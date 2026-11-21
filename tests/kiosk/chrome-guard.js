// tests/kiosk/chrome-guard.js — every headless Chrome a test starts is started in its OWN process group and is killed (whole group, helpers included) and its
// profile folder removed: when the test closes it, when the test finishes, on an exception or rejection, and on Ctrl-C / SIGTERM. Before this, close() killed only
// the main browser process and a throw before close() (or a process.exit) left Chrome and its tb-chrome-* profile behind.
"use strict";
const cp = require("child_process");
const fs = require("fs");
const live = new Map();   // proc -> profile dir

function spawnChrome(bin, args, opts) {
  const proc = cp.spawn(bin, args, Object.assign({}, opts, { detached: true }));   // detached = its own process group, so one kill(-pid) takes the whole browser down
  const m = args.map(String).find(a => a.startsWith("--user-data-dir="));
  live.set(proc, m ? m.slice("--user-data-dir=".length) : null);
  proc.on("exit", () => reap(proc));
  return proc;
}
function reap(proc) {
  const dir = live.get(proc); live.delete(proc);
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}
function killGroup(proc) {
  try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch {} }
  reap(proc);
}
function killAll() { for (const p of [...live.keys()]) killGroup(p); }

process.on("exit", killAll);                       // runs on normal exit, process.exit() and after the handlers below
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { killAll(); process.exit(130); });
process.on("uncaughtException", e => { console.error(e && e.stack || e); killAll(); process.exit(1); });
process.on("unhandledRejection", e => { console.error(e && e.stack || e); killAll(); process.exit(1); });

module.exports = { spawnChrome, killGroup, killAll };
