// node tests/cloud/station.test.mjs — the cloud station Worker (cloud/src/index.js): fails closed without STATION_KEY, X-Key
// (and ?k= for one more release), the feed beyond 100 orders, one KV key per done ticket (no lost updates), Picked up,
// the "MODS:" line note, daily order numbers. Fake KV and a fake Clover, no network.
import assert from "node:assert/strict";
import worker from "../../cloud/src/index.js";
import { _resetStateMemo, splitLine, authFailure, loadState, markDone, markPicked } from "../../cloud/src/ticket.js";

function makeKV(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, { v: typeof v === "string" ? v : JSON.stringify(v) }]));
  return { _m: m,
    async get(k, type) { const e = m.get(k); if (!e) return null; return type === "json" ? JSON.parse(e.v) : e.v; },
    async put(k, v, o) { m.set(k, { v: String(v), meta: o && o.metadata }); },
    async delete(k) { m.delete(k); },
    async list({ prefix = "", cursor } = {}) {
      const all = [...m.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? +cursor : 0, page = all.slice(start, start + 2);   // tiny pages: exercises the cursor loop
      const next = start + 2;
      return { keys: page.map(name => ({ name, metadata: m.get(name).meta })), list_complete: next >= all.length, cursor: String(next) };
    } };
}
const orders = [];
let calls = [];
globalThis.fetch = async (url) => {
  const u = new URL(url); calls.push(u);
  if (u.pathname.endsWith("/items")) return new Response(JSON.stringify({ elements: [] }));
  if (u.pathname.endsWith("/orders")) {
    const lim = +u.searchParams.get("limit"), off = +u.searchParams.get("offset");
    const desc = /DESC/.test(u.searchParams.get("orderBy"));
    const all = orders.slice().sort((a, b) => desc ? b.createdTime - a.createdTime : a.createdTime - b.createdTime);
    return new Response(JSON.stringify({ elements: all.slice(off, off + lim) }));
  }
  return new Response("{}", { status: 404 });
};
const env = (extra = {}) => ({ STATE: makeKV(), CLOVER_MERCHANT_ID: "M", CLOVER_API_TOKEN: "t", STATION_KEY: "k-123456", ASSETS: { fetch: async () => new Response("page") }, PAGE_VERSION: "9", STATION_DONE_MEMO_MS: "0", ...extra });
const call = (e, path, { method = "GET", headers = {}, body } = {}) => worker.fetch(new Request("https://station.test" + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body && JSON.stringify(body) }), e);
const KEY = { "x-key": "k-123456" };

// ---- 150 orders: newest are kept, numbered, add-ons read from the note ----
const t0 = Date.now() - 3 * 3600000;
for (let i = 0; i < 150; i++) orders.push({ id: "ORD" + String(i).padStart(5, "0"), createdTime: t0 + i * 1000, state: "open", paymentState: "OPEN", total: 0, note: "", lineItems: { elements: [{ name: "Thirst Trap", price: 349 }] } });
orders[149].lineItems.elements = [{ name: "Thirst Trap · Medium 24oz, Dr Pepper", note: "MODS: Medium 24oz | Dr Pepper | Coconut | Float: Vanilla | Freeze-dried candy", price: 349 }];
orders[148].note = "Sam — Kiosk order #777";
{
  _resetStateMemo();
  const e = env(); calls = [];
  const q = await (await call(e, "/queue", { headers: KEY })).json();
  assert.equal(q.error, null, String(q.error)); assert.equal(q.waiting.length, 150, "all 150 tickets (the old ASC limit-100 query dropped the newest 50)");
  const ordersCalls = calls.filter(u => u.pathname.endsWith("/orders"));
  assert.ok(ordersCalls.every(u => /DESC/.test(u.searchParams.get("orderBy"))), "newest first");
  assert.ok(ordersCalls.some(u => u.searchParams.get("offset") === "100"), "second page requested");
  const last = q.waiting[q.waiting.length - 1];
  assert.deepEqual(last.items[0].mods, ["Medium 24oz", "Dr Pepper", "Coconut", "Float: Vanilla", "Freeze-dried candy"]);
  assert.equal(last.items[0].note, "");
  assert.equal(q.waiting[0].ticket, "101"); assert.equal(q.waiting.find(o => o.id === orders[148].id).ticket, "777");
  assert.equal(new Set(q.waiting.map(o => o.ticket)).size, 150, "numbers unique");
  assert.equal(last.ref.length, 4);
}

// ---- fails closed ----
{
  _resetStateMemo();
  const e = env({ STATION_KEY: undefined });
  assert.equal((await call(e, "/queue")).status, 503, "no STATION_KEY: /queue refuses");
  assert.equal((await call(e, "/queue", { headers: { "x-key": "" } })).status, 503);
  assert.equal((await call(e, "/done", { method: "POST", body: { id: "ABCDEF" } })).status, 503, "no STATION_KEY: /done refuses");
  assert.equal((await call(e, "/api/monitor")).status, 503);
  assert.equal((await call(e, "/api/report")).status, 503);
  assert.equal(((await (await call(e, "/health")).json())).keyRequired, false, "health still tells the truth");
  assert.deepEqual(await authFailure(new Request("https://x/"), { STATION_KEY: "a" }), { status: 401, error: "key required" });
  assert.equal(await authFailure(new Request("https://x/?k=a"), { STATION_KEY: "a" }), null, "?k= still works");
  assert.equal(await authFailure(new Request("https://x/", { headers: { "x-key": "a" } }), { STATION_KEY: "a" }), null);
  assert.equal((await call(env(), "/queue")).status, 401);
  assert.equal((await call(env(), "/queue", { headers: { "x-key": "nope-nope" } })).status, 401);
  assert.equal((await call(env(), "/queue?k=k-123456")).status, 200, "?k= works for one more release");
  assert.equal((await call(env(), "/queue", { headers: KEY })).status, 200);
}

// ---- done / picked: one KV key per ticket, concurrent taps lose nothing ----
{
  _resetStateMemo();
  const e = env({ STATE: makeKV({ done: { ORD00001: Date.now() } }) });          // the old single blob, still honored for one release
  const ids = ["ORD00140", "ORD00141", "ORD00142", "ORD00143"];
  const res = await Promise.all(ids.map(id => call(e, "/done", { method: "POST", headers: KEY, body: { id } })));
  assert.ok(res.every(r => r.status === 200));
  for (const id of ids) assert.ok(e.STATE._m.has("dn:" + id), "own KV key for " + id);
  assert.equal([...e.STATE._m.keys()].filter(k => k.startsWith("dn:")).length, 4);
  _resetStateMemo();
  let q = await (await call(e, "/queue", { headers: KEY })).json();
  assert.equal(q.waiting.length, 150 - 4 - 1, "four new + one legacy done ticket are off the waiting list");
  assert.equal(q.ready.length, 5);
  assert.equal((await call(e, "/pickedup", { method: "POST", headers: KEY, body: { id: "ORD00149" } })).status, 409, "cannot pick up what is not made");
  assert.equal((await call(e, "/pickedup", { method: "POST", headers: KEY, body: { id: ids[0] } })).status, 200);
  q = await (await call(e, "/queue", { headers: KEY })).json();
  assert.ok(!q.ready.some(o => o.id === ids[0]), "Picked up leaves Ready");
  assert.equal((await call(e, "/undo", { method: "POST", headers: KEY, body: { id: ids[0] } })).status, 200);
  assert.ok(!e.STATE._m.has("dn:" + ids[0]) && !e.STATE._m.has("pk:" + ids[0]));
  assert.equal((await call(e, "/undo", { method: "POST", headers: KEY, body: { id: "ORD00001" } })).status, 200);
  assert.ok(!JSON.parse(e.STATE._m.get("done").v).ORD00001, "undo also clears the legacy blob");
  assert.equal((await call(e, "/done", { method: "POST", headers: { ...KEY, "content-type": "text/plain" }, body: { id: "ORD00001" } })).status, 415, "text/plain POST refused");
  assert.equal((await call(e, "/done", { method: "POST", headers: KEY, body: { id: "x" } })).status, 400, "bad id");
  // a failing list (KV quota) serves the last copy instead of failing the screen
  const bad = { ...e, STATE: { ...e.STATE, list: async () => { throw new Error("KV list() limit exceeded"); }, get: e.STATE.get, put: e.STATE.put, delete: e.STATE.delete } };
  const q2 = await call(bad, "/queue", { headers: KEY });
  assert.equal(q2.status, 200, "list failure does not take the station down");
}

// ---- CR-002: one list call per load, picked rides in the dn key, a cold isolate never falls back to {} ----
{
  _resetStateMemo();
  let lists = 0;
  const kv = makeKV({ done: { LEGACY0001: 111 } });
  const counting = { ...kv, list: async o => { lists++; return kv.list(o); } };
  const e = { STATE: counting, STATION_DONE_MEMO_MS: "0" };
  await markDone(e, "AAAAAA01"); await markPicked(e, "AAAAAA01");
  assert.ok(!kv._m.has("pk:AAAAAA01"), "no separate pk key any more");
  assert.deepEqual(kv._m.get("dn:AAAAAA01").meta.p > 0, true, "picked time is in the dn key's metadata");
  lists = 0; _resetStateMemo();
  const st1 = await loadState(e);
  assert.equal(lists, 1, "ONE list call per state load (it was two)");
  assert.ok(st1.done.AAAAAA01 && st1.picked.AAAAAA01 && st1.done.LEGACY0001 === 111, "done, picked and the legacy blob all read");
  // memo: a 120 s window means the second poll costs no list call
  _resetStateMemo(); lists = 0;
  const e2 = { STATE: counting, STATION_DONE_MEMO_MS: "120000" };
  await loadState(e2); await loadState(e2); await loadState(e2);
  assert.equal(lists, 1, "polls inside the memo window do not list");
  // a COLD isolate whose list is over quota: legacy blob + own writes, NOT {}
  _resetStateMemo();
  const down = { STATE: { get: kv.get, put: kv.put, delete: kv.delete, list: async () => { throw new Error("KV list() limit exceeded"); } }, STATION_DONE_MEMO_MS: "0" };
  await markDone(down, "OWNTAP01");
  const cold = await loadState(down);
  assert.ok(cold.done.LEGACY0001 === 111, "cold isolate + failed list still knows the legacy done tickets");
  assert.ok(cold.done.OWNTAP01, "and this isolate's own tap");
  assert.ok(Object.keys(cold.done).length >= 2, "never {}");
}

// ---- splitLine ----
{
  assert.deepEqual(splitLine({ name: "Thirst Trap · Large 32oz, Coconut" }), { name: "Thirst Trap", mods: ["Large 32oz", "Coconut"], note: "" }, "old name-only format");
  assert.deepEqual(splitLine({ name: "Latte", modifications: { elements: [{ name: "Oat" }] } }), { name: "Latte", mods: ["Oat"], note: "" }, "real modifiers win");
  assert.deepEqual(splitLine({ name: "X · A, B", note: "MODS: A | B | C" }).mods, ["A", "B", "C"], "note first, nothing lost");
  assert.deepEqual(splitLine({ name: "X · A, B, Z", note: "MODS: A | B" }).mods, ["A", "B", "Z"], "a name-only add-on is kept if the note was cut short");
  assert.equal(splitLine({ name: "X", note: "KQ-ABCD1234 · Kiosk" }).note, "", "phone-pay tag is not a drink note");
  assert.equal(splitLine({ name: "X", note: "no ice please" }).note, "no ice please");
}
console.log("station worker: ok");
