/* ============================================================================
   clover-menu-server.js — TB-KIOSK-SHIM v1 · Thirsty Beaches kiosk launcher
   ----------------------------------------------------------------------------
   Both ways of starting the kiosk run THIS file, unchanged since the USB days:
     * Run-Kiosk.bat / Debug-Kiosk.bat / Fix-And-Run.bat:
           node.exe --env-file=kiosk-config.env clover-menu-server.js
     * appliance mode (scheduled task "ThirstyBeachesServer", SYSTEM, at boot):
           node.exe --env-file="...\kiosk-config.env" "...\clover-menu-server.js"
   It is deliberately tiny and rarely changes. It:
     1. makes sure only ONE kiosk server runs on this PC (a lock on 127.0.0.1:PORT+2);
        a second copy exits quietly with code 0
     2. loads kiosk-supervisor.js, which runs the real server (kiosk-server.js) as a
        child process, applies updates and rolls back bad ones
     3. if that supervisor will not load, or does not get the server healthy within
        5 min, it loads the last known-good supervisor copy (.tb/good/)
     4. if no supervisor can run at all, it runs kiosk-server.js in this process
   The real server code lives in kiosk-server.js.
   ============================================================================ */
"use strict";

if (process.env.TB_SHIM_SELFTEST === "1" || process.argv.includes("--tb-selftest")) {
  console.log("TB-SHIM-SELFTEST-OK");
  process.exit(0);
}

const fs   = require("fs");
const path = require("path");
const net  = require("net");

const ROOT        = __dirname;
const PORT        = parseInt(process.env.PORT || "8080", 10);
const LOCK_PORT   = parseInt(process.env.TB_LOCK_PORT || String(PORT + 2), 10);
const LEGACY_HOST = process.env.TB_LEGACY_HOST === "1";      // started by the old server's moderation.js hook
const WATCHDOG_MS = parseInt(process.env.TB_SHIM_WATCHDOG_MS || "", 10) || 5 * 60000;
const BANNER      = "TB-KIOSK-LOCK\n";
const log = (...a) => { try { console.log("[launcher]", ...a); } catch {} };

let current = null, watchdog = null, forceGood = false, appInProcess = false, recovering = false, lastLoadError = "";

function stopCurrent() {
  clearTimeout(watchdog); watchdog = null;
  const c = current; current = null;
  if (c && c.m && typeof c.m.stop === "function") { try { c.m.stop(); } catch (e) { log("stop failed:", e.message); } }
}

function tryLoad(file, reason, isFallback) {
  if (!fs.existsSync(file)) return false;
  try {
    delete require.cache[require.resolve(file)];
    const m = require(file);
    if (!m || typeof m.start !== "function") throw new Error("not a supervisor module");
    current = { m, file, isFallback };
    const goodCopy = path.join(ROOT, ".tb", "good", "kiosk-supervisor.js");
    if (!isFallback && fs.existsSync(goodCopy)) {
      // a supervisor that never gets the server healthy is replaced by the known-good copy
      watchdog = setTimeout(() => {
        log("supervisor did not get the kiosk server healthy within", Math.round(WATCHDOG_MS / 60000), "min — switching to the known-good supervisor");
        stopCurrent(); forceGood = true; boot("watchdog: no healthy server in time");
      }, WATCHDOG_MS);
    }
    m.start({
      root: ROOT, shimFile: __filename, shimVersion: 1, legacyHost: LEGACY_HOST, reason, fallback: isFallback,
      markOk: () => { clearTimeout(watchdog); watchdog = null; },
      reload: r => setTimeout(() => { stopCurrent(); forceGood = false; boot(r || "reload"); }, 50),
    });
    return true;
  } catch (e) {
    lastLoadError = String((e && e.message) || e).slice(0, 120);
    log(`could not start ${path.relative(ROOT, file)}: ${lastLoadError}`);
    stopCurrent();
    return false;
  }
}

function boot(reason) {
  const primary = path.join(ROOT, "kiosk-supervisor.js");
  const good    = path.join(ROOT, ".tb", "good", "kiosk-supervisor.js");
  if (!forceGood && tryLoad(primary, reason, false)) return;
  if (tryLoad(good, forceGood ? reason : `it failed to start: ${lastLoadError}`, true)) return;
  if (LEGACY_HOST) { log("no supervisor could start — handing back to the legacy server"); process.exit(78); }
  log("no supervisor could start — running the kiosk server directly (no automatic restarts or rollback)");
  appInProcess = true;
  require("./kiosk-server.js");
}

process.on("uncaughtException", e => {
  log("unexpected error:", (e && e.stack) || e);
  if (appInProcess) process.exit(1);                         // same as the old server: die, let the launcher restart it
  if (recovering) return;
  recovering = true;
  setTimeout(() => { recovering = false; stopCurrent(); boot("recovered from an unexpected error"); }, 3000);
});
process.on("unhandledRejection", e => log("unhandled rejection:", (e && e.message) || e));
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  try { process.on(sig, () => { log("stopping (" + sig + ")"); stopCurrent(); process.exit(0); }); } catch {}
}

/* ---- single instance: hold a tiny TCP listener for as long as this process lives ---- */
const lock = net.createServer(s => { s.on("error", () => {}); s.end(BANNER); });
lock.on("error", e => {
  if (e.code !== "EADDRINUSE") { log("instance lock unavailable:", e.message, "— continuing without it"); return boot("start"); }
  // something holds the lock port: another kiosk launcher (exit quietly) or an unrelated program (carry on)
  let got = "", decided = false;
  const c = net.connect(LOCK_PORT, "127.0.0.1");
  const done = isKiosk => {
    if (decided) return;
    decided = true;
    c.destroy();
    if (isKiosk) { log("the kiosk server is already running on this PC — this copy exits"); setTimeout(() => process.exit(0), 100); }
    else { log(`port ${LOCK_PORT} is used by another program — continuing without the instance lock`); boot("start"); }
  };
  c.setTimeout(3000, () => done(false));
  c.on("data", d => { got += d; if (got.includes(BANNER.trim())) done(true); });
  c.on("error", () => done(false));
  c.on("end", () => done(got.includes(BANNER.trim())));
});
lock.listen(LOCK_PORT, "127.0.0.1", () => boot("start"));
