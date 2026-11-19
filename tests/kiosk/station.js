// tests/kiosk/station.js — build-card logic of make-station.html (classify() / plan()), run in a vm with no browser.
// Run: node tests/kiosk/station.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(ROOT, "make-station.html"), "utf8");
const a = html.indexOf("const $=s=>document.querySelector(s);");
const b = html.indexOf("/* ---- shared step list behaviour ---- */");
assert.ok(a > 0 && b > a, "make-station.html markers moved: update tests/kiosk/station.js");
const ctx = vm.createContext({ document: { querySelector() { return null; } }, console });
vm.runInContext(html.slice(a, b) + "\n;this.api={plan,classify,loadGroups,setRecipes:r=>{RECIPES=r},capLabel,modText};", ctx);
const api = ctx.api;
api.loadGroups(JSON.parse(fs.readFileSync(path.join(ROOT, "addons.json"), "utf8")));
const RECIPES = JSON.parse(fs.readFileSync(path.join(ROOT, "recipes.json"), "utf8")).recipes;
api.setRecipes(RECIPES);

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error("FAIL " + name); throw e; } };
const names = p => p.steps.map(s => s[0]);
const hasFizzPour = p => p.steps.some(s => /keep the fizz/i.test(s[1]));   // the flavor-syrup pour the bug produced

/* ---- finding 3: one test ticket per cap choice ---- */
for (const cap of ["Pineapple soft serve", "Dole Whip", "Vanilla", "Twist (both)"]) {   // "Dole Whip" = an order placed before the rename
  t("Build Your Own Float + cap " + cap, () => {
    const mods = ["Regular", "Root beer", cap, "Protein scoop", "Popping boba"];
    assert.strictEqual(api.classify(cap, "Floats"), "cap");
    const p = api.plan("Build Your Own Float", mods, "Floats");
    const how = RECIPES["Build Your Own Float"].how;
    assert.ok(!hasFizzPour(p), "no flavor-syrup pour step: " + JSON.stringify(p.steps));
    assert.strictEqual(p.ingredients.length, 0, "recipe float steps are kept, not an ingredient list");
    assert.strictEqual(p.steps.length, how.length, "same number of steps as the recipe");
    assert.strictEqual(p.steps[0][0], "Root beer", "the chosen base fills the base step");
    assert.strictEqual(p.steps[1][0], api.capLabel(cap), "the cap fills the soft-serve step");
    assert.ok(/swirl/i.test(p.steps[1][1]) && p.steps[1][2] === "1 swirl");
    assert.ok(/Protein scoop/.test(p.steps[2][1]) && /Popping boba/.test(p.steps[2][1]), "boosts land in Load it up");
    assert.strictEqual(p.cup, "Regular");
  });
}
for (const cap of ["Pineapple soft serve", "Dole Whip", "Vanilla", "Twist (Pineapple + Vanilla)", "Twist (Dole Whip + Vanilla)"]) {
  t("Soft Serve Float On + flavor " + cap, () => {
    assert.strictEqual(api.classify(cap, "Soft Serve"), "cap");
    const p = api.plan("Float On", ["Regular", "Float (in juice/soda)", cap], "Soft Serve");
    assert.ok(!hasFizzPour(p));
    assert.strictEqual(p.steps[1][0], api.capLabel(cap));
    assert.strictEqual(p.steps.length, RECIPES["Float On"].how.length + 1, "serve choice rides along as one extra step");
  });
}
t("Sandy Bottom with a Vanilla cap shows a SUB for Pineapple soft serve", () => {
  const p = api.plan("Sandy Bottom", ["Regular", "Dr Pepper", "Vanilla"], "Floats");
  const s = p.steps.find(x => x[0] === "Vanilla soft serve");
  assert.ok(s && s[3] === "sub:Pineapple soft serve", JSON.stringify(p.steps));
  for (const cap of ["Pineapple soft serve", "Dole Whip"]) {      // the old spelling on an older order must not look like a substitution
    const same = api.plan("Sandy Bottom", ["Regular", "Dr Pepper", cap], "Floats");
    assert.ok(same.steps.find(x => x[0] === "Pineapple soft serve" && !x[3]), cap + ": " + JSON.stringify(same.steps));
  }
});
t("no crew-visible Dole Whip text is left in the station page, recipes or add-on names", () => {
  const html = fs.readFileSync(path.join(ROOT, "make-station.html"), "utf8");
  const shown = html.split("\n").filter(l => /Dole Whip/.test(l) && !/Older orders/.test(l));   // lowercase "dole whip" lives only in the legacy matchers (CAP_RE, DW_LEGACY, 86 alias), never on screen
  assert.deepStrictEqual(shown, [], "unexpected Dole Whip text: " + shown.join(" | ").slice(0, 300));
  assert.ok(!/dole whip/i.test(fs.readFileSync(path.join(ROOT, "recipes.json"), "utf8")), "recipes.json");
  const names = JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, "addons.json"), "utf8")).groups.flatMap(g => g.items.map(i => i.name)));
  assert.ok(!/dole/i.test(names), "addons.json display names");
});
t("the same words on a dirty soda stay flavor syrups", () => {
  assert.strictEqual(api.classify("Vanilla", "Dirty Sodas"), "flavor");
  assert.strictEqual(api.classify("Vanilla"), "flavor");
  const p = api.plan("Thirst Trap", ["Medium 24oz", "Dr Pepper", "Vanilla"], "Dirty Sodas");
  assert.ok(p.steps.some(s => s[0] === "Vanilla" && /pump/i.test(s[2])), "Vanilla is still pumped as a syrup");
  assert.strictEqual(api.classify("Vanilla cold foam", "Floats"), "topper", "a cold foam is not a cap");
  assert.strictEqual(api.classify("Vanilla Sweet Cream", "Floats"), "cream");
});
t("kiosk float upsell on a dirty soda adds a float cap step, not a syrup", () => {
  assert.strictEqual(api.classify("Float: Pineapple soft serve", "Dirty Sodas"), "cap");
  assert.strictEqual(api.classify("Float: Dole Whip", "Dirty Sodas"), "cap", "an older order");
  assert.strictEqual(api.classify("Float: Vanilla", "Dirty Sodas"), "cap");
  const p = api.plan("Thirst Trap", ["Medium 24oz", "Dr Pepper", "Float: Vanilla"], "Dirty Sodas");
  const s = p.steps.find(x => x[0] === "Vanilla soft serve");
  assert.ok(s && s[3] === "add" && s[2] === "1 swirl", JSON.stringify(p.steps));
  assert.ok(!p.steps.some(x => x[0] === "Float: Vanilla" || x[0] === "?" ), "no unknown-add-on step");
  assert.ok(!p.steps.some(x => x[2] === "?"));
  assert.ok(p.steps.find(x => x[0] === "Dr Pepper")[2] === "2/3", "soda stops at 2/3 to leave room");
});
t("Freeze-dried candy is a known add-on (topper and boost), not a ? step", () => {
  assert.strictEqual(api.classify("Freeze-dried candy", "Dirty Sodas"), "topper");
  assert.strictEqual(api.classify("Freeze-dried candy", "Floats"), "boost");
  const p = api.plan("Thirst Trap", ["Medium 24oz", "Dr Pepper", "Freeze-dried candy"], "Dirty Sodas");
  assert.ok(!p.steps.some(s => s[2] === "?"));
});
t("a size-up made on the kiosk shows on the cup badge (size is a normal mod now)", () => {
  const p = api.plan("Thirst Trap", ["Large 32oz", "Dr Pepper", "Coconut"], "Dirty Sodas");
  assert.strictEqual(p.cup, "Large 32oz");
  assert.ok(!names(p).includes("Size up"));
});
console.log("station: " + n + " checks passed");
