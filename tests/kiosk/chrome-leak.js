// tests/kiosk/chrome-leak.js — a test that THROWS (or calls process.exit) after starting headless Chrome must not leave the browser or its profile behind.
"use strict";
const cp = require("child_process");
const path = require("path");
const L = require("./games-lib");
if (!L.CHROME) { console.log("chrome-leak: SKIPPED (no Chrome found)"); process.exit(0); }
const count = () => cp.execSync("ps -axo command | grep -c '[t]b-chrome-' || true", { encoding: "utf8" }).trim();
const before = parseInt(count(), 10) || 0;
let bad = 0;
for (const how of ["throw new Error('boom')", "process.exit(3)", "Promise.reject(new Error('rejected'))"]) {
  const code = `const L=require(${JSON.stringify(path.join(__dirname, "games-lib"))});(async()=>{await L.launchChrome();${how}})()`;
  const r = cp.spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 60000 });
  const after = parseInt(count(), 10) || 0;
  if (after > before) { bad++; console.error("LEAK after '" + how + "': " + (after - before) + " tb-chrome process(es) left"); }
  if (r.status === 0) { bad++; console.error("the child should have failed for '" + how + "'"); }
}
if (bad) { cp.execSync("pkill -9 -f 'tb-chrome-' || true"); process.exit(1); }
console.log("chrome-leak: 3 ways of dying, no headless Chrome left behind");
