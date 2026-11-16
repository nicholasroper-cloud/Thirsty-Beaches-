// tests/kiosk/page.js — kiosk page logic, run in a vm with no browser:
//   * named-drink defaults (recipe base, signature cap, Medium 24oz; Required only on Pour Decisions and Build Your Own Float)
//   * the attach prompt: which offers show, one tap each, size up = the next real size, float cap chips, topper at menu price,
//     Edit keeps the upsell, and every line the page can build is priced by the cloud price book to the same cent
//   * the age screen thresholds
// Run: node tests/kiosk/page.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const ROOT = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(ROOT, "drink-kiosk.html"), "utf8");
const between = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); assert.ok(i >= 0 && j > i, "marker moved: " + a + " .. " + b); return html.slice(i, j); };

(async () => {
  const code = [
    between("/* ============ MENU DATA ============ */", "let MENU = THIRSTY_MENU;"),
    "let MENU = THIRSTY_MENU; let SOLD_OPTS = new Set(); let editing = null;",
    html.match(/function vibeCleanNick\([^\n]*\n/)[0],
    between("const BYO_IDS", "function pick("),
    between("const FLOAT_CATS", "function showUpsell("),
    between("const AGE_MIN_YEARS", "function ageReset"),
    "this.api = {MENU, defaultSel, calcSel, buildUpsellOffers, applyUpsell, isFloatLine, ageYearOk, FLOAT_UPSELL, RECIPE_DEFAULTS, setSold:s=>{SOLD_OPTS=s}};",
  ].join("\n");
  const ctx = vm.createContext({ document: {}, escK: s => s });
  vm.runInContext(code, ctx);
  const A = ctx.api, MENU = A.MENU;
  let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
  const J = x => JSON.parse(JSON.stringify(x));
  const eq = (a, b, m) => { assert.deepStrictEqual(J(a), J(b), m); n++; };
  const item = (cat, id) => MENU[cat].items.find(i => i.id === id);
  const lineOf = (catKey, id, sel) => {                       // what addToCart() builds
    const it = item(catKey, id), r = A.calcSel(catKey, it.price, sel);
    return { name: it.name, mods: r.mods, unit: r.unit, qty: 1, catKey, itemId: id, basePrice: it.price, sel: JSON.parse(JSON.stringify(sel)) };
  };
  const tapOffer = (line, id, arg) => A.applyUpsell(line, id, arg);

  // ---- named drinks arrive filled in ----
  let sel = A.defaultSel("dirtysodas", item("dirtysodas", "thirst-trap"));
  eq([sel.size, sel.base], ["Medium 24oz", "Dr Pepper"], "Thirst Trap: Medium + the recipe's own base");
  eq(A.defaultSel("dirtysodas", item("dirtysodas", "nice-coconuts")).base, "Coca-Cola", "recipe says Coke, the menu says Coca-Cola");
  eq(A.defaultSel("floats", item("floats", "beached-whale")).cap, "Dole Whip", "Sandy Bottom: Dole Whip cap");
  sel = A.defaultSel("dirtysodas", item("dirtysodas", "pour-decisions"));
  eq([sel.size, sel.base], ["Medium 24oz", null], "Pour Decisions: size only, base stays Required");
  sel = A.defaultSel("floats", item("floats", "byo-float"));
  eq([sel.base, sel.cap], [null, null], "Build Your Own Float: base and cap stay Required");
  eq(A.defaultSel("coffee", item("coffee", "cloud-nine")).size, "12oz", "no Medium 24oz in this category: first size");
  for (const [k, c] of Object.entries(MENU)) for (const it of c.items) {         // every default is a real choice of that drink's category
    const d = A.RECIPE_DEFAULTS[it.id]; if (!d) continue;
    for (const g of ["base", "cap"]) if (d[g]) ok(c.options.find(o => o.key === g).choices.some(ch => ch.name === d[g]), `${it.id}.${g}=${d[g]} exists in ${k}`);
  }
  A.setSold(new Set(["base:Dr Pepper"]));
  eq(A.defaultSel("dirtysodas", item("dirtysodas", "thirst-trap")).base, null, "a sold-out default is not pre-selected");
  A.setSold(new Set());

  // ---- attach prompt ----
  const trap = () => lineOf("dirtysodas", "thirst-trap", A.defaultSel("dirtysodas", item("dirtysodas", "thirst-trap")));
  let line = trap();
  let offers = A.buildUpsellOffers(line);
  eq(offers.map(o => o.id), ["float", "topper", "size"], "a plain dirty soda gets all three offers");
  eq(offers[0].chips.map(c => c.label), ["Dole Whip", "Vanilla"], "float offer carries its two cap chips");
  eq(offers.find(o => o.id === "topper").price, 0.5, "topper at its MENU price (Whipped cream)");
  eq([offers.find(o => o.id === "size").name, offers.find(o => o.id === "size").price], ["Size up to Large 32oz", 0.7], "size up = the NEXT real size, priced as the difference");

  // vanilla syrup on a dirty soda must NOT hide the offers (it used to: the test was a regex on every mod)
  for (const [g, name] of [["flavor", "Vanilla"], ["cream", "Vanilla Sweet Cream"]]) {
    const s2 = A.defaultSel("dirtysodas", item("dirtysodas", "thirst-trap"));
    if (g === "flavor") s2.flavor.push(name); else s2.cream = name;
    const o2 = A.buildUpsellOffers(lineOf("dirtysodas", "thirst-trap", s2)).map(o => o.id);
    ok(o2.includes("float") && o2.includes("topper") && o2.includes("size"), "all offers still show with " + name + ": " + o2);
  }
  // already a float -> only the float offer disappears; topper and size up stay
  for (const [cat, id] of [["floats", "beached-whale"], ["floats", "byo-float"]]) {
    const s3 = A.defaultSel(cat, item(cat, id)); if (!s3.base) s3.base = "Root beer"; if (!s3.cap) s3.cap = "Dole Whip";
    const o3 = A.buildUpsellOffers(lineOf(cat, id, s3)).map(o => o.id);
    ok(!o3.includes("float") && o3.includes("topper") && o3.includes("size"), `${id}: no float offer, but topper + size up: ${o3}`);
  }
  ok(A.isFloatLine({ catKey: "dirtysodas", sel: { cap: "Vanilla" } }), "a cap selection makes it a float");
  ok(A.isFloatLine({ catKey: "dolewhip", sel: {} }), "Soft Serve category");
  ok(A.isFloatLine({ catKey: "dolewhip", sel: { serve: "Float (in juice/soda)" } }));
  ok(!A.isFloatLine({ catKey: "dirtysodas", sel: { flavor: ["Vanilla"], cream: "Vanilla Sweet Cream" } }), "vanilla syrup / cream is not a float");
  eq(A.buildUpsellOffers(lineOf("treats", "fd-candy-sm", {})), [], "candy bags get no prompt");

  // each tap applies at once; several can be picked; tap again takes it back
  const base0 = line.unit;
  tapOffer(line, "size");
  eq([line.sel.size, line.mods.includes("Large 32oz"), line.unit], ["Large 32oz", true, +(base0 + 0.7).toFixed(2)], "size up sets the next real size and re-prices");
  ok(!line.mods.includes("Size up"), "no more fake 'Size up' mod: the station sees a real cup size");
  tapOffer(line, "topper");
  ok(line.mods.includes("Whipped cream") && line.sel.topper.includes("Whipped cream"), "topper lands in the topper group");
  tapOffer(line, "float", "Vanilla");
  eq(line.mods[line.mods.length - 1], "Float: Vanilla", "float cap is the last add-on and names its group");
  eq(line.unit, +(base0 + 0.7 + 0.5 + 1.5).toFixed(2), "all three picked: size + whipped cream + float, all at menu prices");
  tapOffer(line, "float", "Dole Whip");
  eq(line.sel._float, "Dole Whip", "the other chip switches the cap");
  tapOffer(line, "float", "Dole Whip"); tapOffer(line, "size"); tapOffer(line, "topper");
  eq([line.unit, line.mods.join("|")], [base0, trap().mods.join("|")], "tapping each again returns the line exactly to where it was");

  // Edit keeps the upsell: a customer edit rebuilds from `sel`, which carries it
  line = trap(); tapOffer(line, "float", "Dole Whip"); tapOffer(line, "topper");
  const edited = lineOf("dirtysodas", "thirst-trap", JSON.parse(JSON.stringify(line.sel)));
  eq([edited.unit, edited.mods], [line.unit, line.mods], "Edit -> Add rebuilds the identical line (upsell and price kept)");
  line.sel.size = "Small 16oz";
  eq(lineOf("dirtysodas", "thirst-trap", line.sel).mods.includes("Small 16oz"), true);

  // size up offers the NEXT size only if there is one, and says nothing on the biggest
  const big = lineOf("dirtysodas", "thirst-trap", { ...A.defaultSel("dirtysodas", item("dirtysodas", "thirst-trap")), size: "Large 32oz" });
  ok(!A.buildUpsellOffers(big).some(o => o.id === "size"), "already the largest: no size-up offer");
  const small = lineOf("dirtysodas", "thirst-trap", { ...A.defaultSel("dirtysodas", item("dirtysodas", "thirst-trap")), size: "Small 16oz" });
  eq(A.buildUpsellOffers(small).find(o => o.id === "size").price, 0.8, "Small to Medium costs the menu difference");

  // ---- the cloud price book prices every line the page can build, to the cent ----
  const { kioskCandidates, pickPrice } = await import(path.join(ROOT, "cloud/src/pricebook.js"));
  const { KIOSK_MENU } = await import(path.join(ROOT, "cloud/src/kiosk-menu.js"));
  const priced = l => { const r = kioskCandidates({ name: l.name, mods: l.mods, unit: l.unit, qty: 1, catKey: l.catKey }, KIOSK_MENU); return r.found ? pickPrice(Math.round(l.unit * 100), [r.totals]) : null; };
  const cases = [];
  for (const [cat, id] of [["dirtysodas", "thirst-trap"], ["dirtysodas", "pour-decisions"], ["floats", "beached-whale"], ["lemonades", "main-squeeze"], ["beachbabies", "lil-squirt"]]) {
    const s4 = A.defaultSel(cat, item(cat, id));
    for (const o of MENU[cat].options) if (o.required && !o.multi && !s4[o.key]) s4[o.key] = o.choices[0].name;
    const l0 = lineOf(cat, id, s4); cases.push(l0);
    for (const seq of [["size"], ["topper"], ["float", "Dole Whip"], ["size", "topper", "float:Vanilla"]]) {
      const l1 = lineOf(cat, id, JSON.parse(JSON.stringify(s4)));
      for (const step of seq) { const [sid, arg] = step.split(":"); const o = A.buildUpsellOffers(l1).find(x => x.id === sid); if (o) tapOffer(l1, sid, arg || (sid === "float" ? "Dole Whip" : undefined)); }
      cases.push(l1);
    }
  }
  for (const l of cases) ok(priced(l) === Math.round(l.unit * 100), `price book accepts ${l.name} [${l.mods.join(", ")}] at $${l.unit}`);

  // ---- age screen thresholds ----
  const Y = 2026;
  eq([A.ageYearOk(Y - 14, Y), A.ageYearOk(Y - 13, Y), A.ageYearOk(Y - 12, Y), A.ageYearOk(Y - 40, Y)], [true, false, false, true], "a year that could still be 12 does not open the camera");
  for (const bad of [null, undefined, "", "abc", NaN, Y + 1, Y - 200, 2014.5]) ok(!A.ageYearOk(bad, Y), "unknown / junk answer is not 13+: " + bad);
  // the screen itself is neutral: no default selection, no mention of a cutoff, three ways out that all route to the no-photo path
  const gate = html.slice(html.indexOf('<div id="ageGate"'), html.indexOf("<!-- UPSELL / ATTACH PROMPT"));
  ok(!/\b1[0-9]\b|13|under|older|adult|years old/i.test(gate.replace(/<!--[\s\S]*?-->/g, "").replace(/id="age[^"]*"|ageAnswer\(|aria-[a-z]+="[^"]*"/g, "")), "age screen text names no age or cutoff");
  ok(/ageAnswer\(null\)/.test(gate) && /ageAnswer\(false\)/.test(gate), "Skip and Never mind exist");
  ok(!/\bon\b|selected|checked/.test(gate.replace(/onclick/g, "")), "nothing is pre-selected in the markup");
  ok(/if\(_ageOk === null\)\{ askAge\(snapAllow, snapMoodStage\)/.test(html) && /if\(_ageOk === null\)\{ askAge\(vibeAllow, vibeSurprise\)/.test(html), "both camera entry points ask first");
  ok(/if\(!_ageOk\)\{ vibeSurprise\(\)/.test(html) && /if\(!_ageOk\)\{ snapMoodStage\(\)/.test(html), "a no routes to the no-photo path");

  // ---- strings the compliance gate retired ----
  for (const bad of [/Every 5th float/i, /isn't saved/i, /never saved/i, /isn't stored/i, /Spin the Tide/i, /spinTide\(/]) ok(!bad.test(html), "page no longer contains " + bad);
  ok(html.includes("Your photo goes to our AI provider to pick your drink. We don't keep it; the provider may hold it for up to 30 days for safety checks, then deletes it. Ages 13+ only."), "retention notice present");
  ok(html.includes("Grown-ups only in the photo. Snapping the view or your drink works too."), "camera-screen line present");
  ok(html.includes("Our AI invents this drink from the chips you tap. No names or photos, and nothing is saved."), "Design Your Own notice present");
  ok(/<div class="tidelist" id="tidelist" hidden>/.test(html), "Tide List is hidden");
  ok(html.includes("First name only. It shows on the pickup screen and we'll call it out."), "name-pad subhead");
  // the beach-name lists on the page and on the server are the same (the server lets exactly those two-word names through)
  const srv = fs.readFileSync(path.join(ROOT, "kiosk-server.js"), "utf8");
  const list = (src, name) => JSON.parse(src.match(new RegExp("(?:const " + name + "\\s*=\\s*)(\\[[^\\]]*\\])"))[1]);
  eq(list(html, "BEACH_FIRST"), list(srv, "NAME_FIRST"), "beach first names match the server's"); eq(list(html, "BEACH_LAST"), list(srv, "NAME_LAST"), "beach last names match the server's");
  console.log("page: " + n + " checks passed");
})().catch(e => { console.error(e); process.exit(1); });
