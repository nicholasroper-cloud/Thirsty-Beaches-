// tests/kiosk/map-inert.js — filling in catalog-map.json must change NOTHING while KIOSK_ORDER_TYPE_ID and CATALOG_TAX_RATES are blank
// (the kiosk's config today: legacy window-pay order path, pay off). The real kiosk-server.js runs twice against a fake Clover that
// records every request: once with the committed map, once with the same map with every id nulled (the state before the ids were filled
// in). Everything a customer or Clover can observe must be identical: /catalog, /quote, /order and the requests Clover receives.
// Also pins what the map holds: every filled id is unique to a real key, and the leftovers stay null.
// Run: node tests/kiosk/map-inert.js
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), net = require("net"), cp = require("child_process"), assert = require("assert");
const ROOT = path.resolve(__dirname, "../..");
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

const real = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog-map.json"), "utf8"));
const nulled = JSON.parse(JSON.stringify(real));
const walk = (m, f) => { for (const c of Object.values(m.categories)) { for (const it of Object.values(c.items)) f(it); for (const o of c.options) for (const ch of o.choices) f(ch); } for (const fl of m.floats) f(fl); };
walk(nulled, x => { x.clover = null; });

/* ---- what the committed map holds ---- */
{
  let items = 0, itemsNull = 0, mods = 0, modsNull = 0; const seenItem = new Set();
  for (const c of Object.values(real.categories)) {
    for (const it of Object.values(c.items)) { if (it.clover) { items++; ok(/^[A-Z0-9]{13}$/.test(it.clover), "item id shape " + it.clover); seenItem.add(it.clover); } else itemsNull++; }
    for (const o of c.options) for (const ch of o.choices) { if (ch.clover) { mods++; ok(/^[A-Z0-9]{13}$/.test(ch.clover), "modifier id shape " + ch.clover); } else modsNull++; }
  }
  eq([items, itemsNull, mods, modsNull], [113, 5, 237, 65], "113 items + 237 modifier choices filled; 5 items and 65 choices (+ the 2 floats = 67 modifier keys) left null on purpose");
  ok(real.floats.every(f => f.clover === null), "the two attach-prompt floats stay unmapped (no Clover modifier exists)");
  const peach = Object.values(real.categories).flatMap(c => Object.entries(c.items)).find(([id]) => /peach-please/.test(id));
  ok(!peach || peach[1].clover === null, "Peach Please (hidden in Clover) is not mapped");
}

/* ---- two real servers, one fake Clover that records everything ---- */
async function run(map) {
  const log = [];
  const clover = http.createServer((rq, rs) => {
    let b = ""; rq.on("data", c => b += c); rq.on("end", () => {
      log.push(`${rq.method} ${rq.url.replace(/\?.*/, "")} ${rq.method === "GET" ? "" : b.replace(/\d{10,}/g, "T")}`.trim());
      const j = (s, o) => { rs.writeHead(s, { "Content-Type": "application/json" }); rs.end(JSON.stringify(o)); };
      const m = rq.url.replace(/^\/v3\/merchants\/[^/]+/, "").replace(/\?.*/, "");
      if (rq.method === "POST" && m === "/orders") return j(200, { id: "ORDER0000001", state: "open", total: 349, lineItems: { elements: [] }, createdTime: 1 });
      if (rq.method === "POST" && /^\/orders\/[^/]+\/line_items$/.test(m)) return j(200, { id: "LI1" });
      if (rq.method === "POST" && /^\/orders\/[^/]+$/.test(m)) return j(200, {});
      if (rq.method === "GET" && m === "/orders") return j(200, { elements: [] });
      return j(200, { elements: [] });
    });
  });
  await new Promise(r => clover.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-mapinert-"));
  for (const f of ["kiosk-server.js", "kiosk-lib.js", "flex-pay.js", "pay-journal.js", "pay-routes.js", "catalog.js", "quote.js", "moderation.js", "arcade-routes.js", "addons.json", "drink-kiosk.html", "drink-kiosk-light.html"]) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "catalog-map.json"), JSON.stringify(map));
  const port = await freePort();
  // the kiosk's config today: no order type, no tax rates, pay off. (KIOSK_KEY etc. are irrelevant here.)
  const env = { PATH: process.env.PATH, CLOVER_API_TOKEN: "t", CLOVER_MERCHANT_ID: "M", CLOVER_BASE_URL: "http://127.0.0.1:" + clover.address().port, PORT: String(port), KIOSK_HEARTBEAT_URL: "off", PAY_ENABLED: "false", TB_CATALOG_MS: "300" };
  const c = cp.spawn(process.execPath, ["kiosk-server.js"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; c.stdout.on("data", d => out += d); c.stderr.on("data", d => out += d);
  const req = (method, p, obj) => new Promise((resolve, reject) => {
    const data = obj === undefined ? null : JSON.stringify(obj);
    const h = { Host: `127.0.0.1:${port}` };
    if (method !== "GET") Object.assign(h, { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` });
    if (data !== null) h["Content-Length"] = Buffer.byteLength(data);
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: h }, res => { let b = ""; res.on("data", x => b += x); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
    r.on("error", reject); if (data !== null) r.write(data); r.end();
  });
  try {
    for (let i = 0; i < 80; i++) { try { if ((await req("GET", "/health")).status === 200) break; } catch {} await sleep(100); }
    await sleep(900);                                          // long enough for any catalog sync timer (300 ms) to have fired
    const firstMapped = Object.entries(real.categories).flatMap(([cat, c]) => Object.entries(c.items).filter(([, it]) => it.clover).map(([id, it]) => ({ cat, id, it })))[0];
    const cart = [{ catKey: firstMapped.cat, itemId: firstMapped.id, name: firstMapped.it.name, unit: firstMapped.it.kioskCents / 100, qty: 1, mods: [], choices: {} }];
    const res = {
      catalog: await req("GET", "/catalog"),
      quote: await req("POST", "/quote", { cart }),
      order: await req("POST", "/order", { cart: [{ name: firstMapped.it.name, unit: firstMapped.it.kioskCents / 100, qty: 1, mods: [] }], name: "Sam" }),
      payconfig: await req("GET", "/payconfig"),
    };
    const status = JSON.parse((await req("GET", "/kiosk-status")).body);
    res.heartbeatCatalog = JSON.stringify(status.catalog === undefined ? null : status.catalog);
    res.pay = JSON.stringify(status.pay);
    const norm = s => s.replace(/"orderId":"[^"]*"/g, '"orderId":"X"').replace(/"ticket":"[^"]*"/g, '"ticket":"X"').replace(/"(syncedAt|at|ts|now)":\d+/g, '"$1":0');
    for (const k of ["catalog", "quote", "order", "payconfig"]) res[k] = { status: res[k].status, body: norm(res[k].body) };
    return { res, log: log.slice(), out };
  } finally { c.kill(); clover.close(); }
}

(async () => {
  const a = await run(nulled), b = await run(real);
  for (const k of ["catalog", "quote", "order", "payconfig"]) eq(b.res[k], a.res[k], k + " is identical with the ids filled in");
  eq(b.res.heartbeatCatalog, a.res.heartbeatCatalog, "heartbeat catalog block identical");
  eq(b.res.pay, a.res.pay, "pay block identical");
  eq(JSON.parse(b.res.quote.body).error, "not-enabled", "/quote says not-enabled: the legacy window-pay path");
  eq(JSON.parse(b.res.catalog.body).ok, false, "no catalog table is loaded, so the page keeps its own prices");
  eq(b.log, a.log, "Clover receives exactly the same requests");
  ok(!b.log.some(l => /\/(items|tax_rates|modifier_groups)\b/.test(l)), "the catalog is never read from Clover while no order type is set");
  ok(/Server-side pricing OFF/.test(b.out), "boot log says server-side pricing is OFF");
  console.log(`map-inert: ${passed} checks passed (the filled-in map is inert with KIOSK_ORDER_TYPE_ID and CATALOG_TAX_RATES blank)`);
  process.exit(0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
