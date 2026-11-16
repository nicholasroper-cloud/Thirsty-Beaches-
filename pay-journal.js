/* =============================================================================
   pay-journal.js — Thirsty Beaches kiosk: append-only pay journal (JSONL).

   Purpose: the durable memory of every card attempt, so a restart, a dropped
   connection or a late reader answer can never lose track of a charge. The
   journal is written (and fsynced) BEFORE connector.sale() is called.

   File layout (all under .tb/, which no update manifest can reach):
     .tb/pay-journal.jsonl                 today's events, one JSON object per line
     .tb/pay-journal.YYYY-MM-DD.jsonl      earlier days (daily rotation)

   Each line is one EVENT. An attempt's current record is the fold of its events
   (later fields win). Events without an externalId are ORDER events (registered,
   COLLECT, ABANDONED, or a tag-written marker).

   Security (Scarlett Q1, 2026-11-15):
     - Every line goes through serialize(), an ALLOW-LIST serializer that only
       reads known keys from a plain object and validates each value. It never
       stringifies an SDK object, so first6, cardholder name, card tokens, TLV
       data, the pairing token and the Clover API token cannot reach the disk.
     - The journal is a HINT, not evidence: nothing here may write TBK:PAID by
       itself. flex-pay.js approves only on device FOUND/SUCCESS (or REST SUCCESS
       with a matching externalPaymentId and amount).
     - Retention: rotated daily; a rotated file older than 30 days is deleted only
       when every attempt and order in it is resolved. IN_FLIGHT, UNKNOWN and
       DOUBLE entries (and orders still waiting for their Clover tag) are never
       purged. Total size is capped at 50 MB: a NEW attempt is refused when the
       cap cannot be met (fail closed), outcomes of existing attempts always write.

   Dependencies: Node built-ins only.
   ============================================================================= */
"use strict";

const fs   = require("fs");
const path = require("path");

const FILE_NAME = "pay-journal.jsonl";
const ROTATED_RE = /^pay-journal\.(\d{4}-\d{2}-\d{2})\.jsonl$/;

/* attempt states (ADR section 3) */
const UNKNOWN_STATES = new Set(["TIMEOUT_UNKNOWN", "DISCONNECTED_UNKNOWN"]);
const ATTEMPT_STATES = new Set(["IN_FLIGHT", "APPROVED", "DECLINED", "CANCELLED", "DOUBLE", ...UNKNOWN_STATES]);
const ORDER_STATES   = new Set(["PENDING", "COLLECT", "ABANDONED"]);
const SOURCES        = new Set(["device", "rest", "local"]);

const isUnknown = s => UNKNOWN_STATES.has(s);
const isCharged = s => s === "APPROVED" || s === "DOUBLE";
const isActive  = s => s === "IN_FLIGHT" || UNKNOWN_STATES.has(s);

const int = (lo, hi) => v => (Number.isInteger(v) && v >= lo && v <= hi) ? v : undefined;
const pat = (re)     => v => (typeof v === "string" && re.test(v)) ? v : undefined;
const oneOf = set    => v => (typeof v === "string" && set.has(v)) ? v : undefined;

/* The ONLY keys that may ever reach the disk, each with its value validator. A value that fails is dropped. */
const VALIDATORS = {
  ts:            int(1, 8.64e15),
  externalId:    pat(/^TBK[A-Za-z0-9]{4,24}-[1-9]$/),
  kioskOrderId:  pat(/^[A-Za-z0-9]{4,24}$/),
  attempt:       int(1, 9),
  quoteId:       pat(/^[A-Za-z0-9_-]{1,64}$/),
  amountCents:   int(0, 100000000),
  paidCents:     int(0, 100000000),                         // what the device says it actually charged, when that differs from amountCents (CR-003)
  taxCents:      int(0, 100000000),
  state:         v => (ATTEMPT_STATES.has(v) || ORDER_STATES.has(v)) ? v : undefined,
  responseCode:  pat(/^[A-Z_]{2,16}$/),                     // remotepay.ResponseCode: SUCCESS, FAIL, CANCEL, ...
  paymentResult: pat(/^[A-Z_]{2,20}$/),                     // payments.Result: SUCCESS, FAIL, VOIDED, ...
  paymentId:     pat(/^[A-Za-z0-9]{6,32}$/),
  shellOrderId:  pat(/^[A-Za-z0-9]{6,32}$/),
  cardBrand:     pat(/^[A-Za-z0-9 _.\-]{1,24}$/),
  entryMethod:   pat(/^[A-Za-z_]{2,24}$/),
  last4:         pat(/^\d{4}$/),
  createdAt:     int(1, 8.64e15),
  stateAt:       int(1, 8.64e15),
  taggedAt:      int(1, 8.64e15),
  ackedAt:       int(1, 8.64e15),                           // the owner acknowledged a DOUBLE (tools/pay-resolve.js ack-double)
  source:        oneOf(SOURCES),
};
const ALLOWED_KEYS = Object.freeze(Object.keys(VALIDATORS));

/** Allow-list serializer. Accepts only a plain object (never an SDK class instance); returns a new object with allow-listed, validated keys. */
function serialize(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) return out;   // an SDK object (Payment, SaleResponse...) is never serialized
  for (const k of ALLOWED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, k)) continue;
    const v = VALIDATORS[k](input[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Pull the journal-safe display/result fields out of an SDK Payment (duck-typed getters, each guarded). Output is a plain object for serialize(). */
function fromPayment(payment) {
  const out = {};
  if (!payment || typeof payment !== "object") return out;
  const g = (o, name) => { try { return (o && typeof o[name] === "function") ? o[name]() : undefined; } catch { return undefined; } };
  out.paymentResult = g(payment, "getResult");
  out.paymentId     = g(payment, "getId");
  const ord = g(payment, "getOrder");
  out.shellOrderId  = g(ord, "getId");
  const ct = g(payment, "getCardTransaction");
  out.cardBrand     = g(ct, "getCardType");
  out.entryMethod   = g(ct, "getEntryType");
  out.last4         = g(ct, "getLast4");
  return out;
}

const pad2 = n => String(n).padStart(2, "0");
const dayKey = ms => { const d = new Date(ms); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); };
const dayEndMs = key => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d + 1).getTime(); };   // local midnight after that day

/* ---- pure derivations over an order (shared with flex-pay.js, the routes and the tests) ---- */
function orderStatus(order) {
  const att = order.attempts;
  if (att.some(a => isCharged(a.state))) return "APPROVED";
  if (att.some(a => a.state === "IN_FLIGHT")) return "IN_FLIGHT";
  const unk = att.filter(a => isUnknown(a.state));
  if (unk.length) return unk[unk.length - 1].state;
  if (order.abandonedAt) return "ABANDONED";
  if (order.collectAt) return "COLLECT";
  if (att.length) return att[att.length - 1].state;           // DECLINED or CANCELLED
  return "PENDING";
}
/**
 * What the kiosk order should say in Clover, derived from the journal. PAID dominates: nothing can downgrade a paid order.
 * The journal is a hint, not evidence (security review Q1): when isVerified is given, an approval counts for PAID only if
 * isVerified(attempt) says this process saw device or REST evidence for it. A charged-by-the-journal's-word-only order returns null
 * (write nothing yet) rather than falling through to a CHECK or COLLECT tag.
 */
function desiredTag(order, isVerified) {
  const charged = order.attempts.filter(a => isCharged(a.state));
  const paid = isVerified ? charged.filter(isVerified) : charged;
  if (paid.length) {
    return { kind: "PAID", paymentId: paid[0].paymentId || null,
             shells: paid.filter(a => a.shellOrderId).map(a => a.shellOrderId) };
  }
  if (charged.length) return null;
  if (order.attempts.some(a => isUnknown(a.state))) return { kind: "CHECK" };
  if (order.collectAt && !order.abandonedAt) return { kind: "COLLECT" };
  return null;
}
const needsTag = order => !!desiredTag(order) && !(order.taggedAt >= order.changedAt);
const orderNeedsWork = order => order.attempts.some(a => isActive(a.state) || a.state === "DOUBLE") || needsTag(order);

/* ---- process lock (NEW-1): only one process may hold the journal ----
   .tb/pay-journal.lock holds the PID of the kiosk server that has the journal open. It is written when the server starts its pay code and removed at
   shutdown (exit, SIGINT, SIGTERM). A lock whose PID is not running is "stale" (the server was killed). tools/pay-resolve.js refuses to write the
   journal while a live holder exists, because a running server never re-reads the file and would overwrite the owner's decision. */
const LOCK_NAME = "pay-journal.lock";
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }       // EPERM: it exists but is not ours
}
/** -> { state: "none" | "live" | "stale", pid } */
function lockStatus(dir) {
  let pid = null;
  try { pid = parseInt(fs.readFileSync(path.join(dir, LOCK_NAME), "utf8").trim(), 10); } catch (e) { if (e.code === "ENOENT") return { state: "none", pid: null }; }
  if (!Number.isInteger(pid)) return { state: "stale", pid: null };                          // unreadable lock: nobody can be trusted to hold it
  if (pid === process.pid) return { state: "own", pid };
  return { state: pidAlive(pid) ? "live" : "stale", pid };
}
const _heldLocks = new Set();
/** Take the lock for this process (overwrites a stale one). Released automatically at exit and on SIGINT/SIGTERM. */
function acquireLock(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lockStatus(dir);
  if (st.state === "live") throw new Error(`the pay journal is already held by process ${st.pid}`);
  fs.writeFileSync(path.join(dir, LOCK_NAME), String(process.pid) + "\n", { mode: 0o600 });
  if (!_heldLocks.size) {
    const rel = () => { for (const d of _heldLocks) { try { if (lockStatus(d).state === "own") fs.unlinkSync(path.join(d, LOCK_NAME)); } catch {} } _heldLocks.clear(); };
    process.on("exit", rel);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { rel(); process.exit(128); });
  }
  _heldLocks.add(dir);
}
function releaseLock(dir) { try { if (lockStatus(dir).state === "own") fs.unlinkSync(path.join(dir, LOCK_NAME)); } catch {} _heldLocks.delete(dir); }

/* ---- the journal ---- */
function createJournal(opts) {
  const dir       = opts.dir;
  const now       = opts.now || Date.now;
  const maxBytes  = opts.maxBytes || 50 * 1024 * 1024;
  const retention = opts.retentionMs == null ? 30 * 864e5 : opts.retentionMs;
  const FILE      = path.join(dir, FILE_NAME);

  const attempts = new Map();     // externalId -> entry (folded)
  const orders   = new Map();     // kioskOrderId -> order
  let lastTs = 0, curDay = null, needNewline = false, corrupt = 0;

  /** Strictly increasing event time: two events never share a ts, so "tagged after the last change" is exact. */
  const tick = () => (lastTs = Math.max(now(), lastTs + 1));

  function orderOf(id) {
    let o = orders.get(id);
    if (!o) { o = { kioskOrderId: id, attempts: [], pendingAt: 0, collectAt: 0, abandonedAt: 0, taggedAt: 0, changedAt: 0 }; orders.set(id, o); }
    return o;
  }

  function fold(ev) {
    if (!ev.kioskOrderId || !ev.ts) return;
    const o = orderOf(ev.kioskOrderId);
    if (ev.externalId) {
      let e = attempts.get(ev.externalId);
      if (!e) {
        e = { externalId: ev.externalId, kioskOrderId: ev.kioskOrderId, createdAt: ev.createdAt || ev.ts, wasUnknown: false };
        attempts.set(ev.externalId, e);
        o.attempts.push(e);
        o.attempts.sort((a, b) => (a.attempt || 0) - (b.attempt || 0) || a.createdAt - b.createdAt);
      }
      for (const k of ALLOWED_KEYS) if (k !== "ts" && k !== "externalId" && k !== "kioskOrderId" && ev[k] !== undefined) e[k] = ev[k];
      e.updatedAt = ev.ts;
      if (isUnknown(ev.state)) e.wasUnknown = true;
      if (ev.state) o.changedAt = Math.max(o.changedAt, ev.ts);
    } else {
      if (ev.state === "PENDING")   o.pendingAt   = o.pendingAt || ev.ts;
      if (ev.state === "COLLECT")   { o.collectAt = ev.ts; o.changedAt = Math.max(o.changedAt, ev.ts); }
      if (ev.state === "ABANDONED") { o.abandonedAt = ev.ts; o.changedAt = Math.max(o.changedAt, ev.ts); }
      if (ev.taggedAt) o.taggedAt = Math.max(o.taggedAt, ev.taggedAt);
    }
    lastTs = Math.max(lastTs, ev.ts);
  }

  function listFiles() {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const rotated = names.map(n => ({ n, m: ROTATED_RE.exec(n) })).filter(x => x.m).sort((a, b) => (a.m[1] < b.m[1] ? -1 : 1)).map(x => ({ name: x.n, day: x.m[1] }));
    const files = rotated.slice();
    if (names.includes(FILE_NAME)) files.push({ name: FILE_NAME, day: null });
    return files;
  }

  /** Read every journal file (rotated first). A torn or corrupt line is skipped and counted, never fatal. */
  function load() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    attempts.clear(); orders.clear(); lastTs = 0; corrupt = 0;
    for (const f of listFiles()) {
      let text = "";
      try { text = fs.readFileSync(path.join(dir, f.name), "utf8"); } catch { continue; }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let raw; try { raw = JSON.parse(line); } catch { corrupt++; continue; }
        const ev = serialize(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null);   // re-validate: never trust the disk blindly
        if (!ev.ts || !ev.kioskOrderId) { corrupt++; continue; }
        fold(ev);
      }
      if (f.day === null) needNewline = text.length > 0 && !text.endsWith("\n");
    }
    try { curDay = dayKey(fs.statSync(FILE).mtimeMs); } catch { curDay = dayKey(now()); }
    return { attempts: attempts.size, orders: orders.size, corrupt };
  }

  function totalBytes() {
    let n = 0;
    for (const f of listFiles()) { try { n += fs.statSync(path.join(dir, f.name)).size; } catch {} }
    return n;
  }

  function rotateIfNeeded() {
    const today = dayKey(now());
    if (curDay === null) curDay = today;
    if (curDay === today) return;
    try {
      const st = fs.statSync(FILE);
      if (st.size > 0) {
        const target = path.join(dir, `pay-journal.${curDay}.jsonl`);
        if (fs.existsSync(target)) { fs.appendFileSync(target, fs.readFileSync(FILE)); fs.unlinkSync(FILE); }
        else fs.renameSync(FILE, target);
      }
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    curDay = today; needNewline = false;
  }

  function writeLine(line) {
    const fd = fs.openSync(FILE, "a", 0o600);
    try {
      if (needNewline) { fs.writeSync(fd, "\n"); needNewline = false; }
      fs.writeSync(fd, line + "\n");
      fs.fsyncSync(fd);                                   // durable before connector.sale() is called
    } finally { fs.closeSync(fd); }
  }

  /**
   * Append one event (allow-listed). Throws if it cannot be made durable, so the caller must NOT send a Sale.
   * @param {object} fields  plain object; unknown keys are dropped
   * @param {{newAttempt?: boolean}} [o]  newAttempt enforces the size cap (fail closed for NEW card attempts only)
   */
  function append(fields, o = {}) {
    const ev = serialize(fields);
    if (!ev.kioskOrderId) throw new Error("journal: kioskOrderId required");
    // a state that fails validation must never be silently dropped (a lost transition is a lost payment outcome)
    if (fields && fields.state !== undefined && ev.state === undefined) throw new Error("journal: bad attempt state");
    if (fields && fields.externalId !== undefined && ev.externalId === undefined) throw new Error("journal: bad externalId");
    if (ev.externalId) { if (ev.state !== undefined && !ATTEMPT_STATES.has(ev.state)) throw new Error("journal: bad attempt state"); }
    else if (!ORDER_STATES.has(ev.state) && !ev.taggedAt) throw new Error("journal: bad order event");
    ev.ts = tick();
    if (ev.state && !ev.stateAt && ATTEMPT_STATES.has(ev.state)) ev.stateAt = ev.ts;
    if (o.newAttempt) ev.createdAt = ev.ts;
    rotateIfNeeded();
    if (o.newAttempt && totalBytes() > maxBytes) {
      purge({ force: true });
      if (totalBytes() > maxBytes) throw new Error("journal: size cap reached, refusing a new attempt");
    }
    writeLine(JSON.stringify(ev));
    fold(ev);
    return ev.externalId ? attempts.get(ev.externalId) : orderOf(ev.kioskOrderId);
  }

  /** Register an order in this server's journal (idempotent). Pay routes act only on registered orders. */
  function registerOrder(kioskOrderId) {
    const o = orders.get(kioskOrderId);
    if (o && o.pendingAt) return o;
    return append({ kioskOrderId, state: "PENDING", source: "local" });
  }
  const markCollect   = (kioskOrderId, source = "local") => append({ kioskOrderId, state: "COLLECT", source });
  const markAbandoned = (kioskOrderId) => append({ kioskOrderId, state: "ABANDONED", source: "local" });
  /** Record that the order's Clover tag matching `mark` (a value from tick()) was written. */
  const markTagged    = (kioskOrderId, mark) => append({ kioskOrderId, taggedAt: mark });

  /**
   * Delete rotated files older than the retention window whose attempts and orders are ALL resolved.
   * force=true (size cap) ignores the age but never the "all resolved" rule.
   */
  function purge(o = {}) {
    const cutoff = now() - retention;
    let removed = 0;
    for (const f of listFiles()) {
      if (!f.day) continue;
      if (!o.force && dayEndMs(f.day) > cutoff) continue;
      let text = ""; try { text = fs.readFileSync(path.join(dir, f.name), "utf8"); } catch { continue; }
      let keep = false;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (!ev || typeof ev !== "object") continue;
        const od = typeof ev.kioskOrderId === "string" ? orders.get(ev.kioskOrderId) : null;
        if (od && orderNeedsWork(od)) { keep = true; break; }
      }
      if (keep) continue;
      try { fs.unlinkSync(path.join(dir, f.name)); removed++; } catch {}
    }
    if (removed) {
      // drop purged-away resolved orders from memory so it matches the disk (a reload would not see them)
      const live = new Set();
      for (const f of listFiles()) { try { for (const line of fs.readFileSync(path.join(dir, f.name), "utf8").split("\n")) { if (!line.trim()) continue; try { const ev = JSON.parse(line); if (ev && typeof ev.kioskOrderId === "string") live.add(ev.kioskOrderId); } catch {} } } catch {} }
      for (const [id, od] of orders) if (!live.has(id) && !orderNeedsWork(od)) { for (const a of od.attempts) attempts.delete(a.externalId); orders.delete(id); }
    }
    return { removed };
  }

  return {
    load, append, registerOrder, markCollect, markAbandoned, markTagged, purge, tick,
    get: id => attempts.get(id) || null,
    order: id => orders.get(id) || null,
    orders: () => [...orders.values()],
    attemptsFor: id => { const o = orders.get(id); return o ? o.attempts.slice() : []; },
    active: () => [...attempts.values()].filter(a => isActive(a.state)),
    doubles: () => [...attempts.values()].filter(a => a.state === "DOUBLE" && !a.ackedAt),
    ordersNeedingTag: () => [...orders.values()].filter(needsTag),
    stats: () => ({ attempts: attempts.size, orders: orders.size, corrupt, bytes: totalBytes(), file: FILE }),
    dir, FILE,
  };
}

module.exports = {
  createJournal, acquireLock, releaseLock, lockStatus, LOCK_NAME, serialize, fromPayment, orderStatus, desiredTag, needsTag, orderNeedsWork,
  isUnknown, isCharged, isActive, ALLOWED_KEYS, ATTEMPT_STATES, ORDER_STATES, UNKNOWN_STATES, FILE_NAME, dayKey,
};
