// tests/kiosk/html-syntax.js — every inline <script> in the three screens must parse (node --check does not read .html).
// Run: node tests/kiosk/html-syntax.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.resolve(__dirname, "../..");
let scripts = 0;
for (const f of ["drink-kiosk.html", "drink-kiosk-light.html", "make-station.html", "pickup-board.html"]) {
  const html = fs.readFileSync(path.join(ROOT, f), "utf8");
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, i = 0;
  while ((m = re.exec(html))) { i++; scripts++; try { new vm.Script(m[1], { filename: f + "#script" + i }); } catch (e) { console.error("SYNTAX ERROR in " + f + " script " + i + ": " + e.message); process.exit(1); } }
  if (!i) { console.error(f + ": no inline scripts found"); process.exit(1); }
}
const a = fs.readFileSync(path.join(ROOT, "drink-kiosk.html"), "utf8"), b = fs.readFileSync(path.join(ROOT, "drink-kiosk-light.html"), "utf8");
if (a !== b) { console.error("drink-kiosk-light.html must stay byte-identical to drink-kiosk.html (publish-menu.command copies one to the other)"); process.exit(1); }
console.log("html-syntax: " + scripts + " inline scripts parse; light copy identical");
