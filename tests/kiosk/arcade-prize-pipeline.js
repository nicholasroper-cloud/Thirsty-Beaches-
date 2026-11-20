// tests/kiosk/arcade-prize-pipeline.js — a finished GAME (or a slot spin) becomes a prize through ONE server path, and the prize can be used on a LATER order.
// Real kiosk-server.js + real arcade-routes.js against a FAKE tb-where Worker, a FAKE station Worker (prize-to-phone link) and a FAKE Clover. No Chrome needed.
//   game:    start -> finish -> server roll -> Worker code -> pending prize -> attach -> " · ARCADE <prizeId> <CODE>" on the order note -> make-station ARC_RE reads it
//   refused: finish with no session / unknown session / too soon / second finish for the same game / visit cap / Worker offline / page-supplied prize, code or score
//   later:   save a win to a phone number, look it up on another order, attach, link deleted; wrong / expired / used / second code on one order / rate limit; code pad
//   privacy: the full phone number is never in a log, an order note, a Clover body or a response; `useOnSameVisit:false` makes no pending prize and no banner
// Run: node tests/kiosk/arcade-prize-pipeline.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const cp = require("child_process");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "../..");
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const KIOSK_KEY = "k".repeat(30), STAFF = "staff-secret-key-1234";
const PHONE = "8015550142", PHONE2 = "4355550177";
const arc = require(path.join(ROOT, "arcade-routes.js"));

function request(port, method, p, obj, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = obj === undefined ? null : JSON.stringify(obj);
    const h = { Host: `127.0.0.1:${port}`, ...headers };
    if (method !== "GET") Object.assign(h, { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, ...headers });
    if (data !== null) h["Content-Length"] = Buffer.byteLength(data);
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: h }, res => {
      let b = ""; res.on("data", c => b += c);
      res.on("end", () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, headers: res.headers, body: b, json }); });
    });
    r.on("error", reject); if (data !== null) r.write(data); r.end();
  });
}

/* ---------------- unit: settings, phone shape ---------------- */
{
  const d = arc.SESSION_DEFAULTS;
  eq(arc.sessionSettings(null), { maxPrizeRolls: d.maxPrizeRolls, useOnSameVisit: true, gameMinSeconds: d.gameMinSeconds, visitGapSeconds: d.visitGapSeconds }, "no file: defaults");
  const bad = arc.sessionSettings({ maxPrizeRolls: 0, gameMinSeconds: -5, visitGapSeconds: "x", useOnSameVisit: "no" });
  eq(bad, arc.sessionSettings(null), "bad values fall back to the defaults, never to no limit, and only a literal false turns useOnSameVisit off");
  eq(arc.sessionSettings({ maxPrizeRolls: 999 }).maxPrizeRolls, d.maxPrizeRolls, "an absurd cap is not honoured");
  eq(arc.sessionSettings({ useOnSameVisit: false }).useOnSameVisit, false, "the switch works");
  eq(arc.normPhone("(801) 555-0142"), "8015550142", "formatted number"); eq(arc.normPhone("1-801-555-0142"), "8015550142", "leading 1 dropped");
  for (const b of ["", "555", "0015550142", "8010550142", "80155501420", null, "abc"]) eq(arc.normPhone(b), "", "rejected: " + b);
}

/* ---------------- fakes ---------------- */
const claimLog = [], stationLog = [], cloverPosts = [], workerChecks = [];
let minted = 0, workerDown = false, stationOff = false, soldOut = false;
const tokens = new Map(), usedTok = new Set();
const claims = new Map();          // code -> { prizeId, expiresAt, used }
const links = new Map();           // phone -> code
const orders = new Map();          // id -> note
let wState = "";                   // what the fake Worker answers to a check-only on a given code
const worker = http.createServer((rq, rs) => {
  let b = ""; rq.on("data", c => b += c); rq.on("end", () => {
    const j = (s, o) => { rs.writeHead(s, { "Content-Type": "application/json" }); rs.end(JSON.stringify(o)); };
    if (workerDown) { rs.destroy(); return; }
    const body = (() => { try { return JSON.parse(b || "{}"); } catch { return {}; } })();
    if (rq.method === "GET" && rq.url === "/scores/token") { const tk = "tk" + tokens.size; tokens.set(tk, Date.now()); return j(200, { token: tk, minMs: 100 }); }
    if (rq.method === "POST" && rq.url === "/kitchen/claim") {
      claimLog.push({ key: rq.headers["x-kiosk-key"], body });
      if (rq.headers["x-kiosk-key"] !== KIOSK_KEY) return j(429, { error: "daily-limit" });
      const at = tokens.get(body.token); if (at === undefined || Date.now() - at < 100) return j(403, { error: "no-token" });
      if (usedTok.has(body.token)) return j(409, { error: "token-used" });
      if (soldOut) return j(429, { error: "sold-out" });
      usedTok.add(body.token); minted++;
      const code = "W" + "ABCDEFGHJKMN"[minted % 12] + "Q" + (minted % 8 + 2);
      claims.set(code, { prizeId: body.prize && body.prize.id, expiresAt: Date.now() + 24 * 3600e3, used: false });
      return j(200, { ok: true, code, ticket: { reward: "Secret Menu Unlock", drinkName: "x", build: "x", expiresAt: claims.get(code).expiresAt } });
    }
    if (rq.method === "POST" && rq.url === "/kitchen/claims/redeem") {
      workerChecks.push({ key: rq.headers["x-kiosk-key"], body });
      const c = claims.get(body.code);
      if (!c) return j(404, { ok: false, status: "unknown" });
      if (c.used) return j(200, { ok: false, status: "used" });
      return j(200, { ok: true, status: "valid", ticket: { prize: c.prizeId ? { id: c.prizeId, label: "x" } : null, expiresAt: c.expiresAt } });
    }
    j(404, {});
  });
});
const station = http.createServer((rq, rs) => {
  let b = ""; rq.on("data", c => b += c); rq.on("end", () => {
    const j = (s, o) => { rs.writeHead(s, { "Content-Type": "application/json" }); rs.end(JSON.stringify(o)); };
    const body = (() => { try { return JSON.parse(b || "{}"); } catch { return {}; } })();
    stationLog.push({ url: rq.url, key: rq.headers["x-key"], body });
    if (rq.headers["x-key"] !== STAFF) return j(401, { error: "unauthorized" });
    if (stationOff) return j(503, { ok: false, error: "prize-link-off" });
    if (rq.url === "/api/prize-link/save") {
      if (links.has(body.phone)) return j(409, { ok: false, error: "already-have" });
      links.set(body.phone, body.code); return j(200, { ok: true, keptUntil: (claims.get(body.code) || {}).expiresAt });
    }
    if (rq.url === "/api/prize-link/lookup") {
      const code = links.get(body.phone), c = code && claims.get(code);
      if (!c || c.used || c.expiresAt < Date.now()) return j(200, { ok: true, found: false });
      return j(200, { ok: true, found: true, code, prizeId: c.prizeId, label: "from the Worker, must not be shown", expiresAt: c.expiresAt });
    }
    if (rq.url === "/api/prize-link/clear") { for (const [p, c] of links) if (c === body.code) links.delete(p); return j(200, { ok: true }); }
    j(404, {});
  });
});
const clover = http.createServer((rq, rs) => {
  let b = ""; rq.on("data", c => b += c); rq.on("end", () => {
    const j = (s, o) => { rs.writeHead(s, { "Content-Type": "application/json" }); rs.end(JSON.stringify(o)); };
    const m = /\/orders\/([A-Za-z0-9]+)(?:\?|$)/.exec(rq.url);
    if (m && rq.method === "GET") return orders.has(m[1]) ? j(200, { id: m[1], note: orders.get(m[1]), createdTime: Date.now() }) : j(404, {});
    if (m && rq.method === "POST") { cloverPosts.push(b); const n = JSON.parse(b || "{}").note; if (typeof n === "string") orders.set(m[1], n); return j(200, { id: m[1] }); }
    j(200, { elements: [] });
  });
});

(async () => {
  const keepAlive = setInterval(() => {}, 1000);
  const [workerPort, stationPort, cloverPort, port] = [await freePort(), await freePort(), await freePort(), await freePort()];
  await new Promise(r => worker.listen(workerPort, "127.0.0.1", r));
  await new Promise(r => station.listen(stationPort, "127.0.0.1", r));
  await new Promise(r => clover.listen(cloverPort, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-pipe-"));
  for (const f of ["kiosk-server.js", "kiosk-lib.js", "flex-pay.js", "pay-journal.js", "pay-routes.js", "catalog.js", "quote.js", "moderation.js", "arcade-routes.js", "addons.json", "drink-kiosk.html", "drink-kiosk-light.html"]) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "catalog-map.json"), JSON.stringify({ version: 1, floats: [], categories: {} }));
  fs.cpSync(path.join(ROOT, "kiosk"), path.join(dir, "kiosk"), { recursive: true });
  const sessFile = path.join(dir, "kiosk", "arcade-session.json");
  const setSession = o => fs.writeFileSync(sessFile, JSON.stringify({ enabled: true, ...o }));
  setSession({ maxPrizeRolls: 20, useOnSameVisit: true, gameMinSeconds: 5, visitGapSeconds: 120 });
  const child = cp.spawn(process.execPath, ["kiosk-server.js"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH, CLOVER_API_TOKEN: "t", CLOVER_MERCHANT_ID: "M", CLOVER_BASE_URL: "http://127.0.0.1:" + cloverPort, PORT: String(port), KIOSK_HEARTBEAT_URL: "off",
    PRIZE_API: "http://127.0.0.1:" + workerPort, STATION_API: "http://127.0.0.1:" + stationPort, KIOSK_KEY, STATION_KEY: STAFF, PRIZE_LOOKUPS_PER_10MIN: "20", TB_CATALOG_MS: "60000" } });
  let out = ""; child.stdout.on("data", d => out += d); child.stderr.on("data", d => out += d);
  const cleanup = () => { try { child.kill(); } catch {} worker.close(); station.close(); clover.close(); clearInterval(keepAlive); };
  try {
    for (let i = 0; i < 80; i++) { try { if ((await request(port, "GET", "/health")).status) break; } catch {} await sleep(100); }
    const P = (p, o) => request(port, "POST", p, o === undefined ? {} : o);
    // staff odds: every roll is a prize (standard 0; the jackpot stays at its 2% ceiling)
    const allWin = arc.PRIZES.map(p => ({ id: p.id, pct: p.id === "standard" ? 0 : p.id === "size_upgrade" ? 89 : p.id === "free_drink_jackpot" ? 2 : p.id === "soft_serve_topper" ? 4 : p.id === "neon_charm" ? 3 : 2 }));
    eq(allWin.reduce((s, o) => s + o.pct, 0), 100, "odds sum");
    eq((await request(port, "POST", "/api/arcade-config", { odds: allWin }, { "X-Key": STAFF })).status, 200, "staff odds saved");

    // ---- pages: only the five ids are ever served; nothing else under /arcade/games is reachable ----
    for (const bad of ["/arcade/games/evil", "/arcade/games/..%2f..%2fkiosk-server.js", "/arcade/games/%2e%2e/kiosk-server.js", "/arcade/games/thirsty-blaster%00", "/arcade/games/CUP-CATCH", "/arcade/games/cup-catch/../x"]) {
      const r = await request(port, "GET", bad); ok(r.status === 404 || r.status === 403 || r.status === 400, bad + " -> " + r.status);
      ok(!/kiosk-lib|createServer/.test(r.body), bad + " leaked nothing");
    }
    for (const id of arc.GAME_IDS) { const r = await request(port, "GET", "/arcade/games/" + id); ok(r.status === 200 || r.status === 404, id + " " + r.status); if (r.status === 200) ok(/default-src 'none'/.test(String(r.headers["content-security-policy"])) && !/https?:\/\/(?!127)/.test(String(r.headers["content-security-policy"])), "games CSP allows no external host"); }
    ok((await request(port, "GET", "/kiosk/..%2fkiosk-server.js")).status !== 200, "static traversal still refused");
    ok((await request(port, "GET", "/kiosk/arcade-session.json")).status === 200, "session file is served (the page reads it)");
    ok([400, 403, 404].includes((await request(port, "GET", "/kiosk/boardwalk-slots.js%00.png")).status), "NUL refused");

    // ---- the page can only say 'a game finished' ----
    eq((await P("/api/arcade/game/start", { game: "not-a-game" })).status, 400, "unknown game refused");
    eq((await P("/api/arcade/game/start", {})).status, 400, "no game refused");
    eq((await P("/api/arcade/game/finish", {})).status, 404, "forged finish with no session");
    eq((await P("/api/arcade/game/finish", { sid: "a".repeat(24) })).status, 404, "forged finish with an invented session id");
    eq((await P("/api/arcade/game/finish", { sid: { $ne: 1 } })).status, 404, "an object as the session id");
    eq(claimLog.length, 0, "no forged finish reached the Worker");

    // session s1: finish too soon is plain thanks and consumes it
    const s1 = (await P("/api/arcade/game/start", { game: "cup-catch", prizeId: "free_drink_jackpot", code: "AAAA", score: 99999 })).json;
    ok(s1.ok && /^[a-f0-9]{24}$/.test(s1.sid), "session opened by the server"); eq(s1.minPlayMs, 5000, "minimum play time comes from arcade-session.json");
    const early = await P("/api/arcade/game/finish", { sid: s1.sid, prizeId: "free_drink_jackpot", code: "AAAA", score: 99999 });
    eq(early.json, { ok: true, win: false, thanks: true }, "finish too soon: plain thanks, no code, no hint");
    eq((await P("/api/arcade/game/finish", { sid: s1.sid })).status, 409, "a second finish for the same game is refused");
    eq(claimLog.length, 0, "finish too soon never reached the Worker");

    // session s2: waits the minimum on the server clock, then ONE roll at the staff odds
    const s2 = (await P("/api/arcade/game/start", { game: "thirsty-blaster" })).json;
    await sleep(5400);
    const win = (await P("/api/arcade/game/finish", { sid: s2.sid, prizeId: "free_drink_jackpot", label: "FREE", code: "ZZZZ", score: 20000, win: true })).json;
    ok(win.win === true && /^[A-Z2-9]{4}$/.test(win.code) && claims.has(win.code), "a real Worker code: " + JSON.stringify(win));
    ok(win.code !== "ZZZZ" && arc.PRIZE_IDS.includes(win.prizeId) && win.prizeId !== "standard", "prize id from the server table, not the page");
    eq(claimLog.length, 1, "exactly one claim for one finished game");
    ok(claimLog[0].key === KIOSK_KEY, "claim carries the kiosk key from the server");
    ok(claimLog[0].body.score === 600 || claimLog[0].body.score === 2000, "the Worker score is the server's constant, never the page's: " + claimLog[0].body.score);
    eq(claimLog[0].body.prize.id, win.prizeId, "the prize the Worker was asked to mint is the one the server rolled");
    ok(win.orderNow === true && win.pendingUntil > Date.now() && win.pendingUntil <= Date.now() + 15 * 60e3 + 1000, "win rides this visit's order for at most 15 minutes");
    ok(win.expiresAt > Date.now() + 23 * 3600e3, "the response carries the real expiry the Worker gave: " + win.expiresAt); eq(win.saveable, true, "phone save is offered");
    eq((await P("/api/arcade/game/finish", { sid: s2.sid })).status, 409, "one roll per game played: the same session cannot roll twice");
    eq(claimLog.length, 1, "no second claim");

    // pending -> attach -> note tag -> make-station reads it
    const pend = (await request(port, "GET", "/api/arcade/pending")).json.pending;
    ok(pend && pend.code === win.code && pend.prizeId === win.prizeId, "the win is the kiosk's ONE pending prize");
    orders.set("ORDER0000001", "Kiosk order #41 — Thirsty Beaches");
    const att = (await P("/api/arcade/pending/attach", { orderId: "ORDER0000001", code: "ZZZZ", prizeId: "free_drink_jackpot" })).json;
    ok(att.ok === true && att.code === win.code, "attached the server's own pending prize, ignoring anything the page added");
    const expectNote = `Kiosk order #41 — Thirsty Beaches · ARCADE ${win.prizeId} ${win.code}`;
    eq(orders.get("ORDER0000001"), expectNote, "the Clover note carries exactly the tag, nothing else about the order changed");
    eq(cloverPosts.length, 1, "one Clover write, the note"); ok(Object.keys(JSON.parse(cloverPosts[0])).join() === "note", "only {note} was written (no price, discount or line)");
    const station_html = fs.readFileSync(path.join(ROOT, "make-station.html"), "utf8");
    const arcRe = new RegExp(/const ARC_RE=\/(.*)\/;/.exec(station_html)[1]);
    const m = arcRe.exec(orders.get("ORDER0000001")); ok(m && m[1] === win.prizeId && m[2] === win.code, "make-station ARC_RE reads the tag a game win produced, same as a slot win");
    eq((await request(port, "GET", "/api/arcade/pending")).json.pending, null, "pending cleared by the attach");
    await sleep(200);
    ok(stationLog.some(s => s.url === "/api/prize-link/clear" && s.body.code === win.code), "the station was told to drop any phone link for the used code");
    eq((await P("/api/arcade/pending/attach", { orderId: "ORDER0000001" })).json.already, true, "attach is idempotent for the same order");

    // ---- a slot spin shares the same roll path and the same cap ----
    const spin = (await P("/api/arcade/spin")).json;
    ok(spin.win === true || spin.thanks === true, "spin works"); ok(spin.win ? typeof spin.expiresAt === "number" && "orderNow" in spin && "saveable" in spin : true, "spin win carries expiry/orderNow/saveable");
    if (spin.win) await P("/api/arcade/pending/dismiss");

    // ---- phone number: save, look up on a later order, attach, delete ----
    const s3 = (await P("/api/arcade/game/start", { game: "boardwalk-dash" })).json; await sleep(5300);
    const w3 = (await P("/api/arcade/game/finish", { sid: s3.sid })).json; ok(w3.win === true, "a second win: " + JSON.stringify(w3));
    await P("/api/arcade/pending/dismiss");                                   // the customer walked off; the code lives on
    eq((await P("/api/arcade/wallet/save", { phone: "555", code: w3.code })).json.error, "bad-phone", "bad number refused before anything is sent");
    eq((await P("/api/arcade/wallet/save", { phone: PHONE, code: "ABCD" })).json.error, "unknown-code", "a code this server did not issue cannot be saved");
    eq((await P("/api/arcade/wallet/save", { phone: PHONE, code: win.code })).json.ok, true, "an issued code can be saved (the page names it, the server checks it)");   // win.code was attached already but is still a code this server issued
    links.clear();
    const saved = (await P("/api/arcade/wallet/save", { phone: PHONE, code: w3.code })).json;
    ok(saved.ok === true && saved.saved === true && saved.last2 === "42", "saved; only the last two digits come back: " + JSON.stringify(saved));
    ok(!JSON.stringify(saved).includes(PHONE) && !JSON.stringify(saved).includes("801555"), "no number in the response");
    eq(stationLog.filter(s => s.url === "/api/prize-link/save").pop().key, STAFF, "the station call uses the staff key");
    eq((await P("/api/arcade/wallet/save", { phone: PHONE, code: w3.code })).json.error, "already-have", "one saved prize per number: told plainly, nothing replaced");
    // later order: lookup puts it back as THE pending prize; wrong number finds nothing
    eq((await P("/api/arcade/wallet/lookup", { phone: PHONE2 })).json, { ok: true, found: false }, "wrong number: nothing, no hint");
    eq((await request(port, "GET", "/api/arcade/pending")).json.pending, null, "a miss leaves no pending prize");
    const look = (await P("/api/arcade/wallet/lookup", { phone: PHONE })).json;
    ok(look.ok && look.found === true && look.label === arc.PRIZES.find(p => p.id === w3.prizeId).label && look.expiresAt > Date.now(), "found: label comes from the kiosk's own table, not the Worker's text");
    ok(!JSON.stringify(look).includes("must not be shown"), "the Worker's label text is never passed on");
    const pend3 = (await request(port, "GET", "/api/arcade/pending")).json.pending; ok(pend3 && pend3.code === w3.code, "lookup made it the pending prize (banner + attach path unchanged)");
    orders.set("ORDER0000002", "Kiosk order #42 — Thirsty Beaches");
    ok((await P("/api/arcade/pending/attach", { orderId: "ORDER0000002" })).json.ok, "attached on the later order");
    eq(orders.get("ORDER0000002"), `Kiosk order #42 — Thirsty Beaches · ARCADE ${w3.prizeId} ${w3.code}`, "later order note tag");
    await sleep(250); eq(links.has(PHONE), false, "the phone link was deleted when the prize was used");
    // used: the Worker has burned it (bump) -> lookup finds nothing; and the kiosk itself refuses a code it already attached
    claims.get(w3.code).used = true; links.set(PHONE, w3.code);
    eq((await P("/api/arcade/wallet/lookup", { phone: PHONE })).json, { ok: true, found: false }, "already redeemed: no prize on that number");
    claims.get(w3.code).used = false;
    eq((await P("/api/arcade/wallet/lookup", { phone: PHONE })).json, { ok: true, found: false }, "a code already attached to an order cannot ride a second order while it waits to be bumped");
    // expired
    const s4 = (await P("/api/arcade/game/start", { game: "cup-catch" })).json; await sleep(5300);
    const w4 = (await P("/api/arcade/game/finish", { sid: s4.sid })).json; ok(w4.win, "third win");
    await P("/api/arcade/pending/dismiss"); links.set(PHONE2, w4.code); claims.get(w4.code).expiresAt = Date.now() - 1000;
    eq((await P("/api/arcade/wallet/lookup", { phone: PHONE2 })).json, { ok: true, found: false }, "expired: nothing found");
    eq((await request(port, "GET", "/api/arcade/pending")).json.pending, null, "and no pending prize");

    // ---- the code pad (fallback): valid / wrong / used / not an arcade prize / second code on one order ----
    claims.get(w4.code).expiresAt = Date.now() + 3600e3;
    const c1 = (await P("/api/arcade/code", { code: w4.code.toLowerCase() })).json;
    ok(c1.ok && c1.found && c1.label === arc.PRIZES.find(p => p.id === w4.prizeId).label, "valid code adopted: " + JSON.stringify(c1)); ok(workerChecks.pop().body.checkOnly === true, "check only: nothing is burned at lookup");
    eq((await P("/api/arcade/code", { code: "ABCD" })).json, { ok: true, found: false, status: "unknown" }, "wrong code: plain unknown");
    eq((await P("/api/arcade/code", { code: "ab" })).json.found, false, "malformed code never reaches the Worker");
    claims.set("PLNQ", { prizeId: null, expiresAt: Date.now() + 1e6, used: false });
    eq((await P("/api/arcade/code", { code: "PLNQ" })).json.status, "unknown", "a claim that is not an arcade prize (secret menu) is not accepted here");
    claims.set("USDQ", { prizeId: "size_upgrade", expiresAt: Date.now() + 1e6, used: true });
    eq((await P("/api/arcade/code", { code: "USDQ" })).json.status, "used", "already redeemed: said plainly");
    claims.set("OLDQ", { prizeId: "size_upgrade", expiresAt: Date.now() - 1e3, used: false });
    eq((await P("/api/arcade/code", { code: "OLDQ" })).json.found, false, "expired code refused");
    claims.set("TWOQ", { prizeId: "neon_charm", expiresAt: Date.now() + 1e6, used: false });
    ok((await P("/api/arcade/code", { code: "TWOQ" })).json.found, "second code looked up on the same visit");
    const pendTwo = (await request(port, "GET", "/api/arcade/pending")).json.pending; eq(pendTwo.code, "TWOQ", "ONE pending prize: the newer code replaced the older one (the older stays valid by its code)");
    orders.set("ORDER0000003", "Kiosk order #43 — Thirsty Beaches");
    await P("/api/arcade/pending/attach", { orderId: "ORDER0000003" });
    eq((orders.get("ORDER0000003").match(/ARCADE/g) || []).length, 1, "one prize per order");
    eq((await P("/api/arcade/code", { code: "TWOQ" })).json.status, "used", "and that code cannot be offered again");

    // ---- visit cap shared by slots and games ----
    setSession({ maxPrizeRolls: 2, useOnSameVisit: true, gameMinSeconds: 5, visitGapSeconds: 600 });
    await P("/api/arcade/pending/dismiss");
    // the visit window is long in this test file; start a clean visit by reading settings through a big gap: reuse rolls already counted, so ask what happens at the cap
    const before = claimLog.length;
    const sA = (await P("/api/arcade/game/start", { game: "soft-serve-stacker" })).json; await sleep(5300);
    const capped = (await P("/api/arcade/game/finish", { sid: sA.sid })).json;
    eq(capped, { ok: true, win: false, thanks: true }, "visit cap reached: plain thanks, no roll"); eq(claimLog.length, before, "no Worker call once the visit cap is reached");
    const spinCapped = (await P("/api/arcade/spin")).json; eq([spinCapped.win, spinCapped.thanks, spinCapped.code], [false, false, undefined], "a slot spin past the shared cap is an ordinary reveal, no code");

    // ---- useOnSameVisit:false and a fresh visit: the win is only a code / phone link, no pending prize, no banner ----
    setSession({ maxPrizeRolls: 20, useOnSameVisit: false, gameMinSeconds: 5, visitGapSeconds: 120 });
    const sB = (await P("/api/arcade/game/start", { game: "thirsty-tower" })).json; await sleep(5300);
    const wB = (await P("/api/arcade/game/finish", { sid: sB.sid })).json;
    ok(wB.win === true && wB.orderNow === false && wB.pendingUntil === null, "useOnSameVisit:false: a code, not attached to this visit: " + JSON.stringify(wB));
    eq((await request(port, "GET", "/api/arcade/pending")).json.pending, null, "no pending prize, so no banner");
    ok((await P("/api/arcade/code", { code: wB.code })).json.found, "but the code still works on a later order");
    await P("/api/arcade/pending/dismiss");

    // ---- Worker offline: the game still ends, with thanks and no code ----
    setSession({ maxPrizeRolls: 20, useOnSameVisit: true, gameMinSeconds: 5, visitGapSeconds: 120 });
    const sC = (await P("/api/arcade/game/start", { game: "cup-catch" })).json; await sleep(5300);
    workerDown = true;
    const down = (await P("/api/arcade/game/finish", { sid: sC.sid })).json;
    eq(down, { ok: true, win: false, thanks: true }, "Worker offline: thanks, no code, no error");
    eq((await P("/api/arcade/code", { code: "WAAA" })).json.error, "unavailable", "code pad with the Worker offline says unavailable and does not hang");
    workerDown = false;

    // ---- lookup rate limit (per kiosk) ----
    const respond = [];
    for (let i = 0; i < 12; i++) respond.push((await P("/api/arcade/code", { code: "Q" + "ABCDEFGHJK"[i] + "XX" })).status);
    ok(respond.includes(429), "code/phone lookups are rate limited on this kiosk: " + respond.join(","));
    eq((await P("/api/arcade/wallet/lookup", { phone: PHONE2 })).status, 429, "the same limit covers phone lookups");

    // ---- the station link is off / down: saving says so, the code stays the way ----
    const sD = (await P("/api/arcade/game/start", { game: "cup-catch" })).json; await sleep(5300);
    const wD = (await P("/api/arcade/game/finish", { sid: sD.sid })).json;
    if (wD.win) {
      stationOff = true;
      eq((await P("/api/arcade/wallet/save", { phone: PHONE2, code: wD.code })).json.error, "off", "link feature off at the station: said plainly");
      eq((await P("/api/arcade/wallet/lookup", { phone: PHONE2 })).json.error, "off", "and lookups say off, never found");
      stationOff = false;
    }

    // ---- legal pass: period/version on the odds, plain game results, rules facts, "prizes are done" known before play ----
    const st0 = (await request(port, "GET", "/api/arcade/status")).json; eq([st0.ok, st0.prizes, st0.capped], [true, true, false], "status before the cap: prizes on, not capped");
    const cfg1 = (await request(port, "POST", "/api/arcade-config", { period: "Dec 2026 <b>", odds: allWin }, { "X-Key": STAFF })).json.config;
    eq(cfg1.period, "Dec 2026 b", "period text is cleaned"); ok(cfg1.version >= 2, "a period change is a new odds version: " + cfg1.version);
    eq((await request(port, "POST", "/api/arcade-config", { odds: allWin }, { "X-Key": STAFF })).json.config.version, cfg1.version, "saving the same odds again does not bump the version");
    const sP = (await P("/api/arcade/game/start", { game: "thirsty-tower" })).json; await sleep(5300); const wP = (await P("/api/arcade/game/finish", { sid: sP.sid })).json; await P("/api/arcade/pending/dismiss");
    ok(wP.win === true, "a win under the new period"); ok(/arcade: win \S+ via (game|slot) period=Dec 2026 b odds-v=\d+/.test(out), "the win log line carries the period and odds version"); ok(!new RegExp("arcade: win .*" + win.code).test(out), "and never the code");
    ok(wB.label !== undefined && !/jackpot/i.test(JSON.stringify([win, w3, w4, wB])), "no game result ever carries the word jackpot, a mega flag or a sound trigger"); ok(![win, w3, w4, wB].some(w => "mega" in w || "trigger" in w), "game wins have no mega/trigger fields");
    const rl = (await request(port, "GET", "/api/arcade/rules")).json.rules;
    eq(rl.freeDrinkOneIn, 100 / arc.MAX_FREE_DRINK_PCT, "free-drink ceiling stated is MAX_FREE_DRINK_PCT"); ok(!rl.prizes.map(p => p.label + " " + p.note).join(" ").match(/jackpot/i), "rules prize list shows plain names");
    eq(rl.mostGamesDoNotWin, false, "all-win odds: the page may NOT say most games do not win (computed from the live table)");
    ok(["sponsorName", "sponsorAddress", "promoStart", "promoEnd"].every(k => rl.missing.includes(k)) && rl.sponsorName === "", "unknown sponsor/address/dates are reported as missing, never invented");
    eq(rl.prizeLifeText, "24 hours", "prize life states what the Worker really enforces");
    eq(rl.prizes.find(p => p.id === "size_upgrade").note, "used on a drink you order", "upgrade note");
    soldOut = true; usedTok.clear();
    const sE = (await P("/api/arcade/game/start", { game: "cup-catch" })).json; await sleep(5300);
    eq((await P("/api/arcade/game/finish", { sid: sE.sid })).json, { ok: true, win: false, thanks: true }, "cap hit: thanks");
    eq((await request(port, "GET", "/api/arcade/status")).json.capped, true, "the kiosk now knows the daily cap is used up and can say so before play");
    const callsAtCap = claimLog.length;
    const sF = (await P("/api/arcade/game/start", { game: "cup-catch" })).json; await sleep(5300); await P("/api/arcade/game/finish", { sid: sF.sid });
    eq(claimLog.length, callsAtCap, "once capped the kiosk stops asking the Worker until tomorrow");
    soldOut = false;

    // ---- privacy: no full number anywhere it must not be ----
    for (const secret of [PHONE, PHONE2, "801-555-0142", "(801) 555-0142"]) {
      ok(!out.includes(secret), "no full number in the kiosk server log");
      for (const n of orders.values()) ok(!n.includes(secret), "no number in an order note");
      for (const b of cloverPosts) ok(!b.includes(secret), "no number in any Clover body");
    }
    ok(!out.includes("8015550142") && !/\b\d{10}\b/.test(out.replace(/\d{13}/g, "")), "no 10-digit number in the log at all");
    ok(!/KIOSK_KEY|k{30}/.test(out), "no key in the log");
    eq(child.exitCode, null, "server still running: " + out.slice(-400));
    console.log(`arcade-prize-pipeline: ${passed} checks passed`);
  } catch (e) { console.error("FAILED:", e && e.stack || e); console.error("server log tail:\n" + out.slice(-1500)); cleanup(); process.exit(1); }
  cleanup();
})();
