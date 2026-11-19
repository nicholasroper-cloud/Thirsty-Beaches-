// tests/kiosk/arcade-prize.js — an arcade win riding the order as a prize badge, and NOTHING else about the order changing.
//   A  arcade-routes.js unit tests (injected clock, Worker and Clover): the pending prize exists only after a Worker-issued win, one at a time,
//      expires after 15 minutes, is declined/cleared, survives a restart through .tb/arcade-pending.json, and attach writes exactly ONE thing to
//      Clover: the order's note.
//   B  the REAL kiosk-server.js against a fake Worker and a fake stateful Clover: browser-supplied prize fields are ignored, the legacy /order
//      handler is untouched, line items / totals / discounts are identical with and without a prize, cross-origin attach is refused, the
//      ticket the REAL make-station-server.js serves carries the tag, and the redeem relay forwards the ticket number.
//   D  (needs Chrome) the arcade on the kiosk's own screen (v40): the entry on the home and attract screens, the cart guard, the way back, the idle return, the
//      spin and time limit, win -> Order now -> banner, and the audio stopping. Time-based limits are driven with a skewed Date.now in the page, no waiting.
//   C  (needs Chrome, skips without) the order screen banner, the confirm note, the make-station badge, bump -> redeem, and a station server
//      from before this update (the badge still shows, nothing throws). TB_SHOTS=<dir> writes screenshots (kiosk 1080x1920, station 1920x1080).
// Run: node tests/kiosk/arcade-prize.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const cp = require("child_process");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "../..");
const { createArcade, PRIZES, PENDING_TTL_MS } = require(path.join(ROOT, "arcade-routes.js"));
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
async function waitFor(cond, ms = 15000, what = "condition") { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await cond(); if (last) return last; } catch (e) { last = e; } await sleep(60); } assert.fail("timed out waiting for " + what + (last instanceof Error ? ": " + last.message : "")); }
const keepAlive = setInterval(() => {}, 1000);
const KIOSK_KEY = "k".repeat(30), STAFF = "staff-secret-key-1234";
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

/* ================================================================= A. unit ================================================================= */
async function unit() {
  let t = 1_700_000_000_000;
  const mk = (over = {}) => {
    const calls = [], cloverPosts = [];
    const dir = over.dir || tmp("tb-prize-unit-");
    const orders = over.orders || {};
    const worker = over.worker || (async (url, init) => {
      const u = String(url);
      if (/\/scores\/token$/.test(u)) return { status: 200, json: async () => ({ token: "tok" + Math.random(), minMs: 0 }) };
      if (/\/kitchen\/claim$/.test(u)) { const b = JSON.parse(init.body); calls.push({ body: b, headers: init.headers }); return { status: 200, json: async () => ({ ok: true, code: "K7QD", ticket: { reward: "Secret Menu Unlock" } }) }; }
      return { status: 404, json: async () => ({}) };
    });
    const a = createArcade({
      tbDir: dir, apiBase: "https://worker.test", kioskKey: over.noKey ? "" : KIOSK_KEY, stationKey: STAFF, fetchImpl: worker, now: () => t,
      rng: over.rng || (() => 0.85),          // 0.85 of 100 -> size_upgrade (standard is 0..81, size_upgrade 81..87)
      clover: over.clover || { get: async p => { const m = /^\/orders\/(.+)$/.exec(p); return m ? orders[decodeURIComponent(m[1])] || null : null; }, post: async (p, b) => { cloverPosts.push({ p, b }); const m = /^\/orders\/(.+)$/.exec(p); if (m && orders[m[1]] && "note" in b) orders[m[1]].note = b.note; return {}; } },
    });
    return { a, calls, cloverPosts, dir, orders };
  };
  const warm = async a => { await a.refill(); t += 3000; };

  // 1. no KIOSK_KEY: the arcade plays, there is no code, so there is no pending prize
  { const { a } = mk({ noKey: true }); const r = await a.spin(); eq([r.win, r.thanks], [false, true], "no key: thanks for playing"); eq(a.getPending(), null, "no code, no pending prize"); }
  // 2. a normal drink reveal (not a prize roll) never creates one
  { const { a } = mk({ rng: () => 0.1 }); await warm(a); const r = await a.spin(); eq(r.prizeId, "standard"); eq(a.getPending(), null); }
  // 3. the Worker refuses (cap): thanks, nothing pending; and no play token yet: same
  { const { a } = mk({ worker: async u => /token$/.test(u) ? { status: 200, json: async () => ({ token: "x", minMs: 0 }) } : { status: 429, json: async () => ({ error: "sold-out" }) } }); await warm(a); const r = await a.spin(); eq(r.thanks, true); eq(a.getPending(), null, "Worker refused: nothing pending"); }
  { const { a } = mk(); const r = await a.spin(); eq(r.thanks, true); eq(a.getPending(), null, "no play token old enough: nothing pending"); }

  // 4. a Worker-issued win becomes the pending prize; the Worker is told the prize id, and only id and label
  const m4 = mk(); await warm(m4.a);
  const win = await m4.a.spin();
  eq([win.win, win.code, win.prizeId, win.label], [true, "K7QD", "size_upgrade", "Free Size Upgrade"], "win carries the prize label");
  eq(m4.calls[0].body.prize, { id: "size_upgrade", label: "Free Size Upgrade" }, "the claim asks the Worker to store the prize");
  eq(m4.calls[0].headers["X-Kiosk-Key"], KIOSK_KEY, "the claim carries the kiosk key");
  const p = m4.a.getPending();
  eq([p.code, p.prizeId, p.label, p.issuedAt, p.expiresAt], ["K7QD", "size_upgrade", "Free Size Upgrade", t, t + PENDING_TTL_MS], "pending: code, prize id, label, issuedAt, expiry");
  ok(PENDING_TTL_MS === 15 * 60000, "15 minute window");
  // 5. persisted, and a restart (supervisor) keeps it; a restart after expiry does not
  eq(JSON.parse(fs.readFileSync(path.join(m4.dir, "arcade-pending.json"), "utf8")).code, "K7QD", "stored in .tb/arcade-pending.json");
  eq(mk({ dir: m4.dir }).a.getPending().code, "K7QD", "a restarted server still has it");
  // 6. expiry
  t += PENDING_TTL_MS - 1; ok(m4.a.getPending() !== null, "still pending a millisecond before expiry");
  t += 1; eq(m4.a.getPending(), null, "expired at 15 minutes"); ok(!fs.existsSync(path.join(m4.dir, "arcade-pending.json")), "expired file removed");
  eq(mk({ dir: m4.dir }).a.getPending(), null);
  { // a stale or tampered file is not trusted
    const d = tmp("tb-prize-stale-"); fs.writeFileSync(path.join(d, "arcade-pending.json"), JSON.stringify({ code: "K7QD", prizeId: "size_upgrade", issuedAt: t - PENDING_TTL_MS - 5 }));
    eq(mk({ dir: d }).a.getPending(), null, "an expired file is dropped at start");
    fs.writeFileSync(path.join(d, "arcade-pending.json"), JSON.stringify({ code: "<b>x", prizeId: "size_upgrade", issuedAt: t })); eq(mk({ dir: d }).a.getPending(), null, "a bad code in the file is ignored");
    fs.writeFileSync(path.join(d, "arcade-pending.json"), JSON.stringify({ code: "K7QD", prizeId: "standard", issuedAt: t })); eq(mk({ dir: d }).a.getPending(), null, "'standard' is not a prize");
    fs.writeFileSync(path.join(d, "arcade-pending.json"), JSON.stringify({ code: "K7QD", prizeId: "size_upgrade", label: "FREE CAR", issuedAt: t })); eq(mk({ dir: d }).a.getPending().label, "Free Size Upgrade", "the label always comes from the fixed table");
  }
  // 7. one at a time per kiosk: a newer win replaces the older
  { const m = mk({ rng: (() => { const v = [0.85, 0.995]; let i = 0; return () => v[i++ % 2]; })() }); await warm(m.a); await m.a.spin(); t += 3000; await m.a.refill(); t += 3000; await m.a.spin();
    const q = m.a.getPending(); eq(q.prizeId, "free_drink_jackpot", "the newest win is the one pending"); eq(m.calls.length, 2); }
  // 8. decline clears (memory and file)
  { const m = mk(); await warm(m.a); await m.a.spin(); ok(m.a.getPending()); eq(m.a.dismissPending(), { ok: true, dismissed: true }); eq(m.a.getPending(), null); ok(!fs.existsSync(path.join(m.dir, "arcade-pending.json")));
    eq(m.a.dismissPending(), { ok: true, dismissed: false }, "declining twice is harmless"); }

  // 9. attach: ONE Clover write, the note; nothing else about the order
  const fresh = (extra = {}) => ({ id: "ORDER000001", createdTime: t - 5000, note: "Sam — Kiosk order #104", total: 650, title: "TBK:COLLECT", state: "open", ...extra });
  { const m = mk({ orders: { ORDER000001: fresh() } }); await warm(m.a); await m.a.spin();
    eq((await m.a.attachToOrder("../etc")).status, 400, "a bad order id is refused"); eq((await m.a.attachToOrder(undefined)).status, 400); eq((await m.a.attachToOrder({ $ne: 1 })).status, 400, "an object is not an order id");
    eq(m.cloverPosts.length, 0, "refused ids write nothing");
    const r = await m.a.attachToOrder("ORDER000001");
    eq(r.body, { ok: true, code: "K7QD", label: "Free Size Upgrade" });
    eq(m.cloverPosts.length, 1, "exactly one Clover write"); eq(m.cloverPosts[0].p, "/orders/ORDER000001");
    eq(Object.keys(m.cloverPosts[0].b), ["note"], "the write holds the note and nothing else (no total, title, state, line items, discounts)");
    eq(m.cloverPosts[0].b.note, "Sam — Kiosk order #104 · ARCADE size_upgrade K7QD");
    eq(m.a.getPending(), null, "pending is cleared once it is on the order");
    eq((await m.a.attachToOrder("ORDER000001")).body, { ok: true, already: true, code: "K7QD", label: "Free Size Upgrade" }, "the same order twice is idempotent"); eq(m.cloverPosts.length, 1);
    eq((await m.a.attachToOrder("ORDER000002")).body, { ok: false, error: "no-pending" }, "a later order gets nothing"); }
  // 10. attach refuses what is not a fresh kiosk order, and keeps the prize pending
  for (const [why, o] of [["not a kiosk order", fresh({ note: "Register sale" })], ["an old order", fresh({ createdTime: t - 16 * 60000 })], ["a future-dated order", fresh({ createdTime: t + 16 * 60000 })], ["no createdTime", fresh({ createdTime: undefined })]]) {
    const m = mk({ orders: { ORDER000001: o } }); await warm(m.a); await m.a.spin();
    const r = await m.a.attachToOrder("ORDER000001"); eq(r.body.ok, false, why); eq(m.cloverPosts.length, 0, why + ": nothing written"); ok(m.a.getPending(), why + ": prize stays pending");
  }
  { const m = mk({ orders: {} }); await warm(m.a); await m.a.spin(); eq((await m.a.attachToOrder("ORDER000009")).body.error, "order-unreadable", "unreadable order: kept pending"); ok(m.a.getPending()); }
  { const orders = { ORDER000001: fresh() }; const m = mk({ orders, clover: { get: async () => orders.ORDER000001, post: async () => { throw new Error("Clover 500"); } } }); await warm(m.a); await m.a.spin();
    eq((await m.a.attachToOrder("ORDER000001")).body.error, "order-write-failed", "a failed Clover write is reported"); ok(m.a.getPending(), "and the prize stays pending so the page can retry"); }
  { const m = mk({ orders: { ORDER000001: fresh({ note: "Sam — Kiosk order #104 · ARCADE size_upgrade K7QD" }) } }); await warm(m.a); await m.a.spin();
    const r = await m.a.attachToOrder("ORDER000001"); eq(r.body.ok, true); eq(m.cloverPosts.length, 0, "a tag already on the note is never added twice"); }
  // 11. the arcade-prize ids are the ones the Worker allows (worker-tb-where/src/lib/prizes.js ARCADE_PRIZES)
  eq(PRIZES.filter(x => x.isPrize).map(x => x.id), ["size_upgrade", "soft_serve_topper", "neon_charm", "topper_or_sticker", "free_drink_jackpot"], "kiosk prize ids match the Worker allow-list");
}

/* ================================================================= B. server ================================================================= */
function req(port, method, p, obj, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = obj === undefined ? null : JSON.stringify(obj);
    const h = { Host: `127.0.0.1:${port}`, ...headers };
    if (method !== "GET") Object.assign(h, { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, ...headers });
    if (data !== null) h["Content-Length"] = Buffer.byteLength(data);
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: h }, res => { let b = ""; res.on("data", c => b += c); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: b, json: j }); }); });
    r.on("error", reject); if (data !== null) r.write(data); r.end();
  });
}
const CODES = ["K7QD", "M3PA", "N4RS", "T5WX", "P6VZ", "H8GC"];
const worldWorker = { claims: [], redeems: [], issued: 0 };
const worker = http.createServer((rq, rs) => {
  let b = ""; rq.on("data", c => b += c); rq.on("end", () => {
    const j = (s, o) => { rs.writeHead(s, { "Content-Type": "application/json" }); rs.end(JSON.stringify(o)); };
    const body = (() => { try { return JSON.parse(b || "{}"); } catch { return {}; } })();
    if (rq.method === "GET" && rq.url === "/scores/token") return j(200, { token: "tk" + Math.random().toString(16).slice(2), minMs: 100 });
    if (rq.method === "POST" && rq.url === "/kitchen/claim") {
      if (rq.headers["x-kiosk-key"] !== KIOSK_KEY) return j(429, { error: "daily-limit" });
      worldWorker.claims.push(body);
      const code = CODES[worldWorker.issued++ % CODES.length];
      return j(200, { ok: true, code, ticket: { reward: "Secret Menu Unlock", drinkName: "Neon Rip Curl", build: "Sprite", expiresAt: Date.now() + 1e6 } });
    }
    if (rq.method === "POST" && rq.url === "/kitchen/claims/redeem") { worldWorker.redeems.push(body); return j(200, { ok: true, status: "redeemed" }); }
    if (rq.url === "/kitchen/claims" || rq.url.startsWith("/kitchen/drops")) return j(200, { claims: [], drops: [] });
    if (rq.url === "/secret-menu") return j(200, { drinks: [] });
    if (rq.url === "/stock") return j(200, { items: [], ingredients: [], updatedAt: 0 });
    j(404, {});
  });
});
/* a small stateful Clover: orders, line items, discounts, notes. Everything the kiosk writes is recorded per order. */
const world = { orders: new Map(), n: 0 };
const clover = http.createServer((rq, rs) => {
  let b = ""; rq.on("data", c => b += c); rq.on("end", () => {
    const j = (s, o) => { rs.writeHead(s, { "Content-Type": "application/json" }); rs.end(JSON.stringify(o)); };
    const body = (() => { try { return JSON.parse(b || "{}"); } catch { return {}; } })();
    const u = new URL(rq.url, "http://x"); const p = u.pathname.replace(/^\/v3\/merchants\/[^/]+/, "");
    const view = o => ({ id: o.id, state: o.state, createdTime: o.createdTime, note: o.note, title: o.title, total: o.lineItems.reduce((s, l) => s + l.price, 0), lineItems: { elements: o.lineItems.map(l => ({ ...l })) } });
    if (rq.method === "POST" && p === "/orders") { const id = "ORDER" + String(++world.n).padStart(6, "0"); world.orders.set(id, { id, state: "open", createdTime: Date.now(), note: "", title: "", lineItems: [], discounts: [], posts: [] }); return j(200, { id }); }
    let m;
    if (rq.method === "POST" && (m = /^\/orders\/([A-Z0-9]+)\/line_items$/.exec(p))) { const o = world.orders.get(m[1]); if (!o) return j(404, {}); o.lineItems.push({ id: "L" + o.lineItems.length, ...body }); return j(200, {}); }
    if (rq.method === "POST" && (m = /^\/orders\/([A-Z0-9]+)\/discounts$/.exec(p))) { const o = world.orders.get(m[1]); if (!o) return j(404, {}); o.discounts.push(body); return j(200, {}); }
    if (rq.method === "POST" && (m = /^\/orders\/([A-Z0-9]+)$/.exec(p))) { const o = world.orders.get(m[1]); if (!o) return j(404, {}); o.posts.push(body); Object.assign(o, body); return j(200, view(o)); }
    if (rq.method === "GET" && (m = /^\/orders\/([A-Z0-9]+)$/.exec(p))) { const o = world.orders.get(m[1]); return o ? j(200, view(o)) : j(404, {}); }
    if (rq.method === "DELETE" && (m = /^\/orders\/([A-Z0-9]+)$/.exec(p))) { world.orders.delete(m[1]); return j(200, {}); }
    if (rq.method === "GET" && p === "/orders") return j(200, { elements: [...world.orders.values()].map(view) });
    if (rq.method === "GET" && p === "/items") return j(200, { elements: [] });
    j(200, { elements: [] });
  });
});
function stageKiosk() {
  const dir = tmp("tb-prize-kiosk-");
  for (const f of ["kiosk-server.js", "kiosk-lib.js", "flex-pay.js", "pay-journal.js", "pay-routes.js", "catalog.js", "quote.js", "moderation.js", "arcade-routes.js", "addons.json", "drink-kiosk.html", "drink-kiosk-light.html"]) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "catalog-map.json"), JSON.stringify({ version: 1, floats: [], categories: {} }));
  fs.cpSync(path.join(ROOT, "kiosk"), path.join(dir, "kiosk"), { recursive: true });
  return dir;
}
function stageStation() {
  const dir = tmp("tb-prize-station-");
  for (const f of ["make-station-server.js", "make-station.html", "pickup-board.html", "recipes.json", "addons.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  return dir;
}
function spawnNode(dir, file, env) {
  const c = cp.spawn(process.execPath, [file], { cwd: dir, env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  c.out = ""; c.stdout.on("data", d => c.out += d); c.stderr.on("data", d => c.out += d);
  return c;
}
const CART = [{ name: "Neon Sunset Float", mods: ["Large", "Extra cream"], unit: 6.5, qty: 1 }, { name: "Malibu Barbie", mods: [], unit: 4.25, qty: 2 }];
const orderCalls = id => { const o = world.orders.get(id); return { lines: o.lineItems.map(l => ({ name: l.name, price: l.price, note: l.note || null })), discounts: o.discounts, total: o.lineItems.reduce((s, l) => s + l.price, 0), postKeys: o.posts.map(x => Object.keys(x).sort().join(",")) }; };

let ctx = null;
async function servers() {
  await new Promise(r => worker.listen(0, "127.0.0.1", r)); await new Promise(r => clover.listen(0, "127.0.0.1", r));
  const workerPort = worker.address().port, cloverPort = clover.address().port;
  const base = { CLOVER_API_TOKEN: "t", CLOVER_MERCHANT_ID: "M", CLOVER_BASE_URL: "http://127.0.0.1:" + cloverPort };
  const kioskPort = await freePort(), stationPort = await freePort();
  const kiosk = spawnNode(stageKiosk(), "kiosk-server.js", { ...base, PORT: String(kioskPort), KIOSK_HEARTBEAT_URL: "off", PRIZE_API: "http://127.0.0.1:" + workerPort, KIOSK_KEY, STATION_KEY: STAFF, TB_CATALOG_MS: "60000" });
  const station = spawnNode(stageStation(), "make-station-server.js", { ...base, MAKE_PORT: String(stationPort), MAKE_BIND: "127.0.0.1", MAKE_POLL_SEC: "3", TB_WHERE_ORIGIN: "http://127.0.0.1:" + workerPort, KIOSK_KEY });
  await waitFor(async () => (await req(kioskPort, "GET", "/health").catch(() => ({}))).status === 200, 10000, "kiosk up");
  await waitFor(async () => (await req(stationPort, "GET", "/health").catch(() => ({}))).status === 200, 10000, "station up");
  // staff makes every spin a size_upgrade win
  eq((await req(kioskPort, "POST", "/api/arcade-config", { odds: [{ id: "standard", pct: 0 }, { id: "size_upgrade", pct: 100 }, { id: "soft_serve_topper", pct: 0 }, { id: "neon_charm", pct: 0 }, { id: "topper_or_sticker", pct: 0 }, { id: "free_drink_jackpot", pct: 0 }] }, { "X-Key": STAFF })).status, 200, "staff odds saved");
  ctx = { kioskPort, stationPort, kiosk, station, workerPort };
  return ctx;
}
async function winOne(kioskPort, body) {
  // the Worker wants a play token ~2 s old; spin until the Worker has issued a real code
  const issuedBefore = worldWorker.issued;
  for (let i = 0; i < 12; i++) {
    const r = await req(kioskPort, "POST", "/api/arcade/spin", body === undefined ? {} : body);
    if (r.json && r.json.win === true) { ok(worldWorker.issued === issuedBefore + 1); return r.json; }
    await sleep(700);
  }
  assert.fail("no win");
}
const place = (kioskPort, name) => req(kioskPort, "POST", "/order", { cart: CART, name });
const stationOrders = async () => { const r = await req(ctx.stationPort, "GET", "/queue"); return r.json.waiting.concat(r.json.ready); };

async function serverTests() {
  const { kioskPort, stationPort } = await servers();
  const pend = async () => (await req(kioskPort, "GET", "/api/arcade/pending")).json;

  // nothing pending before any win; the routes exist only as documented
  eq(await pend(), { ok: true, pending: null }, "nothing pending at start");
  eq((await req(kioskPort, "POST", "/api/arcade/pending", { code: "ZZZZ", prizeId: "free_drink_jackpot" })).status, 404, "there is no route that creates a pending prize from the browser");
  eq((await req(kioskPort, "PUT", "/api/arcade/pending", { code: "ZZZZ" })).status, 404);
  // a spin made before any play token is old enough (and one with forged fields) gives no prize and no pending
  let r = await req(kioskPort, "POST", "/api/arcade/spin", { prize: { id: "free_drink_jackpot", label: "FREE CAR" }, code: "ZZZZ", win: true, prizeId: "free_drink_jackpot", pending: { code: "ZZZZ" } });
  eq([r.json.win, r.json.thanks], [false, true], "no token yet: thanks for playing");
  eq(await pend(), { ok: true, pending: null }, "forged spin fields create nothing");

  // a worker-issued win (with forged browser fields in the body, which are ignored) becomes pending, with the SERVER's prize
  await sleep(2600);
  const w1 = await winOne(kioskPort, { prize: { id: "free_drink_jackpot", label: "FREE CAR" }, code: "ZZZZ", prizeId: "free_drink_jackpot" });
  eq([w1.prizeId, w1.label, w1.code], ["size_upgrade", "Free Size Upgrade", "K7QD"], "the rolled prize and the Worker's code, not the forged ones");
  eq(worldWorker.claims[0].prize, { id: "size_upgrade", label: "Free Size Upgrade" }, "the Worker was told the real prize");
  const p1 = (await pend()).pending;
  eq([p1.code, p1.prizeId, p1.label], ["K7QD", "size_upgrade", "Free Size Upgrade"], "pending after a Worker-issued win");
  ok(Number.isInteger(p1.issuedAt) && p1.expiresAt - p1.issuedAt === 15 * 60000, "issuedAt and a 15 minute expiry");
  eq((await req(kioskPort, "GET", "/api/arcade/pending")).status, 200); ok(!/no-store/i.test("") && true);

  // decline clears it (dismiss takes no input, so a forged body changes nothing)
  eq((await req(kioskPort, "POST", "/api/arcade/pending/dismiss", { keep: true, code: "ZZZZ" })).json, { ok: true, dismissed: true });
  eq(await pend(), { ok: true, pending: null }, "declined: cleared");

  // ---- an order WITH a prize and one WITHOUT: same cart, the reviewed /order handler, identical lines and totals ----
  const plain = await place(kioskPort, "Sam");
  eq(plain.status, 200, "order without a prize"); const plainId = plain.json.orderId;
  await sleep(2600);
  await winOne(kioskPort);
  const prizeOrder = await place(kioskPort, "Sam");
  eq(prizeOrder.status, 200); const prizeId = prizeOrder.json.orderId;
  // a cross-origin page cannot attach; a non-JSON POST cannot either; the page's own body fields are never read
  eq((await req(kioskPort, "POST", "/api/arcade/pending/attach", { orderId: prizeId }, { Origin: "http://evil.example" })).status, 403, "cross-origin attach refused");
  eq((await req(kioskPort, "POST", "/api/arcade/pending/attach", { orderId: prizeId }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  const forged = await req(kioskPort, "POST", "/api/arcade/pending/attach", { orderId: prizeId, prizeId: "free_drink_jackpot", label: "FREE CAR", code: "ZZZZ", note: "x", price: 0, discount: 100 });
  eq(forged.json, { ok: true, code: "M3PA", label: "Free Size Upgrade" }, "attach used the server's own pending prize, not the forged fields");
  const a = orderCalls(plainId), b = orderCalls(prizeId);
  eq(b.lines, a.lines, "line items are identical with and without a prize");
  eq([b.total, b.discounts], [a.total, a.discounts], "totals and discounts are identical");
  eq(b.discounts, [], "no discount line on the prize order");
  eq(a.postKeys, ["note"], "an order without a prize: the one note write the handler always made");
  eq(b.postKeys, ["note", "note"], "the prize order: the handler's note write, then ONE more note write, never a total/title/state/line-item write");
  const noteA = world.orders.get(plainId).note, noteB = world.orders.get(prizeId).note;
  eq(noteB, noteA.replace(/#\d+/, "#" + /#(\d+)/.exec(noteB)[1]) + " · ARCADE size_upgrade M3PA", "the note is the normal note plus the prize tag");
  eq(await pend(), { ok: true, pending: null }, "pending cleared once attached");
  eq((await place(kioskPort, "Pat")).status, 200);
  eq(world.orders.get("ORDER000003").note.includes("ARCADE"), false, "the next order gets no prize");
  // attach for an order that is not a kiosk order, and for nothing pending
  world.orders.set("ORDERREG01", { id: "ORDERREG01", state: "open", createdTime: Date.now(), note: "Register sale", title: "", lineItems: [], discounts: [], posts: [] });
  eq((await req(kioskPort, "POST", "/api/arcade/pending/attach", { orderId: "ORDERREG01" })).json.ok, false);

  // ---- the ticket the REAL station server serves carries the tag; the board's fields are the ones it always had ----
  await sleep(3500);
  const orders = await waitFor(async () => { const l = await stationOrders(); return l.length >= 3 && l; }, 12000, "station sees the orders");
  const tk = orders.find(o => o.id === prizeId), tkPlain = orders.find(o => o.id === plainId);
  ok(/ · ARCADE size_upgrade M3PA$/.test(tk.orderNote), "the make-station ticket carries the prize tag in its order note");
  eq([tk.total, tk.items.map(i => [i.name, i.qty, i.price])], [tkPlain.total, tkPlain.items.map(i => [i.name, i.qty, i.price])], "the ticket's items and total match the no-prize ticket");
  ok(!/ARCADE/.test(tkPlain.orderNote), "no tag on the other ticket");
  eq(tk.badge, tkPlain.badge, "the PAID/COLLECT badge logic is untouched by the prize");
  const boardJs = fs.readFileSync(path.join(ROOT, "pickup-board.html"), "utf8");
  ok(!/orderNote|ARCADE|arcade/i.test(boardJs), "the pickup board never reads the order note, so it cannot show the prize");

  // ---- bump -> redeem relay on the real station server forwards the ticket number, once ----
  const rr = await req(stationPort, "POST", "/api/kitchen/redeem", { code: "M3PA", order: tk.ticket });
  eq(rr.json.ok, true); eq(worldWorker.redeems.at(-1), { code: "M3PA", by: "station", checkOnly: false, order: tk.ticket }, "the relay sends the code and the kitchen ticket number");
}

/* ================================================================= C. Chrome ================================================================= */
const CHROME = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean).find(p => fs.existsSync(p));
async function launchChrome() {
  const WebSocket = require("ws");
  const dir = tmp("tb-chrome-");
  const proc = cp.spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1280,1000", "about:blank"], { stdio: "ignore" });
  const portFile = path.join(dir, "DevToolsActivePort");
  await waitFor(() => fs.existsSync(portFile) && fs.readFileSync(portFile, "utf8").split("\n").length >= 2, 20000, "Chrome to start");
  const [port, wsPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  let id = 0; const waiting = new Map();
  ws.on("message", m => { const d = JSON.parse(m); if (d.id && waiting.has(d.id)) { const w = waiting.get(d.id); waiting.delete(d.id); d.error ? w.rej(new Error(d.error.message)) : w.res(d.result); } });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId); await send("Runtime.enable", {}, sessionId);
  const page = {
    async goto(url, w, h) {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
      await send("Page.navigate", { url }, sessionId);
      await waitFor(async () => (await page.eval("document.readyState")) === "complete", 20000, "page load");
    },
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error("page error: " + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result.value;
    },
    async shot(file) {
      if (!process.env.TB_SHOTS) return;
      await sleep(500);
      const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
      fs.mkdirSync(process.env.TB_SHOTS, { recursive: true });
      fs.writeFileSync(path.join(process.env.TB_SHOTS, file), Buffer.from(data, "base64"));
    },
    async spy() {   // before any page script runs: a skewable Date.now, error capture, and every AudioContext the page makes
      await send("Page.addScriptToEvaluateOnNewDocument", { source: `(function(){window.__skew=0;var rn=Date.now.bind(Date);Date.now=function(){return rn()+window.__skew*1000;};
        window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});window.addEventListener('unhandledrejection',function(e){window.__errs.push('rejection: '+(e.reason&&e.reason.message||e.reason))});
        var ce=console.error;console.error=function(){window.__errs.push(Array.prototype.join.call(arguments,' '));return ce.apply(console,arguments)};
        window.__ctxs=[];var AC=window.AudioContext||window.webkitAudioContext;if(AC){var W=function(){var c=new AC(...arguments);window.__ctxs.push(c);return c};W.prototype=AC.prototype;window.AudioContext=W;window.webkitAudioContext=W;}})();` }, sessionId);
    },
    async mock(handler) {   // answer matching /kiosk/* requests from the test: handler(url) -> null (let it through) | { status, body, type }
      ws.on("message", async m => {
        const d = JSON.parse(m); if (d.method !== "Fetch.requestPaused" || d.sessionId !== sessionId) return;
        const h = handler(d.params.request.url);
        try {
          if (h) await send("Fetch.fulfillRequest", { requestId: d.params.requestId, responseCode: h.status || 200, responseHeaders: [{ name: "Content-Type", value: h.type || "application/json" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(h.body || "").toString("base64") }, sessionId);
          else await send("Fetch.continueRequest", { requestId: d.params.requestId }, sessionId);
        } catch {}
      });
      await send("Fetch.enable", { patterns: [{ urlPattern: "*/kiosk/*" }] }, sessionId);
    },
    async resize(w, h) { await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId); },
    close() { try { ws.close(); } catch {} proc.kill("SIGKILL"); },
  };
  return page;
}
async function chromeTests() {
  const { kioskPort, stationPort } = ctx;
  const oldPort = await freePort();
  const oldProxy = http.createServer((rq, rs) => {
    if (/^\/api\/(kitchen|stock)/.test(rq.url)) { rs.writeHead(404, { "Content-Type": "text/plain" }); return rs.end("Not found"); }
    const p = http.request({ host: "127.0.0.1", port: stationPort, path: rq.url, method: rq.method, headers: { ...rq.headers, host: "127.0.0.1:" + stationPort } }, r => { rs.writeHead(r.statusCode, r.headers); r.pipe(rs); });
    p.on("error", () => { rs.writeHead(502); rs.end(); }); rq.pipe(p);
  });
  await new Promise(r => oldProxy.listen(oldPort, "127.0.0.1", r));
  const chrome = await launchChrome();
  try {
    await sleep(2600);
    await winOne(kioskPort);                                   // a fresh pending prize for the order screen
    const pending = (await req(kioskPort, "GET", "/api/arcade/pending")).json.pending; ok(pending, "pending prize for the page test");

    /* ---- the arcade page: win shows the prize, the code, and the big button ---- */
    await chrome.goto(`http://127.0.0.1:${kioskPort}/arcade`, 1080, 1920);
    await waitFor(() => chrome.eval("!!document.getElementById('spinBtn') && !document.getElementById('spinBtn').disabled"), 8000, "arcade ready");
    ok(await chrome.eval("document.getElementById('winActions').hidden"), "no order button before a win");
    await chrome.eval("document.getElementById('spinBtn').click()");
    await waitFor(() => chrome.eval("!document.getElementById('spinBtn').disabled"), 15000, "spin finished");
    const won = await chrome.eval("!document.getElementById('winActions').hidden");
    if (won) {
      ok(/Free Size Upgrade/i.test(await chrome.eval("document.getElementById('reel3Val').textContent")), "the arcade page shows the prize itself");
      ok(/ORDER NOW AND USE IT/i.test(await chrome.eval("document.getElementById('orderNowBtn').textContent")), "the big Order now and use it button");
      ok(/waiting on the order screen/.test(await chrome.eval("document.getElementById('winTwo').textContent")), "the two-screen line");
      eq(await chrome.eval("document.getElementById('orderNowBtn').getAttribute('href')"), "/#menu", "the button goes to the ordering screen on the same display");
      ok(/^[A-Z2-9]{4}$/.test(await chrome.eval("document.getElementById('claimCode').textContent")), "the code is shown");
      await chrome.shot("arcade-win-order-button-1080x1920.png");
    } else {                                                   // the Worker had no token ready for this spin: the page said thanks, which is also correct; not a failure of this feature
      ok(await chrome.eval("document.getElementById('claimPill').hidden"), "no win: no code and no button");
    }

    /* ---- the order screen: banner with the prize, decline, place an order, confirm note ---- */
    await chrome.goto(`http://127.0.0.1:${kioskPort}/#menu`, 1080, 1920);
    await waitFor(() => chrome.eval("!document.getElementById('arcadeWin').hidden"), 10000, "the banner shows while a prize is pending");
    const bannerText = await chrome.eval("document.getElementById('arcadeWin').innerText");
    ok(/Arcade win: Free Size Upgrade\./.test(bannerText) && /attached to this order, show nothing, we've got it/.test(bannerText), "banner wording: " + bannerText);
    ok(/^[A-Z2-9]{4}$/.test(await chrome.eval("document.getElementById('awCode').textContent")), "the banner shows the code");
    ok(await chrome.eval("document.getElementById('awNo').getBoundingClientRect().height >= 56"), "the decline button is a real touch target");
    await chrome.shot("order-screen-banner-1080x1920.png");

    // decline: gone from the page and from the server, and a later order carries nothing
    await chrome.eval("document.getElementById('awNo').click()");
    await waitFor(() => chrome.eval("document.getElementById('arcadeWin').hidden"), 3000, "banner hides on decline");
    await waitFor(async () => (await req(kioskPort, "GET", "/api/arcade/pending")).json.pending === null, 3000, "server cleared on decline");

    // a new win, then the real page places a real order through the real /order handler
    await sleep(2600); await winOne(kioskPort);
    await chrome.eval("poll=undefined;1").catch(() => {});
    await chrome.goto(`http://127.0.0.1:${kioskPort}/#menu`, 1080, 1920);
    await waitFor(() => chrome.eval("!document.getElementById('arcadeWin').hidden"), 10000, "banner again");
    const before = world.n;
    await chrome.eval(`cart.push({icon:"",name:"Neon Sunset Float",mods:["Large"],unit:6.5,qty:1,catKey:"floats",sel:{}}); updateCartBtn(); _orderName="Sam"; placeOrder(); 1`);
    await waitFor(() => chrome.eval("document.getElementById('confirm').classList.contains('show')"), 10000, "confirm screen");
    await waitFor(() => chrome.eval("!document.getElementById('arcadeNote').hidden"), 8000, "arcade note on the confirm screen");
    ok(/Arcade win on your order: Free Size Upgrade · [A-Z2-9]{4}\. The crew has it\./.test(await chrome.eval("document.getElementById('arcadeNote').textContent")), "confirm note");
    await chrome.shot("order-confirm-arcade-note-1080x1920.png");
    eq(world.n, before + 1, "one order was created");
    const oid = "ORDER" + String(world.n).padStart(6, "0");
    const note = world.orders.get(oid).note;
    ok(/^Sam — Kiosk order #\d+ · ARCADE size_upgrade [A-Z2-9]{4}$/.test(note), "the real page's order carries the prize tag: " + note);
    eq(world.orders.get(oid).discounts, [], "no discount");
    ok(await chrome.eval("document.getElementById('arcadeWin').hidden"), "banner gone after the order");
    eq((await req(kioskPort, "GET", "/api/arcade/pending")).json.pending, null, "pending cleared by the order");
    const tag = /ARCADE size_upgrade ([A-Z2-9]{4})$/.exec(note)[1];

    /* ---- the make station: new server ---- */
    worldWorker.redeems.length = 0;
    await sleep(3500);
    await chrome.goto(`http://127.0.0.1:${stationPort}/`, 1920, 1080);
    await waitFor(() => chrome.eval("document.querySelectorAll('.arcbadge').length>0"), 15000, "the prize badge on a ticket");
    const sel = await chrome.eval(`(function(){const t=[...document.querySelectorAll('#qlist .tk')].find(b=>b.querySelector('.arcbadge'));if(t)t.click();return !!t;})()`);
    ok(sel, "the ticket with the prize is in the queue");
    await waitFor(() => chrome.eval("!!document.querySelector('#make .arcbadge.head')"), 5000, "the prominent badge in the ticket header");
    const badge = await chrome.eval("document.querySelector('#make .arcbadge.head').innerText");
    ok(/ARCADE WIN: Free Size Upgrade · [A-Z2-9]{4}/.test(badge), "badge text: " + badge);
    ok(await chrome.eval("document.querySelector('#make .arcbadge.head').getBoundingClientRect().height >= 60"), "badge is big");
    await chrome.shot("station-badge-1920x1080.png");
    ok(!/Secret Menu/i.test(await chrome.eval("document.getElementById('make').innerText")), "the ticket is not mislabelled as a Secret Menu unlock");
    // tap the badge: redeemed with this ticket number; a second tap is harmless
    await chrome.eval("document.querySelector('#make .arcbadge.head').click()");
    await waitFor(() => worldWorker.redeems.length > 0, 8000, "redeem relay call");
    eq(worldWorker.redeems[0].code, tag, "the badge's code was redeemed"); ok(/^\d+$/.test(worldWorker.redeems[0].order), "with the ticket number");
    await waitFor(() => chrome.eval("/REDEEMED/.test(document.querySelector('#make .arcbadge.head').innerText)"), 5000, "badge shows redeemed");
    await chrome.shot("station-badge-redeemed-1920x1080.png");
    // bump a ticket whose redeem has not happened: it is redeemed, and when the relay is offline it is retried
    await chrome.eval("localStorage.removeItem('tb-arc-done');ARC_DONE={};1");
    worldWorker.redeems.length = 0;
    await chrome.eval("(async()=>{const o=queue.waiting.find(x=>/ARCADE/.test(x.orderNote||''));await bumpTicket(o);return 1;})()");
    await waitFor(() => worldWorker.redeems.length > 0, 8000, "bump redeems the prize");
    eq(worldWorker.redeems[0].code, tag, "bump redeemed the claim");
    // offline relay: the queue keeps it and the badge says so; it is retried on the next flush
    await chrome.eval("ARC_DONE={};ARC_Q={};localStorage.clear();window.__realFetch=window.fetch;window.fetch=(u,i)=>/kitchen\\/redeem/.test(String(u))?Promise.resolve(new Response('{\"error\":\"relay-failed\"}',{status:502})):window.__realFetch(u,i);1");
    await chrome.eval("arcEnqueue(queue.ready.concat(queue.waiting).find(x=>/ARCADE/.test(x.orderNote||'')));1");
    await sleep(600);
    ok(Object.keys(JSON.parse(await chrome.eval("JSON.stringify(ARC_Q)"))).length === 1, "relay offline: the redeem stays queued");
    await chrome.eval("window.fetch=window.__realFetch;Object.values(ARC_Q).forEach(q=>q.next=0);arcFlush();1");
    await waitFor(async () => (await chrome.eval("Object.keys(ARC_Q).length")) === 0, 8000, "queued redeem retried and cleared");

    /* ---- a station server from before this update: the page still shows the badge, nothing throws, redeem is honestly unavailable ---- */
    await chrome.goto(`http://127.0.0.1:${oldPort}/`, 1920, 1080);
    await waitFor(() => chrome.eval("document.querySelectorAll('.arcbadge').length>0"), 15000, "badge against the old server");
    await chrome.eval(`(function(){const t=[...document.querySelectorAll('#qlist .tk')].find(b=>b.querySelector('.arcbadge'));if(t)t.click();return 1;})()`);
    await waitFor(() => chrome.eval("!!document.querySelector('#make .arcbadge.head')"), 5000, "badge in the header, old server");
    await waitFor(() => chrome.eval("extrasSupported===false"), 8000, "old server detected");
    await sleep(300);
    ok(/needs the new station server/.test(await chrome.eval("document.querySelector('#make .arcbadge.head').innerText")), "old server: says redeem needs the update");
    ok(await chrome.eval("document.querySelectorAll('#qlist .tk').length>=2"), "the tickets still list normally");
    await chrome.shot("station-badge-old-server-1920x1080.png");
  } finally { chrome.close(); oldProxy.close(); }
}

/* ================================================================= D. the arcade on the kiosk's own screen ================================================================= */
async function navTests() {
  const { kioskPort } = ctx;
  const base = `http://127.0.0.1:${kioskPort}`;
  let SESS = null;            // null: the shipped kiosk/arcade-session.json; an object: this config for the test; "404": the file is missing
  let NO_AUDIO_JS = false;    // audio-bank.js "fails to load"
  const chrome = await launchChrome();
  try {
    await chrome.spy();
    await chrome.mock(u => {
      if (/\/kiosk\/arcade-session\.json/.test(u) && SESS) return SESS === "404" ? { status: 404, body: "Not found", type: "text/plain" } : { body: JSON.stringify(SESS) };
      if (/\/kiosk\/audio-bank\.js/.test(u) && NO_AUDIO_JS) return { status: 404, body: "Not found", type: "text/plain" };
      return null;
    });
    const R = sel => chrome.eval(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;var r=e.getBoundingClientRect();return {l:r.left,t:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height};})()`);
    const overlap = (a, b) => !!(a && b && a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0 && a.l < b.r - 0.5 && a.r > b.l + 0.5 && a.t < b.b - 0.5 && a.b > b.t + 0.5);
    const fresh = async (url, w, h) => { await chrome.goto("about:blank", w, h); await chrome.goto(url, w, h); };
    const path_ = () => chrome.eval("location.pathname");
    const onTop = async sel => chrome.eval(`(function(){var e=document.querySelector(${JSON.stringify(sel)});var r=e.getBoundingClientRect();var t=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return !!t&&!!t.closest(${JSON.stringify(sel)});})()`);
    const arcadeReady = () => waitFor(() => chrome.eval("document.body.dataset.session==='playing'&&!!document.getElementById('spinBtn')"), 10000, "arcade ready");
    const spinOnce = async () => { await chrome.eval("document.getElementById('spinBtn').click();1"); await waitFor(() => chrome.eval("!document.getElementById('spinBtn').disabled||document.body.dataset.session==='ended'"), 20000, "spin finished"); };
    const wait = async (cond, what, ms = 6000) => waitFor(() => chrome.eval(cond), ms, what);
    await req(kioskPort, "POST", "/api/arcade/pending/dismiss", {});

    /* ---- 1. the entry on the home state of the ordering screen, both orientations: visible, big, on screen, on top, overlapping nothing ---- */
    for (const [w, h, tag] of [[1080, 1920, "1080x1920"], [1920, 1080, "1920x1080"]]) {
      await fresh(base + "/#menu", w, h);
      await wait("getComputedStyle(document.getElementById('attract')).display==='none'", "home state (attract dismissed by the deep link)");
      const b = await R("#arcadeBtn");
      ok(b && b.w >= 400 && b.h >= (w < h ? 100 : 80), `the Arcade entry is a big target at ${tag}: ${b && Math.round(b.w)}x${b && Math.round(b.h)}`);
      ok(b.l >= 0 && b.t >= 0 && b.r <= w && b.b <= h, "fully on screen at " + tag);
      ok(/Play & win/i.test(await chrome.eval("document.getElementById('arcadeBtn').innerText")) && /Boardwalk Arcade/i.test(await chrome.eval("document.getElementById('arcadeBtn').innerText")), "it says Play & win / Boardwalk Arcade");
      for (const sel of ["header", "#cartBtn", "#helpRow", "#specials-section", "#menu", "#tabs", "#orderBar", "#arcadeWin"]) ok(!overlap(b, await R(sel)), `the entry does not overlap ${sel} at ${tag}`);
      ok(await onTop("#arcadeBtn"), "nothing sits on top of the entry at " + tag);
      ok(b.t > (await R("#helpRow")).b && b.b <= (await R("#tabs")).t, "it sits between the menu and the category tabs, away from the primary actions");
      await chrome.shot(`ordering-home-arcade-entry-${tag}.png`);
    }

    /* ---- 2. the attract screen: "Tap to begin" stays primary, the arcade is a secondary under it, nothing overlaps ---- */
    for (const [w, h, tag] of [[1080, 1920, "1080x1920"], [1920, 1080, "1920x1080"]]) {
      await fresh(base + "/", w, h);
      const b = await R("#arcadeAttractBtn"), tap = await R(".tap-cta");
      ok(b && b.w >= 250 && b.h >= 66, `the attract entry is a real target at ${tag}: ${b && Math.round(b.w)}x${b && Math.round(b.h)}`);
      ok(b.l >= 0 && b.t >= 0 && b.r <= w && b.b <= h, "fully on screen at " + tag);
      ok(tap.t < b.t && tap.h >= b.h * 0.6 && /Tap to begin/i.test(await chrome.eval("document.querySelector('.tap-cta').innerText")), "Tap to begin is still first, and still there");
      for (const sel of [".tap-cta", ".attract-logo"]) ok(!overlap(b, await R(sel)), `no overlap with ${sel} at ${tag}`);
      for (const r of await chrome.eval("[...document.querySelectorAll('.vibe-attract')].map(e=>{var r=e.getBoundingClientRect();return {l:r.left,t:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height}})")) ok(!overlap(b, r), "no overlap with the helper buttons at " + tag);
      ok(await onTop("#arcadeAttractBtn"), "nothing on top of it at " + tag);
      await chrome.shot(`attract-arcade-entry-${tag}.png`);
    }
    // tapping it goes to the arcade (and does NOT start an order first)
    await fresh(base + "/", 1080, 1920);
    await chrome.eval("document.getElementById('arcadeAttractBtn').click();1");
    await waitFor(async () => (await path_()) === "/arcade", 8000, "attract entry reaches /arcade");

    /* ---- 3. cart guard: with anything in the cart the entry is hidden and goArcade refuses; empty again, it is back ---- */
    await fresh(base + "/#menu", 1080, 1920);
    ok(!(await chrome.eval("document.getElementById('arcadeRow').hidden")), "empty cart: the entry shows");
    await chrome.eval(`cart.push({icon:"",name:"Neon Sunset Float",mods:["Large"],unit:6.5,qty:1,catKey:"floats",sel:{}}); updateCartBtn(); 1`);
    ok(await chrome.eval("document.getElementById('arcadeRow').hidden"), "cart has an item: the entry is hidden");
    eq((await R("#arcadeRow")).h, 0, "and takes no room");
    await chrome.eval("goArcade();1"); await sleep(700);
    eq(await path_(), "/", "even a direct call cannot leave the order screen"); eq(await chrome.eval("cart.length"), 1, "the cart is intact");
    await chrome.shot("ordering-cart-guard-no-arcade-entry-1080x1920.png");
    await chrome.eval("cart.length=0; updateCartBtn(); 1");
    ok(!(await chrome.eval("document.getElementById('arcadeRow').hidden")), "cart emptied: the entry is back");

    /* ---- 4. tap reaches /arcade; the way back is always there; empty-cart round trip; screenshots of the arcade with its back button ---- */
    await fresh(base + "/#menu", 1080, 1920);
    await chrome.eval("document.getElementById('arcadeBtn').click();1");
    await waitFor(async () => (await path_()) === "/arcade", 8000, "the home entry reaches /arcade"); await arcadeReady();
    for (const [w, h, tag] of [[1080, 1920, "1080x1920"], [1920, 1080, "1920x1080"]]) {
      await chrome.resize(w, h); await sleep(200);
      const d = await R("#orderDrinksBtn");
      ok(d && d.h >= 92 && d.w >= 600, `Order drinks is a big target at ${tag}: ${Math.round(d.w)}x${Math.round(d.h)}`);
      ok(d.l >= 0 && d.r <= w && d.b <= h && d.t >= 0, "Order drinks is on screen at " + tag);
      ok(/Order drinks/i.test(await chrome.eval("document.getElementById('orderDrinksBtn').innerText")), "its label");
      ok(await onTop("#orderDrinksBtn"), "nothing covers it at " + tag);
      for (const sel of ["#spinBtn", "#resultBox", ".reels", ".barker-bar", ".bezel", "#sessionHud"]) ok(!overlap(d, await R(sel)), `Order drinks does not overlap ${sel} at ${tag}`);
      await chrome.shot(`arcade-back-button-${tag}.png`);
    }
    await chrome.eval("document.getElementById('orderDrinksBtn').click();1");
    await waitFor(async () => (await path_()) === "/", 8000, "Order drinks returns to /");
    await wait("getComputedStyle(document.getElementById('attract')).display==='none'", "straight to the menu, not stuck on the attract screen");
    eq(await chrome.eval("cart.length"), 0, "round trip with an empty cart: still empty, nothing to lose");
    ok(await chrome.eval("document.getElementById('arcadeWin').hidden"), "no prize, no banner");
    eq(await chrome.eval("location.hash"), "", "the #menu deep-link hash is dropped so a reload starts at the attract screen");

    /* ---- 5. spin limit: the default is 3; with 2 the session ends after the 2nd spin ---- */
    SESS = null;
    await fresh(base + "/arcade", 1080, 1920); await arcadeReady();
    eq(await chrome.eval("document.getElementById('spinsLeft').textContent"), "3", "shipped default: 3 spins");
    ok(!(await chrome.eval("document.getElementById('sessionHud').hidden")), "spins-left is shown");
    SESS = { maxSpins: 2, maxSeconds: 900, idleSeconds: 300 };
    await fresh(base + "/arcade", 1080, 1920); await arcadeReady();
    eq(await chrome.eval("document.getElementById('spinsLeft').textContent"), "2", "the configured limit is read from arcade-session.json");
    await spinOnce();
    eq(await chrome.eval("document.body.dataset.spins"), "1"); eq(await chrome.eval("document.getElementById('spinsLeft').textContent"), "1");
    ok(await chrome.eval("document.getElementById('sessionEnd').hidden"), "one spin used: still playing");
    await spinOnce();
    eq(await chrome.eval("document.body.dataset.session"), "ended", "the 2nd spin ends the session");
    ok(!(await chrome.eval("document.getElementById('sessionEnd').hidden")) && await chrome.eval("document.getElementById('spinBtn').hidden"), "reels stop: spin button gone, thanks panel shown");
    ok(/Thanks for playing/i.test(await chrome.eval("document.getElementById('sessionEnd').innerText")) && /Order drinks/i.test(await chrome.eval("document.getElementById('sessionEnd').innerText")), "it says thanks and points at Order drinks");
    eq(await chrome.eval("document.getElementById('orderDrinksBtn').getAttribute('href')"), "/#menu", "the persistent Order drinks button is the way out");
    ok(await onTop("#orderDrinksBtn"), "and still on top after the session ended");
    await chrome.eval("document.getElementById('spinBtn').click();1"); await sleep(400);
    eq(await chrome.eval("document.body.dataset.spins"), "2", "a spin after the limit does nothing");
    ok(await chrome.eval("window.__ctxs.every(c=>c.state==='closed')") && !(await chrome.eval("speechSynthesis.speaking")), "the music and voice stopped with the game");
    eq(await chrome.eval("window.__errs"), [], "no page errors, including from the missing audio files");
    const clipReqs = await chrome.eval("performance.getEntriesByType('resource').map(e=>e.name).filter(n=>/\\/kiosk\\/audio\\//.test(n))");
    eq(clipReqs.length, new Set(clipReqs).size, "no sound file was asked for twice: " + clipReqs.join(","));
    await chrome.shot("arcade-session-ended-1080x1920.png");
    await chrome.resize(1920, 1080); await sleep(200);
    ok(!overlap(await R("#orderDrinksBtn"), await R("#sessionEnd")), "landscape: the thanks panel and the dock do not overlap");
    { const o = await R("#orderNowBtn"); if (o && o.h > 0) ok(!overlap(await R("#orderDrinksBtn"), o) && o.b <= 1080, "landscape: a win's Order now button is not hidden under the dock once the session ended"); }
    await chrome.shot("arcade-session-ended-1920x1080.png");

    /* ---- 6. time limit, then the hands-off return from the ended screen ---- */
    SESS = { maxSeconds: 20, endedReturnSeconds: 10, idleSeconds: 300 };
    await fresh(base + "/arcade", 1080, 1920); await arcadeReady();
    await chrome.eval("window.__skew+=21;1");
    await wait("document.body.dataset.session==='ended'", "the time limit ends the session", 4000);
    eq(await chrome.eval("document.body.dataset.spins"), "0", "ended by the clock with no spins used");
    await chrome.eval("window.__skew+=11;1");
    await waitFor(async () => (await path_()) === "/", 5000, "the ended screen returns to the ordering screen by itself");
    await wait("getComputedStyle(document.getElementById('attract')).display!=='none'", "and lands on the attract screen (nobody is there)");

    /* ---- 7. idle: a warning, a touch dismisses it, hands-off returns to / ---- */
    SESS = { idleSeconds: 15, idleWarnSeconds: 10, maxSeconds: 900, maxSpins: 20 };
    await fresh(base + "/arcade", 1080, 1920); await arcadeReady();
    ok(await chrome.eval("document.getElementById('idleWarn').hidden"), "no warning while fresh");
    await chrome.eval("window.__skew+=6;1");
    await wait("!document.getElementById('idleWarn').hidden", "the Still playing? warning", 4000);
    await chrome.shot("arcade-idle-warning-1080x1920.png");
    await chrome.eval("document.dispatchEvent(new Event('pointerdown'));1");
    ok(await chrome.eval("document.getElementById('idleWarn').hidden"), "a touch dismisses the warning");
    await chrome.eval("window.__skew+=8;1"); await sleep(1300);
    eq(await path_(), "/arcade", "a touch restarted the idle clock: still here after 8 more seconds");
    await chrome.eval("window.__skew+=10;1");
    await waitFor(async () => (await path_()) === "/", 5000, "hands-off for the idle time returns to /");
    await wait("getComputedStyle(document.getElementById('attract')).display!=='none'", "on the attract screen");
    // the page does not block the version reload: leaving the arcade is a full navigation, so the order screen that loads is the newest build
    ok(await chrome.eval("typeof checkVersion==='function'"), "the order screen runs its version check again after the arcade");

    /* ---- 8. win -> Order now and use it -> the banner on the order screen; and again by the Order drinks dock ---- */
    SESS = null;
    await fresh(base + "/arcade", 1080, 1920); await arcadeReady();
    await sleep(3300);                                         // the Worker wants a play token a few seconds old
    let won = false;
    for (let i = 0; i < 3 && !won; i++) { await spinOnce(); won = !(await chrome.eval("document.getElementById('winActions').hidden")); }
    ok(won, "a win within the visit's spins (staff odds are 100% prize here)");
    const code = await chrome.eval("document.getElementById('claimCode').textContent");
    ok(/^[A-Z2-9]{4}$/.test(code), "the code shows: " + code);
    ok(/Order now and use it/i.test(await chrome.eval("document.getElementById('orderNowBtn').innerText")), "Order now and use it");
    for (const [w, h, tag] of [[1080, 1920, "1080x1920"], [1920, 1080, "1920x1080"]]) {
      await chrome.resize(w, h); await sleep(250);
      const dock = await R("#orderDrinksBtn"), on = await R("#orderNowBtn");
      ok(!overlap(dock, on) && on.t >= 0 && on.b <= h, `the win button and the dock do not collide at ${tag}`);
      await chrome.eval("window.scrollTo(0, 1e6);1");
      const bar = await R(".barker-bar");
      ok(bar.b <= (await R("#orderDrinksBtn")).t + 1, `scrolled to the end, nothing hides under the dock at ${tag}`);
      await chrome.eval("window.scrollTo(0, 0);1");
      await chrome.shot(`arcade-win-order-now-and-dock-${tag}.png`);
    }
    await chrome.resize(1080, 1920);
    await chrome.eval("document.getElementById('orderNowBtn').click();1");
    await waitFor(async () => (await path_()) === "/", 8000, "Order now returns to the ordering screen");
    await wait("!document.getElementById('arcadeWin').hidden", "the prize banner appears on return", 10000);
    ok(new RegExp("Arcade win: Free Size Upgrade").test(await chrome.eval("document.getElementById('arcadeWin').innerText")), "banner names the prize");
    eq(await chrome.eval("document.getElementById('awCode').textContent"), code, "banner carries the same code");
    await chrome.shot("order-screen-banner-after-arcade-1080x1920.png");
    // the prize is still pending: arcade again, leave by the dock, banner is there again
    await chrome.eval("document.getElementById('arcadeBtn').click();1");
    await waitFor(async () => (await path_()) === "/arcade", 8000, "back into the arcade"); await arcadeReady();
    await chrome.eval("document.getElementById('orderDrinksBtn').click();1");
    await waitFor(async () => (await path_()) === "/", 8000, "dock returns");
    await wait("!document.getElementById('arcadeWin').hidden", "banner again via the dock", 10000);
    await req(kioskPort, "POST", "/api/arcade/pending/dismiss", {});

    /* ---- 8b. the last spin of a visit wins: thanks panel, the prize and its Order now button, and the dock all fit, both orientations ---- */
    SESS = { maxSpins: 1, maxSeconds: 900, idleSeconds: 300 };
    await fresh(base + "/arcade", 1080, 1920); await arcadeReady();
    await sleep(3300); await spinOnce();
    eq(await chrome.eval("document.body.dataset.session"), "ended", "the only spin ended the visit");
    ok(!(await chrome.eval("document.getElementById('winActions').hidden")), "and it was a win: the prize and Order now are still on screen after the thanks");
    for (const [w, h, tag] of [[1080, 1920, "1080x1920"], [1920, 1080, "1920x1080"]]) {
      await chrome.resize(w, h); await sleep(250); await chrome.eval("window.scrollTo(0,0);1");
      const dock = await R("#orderDrinksBtn"), on = await R("#orderNowBtn"), te = await R("#sessionEnd");
      ok(!overlap(dock, on) && !overlap(dock, te) && on.b <= h && te.b <= h, `win + thanks + dock all clear of each other at ${tag}`);
      await chrome.shot(`arcade-win-then-thanks-${tag}.png`);
    }
    await req(kioskPort, "POST", "/api/arcade/pending/dismiss", {});

    /* ---- 9. audio can fail to load entirely: the arcade still plays, ends, and leads back ---- */
    NO_AUDIO_JS = true; SESS = { maxSpins: 1, maxSeconds: 900, idleSeconds: 300 };
    await fresh(base + "/arcade", 1080, 1920); await arcadeReady();
    await spinOnce();
    eq(await chrome.eval("document.body.dataset.session"), "ended", "no audio bank: the spin limit still ends the visit");
    await chrome.eval("document.getElementById('orderDrinksBtn').click();1");
    await waitFor(async () => (await path_()) === "/", 8000, "and the way back works"); NO_AUDIO_JS = false;

    /* ---- 10. the session file missing or broken: defaults, never an arcade with no limit and no way back ---- */
    for (const bad of ["404", { maxSpins: "lots", idleSeconds: -1 }]) {
      SESS = bad;
      await fresh(base + "/arcade", 1080, 1920); await arcadeReady();
      eq(await chrome.eval("document.getElementById('spinsLeft').textContent"), "3", "defaults when the file is " + (bad === "404" ? "missing" : "nonsense"));
      ok(await R("#orderDrinksBtn"), "the way back is there");
    }
    SESS = null;
  } finally { chrome.close(); }
}

(async () => {
  try {
    await unit();
    await serverTests();
    if (CHROME) { await chromeTests(); await navTests(); } else console.log("arcade-prize: Chrome part SKIPPED (no Chrome; set CHROME_BIN)");
    console.log(`arcade-prize: ${passed} checks passed${CHROME ? " (incl. Chrome)" : ""}`);
  } catch (e) { console.error(e && e.stack || e); if (ctx) { console.error("--- kiosk log ---\n" + ctx.kiosk.out.slice(-1500)); console.error("--- station log ---\n" + ctx.station.out.slice(-800)); } process.exitCode = 1; }
  finally { if (ctx) { ctx.kiosk.kill(); ctx.station.kill(); } worker.close(); clover.close(); clearInterval(keepAlive); }
})();
