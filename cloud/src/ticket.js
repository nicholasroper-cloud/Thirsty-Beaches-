/* Ticket helpers for the cloud station: pure functions (tested in tests/cloud/station.test.mjs) plus the KV state for
   "done" and "picked up" tickets.

   - Daily order numbers (101, 102, ...). Same rules as make-station-server.js and kiosk-server.js (tests/kiosk/seq.js pins all three).
   - splitLine(): name / add-ons / note of one Clover line item, including the kiosk's "MODS: a | b | c" note.
   - Done / picked state: ONE KV KEY PER TICKET ("dn:<orderId>", "pk:<orderId>", 48 h TTL). The old single "done" blob was
     read-modify-written by every tap, so two screens marking tickets at once lost updates. A key per ticket cannot lose another
     ticket's write. Reads list the prefix and are kept in memory for DONE_MEMO_MS (this isolate's own writes show immediately).
     KV list operations are limited on the free plan (1,000/day): see OPS.md "Done tickets in KV".
   - Key check: constant time, fails closed when STATION_KEY is not set. */

import { cloverGet } from "./clover.js";
import { ownerTz, localParts, dayRange } from "./time.js";

export const SEQ_START = 100;
export const noteSeq = note => { const m = /Kiosk order #(\d{1,5})\b/.exec(String(note || "")); return m ? +m[1] : null; };

/* orders: [{id, created(ms), seq|null}] -> Map(id -> number). dayOf(ms) -> a string naming the local day. */
export function assignSeq(orders, dayOf) {
  const out = new Map(), byDay = new Map();
  for (const o of orders) { const k = dayOf(o.created); (byDay.get(k) || byDay.set(k, []).get(k)).push(o); }
  for (const list of byDay.values()) {
    list.sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const taken = new Set();
    for (const o of list) if (o.seq && !taken.has(o.seq)) { taken.add(o.seq); out.set(o.id, o.seq); }   // first claim of a number wins
    list.forEach((o, i) => { if (out.has(o.id)) return; let c = SEQ_START + i + 1; while (taken.has(c)) c++; taken.add(c); out.set(o.id, c); });
  }
  return out;
}

const MODS_NOTE = /^MODS: ([\s\S]+)$/;
/* One Clover line item -> {name, mods, note}. Kiosk lines look like "Thirst Trap · Medium 24oz, Dr Pepper" with the FULL add-on list
   in the line note ("MODS: a | b | c": the name is capped at 127 characters); Register lines carry real modifiers. */
export function splitLine(li) {
  let name = String(li.name || "Item").trim();
  let mods = (((li.modifications || {}).elements) || []).map(m => String(m.name || "").trim()).filter(Boolean);
  let note = String(li.note || "").trim();
  if (/^KQ-[A-Z0-9]{8}( · .*)?$/.test(note)) note = "";     // "Pay on my phone" reference tag, not a drink note
  const mm = MODS_NOTE.exec(note);
  const full = mm ? mm[1].split(" | ").map(x => x.trim()).filter(Boolean) : null;
  if (full) note = "";
  const sep = name.indexOf(" · ");
  if (sep > 0 && (!mods.length || full)) {
    const inName = name.slice(sep + 3).split(",").map(x => x.trim()).filter(Boolean);
    name = name.slice(0, sep).trim();
    if (!mods.length) mods = full ? full.concat(inName.filter(x => !full.includes(x))) : inName;
  } else if (full && !mods.length) mods = full;
  return { name, mods, note };
}

/* ---- access key ---- */
async function sha(v) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(v)))); }
/* constant-time compare: hash both sides so lengths match, then OR the byte differences */
export async function keyMatches(given, expected) {
  const a = await sha(given), b = await sha(expected);
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
/* -> null when allowed, else {status, error}. No STATION_KEY configured = nobody gets in (fail closed). */
export async function authFailure(req, env) {
  if (!env.STATION_KEY) return { status: 503, error: "station key not configured" };
  const given = req.headers.get("x-key") || new URL(req.url).searchParams.get("k") || "";   // ?k= stays for one more release
  return (await keyMatches(given, env.STATION_KEY)) ? null : { status: 401, error: "key required" };
}

/* ---- done / picked state: one KV key per ticket ---- */
const TTL = 48 * 3600;
const memo = { at: 0, done: {}, picked: {}, ok: false };
export const _resetStateMemo = () => { memo.at = 0; memo.done = {}; memo.picked = {}; memo.ok = false; };
const memoMs = env => Math.max(0, parseInt(env.STATION_DONE_MEMO_MS || "10000", 10) || 0);

async function listAll(env, prefix) {
  const out = {};
  let cursor;
  do {
    const r = await env.STATE.list({ prefix, cursor });
    for (const k of r.keys || []) {
      const id = k.name.slice(prefix.length);
      let t = k.metadata && +k.metadata.t;
      if (!t) t = +(await env.STATE.get(k.name)) || Date.now();
      out[id] = t;
    }
    cursor = r.list_complete === false ? r.cursor : undefined;
  } while (cursor);
  return out;
}
/* -> {done:{id:ts}, picked:{id:ts}}. A failed list (quota, outage) serves the last good copy instead of failing the screen. */
export async function loadState(env) {
  if (memo.ok && Date.now() - memo.at < memoMs(env)) return { done: memo.done, picked: memo.picked };
  try {
    const [done, picked, legacy] = await Promise.all([listAll(env, "dn:"), listAll(env, "pk:"), env.STATE.get("done", "json")]);
    for (const [id, t] of Object.entries(legacy || {})) if (!done[id]) done[id] = t;      // the old single blob, for one more release
    memo.done = done; memo.picked = picked; memo.at = Date.now(); memo.ok = true;
  } catch (e) {
    console.error("done-state read failed, using the last copy:", e && e.message);
    memo.at = Date.now();
  }
  return { done: memo.done, picked: memo.picked };
}
const putKey = (env, key, ts) => env.STATE.put(key, String(ts), { expirationTtl: TTL, metadata: { t: ts } });
export async function markDone(env, id, ts = Date.now()) { await putKey(env, "dn:" + id, ts); memo.done = { ...memo.done, [id]: ts }; }
export async function markPicked(env, id, ts = Date.now()) { await putKey(env, "pk:" + id, ts); memo.picked = { ...memo.picked, [id]: ts }; }
export async function markUndo(env, id) {
  await Promise.all([env.STATE.delete("dn:" + id), env.STATE.delete("pk:" + id)]);
  const { [id]: _d, ...done } = memo.done; const { [id]: _p, ...picked } = memo.picked; memo.done = done; memo.picked = picked;
  const legacy = await env.STATE.get("done", "json");                                    // also drop it from the old blob if it is still there
  if (legacy && legacy[id]) { delete legacy[id]; await env.STATE.put("done", JSON.stringify(legacy)); }
}
/* one ticket's done time (0 = not done): a single read, for the phone tracker which polls every few seconds */
export async function doneAt(env, id) {
  const v = await env.STATE.get("dn:" + id);
  if (v) return +v || Date.now();
  const legacy = await env.STATE.get("done", "json");
  return (legacy && legacy[id]) || 0;
}

/* ---- Clover order feed: newest first, paged (the old single "ASC limit 100" query dropped every ticket past the 100th) ---- */
export const PAGE = 100, MAX_PAGES = 10;
export async function fetchOrders(env, since, expand = "lineItems,lineItems.modifications") {
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await cloverGet(env, `/orders?filter=createdTime>=${since}&expand=${expand}&orderBy=createdTime DESC&limit=${PAGE}&offset=${page * PAGE}`);
    const els = (r && r.elements) || [];
    all.push(...els);
    if (els.length < PAGE) break;
  }
  return all.reverse();                                   // oldest first for the screens
}
export const hasLines = o => (((o.lineItems || {}).elements) || []).some(li => !li.exchanged && !li.refunded);
export const dayOfFor = env => { const tz = ownerTz(env); return ms => localParts(ms, tz).date; };
/* where the owner's day starts (UTC ms): daily numbers restart there */
export const startOfDayMs = (env, now = Date.now()) => { const tz = ownerTz(env); return dayRange(localParts(now, tz).date, tz)[0]; };
export const seqMap = (env, orders) => assignSeq(orders.filter(hasLines).map(o => ({ id: o.id, created: o.createdTime, seq: noteSeq(o.note) })), dayOfFor(env));
/* the number a paid phone order shows ("#104"); falls back to the old 4-character code if Clover can't list the day */
export async function seqForOrder(env, orderId) {
  try {
    const list = await fetchOrders(env, startOfDayMs(env), "lineItems");
    const n = seqMap(env, list).get(orderId);
    if (n) return String(n);
  } catch (e) { console.error("order number lookup failed:", e && e.message); }
  return String(orderId).slice(-4).toUpperCase();
}
