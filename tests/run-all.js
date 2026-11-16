// node tests/run-all.js — every test that needs no extra setup (tests/kiosk/e2e.js needs --legacy-dir, run it by hand).
"use strict";
const cp = require("child_process");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const jobs = [
  ["node", ["tests/kiosk/unit.js"]], ["node", ["tests/kiosk/html-syntax.js"]], ["node", ["tests/kiosk/station.js"]], ["node", ["tests/kiosk/page.js"]],
  ["node", ["tests/kiosk/seq.js"]], ["node", ["tests/kiosk/greeter.js"]], ["node", ["tests/kiosk/asis.js"]], ["node", ["tests/kiosk/consent.js"]], ["node", ["tests/kiosk/contrast.js"]], ["node", ["tests/kiosk/servers.js"]],
  ["node", ["tests/kiosk/pay-journal.js"]], ["node", ["tests/kiosk/pay-state.js"]], ["node", ["tests/kiosk/pay-server.js"]],
  ["node", ["tools/sync-recipe-defaults.js", "--check"]], ["node", ["tools/publish-manifest.js", "--check"]],
  ...["aka", "punch", "relay", "report-cors", "station"].map(n => ["node", ["tests/cloud/" + n + ".test.mjs"]]),
];
let bad = 0;
for (const [cmd, args] of jobs) {
  const r = cp.spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  const last = (r.stdout + r.stderr).trim().split("\n").filter(Boolean).pop() || "";
  console.log((r.status === 0 ? "PASS " : "FAIL ") + args.join(" ") + "  " + last.slice(0, 110));
  if (r.status !== 0) { bad++; console.log((r.stdout + r.stderr).slice(-1500)); }
}
console.log(bad ? bad + " failed" : "all passed");
process.exit(bad ? 1 : 0);
