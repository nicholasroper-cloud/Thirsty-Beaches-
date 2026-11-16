// tests/kiosk/pay-e2e.js — the REAL kiosk page in headless Chrome, against the REAL kiosk-server.js (and make-station-server.js),
// a FAKE Clover (HTTP) and a FAKE Flex connector (the real SDK's own response objects, no socket, no pairing).
//   ADR section 8 cases A to E, G, H, the DOUBLE case, ticket release on the station, the catalog drift hold and the quote mismatch path.
// Nothing here can reach a real Flex or a real Clover: the kiosk child process swaps flexPay's connector for the fake before the server starts,
// and every Clover URL points at the fake. Needs Google Chrome (CHROME_BIN, or the macOS / Linux default path); skips (exit 0) when there is none.
// Run: node tests/kiosk/pay-e2e.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const cp = require("child_process");
const assert = require("assert");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "../..");
const CHROME = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean).find(p => fs.existsSync(p));
if (!CHROME) { console.log("pay-e2e: SKIPPED (no Chrome found; set CHROME_BIN)"); process.exit(0); }

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
async function waitFor(cond, ms = 15000, what = "condition") { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await cond(); if (last) return last; } catch (e) { last = e; } await sleep(60); } assert.fail("timed out waiting for " + what + (last instanceof Error ? ": " + last.message : "")); }
const keepAlive = setInterval(() => {}, 1000);

/* ---------------- the kiosk menu -> a fully mapped test catalog (ids are made up HERE, for the fake Clover only) ---------------- */
const { build } = require("../../tools/catalog-map.js");
const MAP = build(null);
const ITEMS = [], GROUPS = [], BYID = new Map();
{
  let n = 0; const id = p => p + String(++n).padStart(11, "0");
  for (const [catKey, cat] of Object.entries(MAP.categories)) {
    for (const [itemId, it] of Object.entries(cat.items)) { it.clover = id("IT"); ITEMS.push({ id: it.clover, name: it.name, price: it.kioskCents, hidden: false, defaultTaxRates: true, taxRates: { elements: [] }, modifierGroups: { elements: [] } }); BYID.set(it.clover, it); }
    for (const o of cat.options) {
      const mods = o.choices.map(c => { c.clover = id("MD"); BYID.set(c.clover, c); return { id: c.clover, name: c.name, price: c.kioskCents }; });
      GROUPS.push({ id: id("GR"), name: catKey + " " + o.key, modifiers: { elements: mods } });
    }
  }
  const fm = []; for (const f of MAP.floats) { f.clover = id("FL"); fm.push({ id: f.clover, name: f.mod, price: f.kioskCents }); }
  GROUPS.push({ id: id("GR"), name: "floats", modifiers: { elements: fm } });
}
const modPrice = {}; for (const g of GROUPS) for (const m of g.modifiers.elements) modPrice[m.id] = m.price;
const itemPrice = {}; for (const i of ITEMS) itemPrice[i.id] = i.price;
const TYPE = "KIOSKTYPE0001", TAXRATE = 700000;

/* ---------------- fake Clover ---------------- */
const F = { orders: new Map(), seq: 0, skew: 0, drift: 0, prize: { check: { ok: true }, burn: { ok: true } }, log: [] };
const mkId = p => p + String(++F.seq).padStart(9, "0");
function priceCart(cart) {
  let total = 0; const els = [];
  for (const li of cart.lineItems) {
    let p = itemPrice[li.item.id]; for (const m of li.modifications || []) p += modPrice[m.modifier.id];
    const taxable = p + (li.discounts || []).reduce((a, d) => a + d.amount, 0), tax = Math.round(taxable * TAXRATE / 1e7);
    total += taxable + tax; els.push({ taxRates: { elements: [{ taxAmount: tax }] } });
  }
  return { total: total + F.skew, els };
}
const clover = http.createServer((rq, res) => {
  const u = new URL(rq.url, "http://x"); let body = "";
  rq.on("data", c => body += c); rq.on("end", () => {
    const j = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    const m = u.pathname.replace(/^\/v3\/merchants\/[^/]+/, ""); const b = body ? JSON.parse(body) : {};
    F.log.push(rq.method + " " + m);
    const lim = +u.searchParams.get("limit") || 100, off = +u.searchParams.get("offset") || 0;
    let mm;
    if (u.pathname === "/redeem") return j(200, b.redeem ? F.prize.burn : F.prize.check);
    if (rq.method === "GET" && m === "/items") return j(200, { elements: ITEMS.map(i => ({ ...i, price: i.price + (F.drift && i.id === ITEMS[0].id ? F.drift : 0) })).slice(off, off + lim) });
    if (rq.method === "GET" && m === "/modifier_groups") return j(200, { elements: GROUPS.slice(off, off + lim) });
    if (rq.method === "GET" && m === "/tax_rates") return j(200, { elements: [{ id: "TAXFL7000001", name: "FL sales tax", rate: TAXRATE, isDefault: true }] });
    if (rq.method === "GET" && m === "/payments") return j(200, { elements: [] });
    if (rq.method === "POST" && m === "/atomic_order/checkouts") { const r = priceCart(b.orderCart); return j(200, { total: r.total, lineItems: { elements: r.els } }); }
    if (rq.method === "POST" && m === "/atomic_order/orders") {
      const id = mkId("ORD"), r = priceCart(b.orderCart);
      const o = { id, state: "open", createdTime: Date.now(), orderType: b.orderCart.orderType, paymentState: "OPEN", total: r.total, lineItems: { elements: b.orderCart.lineItems.map(l => ({ name: ITEMS.find(i => i.id === l.item.id).name, price: itemPrice[l.item.id], note: l.note, item: l.item, discounts: l.discounts })) }, payments: { elements: [] } };
      F.orders.set(id, o); return j(200, o);
    }
    if (rq.method === "POST" && m === "/orders") { const id = mkId("ORD"); F.orders.set(id, { id, state: "open", createdTime: Date.now(), paymentState: "OPEN", total: 0, lineItems: { elements: [] }, payments: { elements: [] } }); return j(200, F.orders.get(id)); }
    if (rq.method === "POST" && (mm = /^\/orders\/([^/]+)\/line_items$/.exec(m))) { const o = F.orders.get(mm[1]); o.lineItems.elements.push(b); o.total += b.price; return j(200, { id: "LI1" }); }
    if (rq.method === "POST" && /^\/orders\/[^/]+\/discounts$/.test(m)) return j(200, {});
    if (rq.method === "POST" && (mm = /^\/orders\/([^/]+)$/.exec(m))) { if (!F.orders.has(mm[1])) F.orders.set(mm[1], { id: mm[1], state: "open", createdTime: Date.now(), paymentState: "OPEN", total: 0, lineItems: { elements: [{ name: "Manual transaction", price: 0 }] }, payments: { elements: [] } }); Object.assign(F.orders.get(mm[1]), b); return j(200, {}); }
    if (rq.method === "DELETE" && (mm = /^\/orders\/([^/]+)$/.exec(m))) { F.orders.delete(mm[1]); return j(200, {}); }
    if (rq.method === "GET" && (mm = /^\/orders\/([^/]+)$/.exec(m))) { const o = F.orders.get(mm[1]); return o ? j(200, o) : j(404, {}); }
    if (rq.method === "GET" && m === "/orders") { const all = [...F.orders.values()].sort((x, y) => y.createdTime - x.createdTime); return j(200, { elements: all.slice(off, off + lim) }); }
    j(404, { message: "no " + m });
  });
});

/* ---------------- the kiosk child: real server, fake Flex ---------------- */
const CHILD = `
"use strict";
const http = require("http");
const { FakeConnector, mkPayment, mkSale, sdk } = require("./pay-fakes");
const fp = require("./flex-pay");
const fc = new FakeConnector();
const S = { sale: "silent", retrieve: "NOT_FOUND", shell: 0, pay: 0 };
const payment = (extId, amount) => mkPayment({ extId, amount, id: "PAYE2E" + String(++S.pay).padStart(6, "0"), shell: "SHELLE2E" + String(++S.shell).padStart(5, "0") });
const amountOf = extId => { const c = fc.calls.filter(x => x.m === "sale" && x.extId === extId).pop(); return c ? c.amount : 100; };
fc.script.sale = (extId, req) => {
  if (S.sale === "approve") fc.listener.onSaleResponse(mkSale("SUCCESS", payment(extId, req.getAmount())));
  else if (S.sale === "decline") fc.listener.onSaleResponse(mkSale("FAIL", null, "declined"));
  else if (S.sale === "cancel") fc.listener.onSaleResponse(mkSale("CANCEL", null, "cancelled"));
};
fc.script.retrievePayment = extId => S.retrieve === "FOUND" ? { status: "FOUND", payment: payment(extId, amountOf(extId)) } : { status: S.retrieve };
// flex-pay reconnects by building a new connector 2 s after a disconnect; the real SDK then reports connected + ready again. Do the same while the "reader" is up.
const up = { on: false };
fc.initializeConnection = () => { if (up.on) setImmediate(() => { fc.listener.onDeviceConnected(); fc.listener.onDeviceReady({ deviceSerial: "C0E2E", merchantName: "E2E" }); }); };
const orig = fp.init;
fp.init = (cfg, deps) => orig.call(fp, { ...cfg, PAY_TIMEOUT_MS: 1500, timing: { PAY_TIMEOUT_MS: 1500, EXTENSION_MS: 300, CANCEL_WAIT_MS: 250, ANSWER_MS: 600, RECONCILE_MS: 400, REST_AFTER_MS: 3600000 } }, { ...deps, sdk, connectorFactory: () => fc });
http.createServer((rq, rs) => {
  let b = ""; rq.on("data", c => b += c); rq.on("end", () => {
    const o = b ? JSON.parse(b) : {}; const out = {};
    if (o.op === "ready") { up.on = true; fc.listener.onDeviceConnected(); fc.listener.onDeviceReady({ deviceSerial: "C0E2E", merchantName: "E2E" }); }
    if (o.op === "disconnect") { up.on = false; fc.listener.onDeviceDisconnected(); }
    if (o.op === "mode") { for (const k of ["sale", "retrieve"]) if (o[k]) S[k] = o[k]; if (o.device) fc.deviceState = o.device; }
    if (o.op === "respond") fc.listener.onSaleResponse(mkSale(o.rc || "SUCCESS", payment(o.extId, amountOf(o.extId))));
    if (o.op === "calls") out.calls = fc.calls.map(c => ({ m: c.m, extId: c.extId, key: c.key }));
    rs.writeHead(200, { "Content-Type": "application/json" }); rs.end(JSON.stringify(out));
  });
}).listen(+process.env.E2E_CTL, "127.0.0.1", () => { require("./kiosk-server.js"); });
`;

function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-e2e-"));
  for (const f of ["kiosk-server.js", "kiosk-lib.js", "flex-pay.js", "pay-journal.js", "pay-routes.js", "catalog.js", "quote.js", "moderation.js", "addons.json", "drink-kiosk.html", "drink-kiosk-light.html", "recipes.json", "make-station-server.js", "make-station.html", "pickup-board.html"])
    if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.copyFileSync(path.join(__dirname, "pay-fakes.js"), path.join(dir, "pay-fakes.js"));
  fs.writeFileSync(path.join(dir, "catalog-map.json"), JSON.stringify(MAP));
  fs.writeFileSync(path.join(dir, "e2e-child.js"), CHILD);
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");
  fs.cpSync(path.join(ROOT, "assets"), path.join(dir, "assets"), { recursive: true });
  return dir;
}
function spawnNode(dir, file, env) {
  const c = cp.spawn(process.execPath, [file], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, ...env } });
  c.out = ""; c.stdout.on("data", d => c.out += d); c.stderr.on("data", d => c.out += d);
  return c;
}
const stop = c => new Promise(r => { if (!c || c.exitCode !== null) return r(); c.on("exit", () => r()); c.kill("SIGKILL"); });
function jreq(port, method, p, obj, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = obj === undefined ? null : JSON.stringify(obj);
    const h = { Host: `127.0.0.1:${port}`, ...(method !== "GET" ? { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` } : {}), ...headers };
    if (data !== null) h["Content-Length"] = Buffer.byteLength(data);
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: h }, res => { let b = ""; res.on("data", c => b += c); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j, body: b }); }); });
    r.on("error", reject); if (data !== null) r.write(data); r.end();
  });
}

/* ---------------- headless Chrome over the DevTools protocol (the repo's own ws dependency; no puppeteer) ---------------- */
async function launchChrome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-chrome-"));
  const proc = cp.spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1280,1000", "--disable-features=Translate", "about:blank"], { stdio: "ignore" });
  const portFile = path.join(dir, "DevToolsActivePort");
  await waitFor(() => fs.existsSync(portFile) && fs.readFileSync(portFile, "utf8").split("\n").length >= 2, 20000, "Chrome to start");
  const [port, wsPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  let id = 0; const waiting = new Map(), events = [];
  ws.on("message", m => { const d = JSON.parse(m); if (d.id && waiting.has(d.id)) { const w = waiting.get(d.id); waiting.delete(d.id); d.error ? w.rej(new Error(d.error.message)) : w.res(d.result); } else if (d.method) events.push(d); });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId); await send("Runtime.enable", {}, sessionId);
  const page = {
    errors: [], events,
    async goto(url) { await send("Page.navigate", { url }, sessionId); await waitFor(async () => (await page.eval("document.readyState")) === "complete", 20000, "page load"); },
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error("page error: " + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result.value;
    },
    close() { try { ws.close(); } catch {} proc.kill("SIGKILL"); },
  };
  return page;
}

(async () => {
  await new Promise(r => clover.listen(0, "127.0.0.1", r));
  const cloverPort = clover.address().port;
  const dir = stage();
  const kioskPort = await freePort(), ctlPort = await freePort(), stationPort = await freePort();
  const baseEnv = { CLOVER_API_TOKEN: "t", CLOVER_MERCHANT_ID: "M", CLOVER_BASE_URL: "http://127.0.0.1:" + cloverPort };
  const kioskEnv = { ...baseEnv, PORT: String(kioskPort), E2E_CTL: String(ctlPort), PAY_ENABLED: "true", FLEX_IP: "127.0.0.1", KIOSK_HEARTBEAT_URL: "off", PRIZE_API: "http://127.0.0.1:" + cloverPort,
    KIOSK_ORDER_TYPE_ID: TYPE, CATALOG_TAX_RATES: "7", TB_CATALOG_MS: "600", READER_LOCATION_TEXT: "The reader is on the right of this screen",
    PAY_UNKNOWN_HOLD_MS: "6000", PAY_DECLINED_WAIT_MS: "2500", PAY_STILL_THERE_MS: "1500", TB_IDLE_MS: "120000", PAY_RATE_PER_MIN: "60" };
  let kiosk = null, station = null, chrome = null;
  const ctl = o => jreq(ctlPort, "POST", "/", o, { Origin: "http://x" }).then(r => r.json);
  const startKiosk = async () => {
    kiosk = spawnNode(dir, "e2e-child.js", kioskEnv);
    await waitFor(async () => (await jreq(kioskPort, "GET", "/health").catch(() => ({}))).status === 200, 20000, "kiosk server: " + (kiosk && kiosk.out));
  };
  const ready = () => ctl({ op: "ready" });
  const sales = async () => (await ctl({ op: "calls" })).calls.filter(c => c.m === "sale").map(c => c.extId);
  const qs = async () => { const q = (await jreq(stationPort, "GET", "/queue")).json; return { orders: [...(q.waiting || []), ...(q.ready || [])] }; };
  const byTicket = async id => (await qs()).orders.find(o => o.id === id);
  const kioskOrders = () => [...F.orders.values()].filter(o => o.orderType && o.orderType.id === TYPE);
  try {
    await startKiosk();
    station = spawnNode(dir, "make-station-server.js", { ...baseEnv, MAKE_PORT: String(stationPort), MAKE_POLL_SEC: "3", KIOSK_ORDER_TYPE_ID: TYPE });
    await waitFor(async () => (await jreq(stationPort, "GET", "/health").catch(() => ({}))).status === 200, 15000, "station: " + station.out);
    chrome = await launchChrome();
    await chrome.goto(`http://127.0.0.1:${kioskPort}/`);
    await ready();
    await waitFor(async () => (await jreq(kioskPort, "GET", "/pay/status")).json.state === "ready", 8000, "reader ready");
    await waitFor(async () => (await jreq(kioskPort, "GET", "/catalog")).json.payNow === true, 15000, "catalog synced and payNow");
    eq((await jreq(kioskPort, "GET", "/payconfig")).json.readerLocationText, "The reader is on the right of this screen");
    await chrome.goto(`http://127.0.0.1:${kioskPort}/`);                      // reload so the page reads /payconfig and /catalog
    await waitFor(() => chrome.eval("_payEnabled === true && _payCfg.readerLocationText.length > 0"), 8000, "page read /payconfig");

    const E = x => chrome.eval(x);
    const screen = () => E(`({ state: document.querySelector('#payscreen').getAttribute('data-state'), shown: document.querySelector('#payscreen').classList.contains('show'), hl: document.querySelector('#payHeadline').textContent,
      body: document.querySelector('#payBody').textContent, ticket: document.querySelector('#payTicket').textContent, amount: document.querySelector('#payAmount').textContent, label: document.querySelector('#payLabel').textContent,
      where: document.querySelector('#payWhere').hidden ? '' : document.querySelector('#payWhereText').textContent, still: document.querySelector('#payscreen').getAttribute('data-still') === '1',
      confirm: document.querySelector('#confirm').classList.contains('show'), num: document.querySelector('#orderNum').textContent, banner: (document.querySelector('#confirm .paywindow')||{}).textContent || '' })`);
    // a customer: one drink (Medium), cart, name pad, place the order. Returns once placeOrder() has been called.
    const customer = async (name, o = {}) => {
      await E(`resetAll(); (function(){ const catKey=${JSON.stringify(o.catKey || "dirtysodas")}; const item=MENU[catKey].items[0]; const sel=defaultSel(catKey,item); ${o.size ? `sel.size=${JSON.stringify(o.size)};` : ""}
        const r=calcSel(catKey,item.price,sel); cart.push({icon:iconFor(item),name:item.name,mods:r.mods,unit:r.unit,qty:${o.qty || 1},catKey,itemId:item.id,basePrice:item.price,desc:item.desc,sel:JSON.parse(JSON.stringify(sel))}); updateCartBtn(); ${o.code ? `_prizeCode=${JSON.stringify(o.code)};` : ""} openCart(); })()`);
      if (!o.noQuoteWait) await waitFor(() => E("quoteUsable() || (_quote===null && document.querySelector('#cartTotals') && !_quoteBusy)"), 8000, "quote settled");
      await E(`askName(); _orderName=${JSON.stringify(name)}; refreshName(); true`);
      return E("placeOrder(); true");
    };
    const lastKioskOrder = () => kioskOrders().sort((a, b) => b.createdTime - a.createdTime)[0];

    /* ===== catalog-driven prices and "Total with tax" that is now true ===== */
    await E(`resetAll(); (function(){ const catKey="dirtysodas"; const item=MENU[catKey].items[0]; const sel=defaultSel(catKey,item); const r=calcSel(catKey,item.price,sel); cart.push({name:item.name,mods:r.mods,unit:r.unit,qty:1,catKey,itemId:item.id,basePrice:item.price,desc:item.desc,sel}); updateCartBtn(); openCart(); })()`);
    await waitFor(() => E("quoteUsable()"), 8000, "a usable quote");
    const totals = await E("document.querySelector('#cartTotals').textContent");
    ok(/Subtotal/.test(totals) && /FL sales tax 7%/.test(totals) && /Total with tax/.test(totals), "the cart shows subtotal, tax and Total with tax: " + totals);
    const q = await E("_quote");
    ok(q.tax > 0 && q.total === q.subtotal - q.discount + q.tax && q.payNow === true, "quote is internally consistent and agreed with Clover");
    ok(F.log.includes("POST /atomic_order/checkouts") && !F.log.includes("POST /atomic_order/orders"), "a quote asks Clover's checkout and creates no order");

    /* ===== A: approve ===== */
    await ctl({ op: "mode", sale: "approve" });
    await customer("Sam");
    await waitFor(async () => (await screen()).confirm, 15000, "confirm screen after approval");
    let sc = await screen();
    ok(/^\d{3}$/.test(sc.num) && /Grab your order/.test(sc.banner), "confirm screen: ticket number and the paid banner (" + sc.num + ")");
    let ord = lastKioskOrder();
    await waitFor(() => /^TBK:PAID:PAYE2E/.test(lastKioskOrder().title) && lastKioskOrder().state === "locked", 8000, "PAID title and lock in Clover");
    ord = lastKioskOrder(); eq(ord.total, q.total, "charged total = checkout total");
    const shell = [...F.orders.values()].find(o => o.title === `TBK:SHELL:${ord.id}`); ok(shell, "the shell order is titled TBK:SHELL");
    eq((await sales()).length, 1);
    { const t = await waitFor(async () => byTicket(ord.id), 8000, "station ticket"); eq(t.badge.kind, "PAID"); ok(!(await qs()).orders.some(o => o.id === shell.id), "the shell order never shows on the station"); }
    ok((await jreq(kioskPort, "GET", "/pay/state?orderId=" + ord.id)).status === 403, "/pay/state without the token is refused");

    /* ===== B: decline, then a retry on the SAME order with a new attempt id ===== */
    await ctl({ op: "mode", sale: "decline" });
    await customer("Pat");
    await waitFor(async () => (await screen()).state === "declined", 15000, "declined screen");
    sc = await screen();
    ok(/didn't go through/.test(sc.hl) && /Total with tax/.test(sc.label) && sc.where === "The reader is on the right of this screen", "decline copy, 'Total with tax', and the owner's reader-location line");
    let bOrder = lastKioskOrder(); eq(bOrder.title, "TBK:PENDING", "a declined order stays hidden (TBK:PENDING)");
    ok(!(await qs()).orders.some(o => o.id === bOrder.id), "and never reaches the station");
    await ctl({ op: "mode", sale: "approve" });
    await E("doPay(); true");
    await waitFor(async () => (await screen()).confirm, 15000, "confirm after the retry");
    await waitFor(() => /^TBK:PAID:/.test(F.orders.get(bOrder.id).title), 8000, "PAID after retry");
    eq((await sales()).slice(-2), [`TBK${bOrder.id}-1`, `TBK${bOrder.id}-2`], "the retry used a new ExternalId");
    ok((await waitFor(async () => byTicket(bOrder.id))).badge.kind === "PAID", "tile appears only after -2");

    /* ===== C: cancel on the Flex, then pay at the window ===== */
    await ctl({ op: "mode", sale: "cancel" });
    await customer("Cy");
    await waitFor(async () => (await screen()).state === "cancelled", 15000, "cancelled screen");
    await E("payAtWindow(); true");
    await waitFor(async () => (await screen()).confirm, 8000, "window confirm");
    sc = await screen(); ok(/Head to the window to pay/.test(sc.banner), "window banner");
    const cOrder = lastKioskOrder();
    await waitFor(() => F.orders.get(cOrder.id).title === "TBK:COLLECT" && F.orders.get(cOrder.id).state === "open", 8000, "COLLECT title, open");
    { const t = await waitFor(async () => byTicket(cOrder.id)); eq(t.badge.kind, "COLLECT"); ok(/^COLLECT \$\d+\.\d\d$/.test(t.badge.text), t.badge.text); eq(t.paid, false); }

    /* ===== Still there? / abandon: a declined order left alone is abandoned (deleted) after the countdowns ===== */
    await ctl({ op: "mode", sale: "decline" });
    await customer("Dee");
    await waitFor(async () => (await screen()).state === "declined", 15000, "declined (idle case)");
    const dOrder = lastKioskOrder();
    await waitFor(async () => (await screen()).still, 8000, "Still there? appears");
    await waitFor(() => !F.orders.has(dOrder.id), 10000, "the abandoned order is deleted");
    eq((await screen()).shown, false, "the page went back to the attract screen");

    /* ===== D + H: disconnect after the prompt, "Don't pay again", repeat /pay blocked, reconnect proves ONE payment ===== */
    await ctl({ op: "mode", sale: "silent", retrieve: "FOUND" });
    await customer("Dan");
    await waitFor(async () => (await screen()).state === "working", 10000, "working screen");
    const dId = lastKioskOrder().id; const salesBefore = (await sales()).length;
    await ctl({ op: "disconnect" });
    await waitFor(async () => (await screen()).state === "unknown", 10000, "the 'we're checking' screen");
    sc = await screen();
    ok(/checking your payment/i.test(sc.hl) && /Don't pay again/.test(sc.body) && /Show ticket #\d+ at the window/.test(sc.body) && /^#\d+$/.test(sc.ticket), "UNKNOWN copy: " + sc.hl + " / " + sc.body);
    await waitFor(() => F.orders.get(dId).title === "TBK:CHECK" && F.orders.get(dId).state === "locked", 8000, "CHECK title and lock");
    { const t = await waitFor(async () => byTicket(dId)); eq(t.badge.kind, "CHECK"); eq(t.badge.text, "CHECK READER, do not charge"); }
    // H: a second /pay for the same order is refused by the server and sends no second Sale
    const tok = await E("_payOrder.payToken");
    const h = await jreq(kioskPort, "POST", "/pay", { orderId: dId, amountCents: F.orders.get(dId).total, payToken: tok });
    eq(h.json.result, "blocked-unknown"); eq((await sales()).length, salesBefore, "no second Sale");
    eq((await jreq(kioskPort, "POST", "/pay/window", { orderId: dId, payToken: tok })).json.result, "blocked-unknown", "and no window release either");
    await ready();                                                                      // the reader comes back; the card WAS charged
    await waitFor(async () => (await screen()).confirm, 12000, "late approval reaches the page");
    await waitFor(() => /^TBK:PAID:/.test(F.orders.get(dId).title), 8000, "PAID after reconnect");
    eq((await sales()).length, salesBefore, "still exactly one Sale for that order");
    await waitFor(async () => { const t = await byTicket(dId); return t && t.badge && t.badge.kind === "PAID"; }, 10000, "the tile flips from CHECK to PAID");

    /* ===== E: timeout -> checking; the customer taps late; the order flips to PAID and no second attempt exists ===== */
    await ctl({ op: "mode", sale: "silent", retrieve: "NOT_FOUND", device: "BUSY" });
    await customer("Eve");
    await waitFor(async () => (await screen()).state === "unknown", 15000, "timeout becomes 'checking'");
    const eId = lastKioskOrder().id;
    await ctl({ op: "respond", extId: `TBK${eId}-1`, rc: "SUCCESS" });
    await waitFor(() => /^TBK:PAID:/.test(F.orders.get(eId).title), 8000, "late approval tags PAID");
    await waitFor(async () => (await screen()).confirm, 8000, "confirm if still on screen");
    eq((await sales()).filter(x => x.startsWith("TBK" + eId)).length, 1, "no second attempt");
    await ctl({ op: "mode", device: "IDLE" });

    /* ===== G: the server dies mid-sale; on restart the journal is replayed and the device settles it ===== */
    await ctl({ op: "mode", sale: "silent", retrieve: "NOT_FOUND" });
    await customer("Gus");
    await waitFor(async () => (await screen()).state === "working", 10000, "working before the crash");
    const gId = lastKioskOrder().id;
    await stop(kiosk);                                                                  // taskkill node
    await startKiosk();                                                                 // the supervisor would do this
    await ctl({ op: "mode", sale: "silent", retrieve: "FOUND" });
    await ready();
    await waitFor(async () => (await screen()).confirm || (await screen()).state === "unknown", 25000, "the page recovers after the restart");
    await waitFor(() => /^TBK:PAID:/.test(F.orders.get(gId).title), 15000, "replay resolved the order to PAID");
    eq((await sales()).filter(x => x.startsWith("TBK" + gId)).length, 0, "the restarted server sent no new Sale (the first process sent it)");
    ok(/boot replay/.test(kiosk.out), "the boot log shows the journal replay");

    /* ===== DOUBLE: a late card approval on an order that already went to the window ===== */
    await ctl({ op: "mode", sale: "cancel", retrieve: "NOT_FOUND" });
    await customer("Dot");
    await waitFor(async () => (await screen()).state === "cancelled", 10000, "cancelled");
    const xId = lastKioskOrder().id;
    await E("payAtWindow(); true");
    await waitFor(() => F.orders.get(xId).title === "TBK:COLLECT", 8000, "COLLECT");
    await ctl({ op: "respond", extId: `TBK${xId}-1`, rc: "SUCCESS" });                  // the card was charged after all
    await waitFor(() => /^TBK:PAID:/.test(F.orders.get(xId).title), 8000, "PAID written");
    F.orders.get(xId).paymentState = "PAID";                                            // and the cashier also tendered it on the Duo
    await waitFor(async () => { const t = await byTicket(xId); return t && t.badge.kind === "DOUBLE"; }, 10000, "the DOUBLE badge");
    eq((await byTicket(xId)).badge.text, "DOUBLE PAID: void one");

    /* ===== ticket release: PENDING is hidden, a Duo order is not ===== */
    F.orders.set("DUOORDER00001", { id: "DUOORDER00001", state: "open", createdTime: Date.now(), paymentState: "OPEN", total: 500, title: "", note: "", orderType: { id: "DUOTYPE00001" }, lineItems: { elements: [{ name: "Thirst Trap", price: 500 }] }, payments: { elements: [] } });
    await waitFor(async () => (await qs()).orders.some(o => o.id === "DUOORDER00001"), 8000, "the legacy Duo order shows");
    eq((await byTicket("DUOORDER00001")).badge, null, "legacy behavior: no badge");

    /* ===== Maze: the free upsize is a line-level discount, burned before the order exists ===== */
    await ctl({ op: "mode", sale: "approve" });
    await customer("Max", { code: "MAZE-123456", size: "Medium 24oz" });
    await waitFor(async () => (await screen()).confirm, 15000, "Maze order paid");
    const mOrder = lastKioskOrder(); eq(mOrder.lineItems.elements[0].discounts[0].amount, -80, "line-level 80 cent discount"); ok(/MAZE UPSIZE/.test(mOrder.note));
    ok(F.log.indexOf("POST /redeem") < F.log.lastIndexOf("POST /atomic_order/orders"), "the code was redeemed before the order was created");

    /* ===== quote mismatch: Clover disagrees by a cent -> no card, the order is the legacy window order ===== */
    F.skew = 1;
    const nKiosk = kioskOrders().length, nAll = F.orders.size;
    await customer("Moe", { noQuoteWait: true });
    await waitFor(async () => (await screen()).confirm, 15000, "window confirm on mismatch");
    sc = await screen(); ok(/Head to the window to pay/.test(sc.banner), "no card path when the totals disagree");
    eq(kioskOrders().length, nKiosk, "no atomic (Kiosk-typed) order was created");
    eq(F.orders.size, nAll + 1, "one order: the legacy line-by-line order");
    const legacyOrder = [...F.orders.values()].sort((a, b) => b.createdTime - a.createdTime)[0];
    ok(!legacyOrder.orderType && !legacyOrder.title && legacyOrder.lineItems.elements.length >= 1, "legacy shape: no orderType, no TBK title");
    eq((await sales()).filter(x => x.includes(legacyOrder.id)).length, 0, "and no card Sale was sent for it");
    F.skew = 0;

    /* ===== catalog drift: a mapped price jumps > 50% -> payment HELD, the last good prices stay, the page uses the window ===== */
    F.drift = 5000;
    await waitFor(async () => { const d = (await jreq(kioskPort, "GET", "/catalog")).json; return d.payNow === false && /held/.test(d.reason); }, 10000, "the drift hold");
    ok((await jreq(kioskPort, "GET", "/kiosk-status")).json.catalog.alerts.some(a => /PAYMENT HELD/.test(a)), "heartbeat alert raised");
    eq((await jreq(kioskPort, "GET", "/catalog")).json.items["dirtysodas/" + Object.keys(MAP.categories.dirtysodas.items)[0]], MAP.categories.dirtysodas.items[Object.keys(MAP.categories.dirtysodas.items)[0]].kioskCents, "last good price still served");
    await customer("Hal", { noQuoteWait: true });
    await waitFor(async () => (await screen()).confirm, 15000, "window confirm while held");
    ok(/Head to the window to pay/.test((await screen()).banner), "held catalog: window only");
    F.drift = 0;
    await waitFor(async () => (await jreq(kioskPort, "GET", "/catalog")).json.payNow === true, 10000, "the hold clears when prices come back");

    // nothing sensitive in the browser console or the server logs
    ok(!/PAYE2E[0-9]+.*(first6|cardholder|411111)/.test(kiosk.out), "no card data in the server log");
    console.log(`pay-e2e: ${passed} checks passed (Chrome ${await chrome.eval("navigator.userAgent.match(/Chrome\\/([\\d.]+)/)[1]")})`);
  } catch (e) {
    console.error("pay-e2e FAILED:", e && e.stack || e);
    try { console.error("--- page ---", JSON.stringify(await chrome.eval(`({ pay: document.querySelector('#payscreen').getAttribute('data-state'), payShown: document.querySelector('#payscreen').classList.contains('show'), confirm: document.querySelector('#confirm').classList.contains('show'),
      attract: getComputedStyle(document.querySelector('#attract')).display, sendFails: _sendFails, orderInFlight, quote: _quote && {ok:_quote.ok,payNow:_quote.payNow,reason:_quote.reason}, cart: cart.length, sheet: document.querySelector('#overlay').classList.contains('show') })`))); } catch {}
    console.error("--- clover calls (tail) ---\n" + F.log.slice(-14).join("\n") + "\nlast order: " + JSON.stringify([...F.orders.values()].pop() && { id: [...F.orders.values()].pop().id, title: [...F.orders.values()].pop().title, note: [...F.orders.values()].pop().note }));
    console.error("--- kiosk log (tail) ---\n" + String(kiosk && kiosk.out).slice(-2500));
    process.exitCode = 1;
  } finally {
    try { if (chrome) chrome.close(); } catch {}
    await stop(kiosk); await stop(station); clover.close(); clearInterval(keepAlive);
    process.exit(process.exitCode || 0);
  }
})();
