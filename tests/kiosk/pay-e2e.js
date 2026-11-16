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
const S = { sale: "silent", retrieve: "NOT_FOUND", shell: 0, pay: 0, cancel: "ignore" };
const payment = (extId, amount) => mkPayment({ extId, amount, id: "PAYE2E" + String(++S.pay).padStart(6, "0"), shell: "SHELLE2E" + String(++S.shell).padStart(5, "0") });
const amountOf = extId => { if (S.amount) return S.amount; const c = fc.calls.filter(x => x.m === "sale" && x.extId === extId).pop(); return c ? c.amount : 100; };
fc.script.sale = (extId, req) => {
  if (S.sale === "approve") fc.listener.onSaleResponse(mkSale("SUCCESS", payment(extId, req.getAmount())));
  else if (S.sale === "decline") fc.listener.onSaleResponse(mkSale("FAIL", null, "declined"));
  else if (S.sale === "cancel") fc.listener.onSaleResponse(mkSale("CANCEL", null, "cancelled"));
};
fc.script.cancel = () => { if (S.cancel === "respond") fc.listener.onSaleResponse(mkSale("CANCEL", null, "Request Canceled")); };   // the reader answers our ESC with a CANCEL
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
    if (o.op === "mode") { for (const k of ["sale", "retrieve", "cancel", "amount"]) if (o[k] !== undefined) S[k] = o[k]; if (o.device) fc.deviceState = o.device; }
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
  await send("Emulation.setDeviceMetricsOverride", { width: 1080, height: 1920, deviceScaleFactor: 1, mobile: false }, sessionId);   // the kiosk is a portrait 1080x1920 screen
  const page = {
    errors: [], events,
    async goto(url) { await send("Page.navigate", { url }, sessionId); await waitFor(async () => (await page.eval("document.readyState")) === "complete", 20000, "page load"); },
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error("page error: " + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result.value;
    },
    async viewport(w, h, reduce = false) {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }] }, sessionId);
    },
    async shot(file, w = 1080, h = 1920, reduce = false) {              // only when TB_SHOTS=<dir> is set (screens for the UX review); never in a normal run
      if (!process.env.TB_SHOTS) return;
      await page.viewport(w, h, reduce); await sleep(500);
      const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
      fs.mkdirSync(process.env.TB_SHOTS, { recursive: true });
      fs.writeFileSync(path.join(process.env.TB_SHOTS, file), Buffer.from(data, "base64"));
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
    PAY_UNKNOWN_HOLD_MS: "6000", PAY_DECLINED_WAIT_MS: "2500", PAY_STILL_THERE_MS: "2000", READER_SIDE: "right", TB_IDLE_MS: "120000", PAY_RATE_PER_MIN: "60" };
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
    await chrome.shot("01-cart-with-tax.png");
    await E("_quote=null; _quoteSig=''; _quotePending=true; document.querySelector('#cartTotals').innerHTML=totalsHTML(); true");
    ok(/calculating/.test(await E("document.querySelector('#cartTotals').textContent")) && !/\$\d/.test(await E("document.querySelector('#cartTotals').textContent")), "Snake Eyes 9: while the quote is pending the cart never shows a bare subtotal");
    await chrome.shot("01b-cart-calculating.png");
    await E("refreshQuoteView(); true"); await waitFor(() => E("quoteUsable()"), 8000, "the quote again");
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
    ok(/^\d{3}$/.test(sc.num) && /^✓ Paid \$\d+\.\d\d\. Grab your order at the window/.test(sc.banner), "confirm screen: ticket number and the green paid pill (" + sc.banner + ")");
    eq(await E("document.querySelector('#confirm .paywindow').classList.contains('paid')"), true);
    eq(await E("[document.querySelector('#confirm .check').textContent, document.querySelector('#confirm').classList.contains('window')]"), ["✓", false], "paid hero: the check");
    await chrome.shot("02-confirm-paid.png");
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
    eq(sc.body, "Tap Try again to use another card, or tap Pay at the window so we start your drink.", "Snake Eyes 5: declined copy");
    await chrome.shot("03-declined.png");
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
    eq((await screen()).body, "Tap Try again, or tap Pay at the window so we start your drink.", "Snake Eyes 5: cancelled copy");
    await chrome.shot("05-cancelled.png");
    await E("payAtWindow(); true");
    await waitFor(async () => (await screen()).confirm, 8000, "window confirm");
    sc = await screen(); ok(/^Pay \$\d+\.\d\d at the window, then grab your order/.test(sc.banner), "window banner");
    eq(await E("document.querySelector('#confirm .paywindow').classList.contains('collect')"), true, "amber pill");
    eq(await E("[document.querySelector('#confirm .check').textContent, document.querySelector('#confirm').classList.contains('window'), getComputedStyle(document.querySelector('#confirm .check')).backgroundColor]"), ["$", true, "rgb(255, 209, 102)"], "NEW-6: the pay-at-the-window hero is an amber $, not the paid check");
    await chrome.shot("06-confirm-window-collect.png");
    const cOrder = lastKioskOrder();
    await waitFor(() => F.orders.get(cOrder.id).title === "TBK:COLLECT" && F.orders.get(cOrder.id).state === "open", 8000, "COLLECT title, open");
    { const t = await waitFor(async () => byTicket(cOrder.id)); eq(t.badge.kind, "COLLECT"); ok(/^COLLECT \$\d+\.\d\d$/.test(t.badge.text), t.badge.text); eq(t.paid, false); }

    /* ===== Still there? / abandon: a declined order left alone is abandoned (deleted) after the countdowns ===== */
    await ctl({ op: "mode", sale: "decline" });
    await customer("Dee");
    await waitFor(async () => (await screen()).state === "declined", 15000, "declined (idle case)");
    const dOrder = lastKioskOrder();
    await waitFor(async () => (await screen()).still, 8000, "Still there? appears");
    ok(/^\d+$/.test(await E("document.querySelector('#payStillSecs').textContent")) && await E("getComputedStyle(document.querySelector('#payStill')).position") === "fixed", "Still there? is a modal with a seconds countdown");
    { // NEW-6: a solid card behind the modal text, so nothing underneath shows through the sentence
      const m = await E(`(function(){ const card = document.querySelector('#payStill .pay-still-card'), c = getComputedStyle(card), p = document.querySelector('#payStill p').getBoundingClientRect(), r = card.getBoundingClientRect();
        return { bg: c.backgroundColor, inside: p.left >= r.left && p.right <= r.right && p.top >= r.top && p.bottom <= r.bottom }; })()`);
      ok(/^rgb\(\d+, \d+, \d+\)$/.test(m.bg) && m.inside, "Still there? text sits on an opaque card: " + m.bg);
    }
    await chrome.shot("04-declined-still-there.png");
    await E("document.dispatchEvent(new Event('pointerdown')); true");
    await waitFor(async () => !(await screen()).still, 3000, "a touch clears Still there? (Snake Eyes 6)");
    await waitFor(() => !F.orders.has(dOrder.id), 10000, "the abandoned order is deleted");
    await waitFor(async () => !(await screen()).shown, 5000, "the page went back to the attract screen");

    /* ===== NEW-4: an order that is being closed or was abandoned is "cancelled, start over", never a window confirm ===== */
    await ctl({ op: "mode", sale: "decline", retrieve: "NOT_FOUND", device: "IDLE" });
    await customer("Abe");
    await waitFor(async () => (await screen()).state === "declined", 15000, "Abe: declined");
    const abeId = lastKioskOrder().id, abeTok = await E("_payOrder.payToken");
    ok((await jreq(kioskPort, "POST", "/pay/abandon", { orderId: abeId, payToken: abeTok })).json.result === "abandoned", "the server abandons Abe's order");
    await E("doPay(); true");                                                           // the customer taps Try again a moment too late
    await waitFor(async () => !(await screen()).shown, 8000, "Abe: back to the attract screen");
    sc = await screen();
    ok(!sc.confirm, "no window confirm for a deleted order");
    ok(/cancelled/i.test(await E("document.querySelector('#toast').textContent")) && await E("document.querySelector('#toast').classList.contains('show')"), "a plain message says the order was cancelled");
    await customer("Bea");
    await waitFor(async () => (await screen()).state === "declined", 15000, "Bea: declined");
    await E(`(async () => { const of = window.fetch; window.fetch = (u, o) => String(u).includes('/pay/window') ? Promise.resolve({ json: async () => ({ result: 'unavailable', message: 'order is being closed' }) }) : of(u, o); try { await payAtWindow(); } finally { window.fetch = of; } return true; })()`);
    await waitFor(async () => !(await screen()).shown, 5000, "Bea: back to the attract screen");
    ok(!(await screen()).confirm && /cancelled/i.test(await E("document.querySelector('#toast').textContent")), "'being closed' also ends in the cancelled message, not a window confirm");

    /* ===== every pay-screen state, held still for the screenshots (the poll is paused; the reader's answer to the window tap ends it) ===== */
    await ctl({ op: "mode", sale: "silent", retrieve: "NOT_FOUND", cancel: "respond", device: "IDLE" });
    await customer("Pia");
    await waitFor(async () => (await screen()).state === "working", 10000, "Pia: working");
    await E("clearTimeout(_payPoll.timer); true");
    await chrome.shot("07-working-arrow-right.png");
    await E("setPayState('prompt'); true"); await chrome.shot("08-prompt.png");
    for (const side of ["left", "below"]) { await E(`document.querySelector('#payArrow').setAttribute('data-side','${side}'); true`); await chrome.shot(`08-prompt-arrow-${side}.png`); }
    await E("document.querySelector('#payArrow').setAttribute('data-side','right'); setPayState('recovering'); true"); await chrome.shot("09-recovering.png");
    await E("payAtWindow(); true");
    await waitFor(async () => (await screen()).confirm, 10000, "Pia: window confirm");
    await ctl({ op: "mode", cancel: "ignore" });

    /* ===== D + H: disconnect after the prompt, "Don't pay again", repeat /pay blocked, reconnect proves ONE payment ===== */
    await ctl({ op: "mode", sale: "silent", retrieve: "FOUND" });
    await customer("Dan");
    await waitFor(async () => (await screen()).state === "working", 10000, "working screen");
    const dId = lastKioskOrder().id; const salesBefore = (await sales()).length;
    await ctl({ op: "disconnect" });
    await waitFor(async () => (await screen()).state === "unknown", 10000, "the 'we're checking' screen");
    sc = await screen();
    ok(/checking your payment/i.test(sc.hl) && /You may already be paid\. Show #\d+ at the window and we'll sort it out\./.test(sc.body) && /^#\d+$/.test(sc.ticket), "UNKNOWN copy: " + sc.hl + " / " + sc.body);
    await chrome.shot("10-unknown-dont-pay-again.png");
    { // Snake Eyes 3: it must not look like a pay prompt
      const v = await E(`(function(){ const q = s => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none'; }; return { dont: q('#payDont'), dontText: document.querySelector('#payDont').textContent, amount: q('#payAmount'), label: q('#payLabel'), reader: q('.reader-icon'), arrow: q('#payArrow'), where: q('#payWhere'), retry: q('#payRetryBtn'), window: q('#payWindowBtn'), got: q('#payGotBtn') }; })()`);
      eq([v.dont, v.dontText, v.amount, v.label, v.reader, v.arrow, v.where, v.retry, v.window, v.got], [true, "DON'T PAY AGAIN", false, false, false, false, false, false, false, true], "UNKNOWN screen: DON'T PAY AGAIN pill and Got it, no amount, no reader, no retry, no window button");
    }
    await waitFor(() => F.orders.get(dId).title === "TBK:CHECK" && F.orders.get(dId).state === "locked", 8000, "CHECK title and lock");
    { const t = await waitFor(async () => byTicket(dId)); eq(t.badge.kind, "CHECK"); eq(t.badge.long, "CHECK READER, do not charge"); eq(t.badge.text, "⚠ CHECK"); }
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
    await ctl({ op: "mode", sale: "silent", retrieve: "FOUND", amount: F.orders.get(gId).total });   // the restarted reader process has no memory of the sale amount: tell it
    await ready();
    await waitFor(async () => (await screen()).confirm || (await screen()).state === "unknown", 25000, "the page recovers after the restart");
    await waitFor(() => /^TBK:PAID:/.test(F.orders.get(gId).title), 15000, "replay resolved the order to PAID");
    eq((await sales()).filter(x => x.startsWith("TBK" + gId)).length, 0, "the restarted server sent no new Sale (the first process sent it)");
    ok(/boot replay/.test(kiosk.out), "the boot log shows the journal replay");

    await ctl({ op: "mode", amount: 0 });
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
    eq((await byTicket(xId)).badge.long, "DOUBLE PAID: void one"); eq((await byTicket(xId)).badge.text, "2× DOUBLE");
    { const hb = (await jreq(kioskPort, "GET", "/kiosk-status")).json.pay; ok(hb.doubles >= 1 && /DOUBLE CHARGE/.test(hb.alert), "CR-010: the heartbeat reports the double and says what to do: " + hb.alert); }

    /* ===== ticket release: PENDING is hidden, a Duo order is not ===== */
    F.orders.set("DUOORDER00001", { id: "DUOORDER00001", state: "open", createdTime: Date.now(), paymentState: "OPEN", total: 500, title: "", note: "", orderType: { id: "DUOTYPE00001" }, lineItems: { elements: [{ name: "Thirst Trap", price: 500 }] }, payments: { elements: [] } });
    await waitFor(async () => (await qs()).orders.some(o => o.id === "DUOORDER00001"), 8000, "the legacy Duo order shows");
    eq((await byTicket("DUOORDER00001")).badge, null, "legacy behavior: no badge");

    /* ===== Maze: the free upsize is a line-level discount, burned before the order exists ===== */
    await ctl({ op: "mode", sale: "approve" });
    await customer("Max", { code: "MAZE-123456", size: "Medium 24oz" });
    await waitFor(async () => (await screen()).confirm, 15000, "Maze order paid");
    await chrome.shot("11-confirm-paid-maze.png");
    ok(/Thirsty Maze free upsize applied: -\$0\.80/.test(await E("document.querySelector('#confirm .upsizenote').textContent")), "Snake Eyes 10: the Maze note shows the discount");
    const mOrder = lastKioskOrder(); eq(mOrder.lineItems.elements[0].discounts[0].amount, -80, "line-level 80 cent discount"); ok(/MAZE UPSIZE/.test(mOrder.note));
    ok(F.log.indexOf("POST /redeem") < F.log.lastIndexOf("POST /atomic_order/orders"), "the code was redeemed before the order was created");

    /* ===== Snake Eyes 4: "Pay at the window" while the reader is waiting cancels the prompt (server side) and goes to COLLECT ===== */
    await ctl({ op: "mode", sale: "silent", retrieve: "NOT_FOUND", cancel: "respond", device: "IDLE" });
    await customer("Wes");
    await waitFor(async () => (await screen()).state === "working", 10000, "working before the window tap");
    sc = await screen();
    ok(sc.hl === "Tap your card on the reader" && /Or insert or swipe it/.test(sc.body), "working copy tells the customer to tap (Snake Eyes 7): " + sc.hl);
    eq(await E("document.querySelector('#payWindowBtn').textContent"), "Cancel card and pay at the window", "the button says what it does while the prompt is live");
    eq(await E("document.querySelector('#payArrow').getAttribute('data-side')"), "right", "READER_SIDE puts an arrow disc at that edge");
    const wId = lastKioskOrder().id;
    await E("payAtWindow(); true");
    await waitFor(async () => (await screen()).confirm, 10000, "window confirm after cancelling the prompt");
    sc = await screen(); ok(/^Pay \$\d+\.\d\d at the window, then grab your order/.test(sc.banner), "amber window pill with the amount: " + sc.banner);
    await waitFor(() => F.orders.get(wId).title === "TBK:COLLECT", 8000, "COLLECT after the cancel");
    ok((await ctl({ op: "calls" })).calls.some(c => c.m === "cancel" && c.key === "ESC"), "the server sent CANCEL_INPUT_OPTION (ESC) to the reader");
    eq((await sales()).filter(x => x.startsWith("TBK" + wId)).length, 1, "one Sale, cancelled, no second attempt");
    await ctl({ op: "mode", cancel: "ignore" });

    /* ===== "Got it" on the checking screen, then CR-005: a second customer while the reader holds an unresolved attempt goes straight to the window ===== */
    await ctl({ op: "mode", sale: "silent", retrieve: "NOT_FOUND", device: "BUSY" });
    await customer("Xan");
    await waitFor(async () => (await screen()).state === "unknown", 15000, "Xan: checking screen");
    const xanId = lastKioskOrder().id;
    await E("document.querySelector('#payGotBtn').click(); true");
    await waitFor(async () => !(await screen()).shown && !(await screen()).confirm, 8000, "Got it returns to the attract screen");
    eq(F.orders.get(xanId).title, "TBK:CHECK", "the order is kept, locked, for the window");
    const salesNow = (await sales()).length;
    await ctl({ op: "mode", sale: "approve" });                                          // the reader stays BUSY: Xan is genuinely unresolved
    await customer("Yul");
    await waitFor(async () => (await screen()).confirm, 10000, "Yul is sent to the window, not left on a dead prompt");
    sc = await screen(); ok(/^Pay \$\d+\.\d\d at the window/.test(sc.banner), "CR-005: " + sc.banner);
    eq((await sales()).length, salesNow, "no Sale for Yul while Xan is unresolved");
    ok((await E("_payPoll")) === null, "and the page is not polling a prompt that will never come");
    await ctl({ op: "respond", extId: `TBK${xanId}-1`, rc: "SUCCESS" });                // Xan's card was charged after all
    await waitFor(() => /^TBK:PAID:/.test(F.orders.get(xanId).title), 8000, "Xan's late approval tags PAID");
    await ctl({ op: "mode", device: "IDLE" });

    /* ===== quote mismatch: Clover disagrees by a cent -> no card, the order is the legacy window order ===== */
    F.skew = 1;
    const nKiosk = kioskOrders().length, nAll = F.orders.size;
    await customer("Moe", { noQuoteWait: true });
    await waitFor(async () => (await screen()).confirm, 15000, "window confirm on mismatch");
    sc = await screen(); ok(/^Pay \$\d+\.\d\d at the window, then grab your order/.test(sc.banner), "no card path when the totals disagree");
    eq(kioskOrders().length, nKiosk, "no atomic (Kiosk-typed) order was created");
    eq(F.orders.size, nAll + 1, "one order: the legacy line-by-line order");
    const legacyOrder = [...F.orders.values()].sort((a, b) => b.createdTime - a.createdTime)[0];
    ok(!legacyOrder.orderType && !legacyOrder.title && legacyOrder.lineItems.elements.length >= 1, "legacy shape: no orderType, no TBK title");
    { // CR-001: a legacy order is not in the journal, so even a correctly computed token buys nothing
      const lib = require("../../kiosk-lib"); const key = lib.loadOrCreateKey(path.join(dir, ".tb", "pay-token.key"));
      const r = await jreq(kioskPort, "POST", "/pay", { orderId: legacyOrder.id, amountCents: legacyOrder.total, payToken: lib.payTokenFor(key, legacyOrder.id) });
      eq(r.status, 403, "CR-001: /pay refuses a legacy order"); eq((await sales()).filter(x => x.includes(legacyOrder.id)).length, 0);
    }
    eq((await sales()).filter(x => x.includes(legacyOrder.id)).length, 0, "and no card Sale was sent for it");
    F.skew = 0;

    /* ===== catalog drift: a mapped price jumps > 50% -> payment HELD, the last good prices stay, the page uses the window ===== */
    F.drift = 5000;
    await waitFor(async () => { const d = (await jreq(kioskPort, "GET", "/catalog")).json; return d.payNow === false && /held/.test(d.reason); }, 10000, "the drift hold");
    ok((await jreq(kioskPort, "GET", "/kiosk-status")).json.catalog.alerts.some(a => /PAYMENT HELD/.test(a)), "heartbeat alert raised");
    eq((await jreq(kioskPort, "GET", "/catalog")).json.items["dirtysodas/" + Object.keys(MAP.categories.dirtysodas.items)[0]], MAP.categories.dirtysodas.items[Object.keys(MAP.categories.dirtysodas.items)[0]].kioskCents, "last good price still served");
    await customer("Hal", { noQuoteWait: true });
    await waitFor(async () => (await screen()).confirm, 15000, "window confirm while held");
    ok(/^Pay \$\d+\.\d\d at the window, then grab your order/.test((await screen()).banner), "held catalog: window only");
    F.drift = 0;
    await waitFor(async () => (await jreq(kioskPort, "GET", "/catalog")).json.payNow === true, 10000, "the hold clears when prices come back");

    /* ===== the station at 1920x1080 with PAID, COLLECT, CHECK and DOUBLE tickets together (Snake Eyes 1, 2): no overflow, no clipped amount ===== */
    await ctl({ op: "mode", sale: "silent", retrieve: "NOT_FOUND", device: "BUSY" });
    await customer("Zed");
    await waitFor(async () => (await screen()).state === "unknown", 15000, "Zed: a CHECK ticket for the station");
    const zId = lastKioskOrder().id;
    const keep = new Set([ord.id, cOrder.id, zId, xId]);
    for (const id of [...F.orders.keys()]) if (!keep.has(id)) F.orders.delete(id);
    F.orders.get(cOrder.id).total = 535;                                              // the amount that clipped in the review ("COLLECT $5.35")
    await chrome.goto(`http://127.0.0.1:${stationPort}/`);
    await chrome.viewport(1920, 1080);
    await waitFor(() => chrome.eval("document.querySelectorAll('#qlist .tk').length === 4"), 15000, "four tickets on the station");
    const kinds = await chrome.eval("[...document.querySelectorAll('#qlist .tk')].map(t => t.querySelector('.paybadge') && t.querySelector('.paybadge').className.replace('paybadge ','') + '|' + t.querySelector('.paybadge').textContent)");
    ok(["paid|✓ PAID", "collect|COLLECT $5.35", "check|⚠ CHECK", "double|2× DOUBLE"].every(k => kinds.includes(k)), "tile labels are short: " + kinds.join(", "));
    const geometry = () => chrome.eval(`(function(){ const r = e => e && e.getBoundingClientRect(); const out = {}; const sel = document.querySelector('#qlist .tk.on');
      const tiles = [...document.querySelectorAll('#qlist .tk')]; out.tileClip = tiles.map(t => { const pb = t.querySelector('.pb'), b = t.querySelector('.paybadge'), sub = t.querySelector('.sub'); const rg = document.createRange(); if (b) rg.selectNodeContents(b); const tr = b ? rg.getBoundingClientRect() : null; return { badgeFits: !!b && b.scrollWidth <= b.clientWidth + 1 && r(b).right <= r(t).right - 8 && tr.right <= r(b).right - 6 && tr.left >= r(b).left + 6, subVisible: !!sub && r(sub).width > 40 && sub.textContent.trim().length > 0 }; });
      const done = document.querySelector('#doneBtn'), next = document.querySelector('.nextpane'), head = document.querySelector('#make .mhead'), hb = head && head.querySelector('.paybadge');
      out.done = done ? { right: r(done).right, bottom: r(done).bottom, vis: r(done).width > 0 } : null; out.next = next ? { left: r(next).left, display: getComputedStyle(next).display } : null;
      out.headBadge = hb ? { text: hb.textContent, h: r(hb).height, fs: parseFloat(getComputedStyle(hb).fontSize), fits: r(hb).right <= r(head).right + 1 && r(hb).left >= r(head).left - 1 } : null;
      out.headFits = head ? head.scrollWidth <= head.clientWidth + 1 : null; return out; })()`);
    const pick = async id => { await chrome.eval(`document.querySelector('#qlist .tk[data-id="${id}"]').click(); true`); await sleep(400); return geometry(); };
    await chrome.shot("20-station-default.png", 1920, 1080);
    for (const [name, id, kind, longText] of [["check", zId, "check", "CHECK READER, do not charge"], ["double", xId, "double", "DOUBLE PAID: void one"], ["collect", cOrder.id, "collect", "COLLECT $5.35"], ["paid", ord.id, "paid", "✓ PAID"]]) {
      const g = await pick(id);
      ok(g.headBadge && g.headBadge.text === longText && g.headBadge.fs >= 40 && g.headBadge.fits && g.headFits, `${name}: the header badge is 40 px, full text "${g.headBadge && g.headBadge.text}" and fits in the header`);
      ok(g.done && g.done.vis && (!g.next || g.next.display === "none" || g.done.right <= g.next.left + 1), `${name}: "Done, next ticket" is not under the NEXT pane (done right ${g.done && g.done.right}, next left ${g.next && g.next.left})`);
      ok(g.tileClip.every(t => t.badgeFits && t.subVisible), `${name}: no tile clips its badge, and every tile still shows its drink summary`);
      await chrome.shot(`21-station-${name}-selected.png`, 1920, 1080);
    }
    await chrome.shot("22-station-reduced-motion.png", 1920, 1080, true);
    await jreq(stationPort, "POST", "/done", { id: ord.id });
    await chrome.goto(`http://127.0.0.1:${stationPort}/board`);
    await sleep(3500);
    await chrome.shot("23-board.png", 1920, 1080);
    await chrome.shot("24-board-reduced-motion.png", 1920, 1080, true);

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
