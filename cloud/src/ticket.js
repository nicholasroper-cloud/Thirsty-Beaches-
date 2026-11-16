/* Ticket helpers for the cloud station: pure functions (tested in tests/cloud/station.test.mjs) plus the KV state for
   "done" and "picked up" tickets.

   - Daily order numbers (101, 102, ...). Same rules as make-station-server.js and kiosk-server.js (tests/kiosk/seq.js pins all three).
   - splitLine(): name / add-ons / note of one Clover line item, including the kiosk's "MODS: a | b | c" note.
   - Done / picked state: ONE KV KEY PER TICKET ("dn:<orderId>", picked rides in its metadata, 48 h TTL). The old single "done" blob was
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

/* ---- ticket release gate (ADR 2026-11-15 section 5): the same rules as make-station-server.js ticketGate(); tests/kiosk/gate.js pins both ---- */
export function ticketGate(o, kioskTypeId) {
  const title = String(o.title || "");
  const lines = (((o.lineItems || {}).elements) || []).filter(li => !li.exchanged && !li.refunded);
  if (/^TBK:SHELL\b/.test(title)) return { show: false };
  if (lines.length && lines.every(li => String(li.name || "").trim().toLowerCase() === "manual transaction")) return { show: false };
  const isKiosk = title.startsWith("TBK:") || (!!kioskTypeId && !!o.orderType && o.orderType.id === kioskTypeId);
  if (!isKiosk) return { show: true, badge: null };
  const native = String(o.paymentState || "").toUpperCase() === "PAID";
  const money = "$" + ((o.total || 0) / 100).toFixed(2);
  if (/^TBK:PAID\b/.test(title)) return native ? { show: true, paid: true, badge: { kind: "DOUBLE", text: "2× DOUBLE", long: "DOUBLE PAID: void one" } } : { show: true, paid: true, badge: { kind: "PAID", text: "✓ PAID", long: "✓ PAID" } };
  if (/^TBK:COLLECT\b/.test(title)) return native ? { show: true, paid: true, badge: { kind: "PAID", text: "✓ PAID", long: "✓ PAID" } } : { show: true, paid: false, badge: { kind: "COLLECT", text: "COLLECT " + money, long: "COLLECT " + money } };
  if (/^TBK:CHECK\b/.test(title)) return { show: true, paid: false, badge: { kind: "CHECK", text: "⚠ CHECK", long: "CHECK READER, do not charge" } };
  return { show: false };
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

/* ---- done / picked state: one KV key per ticket ----
   "dn:<orderId>" holds the done time; "Picked up" lives in the SAME key's metadata ({t: done, p: picked}), so a read is ONE list call
   (two prefixes doubled the quota use) and a tap is one write. 48 h TTL. */
const TTL = 48 * 3600;
const memo = { at: 0, done: {}, picked: {}, ok: false };
const own = { done: {}, picked: {} };           // what THIS isolate wrote: still true when KV cannot be listed
export const _resetStateMemo = () => { memo.at = 0; memo.done = {}; memo.picked = {}; memo.ok = false; own.done = {}; own.picked = {}; };
const memoMs = env => { const n = parseInt(env.STATION_DONE_MEMO_MS || "120000", 10); return Number.isFinite(n) && n >= 0 ? n : 120000; };

async function listDone(env) {
  const done = {}, picked = {};
  let cursor;
  do {
    const r = await env.STATE.list({ prefix: "dn:", cursor });
    for (const k of r.keys || []) {
      const id = k.name.slice(3), m = k.metadata || {};
      let t = +m.t;
      if (!t) t = +(await env.STATE.get(k.name)) || Date.now();
      done[id] = t;
      if (+m.p) picked[id] = +m.p;
    }
    cursor = r.list_complete === false ? r.cursor : undefined;
  } while (cursor);
  return { done, picked };
}
/* -> {done:{id:ts}, picked:{id:ts}}. If the list fails (free-plan quota, outage) the last good copy is served; on a COLD isolate with no
   copy it falls back to the legacy "done" blob plus this isolate's own taps, never to {} (that made every Done ticket come back). */
export async function loadState(env) {
  if (memo.ok && Date.now() - memo.at < memoMs(env)) return { done: memo.done, picked: memo.picked };
  let legacy = null;
  try { legacy = await env.STATE.get("done", "json"); } catch {}
  try {
    const { done, picked } = await listDone(env);
    for (const [id, t] of Object.entries(legacy || {})) if (!done[id]) done[id] = t;       // the old single blob, for one more release
    memo.done = done; memo.picked = picked; memo.at = Date.now(); memo.ok = true;
  } catch (e) {
    console.error("done-state list failed:", e && e.message);
    if (!memo.ok) {                                                                       // nothing to fall back on yet
      memo.done = { ...(legacy || {}), ...own.done }; memo.picked = { ...own.picked }; memo.ok = true;
    }
    memo.at = Date.now();                                                                 // do not hammer a failing list on every poll
  }
  return { done: memo.done, picked: memo.picked };
}
const putDn = (env, id, t, p) => env.STATE.put("dn:" + id, String(t), { expirationTtl: TTL, metadata: p ? { t, p } : { t } });
export async function markDone(env, id, ts = Date.now()) { await putDn(env, id, ts); own.done[id] = ts; memo.done = { ...memo.done, [id]: ts }; }
export async function markPicked(env, id, ts = Date.now()) {
  const t = memo.done[id] || +(await env.STATE.get("dn:" + id)) || ts;                 // keep the original done time
  await putDn(env, id, t, ts); own.picked[id] = ts; memo.picked = { ...memo.picked, [id]: ts };
}
export async function markUndo(env, id) {
  await env.STATE.delete("dn:" + id);
  delete own.done[id]; delete own.picked[id];
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
export async function fetchOrders(env, since, expand = "lineItems,lineItems.modifications,orderType") {
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
