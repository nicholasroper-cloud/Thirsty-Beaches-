// tests/kiosk/catalog.js — catalog.js (sync, last-good, drift hold, tax allow-list) and quote.js (server-side pricing, Clover cross-check,
// Maze line discount, atomic order creation) against an in-memory fake Clover. No network, no real Clover, no writes anywhere real.
// Run: node tests/kiosk/catalog.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { createCatalog, buildTable } = require("../../catalog");
const { createQuoteApi, parseCheckout } = require("../../quote");

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tb-catalog-"));
const ID = (p, n) => (p + String(n).padStart(9, "0")).toUpperCase();   // 13 chars like a Clover id

/* ---------------- the kiosk menu keys (a small map; the real one is catalog-map.json) ---------------- */
const SZ = ["Small 16oz", "Medium 24oz", "Large 32oz"];
const MAP = { version: 1, floats: [{ mod: "Float: Dole Whip", clover: "FLOATDOLE0001" }], categories: {
  dirtysodas: { items: { "thirst-trap": { name: "Thirst Trap", clover: "ITEMTRAP00001" }, "pink-flamingo": { name: "Pink Flamingo", clover: "ITEMFLAM00001" }, unmapped: { name: "Nope", clover: null } },
    options: [
      { key: "size", multi: false, choices: [{ name: SZ[0], clover: "MODSMALL00001" }, { name: SZ[1], clover: "MODMEDIUM0001" }, { name: SZ[2], clover: "MODLARGE00001" }] },
      { key: "flavor", multi: true, choices: [{ name: "Coconut", clover: "MODCOCONUT001" }, { name: "Lime", clover: null }] },
    ] } } };

/* ---------------- fake Clover ---------------- */
function mkFake() {
  const f = {
    items: [], groups: [], taxRates: [{ id: "TAXFL7000001", name: "FL sales tax", rate: 700000, isDefault: true }],
    calls: [], orders: new Map(), seq: 0, skew: 0, checkoutShape: "ok", failCheckout: false, omitTotal: false, failTitle: false, deleted: [], pageSize: 500, neverExhaust: false,
  };
  const items = (id, name, price) => ({ id, name, price, hidden: false, defaultTaxRates: true, taxRates: { elements: [] }, modifierGroups: { elements: [] } });
  f.items.push(items("ITEMTRAP00001", "Thirst Trap", 349), items("ITEMFLAM00001", "Pink Flamingo", 399));
  f.groups.push({ id: "GRPSIZE000001", name: "Size", modifiers: { elements: [{ id: "MODSMALL00001", name: "Small 16oz", price: 0 }, { id: "MODMEDIUM0001", name: "Medium 24oz", price: 80 }, { id: "MODLARGE00001", name: "Large 32oz", price: 150 }] } },
    { id: "GRPFLAVOR0001", name: "Flavor", modifiers: { elements: [{ id: "MODCOCONUT001", name: "Coconut", price: 50 }, { id: "FLOATDOLE0001", name: "Float: Dole Whip", price: 150 }] } });
  const ratePct = () => f.taxRates[0].rate / 1e7;
  function price(cart) {                                   // Clover's own arithmetic (per line item, tax rounded per line)
    let total = 0, taxT = 0; const els = [];
    const mod = id => { for (const g of f.groups) for (const m of g.modifiers.elements) if (m.id === id) return m; return null; };
    for (const li of cart.lineItems) {
      const it = f.items.find(i => i.id === li.item.id); let p = it.price;
      for (const m of li.modifications || []) p += mod(m.modifier.id).price;
      const disc = (li.discounts || []).reduce((a, d) => a + (d.amount || 0), 0);
      const taxable = p + disc, tax = Math.round(taxable * ratePct());
      total += taxable + tax; taxT += tax; els.push({ taxRates: { elements: [{ taxAmount: tax }] } });
    }
    return { total: total + f.skew, taxT, els };
  }
  f.get = async p => {
    f.calls.push("GET " + p.split("?")[0]);
    const u = new URL(p, "http://x"), lim = +u.searchParams.get("limit") || 100, off = +u.searchParams.get("offset") || 0, path0 = u.pathname;
    const page = list => ({ elements: f.neverExhaust ? Array.from({ length: lim }, (_, i) => list[0]) : list.slice(off, off + Math.min(lim, f.pageSize)) });
    if (path0 === "/items") return page(f.items);
    if (path0 === "/modifier_groups") return page(f.groups);
    if (path0 === "/tax_rates") return page(f.taxRates);
    let m; if ((m = /^\/orders\/([A-Z0-9]+)$/.exec(path0))) { const o = f.orders.get(m[1]); if (!o) throw new Error("404"); return { ...o }; }
    if (path0 === "/orders") return { elements: [] };
    throw new Error("404 " + p);
  };
  f.post = async (p, body) => {
    f.calls.push("POST " + p);
    if (p === "/atomic_order/checkouts") {
      if (f.failCheckout) throw new Error("500");
      const r = price(body.orderCart);
      if (f.checkoutShape === "ok") return { total: r.total, lineItems: { elements: r.els } };
      if (f.checkoutShape === "junk") return { hello: "world" };
      if (f.checkoutShape === "notax") return { total: r.total };
    }
    if (p === "/atomic_order/orders") {
      const r = price(body.orderCart); const id = ID("ORD", ++f.seq);
      const o = { id, state: "open", orderType: body.orderCart.orderType, lineItems: { elements: body.orderCart.lineItems.map(l => ({ ...l })) }, ...(f.omitTotal ? {} : { total: r.total }) };
      f.orders.set(id, o); return { ...o };
    }
    let m; if ((m = /^\/orders\/([A-Z0-9]+)$/.exec(p))) {
      if (f.failTitle && body.title) throw new Error("500 title");
      Object.assign(f.orders.get(m[1]), body); return {};
    }
    throw new Error("404 " + p);
  };
  return f;
}

(async () => {
  /* ================= catalog.js ================= */
  {
    const f = mkFake(), dir = tmp(); let t = 1.7e12;
    const cat = createCatalog({ cloverGet: f.get, dir, map: MAP, taxAllow: [7], now: () => t, log: quiet });
    ok(!cat.table() && cat.payBlock() === "catalog not synced");
    await cat.sync();
    ok(cat.table() && Object.keys(cat.table().items).length === 2, "first sync fills the table");
    ok(fs.existsSync(path.join(dir, "catalog.json")) && !fs.readdirSync(dir).some(n => n.includes(".tmp")), "written, and no temp file left behind");
    eq(cat.payBlock(), null, "tax rate 7% is in the allow-list");
    const d = cat.display();
    eq([d.ok, d.payNow, d.items["dirtysodas/thirst-trap"], d.mods["dirtysodas/size/Medium 24oz"], d.mods["float/Float: Dole Whip"], d.tax.pct], [true, true, 349, 80, 150, 7]);
    ok(!("dirtysodas/unmapped" in d.items), "only mapped keys are priced");
    // a restart reads the last good copy from disk
    const cat2 = createCatalog({ cloverGet: async () => { throw new Error("offline"); }, dir, map: MAP, taxAllow: [7], now: () => t, log: quiet });
    ok(cat2.table() && cat2.table().items.ITEMTRAP00001.price === 349, "last good copy loads from disk");
    await cat2.sync(); ok(cat2.table() && cat2.heartbeat().lastError, "an offline sync keeps the copy and reports the error");
    // a corrupt file on disk is ignored
    fs.writeFileSync(path.join(dir, "catalog.json"), '{"version":1,"items":{"bad id":{}}}');
    ok(!createCatalog({ cloverGet: f.get, dir, map: MAP, log: quiet }).table(), "an invalid catalog.json is not trusted");
  }
  { // paging: 1,250 items need three pages, all of them read; a list that never ends is an error, not a short list
    const f = mkFake(), dir = tmp(); f.pageSize = 500;
    for (let i = 0; i < 1250; i++) f.items.push({ id: ID("FILL", i), name: "Filler " + i, price: 100, taxRates: { elements: [] } });
    const cat = createCatalog({ cloverGet: f.get, dir, map: MAP, taxAllow: [7], log: quiet });
    await cat.sync();
    eq(Object.keys(cat.table().items).length, 1252, "every page was read");
    eq(f.calls.filter(c => c === "GET /items").length, 3, "paged until a short page");
    const f2 = mkFake(); f2.neverExhaust = true;
    const cat3 = createCatalog({ cloverGet: f2.get, dir: tmp(), map: MAP, taxAllow: [7], log: quiet });
    await cat3.sync(); ok(!cat3.table() && /not exhausted/.test(cat3.state.lastError), "a list that never ends is refused");
  }
  { // schema: one bad element rejects the whole sync, last good stays
    const f = mkFake(), dir = tmp();
    const cat = createCatalog({ cloverGet: f.get, dir, map: MAP, taxAllow: [7], log: quiet }); await cat.sync();
    const before = JSON.stringify(cat.table());
    f.items.push({ id: "ITEMBADPRICE1", name: "Bad", price: 3.5 });
    await cat.sync(); eq(JSON.stringify(cat.table()), before, "bad price: last good kept"); ok(/bad item price/.test(cat.state.lastError));
    f.items.pop(); f.items.push({ id: "x", name: "short id" }); await cat.sync(); eq(JSON.stringify(cat.table()), before, "bad id: last good kept");
    f.items.pop(); f.taxRates.push({ id: "TAXBAD0000001", name: "silly", rate: 9e9 }); await cat.sync(); eq(JSON.stringify(cat.table()), before, "absurd tax rate: last good kept");
    f.taxRates.pop();
  }
  { // mapped id missing / count drop > 10% -> keep last good; drift > 50% or under the floor -> HOLD (not promoted); owner accept flag promotes
    const f = mkFake(), dir = tmp(); let t = 1.7e12;
    for (let i = 0; i < 20; i++) f.items.push({ id: ID("FILL", i), name: "F" + i, price: 200, taxRates: { elements: [] } });
    const cat = createCatalog({ cloverGet: f.get, dir, map: MAP, taxAllow: [7], now: () => t, log: quiet }); await cat.sync();
    const good = cat.table();
    const trap = f.items[0];
    f.items.shift(); await cat.sync();
    ok(cat.table() === good && /mapped item ITEMTRAP00001 is missing/.test(cat.heartbeat().alerts.join()), "mapped id missing: last good kept, alert raised");
    f.items.unshift(trap);
    const saved = f.items.splice(10, 8); await cat.sync();
    ok(cat.table() === good && /dropped/.test(cat.state.alerts.map(a => a.msg).join()), "item count dropped more than 10%: last good kept");
    f.items.push(...saved);
    trap.price = 900; await cat.sync();                                          // 349 -> 900
    ok(cat.table() === good, "a 158% price move is NOT promoted");
    ok(cat.payBlock() && /held/.test(cat.payBlock()) && cat.display().payNow === false && cat.heartbeat().hold >= 1, "payNow false and a heartbeat alert while held");
    ok(/PAYMENT HELD/.test(cat.heartbeat().alerts.join()));
    trap.price = 349; await cat.sync(); eq(cat.payBlock(), null, "the hold clears when prices come back");
    trap.price = 100; await cat.sync(); ok(cat.table().items.ITEMTRAP00001.price === 349 && cat.payBlock(), "a 71% drop also holds, and the last good price is still the one served");
    trap.price = 10; await cat.sync(); ok(/floor|moved/.test(cat.payBlock()), "under the floor holds");
    trap.price = 380;                                                            // +9%: a normal price change goes straight through
    await cat.sync(); eq(cat.table().items.ITEMTRAP00001.price, 380, "a small change is promoted"); eq(cat.payBlock(), null);
    trap.price = 800; await cat.sync(); ok(cat.payBlock());
    fs.writeFileSync(path.join(dir, "catalog-accept.flag"), "");
    await cat.sync();
    eq(cat.table().items.ITEMTRAP00001.price, 800, "the owner's accept flag promotes the new prices"); eq(cat.payBlock(), null);
    ok(!fs.existsSync(path.join(dir, "catalog-accept.flag")), "and is consumed");
    t += 7 * 3600000; ok(/older than/.test(cat.payBlock()), "a catalog older than 6 hours blocks pay");
  }
  { // the price floor holds payment even on the very first sync (nothing to compare with)
    const f = mkFake(); f.items[0].price = 10;
    const cat = createCatalog({ cloverGet: f.get, dir: tmp(), map: MAP, taxAllow: [7], log: quiet }); await cat.sync();
    ok(cat.table() && /floor/.test(cat.payBlock()), "an item under the floor holds pay: " + cat.payBlock());
    await cat.sync(); ok(/floor/.test(cat.payBlock()), "and keeps holding while it lasts");
    f.items[0].price = 349; await cat.sync(); eq(cat.payBlock(), null, "until the price is fixed");
  }
  { // tax allow-list
    const f = mkFake();
    const none = createCatalog({ cloverGet: f.get, dir: tmp(), map: MAP, taxAllow: [], log: quiet }); await none.sync();
    ok(/allow-list not configured/.test(none.payBlock()), "no allow-list = payNow stays false");
    const wrong = createCatalog({ cloverGet: f.get, dir: tmp(), map: MAP, taxAllow: [6.5, 7.25], log: quiet }); await wrong.sync();
    ok(/not in the allow-list/.test(wrong.payBlock()), "a rate that is not allowed blocks pay");
    f.taxRates[0].rate = 650000;
    const right = createCatalog({ cloverGet: f.get, dir: tmp(), map: MAP, taxAllow: [6.5], log: quiet }); await right.sync(); eq(right.payBlock(), null);
  }
  eq(parseCheckout({ total: 1000, lineItems: { elements: [{ taxRates: { elements: [{ taxAmount: 65 }] } }] } }), { total: 1000, tax: 65 });
  eq(parseCheckout({ total: 1000, totalTaxAmount: 65 }), { total: 1000, tax: 65 });
  for (const bad of [null, {}, { total: "10" }, { total: 10 }, { total: 10, lineItems: { elements: [{ taxRates: { elements: [{}] } }] } }]) eq(parseCheckout(bad), null, "unreadable: " + JSON.stringify(bad));

  /* ================= quote.js ================= */
  async function rig(o = {}) {
    const f = o.fake || mkFake(), dir = tmp();
    if (o.tweak) o.tweak(f);
    const catalog = createCatalog({ cloverGet: f.get, dir, map: MAP, taxAllow: [7], log: quiet }); await catalog.sync();
    const r = { f, catalog, prize: { check: { ok: true }, burn: { ok: true } }, prizeCalls: [], regs: [], allowed: true, now: 1.7e12 };
    r.api = createQuoteApi({ catalog, map: MAP, cloverGet: f.get, cloverPost: f.post, cloverDelete: async id => { f.deleted.push(id); f.orders.delete(id); },
      prizeCheck: async (code, redeem) => { r.prizeCalls.push({ code, redeem, afterOrder: f.calls.includes("POST /atomic_order/orders") }); return redeem ? r.prize.burn : r.prize.check; },
      nextOrderSeq: async () => 104, cleanCustomerName: n => n, modsNote: mods => mods.length ? "MODS: " + mods.join(" | ") : "",
      orderTypeId: o.orderTypeId === undefined ? "KIOSKTYPE0001" : o.orderTypeId, orderPath: o.orderPath || "atomic", quoteAllowed: () => r.allowed, payRunning: () => o.payRunning !== false,
      payRegister: (id, mode) => { r.regs.push({ id, mode }); return "t".repeat(32); }, now: () => r.now, log: quiet });
    return r;
  }
  const f2 = r => r.f.calls;
  const L = (extra = {}) => ({ catKey: "dirtysodas", itemId: "thirst-trap", sel: { size: SZ[1], flavor: ["Coconut"] }, qty: 1, ...extra });

  { // pricing, tax, cross-check
    const r = await rig();
    const q = (await r.api.quote({ cart: [L()] })).body;
    // 349 + 80 + 50 = 479; tax 7% = 34 (33.53); total 513
    eq([q.ok, q.payNow, q.subtotal, q.discount, q.tax, q.total, q.taxPct, q.taxName], [true, true, 479, 0, 34, 513, 7, "FL sales tax"]);
    ok(/^[0-9a-f]{32}$/.test(q.quoteId) && q.expiresInMs === 600000);
    ok(q.lines[0].mods.join() === "Medium 24oz,Coconut", "mods come back in menu order");
    eq(f2(r).filter(c => c === "POST /atomic_order/checkouts").length, 1, "Clover's checkout was asked");
    ok(!f2(r).includes("POST /atomic_order/orders"), "a quote creates NO order");
    // qty, float, notes
    const q2 = (await r.api.quote({ cart: [L({ qty: 2, float: "Float: Dole Whip", notes: ["Pretty in pink", "x|y"], nick: "Cap'n" })] })).body;
    eq([q2.subtotal, q2.payNow], [2 * (479 + 150), true]);
    // unmapped keys are refused and listed (nothing guessed)
    const u = (await r.api.quote({ cart: [L({ itemId: "unmapped" }), L({ sel: { size: SZ[1], flavor: ["Lime"] } })] })).body;
    eq([u.ok, u.payNow, u.error], [false, false, "unmapped"]);
    ok(u.unmapped.includes("item dirtysodas/unmapped"), "lists the unmapped item"); 
    const u2 = (await r.api.quote({ cart: [L({ sel: { size: SZ[1], flavor: ["Lime"] } })] })).body;
    eq(u2.unmapped, ["mod dirtysodas/flavor/Lime"]);
    // junk is a 400, never a price
    for (const bad of [[], [L({ itemId: "nope" })], [L({ sel: { size: "Gigantic" } })], [L({ float: "Float: Gold" })], [null], "x"]) eq((await r.api.quote({ cart: bad })).status, 400, "bad cart " + JSON.stringify(bad).slice(0, 40));
    // the page cannot name a price: extra price fields are ignored
    const p = (await r.api.quote({ cart: [{ ...L(), unit: 0.01, price: 1, basePrice: 1 }] })).body; eq(p.subtotal, 479, "price fields from the page are ignored");
    // rate limit
    r.allowed = false; eq((await r.api.quote({ cart: [L()] })).status, 429); r.allowed = true;
  }
  { // disagreement paths: payNow stays false, reason says why
    for (const [label, tweak, rx] of [
      ["Clover total differs by one cent", f => { f.skew = 1; }, /disagree/],
      ["checkout call fails", f => { f.failCheckout = true; }, /checkout failed/],
      ["checkout answer unreadable", f => { f.checkoutShape = "junk"; }, /not understood/],
      ["checkout has no tax", f => { f.checkoutShape = "notax"; }, /not understood/],
    ]) {
      const r = await rig(); tweak(r.f);
      const q = (await r.api.quote({ cart: [L()] })).body;
      ok(q.ok && q.payNow === false && rx.test(q.reason), label + ": payNow=false (" + q.reason + ")");
    }
    const held = await rig(); held.f.items[0].price = 5000; await held.catalog.sync();
    ok((await held.api.quote({ cart: [L()] })).body.payNow === false, "a held catalog never says payNow");
    const off = await rig({ orderPath: "legacy" }); eq((await off.api.quote({ cart: [L()] })).body.error, "not-enabled");
    const notype = await rig({ orderTypeId: "" }); eq((await notype.api.quote({ cart: [L()] })).body.error, "not-enabled");
  }
  { // Maze: only above the smallest size; the most expensive eligible line; one cup; line level; capped at 80 cents; checked, not burned, at quote time
    const r = await rig();
    const small = (await r.api.quote({ cart: [L({ sel: { size: SZ[0] } })], code: "MAZE-123456" })).body;
    eq([small.codeStatus, small.discount], ["no-upsizable-line", 0], "a Small has nothing to upsize");
    const med = (await r.api.quote({ cart: [L({ sel: { size: SZ[1] } })], code: "MAZE-123456" })).body;
    eq([med.codeStatus, med.discount], ["ok", 80], "Medium: the 80 cent step");
    const lrg = (await r.api.quote({ cart: [L({ sel: { size: SZ[2] } })], code: "MAZE-123456" })).body;
    eq(lrg.discount, 70, "Large: its own step (150 - 80), under the cap");
    const two = (await r.api.quote({ cart: [L({ sel: { size: SZ[1] } }), L({ itemId: "pink-flamingo", sel: { size: SZ[1] } }), L({ sel: { size: SZ[0] } })], code: "MAZE-123456" })).body;
    eq(two.discount, 80, "one discount on one cup, however many lines");
    ok(two.payNow, "Clover agrees with the discounted, line-level cart (tax on the discounted cup)");
    const mq = [...r.api._quotes.values()].pop();
    const discounted = mq.units.filter(u => u.disc);
    eq([discounted.length, discounted[0].line.itemId], [1, "pink-flamingo"], "the most expensive eligible line gets it");
    const big = await rig({ tweak: f => { f.groups[0].modifiers.elements[2].price = 600; } });   // a Large at +$6.00: its step is 520
    const bq = (await big.api.quote({ cart: [L({ sel: { size: SZ[2] } })], code: "MAZE-123456" })).body;
    eq([bq.discount, bq.payNow], [80, true], "the discount never exceeds 80 cents");
    const two2 = (await r.api.quote({ cart: [L({ qty: 3, sel: { size: SZ[1] } })], code: "MAZE-123456" })).body;
    eq(two2.discount, 80, "qty 3: only the first cup is discounted");
    r.prize.check = { ok: false, status: "used" };
    const bad = (await r.api.quote({ cart: [L()], code: "MAZE-123456" })).body; eq([bad.codeStatus, bad.discount, bad.ok], ["used", 0, true], "a bad code still quotes, without the discount");
    ok(r.prizeCalls.every(c => !c.redeem), "/quote never burns a code");
  }
  { // /order: atomic create, read back, write total when missing or different, title + note; burn-first; single use; failure cleanup
    const r = await rig();
    const q = (await r.api.quote({ cart: [L()] })).body;
    const o = await r.api.createOrder({ quoteId: q.quoteId, name: "Sam", payMode: "card" });
    eq(o.status, 200); eq([o.body.ok, o.body.payMode, o.body.total, o.body.tax, o.body.seq, o.body.ticket.length], [true, "card", 513, 34, 104, 4]);
    eq(o.body.payToken, "t".repeat(32), "card order: payToken from the registrar"); eq(r.regs, [{ id: o.body.orderId, mode: "card" }]);
    const co = r.f.orders.get(o.body.orderId);
    eq([co.title, co.note, co.orderType.id], ["TBK:PENDING", "Sam — Kiosk order #104", "KIOSKTYPE0001"]);
    ok(co.lineItems.elements[0].note === "MODS: Medium 24oz | Coconut" && co.lineItems.elements[0].item.id === "ITEMTRAP00001", "line note carries the MODS list for the station");
    eq(co.total, 513);
    // single use
    eq((await r.api.createOrder({ quoteId: q.quoteId, name: "Sam" })).status, 409, "a quote is single use");
    eq((await r.api.createOrder({ quoteId: "f".repeat(32), name: "Sam" })).status, 409, "unknown quote");
    // window mode -> TBK:COLLECT, no token
    const q2 = (await r.api.quote({ cart: [L()] })).body;
    const w = await r.api.createOrder({ quoteId: q2.quoteId, name: "Pat", payMode: "window" });
    eq([w.body.payMode, "payToken" in w.body, r.f.orders.get(w.body.orderId).title], ["window", false, "TBK:COLLECT"]);
    eq(r.regs[1].mode, "window");
    // payNow false: card is downgraded to window, never a card order on an unverified total
    const dis = await rig(); dis.f.skew = 1;
    const q3 = (await dis.api.quote({ cart: [L()] })).body; eq(q3.payNow, false);
    const d3 = await dis.api.createOrder({ quoteId: q3.quoteId, name: "Al", payMode: "card" });
    eq([d3.body.payMode, dis.f.orders.get(d3.body.orderId).title], ["window", "TBK:COLLECT"]);
    // Clover omitted the total -> we write it; Clover disagreed -> we write the checkout total
    for (const mode of ["omit", "differ"]) {
      const x = await rig(); const qq = (await x.api.quote({ cart: [L()] })).body;
      const origPost = x.f.post;
      if (mode === "omit") x.f.omitTotal = true; else x.f.post = async (p, b) => { const r2 = await origPost(p, b); if (p === "/atomic_order/orders") { x.f.orders.get(r2.id).total = 999; r2.total = 999; } return r2; };
      const oo = await x.api.createOrder({ quoteId: qq.quoteId, name: "Zed", payMode: "card" });
      eq(x.f.orders.get(oo.body.orderId).total, 513, "total written from the checkout (" + mode + ")");
    }
    // finishing fails -> the half-made order is deleted
    const fx = await rig(); const qf = (await fx.api.quote({ cart: [L()] })).body; fx.f.failTitle = true;
    const fo = await fx.api.createOrder({ quoteId: qf.quoteId, name: "Fay", payMode: "card" });
    eq(fo.status, 502); eq(fx.f.deleted.length, 1, "no half-made ticket is left behind"); eq(fx.f.orders.size, 0);
    // expiry
    const ex = await rig(); const qe = (await ex.api.quote({ cart: [L()] })).body; ex.now += 10 * 60000 + 1;
    eq((await ex.api.createOrder({ quoteId: qe.quoteId, name: "Old" })).status, 409, "quotes live 10 minutes");
    // legacy switch
    const lg = await rig({ orderPath: "legacy" }); eq((await lg.api.createOrder({ quoteId: "x".repeat(32) })).status, 409);
  }
  { // burn-first
    const r = await rig();
    const q = (await r.api.quote({ cart: [L({ sel: { size: SZ[1] } })], code: "MAZE-123456" })).body;
    eq(q.discount, 80);
    const o = await r.api.createOrder({ quoteId: q.quoteId, name: "Max", payMode: "card" });
    eq(o.status, 200); ok(o.body.upsize);
    const burn = r.prizeCalls.filter(c => c.redeem); eq(burn.length, 1); ok(!burn[0].afterOrder, "the code is burned BEFORE the Clover order exists");
    const co = r.f.orders.get(o.body.orderId);
    ok(/MAZE UPSIZE/.test(co.note) && co.lineItems.elements[0].discounts[0].amount === -80, "discount rides on the order line; note tagged");
    // a failed burn is a failed order: nothing created, quote still usable, page re-quotes without the code
    const b = await rig(); const qb = (await b.api.quote({ cart: [L({ sel: { size: SZ[1] } })], code: "MAZE-123456" })).body;
    b.prize.burn = { ok: false, status: "used" };
    const bo = await b.api.createOrder({ quoteId: qb.quoteId, name: "Max", payMode: "card" });
    eq([bo.status, bo.body.error], [400, "bad-code"]); ok(!b.f.calls.includes("POST /atomic_order/orders"), "no Clover order after a failed burn");
    const retry = (await b.api.quote({ cart: [L({ sel: { size: SZ[1] } })] })).body;
    eq((await b.api.createOrder({ quoteId: retry.quoteId, name: "Max", payMode: "card" })).status, 200, "ordering without the code works");
    // a code that went bad between quote and order is refused at order time too
    const c = await rig(); const qc = (await c.api.quote({ cart: [L({ sel: { size: SZ[1] } })], code: "MAZE-123456" })).body; c.prize.check = { ok: false, status: "used" };
    eq((await c.api.createOrder({ quoteId: qc.quoteId, name: "Max" })).body.error, "bad-code");
  }

  console.log(`catalog: ${passed} checks passed`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
