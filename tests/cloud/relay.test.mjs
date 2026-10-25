// node tests/cloud/relay.test.mjs — the station Worker's use of the Salty Dog Tags relay (cloud/src/relay.js):
// "Pay on my phone" / "Order ahead" checkouts and owner alerts, with a fake KV and a stubbed fetch (no network).
import assert from "node:assert/strict";
import { handleQr } from "../../cloud/src/qr.js";
import { handleOrderAhead, oaMemo } from "../../cloud/src/order-ahead.js";
import { notify, notifyConfigured, notifyChannels } from "../../cloud/src/notify.js";

const KEY = "f".repeat(64);
const logs = [];
for (const lvl of ["log", "warn", "error"]) console[lvl] = (...a) => logs.push(a.map(String).join(" "));

function makeKV() {
  const m = new Map();
  return { _m: m,
    async get(k, type) { const v = m.has(k) ? m.get(k) : null; return v != null && type === "json" ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } };
}
let sent = [];
let relayReply = () => new Response(JSON.stringify({ href: "https://www.clover.com/checkout/s1", checkoutSessionId: "s1",
  createdTime: Date.now(), expirationTime: Date.now() + 15 * 60000 }), { status: 200 });
let cloverReply = () => new Response(JSON.stringify({ href: "https://www.clover.com/checkout/d1", checkoutSessionId: "d1", expirationTime: Date.now() + 15 * 60000 }));
let otherReply = () => new Response("{}");
globalThis.fetch = async (url, init = {}) => {
  url = String(url); sent.push({ url, init });
  if (url.includes("/api/relay")) return relayReply(url, init);
  if (url.includes("/invoicingcheckoutservice/")) return cloverReply(url, init);
  if (url.includes("/where")) return new Response(JSON.stringify({ open: true, label: "Lehi Main St" }));
  if (url.includes("kiosk-control.json")) return new Response(JSON.stringify({ soldOut: [], soldOutOptions: [], specials: [] }));
  return otherReply(url, init);
};

const baseEnv = (x = {}) => ({ STATE: makeKV(), CLOVER_MERCHANT_ID: "MQKMTFBRXFP21", CLOVER_BASE_URL: "https://api.clover.com", CLOVER_API_TOKEN: "rest-token", TIPS: "0", QR_RATE_PER_HOUR: "1000", ...x });
const responses = [];
let ipn = 0;
async function qr(env, method, body, headers = {}) {
  const req = new Request("https://station.thirstybeaches.com/api/qr", { method, headers: { "content-type": "application/json", "cf-connecting-ip": "10.0.0." + (++ipn), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const r = await handleQr(req, env, new URL(req.url));
  const text = await r.text(); responses.push(text);
  return { status: r.status, json: JSON.parse(text) };
}
const line = (x = {}) => ({ name: "Sandy Bottom", unit: 6.5, qty: 1, mods: [], catKey: "floats", ...x });
const cart = (x = {}) => ({ lines: [line()], name: "Nick", ...x });
/* the kiosk's own decision (drink-kiosk.html startQr): anything but a good 200 -> "Pay at the window" */
const kioskFallsBack = r => !(r.status === 200 && r.json && r.json.ref && r.json.payUrl && r.json.total > 0);

/* --- neither key: phone pay off, nothing sent --- */
let env = baseEnv();
sent = [];
assert.equal((await qr(env, "GET")).status, 503);
assert.equal((await qr(env, "GET")).json.error, "qr-off");
assert.equal((await qr(env, "POST", cart())).json.error, "qr-off");
// a short RELAY_KEY doesn't count (the workflow makes 64 hex chars)
env = baseEnv({ RELAY_KEY: "too-short" });
assert.equal((await qr(env, "GET")).json.error, "qr-off");
assert.equal(sent.length, 0);

/* --- RELAY_KEY only: enabled, checkout made through the relay --- */
env = baseEnv({ RELAY_KEY: KEY });
assert.deepEqual((await qr(env, "GET")).json, { enabled: true });
sent = [];
let r = await qr(env, "POST", cart({ lines: [line(), line({ name: "Thicc & Thirsty", unit: 7.5, qty: 2 })] }));
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.ok(r.json.ref && r.json.payUrl.startsWith("https://station.thirstybeaches.com/r/"));
assert.equal(r.json.total, 650 + 1500);
assert.equal(sent.filter(s => s.url.includes("/invoicingcheckoutservice/")).length, 0, "never Clover directly without our own key");
const rc = sent.filter(s => s.url.includes("/api/relay"));
assert.equal(rc.length, 1);
assert.equal(rc[0].url, "https://saltydogtags.com/api/relay");
assert.equal(rc[0].init.method, "POST");
assert.equal(rc[0].init.headers.authorization, "Bearer " + KEY);
let p = JSON.parse(rc[0].init.body);
assert.equal(p.kind, "checkout"); assert.equal(p.merchantId, "MQKMTFBRXFP21");
assert.deepEqual(p.customer, { firstName: "Nick" });
assert.deepEqual(p.tips, { enabled: false });
assert.equal(p.shoppingCart.lineItems.length, 3, "one line per drink");
assert.deepEqual(p.shoppingCart.lineItems.map(l => [l.name, l.price, l.unitQty]), [["Sandy Bottom", 650, 1], ["Thicc & Thirsty", 750, 1], ["Thicc & Thirsty", 750, 1]]);
assert.equal(p.shoppingCart.lineItems[0].note, `KQ-${r.json.ref} · Nick`);
assert.deepEqual(p.redirectUrls, { success: `https://station.thirstybeaches.com/r/${r.json.ref}?paid=1`, failure: `https://station.thirstybeaches.com/r/${r.json.ref}?failed=1` });
const rec = JSON.parse(env.STATE._m.get("qr:" + r.json.ref));
assert.equal(rec.sid, "s1"); assert.equal(rec.href, "https://www.clover.com/checkout/s1"); assert.equal(rec.status, "pending");
// status poll still works off the stored record
const st = await handleQr(new Request("https://station.thirstybeaches.com/api/qr/" + r.json.ref), env, new URL("https://station.thirstybeaches.com/api/qr/" + r.json.ref));
assert.equal(st.status, 200);
// RELAY_URL override
env.RELAY_URL = "https://preview.salty-dog-tags.pages.dev/api/relay"; sent = [];
assert.equal((await qr(env, "POST", cart())).status, 200);
assert.equal(sent.find(s => s.url.includes("/api/relay")).url, "https://preview.salty-dog-tags.pages.dev/api/relay");
delete env.RELAY_URL;
// QR_ENABLED=0 still switches it off
assert.equal((await qr({ ...env, QR_ENABLED: "0" }, "GET")).json.error, "qr-off");

/* --- own CLOVER_ECOMM_TOKEN wins over the relay --- */
const envOwn = baseEnv({ RELAY_KEY: KEY, CLOVER_ECOMM_TOKEN: "own-ecomm-token" });
sent = [];
r = await qr(envOwn, "POST", cart());
assert.equal(r.status, 200);
assert.equal(sent.filter(s => s.url.includes("/api/relay")).length, 0);
const dc = sent.find(s => s.url.includes("/invoicingcheckoutservice/"));
assert.equal(dc.url, "https://api.clover.com/invoicingcheckoutservice/v1/checkouts");
assert.equal(dc.init.headers.authorization, "Bearer own-ecomm-token");

/* --- relay trouble: clean error, kiosk falls back to the window, no ref stored --- */
const troubles = [
  ["unreachable", () => { throw new TypeError("fetch failed"); }],
  ["timeout", () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }],
  ["404 (key not live on the site yet)", () => new Response("Not found", { status: 404 })],
  ["401 (key mismatch)", () => new Response('{"error":"unauthorized"}', { status: 401 })],
  ["429", () => new Response('{"error":"rate-limited"}', { status: 429 })],
  ["502 clover error", () => new Response('{"error":"clover-error","status":401}', { status: 502 })],
  ["503 pay off", () => new Response('{"error":"pay-off"}', { status: 503 })],
  ["200 but not a clover link", () => new Response('{"href":"https://evil.com/x","checkoutSessionId":"x"}')],
  ["200 no session", () => new Response('{"href":"https://www.clover.com/x"}')],
  ["200 html", () => new Response("<html>")],
];
for (const [what, fn] of troubles) {
  relayReply = fn;
  const before = [...env.STATE._m.keys()].filter(k => k.startsWith("qr:")).length;
  r = await qr(env, "POST", cart());
  assert.equal(r.status, 502, what); assert.deepEqual(r.json, { error: "checkout-failed" }, what);
  assert.ok(kioskFallsBack(r), what);
  assert.notEqual(r.json.error, "qr-off", "a relay hiccup doesn't hide the QR choice for later customers: " + what);
  assert.equal([...env.STATE._m.keys()].filter(k => k.startsWith("qr:")).length, before, "nothing stored: " + what);
}
relayReply = () => new Response(JSON.stringify({ href: "https://www.clover.com/checkout/s2", checkoutSessionId: "s2", expirationTime: Date.now() + 15 * 60000 }));

/* --- carts the relay would refuse are stopped here first --- */
sent = [];
r = await qr(env, "POST", cart({ lines: [line({ qty: 20 }), line({ qty: 11 })] }));                 // 31 drinks
assert.equal(r.status, 400); assert.deepEqual(r.json, { error: "too-big", max: 30 }); assert.ok(kioskFallsBack(r));
r = await qr(env, "POST", cart({ lines: [line({ name: "Thicc & Thirsty", unit: 7.5, qty: 20 }), line({ name: "Thicc & Thirsty", unit: 7.5, qty: 7 })] }));   // $202.50
assert.equal(r.status, 400); assert.deepEqual(r.json, { error: "too-big" });
assert.equal(sent.filter(s => s.url.includes("/api/relay")).length, 0);
// the same carts are fine with our own key (no relay limits)
assert.equal((await qr(envOwn, "POST", cart({ lines: [line({ qty: 20 }), line({ qty: 11 })] }))).status, 200);
// a tampered price never reaches the relay
sent = [];
r = await qr(env, "POST", cart({ lines: [line({ unit: 0.5 })] }));
assert.equal(r.status, 400); assert.equal(sent.filter(s => s.url.includes("/api/relay")).length, 0);

/* --- order ahead treats the relay as available --- */
const oa = async (e) => { oaMemo.where = null; oaMemo.whereAt = 0; const req = new Request("https://station.thirstybeaches.com/api/order-ahead");
  const res = await handleOrderAhead(req, e, new URL(req.url)); return res.json(); };
assert.equal((await oa(baseEnv({ ORDER_AHEAD: "true" }))).enabled, false);
assert.equal((await oa(baseEnv({ ORDER_AHEAD: "true", RELAY_KEY: KEY }))).enabled, true);
assert.equal((await oa(baseEnv({ ORDER_AHEAD: "true", RELAY_KEY: KEY, QR_ENABLED: "0" }))).enabled, false);
const envOa = baseEnv({ ORDER_AHEAD: "true", RELAY_KEY: KEY });
oaMemo.where = null; sent = [];
r = await qr(envOa, "POST", cart({ source: "online" }), { origin: "https://station.thirstybeaches.com" });
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.equal(r.json.checkoutUrl, "https://www.clover.com/checkout/s2");
p = JSON.parse(sent.find(s => s.url.includes("/api/relay")).init.body);
assert.equal(p.shoppingCart.lineItems[0].note, `KQ-${r.json.ref} · Online · Nick`);

/* --- owner alerts --- */
let relayNote = () => new Response('{"ok":true,"sent":1}');
relayReply = (u, i) => relayNote(u, i);
const msg = { title: "Down: saltydogtags.com", body: "🔴 Salty Dog Tags is DOWN: HTTP 503", priority: "high", tags: ["rotating_light"], click: "https://saltydogtags.com/" };
// nothing configured
assert.equal(notifyConfigured(baseEnv()), false);
assert.deepEqual(await notify(baseEnv(), msg), ["no channel configured"]);
// relay only
env = baseEnv({ RELAY_KEY: KEY });
assert.equal(notifyConfigured(env), true); assert.deepEqual(notifyChannels(env), ["relay"]);
sent = [];
assert.deepEqual(await notify(env, msg), []);
assert.equal(sent.length, 1); assert.equal(sent[0].url, "https://saltydogtags.com/api/relay");
assert.equal(sent[0].init.headers.authorization, "Bearer " + KEY);
assert.deepEqual(JSON.parse(sent[0].init.body), { kind: "notify", source: "tb-station", title: "Down: saltydogtags.com", message: msg.body, priority: "high", url: "https://saltydogtags.com/" });
// long text is cut to the relay's limits; non-https links dropped; unknown priority -> normal
sent = [];
await notify(env, { title: "T".repeat(300), body: "B".repeat(5000), click: "http://x.com", priority: "urgent" });
p = JSON.parse(sent[0].init.body);
assert.equal(p.title.length, 120); assert.equal(p.message.length, 1000); assert.ok(!("url" in p)); assert.equal(p.priority, "normal");
// relay failure -> one error for one channel, so the monitor / daily report retry next run
for (const fn of [() => new Response('{"error":"notify-failed"}', { status: 502 }), () => { throw new TypeError("down"); }, () => new Response("Not found", { status: 404 }),
                  () => new Response('{"error":"rate-limited"}', { status: 429 }), () => new Response("{}", { status: 200 })]) {
  relayNote = fn;
  const errs = await notify(env, msg);
  assert.equal(errs.length, 1); assert.ok(errs.length >= notifyChannels(env).length, "counted as nothing got through");
  assert.match(errs[0], /^relay /);
}
relayNote = () => new Response('{"ok":true,"sent":1}');
// own channels win: any one of them set -> relay never used
for (const own of [{ NTFY_TOPIC: "my-topic" }, { PUSHOVER_TOKEN: "pt", PUSHOVER_USER: "pu" }, { TWILIO_SID: "AC", TWILIO_TOKEN: "tt", TWILIO_FROM: "+1", NOTIFY_TO: "+2" }]) {
  const e = baseEnv({ RELAY_KEY: KEY, ...own });
  sent = [];
  assert.deepEqual(await notify(e, msg), []);
  assert.equal(sent.filter(s => s.url.includes("/api/relay")).length, 0, JSON.stringify(own));
  assert.ok(sent.length >= 1);
  assert.ok(!notifyChannels(e).includes("relay"));
}
// a half-set own channel (Pushover token without user) doesn't count, so the relay is still used
env = baseEnv({ RELAY_KEY: KEY, PUSHOVER_TOKEN: "pt" }); sent = [];
await notify(env, msg);
assert.equal(sent.filter(s => s.url.includes("/api/relay")).length, 1);

/* --- the key never shows up in a response or a log line --- */
for (const t of responses) assert.ok(!t.includes(KEY), "key in a response");
for (const l of logs) { assert.ok(!l.includes(KEY), "key in a log: " + l); assert.ok(!l.includes("own-ecomm-token"), "token in a log"); }
process.stdout.write(`station relay tests ok (${responses.length} requests, ${logs.length} log lines)\n`);
