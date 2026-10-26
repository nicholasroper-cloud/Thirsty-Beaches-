// node tests/cloud/punch.test.mjs — GET /api/qr/<ref>/punch (cloud/src/punch.js): the punch-card link for a paid
// phone order. Signature, expiry, drinks count, not-paid / unknown / punch-off. Fake KV, no network.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handleQr } from "../../cloud/src/qr.js";
import { drinkCount, PUNCH_TTL_MS, punchToken } from "../../cloud/src/punch.js";
import { KIOSK_MENU } from "../../cloud/src/kiosk-menu.js";
import { phonePage } from "../../cloud/src/phone-page.js";

const KEY = "0123456789abcdef".repeat(4);          // 64 hex chars, like the setup workflow makes
function makeKV(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  return { _m: m, async get(k, type) { const v = m.has(k) ? m.get(k) : null; return v != null && type === "json" ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } };
}
let fetches = 0;
globalThis.fetch = async () => { fetches++; return new Response(JSON.stringify({ elements: [] })); };

const treat = KIOSK_MENU.cats.treats.items[0].name;
const drink = KIOSK_MENU.cats.floats.items[0].name;
const now = Date.now();
const rec = (status, lines, extra = {}) => ({ sid: "s", href: "https://www.clover.com/x", total: 1000, name: "Tank", created: now - 60000,
  expires: now + 14 * 60000, status, lines, ...extra });
const REFS = {
  PAYDAAAA: rec("paid", [{ name: drink, mods: ["Regular", "AKA The Orange Crush Captain"], qty: 2, price: 650 }, { name: treat, mods: [], qty: 3, price: 300 }], { orderId: "ORD1", ticket: "ORD1" }),
  REDYBBBB: rec("paid", [{ name: drink, mods: [], qty: 9, price: 650 }], { orderId: "ORD2", ticket: "ORD2" }),
  PENDCCCC: rec("pending", [{ name: drink, mods: [], qty: 1, price: 650 }], { created: now - 30000 }),
  EXPDDDDD: rec("expired", [{ name: drink, mods: [], qty: 1, price: 650 }]),
  TREATEEE: rec("paid", [{ name: treat, mods: [], qty: 2, price: 300 }], { orderId: "ORD3", ticket: "ORD3" }),
};
const kvInit = { done: { ORD2: now - 1000 } };
for (const [r, v] of Object.entries(REFS)) kvInit["qr:" + r] = v;
const env = (x = {}) => ({ STATE: makeKV(kvInit), CLOVER_MERCHANT_ID: "M", CLOVER_API_TOKEN: "t", PUNCH_KEY: KEY, ...x });

async function punch(e, ref, origin) {
  const req = new Request(`https://station.thirstybeaches.com/api/qr/${ref}/punch`, { headers: origin ? { origin } : {} });
  const r = await handleQr(req, e, new URL(req.url));
  return { status: r.status, json: await r.json(), headers: r.headers };
}
const verify = (token) => {
  const m = token.match(/^([A-Z0-9]+)\.(\d)\.(\d+)\.([0-9a-f]{32})$/);
  assert.ok(m, "token shape " + token);
  const payload = `${m[1]}.${m[2]}.${m[3]}`;
  assert.equal(m[4], createHmac("sha256", Buffer.from(KEY, "utf8")).update(payload).digest("hex").slice(0, 32), "sig = first 32 hex of HMAC-SHA256(PUNCH_KEY utf8, payload)");
  return { ref: m[1], drinks: +m[2], exp: +m[3] };
};

// paid: 2 drinks (the 3 treats don't count), signed, 7-day expiry, CORS for the kiosk PC
let r = await punch(env(), "PAYDAAAA", "http://localhost:8137");
assert.equal(r.status, 200);
assert.equal(r.json.drinks, 2);
assert.ok(r.json.url.startsWith("https://thirstybeaches.com/card?claim="), r.json.url);
let t = verify(new URL(r.json.url).searchParams.get("claim"));
assert.equal(t.ref, "PAYDAAAA"); assert.equal(t.drinks, 2);
assert.ok(Math.abs(t.exp - (Date.now() + PUNCH_TTL_MS)) < 5000, "exp = now + 7 days");
assert.equal(r.headers.get("access-control-allow-origin"), "http://localhost:8137");
// a different key gives a different sig (the sig really depends on PUNCH_KEY)
const other = await punch(env({ PUNCH_KEY: "f".repeat(64) }), "PAYDAAAA");
assert.notEqual(new URL(other.json.url).searchParams.get("claim").split(".")[3], new URL(r.json.url).searchParams.get("claim").split(".")[3]);

// ready (done on the make station): drinks capped at 5
r = await punch(env(), "REDYBBBB");
assert.equal(r.status, 200); assert.equal(r.json.drinks, 5);
assert.equal(verify(new URL(r.json.url).searchParams.get("claim")).drinks, 5);

// not paid yet / expired -> 409; only treats -> 409 no-drinks; unknown / malformed -> 404
assert.equal((await punch(env(), "PENDCCCC")).status, 409);
assert.equal((await punch(env(), "PENDCCCC")).json.error, "not-paid");
assert.equal((await punch(env(), "EXPDDDDD")).status, 409);
r = await punch(env(), "TREATEEE"); assert.equal(r.status, 409); assert.equal(r.json.error, "no-drinks");
assert.equal((await punch(env(), "ZZZZZZZZ")).status, 404);
assert.equal((await punch(env(), "bad")).status, 404);

// punch-off: no PUNCH_KEY (or a too-short one) -> 503, nothing looked up
for (const k of [undefined, "", "short-key"]) {
  const before = fetches;
  r = await punch(env({ PUNCH_KEY: k }), "PAYDAAAA");
  assert.equal(r.status, 503); assert.equal(r.json.error, "punch-off");
  assert.equal(fetches, before);
}
// POST is refused
const post = await handleQr(new Request("https://station.thirstybeaches.com/api/qr/PAYDAAAA/punch", { method: "POST" }), env(), new URL("https://station.thirstybeaches.com/api/qr/PAYDAAAA/punch"));
assert.equal(post.status, 405);
// plain status route still works next to it
const st = await handleQr(new Request("https://station.thirstybeaches.com/api/qr/PAYDAAAA"), env(), new URL("https://station.thirstybeaches.com/api/qr/PAYDAAAA"));
assert.equal((await st.json()).status, "paid");

// drinkCount ignores treats by GRAB_CATEGORIES
assert.equal(drinkCount({}, REFS.PAYDAAAA), 2);
assert.equal(drinkCount({ GRAB_CATEGORIES: "Nothing" }, REFS.PAYDAAAA), 5);

// tracker page: the punch button script is only on the page when punch is on; AKA never shows as a raw mod
const view = { ref: "PAYDAAAA", status: "paid", ticket: "ORD1", total: 1000, name: "Tank", items: [{ name: drink, mods: ["Regular", "AKA The Orange Crush Captain"], qty: 2 }] };
const on = phonePage(view, { punch: true }), off = phonePage(view, {});
assert.ok(/const PUNCH_ON = true/.test(on)); assert.ok(/const PUNCH_ON = false/.test(off));

// fixed test vector shared with tb-where: key = the PUNCH_KEY string as UTF-8 (not hex-decoded)
{
  const k = "a".repeat(64), want = createHmac("sha256", "a".repeat(64)).update("ABC123.2.1800000000000").digest("hex").slice(0, 32);
  assert.equal(await punchToken(k, "ABC123", 2, 1800000000000), "ABC123.2.1800000000000." + want);
  assert.match(want, /^[0-9a-f]{32}$/);
}

console.log("punch tests ok");
