// tests/kiosk/e2e.js — end-to-end test of the kiosk switch-over / update / rollback / remote-control path.
// Runs on Linux/macOS with plain Node (no Windows needed). Real processes, real files, fake internet:
//   - one local HTTP server stands in for raw.githubusercontent.com (/gh), kiosk-control.json (/control.json),
//     the Clover REST API (/clover), healthchecks.io (/hc) and the tb-where worker (/worker — the REAL worker
//     module with an in-memory KV when --worker is given)
//   - a "PC folder" starts as the Oct 12 USB drive (the legacy server) at update v23
// Usage:
//   node tests/kiosk/e2e.js --legacy-dir <USB drive copy> [--worker <tb-where worker.js>] [--work <tmp dir>] [--only a,b]
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const cp = require("child_process");
const crypto = require("crypto");

const REPO = path.resolve(__dirname, "../..");
const argv = process.argv.slice(2);
const arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const LEGACY = arg("--legacy-dir") || process.env.TB_LEGACY_DIR;
const WORKER = arg("--worker") || process.env.TB_WORKER_JS;
const WORK = fs.mkdtempSync(path.join(arg("--work") || os.tmpdir(), "tb-e2e-"));
const ONLY = (arg("--only") || "").split(",").filter(Boolean);
if (!LEGACY || !fs.existsSync(path.join(LEGACY, "clover-menu-server.js"))) { console.error("need --legacy-dir with the pre-v24 clover-menu-server.js"); process.exit(2); }

const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const shaFile = f => { try { return sha(fs.readFileSync(f)); } catch { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(cond, msg) { if (cond) { passed++; console.log("  ok   " + msg); } else { failed++; console.log("  FAIL " + msg); } return !!cond; }
async function waitFor(fn, ms, msg) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return check(true, msg) && last; } catch (e) { last = e; } await sleep(200); }
  check(false, `${msg} (timed out after ${ms} ms${last instanceof Error ? ": " + last.message : ""})`);
  return null;
}

/* ------------------------------------------------------------------ fake internet */
const svc = { ghRoot: null, tamper: {}, control: { soldOut: [], special: null, updated: "" }, cloverDelayMs: 0, orders: {}, hc: 0, pings: [] };
let kv = null, workerMod = null;
const WORKER_ENV = () => ({ TB_LOC: kv, TB_SECRET: "e2e-staff-secret", KIOSK_MIN_GAP_MS: "1000", KIOSK_WRITE_MIN: "1" });
function makeKV() {
  const m = new Map(); let writes = 0;
  return {
    get writes() { return writes; },
    async get(k) { const e = m.get(k); if (!e) return null; if (e.exp && e.exp < Date.now()) { m.delete(k); return null; } return e.v; },
    async put(k, v, o) { writes++; m.set(k, { v: String(v), exp: o && o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : 0 }); },
    async delete(k) { m.delete(k); },
    async list(o) { const p = (o && o.prefix) || ""; return { keys: [...m.keys()].filter(k => k.startsWith(p)).sort().slice(0, (o && o.limit) || 1000).map(name => ({ name })) }; },
  };
}
const readBody = req => new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
const cloverId = () => "ORD" + crypto.randomBytes(6).toString("hex").toUpperCase().slice(0, 10);
const svcServer = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const body = await readBody(req);
  const send = (code, obj, type) => { res.writeHead(code, { "Content-Type": type || "application/json" }); res.end(typeof obj === "string" || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)); };
  try {
    if (u.pathname.startsWith("/gh/")) {
      const rel = decodeURIComponent(u.pathname.slice(4));
      if (svc.tamper[rel]) return send(200, svc.tamper[rel], "application/octet-stream");
      const fp = path.join(svc.ghRoot, rel);
      if (!fp.startsWith(svc.ghRoot) || !fs.existsSync(fp)) return send(404, "nope", "text/plain");
      return send(200, fs.readFileSync(fp), "application/octet-stream");
    }
    if (u.pathname === "/control.json") return send(200, svc.control);
    if (u.pathname.startsWith("/hc/")) { svc.hc++; return send(200, "OK", "text/plain"); }
    if (u.pathname.startsWith("/clover/v3/merchants/MTEST")) {
      const p = u.pathname.slice("/clover/v3/merchants/MTEST".length);
      if (req.headers.authorization !== "Bearer test-token-not-real") return send(401, { message: "bad token" });
      const j = body.length ? JSON.parse(body) : {};
      if (req.method === "POST" && p === "/orders") { if (svc.cloverDelayMs) await sleep(svc.cloverDelayMs); const id = cloverId(); svc.orders[id] = { id, state: "open", total: 0 }; return send(200, svc.orders[id]); }
      let m;
      if ((m = /^\/orders\/(\w+)\/line_items$/.exec(p)) && req.method === "POST") { svc.orders[m[1]].total += j.price; return send(200, { id: "L1" }); }
      if ((m = /^\/orders\/(\w+)\/discounts$/.exec(p)) && req.method === "POST") return send(200, { id: "D1" });
      if ((m = /^\/orders\/(\w+)$/.exec(p))) {
        const o = svc.orders[m[1]]; if (!o) return send(404, { message: "no order" });
        if (req.method === "POST") Object.assign(o, j);
        if (req.method === "DELETE") delete svc.orders[m[1]];
        return send(200, o);
      }
      if (p.startsWith("/items") || p.startsWith("/categories")) return send(200, { elements: [] });
      return send(404, { message: "unknown clover path " + p });
    }
    if (u.pathname.startsWith("/worker/")) {
      const wurl = "https://tb-where.test" + u.pathname.slice(7) + u.search;
      if (u.pathname === "/worker/kiosk/ping") svc.pings.push(JSON.parse(body.toString() || "{}"));
      if (!workerMod) return send(200, { ok: true });
      const r = await workerMod.default.fetch(new Request(wurl, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }), WORKER_ENV(), { waitUntil() {} });
      res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/json" });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    send(404, "?", "text/plain");
  } catch (e) { send(500, { error: e.message }); }
});
let SVC = 0;

/* ------------------------------------------------------------------ publishing (fake GitHub) */
let pubN = 0;
function copyRepo(dest) {
  const skip = new Set([".git", "tests", "node_modules", ".tb"]);
  (function walk(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (skip.has(e.name) && src === REPO) continue;
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) walk(s, d); else fs.copyFileSync(s, d);
    }
  })(REPO, dest);
}
/* proper publish through tools/publish-manifest.js (refuses broken code) */
function publish(version, mutate) {
  const dir = path.join(WORK, "gh-" + (++pubN));
  copyRepo(dir);
  if (mutate) mutate(dir);
  const mf = path.join(dir, "update-manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8")); m.version = version - 1; fs.writeFileSync(mf, JSON.stringify(m));
  const r = cp.spawnSync(process.execPath, [path.join(dir, "tools", "publish-manifest.js"), "--base", `http://127.0.0.1:${SVC}/gh`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("publish failed: " + r.stderr + r.stdout);
  svc.ghRoot = svc.goodRoot = dir; svc.tamper = {};
  return JSON.parse(fs.readFileSync(mf, "utf8"));
}
/* a "bad push" that bypasses the tool: copy the last published tree, change files, rehash by hand */
function publishRaw(version, mutate) {
  const dir = path.join(WORK, "gh-" + (++pubN));
  fs.cpSync(svc.goodRoot, dir, { recursive: true });
  mutate(dir);
  const mf = path.join(dir, "update-manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  m.version = version;
  for (const f of m.files) {
    const src = f.path === "clover-menu-server.next.js" ? "clover-menu-server.js" : f.path;
    const b = fs.readFileSync(path.join(dir, src));
    f.sha256 = sha(b); f.size = b.length; f.url = `http://127.0.0.1:${SVC}/gh/${src}?v=${f.sha256.slice(0, 12)}`;
  }
  fs.writeFileSync(mf, JSON.stringify(m, null, 1));
  svc.ghRoot = dir; svc.tamper = {};
  return m;
}
const edit = (dir, rel, fn) => { const f = path.join(dir, rel); fs.writeFileSync(f, fn(fs.readFileSync(f, "utf8"))); };

/* ------------------------------------------------------------------ the kiosk PC */
function makePc(name, port, extraEnv) {
  const dir = path.join(WORK, "pc-" + name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["clover-menu-server.js", "flex-pay.js", "moderation.js", "addons.json", "package.json", "Run-Kiosk.bat", "Stop-Kiosk.bat", "Debug-Kiosk.bat", "Fix-And-Run.bat", "READ-ME-FIRST.txt", "remote-update-SETUP.txt"])
    fs.copyFileSync(path.join(LEGACY, f), path.join(dir, f));
  fs.cpSync(path.join(LEGACY, "kiosk-lockdown"), path.join(dir, "kiosk-lockdown"), { recursive: true });
  for (const f of ["drink-kiosk.html", "drink-kiosk-light.html"]) fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  fs.cpSync(path.join(REPO, "assets"), path.join(dir, "assets"), { recursive: true });
  for (const f of fs.readdirSync(dir)) { try { fs.chmodSync(path.join(dir, f), 0o644); } catch {} }
  fs.writeFileSync(path.join(dir, "update-state.json"), JSON.stringify({ version: 23, at: "2026-10-12T00:00:00Z" }));
  const env = {
    CLOVER_API_TOKEN: "test-token-not-real", CLOVER_MERCHANT_ID: "MTEST", CLOVER_BASE_URL: `http://127.0.0.1:${SVC}/clover`, PORT: port,
    ANTHROPIC_API_KEY: "test-anthropic-key", VIBE_MODEL: "claude-haiku-4-5",
    UPDATE_MANIFEST_URL: `http://127.0.0.1:${SVC}/gh/update-manifest.json`, UPDATE_INTERVAL_MIN: 60,
    CONTROL_URL: `http://127.0.0.1:${SVC}/control.json`, HEALTHCHECK_URL: `http://127.0.0.1:${SVC}/hc/ping`,
    PAY_ENABLED: "false", FLEX_IP: "", FLEX_PORT: 12345, FLEX_WS_SCHEME: "wss", PAY_TIMEOUT_MS: 90000,
    POS_NAME: "TestKiosk-" + name, FLEX_PAIRING_FILE: "flex-pairing.json", AI_DESIGN_ENABLED: "false", DRINK_MODEL: "claude-haiku-4-5",
    PRIZE_API: `http://127.0.0.1:${SVC}/worker`,
    // test-only speedups (the defaults are 2 min idle, 60 s health, 5 min good, 10 min window ...)
    TB_ALLOW_HTTP_UPDATES: 1, TB_IDLE_MS: 1500, TB_HEALTH_TIMEOUT_MS: 8000, TB_GOOD_AFTER_MS: 2000, TB_TRIAL_WINDOW_MS: 8000,
    TB_HUNG_MS: 8000, TB_POLL_FAST_MS: 200, TB_POLL_SLOW_MS: 1000, TB_CONTROL_MS: 1000, TB_HEARTBEAT_MS: 5000,
    TB_UPDATE_INTERVAL_MS: 3600000, TB_SHIM_WATCHDOG_MS: 30000, TB_DOWN_HEARTBEAT_MS: 3000,
    ...(extraEnv || {}),
  };
  fs.writeFileSync(path.join(dir, "kiosk-config.env"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\r\n") + "\r\n");
  return { name, dir, port, lock: port + 2, procs: [], logN: 0 };
}
/* mode "bat": like Run-Kiosk.bat (relative env file, cwd = folder); "task": like the appliance scheduled task */
const allPcs = new Set();
function killAll() { for (const pc of allPcs) for (const p of pc.procs) { try { process.kill(-p.pid, "SIGKILL"); } catch {} } }
process.on("exit", killAll);
function launch(pc, mode, env) {
  allPcs.add(pc);
  const log = path.join(pc.dir, `.e2e-${++pc.logN}.log`);
  const out = fs.openSync(log, "a");
  const args = mode === "task" ? [`--env-file=${path.join(pc.dir, "kiosk-config.env")}`, path.join(pc.dir, "clover-menu-server.js")]
                               : ["--env-file=kiosk-config.env", "clover-menu-server.js"];
  const p = cp.spawn(process.execPath, args, { cwd: pc.dir, detached: true, stdio: ["ignore", out, out], env: { ...process.env, ...(env || {}) } });
  p.log = log; p.exitCode_ = null;
  p.on("exit", c => { p.exitCode_ = c; });
  pc.procs.push(p);
  return p;
}
const logOf = p => { try { return fs.readFileSync(p.log, "utf8"); } catch { return ""; } };
async function reboot(pc) {           // power off: every process of this kiosk dies at once
  for (const p of pc.procs) { try { process.kill(-p.pid, "SIGKILL"); } catch {} }
  pc.procs = [];
  await waitFor(() => portFree(pc.port), 8000, `${pc.name}: port ${pc.port} free after power-off`);
}
const portFree = port => new Promise(r => { const s = require("net").createServer(); s.once("error", () => r(false)); s.listen(port, "127.0.0.1", () => s.close(() => r(true))); });
function req(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: { "Content-Type": "application/json", ...(headers || {}) }, timeout: 15000 }, res => {
      const c = []; res.on("data", d => c.push(d)); res.on("end", () => { const t = Buffer.concat(c).toString(); let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, headers: res.headers, text: t, json: j }); });
    });
    r.on("error", reject); r.on("timeout", () => r.destroy(new Error("timeout")));
    if (body !== undefined) r.write(typeof body === "string" ? body : JSON.stringify(body));
    r.end();
  });
}
const health = async pc => { const r = await req(pc.port, "GET", "/health"); return r.status === 200 && r.text === "ok" ? (r.headers["x-tb-pid"] || "legacy") : null; };
const kstatus = async pc => (await req(pc.port, "GET", "/kiosk-status")).json;
const supState = pc => { try { return JSON.parse(fs.readFileSync(path.join(pc.dir, ".tb", "supervisor-state.json"), "utf8")); } catch { return {}; } };
const version = pc => { try { return JSON.parse(fs.readFileSync(path.join(pc.dir, "update-state.json"), "utf8")).version; } catch { return null; } };
const command = (name) => { svc.control = { ...svc.control, commands: { ...(svc.control.commands || {}), [name]: new Date().toISOString() } }; };
async function workerStatus(full, id) {
  const r = await req(SVC, "GET", `/worker/kiosk/status?${full ? "full=1&" : ""}${id ? "id=" + id : ""}`, undefined, full ? { Authorization: "Bearer e2e-staff-secret" } : {});
  return r.json;
}
async function order(pc) { return req(pc.port, "POST", "/order", { cart: [{ name: "Sandy Bottom", unit: 4.5, qty: 1, mods: ["Large"] }], name: "Alice" }); }

/* ------------------------------------------------------------------ scenarios */
const scenarios = {};

scenarios.main = async () => {
  console.log("\n== legacy server picks up the bootstrap files (no restart yet)");
  const pc = makePc("main", 18137);
  const m24 = publish(24);
  let p = launch(pc, "bat");
  await waitFor(() => version(pc) === 24, 20000, "legacy server applied manifest v24");
  const L = logOf(p);
  check(/update: skipped clover-menu-server\.js/.test(L) && /update: skipped flex-pay\.js/.test(L), "legacy skipped clover-menu-server.js and flex-pay.js (as designed) but applied the rest");
  check(shaFile(path.join(pc.dir, "clover-menu-server.js")) === shaFile(path.join(LEGACY, "clover-menu-server.js")), "running legacy server file untouched");
  for (const f of ["kiosk-server.js", "kiosk-lib.js", "kiosk-supervisor.js", "clover-menu-server.next.js", "tb-bootstrap.json", "moderation.js"])
    check(shaFile(path.join(pc.dir, f)) === m24.files.find(x => x.path === f).sha256, `bootstrap file ${f} downloaded intact`);
  check(await health(pc) === "legacy", "legacy server still serving (no X-TB-Pid)");
  check(!/switch-over/.test(L), "no switch-over inside the already-running legacy process");
  check((await order(pc)).json.ok === true, "legacy server still takes orders");

  // moderation.js contract unchanged
  const probe = `const a=require(process.argv[1]).sanitizeDrinkText,b=require(process.argv[2]).sanitizeDrinkText;` +
    `const s=["Sunny Riptide","a sexy drink","Gluten-Free Wave","  lots   of   space ","x".repeat(200),"🌊 wave",42,null,"Coca-Cola Float"];` +
    `const fs=["name","blurb",undefined];let ok=1;for(const x of s)for(const f of fs)if(a(x,f)!==b(x,f)){ok=0;console.log("diff",x,f)}console.log(ok?"SAME":"DIFF")`;
  const cmp = cp.spawnSync(process.execPath, ["-e", probe, path.join(LEGACY, "moderation.js"), path.join(pc.dir, "moderation.js")], { encoding: "utf8" });
  check(cmp.stdout.trim() === "SAME", "new moderation.js sanitizeDrinkText behaves exactly like the old one");

  console.log("\n== ONE restart (Run-Kiosk.bat style): the legacy launch switches over");
  await reboot(pc);
  p = launch(pc, "bat");
  const pid1 = await waitFor(async () => { const h = await health(pc); return h && h !== "legacy" ? h : null; }, 20000, "new supervised server answers /health (X-TB-Pid)");
  check(/\[switch-over\] starting/.test(logOf(p)), "switch-over hook ran from moderation.js");
  const st1 = await kstatus(pc);
  check(st1 && st1.supervised === true && st1.version === 24 && st1.trial === true, "kiosk-status: supervised, v24, in switch-over trial");
  check((await order(pc)).json.ok === true, "orders work on the new server");
  await waitFor(() => supState(pc).installed && supState(pc).good && supState(pc).good.version === 24, 25000, "switch-over marked known-good and the new launcher installed");
  check(fs.readFileSync(path.join(pc.dir, "clover-menu-server.js"), "utf8").includes("TB-KIOSK-SHIM"), "clover-menu-server.js is now the shim");
  check(shaFile(path.join(pc.dir, ".tb", "legacy", "clover-menu-server.js")) === shaFile(path.join(LEGACY, "clover-menu-server.js")), "legacy server kept in .tb/legacy/");
  check(fs.existsSync(path.join(pc.dir, ".tb", "good", "kiosk-supervisor.js")), "known-good supervisor copy saved");
  if (workerMod) await waitFor(async () => { const s = await workerStatus(false, "TestKiosk-main"); return s && s.online && s.version === 24; }, 15000, "worker: public status online · v24");
  const ping = svc.pings.filter(x => x.kioskId === "TestKiosk-main" && !x.appDown).pop();
  check(ping && ping.serverHash === m24.files.find(f => f.path === "kiosk-server.js").sha256 && typeof ping.uptimeSec === "number" && ping.node && "freeDiskMB" in ping && ping.pay && ping.clover && Array.isArray(ping.errors),
        "heartbeat payload has version/serverHash/uptime/pay/clover/errors/node/disk");
  check(ping && !JSON.stringify(ping).includes("test-token-not-real") && !JSON.stringify(ping).includes("test-anthropic-key") && !JSON.stringify(ping).includes("Alice"), "heartbeat carries no secrets / customer names");
  check(svc.hc > 0, "healthchecks.io ping still sent");

  console.log("\n== second copy started while running (double-click Run-Kiosk.bat) exits quietly");
  const dup = launch(pc, "bat");
  await waitFor(() => dup.exitCode_ === 0, 10000, "second launcher exited with code 0");
  check(await health(pc) === pid1, "first server untouched");

  console.log("\n== next PC start, appliance-task style: runs the new launcher directly");
  await reboot(pc);
  p = launch(pc, "task");
  await waitFor(async () => { const h = await health(pc); return h && h !== "legacy"; }, 20000, "healthy after reboot");
  check(!/switch-over/.test(logOf(p)), "no switch-over needed any more");
  check((await kstatus(pc)).trial === false, "not in trial");

  console.log("\n== normal remote update of server code (v25); waits for idle");
  const m25 = publish(25, d => edit(d, "kiosk-server.js", s => s + "\n// e2e v25 marker\n"));
  const pidA = await health(pc);
  svc.cloverDelayMs = 6000;
  const slowOrder = order(pc);
  await sleep(300);
  command("checkUpdateAt");
  await waitFor(() => fs.existsSync(path.join(pc.dir, ".tb", "pending.json")), 8000, "v25 downloaded, verified and staged");
  await sleep(2500);
  check(await health(pc) === pidA, "no restart while an order is in flight");
  const so = await slowOrder; svc.cloverDelayMs = 0;
  check(so.json && so.json.ok, "the in-flight order completed normally");
  await waitFor(async () => { const h = await health(pc); return h && h !== pidA; }, 15000, "restarted once idle");
  await waitFor(() => supState(pc).good && supState(pc).good.version === 25, 25000, "v25 known-good");
  const st25 = await kstatus(pc);
  check(st25.version === 25 && st25.serverHash === m25.files.find(f => f.path === "kiosk-server.js").sha256, "running v25 with the new server hash");
  check((await req(pc.port, "GET", "/version")).json.v === 25, "/version says 25 (screen reloads when idle)");

  console.log("\n== broken push 1: syntax error (bypassing the publish tool)");
  publishRaw(26, d => edit(d, "kiosk-server.js", s => s + "\nfunction (\n"));
  let pidB = await health(pc);
  command("checkUpdateAt");
  await waitFor(() => (supState(pc).quarantine || []).includes(26), 15000, "v26 refused by the syntax gate and quarantined");
  await waitFor(async () => { const h = await health(pc); return h && h !== "legacy"; }, 10000, "kiosk healthy on v25");
  check(version(pc) === 25 && /syntax/.test((supState(pc).lastApply || {}).error || ""), "still v25, lastApply says syntax error");
  check(!fs.readFileSync(path.join(pc.dir, "kiosk-server.js"), "utf8").includes("function (\n"), "live kiosk-server.js never replaced");

  console.log("\n== broken push 2: crashes on boot");
  publishRaw(27, d => edit(d, "kiosk-server.js", s => s.replace('const http   = require("http");', 'const http   = require("http"); throw new Error("e2e boot crash");')));
  command("checkUpdateAt");
  await waitFor(() => (supState(pc).lastRollback || {}).from === 27, 20000, "v27 rolled back automatically");
  await waitFor(async () => (await kstatus(pc)).version === 25, 10000, "back on v25");
  check(/before it ever answered/.test(supState(pc).lastRollback.reason), "rollback reason recorded");
  check(shaFile(path.join(pc.dir, "kiosk-server.js")) === m25.files.find(f => f.path === "kiosk-server.js").sha256, "v25 kiosk-server.js restored byte-for-byte");
  await waitFor(() => svc.pings.some(x => x.kioskId === "TestKiosk-main" && x.rollback && x.rollback.from === 27), 12000, "heartbeat reports the rollback");

  console.log("\n== broken push 3: hash mismatch (corrupt / tampered download)");
  publishRaw(28, d => edit(d, "kiosk-server.js", s => s + "\n// v28\n"));
  svc.tamper["kiosk-server.js"] = Buffer.from("// truncated download ......................................\n");
  command("checkUpdateAt");
  await waitFor(async () => /sha256 check/.test(((await kstatus(pc)).lastUpdate || {}).error || ""), 10000, "v28 refused: sha256 mismatch, nothing applied");
  check(version(pc) === 25 && !fs.existsSync(path.join(pc.dir, ".tb", "pending.json")), "nothing staged, still v25");

  console.log("\n== broken push 4: healthy, then crashes repeatedly");
  publishRaw(29, d => edit(d, "kiosk-server.js", s => s + "\nsetTimeout(() => process.exit(1), 1200);\n"));
  command("checkUpdateAt");
  await waitFor(() => (supState(pc).lastRollback || {}).from === 29, 30000, "v29 rolled back after 3 crashes");
  check(/crashed 3 times/.test(supState(pc).lastRollback.reason), "reason: crashed 3 times");

  console.log("\n== broken push 5: hangs (never answers /health)");
  publishRaw(30, d => edit(d, "kiosk-server.js", s => s.replace('server.listen(PORT, "127.0.0.1",', '((...a) => {})(PORT, "127.0.0.1",')));
  command("checkUpdateAt");
  await waitFor(() => (supState(pc).lastRollback || {}).from === 30, 30000, "v30 rolled back (no /health within the timeout)");
  await waitFor(async () => (await kstatus(pc)).version === 25, 10000, "back on v25");

  console.log("\n== broken push 6: a supervisor that loads but throws in start()");
  publishRaw(31, d => edit(d, "kiosk-supervisor.js", s => s.replace("function start(ctx) {", 'function start(ctx) { if (!process.argv.includes("--tb-selftest")) throw new Error("e2e supervisor boom");')));
  command("checkUpdateAt");
  await waitFor(() => (supState(pc).lastRollback || {}).from === 31, 20000, "v31 rolled back by the known-good supervisor copy");
  check(/new supervisor failed/.test(supState(pc).lastRollback.reason), "reason: the new supervisor failed");
  await waitFor(async () => { const h = await health(pc); return h && h !== "legacy"; }, 10000, "healthy on the old supervisor");
  check(!fs.readFileSync(path.join(pc.dir, "kiosk-supervisor.js"), "utf8").includes("e2e supervisor boom"), "kiosk-supervisor.js restored");

  console.log("\n== good supervisor update (v32): reloads itself in place");
  publish(32, d => edit(d, "kiosk-supervisor.js", s => s.replace("const SUPERVISOR_VERSION = 1;", "const SUPERVISOR_VERSION = 2;")));
  command("checkUpdateAt");
  await waitFor(() => supState(pc).good && supState(pc).good.version === 32, 30000, "v32 known-good");
  check(/supervisor v2 starting/.test(fs.readFileSync(path.join(pc.dir, ".tb", "supervisor.log"), "utf8")), "supervisor v2 running");
  check(fs.readFileSync(path.join(pc.dir, ".tb", "good", "kiosk-supervisor.js"), "utf8").includes("SUPERVISOR_VERSION = 2"), "known-good copy updated");

  console.log("\n== remote settings");
  let v0 = (await req(pc.port, "GET", "/version")).json.v;
  svc.control = { ...svc.control, settings: { UPDATE_INTERVAL_MIN: 7, HIDE_CATEGORIES: ["Secret Menu"], AI_DESIGN_ENABLED: true, BOGUS: 1, PAY_TIMEOUT_MS: 5 } };
  const st = await waitFor(async () => { const s = await kstatus(pc); return s.settings.length === 3 ? s : null; }, 8000, "3 valid settings applied live");
  check(st && st.settings.sort().join() === "AI_DESIGN_ENABLED,HIDE_CATEGORIES,UPDATE_INTERVAL_MIN", "exactly the allowed + valid ones");
  check(st && st.errors.some(e => /BOGUS is not allowed/.test(e)) && st.errors.some(e => /PAY_TIMEOUT_MS has an invalid value/.test(e)), "unknown key and out-of-range value rejected and reported");
  check((await req(pc.port, "GET", "/aiconfig")).json.enabled === true, "AI_DESIGN_ENABLED live (/aiconfig)");
  const v1 = (await req(pc.port, "GET", "/version")).json.v;
  check(v1 !== v0 && String(v1).startsWith("32."), `screen asked to reload (/version ${v0} -> ${v1})`);
  check(st.pendingRestart === null && st.settings.length === 3, "live settings did not need a restart");
  let pidC = await health(pc);
  svc.control = { ...svc.control, settings: { ...svc.control.settings, PAY_TIMEOUT_MS: 30000 } };
  await waitFor(async () => { const h = await health(pc); return h && h !== pidC; }, 10000, "pay setting -> idle restart");
  const st2 = await waitFor(async () => { const s = await kstatus(pc); return s && s.settings.includes("PAY_TIMEOUT_MS") ? s : null; }, 8000, "PAY_TIMEOUT_MS in force after restart");
  const v2 = (await req(pc.port, "GET", "/version")).json.v;
  check(v2 !== v1, `screen reload requested again after the pay change (${v1} -> ${v2})`);
  check(st2 && st2.trial === false, "a settings restart is not a code trial");

  console.log("\n== remote commands");
  pidC = await health(pc);
  command("restartAt");
  await waitFor(async () => { const h = await health(pc); return h && h !== pidC; }, 10000, "restartAt -> restarted");
  const pidD = await health(pc);
  await sleep(3500);
  check(await health(pc) === pidD, "restartAt ran only once");
  const v3 = (await req(pc.port, "GET", "/version")).json.v;
  command("reloadScreenAt");
  await waitFor(async () => (await req(pc.port, "GET", "/version")).json.v !== v3, 6000, "reloadScreenAt -> /version changed");
  svc.control = { ...svc.control, commands: { ...svc.control.commands, restartAt: "next tuesday" } };
  await waitFor(async () => (await kstatus(pc)).errors.some(e => /restartAt: not an ISO time/.test(e)), 6000, "bad command time rejected + reported");
  check(await health(pc) === pidD, "...and did nothing");
  svc.control = { ...svc.control, commands: {} };

  console.log("\n== safe mode: a remote setting that crashes this build");
  publish(33, d => edit(d, "kiosk-server.js", s => s + '\nsetInterval(() => { if (CFG.HIDE_CATEGORIES.includes("E2E_CRASH")) process.exit(1); }, 300);\n'));
  command("checkUpdateAt");
  await waitFor(() => supState(pc).good && supState(pc).good.version === 33, 30000, "v33 known-good");
  svc.control = { ...svc.control, settings: { HIDE_CATEGORIES: ["E2E_CRASH"] } };
  await waitFor(() => supState(pc).safeMode, 30000, "crash loop with remote settings -> SAFE MODE");
  await waitFor(async () => { const s = await kstatus(pc); return s && s.safeMode === true && s.settings.length === 0; }, 15000, "safe mode: bad settings ignored, kiosk-config.env only");
  const pidE = await health(pc);
  await sleep(3000);
  check(await health(pc) === pidE, "stable in safe mode (no more crashes)");
  svc.control = { ...svc.control, settings: { UPDATE_INTERVAL_MIN: 9 } };
  await waitFor(async () => { const s = await kstatus(pc); return s && s.settings.includes("UPDATE_INTERVAL_MIN"); }, 8000, "new, different settings apply again");
  svc.control = { ...svc.control, settings: {} };

  console.log("\n== power cut in the middle of a trial");
  publish(34, d => edit(d, "kiosk-server.js", s => s + "\n// v34\n"));
  command("checkUpdateAt");
  await waitFor(async () => { const s = supState(pc); return s.trial && s.trial.version === 34 && s.trial.phase === "trial"; }, 15000, "v34 trial running");
  await reboot(pc);
  p = launch(pc, "task");
  await waitFor(() => supState(pc).good && supState(pc).good.version === 34, 30000, "after the power cut the trial resumed and v34 became known-good");

  console.log("\n== power cut in the middle of the file swap (journal phase 'swap')");
  await reboot(pc);
  const ks = path.join(pc.dir, "kiosk-server.js");
  const good = fs.readFileSync(ks);
  const bdir = path.join(pc.dir, ".tb", "backup", "999-v34");
  fs.mkdirSync(bdir, { recursive: true }); fs.writeFileSync(path.join(bdir, "kiosk-server.js"), good);
  fs.writeFileSync(ks, good.toString() + "\n// half-swapped\n");
  const s0 = supState(pc);
  s0.trial = { kind: "update", version: 35, from: 34, phase: "swap", startedAt: null, crashes: [], backupDir: bdir, files: [{ path: "kiosk-server.js", sha256: sha(Buffer.from(good.toString() + "\n// half-swapped\n")), existed: true }] };
  fs.writeFileSync(path.join(pc.dir, ".tb", "supervisor-state.json"), JSON.stringify(s0));
  p = launch(pc, "bat");
  await waitFor(async () => { const h = await health(pc); return h && h !== "legacy"; }, 15000, "healthy after the interrupted swap");
  check(shaFile(ks) === sha(good) && version(pc) === 34 && !supState(pc).trial, "old files restored, still v34");

  if (workerMod) {
    console.log("\n== worker: staff view + validation");
    const full = await workerStatus(true, "TestKiosk-main");
    check(full && full.kiosks && full.kiosks[0] && Array.isArray(full.kiosks[0].history) && full.kiosks[0].history.some(h => h.t === "rollback"), "staff ?full=1 has errors/rollback history");
    const pub = await workerStatus(false, "TestKiosk-main");
    check(pub && pub.online === true && !("errors" in pub) && !("history" in pub) && !("errors" in pub.kiosks[0]), "public status: online/lastSeen/version only");
    const noauth = await req(SVC, "GET", "/worker/kiosk/status?full=1");
    check(noauth.status === 401, "?full=1 without the staff secret -> 401");
  }
  await reboot(pc);
};

scenarios.bootfail = async () => {
  console.log("\n== switch-over fails (new server broken) -> legacy server carries on");
  const pc = makePc("bootfail", 18237);
  publish(24, d => edit(d, "kiosk-server.js", s => s.replace('const http   = require("http");', 'const http   = require("http"); throw new Error("e2e: broken new server");')));
  let p = launch(pc, "bat");
  await waitFor(() => version(pc) === 24, 20000, "legacy applied v24 (broken new server inside)");
  await reboot(pc);
  p = launch(pc, "task");
  await waitFor(() => supState(pc).bootstrapFailed, 20000, "switch-over trial failed and was recorded");
  await waitFor(async () => (await health(pc)) === "legacy", 15000, "legacy server serving on the same port");
  check(/handed back \(exit 78\)/.test(logOf(p)), "hook saw exit 78 and fell through to the old server");
  check((await order(pc)).json.ok === true, "orders work (legacy)");
  check(!fs.readFileSync(path.join(pc.dir, "clover-menu-server.js"), "utf8").includes("TB-KIOSK-SHIM"), "launcher not replaced");
  check(svc.pings.some(x => x.kioskId === "TestKiosk-bootfail" && x.appDown), "supervisor sent an 'app down / switch-over failed' heartbeat");

  console.log("\n== reboot again: does not retry the same broken files");
  await reboot(pc);
  p = launch(pc, "bat");
  await waitFor(async () => (await health(pc)) === "legacy", 15000, "legacy serving");
  check(/failed before with these files/.test(logOf(p)), "hook skipped the known-bad bootstrap");

  console.log("\n== tampered bootstrap file -> 'not yet'");
  await reboot(pc);
  fs.appendFileSync(path.join(pc.dir, "kiosk-lib.js"), "\n// tampered\n");
  p = launch(pc, "bat");
  await waitFor(async () => (await health(pc)) === "legacy", 15000, "legacy serving");
  check(/not yet: kiosk-lib\.js/.test(logOf(p)), "hook refused a file whose sha256 does not match tb-bootstrap.json");

  console.log("\n== fixed version published: legacy downloads it at boot, next reboot switches over");
  publish(25);
  await reboot(pc);
  p = launch(pc, "bat");
  await waitFor(() => version(pc) === 25, 20000, "legacy applied v25 at boot");
  await reboot(pc);
  p = launch(pc, "bat");
  await waitFor(async () => { const h = await health(pc); return h && h !== "legacy"; }, 20000, "switch-over to the fixed v25");
  await waitFor(() => supState(pc).installed, 25000, "known-good + installed");
  await reboot(pc);
};

scenarios.legacyonly = async () => {
  console.log("\n== an old server that never switches over keeps working with the new manifest");
  const pc = makePc("legacyonly", 18337);
  const m = publish(24);
  const p = launch(pc, "bat", { TB_NO_SWITCHOVER: "1" });
  await waitFor(() => version(pc) === 24, 20000, "legacy applied v24");
  const L = logOf(p);
  const skipped = (L.match(/update: skipped (\S+)/g) || []).map(s => s.split(" ").pop()).sort();
  check(skipped.join() === "clover-menu-server.js,flex-pay.js", "only the two refused files skipped: " + skipped.join(","));
  check(/applied v24 \(26 files\)/.test(L), "applied every other file (26 of " + m.files.length + ")");
  check(await health(pc) === "legacy" && (await order(pc)).json.ok, "legacy keeps serving and taking orders");
  check(m.files.every(f => f.size >= 32), "every manifest file >= 32 bytes (legacy aborts on smaller)");
  await reboot(pc);
};

scenarios.unsupervised = async () => {
  console.log("\n== no supervisor at all (file missing, no good copy): shim runs the server directly");
  const pc = makePc("nosup", 18437);
  publish(24);
  for (const f of ["kiosk-server.js", "kiosk-lib.js", "flex-pay.js", "moderation.js"]) fs.copyFileSync(path.join(svc.ghRoot, f), path.join(pc.dir, f));
  fs.copyFileSync(path.join(svc.ghRoot, "clover-menu-server.js"), path.join(pc.dir, "clover-menu-server.js"));
  const p = launch(pc, "bat");
  await waitFor(async () => { const h = await health(pc); return h && h !== "legacy"; }, 15000, "server up without a supervisor");
  check(/running the kiosk server directly/.test(logOf(p)) && (await kstatus(pc)).supervised === false, "reported as unsupervised");
  await reboot(pc);
};

(async () => {
  await new Promise(r => svcServer.listen(0, "127.0.0.1", r));
  SVC = svcServer.address().port;
  if (WORKER) {
    const tmp = path.join(WORK, "worker.mjs");
    fs.copyFileSync(WORKER, tmp);
    workerMod = await import("file://" + tmp);
    kv = makeKV();
  }
  console.log(`work dir ${WORK} · fake services on :${SVC}${WORKER ? " · real tb-where worker" : ""}`);
  const order_ = ["main", "bootfail", "legacyonly", "unsupervised"];
  for (const name of order_) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    try { await scenarios[name](); } catch (e) { failed++; console.log("  FAIL scenario " + name + " threw: " + (e && e.stack || e)); }
    killAll();
  }
  if (kv) console.log(`worker KV writes during the run: ${kv.writes}`);
  console.log(`\n${passed} passed, ${failed} failed`);
  svcServer.close();
  process.exit(failed ? 1 : 0);
})();
