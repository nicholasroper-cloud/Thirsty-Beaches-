// tests/kiosk/pay-server.js — the pay kill switch, the payToken / route rules, rate limits and the boot assertion.
//   1. pure helpers in kiosk-lib.js (gate, remote kill file, boot assertion, limiter, payToken)
//   2. pay-routes.js in-process with the fake connector (Q5: token on every route, abandon rules, rate limit, kill)
//   3. the REAL kiosk-server.js in a child process against a fake Clover (kill matrix incl. restart persistence, payToken, guards)
// Never talks to a real Flex or a real Clover. Run: node tests/kiosk/pay-server.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const cp = require("child_process");
const assert = require("assert");
const lib = require("../../kiosk-lib");
const fp = require("../../flex-pay");
const J = require("../../pay-journal");
const { createPayApi } = require("../../pay-routes");
const { FakeConnector, mkPayment, sdk } = require("./pay-fakes");

const ROOT = path.resolve(__dirname, "../..");
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
async function waitFor(cond, ms = 6000, what = "condition") { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return; await sleep(40); } assert.fail("timed out waiting for " + what); }
const keepAlive = setInterval(() => {}, 1000);

function req(port, method, p, obj, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = obj === undefined ? null : (typeof obj === "string" ? obj : JSON.stringify(obj));
    const h = { Host: `127.0.0.1:${port}`, ...headers };
    if (method !== "GET") Object.assign(h, { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, ...headers });
    if (data !== null) h["Content-Length"] = Buffer.byteLength(data);
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: h }, res => { let b = ""; res.on("data", c => b += c); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, headers: res.headers, body: b, json: j }); }); });
    r.on("error", reject); if (data !== null) r.write(data); r.end();
  });
}

/* ================= 1. pure helpers ================= */
{
  // gate: strictly env && !flag && !remoteKill
  const matrix = [
    [{ envEnabled: true,  flagPresent: false, remoteKill: false }, true],
    [{ envEnabled: false, flagPresent: false, remoteKill: false }, false],   // env false: nothing else can turn it on
    [{ envEnabled: false, flagPresent: false, remoteKill: true  }, false],
    [{ envEnabled: true,  flagPresent: true,  remoteKill: false }, false],   // pay-off.flag
    [{ envEnabled: true,  flagPresent: false, remoteKill: true  }, false],   // remote kill
    [{ envEnabled: true,  flagPresent: true,  remoteKill: true  }, false],
    [{ envEnabled: "true", flagPresent: false, remoteKill: false }, false],  // not a clean boolean = no
    [{ envEnabled: true,  flagPresent: undefined, remoteKill: false }, false],
    [{ envEnabled: true,  flagPresent: false, remoteKill: undefined }, false],
  ];
  for (const [a, want] of matrix) eq(lib.payGate(a), want, JSON.stringify(a));
  // the Control file can only kill: the literal boolean false and nothing else
  eq(lib.payKillFrom({ payEnabled: false }), true);
  for (const v of [true, "true", "false", 1, 0, null, undefined, "", [], {}]) eq(lib.payKillFrom({ payEnabled: v }), false, "payEnabled=" + JSON.stringify(v) + " is not a kill");
  for (const c of [null, undefined, "x", 5, []]) eq(lib.payKillFrom(c), null, "no control data keeps the last answer");
  // and the Control file cannot reach any pay setting
  for (const k of ["PAY_ENABLED", "FLEX_IP", "FLEX_PORT", "PAY_TIMEOUT_MS", "FLEX_WS_SCHEME", "FLEX_PAIRING_FILE"]) ok(!(k in lib.SETTINGS_SPEC), k + " is not remotely settable");
  eq(lib.validateSettings({ PAY_ENABLED: true, FLEX_IP: "10.9.9.9" }).settings, {});

  // remote kill file: persisted, tolerant, literal true only
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-kill-")), f = path.join(dir, ".tb", "pay-remote-kill.json");
  eq(lib.readRemoteKill(f), false);
  lib.writeRemoteKill(f, true); eq(lib.readRemoteKill(f), true);
  lib.writeRemoteKill(f, false); eq(lib.readRemoteKill(f), false);
  for (const junk of ['{"kill":"true"}', '{"kill":1}', "not json", "[]", "null"]) { fs.writeFileSync(f, junk); eq(lib.readRemoteKill(f), false, "junk " + junk); }

  // boot assertion
  eq(lib.payBootProblem({ PAY_ENABLED: false, IDLE_MS: 1000, PAY_TIMEOUT_MS: 90000 }), null, "only checked when pay is on");
  eq(lib.payBootProblem({ PAY_ENABLED: true, IDLE_MS: 120000, PAY_TIMEOUT_MS: 60000 }), null, "defaults pass: 120000 > 105000");
  ok(/TB_IDLE_MS/.test(lib.payBootProblem({ PAY_ENABLED: true, IDLE_MS: 105000, PAY_TIMEOUT_MS: 60000 })), "equal is a refusal (must be strictly greater)");
  ok(lib.payBootProblem({ PAY_ENABLED: true, IDLE_MS: 120000, PAY_TIMEOUT_MS: 90000 }), "the old 90 s default no longer fits under the default idle time");
  eq(lib.payBootProblem({ PAY_ENABLED: true, IDLE_MS: 105001, PAY_TIMEOUT_MS: 60000 }), null);

  // rate limiter: 6 per minute, sliding
  let t = 1000; const lim = lib.makeRateLimiter(6, 60000, () => t);
  eq([1, 2, 3, 4, 5, 6, 7].map(() => lim.take()), [true, true, true, true, true, true, false]);
  t += 59000; eq(lim.take(), false); t += 1001; eq(lim.take(), true, "window slides");

  // payToken: 128 bits, bound to the order and the key
  const k1 = Buffer.alloc(32, 1), k2 = Buffer.alloc(32, 2);
  const tok = lib.payTokenFor(k1, "ORDER00000001");
  ok(/^[0-9a-f]{32}$/.test(tok)); ok(lib.payTokenOk(k1, "ORDER00000001", tok));
  ok(!lib.payTokenOk(k1, "ORDER00000002", tok), "bound to the order"); ok(!lib.payTokenOk(k2, "ORDER00000001", tok), "bound to the key");
  for (const bad of [undefined, null, "", 5, tok.slice(1), tok + "0", tok.toUpperCase(), "z".repeat(32)]) ok(!lib.payTokenOk(k1, "ORDER00000001", bad), "bad token " + String(bad).slice(0, 8));
  const kf = path.join(dir, "k", "pay-token.key"); const a = lib.loadOrCreateKey(kf), b = lib.loadOrCreateKey(kf);
  ok(a.length === 32 && a.equals(b), "key is created once and reused");
}

/* ================= 2. pay-routes.js in-process ================= */
async function routeTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-payroutes-"));
  const journal = J.createJournal({ dir }); journal.load();
  const fc = new FakeConnector(); const tags = [];
  const state = { allowed: true, orders: new Map(), deleted: [] };
  const key = Buffer.alloc(32, 7);
  const clock = { t: 1e12, spacing: 20000 };            // limiter clock: each /pay moves it on 20 s so ordinary tests stay under 6 per minute
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  const mute = on => { for (const k of Object.keys(quiet)) console[k] = on ? () => {} : quiet[k]; };
  mute(true);
  fp.init({ FLEX_IP: "x", FLEX_PORT: 1, FLEX_SCHEME: "wss", POS_NAME: "t", PAIRING_FILE: "x", JOURNAL_DIR: dir, PAY_TIMEOUT_MS: 150,
    timing: { PAY_TIMEOUT_MS: 150, EXTENSION_MS: 80, CANCEL_WAIT_MS: 60, ANSWER_MS: 250, RECONCILE_MS: 50, REST_AFTER_MS: 10000 }, payAllowed: () => state.allowed },
    { journal, sdk, connectorFactory: () => fc, tagOrder: async t => { tags.push(t); } });
  fc.listener.onDeviceConnected(); fc.listener.onDeviceReady({ deviceSerial: "C0", merchantName: "T" });
  let port;
  const api = createPayApi({
    flexPay: fp, payEnabled: true, payAllowed: () => state.allowed, tokenKey: key,
    cloverGet: async p => { const id = /\/orders\/([A-Za-z0-9]+)/.exec(p)[1]; const o = state.orders.get(id); if (!o) throw new Error("404"); return o; },
    cloverDelete: async id => { state.deleted.push(id); state.orders.delete(id); },
    sendJSON: (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); },
    readBody: r => new Promise(res => { let d = ""; r.on("data", c => d += c); r.on("end", () => res(d)); }),
    readerTimeoutMs: 60000, recoveryMs: 45000, now: () => clock.t,
  });
  const server = http.createServer(async (rq, res) => {
    const pathname = new URL(rq.url, "http://x").pathname;
    const problem = lib.requestProblem(rq, port);                        // the real Host / Origin / Sec-Fetch-Site guard runs first, as in kiosk-server.js
    if (problem) { res.writeHead(403); return res.end("forbidden"); }
    if (!(await api.handle(rq, res, pathname))) { res.writeHead(404); res.end("nf"); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r)); port = server.address().port;
  const mkOrder = (id, total = 349, extra = {}) => { state.orders.set(id, { id, state: "open", total, title: "TBK:PENDING", payments: { elements: [] }, ...extra }); };
  // ADR section 7: /pay answers {result:"pending"} at once; the page polls /pay/state. This helper does the same and returns the settled view.
  const MAPPED = { APPROVED: "approved", DECLINED: "declined", CANCELLED: "cancelled", TIMEOUT_UNKNOWN: "unknown", DISCONNECTED_UNKNOWN: "unknown" };
  const stateOf = (id, tok) => req(port, "GET", "/pay/state?orderId=" + id, undefined, { "X-Pay-Token": tok }).then(r => r.json);
  const payWait = async (id, tok, amt = 349) => {
    const r = await post("/pay", { orderId: id, amountCents: amt, payToken: tok });
    if (r.json.result !== "pending") return r.json;
    let s2; await waitFor(async () => { s2 = await stateOf(id, tok); return s2.state !== "IN_FLIGHT"; }, 5000, "the sale to settle");
    return { ...s2, result: MAPPED[s2.state] || s2.state };
  };
  const newOrder = (id, total) => { mkOrder(id, total); const tok = api.registerOrder(id); return tok; };
  const post = (p, body, h) => { if (p === "/pay") clock.t += clock.spacing; return req(port, "POST", p, body, h); };

  try {
    // registerOrder: token only for a registered order, 128 bits, and the order is in the journal
    const T1 = newOrder("ROUTEORDER001");
    ok(/^[0-9a-f]{32}$/.test(T1)); ok(journal.order("ROUTEORDER001").pendingAt > 0, "order is in the journal");

    // ---- token required on EVERY pay route ----
    const otherTok = newOrder("ROUTEORDER002");
    for (const [p, body] of [["/pay", { orderId: "ROUTEORDER001", amountCents: 349 }], ["/pay/window", { orderId: "ROUTEORDER001" }], ["/pay/abandon", { orderId: "ROUTEORDER001" }]]) {
      for (const [label, payToken] of [["missing", undefined], ["wrong", "0".repeat(32)], ["another order's", otherTok], ["malformed", "xyz"]]) {
        const r = await post(p, { ...body, payToken });
        eq(r.status, 403, `${p} with a ${label} token is refused`); eq(r.json.result === "forbidden" || r.json.error === "forbidden", true);
      }
    }
    for (const [label, h] of [["missing", {}], ["wrong", { "X-Pay-Token": "0".repeat(32) }], ["another order's", { "X-Pay-Token": otherTok }]])
      eq((await req(port, "GET", "/pay/state?orderId=ROUTEORDER001", undefined, h)).status, 403, `/pay/state with a ${label} token`);
    eq((await req(port, "GET", "/pay/state?orderId=ROUTEORDER001", undefined, { "X-Pay-Token": T1 })).json.state, "PENDING");
    // a perfectly signed token for an order this server never registered is still refused: "act only on orders in this server's journal"
    const ghost = lib.payTokenFor(key, "NEVERREGISTERED");
    eq((await post("/pay", { orderId: "NEVERREGISTERED", amountCents: 349, payToken: ghost })).status, 403);
    eq((await req(port, "GET", "/pay/state?orderId=NEVERREGISTERED", undefined, { "X-Pay-Token": ghost })).status, 403);
    eq(fc.count("sale"), 0, "no refused request reached the reader");
    // the token also works as the X-Pay-Token header on POSTs
    eq((await post("/pay/window", { orderId: "ROUTEORDER002" }, { "X-Pay-Token": otherTok })).json.result, "collect");

    // ---- Host / Origin / Sec-Fetch-Site guard still in front ----
    eq((await post("/pay", { orderId: "ROUTEORDER001", amountCents: 349, payToken: T1 }, { Origin: "http://evil.example" })).status, 403, "cross origin");
    eq((await post("/pay", { orderId: "ROUTEORDER001", amountCents: 349, payToken: T1 }, { Host: "evil.example" })).status, 403, "bad Host (DNS rebinding)");
    eq((await post("/pay", { orderId: "ROUTEORDER001", amountCents: 349, payToken: T1 }, { "Sec-Fetch-Site": "cross-site" })).status, 403, "cross-site fetch");
    eq((await post("/pay", { orderId: "ROUTEORDER001", amountCents: 349, payToken: T1 }, { "Content-Type": "text/plain" })).status, 403, "text/plain POST (no preflight)");
    ok(!("access-control-allow-origin" in (await req(port, "GET", "/payconfig")).headers) && !("access-control-allow-origin" in (await post("/pay/window", { orderId: "ROUTEORDER001", payToken: "0".repeat(32) })).headers), "no CORS header");

    // ---- /pay: server decides the amount (kept rule), approve, cached retry while the Clover order is locked ----
    eq((await post("/pay", { orderId: "ROUTEORDER001", amountCents: 100, payToken: T1 })).json.result, "mismatch", "client amount differs from the Clover total");
    eq(fc.count("sale"), 0);
    fc.script.sale = (id) => fc.listener.onSaleResponse(require("./pay-fakes").mkSale("SUCCESS", mkPayment({ extId: id, amount: 349, id: "PAYIDROUTE001" })));
    const first = await post("/pay", { orderId: "ROUTEORDER001", amountCents: 349, payToken: T1 });
    eq(first.json.result, "pending", "a started Sale answers at once");
    await waitFor(async () => (await stateOf("ROUTEORDER001", T1)).state === "APPROVED", 5000, "late approval reaches /pay/state");
    eq((await stateOf("ROUTEORDER001", T1)).paymentId, "PAYIDROUTE001");
    state.orders.get("ROUTEORDER001").state = "locked";                   // the PAID tag locked it in Clover
    const again = await post("/pay", { orderId: "ROUTEORDER001", amountCents: 349, payToken: T1 });
    eq(again.json.result, "approved", "a retry after a dropped response is answered from the journal even though the order is no longer open"); eq(again.json.ticket, "R001");
    eq(fc.count("sale"), 1);
    eq((await req(port, "GET", "/pay/state?orderId=ROUTEORDER001", undefined, { "X-Pay-Token": T1 })).json.state, "APPROVED");
    ok(JSON.stringify((await req(port, "GET", "/pay/state?orderId=ROUTEORDER001", undefined, { "X-Pay-Token": T1 })).json).indexOf("411111") < 0);

    // ---- /pay/abandon: only PENDING / DECLINED / CANCELLED, zero payments, reader idle ----
    const A = newOrder("ROUTEABAND01"), ab = body => post("/pay/abandon", { orderId: "ROUTEABAND01", payToken: A, ...body });
    fc.deviceState = "BUSY"; eq((await ab()).json.result, "refused", "reader not idle"); eq(state.deleted.length, 0);
    fc.deviceState = "IDLE";
    state.orders.get("ROUTEABAND01").payments = { elements: [{ id: "P1" }] };
    eq((await ab()).json.result, "refused", "Clover shows a payment on it"); eq(state.deleted.length, 0);
    state.orders.get("ROUTEABAND01").payments = { elements: [] };
    state.orders.get("ROUTEABAND01").state = "locked";
    eq((await ab()).json.result, "refused", "not an open order"); state.orders.get("ROUTEABAND01").state = "open";
    eq((await ab()).json.result, "abandoned"); eq(state.deleted, ["ROUTEABAND01"]);
    eq(fp.orderState("ROUTEABAND01").state, "ABANDONED");
    eq((await ab()).json.result, "refused", "second abandon: it is gone");
    eq((await post("/pay/abandon", { orderId: "ROUTEORDER001", payToken: T1 })).json.result, "refused", "a PAID order is never deleted");
    eq((await post("/pay/abandon", { orderId: "ROUTEORDER002", payToken: otherTok })).json.result, "refused", "a COLLECT order is not deleted");
    eq(state.deleted.length, 1);
    // declined attempt -> abandon allowed
    const D = newOrder("ROUTEDECLN01");
    fc.script.sale = () => fc.listener.onSaleResponse(require("./pay-fakes").mkSale("FAIL", null, "declined"));
    { clock.t = Date.now(); const dr = await payWait("ROUTEDECLN01", D); eq(dr.result, "declined");
      ok(dr.stillThereInMs > 0 && dr.stillThereInMs <= 30000 && dr.abandonInMs === dr.stillThereInMs + 10000, "declined carries the server-side Still there? countdown (30 s) and the abandon countdown (40 s)"); }
    eq((await post("/pay/abandon", { orderId: "ROUTEDECLN01", payToken: D })).json.result, "abandoned");
    // an UNKNOWN order is never deleted
    fc.deviceState = "BUSY"; fc.script.sale = () => {};
    const U = newOrder("ROUTEUNKNW01");
    { clock.t = Date.now(); const ur = await payWait("ROUTEUNKNW01", U); eq(ur.result, "unknown"); ok(ur.resetInMs > 0 && ur.resetInMs <= 20000, "UNKNOWN carries the 20 s hold countdown"); }
    fc.deviceState = "IDLE";
    eq((await post("/pay/abandon", { orderId: "ROUTEUNKNW01", payToken: U })).json.result, "refused");
    eq((await post("/pay", { orderId: "ROUTEUNKNW01", amountCents: 349, payToken: U })).json.result, "blocked-unknown", "answered from the journal; the Clover order is locked");
    eq((await post("/pay/window", { orderId: "ROUTEUNKNW01", payToken: U })).json.result, "blocked-unknown");
    // let reconcile settle it (device has nothing) so the reader is free for the next checks
    fc.script.retrievePayment = () => ({ status: "NOT_FOUND" });
    await waitFor(() => fp.orderState("ROUTEUNKNW01").state === "COLLECT", 5000, "UNKNOWN released to COLLECT");

    // ---- kill switch: status/config say off, new sale refused, journal answers continue ----
    state.allowed = false;
    eq((await req(port, "GET", "/payconfig")).json.enabled, false);
    eq((await req(port, "GET", "/pay/status")).json.state, "off");
    const K = newOrder("ROUTEKILL001");
    const kr = await post("/pay", { orderId: "ROUTEKILL001", amountCents: 349, payToken: K });
    eq(kr.json.result, "unavailable"); const salesBefore = fc.count("sale");
    eq((await post("/pay", { orderId: "ROUTEORDER001", amountCents: 349, payToken: T1 })).json.result, "approved", "an approved order still answers while killed");
    eq(fc.count("sale"), salesBefore);
    state.allowed = true;
    const pc = (await req(port, "GET", "/payconfig")).json; eq([pc.enabled, pc.readerTimeoutMs, pc.recoveryMs], [true, 60000, 45000]);
    eq((await req(port, "GET", "/pay/status")).json.state, "ready");

    // ---- rate limit: /pay 6 per minute (this run already used some; flood until it trips, then check the shape) ----
    clock.spacing = 0;                                                   // now flood: no time passes between requests
    let tripped = null;
    for (let i = 0; i < 12 && !tripped; i++) { const r = await post("/pay", { orderId: "ROUTEKILL001", amountCents: 349, payToken: K }); if (r.status === 429) tripped = r; }
    ok(tripped, "/pay is rate limited"); eq(tripped.json.result, "unavailable");
    ok(api.quoteAllowed() === true, "the /quote limiter exists for the quote route (30 per minute)");
    let q = 1; while (api.quoteAllowed()) q++; eq(q, 30, "30 quotes pass, the 31st does not");
  } finally {
    mute(false); server.close(); fp.shutdown();
  }
}

/* ================= 3. the real kiosk-server.js in a child process ================= */
const fake = { control: {}, controlFail: false, orders: new Map(), seq: 0 };
const cloverSrv = http.createServer((rq, res) => {
  const u = new URL(rq.url, "http://x"); let body = "";
  rq.on("data", c => body += c); rq.on("end", () => {
    const j = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    const m = u.pathname.replace(/^\/v3\/merchants\/[^/]+/, "");
    if (u.pathname === "/control.json") return fake.controlFail ? j(500, { error: "down" }) : j(200, fake.control);
    let mm;
    if (rq.method === "POST" && m === "/orders") { const o = { id: "KORDER" + String(++fake.seq).padStart(6, "0"), state: "open", total: 349, lineItems: { elements: [] }, createdTime: Date.now() }; fake.orders.set(o.id, o); return j(200, o); }
    if (rq.method === "POST" && (mm = /^\/orders\/([^/]+)\/line_items$/.exec(m))) { const o = fake.orders.get(mm[1]); o.lineItems.elements.push(JSON.parse(body)); return j(200, { id: "LI1" }); }
    if (rq.method === "POST" && (mm = /^\/orders\/([^/]+)$/.exec(m))) { Object.assign(fake.orders.get(mm[1]), JSON.parse(body)); return j(200, {}); }
    if (rq.method === "GET" && (mm = /^\/orders\/([^/]+)$/.exec(m))) { const o = fake.orders.get(mm[1]); return o ? j(200, o) : j(404, {}); }
    if (rq.method === "GET" && m === "/orders") return j(200, { elements: [] });
    j(404, { message: "no" });
  });
});
function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-paysrv-"));
  for (const f of ["kiosk-server.js", "kiosk-lib.js", "flex-pay.js", "pay-journal.js", "pay-routes.js", "catalog.js", "quote.js", "catalog-map.json", "moderation.js", "addons.json", "drink-kiosk.html", "drink-kiosk-light.html"]) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  return dir;
}
function spawnKiosk(dir, port, cloverPort, env) {
  const child = cp.spawn(process.execPath, ["kiosk-server.js"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, CLOVER_API_TOKEN: "t", CLOVER_MERCHANT_ID: "M", CLOVER_BASE_URL: "http://127.0.0.1:" + cloverPort, PORT: String(port), KIOSK_HEARTBEAT_URL: "off",
      CONTROL_URL: "http://127.0.0.1:" + cloverPort + "/control.json", TB_CONTROL_MS: "150", PRIZE_API: "http://127.0.0.1:" + cloverPort, ...env } });
  child.out = ""; child.stdout.on("data", d => child.out += d); child.stderr.on("data", d => child.out += d);
  return child;
}
const stop = c => new Promise(r => { if (c.exitCode !== null) return r(); c.on("exit", () => r()); c.kill(); });
async function up(port) { const end = Date.now() + 8000; while (Date.now() < end) { try { if ((await req(port, "GET", "/health")).status) return true; } catch {} await sleep(100); } return false; }
const enabled = async port => (await req(port, "GET", "/payconfig")).json.enabled;

async function serverTests(cloverPort) {
  const dir = stage();
  const tb = f => path.join(dir, ".tb", f);
  let saved = null;
  const run = async (env, fn) => { const port = await freePort(); const c = spawnKiosk(dir, port, cloverPort, env); try { ok(await up(port), "server up: " + c.out); await fn(port, c); } finally { await stop(c); } };

  // ---- kill matrix 1: env false. Nothing the Control file says can enable pay ----
  fake.control = { payEnabled: true }; fake.controlFail = false;
  await run({ PAY_ENABLED: "false", FLEX_IP: "127.0.0.1" }, async port => {
    await sleep(500);
    eq(await enabled(port), false, "env false + remote true: pay stays off");
    for (const v of ["true", 1, "yes"]) { fake.control = { payEnabled: v, settings: { PAY_ENABLED: v, FLEX_IP: "10.9.9.9" } }; await sleep(450); eq(await enabled(port), false, "env false + remote " + JSON.stringify(v)); }
    const s = (await req(port, "GET", "/kiosk-status")).json.pay; eq([s.enabled, s.allowed], [false, false]);
    ok(!fs.existsSync(tb("pay-token.key")) && !fs.existsSync(tb("pay-journal.jsonl")), "pay off: no key file and no journal are created");
    const o = await req(port, "POST", "/order", { cart: [{ name: "Thirst Trap", unit: 3.49, qty: 1, mods: [] }], name: "Sam" });
    eq(o.status, 200); ok(!("payToken" in o.json), "pay off: no payToken is issued");
    eq((await req(port, "POST", "/pay", { orderId: o.json.orderId, amountCents: 349 })).json.result, "unavailable");
  });

  // ---- kill matrix 2: env true. true / "true" / 1 are NOT a kill; the flag and a literal false are ----
  fake.control = { payEnabled: true };
  await run({ PAY_ENABLED: "true", FLEX_IP: "127.0.0.1" }, async port => {
    await sleep(450);
    eq(await enabled(port), true, "env true + remote true");
    for (const v of ["true", 1, null]) { fake.control = { payEnabled: v }; await sleep(450); eq(await enabled(port), true, "env true + remote " + JSON.stringify(v)); }
    // pay-off.flag: honored on the very next call, no restart
    fs.mkdirSync(path.dirname(tb("x")), { recursive: true }); fs.writeFileSync(tb("pay-off.flag"), "");
    eq(await enabled(port), false, "env true + pay-off.flag"); eq((await req(port, "GET", "/pay/status")).json.state, "off");
    let s = (await req(port, "GET", "/kiosk-status")).json.pay; eq([s.allowed, s.offFlag], [false, true]);
    fs.unlinkSync(tb("pay-off.flag")); eq(await enabled(port), true, "flag removed: pay resumes");
    // payToken on the real server (journal exists because FLEX_IP is set; the SDK is not installed in this stage dir, so the reader is "disabled")
    ok(fs.existsSync(tb("pay-token.key")), "the token key is created when pay is on");
    const o = await req(port, "POST", "/order", { cart: [{ name: "Thirst Trap", unit: 3.49, qty: 1, mods: [] }], name: "Sam" });
    eq(o.status, 200); ok(/^[0-9a-f]{32}$/.test(o.json.payToken), "/order returns a 128-bit payToken");
    const id = o.json.orderId, tok = o.json.payToken;
    eq((await req(port, "POST", "/pay", { orderId: id, amountCents: 349 })).status, 403, "no token");
    eq((await req(port, "POST", "/pay", { orderId: id, amountCents: 349, payToken: "0".repeat(32) })).status, 403, "wrong token");
    eq((await req(port, "POST", "/pay/window", { orderId: id })).status, 403); eq((await req(port, "POST", "/pay/abandon", { orderId: id })).status, 403);
    eq((await req(port, "GET", "/pay/state?orderId=" + id)).status, 403);
    eq((await req(port, "GET", "/pay/state?orderId=" + id, undefined, { "X-Pay-Token": tok })).json.state, "PENDING");
    const pr = await req(port, "POST", "/pay", { orderId: id, amountCents: 349, payToken: tok });
    eq(pr.status, 200); eq(pr.json.result, "unavailable", "valid token, reader not connected: refused without a Sale");
    eq((await req(port, "POST", "/pay", { orderId: id, amountCents: 349, payToken: tok }, { Origin: "http://evil.example" })).status, 403, "Origin guard kept");
    eq((await req(port, "POST", "/pay", { orderId: id, amountCents: 349, payToken: tok }, { Host: "evil.example" })).status, 403, "Host guard kept");
    eq((await req(port, "POST", "/pay/window", { orderId: id, payToken: tok })).json.result, "collect");
    saved = { id, tok };
    // the journal holds ids and states only
    const lines = fs.readFileSync(tb("pay-journal.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    for (const l of lines) for (const k of Object.keys(l)) ok(J.ALLOWED_KEYS.includes(k), "journal key " + k);
  });
  // the token and the registered order survive a restart (HMAC key + journal on disk)
  await run({ PAY_ENABLED: "true", FLEX_IP: "127.0.0.1" }, async port => {
    const { id, tok } = saved;
    eq((await req(port, "GET", "/pay/state?orderId=" + id, undefined, { "X-Pay-Token": tok })).json.state, "COLLECT", "after a restart the order and its token are still valid");
  });

  // ---- kill matrix 3: env true + remote literal false = off; a failed fetch KEEPS the kill; a restart KEEPS it; only a good fetch clears it ----
  fake.control = { payEnabled: false }; fake.controlFail = false;
  await run({ PAY_ENABLED: "true", FLEX_IP: "127.0.0.1" }, async port => {
    await waitFor(async () => (await enabled(port)) === false, 5000, "remote kill applied");
    eq(JSON.parse(fs.readFileSync(tb("pay-remote-kill.json"), "utf8")).kill, true, "last remote kill persisted under .tb/");
    let s = (await req(port, "GET", "/kiosk-status")).json.pay; eq([s.remoteKill, s.allowed], [true, false]);
    fake.controlFail = true; await sleep(700);
    eq(await enabled(port), false, "failed fetch keeps the last kill");
    fake.controlFail = false; fake.control = ["not", "a", "control", "file"]; await sleep(700);        // fetched fine but unusable: also "no data"
    eq(await enabled(port), false, "an unusable Control body keeps the last kill");
    fake.control = { payEnabled: false };
    fake.controlFail = true;
  });
  await run({ PAY_ENABLED: "true", FLEX_IP: "127.0.0.1" }, async port => {
    await sleep(200);
    eq(await enabled(port), false, "restart with GitHub unreachable keeps the kill");
    fake.control = { payEnabled: true, updated: "x" }; fake.controlFail = false;
    await waitFor(async () => (await enabled(port)) === true, 5000, "kill cleared by a good fetch");
    eq(JSON.parse(fs.readFileSync(tb("pay-remote-kill.json"), "utf8")).kill, false);
    // a Control file with no payEnabled at all is "not a kill"
    fake.control = { payEnabled: false }; await waitFor(async () => (await enabled(port)) === false, 5000, "kill again");
    fake.control = {}; await waitFor(async () => (await enabled(port)) === true, 5000, "missing key clears");
    // and the Control file still cannot move the reader or change timeouts
    fake.control = { settings: { FLEX_IP: "10.9.9.9", PAY_TIMEOUT_MS: 15000, PAY_ENABLED: false } }; await sleep(500);
    eq(await enabled(port), true); eq((await req(port, "GET", "/payconfig")).json.readerTimeoutMs, 60000);
  });

  // ---- boot assertion: refuse to start with PAY_ENABLED=true unless IDLE_MS > PAY_TIMEOUT_MS + 45000 ----
  fake.control = {}; fake.controlFail = false;
  for (const [env, shouldRun] of [[{ PAY_TIMEOUT_MS: "90000" }, false], [{ PAY_TIMEOUT_MS: "60000", TB_IDLE_MS: "105000" }, false], [{ PAY_TIMEOUT_MS: "60000", TB_IDLE_MS: "105001" }, true], [{}, true], [{ PAY_TIMEOUT_MS: "90000", TB_IDLE_MS: "300000" }, true]]) {
    const port = await freePort(); const c = spawnKiosk(dir, port, cloverPort, { PAY_ENABLED: "true", FLEX_IP: "127.0.0.1", ...env });
    if (shouldRun) { ok(await up(port), "starts with " + JSON.stringify(env) + ": " + c.out); await stop(c); }
    else { await new Promise(r => c.on("exit", r)); eq(c.exitCode, 2, "refuses " + JSON.stringify(env)); ok(/REFUSING TO START/.test(c.out) && /TB_IDLE_MS/.test(c.out), "explains the fix"); }
  }
  // pay off: the assertion does not apply
  { const port = await freePort(); const c = spawnKiosk(dir, port, cloverPort, { PAY_ENABLED: "false", PAY_TIMEOUT_MS: "90000", TB_IDLE_MS: "2000" }); ok(await up(port), "pay off is never refused"); await stop(c); }

  // ---- rate limit on the real server: /pay 6 per minute ----
  await run({ PAY_ENABLED: "true", FLEX_IP: "127.0.0.1" }, async port => {
    const codes = []; for (let i = 0; i < 8; i++) codes.push((await req(port, "POST", "/pay", { orderId: "X", amountCents: 1 })).status);
    eq(codes.slice(0, 6).every(c => c !== 429), true); eq(codes.slice(6), [429, 429], "7th and 8th /pay in a minute are refused");
  });
}

(async () => {
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  await routeTests();
  await new Promise(r => cloverSrv.listen(0, "127.0.0.1", r));
  try { await serverTests(cloverSrv.address().port); } finally { cloverSrv.close(); }
  console.log(`pay-server: ${passed} checks passed`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
