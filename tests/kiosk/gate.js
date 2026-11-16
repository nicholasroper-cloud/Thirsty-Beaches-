// tests/kiosk/gate.js — the ticket release gate (ADR section 5) on the local station (make-station-server.js) and the cloud worker
// (cloud/src/ticket.js): one table, both implementations, identical answers. Also: badges are >= 32 px with solid fills in the station page.
// Run: node tests/kiosk/gate.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const ROOT = path.resolve(__dirname, "../..");
let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

const KT = "KIOSKTYPE0001";
const line = (name = "Thirst Trap", extra = {}) => ({ name, price: 349, ...extra });
const order = (o = {}) => ({ id: "ORDER00000001", total: 513, title: "", paymentState: "OPEN", orderType: null, lineItems: { elements: [line()] }, ...o });
const kiosk = { id: KT };
// [label, order, expected {show, kind, paid}]
const CASES = [
  ["TBK:PENDING hidden", order({ title: "TBK:PENDING", orderType: kiosk }), { show: false }],
  ["Kiosk-typed order with no title yet hidden (no race)", order({ orderType: kiosk }), { show: false }],
  ["TBK:PENDING hidden even if the order type is missing", order({ title: "TBK:PENDING" }), { show: false }],
  ["TBK:PAID shows PAID", order({ title: "TBK:PAID:PAYID1234567", orderType: kiosk }), { show: true, kind: "PAID", paid: true, text: "✓ PAID", long: "✓ PAID" }],
  ["TBK:PAID and Clover PAID = DOUBLE", order({ title: "TBK:PAID:PAYID1234567", orderType: kiosk, paymentState: "PAID" }), { show: true, kind: "DOUBLE", paid: true, text: "2× DOUBLE", long: "DOUBLE PAID: void one" }],
  ["TBK:COLLECT shows COLLECT $5.13", order({ title: "TBK:COLLECT", orderType: kiosk }), { show: true, kind: "COLLECT", paid: false, text: "COLLECT $5.13", long: "COLLECT $5.13" }],
  ["TBK:COLLECT paid at the window shows PAID", order({ title: "TBK:COLLECT", orderType: kiosk, paymentState: "PAID" }), { show: true, kind: "PAID", paid: true }],
  ["TBK:CHECK shows CHECK READER", order({ title: "TBK:CHECK", orderType: kiosk }), { show: true, kind: "CHECK", paid: false, text: "⚠ CHECK", long: "CHECK READER, do not charge" }],
  ["TBK:SHELL hidden", order({ title: "TBK:SHELL:ORDER00000001", orderType: null }), { show: false }],
  ["TBK:SHELL hidden even if it carries real lines", order({ title: "TBK:SHELL:ORDER00000001", lineItems: { elements: [line("Thirst Trap")] } }), { show: false }],
  ["Manual-transaction-only order hidden", order({ lineItems: { elements: [line("Manual transaction")] } }), { show: false }],
  ["Manual transaction plus a real line is shown", order({ lineItems: { elements: [line("Manual transaction"), line("Thirst Trap")] } }), { show: true, kind: null }],
  ["Duo order: legacy, no badge", order({ orderType: { id: "DUOTYPE00001" }, paymentState: "PAID" }), { show: true, kind: null }],
  ["Register order with a customer title keeps showing", order({ title: "Sam" }), { show: true, kind: null }],
  ["QR phone order (no orderType): legacy", order({ title: "" }), { show: true, kind: null }],
  ["unknown TBK: title is hidden (fail closed)", order({ title: "TBK:WHAT", orderType: kiosk }), { show: false }],
  ["a title that only looks like it (tbk: lowercase) is a Register title", order({ title: "tbk:paid" }), { show: true, kind: null }],
  ["no KIOSK_ORDER_TYPE_ID configured: untitled order is legacy", order({ orderType: kiosk }), { show: true, kind: null, noType: true }],
];

function localGate() {
  const src = fs.readFileSync(path.join(ROOT, "make-station-server.js"), "utf8");
  const a = src.indexOf("function ticketGate("), b = src.indexOf("\n}\n", a) + 3;
  assert.ok(a > 0 && b > a, "ticketGate() not found in make-station-server.js");
  return vm.runInNewContext(src.slice(a, b) + "\nticketGate;", {});
}

(async () => {
  const local = localGate();
  const cloud = (await import(path.join(ROOT, "cloud/src/ticket.js"))).ticketGate;
  for (const [label, o, want] of CASES) {
    const kt = want.noType ? "" : KT;
    for (const [who, fn] of [["local", local], ["cloud", cloud]]) {
      const g = fn(o, kt);
      eq(g.show, want.show, `${who}: ${label}: show`);
      if (want.show) {
        eq(g.badge ? g.badge.kind : null, want.kind === undefined ? null : want.kind, `${who}: ${label}: badge`);
        if (want.paid !== undefined) eq(g.paid, want.paid, `${who}: ${label}: paid`);
        if (want.text) eq(g.badge.text, want.text, `${who}: ${label}: short text (tile and next pane)`);
        if (want.long) eq(g.badge.long, want.long, `${who}: ${label}: long text (ticket header)`);
        if (want.text) ok([...g.badge.text].length <= 14, `${who}: ${label}: the tile label is short enough not to clip (${g.badge.text})`);
      }
    }
    eq(JSON.stringify(local(o, kt)), JSON.stringify(cloud(o, kt)), `local and cloud agree: ${label}`);
  }

  // the station page: solid fills, 32 px or more, on the tile and on the ticket header
  const html = fs.readFileSync(path.join(ROOT, "make-station.html"), "utf8");
  const css = sel => { const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{([^}]*)\\}").exec(html); return m ? m[1] : ""; };
  const all = sel => [...html.matchAll(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{([^}]*)\\}", "g"))].map(m => m[1]).join(";");
  const px = sel => { const sizes = [...all(sel).matchAll(/font-size:(\d+)px/g)].map(m => +m[1]); return sizes.length ? Math.max(...sizes) : 0; };
  ok(px(".paybadge") >= 32 && px(".tk .paybadge") >= 32 && px(".mhead .paybadge") >= 32 && px(".nxhead .paybadge") >= 32, "badge font sizes are at least 32 px on tile, header and next pane");
  for (const k of ["paid", "collect", "check", "double"]) ok(/background:(#[0-9a-f]{6}|repeating-linear-gradient\(135deg,#[0-9a-f]{6} 0 16px,#[0-9a-f]{6} 16px 32px\))/i.test(css(".paybadge." + k)), `.paybadge.${k} is a solid fill (the hazard stripes are two solid colors)`);
  ok(/o\.badge&&o\.badge\.kind/.test(html), "the page renders the server's badge");
  // Snake Eyes 1, 2, 11: the badge row wraps in the header, the tile badge sits outside .sub, shapes differ, header badge is 40 px
  ok(/\.mhead\{flex-wrap:wrap\}/.test(html) && /\.mhead \.paybadge\{[^}]*flex:1 0 100%[^}]*white-space:normal[^}]*font-size:40px/.test(html), "header badge: own full-width row, wrapping, 40 px");
  ok(/<span class="pb">\$\{payBadge\(o\)\}<\/span>/.test(html) && !/<span class="sub">\$\{payBadge/.test(html), "tile badge is outside .sub");
  ok(/payBadge\(o,true\)/.test(html), "the header uses the long label");
  ok(/\.paybadge\.paid\{[^}]*border-radius:999px/.test(html) && /\.paybadge\.collect\{[^}]*border-radius:4px[^}]*inset 0 0 0 4px/.test(html) && /\.paybadge\.check\{[^}]*repeating-linear-gradient\(135deg/.test(html) && /\.paybadge\.double\{[^}]*0 0 0 3px #fff/.test(html), "four different badge shapes");
  ok(/@media \(prefers-reduced-motion:reduce\)\{\.mhead \.code\{animation:none\}\}/.test(html), "the header flicker respects reduced motion");
  ok(/prefers-reduced-motion:reduce\)\{\.ready\.fresh\{animation:none\}/.test(fs.readFileSync(path.join(ROOT, "pickup-board.html"), "utf8")), "the board pop respects reduced motion");

  console.log(`gate: ${passed} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
