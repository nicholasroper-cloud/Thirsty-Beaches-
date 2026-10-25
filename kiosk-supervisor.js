/* ============================================================================
   kiosk-supervisor.js — TB-KIOSK-SUPERVISOR · Thirsty Beaches kiosk
   ----------------------------------------------------------------------------
   Loaded by the boot shim (clover-menu-server.js) in the long-lived launcher
   process. Runs the real server (kiosk-server.js) as a CHILD process and:
     * restarts it right away if it exits (backoff on repeated crashes)
     * applies a staged code update (.tb/pending.json) while the server is
       stopped: verify sha256 + `node --check` + self-tests, back up the old
       files, swap the new ones in
     * TRIAL: the new server must answer /health within 60 s, and must not
       crash 3 times in 10 min; otherwise the old files are restored
       automatically (ROLLBACK) and that version is never retried
     * KNOWN-GOOD: after >=10 min with the last 5 min healthy the version is
       marked good (and the supervisor itself is copied to .tb/good/)
     * restarts a server that stops answering /health for 3 min
     * safe mode: 3 crashes in 10 min outside a trial while remote settings
       are in force -> next start ignores those settings
     * first switch-over from the legacy server (see moderation.js): a
       BOOTSTRAP trial; on failure it exits 78 and the legacy server carries on
   Self-contained on purpose (Node built-ins only, no local requires) so a bad
   update of another file can never break the thing that rolls it back.
   All state lives in .tb/ (never touched by updates).
   ============================================================================ */
"use strict";

const fs     = require("fs");
const path   = require("path");
const http   = require("http");
const net    = require("net");
const os     = require("os");
const crypto = require("crypto");
const cp     = require("child_process");

const SUPERVISOR_VERSION = 1;
const EXIT_UPDATE = 75, EXIT_RESTART = 76, EXIT_PORT_BUSY = 77, EXIT_BOOTSTRAP_FAILED = 78;

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
const T = {
  healthTimeout: num(process.env.TB_HEALTH_TIMEOUT_MS, 60000),       // new server must be healthy within this
  goodAfter:     num(process.env.TB_GOOD_AFTER_MS, 5 * 60000),        // ...and stay healthy this long
  trialWindow:   num(process.env.TB_TRIAL_WINDOW_MS, 10 * 60000),     // crash-count window / min trial length
  crashLimit:    3,
  hung:          num(process.env.TB_HUNG_MS, 3 * 60000),              // known-good server unhealthy this long -> restart
  pollFast:      num(process.env.TB_POLL_FAST_MS, 1000),
  pollSlow:      num(process.env.TB_POLL_SLOW_MS, 15000),
  downBeat:      num(process.env.TB_DOWN_HEARTBEAT_MS, 5 * 60000),    // heartbeat from here while the server is down
};

const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");
const sha256File = fp => { try { return sha256(fs.readFileSync(fp)); } catch { return null; } };
const sleepSync = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
const nowIso = () => new Date().toISOString();
const dur = ms => ms >= 120000 ? Math.round(ms / 60000) + " min" : Math.round(ms / 1000) + " s";
function retry(fn) {
  let last;
  for (let i = 0; i < 12; i++) {
    try { return fn(); } catch (e) { last = e; if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e; sleepSync(100 + i * 100); }
  }
  throw last;
}
const renameRetry = (a, b) => retry(() => fs.renameSync(a, b));
function copyAtomic(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = to + ".tbtmp";
  fs.copyFileSync(from, tmp);
  renameRetry(tmp, to);
}
function writeJson(fp, obj) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  renameRetry(tmp, fp);
}
function readJson(fp, fb) { try { return JSON.parse(fs.readFileSync(fp, "utf8")); } catch { return fb; } }

/* same rules as kiosk-lib.js checkRelPath/blockedReason (duplicated: this file stays self-contained) */
function relOk(rel) {
  if (typeof rel !== "string" || !rel || rel.length > 200 || !/^[A-Za-z0-9._\-\/]+$/.test(rel)) return false;
  for (const s of rel.split("/")) {
    if (!s || s.startsWith(".") || s.endsWith(".") || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(s)) return false;
  }
  const base = path.posix.basename(rel.toLowerCase());
  if (base.endsWith(".env") || base.includes(".env.") || base === "update-state.json" || base === "flex-pairing.json") return false;
  if ([".exe", ".dll", ".node", ".sys", ".msi", ".scr", ".com"].includes(path.posix.extname(base))) return false;
  if (rel.toLowerCase().split("/")[0] === "node_modules") return false;
  return true;
}

/* Which --env-file the launcher used (Run-Kiosk.bat: relative; scheduled task: absolute). */
function envFileFromArgs(root) {
  const a = process.execArgv;
  for (let i = 0; i < a.length; i++) {
    const m = /^--env-file(?:-if-exists)?(?:=(.*))?$/.exec(a[i]);
    if (m) { const v = m[1] != null ? m[1] : a[i + 1]; if (v) return path.resolve(process.cwd(), v.replace(/^"|"$/g, "")); }
  }
  const def = path.join(root, "kiosk-config.env");
  return fs.existsSync(def) ? def : null;
}
function envFileKeys(fp) {
  try {
    return fs.readFileSync(fp, "utf8").split(/\r?\n/)
      .map(l => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(l)).filter(Boolean).map(m => m[1]);
  } catch { return []; }
}

/* ======================================================================== */
let S = null;          // the running instance (one per load of this module)

function start(ctx) {
  if (S) stop();
  const root = path.resolve(ctx && ctx.root ? ctx.root : __dirname);
  const tb = path.join(root, ".tb");
  fs.mkdirSync(tb, { recursive: true });
  S = {
    ctx: ctx || {}, root, tb, stopped: false, timers: new Set(), child: null, childStartedAt: 0,
    healthyOnce: false, healthySince: 0, lastHealthOk: 0, lastUpAt: Date.now(), backoff: 0,
    rollbackOnExit: null, lastDownBeat: 0, lastPoll: 0,
    stateFile: path.join(tb, "supervisor-state.json"), pendingFile: path.join(tb, "pending.json"),
    logFile: path.join(tb, "supervisor.log"), envFile: envFileFromArgs(root),
    port: parseInt(process.env.PORT || "8080", 10),
  };
  S.state = loadState();
  log(`supervisor v${SUPERVISOR_VERSION} starting (${S.ctx.reason || "start"}${S.ctx.legacyHost ? ", switching over from the legacy server" : ""}${S.ctx.fallback ? ", FALLBACK copy" : ""})`);

  const me = S;
  every(tick, 1000);
  try {
    recoverJournal();
    if (S.ctx.fallback && S.state.trial && (S.state.trial.files || []).some(f => f.path === "kiosk-supervisor.js")) {
      // we are the known-good copy, loaded because the freshly updated supervisor failed: undo that update
      if (rollbackFiles(`the new supervisor failed (${S.ctx.reason || "unknown"})`) && S.ctx.reload) { const c = S.ctx; stop(); c.reload("rolled back the supervisor"); return; }
    }
    if (S.ctx.legacyHost && !S.state.trial) beginBootstrapTrial();
    if (fs.existsSync(S.pendingFile) && !S.state.trial && applyPending() === "reload") return;
  } catch (e) { log("startup step failed: " + (e && e.stack || e)); }
  if (S !== me) return;
  cleanupOrphan();
  portFree(S.port, free => {
    if (S !== me || me.stopped) return;
    if (!free) {
      if (S.ctx.legacyHost) {
        // something (the old server started some other way?) already serves the kiosk port:
        // leave it alone; do not count this as a failed switch-over
        log(`port ${S.port} is already in use by another program — leaving it running and stepping aside`);
        S.state.trial = (S.state.trial && S.state.trial.kind === "bootstrap") ? null : S.state.trial;
        saveState();
        return exitProcess(0);
      }
      log(`port ${S.port} is in use by another program — waiting for it to be free`);
      return later(() => start(me.ctx), 5000);
    }
    launch();
  });
}

function stop() {
  if (!S) return;
  const s = S;
  s.stopped = true;
  for (const t of s.timers) { clearTimeout(t); clearInterval(t); }
  s.timers.clear();
  if (s.child) { try { killTree(s.child.pid); } catch {} }
  S = null;
}

/* ---------------- timers bound to this instance ---------------- */
function later(fn, ms) {
  const me = S;
  const t = setTimeout(() => { me.timers.delete(t); if (!me.stopped && S === me) safe(fn); }, ms);
  me.timers.add(t); return t;
}
function every(fn, ms) {
  const me = S;
  const t = setInterval(() => { if (!me.stopped && S === me) safe(fn); }, ms);
  me.timers.add(t); return t;
}
function safe(fn) { try { fn(); } catch (e) { log("error: " + (e && e.stack || e)); } }

/* ---------------- state ---------------- */
function loadState() {
  const st = readJson(path.join(path.resolve(S.root), ".tb", "supervisor-state.json"), {}) || {};
  return Object.assign({ schema: 1, installed: false, good: null, trial: null, quarantine: [], lastRollback: null,
                         lastApply: null, bootstrapFailed: null, safeMode: null, crashLog: [] }, st);
}
function saveState() { try { writeJson(S.stateFile, S.state); } catch (e) { log("could not save state: " + e.message); } }
function log(msg) {
  const line = `[supervisor ${nowIso()}] ${msg}`;
  try { console.log(line); } catch {}
  if (!S) return;
  try {
    try { if (fs.statSync(S.logFile).size > 1024 * 1024) renameRetry(S.logFile, S.logFile + ".1"); } catch {}
    fs.appendFileSync(S.logFile, line + os.EOL);
  } catch {}
}
function currentVersion() { return (readJson(path.join(S.root, "update-state.json"), {}) || {}).version || 1; }
function setVersion(v) { writeJson(path.join(S.root, "update-state.json"), { version: v, at: nowIso() }); }

/* ---------------- child (the real server) ---------------- */
function childEnv() {
  const env = { ...process.env };
  delete env.TB_LEGACY_HOST; delete env.TB_SHIM_SELFTEST;
  if (S.envFile && fs.existsSync(S.envFile)) for (const k of envFileKeys(S.envFile)) delete env[k];   // re-read from the file each start
  env.TB_SUPERVISED = "1";
  env.TB_SUPERVISOR_VERSION = String(SUPERVISOR_VERSION);
  if (S.state.safeMode) env.TB_SAFE_MODE = "1"; else delete env.TB_SAFE_MODE;
  return env;
}
function launch() {
  if (S.stopped || S.child) return;
  if (S.state.safeMode) {
    // the settings that caused the crash loop have been replaced remotely: no reason to stay careful
    const rs = readJson(path.join(S.tb, "remote-settings.json"), null);
    if (!rs || rs.hash !== S.state.safeMode.settingsHash) { log("remote settings changed since the crash loop — leaving safe mode"); S.state.safeMode = null; saveState(); }
  }
  const args = [];
  if (S.envFile && fs.existsSync(S.envFile)) args.push("--env-file=" + S.envFile);
  args.push(path.join(S.root, "kiosk-server.js"));
  let child;
  try {
    child = cp.spawn(process.execPath, args, { cwd: S.root, env: childEnv(), stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
  } catch (e) { log("could not start the server: " + e.message); return later(launch, 5000); }
  S.child = child; S.childStartedAt = Date.now(); S.healthyOnce = false; S.healthySince = 0; S.lastHealthOk = 0;
  try { writeJson(path.join(S.tb, "app.pid"), { pid: child.pid, at: nowIso() }); } catch {}
  log(`server started (pid ${child.pid}, v${currentVersion()}${S.state.trial ? ", TRIAL of v" + S.state.trial.version : ""}${S.state.safeMode ? ", SAFE MODE" : ""})`);
  const me = S;
  child.on("error", e => { if (S === me) log("server process error: " + e.message); });
  child.on("exit", (code, signal) => { if (S === me && !me.stopped) safe(() => onExit(child, code, signal)); });
}

function onExit(child, code, signal) {
  if (S.child !== child) return;
  S.child = null;
  const ranMs = Date.now() - S.childStartedAt;
  log(`server exited (code ${code}${signal ? ", signal " + signal : ""}) after ${Math.round(ranMs / 1000)} s`);
  if (S.rollbackOnExit) { const r = S.rollbackOnExit; S.rollbackOnExit = null; return rollbackNow(r); }

  if (fs.existsSync(S.pendingFile) && !S.state.trial) {
    const r = applyPending();
    if (r === "reload") return;
    return later(launch, 200);
  }
  if (code === EXIT_PORT_BUSY) { cleanupOrphan(); return later(launch, 3000); }

  const intentional = code === EXIT_UPDATE || code === EXIT_RESTART;
  const tr = S.state.trial;
  if (tr && !intentional) {
    if (!S.healthyOnce) return rollbackNow(`the new server exited (code ${code}) before it ever answered /health`);
    const now = Date.now();
    tr.crashes = (tr.crashes || []).filter(t => now - t < T.trialWindow).concat(now);
    saveState();
    if (tr.crashes.length >= T.crashLimit) return rollbackNow(`the new server crashed ${tr.crashes.length} times in ${dur(T.trialWindow)}`);
  }
  if (intentional) { S.backoff = 0; return later(launch, 100); }

  // plain crash of a known-good server: restart with backoff; maybe enter safe mode
  const now = Date.now();
  S.state.crashLog = (S.state.crashLog || []).filter(t => now - t < T.trialWindow).concat(now);
  if (!tr && S.state.crashLog.length >= T.crashLimit) {
    const rs = readJson(path.join(S.tb, "remote-settings.json"), null);
    if (rs && rs.settings && Object.keys(rs.settings).length && (!S.state.safeMode || S.state.safeMode.settingsHash !== rs.hash)) {
      S.state.safeMode = { since: nowIso(), settingsHash: rs.hash || null };
      log("server keeps crashing while remote settings are in force — next start is in SAFE MODE (kiosk-config.env only)");
    }
  }
  saveState();
  S.backoff = Math.min(60000, S.backoff ? S.backoff * 2 : 1000);
  later(launch, S.backoff);
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try { cp.spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10000 }); } catch {}
  } else { try { process.kill(pid, "SIGKILL"); } catch {} }
}
function stopChildThen(reason) {
  S.rollbackOnExit = reason;
  if (S.child) killTree(S.child.pid); else { S.rollbackOnExit = null; rollbackNow(reason); }
}

/* A server left running by an earlier supervisor that died (pid file from this boot, still a
   kiosk-server node process) would hold the port: stop it. */
function cleanupOrphan() {
  const pf = path.join(S.tb, "app.pid");
  const info = readJson(pf, null);
  if (!info || !info.pid || (S.child && S.child.pid === info.pid)) return;
  const bootAt = Date.now() - os.uptime() * 1000;
  if ((Date.parse(info.at) || 0) < bootAt) return;                 // from before this boot: pid means nothing now
  let ours = false;
  try {
    if (process.platform === "win32") {
      const r = cp.spawnSync("tasklist", ["/FI", `PID eq ${info.pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      ours = /"node\.exe"/i.test(r.stdout || "");
    } else {
      ours = /kiosk-server\.js/.test(fs.readFileSync(`/proc/${info.pid}/cmdline`, "utf8"));
    }
  } catch {}
  if (ours) { log(`stopping a leftover server (pid ${info.pid})`); killTree(info.pid); sleepSync(500); }
}

function portFree(port, cb) {
  const srv = net.createServer();
  srv.once("error", () => cb(false));
  srv.listen(port, "127.0.0.1", () => srv.close(() => cb(true)));
}
function health(cb) {
  const req = http.get({ host: "127.0.0.1", port: S.port, path: "/health", timeout: 3000 }, res => {
    let body = "";
    res.on("data", c => { body += c; });
    res.on("end", () => cb(res.statusCode === 200 && body.trim() === "ok", res.headers["x-tb-pid"]));
  });
  req.on("timeout", () => req.destroy());
  req.on("error", () => cb(false, null));
}

/* ---------------- the 1 s tick: health, trial bookkeeping ---------------- */
let checking = false;
function tick() {
  const now = Date.now();
  if (!S.child) return maybeDownBeat(now);
  const fast = !S.healthyOnce || S.state.trial;
  if (checking || (!fast && now - (S.lastPoll || 0) < T.pollSlow) || (fast && now - (S.lastPoll || 0) < T.pollFast)) return;
  checking = true; S.lastPoll = now;
  const me = S, child = S.child;
  health((ok, pid) => {
    checking = false;
    if (S !== me || me.stopped || S.child !== child) return;
    const t = Date.now();
    const mine = ok && String(pid) === String(child.pid);
    if (mine) {
      if (!S.healthyOnce) { S.healthyOnce = true; S.backoff = 0; log(`server healthy (pid ${child.pid})`); if (S.ctx.markOk) safe(() => S.ctx.markOk()); }
      if (!S.healthySince) S.healthySince = t;
      S.lastHealthOk = t; S.lastUpAt = t;
      maybeMarkGood(t);
    } else {
      S.healthySince = 0;
      if (!S.healthyOnce) {
        if (t - S.childStartedAt > T.healthTimeout) {
          if (S.state.trial) return stopChildThen(`the new server did not answer /health within ${dur(T.healthTimeout)}`);
          log("server did not become healthy in time — restarting it");
          killTree(child.pid);
        }
      } else if (t - S.lastHealthOk > T.hung) {
        log(`server stopped answering /health for ${dur(T.hung)} — restarting it`);
        killTree(child.pid);
      }
    }
    maybeDownBeat(t);
  });
}

function maybeMarkGood(t) {
  const tr = S.state.trial;
  if (!tr || tr.phase !== "trial") return;
  if (t - S.healthySince < T.goodAfter || t - (Date.parse(tr.startedAt) || t) < T.trialWindow) return;
  if ((tr.crashes || []).filter(c => t - c < T.trialWindow).length >= T.crashLimit) return;
  markGood();
}

function markGood() {
  const tr = S.state.trial;
  const v = currentVersion();
  if (tr.kind === "bootstrap") {
    try { installShim(); } catch (e) { log("could not install the new launcher shim yet (will retry next start): " + e.message); return; }
  }
  try {
    const good = path.join(S.tb, "good");
    fs.mkdirSync(good, { recursive: true });
    copyAtomic(path.join(S.root, "kiosk-supervisor.js"), path.join(good, "kiosk-supervisor.js"));
  } catch (e) { log("could not save the known-good supervisor copy: " + e.message); }
  S.state.good = { version: v, at: nowIso(), serverHash: sha256File(path.join(S.root, "kiosk-server.js")) };
  S.state.lastApply = { version: v, at: nowIso(), ok: true, error: null };
  S.state.trial = null;
  S.state.crashLog = [];
  saveState();
  pruneBackups();
  log(`v${v} is KNOWN-GOOD${tr.kind === "bootstrap" ? " — switch-over complete; the next PC start runs the new launcher directly" : ""}`);
}

function pruneBackups() {
  const dir = path.join(S.tb, "backup");
  let names = [];
  try { names = fs.readdirSync(dir).sort(); } catch { return; }
  for (const n of names.slice(0, Math.max(0, names.length - 2))) { try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch {} }
}

/* ---------------- bootstrap (first switch-over from the legacy server) ---------------- */
function bootstrapKey() {
  const b = readJson(path.join(S.root, "tb-bootstrap.json"), null);
  return b && b.files ? sha256(JSON.stringify(Object.keys(b.files).sort().map(k => [k, b.files[k]]))).slice(0, 16) : "none";
}
function beginBootstrapTrial() {
  S.state.trial = { kind: "bootstrap", version: currentVersion(), from: "legacy", phase: "trial", startedAt: nowIso(), crashes: [], files: [] };
  S.state.installed = false;
  saveState();
  log(`switch-over trial started for v${S.state.trial.version}`);
}
function installShim() {
  const shim = S.ctx.shimFile || path.join(S.root, "clover-menu-server.next.js");
  const src = fs.readFileSync(shim, "utf8");
  if (!src.includes("TB-KIOSK-SHIM")) throw new Error("shim file does not look like the new launcher");
  const live = path.join(S.root, "clover-menu-server.js");
  if (path.resolve(shim) !== path.resolve(live)) {
    const legacy = path.join(S.tb, "legacy", "clover-menu-server.js");
    if (fs.existsSync(live) && !fs.readFileSync(live, "utf8").includes("TB-KIOSK-SHIM")) copyAtomic(live, legacy);
    copyAtomic(shim, live);
  }
  S.state.installed = true;
  log("installed the new launcher shim as clover-menu-server.js");
}

/* ---------------- journal recovery (power loss mid-update) ---------------- */
function recoverJournal() {
  const tr = S.state.trial;
  if (!tr || tr.kind === "bootstrap") return;
  if (tr.phase === "backup") {                      // live files untouched
    log(`v${tr.version} update was interrupted before any file was replaced — discarded`);
    S.state.trial = null;
    S.state.lastApply = { version: tr.version, at: nowIso(), ok: false, error: "interrupted before swap" };
    saveState();
  } else if (tr.phase === "swap") {
    restoreBackup(tr);
    S.state.trial = null;
    S.state.lastApply = { version: tr.version, at: nowIso(), ok: false, error: "interrupted while swapping files — old files restored" };
    saveState();
    log(`v${tr.version} update was interrupted mid-swap — old files restored`);
  } else if (tr.phase === "trial") {
    const bad = (tr.files || []).filter(f => sha256File(path.join(S.root, ...f.path.split("/"))) !== f.sha256);
    if (bad.length) { log(`files changed during the v${tr.version} trial (${bad.map(f => f.path).join(", ")}) — rolling back`); rollbackFiles(`files changed during the trial`); }
  }
}

/* ---------------- applying a staged update ---------------- */
function checkJs(file) {
  const r = cp.spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  return r.status === 0 ? null : ((r.stderr || r.stdout || "").split("\n").find(l => /Error/.test(l)) || "syntax check failed").trim().slice(0, 140);
}
function selfTest(file, env, expect) {
  const r = cp.spawnSync(process.execPath, [file, "--tb-selftest"], { encoding: "utf8", windowsHide: true, timeout: 30000,
    env: { ...process.env, ...env, TB_SUPERVISED: "", TB_LEGACY_HOST: "" } });
  return r.status === 0 && String(r.stdout).includes(expect) ? null : `self-test failed (exit ${r.status})`;
}

/* returns "reload" if the supervisor itself was replaced and is reloading */
function applyPending() {
  const p = readJson(S.pendingFile, null);
  const discard = (why, quarantine) => {
    log(`staged update ${p && p.version ? "v" + p.version + " " : ""}NOT applied: ${why}`);
    if (p && Number.isInteger(p.version)) {
      S.state.lastApply = { version: p.version, at: nowIso(), ok: false, error: why };
      // a version whose staged files keep failing to apply is given up after 3 tries (no restart loop)
      const fails = S.state.applyFails = (S.state.applyFails && S.state.applyFails.v === p.version) ? S.state.applyFails : { v: p.version, n: 0 };
      fails.n++;
      if ((quarantine || fails.n >= 3) && !S.state.quarantine.includes(p.version)) S.state.quarantine.push(p.version);
    }
    saveState();
    try { fs.rmSync(S.pendingFile, { force: true }); } catch {}
    if (p && typeof p.stageDir === "string") try { fs.rmSync(path.join(S.tb, "staging"), { recursive: true, force: true }); } catch {}
    return "discarded";
  };
  if (!p || !Number.isInteger(p.version) || !Array.isArray(p.files) || !p.files.length) return discard("pending.json unreadable");
  const from = currentVersion();
  if (p.version <= from) return discard(`v${p.version} is not newer than v${from}`);
  if (S.state.quarantine.includes(p.version)) return discard(`v${p.version} was rolled back before`);
  const stageRoot = path.resolve(S.tb, "staging");
  const stage = path.resolve(S.root, String(p.stageDir || ""));
  if (!stage.startsWith(stageRoot + path.sep)) return discard("bad staging folder");

  const files = [];
  for (const f of p.files) {
    if (!f || !relOk(f.path) || !/^[0-9a-f]{64}$/.test(String(f.sha256))) return discard(`bad file entry ${f && f.path}`);
    const staged = path.join(stage, ...f.path.split("/"));
    if (sha256File(staged) !== f.sha256) return discard(`${f.path}: staged copy missing or sha256 mismatch`);   // retried next check
    files.push({ path: f.path, sha256: f.sha256, staged, live: path.join(S.root, ...f.path.split("/")) });
  }
  // gates: every staged .js must parse; the supervisor and the shim must pass their self-tests
  for (const f of files) {
    if (f.path.toLowerCase().endsWith(".js")) { const err = checkJs(f.staged); if (err) return discard(`${f.path} has a syntax error: ${err}`, true); }
    if (f.path === "addons.json") { try { JSON.parse(fs.readFileSync(f.staged, "utf8")); } catch { return discard("addons.json is not valid JSON", true); } }
  }
  const sup = files.find(f => f.path === "kiosk-supervisor.js");
  if (sup) { const err = selfTest(sup.staged, {}, "TB-SUPERVISOR-SELFTEST-OK"); if (err) return discard("kiosk-supervisor.js " + err, true); }
  const shim = files.find(f => f.path === "clover-menu-server.js");
  if (shim) {
    if (!fs.readFileSync(shim.staged, "utf8").includes("TB-KIOSK-SHIM")) return discard("clover-menu-server.js is not a launcher shim", true);
    const err = selfTest(shim.staged, { TB_SHIM_SELFTEST: "1" }, "TB-SHIM-SELFTEST-OK"); if (err) return discard("clover-menu-server.js " + err, true);
  }

  // journal: backup -> swap -> trial (recoverJournal() finishes or undoes this after a power cut)
  const backupDir = path.join(S.tb, "backup", `${String(Date.now())}-v${from}`);
  S.state.trial = { kind: "update", version: p.version, from, phase: "backup", startedAt: null, crashes: [], backupDir,
                    files: files.map(f => ({ path: f.path, sha256: f.sha256, existed: fs.existsSync(f.live) })) };
  saveState();
  try {
    for (const f of files) if (fs.existsSync(f.live)) copyAtomic(f.live, path.join(backupDir, ...f.path.split("/")));
  } catch (e) {
    S.state.trial = null; saveState();
    return discard("could not back up the current files: " + e.message);
  }
  S.state.trial.phase = "swap"; saveState();
  try {
    for (const f of files) { fs.mkdirSync(path.dirname(f.live), { recursive: true }); renameRetry(f.staged, f.live); }
  } catch (e) {
    log("swap failed, restoring: " + e.message);
    restoreBackup(S.state.trial);
    S.state.trial = null; saveState();
    return discard("could not replace files: " + e.message);
  }
  setVersion(p.version);
  Object.assign(S.state.trial, { phase: "trial", startedAt: nowIso() });
  S.state.lastApply = { version: p.version, at: nowIso(), ok: null, error: null };
  saveState();
  try { fs.rmSync(S.pendingFile, { force: true }); } catch {}
  try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch {}
  log(`v${p.version} swapped in (${files.map(f => f.path).join(", ")}) — trial started`);
  if (sup && S.ctx.reload) { log("the supervisor itself was updated — reloading it"); const c = S.ctx; stop(); c.reload("supervisor updated"); return "reload"; }
  return "applied";
}

/* ---------------- rollback ---------------- */
function restoreBackup(tr) {
  for (const f of tr.files || []) {
    const b = path.join(tr.backupDir, ...f.path.split("/"));
    const live = path.join(S.root, ...f.path.split("/"));
    try { if (f.existed && fs.existsSync(b)) copyAtomic(b, live); } catch (e) { log(`could not restore ${f.path}: ${e.message}`); }
  }
}
function rollbackFiles(reason) {
  const tr = S.state.trial;
  restoreBackup(tr);
  try { setVersion(tr.from); } catch {}
  if (!S.state.quarantine.includes(tr.version)) S.state.quarantine.push(tr.version);
  S.state.quarantine = S.state.quarantine.slice(-50);
  S.state.lastRollback = { at: nowIso(), from: tr.version, to: tr.from, reason };
  S.state.lastApply = { version: tr.version, at: nowIso(), ok: false, error: "rolled back: " + reason };
  S.state.trial = null;
  saveState();
  log(`ROLLED BACK v${tr.version} -> v${tr.from}: ${reason}`);
  return (tr.files || []).some(f => f.path === "kiosk-supervisor.js");
}
function rollbackNow(reason) {
  const tr = S.state.trial;
  if (!tr) return later(launch, 500);
  if (S.child) return stopChildThen(reason);
  if (tr.kind === "bootstrap") {
    S.state.bootstrapFailed = { key: bootstrapKey(), at: nowIso(), reason };
    S.state.lastRollback = { at: nowIso(), from: tr.version, to: "legacy", reason: "switch-over failed: " + reason };
    S.state.lastApply = { version: tr.version, at: nowIso(), ok: false, error: "switch-over failed: " + reason };
    S.state.trial = null;
    saveState();
    log(`SWITCH-OVER FAILED (${reason}) — handing back to the legacy server; it will not be retried until a new bootstrap is published`);
    downBeat(true).finally(() => exitProcess(EXIT_BOOTSTRAP_FAILED));
    return;
  }
  const supChanged = rollbackFiles(reason);
  if (supChanged && S.ctx.reload) { const c = S.ctx; stop(); c.reload("rolled back the supervisor"); return; }
  later(launch, 300);
}
function exitProcess(code) { const s = S; stop(); setTimeout(() => process.exit(code), 50); return s; }

/* ---------------- heartbeat while the server is down ---------------- */
function maybeDownBeat(now) {
  const downFor = now - S.lastUpAt;                 // not reset by restarts: a crash loop still reports
  if (downFor < T.hung || now - S.lastDownBeat < T.downBeat) return;
  S.lastDownBeat = now;
  downBeat(false);
}
function downBeat(final) {
  const base = (process.env.PRIZE_API || "https://tb-where.nicholasroper.workers.dev").replace(/\/+$/, "");
  const url = (process.env.KIOSK_HEARTBEAT_URL || base + "/kiosk/ping").trim();
  if (!url || url === "off" || typeof fetch !== "function") return Promise.resolve();
  const st = S.state;
  const body = {
    kioskId: String(process.env.POS_NAME || "ThirstyBeaches-Kiosk").trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40),
    version: currentVersion(), appDown: true, startedAt: null, uptimeSec: Math.round(process.uptime()),
    rollback: st.lastRollback, lastUpdate: st.lastApply ? { version: st.lastApply.version, at: st.lastApply.at, ok: st.lastApply.ok, error: st.lastApply.error } : null,
    errors: [final ? "switch-over to the new server failed; legacy server running" : "kiosk server is not answering; supervisor is restarting it"],
    node: process.version, supervised: true, trial: !!st.trial, safeMode: !!st.safeMode,
  };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal })
    .catch(() => {}).finally(() => clearTimeout(t));
}

/* ---------------- self-test (run by the previous supervisor before it swaps this file in) ---------------- */
function selfTestMain() {
  const keys = (() => { const f = path.join(os.tmpdir(), `tb-st-${process.pid}.env`); fs.writeFileSync(f, "A=1\n# c\nexport B_2 = x\n\nC.D=\"q\"\n"); const k = envFileKeys(f); fs.rmSync(f, { force: true }); return k; })();
  const ok = keys.join(",") === "A,B_2,C.D" && relOk("assets/logo.png") && !relOk("../x") && !relOk("kiosk-config.env.") &&
             !relOk(".tb/x") && !relOk("a\\b") && typeof start === "function" && typeof stop === "function";
  if (!ok) { console.log("TB-SUPERVISOR-SELFTEST-FAILED"); process.exit(1); }
  console.log("TB-SUPERVISOR-SELFTEST-OK");
  process.exit(0);
}
if (require.main === module) {
  if (process.argv.includes("--tb-selftest")) selfTestMain();
  else { console.log("kiosk-supervisor.js is started by clover-menu-server.js — run that instead."); process.exit(2); }
}

module.exports = { start, stop, SUPERVISOR_VERSION, _internals: { relOk, envFileKeys, envFileFromArgs } };
