// node tests/cloud/aka.test.mjs — Match My Vibe's "AKA <funny name>" mod rides along at $0 on phone pay.
import assert from "node:assert/strict";
import { validateCart, lineName } from "../../cloud/src/qr.js";
import { KIOSK_MENU } from "../../cloud/src/kiosk-menu.js";
const env = {};
const [catKey, c] = Object.entries(KIOSK_MENU.cats)[0];
const pick = { catKey, it: { name: c.items[0].name, price: c.items[0].price / 100 } };
const base = { name: pick.it.name, unit: pick.it.price, qty: 1, catKey: pick.catKey };
let v = await validateCart(env, { lines: [{ ...base, mods: ["AKA The Sunburnt Optimist"] }] });
assert.equal(v.ok, true, JSON.stringify(v));
assert.equal(lineName(v.lines[0]), pick.it.name + " · AKA The Sunburnt Optimist");
v = await validateCart(env, { lines: [{ ...base, mods: ["AKA One", "AKA Two"] }] });
assert.equal(v.ok, false);
v = await validateCart(env, { lines: [{ ...base, mods: ["AKA <script>"] }] });
assert.equal(v.ok, false);
v = await validateCart(env, { lines: [{ ...base, unit: pick.it.price + 1, mods: ["AKA Pricey Pal"] }] });
assert.equal(v.ok, false, "nickname never changes the price");
console.log("aka: all passed");
