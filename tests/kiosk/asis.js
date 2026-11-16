// tests/kiosk/asis.js — a drink ordered AS-IS on the kiosk must build with no false SUB on the station.
// The kiosk pre-selects each named drink's recipe base (RECIPE_DEFAULTS) using MENU spellings (Coca-Cola, Classic Lemonade); recipes.json
// spells them its own way (Coke, Lemonade). Flint CR-001: that mismatch printed "Instead of Coke" on 9 drinks. This runs every defaulted
// drink through the REAL page logic (defaultSel + calcSel) into the REAL station plan() and asserts zero sub: steps.
// Run: node tests/kiosk/asis.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const ROOT = path.resolve(__dirname, "..", "..");
const html = fs.readFileSync(path.join(ROOT, "drink-kiosk.html"), "utf8");
const st = fs.readFileSync(path.join(ROOT, "make-station.html"), "utf8");
const between = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, "marker moved: " + a); return src.slice(i, j); };

// page side
const pctx = vm.createContext({ document: {}, escK: s => s });
vm.runInContext([
  between(html, "/* ============ MENU DATA ============ */", "let MENU = THIRSTY_MENU;"),
  "let MENU = THIRSTY_MENU; let SOLD_OPTS = new Set(); let editing = null;",
  html.match(/function vibeCleanNick\([^\n]*\n/)[0],
  between(html, "const BYO_IDS", "function pick("),
  "this.api = {MENU, defaultSel, calcSel, isReq, RECIPE_DEFAULTS};",
].join("\n"), pctx);
const P = pctx.api;
// station side
const sctx = vm.createContext({ document: { querySelector() { return null; } }, console });
vm.runInContext(between(st, "const $=s=>document.querySelector(s);", "/* ---- shared step list behaviour ---- */") + "\n;this.api={plan,loadGroups,setRecipes:r=>{RECIPES=r}};", sctx);
const S = sctx.api;
S.loadGroups(JSON.parse(fs.readFileSync(path.join(ROOT, "addons.json"), "utf8")));
const recipes = JSON.parse(fs.readFileSync(path.join(ROOT, "recipes.json"), "utf8")).recipes;
S.setRecipes(recipes);

let tested = 0; const bad = [];
for (const [catKey, cat] of Object.entries(P.MENU)) for (const it of cat.items) {
  if (!P.RECIPE_DEFAULTS[it.id]) continue;
  const sel = P.defaultSel(catKey, it);
  if (cat.options.some(o => P.isReq(it, o) && !sel[o.key])) continue;      // still needs a customer pick (a float's base): not "as-is"
  const r = P.calcSel(catKey, it.price, sel);
  const plan = S.plan(it.name, JSON.parse(JSON.stringify(r.mods)), (recipes[it.name] || {}).c);
  tested++;
  for (const step of plan.steps) if (String(step[3] || "").startsWith("sub:")) bad.push(`${it.name}: "${step[0]}" ${step[3]} (mods ${r.mods.join(", ")})`);
  if (it.id === "cold-front") {                                          // CR-010: nothing extra, nothing forced
    assert.strictEqual(plan.steps.filter(s => s[3]).length, 0, "Cold Shoulder as-is has no ADD / SUB steps: " + JSON.stringify(plan.steps));
    assert.strictEqual(plan.steps.filter(s => /dr pepper/i.test(s[0])).length, 1, "one Dr Pepper step, not two");
    assert.ok(!plan.steps.some(s => /dole whip|vanilla soft/i.test(s[0])), "no forced soft-serve cap");
  }
}
assert.strictEqual(bad.length, 0, "false SUB on an as-is drink:\n" + bad.join("\n"));
assert.ok(tested >= 40, "expected to test every defaulted drink, got " + tested);
// the exact drinks Flint named
for (const [catKey, id] of [["dirtysodas", "nice-coconuts"], ["dirtysodas", "sweet-cheeks"], ["seasonal", "hayride-hottie"], ["seasonal", "naughty-nice"], ["lemonades", "main-squeeze"], ["lemonades", "pucker"], ["lemonades", "life-beaches"], ["lemonades", "easy-squeezy"], ["lemonades", "pink-flamingo"]]) {
  const it = P.MENU[catKey].items.find(i => i.id === id); assert.ok(it, id);
  assert.ok(P.RECIPE_DEFAULTS[id] && P.RECIPE_DEFAULTS[id].base, id + " has a default base");
}
// a REAL substitution is still a SUB
const real = S.plan("Nice Coconuts", ["Medium 24oz", "Pepsi", "Coconut"], "Dirty Sodas");
assert.ok(real.steps.some(s => /^sub:/.test(s[3] || "")), "Pepsi instead of Coke is still flagged");
console.log("as-is: " + tested + " defaulted drinks build with zero false SUB; Cold Shoulder is clean");
