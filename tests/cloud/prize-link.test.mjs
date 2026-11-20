// node tests/cloud/prize-link.test.mjs — the prize-to-phone link in the station Worker (cloud/src/prize-link.js + its routes in index.js).
// Fake KV (records TTLs) and a fake tb-where that enforces the real claim rules (checkOnly valid / used / unknown, ticket.prize, ticket.expiresAt).
// Privacy checks: the full number and its hash must never appear in a log line, a stored KV key/value or any response.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import worker from "../../cloud/src/index.js";
import { normalizePhone, clearPrizeLinkByCode, LINK_PRIZE_IDS } from "../../cloud/src/prize-link.js";

const KEY = "p".repeat(40), STATION = "k-123456", KIOSK = "kiosk-key-for-tests";
const NUM = "3855550142", NUM2 = "4355550199";
const hash = n => crypto.createHmac("sha256", KEY).update("tb-prize-phone|+1" + n).digest("hex");

const logs = [];
for (const m of ["log", "warn", "error", "info", "debug"]) console[m] = (...a) => logs.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
const out = s => process.stdout.write(s + "\n");

function makeKV() {
  const m = new Map();
  return { _m: m,
    async get(k, type) { const e = m.get(k); if (!e) return null; return type === "json" ? JSON.parse(e.v) : e.v; },
    async put(k, v, o) { m.set(k, { v: String(v), ttl: o && o.expirationTtl }); },
    async delete(k) { m.delete(k); },
    async list() { return { keys: [...m.keys()].map(name => ({ name })), list_complete: true }; } };
}

/* fake tb-where */
const claims = new Map();
let whereDown = false, whereCalls = [];
const mk = (code, o = {}) => claims.set(code, { code, redeemed: false, prize: { id: "size_upgrade", label: "Free Size Upgrade" }, expiresAt: Date.now() + 24 * 3600e3, ...o });
globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  if (u.pathname === "/kitchen/claims/redeem") {
    if (whereDown) throw new Error("offline");
    const b = JSON.parse(init.body); whereCalls.push(b);
    if ((init.headers["x-kiosk-key"] || "") !== KIOSK) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    const rec = claims.get(b.code);
    if (!rec) return new Response(JSON.stringify({ ok: false, status: "unknown" }), { status: 404 });
    if (rec.redeemed) return new Response(JSON.stringify({ ok: false, status: "used", ticket: rec }), { status: 200 });
    if (b.checkOnly === true) return new Response(JSON.stringify({ ok: true, status: "valid", ticket: rec }), { status: 200 });
    rec.redeemed = true; return new Response(JSON.stringify({ ok: true, status: "redeemed", ticket: rec }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
};

const env = (extra = {}) => ({ STATE: makeKV(), STATION_KEY: STATION, KIOSK_KEY: KIOSK, TB_WHERE_ORIGIN: "https://where.test", PRIZE_PHONE_KEY: KEY,
  ASSETS: { fetch: async () => new Response("page") }, ...extra });
const responses = [];
const call = async (e, path, body, { headers = { "x-key": STATION }, ct = "application/json", method = "POST", ctx } = {}) => {
  const r = await worker.fetch(new Request("https://station.test" + path, { method, headers: { ...(ct ? { "content-type": ct } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), e, ctx);
  const text = await r.text(); responses.push(text);
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, body: j };
};
let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; }; const eq = (a, b, m) => { assert.deepEqual(a, b, m); passed++; };
const save = (e, phone, code, o) => call(e, "/api/prize-link/save", { phone, code }, o);
const look = (e, phone, o) => call(e, "/api/prize-link/lookup", { phone }, o);

// ---- phone shapes ----
eq(normalizePhone("(385) 555-0142"), NUM, "punctuation stripped");
eq(normalizePhone("1-385-555-0142"), NUM, "leading 1 dropped");
eq(["", "123", "385555014", "38555501421", "0855550142", "3850550142", "abc", "21255501420"].map(normalizePhone).filter(Boolean), [], "bad shapes rejected");
eq(normalizePhone("212 555 0142 "), "2125550142", "spaces fine");
eq(normalizePhone(null), "", "null"); eq(normalizePhone({}), "", "object");

// ---- save -> lookup -> clear ----
{
  const e = env(); mk("ABCD");
  let r = await save(e, "(385) 555-0142", "abcd");
  eq([r.status, r.body.ok, r.body.keptUntil > Date.now()], [200, true, true], "saved");
  const keys = [...e.STATE._m.keys()].filter(k => !k.startsWith("pzrl:")).sort();
  eq(keys, ["pz:" + hash(NUM), "pzc:ABCD"], "only the hashed link and the code index are stored");
  const ttl = e.STATE._m.get("pz:" + hash(NUM)).ttl;
  ok(ttl > 23 * 3600 && ttl <= 24 * 3600, "TTL ends with the claim (about 24 h), got " + ttl);
  r = await look(e, "385-555-0142");
  eq([r.status, r.body.found, r.body.code, r.body.prizeId, r.body.label], [200, true, "ABCD", "size_upgrade", "Free Size Upgrade"], "found with the prize");
  ok(r.body.expiresAt > Date.now(), "expiry returned");
  eq(Object.keys(r.body).sort(), ["code", "expiresAt", "found", "label", "ok", "prizeId"], "nothing else is revealed");
  r = await save(e, "3855550142", "ABCD"); eq([r.status, r.body.ok, r.body.already], [200, true, true], "same number, same code again is fine");
  r = await call(e, "/api/prize-link/clear", { code: "ABCD" }); eq(r.body, { ok: true }, "clear");
  eq([...e.STATE._m.keys()].filter(k => !k.startsWith("pzrl:")), [], "link and index deleted");
  r = await look(e, NUM); eq(r.body, { ok: true, found: false }, "gone after clear");
  r = await call(e, "/api/prize-link/clear", { code: "ABCD" }); eq(r.body, { ok: true }, "clear is idempotent");
  r = await call(e, "/api/prize-link/clear", { code: "ab" }); eq(r.status, 400, "bad code on clear");
}

// ---- wrong number looks exactly like no prize ----
{
  const e = env(); mk("ABCD");
  await save(e, NUM, "ABCD");
  const a = await look(e, NUM2), b = await look(env(), NUM2);
  eq(a.body, { ok: true, found: false }, "wrong number: not found"); eq(a, b, "identical to a number that never saved anything");
}

// ---- expiry ----
{
  const e = env(); mk("ABCD"); await save(e, NUM, "ABCD");
  claims.get("ABCD").expiresAt = Date.now() - 1000;                     // tb-where says the claim has expired
  let r = await look(e, NUM); eq(r.body, { ok: true, found: false }, "expired claim is not found");
  eq([...e.STATE._m.keys()].filter(k => k.startsWith("pz")).filter(k => !k.startsWith("pzrl")), [], "expired link deleted");
  mk("EXPR", { expiresAt: Date.now() - 1000 });
  r = await save(env(), NUM, "EXPR"); eq([r.status, r.body.error], [409, "bad-claim"], "cannot save an expired claim");
  // KV copy expired locally but tb-where still thinks it is live: our own stored expiry wins
  const e2 = env(); mk("LOCL"); await save(e2, NUM, "LOCL");
  const k = "pz:" + hash(NUM), v = JSON.parse(e2.STATE._m.get(k).v); v.expiresAt = Date.now() - 5; e2.STATE._m.get(k).v = JSON.stringify(v);
  r = await look(e2, NUM); eq(r.body.found, false, "stored expiry past: not found");
  mk("GONE"); const e3 = env(); await save(e3, NUM, "GONE"); claims.delete("GONE");
  r = await look(e3, NUM); eq(r.body.found, false, "claim unknown at tb-where (KV TTL ended): not found");
}

// ---- used ----
{
  const e = env(); mk("USED"); await save(e, NUM, "USED");
  claims.get("USED").redeemed = true;
  let r = await look(e, NUM); eq(r.body, { ok: true, found: false }, "used claim is not found");
  eq([...e.STATE._m.keys()].filter(k => /^pzc?:/.test(k)), [], "link deleted when found used");
  mk("NEWC"); r = await save(e, NUM, "NEWC"); eq(r.body.ok, true, "a number whose prize was used can save a new one");
  claims.get("NEWC").redeemed = true; r = await save(env(), NUM2, "NEWC"); eq([r.status, r.body.error], [409, "bad-claim"], "cannot save a used claim");
  // the real bump redeem (index.js relay) also clears the link
  const e2 = env(); mk("BUMP"); await save(e2, NUM, "BUMP");
  const pending = []; const ctx = { waitUntil: p => pending.push(p) };
  r = await call(e2, "/api/kitchen/redeem", { code: "BUMP", order: "104" }, { ctx }); await Promise.all(pending);
  eq(r.body.status, "redeemed", "relay redeemed");
  eq([...e2.STATE._m.keys()].filter(k => /^pzc?:/.test(k)), [], "redeem at the make station deletes the phone link");
  mk("CHCK"); await save(e2, NUM2, "CHCK");
  await call(e2, "/api/kitchen/redeem", { code: "CHCK", checkOnly: true }, { ctx }); await Promise.all(pending);
  ok(e2.STATE._m.has("pz:" + hash(NUM2)), "a check-only lookup keeps the link");
}

// ---- one prize per number; one number per code ----
{
  const e = env(); mk("AAAA"); mk("BBBB");
  await save(e, NUM, "AAAA");
  let r = await save(e, NUM, "BBBB"); eq([r.status, r.body.error], [409, "already-have"], "second prize on the same number: already-have");
  r = await look(e, NUM); eq(r.body.code, "AAAA", "the first prize is untouched");
  ok(!e.STATE._m.has("pzc:BBBB"), "nothing stored for the refused one");
  r = await save(e, NUM2, "AAAA"); eq([r.status, r.body.error], [409, "bad-claim"], "same code to a second number refused");
  r = await save(e, NUM2, "BBBB"); eq(r.body.ok, true, "different number, different prize is fine");
}

// ---- tb-where decides the prize, not the caller ----
{
  const e = env();
  mk("NOPR", { prize: null }); mk("BADP", { prize: { id: "standard", label: "Standard Custom Drink" } }); mk("EVIL", { prize: { id: "free_drink_jackpot", label: "<b>FREE</b>\u0001 DRINK" } });
  let r = await save(e, NUM, "NOPR"); eq(r.body.error, "bad-claim", "claim without a prize refused");
  r = await save(e, NUM, "BADP"); eq(r.body.error, "bad-claim", "non-prize id refused");
  r = await save(e, NUM, "NONE"); eq(r.body.error, "bad-claim", "unknown claim refused");
  r = await call(e, "/api/prize-link/save", { phone: NUM, code: "EVIL", prizeId: "size_upgrade", label: "mine" });
  eq(r.body.ok, true, "extra fields from the caller are ignored");
  r = await look(e, NUM); eq([r.body.prizeId, r.body.label], ["free_drink_jackpot", "b FREE /b   DRINK"], "prize id and label come from tb-where (cleaned)");
  ok(!/[<>\u0001]/.test(r.body.label), "label is cleaned");
  ok(LINK_PRIZE_IDS.every(i => i !== "standard"), "allowed ids exclude the standard drink");
}

// ---- bad input, off, unauthorized, json only ----
{
  const e = env();
  for (const bad of ["", "123", "385555014", "38555501421", "1385555014", "0855550142", "3850550142", "abcdefghij", null, undefined, 3855550142.5, {}]) {
    const r = await look(e, bad); ok(r.status === 400 && r.body.error === "bad-phone", "bad phone " + JSON.stringify(bad) + " -> " + r.status);
  }
  let r = await look(env({ PRIZE_PHONE_KEY: undefined }), NUM); eq([r.status, r.body], [503, { ok: false, error: "prize-link-off" }], "off without the secret");
  r = await save(env({ PRIZE_PHONE_KEY: "short" }), NUM, "ABCD"); eq(r.status, 503, "a short key counts as off");
  r = await look(env({ STATE: undefined }), NUM); eq(r.status, 503, "off without KV");
  r = await look(e, NUM, { headers: {} }); eq(r.status, 401, "no key: 401");
  r = await look(e, NUM, { headers: { "x-key": "wrong" } }); eq(r.status, 401, "wrong key: 401");
  r = await look(env({ STATION_KEY: undefined }), NUM, { headers: {} }); eq(r.status, 503, "no STATION_KEY configured: fails closed");
  r = await look(e, NUM, { ct: "text/plain" }); eq(r.status, 415, "json only");
  r = await call(e, "/api/prize-link/lookup", undefined, { method: "GET" }); eq(r.status, 405, "GET refused");
  r = await save(e, NUM, "ab1"); eq(r.body.error, "bad-claim", "bad code shape on save");
  r = await save(e, NUM, "ABIO"); eq(r.body.error, "bad-claim", "letters outside the claim alphabet refused");
  r = await call(e, "/api/prize-link/other", {}); ok(r.status === 404 || r.status === 200, "unknown subpath is not a link route");
}

// ---- rate limit ----
{
  const e = env({ PRIZE_LINK_PER_HOUR: "5" });
  for (let i = 0; i < 5; i++) { const r = await look(e, NUM); eq(r.status, 200, "lookup " + i + " allowed"); }
  let r = await look(e, NUM2); eq([r.status, r.body], [429, { ok: false, error: "slow-down" }], "6th lookup in the hour refused");
  r = await save(e, NUM2, "ABCD"); eq(r.status, 429, "saves share the budget");
  r = await call(e, "/api/prize-link/clear", { code: "ABCD" }); eq(r.status, 200, "clear is not rate limited");
  const bad = await look(env({ PRIZE_LINK_PER_HOUR: "5" }), "12"); eq(bad.status, 400, "bad phones do not spend the budget (checked before it)");
}

// ---- tb-where down ----
{
  const e = env(); mk("DOWN"); await save(e, NUM, "DOWN");
  whereDown = true;
  let r = await look(e, NUM); eq([r.status, r.body], [503, { ok: false, error: "unavailable" }], "lookup with tb-where down is unavailable, never found");
  r = await save(e, NUM2, "DOWN"); eq([r.status, r.body.error], [409, "bad-claim"], "code already owned by another number is refused before tb-where");
  mk("DWN2"); r = await save(e, NUM2, "DWN2"); eq([r.status, r.body.error], [503, "unavailable"], "save with tb-where down is unavailable");
  ok(!e.STATE._m.has("pz:" + hash(NUM2)), "nothing stored when it could not be verified");
  r = await save(e, NUM, "DWN2"); eq(r.status, 503, "existing link cannot be verified: unavailable, not replaced");
  whereDown = false;
  r = await look(env({ KIOSK_KEY: undefined, TB_SECRET: undefined }), NUM); eq(r.status, 200, "no tb-where credentials and no link: just not found");
  const e2 = env({ KIOSK_KEY: undefined }); e2.STATE._m.set("pz:" + hash(NUM), { v: JSON.stringify({ code: "DOWN", prizeId: "size_upgrade", label: "x", expiresAt: Date.now() + 1e6, at: 1 }) });
  r = await look(e2, NUM); eq(r.status, 503, "no credentials to verify with: unavailable, not found");
}

// ---- clearPrizeLinkByCode never throws ----
{
  eq(await clearPrizeLinkByCode({}, "ABCD"), false, "no KV"); eq(await clearPrizeLinkByCode(null, "ABCD"), false, "no env");
  eq(await clearPrizeLinkByCode({ STATE: { get: async () => { throw new Error("x"); } } }, "ABCD"), false, "KV error swallowed");
  eq(await clearPrizeLinkByCode(env(), "zz"), false, "bad code");
}

// ---- privacy: no number or hash anywhere ----
{
  const e = env(); mk("PRIV"); await save(e, "(385) 555-0142", "PRIV"); await look(e, NUM); await look(e, NUM2); await save(e, NUM, "PRIV");
  const h = hash(NUM), h2 = hash(NUM2);
  // The keyed hash IS the storage key (pz:<hash>) and the value of the delete index (pzc:<code>); that is by design (it is useless without the Worker secret).
  // It must never leave KV: not in a log line, not in a response. The raw number must not appear anywhere, KV included.
  const stored = [...e.STATE._m.entries()].map(([k, v]) => k + "=" + v.v).join("\n");
  const everything = { logs: logs.join("\n"), stored, responses: responses.join("\n") };
  for (const [where, text] of Object.entries(everything)) {
    for (const n of [NUM, NUM2, "385-555-0142", "(385) 555-0142"]) ok(!text.includes(n), where + " contains a phone number " + n.slice(0, 3) + "…");
    ok(!text.includes("5550142"), where + " contains the number's tail");
    if (where !== "stored") ok(!text.includes(h) && !text.includes(h2), where + " contains a phone hash");
  }
  ok([...e.STATE._m.entries()].every(([k, v]) => !/^pz:/.test(k) ? true : !v.v.includes(h)), "the record under pz:<hash> does not repeat the hash");
  ok(!JSON.stringify(e.STATE._m.get("pzc:PRIV")).includes(NUM), "index holds no number");
  ok(logs.length === 0, "the link code makes no log calls at all (" + logs.length + ")");
}

out(`prize-link: ${passed} checks passed`);
