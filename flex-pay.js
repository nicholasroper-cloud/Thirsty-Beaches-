/* =============================================================================
   flex-pay.js — Thirsty Beaches kiosk: persistent Flex WSS connection, the
   journaled payment state machine, and the reconcile routine (Clover Secure
   Network Pay Display, remote-pay-cloud 4.1.2).

   Purpose: owns the single, long-lived WebSocket Secure connection to the Clover
   Flex (LAN-direct via the remote-pay-cloud SDK) and guarantees that a card is
   never charged twice and a charged order is never lost. Design: ADR
   2026-11-15-adr-tap-to-pay-redesign.md sections 2, 3, 6 and 7.

   Exports:
     init(cfg, deps)   connect, load the journal, replay it, start the reconcile loop
     status()          { state, flexSerial, unresolved } for GET /pay/status
     pay(opts)         attempt-scoped sale; resolves (never rejects) with a typed result
     collect/canAbandon/markAbandoned/orderState/registerOrder   order-level helpers for the routes
     reconcile()       the ADR section 6 routine (also runs on a 15 s timer)
     buildSaleRequest  the ADR section 2 SaleRequest builder (unit-tested against the real SDK)

   The state machine in one paragraph. An order's card attempts are journaled
   (pay-journal.js, fsync) BEFORE connector.sale(). The ExternalId is
   TBK<kioskOrderId>-<attempt>, new per attempt (the Flex rejects back-to-back
   identical ids). APPROVED needs ResponseCode SUCCESS AND payment result SUCCESS,
   matched by externalPaymentId. At PAY_TIMEOUT_MS the module asks the device
   (retrievePayment), cancels the prompt (ESC) and resets the reader before it will
   say "not charged"; anything it cannot prove is UNKNOWN, which locks the order
   against a second charge. A late SUCCESS for any non-approved attempt is accepted.
   Only APPROVED is ever cached; every other terminal state is cleared after reconcile.

   Dependencies (loaded only when init() runs, never when PAY_ENABLED=false):
     remote-pay-cloud@4.1.2, remote-pay-cloud-api@4.0.5, ws@^8

   Security notes:
     - The module never sees raw card data. Only last4, card brand, entry method,
       result and ids are extracted (pay-journal.js fromPayment + allow-list).
     - Refunds are explicitly refused: the kiosk is NOT the refund path.
     - Kill switch (PAY_ENABLED / pay-off.flag / remote payEnabled:false) stops NEW sales
       only (cfg.payAllowed). Reconcile, late approvals and journal writes never stop.
     - Pairing auth token is written to PAIRING_FILE (not kiosk-config.env).

   OS prerequisite (not code): the Clover Device Server Root CA must be trusted by
   Node on the kiosk PC before WSS will succeed (see the real-Flex prerequisites).
   ============================================================================= */

"use strict";

const fs   = require("fs");
const path = require("path");
const J    = require("./pay-journal");

// ---- timing (ADR section 3 and 6); cfg.timing may shorten them in tests ----
const DEFAULT_TIMING = {
  PAY_TIMEOUT_MS: 60000,     // reader prompt budget before recovery starts
  EXTENSION_MS:   30000,     // one extension when the device says IN_PROGRESS (customer mid-PIN)
  CANCEL_WAIT_MS: 5000,      // wait for the CANCEL response after ESC
  ANSWER_MS:      10000,     // a device query that gets no answer in this time is "no answer"
  RECONCILE_MS:   15000,     // reconcile loop
  REST_AFTER_MS:  60000,     // device unreachable this long -> REST may supply POSITIVE evidence
};
const MAX_ATTEMPTS = 3;
const EXTERNAL_ID_RE = /^TBK([A-Za-z0-9]{4,24})-([1-9])$/;
const ORDER_ID_RE = /^[A-Za-z0-9]{4,24}$/;

// ---- module-level state ----
/** @type {"disabled"|"connecting"|"connected"|"ready"|"offline"} */
let _state = "disabled";
let _flexSerial = null;
let _connector = null;
let _cfg = null;
let _deps = {};
let _t = { ...DEFAULT_TIMING };
let _journal = null;
let _connSeq = 0;                 // bumped on every disconnect: in-progress recoveries notice and stop
let _downSince = 0;               // when the device last went away (0 = up); gates the REST fallback
let _reconcileTimer = null;
let _reconciling = false;
let _backoffIdx = 0;
let _reconnectTimer = null;

/** runtime per externalId: { waiters, timer, recovering, extended, cancelAck, connSeq } (journal holds the durable part) */
const _rt = new Map();
const _waiters = { payment: [], status: [], reset: [] };
const _verified = new Set();      // externalIds proven in THIS process by device or REST evidence. The journal alone is never evidence (Q1).
const _tagState = new Map();      // kioskOrderId -> { running, again }
const _tagWarned = new Map();     // kioskOrderId -> last warn time (throttle)

const BACKOFF_MS = [2000, 5000, 15000, 30000];
const now = () => (_deps.now ? _deps.now() : Date.now());
const log  = (...a) => console.log("[flex-pay]", ...a);
const warn = (...a) => console.warn("[flex-pay]", ...a);
const fail = (...a) => console.error("[flex-pay]", ...a);
const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

module.exports = {
  init, shutdown, status, pay, collect, canAbandon, markAbandoned, orderState, registerOrder, reconcile, buildSaleRequest,
  _internals: { loadSdk: () => _requireSdk(), journal: () => _journal, rt: _rt },
};

// =============================================================================
// ADR section 2: the SaleRequest
// =============================================================================

/**
 * CardEntryMethods: the real values are statics on the dist class (the ADR's runtime check). Loaded from the dist file first,
 * the SDK facade second, and the three numbers are asserted so a library change fails closed instead of enabling manual entry.
 */
function _cardEntryMethods(sdk) {
  let CEM = null;
  try { CEM = require("remote-pay-cloud/dist/com/clover/remote/client/CardEntryMethods.js").CardEntryMethods; } catch (e) { /* fall through */ }
  if (!CEM || typeof CEM.CARD_ENTRY_METHOD_NFC_CONTACTLESS !== "number") CEM = sdk && sdk.CardEntryMethods;
  const nfc = CEM && CEM.CARD_ENTRY_METHOD_NFC_CONTACTLESS, icc = CEM && CEM.CARD_ENTRY_METHOD_ICC_CONTACT, mag = CEM && CEM.CARD_ENTRY_METHOD_MAG_STRIPE;
  if (nfc !== 33796 || icc !== 33282 || mag !== 33025) throw new Error(`CardEntryMethods constants changed (nfc=${nfc} icc=${icc} mag=${mag}): re-verify before enabling pay`);
  return nfc | icc | mag;                   // tap, insert, swipe. Never MANUAL at a kiosk
}

const REQUIRED_SALE_SETTERS = ["setAmount", "setExternalId", "setTipMode", "setTipAmount", "setTaxAmount", "setCardEntryMethods",
  "setAllowOfflinePayment", "setForceOfflinePayment", "setApproveOfflinePaymentWithoutPrompt", "setDisableRestartTransactionOnFail",
  "setDisableDuplicateChecking", "setAutoAcceptSignature", "setDisableCashback", "setDisablePrinting", "setDisableReceiptSelection"];

/**
 * Build the Sale for one attempt. Verified against remote-pay-cloud 4.1.2 at runtime: there is NO setTransactionSettings on SaleRequest
 * (tip is setTipMode with payments.TipMode.NO_TIP from remote-pay-cloud-api), and the setter list is checked before use.
 * @param {{remotepay, payments, CardEntryMethods?}} sdk
 * @param {{externalId: string, amountCents: number, taxCents?: number}} p
 */
function buildSaleRequest(sdk, { externalId, amountCents, taxCents }) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("amountCents must be a positive integer");
  if (typeof externalId !== "string" || !/^[A-Za-z0-9-]{1,32}$/.test(externalId)) throw new Error("externalId must be 1..32 chars of [A-Za-z0-9-]");
  const tax = Number.isInteger(taxCents) && taxCents >= 0 ? taxCents : 0;
  const cardEntry = _cardEntryMethods(sdk);
  const r = new sdk.remotepay.SaleRequest();
  for (const m of REQUIRED_SALE_SETTERS) if (typeof r[m] !== "function") throw new Error(`SaleRequest.${m} is missing in this SDK version`);
  if (!sdk.payments || !sdk.payments.TipMode || sdk.payments.TipMode.NO_TIP === undefined) throw new Error("payments.TipMode.NO_TIP is missing in this SDK version");
  r.setAmount(amountCents);                                   // server-held order total, never from the page
  r.setExternalId(externalId);                                // attempt-scoped: the binding and the device-side idempotency
  r.setTipMode(sdk.payments.TipMode.NO_TIP);                  // replaces the nonexistent setTransactionSettings
  r.setTipAmount(0);
  r.setTaxAmount(tax);                                        // reporting only: verify in real-Flex test A that it does not raise the charge
  r.setCardEntryMethods(cardEntry);
  r.setAllowOfflinePayment(false);                            // offline approvals are invisible to REST and can decline later
  r.setForceOfflinePayment(false);
  r.setApproveOfflinePaymentWithoutPrompt(false);
  r.setDisableRestartTransactionOnFail(true);                 // one attempt = one outcome; the kiosk owns retry
  r.setDisableDuplicateChecking(false);                       // keep Clover's duplicate challenge; the listener rejects it
  r.setAutoAcceptSignature(true);
  r.setDisableCashback(true);
  r.setDisablePrinting(true);                                 // faster tap; receipts at the window (owner decision)
  r.setDisableReceiptSelection(true);
  return r;
}

function _cancelOption(sdk) {
  // CloverConnector.CANCEL_INPUT_OPTION only exists after a connector has been constructed; build the same ESC option directly.
  const io = new sdk.remotemessage.InputOption();
  io.setKeyPress(sdk.remotemessage.KeyPress.ESC);
  io.setDescription("Cancel");
  return io;
}

// =============================================================================
// init / status / shutdown
// =============================================================================

/**
 * @param {{ FLEX_IP, FLEX_PORT, FLEX_SCHEME, POS_NAME, PAIRING_FILE, PAY_TIMEOUT_MS, JOURNAL_DIR, payAllowed: () => boolean, timing?: object }} cfg
 * @param {{ journal?, connectorFactory?, sdk?, tagOrder?, restFindPayments?, now? }} [deps]  injection points (the real server passes tagOrder and restFindPayments; tests pass fakes)
 */
function init(cfg, deps = {}) {
  _resetRuntime();
  _cfg = cfg; _deps = deps;
  _t = { ...DEFAULT_TIMING, ...(cfg.timing || {}) };
  if (cfg.PAY_TIMEOUT_MS) _t.PAY_TIMEOUT_MS = cfg.PAY_TIMEOUT_MS;
  _state = "connecting"; _backoffIdx = 0; _downSince = now();
  try {
    _journal = deps.journal || J.createJournal({ dir: cfg.JOURNAL_DIR, now: deps.now });
    if (!deps.journal) { const st = _journal.load(); log(`journal loaded: ${st.attempts} attempts, ${st.orders} orders${st.corrupt ? `, ${st.corrupt} unreadable line(s) skipped` : ""}`); }
  } catch (e) {
    _state = "disabled";
    fail(`CRITICAL: pay journal unavailable (${e.message}). Tap-to-pay is disabled: no sale may be sent without a journal.`);
    throw e;
  }
  _replayAtBoot();
  _reconcileTimer = setInterval(() => { reconcile("timer").catch(e => fail("reconcile error:", e.message)); }, _t.RECONCILE_MS);
  if (_reconcileTimer.unref) _reconcileTimer.unref();
  reconcile("boot").catch(e => fail("reconcile error:", e.message));
  _connectNow();
}

/** Stop timers (tests, graceful exit). The journal on disk is already durable. */
function shutdown() { _resetRuntime(); _state = "disabled"; }

function _resetRuntime() {
  clearInterval(_reconcileTimer); _reconcileTimer = null;
  clearTimeout(_reconnectTimer); _reconnectTimer = null;
  for (const rt of _rt.values()) clearTimeout(rt.timer);
  _rt.clear();
  for (const k of Object.keys(_waiters)) { for (const w of _waiters[k]) { clearTimeout(w.timer); } _waiters[k].length = 0; }
  _tagState.clear(); _tagWarned.clear(); _verified.clear();
  _reconciling = false; _connSeq++;
}

function status() {
  return { state: _state, flexSerial: _flexSerial, unresolved: _journal ? _journal.active().length : 0 };
}

/** A process that died with a sale in flight cannot know the outcome: every IN_FLIGHT entry becomes UNKNOWN (and its order is locked) until the device answers. */
function _replayAtBoot() {
  for (const e of _journal.active()) {
    if (e.state === "IN_FLIGHT") {
      log(`boot replay: ${e.externalId} was IN_FLIGHT when the server stopped -> DISCONNECTED_UNKNOWN`);
      _transition(e, "DISCONNECTED_UNKNOWN", { source: "local" });
    }
  }
}

// =============================================================================
// pay()
// =============================================================================

/**
 * Start one card attempt. Resolves (never rejects) with { result, ... } where result is one of
 * approved | declined | cancelled | error | unknown | blocked-unknown | busy | unavailable | mismatch.
 * Kill switch: cfg.payAllowed() is checked here and the answer is "unavailable" (new sales only).
 *
 * @param {{ orderId: string, amountCents: number, taxCents?: number, quoteId?: string }} opts
 */
function pay(opts) {
  try { return _pay(opts || {}); }
  catch (e) { fail(`pay: unexpected error: ${e && e.message}`); return Promise.resolve({ result: "error", message: "pay failed to start" }); }
}

function _pay({ orderId, amountCents, taxCents, quoteId }) {
  const done = r => Promise.resolve(r);
  if (!_journal) return done({ result: "unavailable", message: "pay journal not ready" });
  if (typeof orderId !== "string" || !ORDER_ID_RE.test(orderId)) return done({ result: "mismatch", message: "bad order id" });
  const order = _journal.order(orderId);
  if (!order || !order.pendingAt) return done({ result: "mismatch", message: "unknown order" });   // only orders registered in this server's journal

  // Idempotent answers first: they need no device and never start a Sale
  const charged = order.attempts.find(a => J.isCharged(a.state));
  if (charged) return done({ ..._resultFor(charged), cached: true });            // only APPROVED is cached
  if (order.abandonedAt) return done({ result: "mismatch", message: "order was abandoned" });
  if (order.collectAt) return done({ result: "unavailable", message: "order is pay-at-window" });
  if (order.attempts.some(a => a.state === "IN_FLIGHT")) return done({ result: "busy", message: "payment already in progress for this order" });
  if (order.attempts.some(a => J.isUnknown(a.state))) return done({ result: "blocked-unknown", message: "checking the earlier payment; do not pay again" });
  // Kill switch (PAY_ENABLED + pay-off.flag + remote payEnabled): stops NEW sales only. Everything above is journal-only and still answers.
  if (typeof _cfg.payAllowed !== "function" || !_cfg.payAllowed()) return done({ result: "unavailable", message: "card payments are off" });
  if (_state !== "ready") { log(`sale rejected: device ${_state} (orderId=${orderId})`); return done({ result: "unavailable", message: `device ${_state}` }); }
  // One reader: any other order still IN_FLIGHT or UNKNOWN keeps the reader (an unresolved prompt may still be live on it)
  for (const a of _journal.active()) if (a.kioskOrderId !== orderId) { log(`sale rejected: reader busy with ${a.externalId}`); return done({ result: "busy", message: "reader busy with another order" }); }
  if (order.attempts.length >= MAX_ATTEMPTS) return done({ result: "unavailable", message: "attempt limit reached; pay at the window" });

  const attempt = order.attempts.reduce((m, a) => Math.max(m, a.attempt || 0), 0) + 1;
  const externalId = `TBK${orderId}-${attempt}`;
  if (externalId.length > 32 || !EXTERNAL_ID_RE.test(externalId)) return done({ result: "mismatch", message: "order id does not fit an ExternalId" });
  const sdk = _requireSdk();
  if (!sdk) return done({ result: "unavailable", message: "SDK not loaded" });
  const tax = Number.isInteger(taxCents) && taxCents >= 0 ? taxCents : 0;

  let saleReq;
  try { saleReq = buildSaleRequest(sdk, { externalId, amountCents, taxCents: tax }); }
  catch (e) { fail(`pay: ${e.message}`); return done({ result: "error", message: "sale could not be built" }); }

  return new Promise(resolve => {
    let entry = null, called = false;
    try {
      // journal (fsync) BEFORE the Sale: if this throws, nothing was sent
      entry = _journal.append({ externalId, kioskOrderId: orderId, attempt, quoteId, amountCents, taxCents: tax, state: "IN_FLIGHT", source: "local" }, { newAttempt: true });
      const rt = _runtime(externalId);
      rt.waiters.push(resolve); rt.connSeq = _connSeq;
      rt.timer = setTimeout(() => _onPayTimeout(externalId), _t.PAY_TIMEOUT_MS);
      log(`Sale -> ${externalId} amount=${amountCents}c`);
      called = true;
      _connector.sale(saleReq);
    } catch (e) {
      fail(`pay: ${called ? "connector.sale threw" : "could not start the sale"}: ${e && e.message}`);
      if (entry) {
        const cur = _journal.get(externalId);
        if (cur && cur.state === "IN_FLIGHT") {
          if (called) _transition(cur, "DISCONNECTED_UNKNOWN", { source: "local" });                 // the request may have left: unproven, lock the order
          else _transition(cur, "CANCELLED", { source: "local" });                                    // never reached the SDK: provably not charged ("deleted")
        }
      }
      resolve(entry ? _resultFor(_journal.get(externalId)) : { result: "error", message: "payment could not be started" });
    }
  });
}

function _runtime(externalId) {
  let rt = _rt.get(externalId);
  if (!rt) { rt = { waiters: [], timer: null, recovering: false, extended: false, cancelAck: null, connSeq: _connSeq }; _rt.set(externalId, rt); }
  return rt;
}

function _onPayTimeout(externalId) {
  const e = _journal.get(externalId);
  if (!e || e.state !== "IN_FLIGHT") return;
  const rt = _rt.get(externalId); if (rt) rt.timer = null;           // fired: from now on reconcile may also pick this attempt up
  warn(`Sale timeout (${_t.PAY_TIMEOUT_MS}ms) ${externalId}: asking the device before saying anything`);
  _recover(e, { reason: "timeout" }).catch(err => fail("recovery error:", err.message));
}

function _resultFor(e) {
  if (!e) return { result: "error", message: "unknown attempt" };
  switch (e.state) {
    case "APPROVED": case "DOUBLE":
      return { result: "approved", paymentId: e.paymentId || null, last4: e.last4 || null, cardBrand: e.cardBrand || null, double: e.state === "DOUBLE" };
    case "DECLINED": return { result: "declined", message: "card was declined" };
    case "CANCELLED":
      return (e.responseCode === "ERROR" || e.responseCode === "UNSUPPORTED")
        ? { result: "error", message: "reader or transaction error" } : { result: "cancelled", message: "payment was cancelled" };
    case "TIMEOUT_UNKNOWN": case "DISCONNECTED_UNKNOWN":
      return { result: "unknown", message: "checking your payment; do not pay again" };
    default: return { result: "busy", message: "payment in progress" };
  }
}

// =============================================================================
// journal transitions (the only place a state changes)
// =============================================================================

/**
 * Move an attempt to a new state. Rules: an approved attempt never changes (only APPROVED is final); a settled DECLINED or CANCELLED
 * attempt changes only to APPROVED (a late approval is always accepted); an APPROVED that finds another charge on the same order, or an
 * order already sent to the window, is recorded as DOUBLE so the owner can void one.
 */
function _transition(entry, state, patch = {}) {
  const cur = _journal.get(entry.externalId) || entry;
  if (J.isCharged(cur.state)) return cur;
  let next = state;
  if (state === "APPROVED") {
    const order = _journal.order(cur.kioskOrderId);
    if (order && (order.attempts.some(a => a !== cur && J.isCharged(a.state)) || order.collectAt)) next = "DOUBLE";
  }
  if ((cur.state === "DECLINED" || cur.state === "CANCELLED") && next !== "APPROVED" && next !== "DOUBLE") return cur;
  if (cur.state === next && !Object.keys(patch).length) return cur;
  let e;
  try { e = _journal.append({ externalId: cur.externalId, kioskOrderId: cur.kioskOrderId, state: next, ...patch }); }
  catch (err) {
    // The outcome could not be made durable. Keep the process correct in memory and shout: a restart would replay the older state.
    fail(`CRITICAL: journal write failed for ${cur.externalId} -> ${next}: ${err.message}`);
    Object.assign(cur, patch, { state: next, stateAt: now() });
    e = cur;
  }
  if (next === "DOUBLE") fail(`DOUBLE CHARGE: ${cur.externalId} approved but order ${cur.kioskOrderId} already has a charge or went to the window: the owner must void one in the Dashboard`);
  _afterChange(e);
  return e;
}

function _afterChange(e) {
  const rt = _rt.get(e.externalId);
  if (rt && e.state !== "IN_FLIGHT") {
    clearTimeout(rt.timer); rt.timer = null;
    const ws = rt.waiters.splice(0);
    for (const w of ws) { try { w(_resultFor(e)); } catch {} }
    if (!J.isActive(e.state)) _rt.delete(e.externalId);                   // terminal: nothing is cached at runtime, the journal holds APPROVED
  }
  if (e.state !== "IN_FLIGHT") _kickTag(e.kioskOrderId);
}

/** Approval: needs payment result SUCCESS and a matching externalPaymentId. Anything else is NOT approval. */
function _approve(entry, payment, responseCode, source) {
  const f = J.fromPayment(payment);
  let pext; try { pext = payment && payment.getExternalPaymentId && payment.getExternalPaymentId(); } catch {}
  if (pext && pext !== entry.externalId) { warn(`approval ignored: payment externalPaymentId does not match ${entry.externalId}`); return false; }
  if (f.paymentResult !== "SUCCESS") return false;
  let amt; try { amt = payment.getAmount && payment.getAmount(); } catch {}
  if (Number.isInteger(amt) && amt !== entry.amountCents) warn(`approved amount ${amt} differs from the sale amount ${entry.amountCents} for ${entry.externalId}`);
  _verified.add(entry.externalId);                         // device evidence seen in this process
  if (J.isCharged(entry.state)) { _kickTag(entry.kioskOrderId); return true; }   // already approved (e.g. loaded from disk): this is the verification
  _transition(entry, "APPROVED", { ...f, ...(responseCode ? { responseCode } : {}), source });
  return true;
}

/** Proven not charged: DECLINED / CANCELLED. If the order had been UNKNOWN (locked CHECK) it is released to COLLECT so the window can take payment. */
function _settleNotCharged(entry, state, source, code) {
  const wasUnknown = entry.wasUnknown || J.isUnknown(entry.state);
  const rc = typeof code === "string" && /^[A-Z_]{2,16}$/.test(code) ? code : undefined;
  _transition(entry, state, { source, ...(rc ? { responseCode: rc } : {}) });
  if (wasUnknown) {
    const order = _journal.order(entry.kioskOrderId);
    if (order && !order.attempts.some(a => J.isCharged(a.state)) && !order.collectAt && !J.orderStatus(order).endsWith("_UNKNOWN")) {
      try { _journal.markCollect(entry.kioskOrderId, "local"); } catch (e) { fail(`could not journal COLLECT for ${entry.kioskOrderId}: ${e.message}`); }
      _kickTag(entry.kioskOrderId);
    }
  }
}

function _unknown(entry, state) {
  if (!state) return;
  const cur = _journal.get(entry.externalId);
  if (cur && cur.state === "IN_FLIGHT") _transition(cur, state, { source: "local" });
}

// =============================================================================
// ADR section 3 / 6: recovery (one attempt) and reconcile (all attempts)
// =============================================================================

function _query(entry) {
  return new Promise(resolve => {
    const w = { extId: entry.externalId, resolve };
    w.timer = setTimeout(() => { const i = _waiters.payment.indexOf(w); if (i >= 0) _waiters.payment.splice(i, 1); resolve({ status: "NO_ANSWER" }); }, _t.ANSWER_MS);
    if (w.timer.unref) w.timer.unref();
    _waiters.payment.push(w);
    try {
      const sdk = _requireSdk();
      const req = new sdk.remotepay.RetrievePaymentRequest();
      req.setExternalPaymentId(entry.externalId);
      _connector.retrievePayment(req);
    } catch (e) {
      clearTimeout(w.timer); const i = _waiters.payment.indexOf(w); if (i >= 0) _waiters.payment.splice(i, 1);
      resolve({ status: "NO_ANSWER" });
    }
  });
}

function _deviceStatus(replay) {
  return new Promise(resolve => {
    const w = { resolve };
    w.timer = setTimeout(() => { const i = _waiters.status.indexOf(w); if (i >= 0) _waiters.status.splice(i, 1); resolve(null); }, _t.ANSWER_MS);
    if (w.timer.unref) w.timer.unref();
    _waiters.status.push(w);
    try {
      const sdk = _requireSdk();
      const req = new sdk.remotepay.RetrieveDeviceStatusRequest();
      req.setSendLastMessage(!!replay);                  // a replayed SaleResponse comes back through onSaleResponse
      _connector.retrieveDeviceStatus(req);
    } catch (e) {
      clearTimeout(w.timer); const i = _waiters.status.indexOf(w); if (i >= 0) _waiters.status.splice(i, 1);
      resolve(null);
    }
  });
}

async function _deviceIdle() {
  if (_state !== "ready") return false;
  const s = await _deviceStatus(false);
  return !!s && s.state === "IDLE";
}

function _resetDevice() {
  return new Promise(resolve => {
    const w = { resolve };
    w.timer = setTimeout(() => { const i = _waiters.reset.indexOf(w); if (i >= 0) _waiters.reset.splice(i, 1); resolve(false); }, _t.ANSWER_MS);
    if (w.timer.unref) w.timer.unref();
    _waiters.reset.push(w);
    try { _connector.resetDevice(); } catch (e) { clearTimeout(w.timer); const i = _waiters.reset.indexOf(w); if (i >= 0) _waiters.reset.splice(i, 1); resolve(false); }
  });
}

/**
 * Prove what happened to one attempt, using the device as the only authority for "not charged".
 * reason: "timeout" (PAY_TIMEOUT_MS elapsed), "hint" (an unmatched Fail/Cancel/Error response arrived), "reconcile".
 * hint:   the ResponseCode string of that response, if any.
 */
async function _recover(entry, { reason, hint }) {
  const rt = _runtime(entry.externalId);
  if (rt.recovering) return;
  rt.recovering = true;
  const gen = _connSeq;
  const alive = () => { const c = _journal.get(entry.externalId); return !!c && J.isActive(c.state) && _connSeq === gen && _state === "ready"; };
  try {
    if (_state !== "ready") return;
    let q = await _query(entry);
    if (!alive()) return;
    if (q.status === "FOUND") return;                                           // _applyFound already moved the state
    if (q.status === "NO_ANSWER") return _unknown(entry, reason === "reconcile" ? null : "TIMEOUT_UNKNOWN");
    if (q.status === "IN_PROGRESS") {
      if (reason !== "timeout") return;                                         // the reader is still working: leave it, look again next tick
      if (rt.extended) return _unknown(entry, "TIMEOUT_UNKNOWN");
      rt.extended = true;                                                       // customer may be mid-PIN: one extension
      await sleep(_t.EXTENSION_MS);
      if (!alive()) return;
      q = await _query(entry);
      if (!alive()) return;
      if (q.status === "FOUND") return;
      if (q.status !== "NOT_FOUND") return _unknown(entry, "TIMEOUT_UNKNOWN");
    }
    // ---- NOT_FOUND ----
    if (hint && /^(FAIL|CANCEL|ERROR|UNSUPPORTED|DUPLICATE)$/.test(hint)) {
      // the reader itself told us the sale ended without a payment: confirm it is idle, then label it by what it said
      if (!(await _deviceIdle()) || !alive()) return;
      return _settleNotCharged(entry, hint === "FAIL" ? "DECLINED" : "CANCELLED", "device", hint);
    }
    // cancel the prompt (ESC) and wait for the CANCEL response; without one, reset the reader, then ask again
    const ack = new Promise(r => { rt.cancelAck = r; });
    try { _connector.invokeInputOption(_cancelOption(_requireSdk())); } catch (e) { warn(`cancel input failed: ${e.message}`); }
    const gotCancel = await Promise.race([ack.then(() => true), sleep(_t.CANCEL_WAIT_MS).then(() => false)]);
    rt.cancelAck = null;
    if (!alive()) return;
    if (!gotCancel) { await _resetDevice(); if (!alive()) return; }
    const q2 = await _query(entry);
    if (!alive()) return;
    if (q2.status === "FOUND") return;
    if (q2.status !== "NOT_FOUND") return _unknown(entry, "TIMEOUT_UNKNOWN");   // IN_PROGRESS or silence: not proven
    if (!(await _deviceIdle()) || !alive()) return _unknown(entry, "TIMEOUT_UNKNOWN");   // NOT_FOUND counts only when the reader is IDLE
    return _settleNotCharged(entry, "CANCELLED", "device", "CANCEL");
  } catch (e) {
    fail(`recovery of ${entry.externalId} failed: ${e.message}`);
  } finally { rt.recovering = false; rt.cancelAck = null; }
}

/** FOUND from the device: SUCCESS approves (matched by externalPaymentId); a non-success payment settles the attempt as not charged. */
function _applyFound(entry, payment) {
  if (!payment) return;                                                         // FOUND without a payment proves nothing: look again later
  const f = J.fromPayment(payment);
  if (f.paymentResult === "SUCCESS") { _approve(entry, payment, undefined, "device"); return; }
  if (J.isCharged(entry.state)) return;                                          // a charged attempt is never settled "not charged" by a lookup
  if (J.isActive(entry.state) || entry.state === "DECLINED" || entry.state === "CANCELLED") {
    _settleNotCharged(entry, f.paymentResult === "FAIL" ? "DECLINED" : "CANCELLED", "device", undefined);
  }
}

/** ADR section 6. Device first; REST only as POSITIVE evidence; never stops, whatever the kill switch says. */
async function reconcile(trigger) {
  if (_reconciling || !_journal) return;
  _reconciling = true;
  try {
    const open = _journal.active().filter(_needsRecovery);
    if (open.length && _state === "ready") {
      log(`reconcile (${trigger}): ${open.length} unresolved attempt(s)`);
      await _deviceStatus(true);                                                // replay the last message through the normal handlers
      for (const e of _journal.active().filter(_needsRecovery)) {
        if (_state !== "ready") break;
        await _recover(e, { reason: "reconcile" });
      }
    } else if (open.length && _downSince && now() - _downSince > _t.REST_AFTER_MS && typeof _deps.restFindPayments === "function") {
      for (const e of open) await _restProbe(e);
    }
    for (const o of _journal.ordersNeedingTag()) {                                // title/lock writes retry until they succeed
      for (const a of o.attempts) if (J.isCharged(a.state) && !_verified.has(a.externalId)) await _verifyCharged(a);
      await _tagOnce(o.kioskOrderId);
    }
  } catch (e) { fail(`reconcile failed: ${e.message}`); }
  finally { _reconciling = false; }
}

/** Unknown attempts, and IN_FLIGHT ones this process is not actively waiting on. A live sale is owned by its own timeout. */
function _needsRecovery(e) {
  if (J.isUnknown(e.state)) return true;
  if (e.state !== "IN_FLIGHT") return false;
  const rt = _rt.get(e.externalId);
  return !rt || !rt.timer || rt.connSeq !== _connSeq;
}

/**
 * An approval loaded from the journal is a claim, not proof (Q1). Before TBK:PAID is written for it, ask the device (FOUND + SUCCESS) or,
 * with the device down, REST (SUCCESS, unvoided, matching id and amount). Without either, nothing is written and nothing is downgraded.
 */
async function _verifyCharged(entry) {
  if (_state === "ready") { await _query(entry); return; }                      // onRetrievePaymentResponse -> _applyFound -> _approve marks it verified
  if (_downSince && now() - _downSince > _t.REST_AFTER_MS && typeof _deps.restFindPayments === "function") await _restProbe(entry);
}

/** REST is allowed to say "yes, it was charged" (SUCCESS, not voided, matching id and amount) and nothing else. */
async function _restProbe(entry) {
  try {
    const list = await _deps.restFindPayments(entry.externalId);
    for (const p of Array.isArray(list) ? list : []) {
      if (!p || p.externalPaymentId !== entry.externalId) continue;
      const voids = p.voids && Array.isArray(p.voids.elements) ? p.voids.elements.length : 0;
      if (p.result !== "SUCCESS" || p.voided || voids > 0) continue;
      if (p.amount !== entry.amountCents) { warn(`REST payment for ${entry.externalId} has amount ${p.amount} (expected ${entry.amountCents}): not accepted as evidence`); continue; }
      log(`REST evidence: ${entry.externalId} was charged (payment ${String(p.id).slice(-4)})`);
      _verified.add(entry.externalId);
      if (J.isCharged(entry.state)) { _kickTag(entry.kioskOrderId); return; }
      _transition(entry, "APPROVED", {
        paymentResult: "SUCCESS", paymentId: p.id, shellOrderId: p.order && p.order.id,
        cardBrand: p.cardTransaction && p.cardTransaction.cardType, entryMethod: p.cardTransaction && p.cardTransaction.entryType,
        last4: p.cardTransaction && p.cardTransaction.last4, source: "rest",
      });
      return;
    }
    // no match / voided / error: that is NOT evidence of anything. The attempt stays unresolved.
  } catch (e) { warn(`REST probe for ${entry.externalId} failed: ${e.message}`); }
}

// =============================================================================
// Clover tags (title + lock), retried from the journal until they succeed
// =============================================================================

function _kickTag(orderId) {
  if (!_journal || typeof _deps.tagOrder !== "function") return;
  let st = _tagState.get(orderId);
  if (!st) { st = { running: false, again: false }; _tagState.set(orderId, st); }
  if (st.running) { st.again = true; return; }
  st.running = true;
  (async () => {
    try { do { st.again = false; await _tagOnce(orderId); } while (st.again); }
    catch (e) { fail(`tag job for ${orderId} failed: ${e.message}`); }
    finally { st.running = false; }
  })();
}

async function _tagOnce(orderId) {
  const order = _journal && _journal.order(orderId);
  if (!order || !J.needsTag(order) || typeof _deps.tagOrder !== "function") return;
  const mark = _journal.tick();                                // any journal change after this has a larger ts, so it will be tagged again
  const want = J.desiredTag(order, a => _verified.has(a.externalId));
  if (!want) return;                                                           // an unverified approval: wait for evidence
  const title = want.kind === "PAID" ? (want.paymentId ? `TBK:PAID:${want.paymentId}` : "TBK:PAID") : `TBK:${want.kind}`;
  try {
    await _deps.tagOrder({ kioskOrderId: orderId, kind: want.kind, title, lock: want.kind !== "COLLECT",
      shells: want.kind === "PAID" ? want.shells.map(id => ({ orderId: id, title: `TBK:SHELL:${orderId}` })) : [] });
  } catch (e) {
    const last = _tagWarned.get(orderId) || 0;
    if (now() - last > 5 * 60000) { _tagWarned.set(orderId, now()); warn(`could not write the ${want.kind} tag on order ${orderId} (will retry): ${e.message}`); }
    return;
  }
  try { _journal.markTagged(orderId, mark); } catch (e) { fail(`could not journal the tag marker for ${orderId}: ${e.message}`); }
}

// =============================================================================
// order-level helpers for the routes (pay-routes.js)
// =============================================================================

/** Register an order in this server's journal. Returns false when pay is not running (no journal): the caller then issues no payToken. */
function registerOrder(orderId) {
  if (!_journal || typeof orderId !== "string" || !ORDER_ID_RE.test(orderId)) return false;
  try { _journal.registerOrder(orderId); return true; } catch (e) { fail(`could not register order ${orderId}: ${e.message}`); return false; }
}

function orderState(orderId) {
  const order = _journal && _journal.order(orderId);
  if (!order || !order.pendingAt) return null;
  const status = J.orderStatus(order);
  const last = order.attempts.length ? order.attempts[order.attempts.length - 1] : null;
  const paid = order.attempts.find(a => J.isCharged(a.state));
  return { state: status, attempt: last ? last.attempt : 0, attempts: order.attempts.length,
           paymentId: paid ? paid.paymentId || null : null, last4: paid ? paid.last4 || null : null, cardBrand: paid ? paid.cardBrand || null : null };
}

/** "Pay at window". Refused while a card attempt is unresolved (the card may still be charged). */
function collect(orderId) {
  const order = _journal && _journal.order(orderId);
  if (!order || !order.pendingAt) return { result: "mismatch", message: "unknown order" };
  const charged = order.attempts.find(a => J.isCharged(a.state));
  if (charged) return { ..._resultFor(charged), cached: true };
  if (order.attempts.some(a => a.state === "IN_FLIGHT")) return { result: "busy", message: "payment in progress" };
  if (order.attempts.some(a => J.isUnknown(a.state))) return { result: "blocked-unknown", message: "checking your payment; do not pay again" };
  if (order.abandonedAt) return { result: "mismatch", message: "order was abandoned" };
  try { if (!order.collectAt) _journal.markCollect(orderId, "local"); } catch (e) { fail(`could not journal COLLECT: ${e.message}`); return { result: "error", message: "could not record pay-at-window" }; }
  _kickTag(orderId);
  return { result: "collect" };
}

/** May this order be deleted? PENDING, DECLINED or CANCELLED only, no charge in the journal, and the reader confirmed idle right now. */
async function canAbandon(orderId) {
  const order = _journal && _journal.order(orderId);
  if (!order || !order.pendingAt) return { ok: false, reason: "unknown order" };
  const status = J.orderStatus(order);
  if (!["PENDING", "DECLINED", "CANCELLED"].includes(status)) return { ok: false, reason: `order is ${status}` };
  if (order.collectAt || order.attempts.some(a => J.isCharged(a.state) || J.isActive(a.state))) return { ok: false, reason: "order has a live or charged attempt" };
  if (_state !== "ready") return { ok: false, reason: "reader not confirmed idle (device " + _state + ")" };
  if (!(await _deviceIdle())) return { ok: false, reason: "reader not idle" };
  const again = _journal.order(orderId);                                          // nothing may have started while we asked the reader
  if (!again || again.attempts.length !== order.attempts.length || again.attempts.some(a => J.isActive(a.state) || J.isCharged(a.state))) return { ok: false, reason: "order changed" };
  return { ok: true };
}
function markAbandoned(orderId) {
  try { _journal.markAbandoned(orderId); return true; } catch (e) { fail(`could not journal ABANDONED: ${e.message}`); return false; }
}

// =============================================================================
// connect / reconnect
// =============================================================================

function _connectNow() {
  const sdk = _requireSdk();
  if (!sdk) {
    _state = "disabled";
    fail("CRITICAL: remote-pay-cloud SDK not found. Run npm ci next to the server. Tap-to-pay is disabled.");
    return;
  }

  if (_deps.connectorFactory) {                              // tests: a fake connector, no sockets, no pairing
    _connector = _deps.connectorFactory({ sdk, cfg: _cfg });
    _connector.addCloverConnectorListener(_buildListener());
    _connector.initializeConnection();
    return;
  }

  const endpoint = `${_cfg.FLEX_SCHEME}://${_cfg.FLEX_IP}:${_cfg.FLEX_PORT}/remote_pay`;
  log(`connecting to ${endpoint}`);

  const { CloverConnector, WebSocketPairedCloverDeviceConfiguration, ImageUtil } = sdk;
  const NodeWebSocketImpl = _buildNodeWebSocketFactory();

  let storedAuthToken = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(_cfg.PAIRING_FILE, "utf8"));
    if (parsed && parsed.authToken) { storedAuthToken = parsed.authToken; log(`loaded pairing token (paired ${parsed.pairedAt || "unknown"})`); }
  } catch (e) {
    if (e.code !== "ENOENT") warn(`could not read pairing file: ${e.message}`);
  }

  const deviceConfig = new WebSocketPairedCloverDeviceConfiguration(
    endpoint,
    "com.thirstybeaches.kiosk:1.0.0",   // applicationId
    _cfg.POS_NAME,                       // posName (shown on Flex during pairing)
    "TB-Kiosk-01",                       // serialNumber (shown on Flex during pairing)
    storedAuthToken,                     // null on first pairing, token thereafter
    _onPairingCode,
    _onPairingSuccess,
    NodeWebSocketImpl,
    new ImageUtil(),
    5000,                                // heartbeatInterval ms
    3000,                                // reconnectDelay ms (we manage reconnect)
    3000                                 // heartbeatDisconnectTimeout ms
  );

  _connector = new CloverConnector(deviceConfig);
  _connector.addCloverConnectorListener(_buildListener());
  _connector.initializeConnection();
}

function _onPairingCode(pairingCode) {
  console.log("\n========================================");
  console.log(`  PAIRING CODE: ${pairingCode}`);
  console.log("  Enter this code on the Flex screen to complete pairing.");
  console.log("========================================\n");
}

function _onPairingSuccess(authToken) {
  log("pairing successful: persisting auth token");
  const record = { authToken, pairedAt: new Date().toISOString(), flexSerial: _flexSerial || "unknown" };
  try {
    fs.writeFileSync(_cfg.PAIRING_FILE, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
    log(`pairing token saved to ${_cfg.PAIRING_FILE}`);
  } catch (e) {
    fail(`FAILED to persist pairing token: ${e.message}: will need to re-pair on restart`);
  }
}

function _scheduleReconnect() {
  clearTimeout(_reconnectTimer);
  const delay = BACKOFF_MS[Math.min(_backoffIdx, BACKOFF_MS.length - 1)];
  _backoffIdx = Math.min(_backoffIdx + 1, BACKOFF_MS.length - 1);
  log(`reconnecting in ${delay / 1000}s…`);
  _reconnectTimer = setTimeout(() => { _state = "connecting"; _connectNow(); }, delay);
  if (_reconnectTimer.unref) _reconnectTimer.unref();
}

// =============================================================================
// SDK listener
// =============================================================================

function _flushWaiters() {
  for (const k of Object.keys(_waiters)) {
    for (const w of _waiters[k].splice(0)) { clearTimeout(w.timer); try { w.resolve(k === "payment" ? { status: "NO_ANSWER" } : (k === "reset" ? false : null)); } catch {} }
  }
}

function _buildListener() {
  const sdk = _requireSdk();
  const { remotepay } = sdk;
  const str = v => (v == null ? null : String(v));

  // A plain object implementing ICloverConnectorListener (the SDK calls these by name).
  // Every callback is wrapped: a throw inside one must never reach the SDK's socket thread or strand a payment.
  const safe = (name, fn) => (...a) => { try { return fn(...a); } catch (e) { fail(`${name} handler error: ${e && e.message}`); } };

  return {
    onDeviceConnected: safe("onDeviceConnected", () => { _state = "connected"; _backoffIdx = 0; log("device connected (waiting for ready)"); }),

    onDeviceReady: safe("onDeviceReady", merchantInfo => {
      _state = "ready"; _downSince = 0;
      _flexSerial = (merchantInfo && merchantInfo.deviceSerial) ? merchantInfo.deviceSerial : "unknown";
      log(`device READY: serial=${_flexSerial} merchant=${(merchantInfo && merchantInfo.merchantName) || "?"}`);
      reconcile("ready").catch(e => fail("reconcile error:", e.message));
    }),

    onDeviceDisconnected: safe("onDeviceDisconnected", () => {
      warn("device disconnected: entering offline state");
      _state = "offline"; _flexSerial = null; _connSeq++; _downSince = now();
      _flushWaiters();
      // A card may be mid-dip: the outcome is UNKNOWN, not "unavailable". The order is locked until the device or REST proves it.
      for (const e of _journal ? _journal.active() : []) {
        if (e.state === "IN_FLIGHT") {
          const rt = _rt.get(e.externalId); if (rt) { clearTimeout(rt.timer); rt.timer = null; }
          warn(`in-flight ${e.externalId} -> DISCONNECTED_UNKNOWN`);
          _transition(e, "DISCONNECTED_UNKNOWN", { source: "local" });
        }
      }
      _scheduleReconnect();
    }),

    onDeviceError: safe("onDeviceError", ev => {
      const msg = (ev && ev.getMessage && ev.getMessage()) || "unknown";
      fail(`device error: ${msg}`);
    }),

    onSaleResponse: safe("onSaleResponse", resp => _handleSaleResponse(resp, remotepay)),

    onRetrievePaymentResponse: safe("onRetrievePaymentResponse", resp => {
      const extId = str(resp.getExternalPaymentId && resp.getExternalPaymentId());
      const qs = str(resp.getQueryStatus && resp.getQueryStatus());
      const entry = extId ? _journal.get(extId) : null;
      if (entry && qs === "FOUND") _applyFound(entry, resp.getPayment && resp.getPayment());
      const i = _waiters.payment.findIndex(w => w.extId === extId);
      if (i >= 0) { const w = _waiters.payment.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve({ status: qs }); }
    }),

    onRetrieveDeviceStatusResponse: safe("onRetrieveDeviceStatusResponse", resp => {
      const w = _waiters.status.shift();
      if (w) { clearTimeout(w.timer); w.resolve({ state: str(resp.getState && resp.getState()) }); }
    }),

    onResetDeviceResponse: safe("onResetDeviceResponse", () => {
      const w = _waiters.reset.shift();
      if (w) { clearTimeout(w.timer); w.resolve(true); }
    }),

    // REQUIRED: must implement or sales hang when the Flex needs confirmation (partial authorisation, duplicate detection).
    // Kiosk policy: never accept a challenge (never accept less than the full amount, never accept a duplicate). The customer can retry.
    onConfirmPaymentRequest: safe("onConfirmPaymentRequest", request => {
      if (!request || !_connector) return;
      log("onConfirmPaymentRequest: rejecting the challenge (kiosk policy)");
      _connector.rejectPayment(request.getPayment(), request.getChallenges()[0]);
    }),

    // Signature is not required for EMV/NFC tap-to-pay, but the callback must be handled or the SDK may block.
    onVerifySignatureRequest: safe("onVerifySignatureRequest", request => {
      if (!request || !_connector) return;
      log("onVerifySignatureRequest: accepting (no signature at the kiosk)");
      _connector.acceptSignature(request);
    }),

    // Stubs for required listener interface methods
    onDeviceActivityStart() {}, onDeviceActivityEnd() {}, onMerchantInfo() {}, onAuthResponse() {}, onPreAuthResponse() {},
    onTipAdjustAuthResponse() {}, onCapturePreAuthResponse() {}, onVoidPaymentResponse() {}, onRefundPaymentResponse() {},
    onManualRefundResponse() {}, onRetrievePendingPaymentsResponse() {}, onReadCardDataResponse() {}, onCloseoutResponse() {},
    onCustomActivityResponse() {}, onDisplayReceiptOptionsResponse() {}, onInvalidStateTransitionResponse() {},
    onMessageFromActivity() {}, onPrintJobStatusResponse() {},
  };
}

/**
 * SaleResponse. A response WITH a payment carries our ExternalId and is matched to its attempt by that id, never by "first in flight".
 * Fail/Cancel/Duplicate responses from the SDK carry NO payment (and the SDK maps a duplicate to ResponseCode.CANCEL with the id only
 * in the message), so they are HINTS: they start a device check of the one attempt they can belong to, they never settle it on their own.
 */
function _handleSaleResponse(resp, remotepay) {
  const rc = String(resp && resp.getResult ? resp.getResult() : "");
  const payment = resp && resp.getPayment ? resp.getPayment() : null;
  let extId = null;
  try { extId = payment && payment.getExternalPaymentId ? payment.getExternalPaymentId() : null; } catch {}

  if (extId) {
    let entry = _journal.get(extId);
    if (!entry) {
      if (EXTERNAL_ID_RE.test(extId)) entry = _adoptOrphan(extId, payment, rc);
      else warn("onSaleResponse: a payment that is not ours (ignored)");
      if (!entry) return;
    }
    return _applyOutcome(entry, rc, payment, remotepay);
  }

  // no payment: try to name the attempt from the message (duplicate), then fall back to "the one attempt that can be waiting"
  let text = ""; try { text = `${resp.getMessage ? resp.getMessage() : ""} ${resp.getReason ? resp.getReason() : ""}`; } catch {}
  const named = (text.match(/TBK[A-Za-z0-9]{4,24}-[1-9]/g) || []).map(id => _journal.get(id)).find(Boolean);

  // a CANCEL while we are waiting for the ack of our own ESC: that IS the ack
  for (const e of _journal.active()) {
    const rt = _rt.get(e.externalId);
    if (rt && rt.cancelAck && (!named || named === e) && rc === "CANCEL") { const f = rt.cancelAck; rt.cancelAck = null; f(); return; }
  }
  const target = named || _soleLiveInFlight();
  if (!target) { warn(`onSaleResponse ${rc} with no payment and no attempt to attach it to (ignored)`); return; }
  if (J.isCharged(target.state)) return;
  log(`onSaleResponse ${rc} without a payment for ${target.externalId}: verifying with the device`);
  _recover(target, { reason: "hint", hint: rc || "ERROR" }).catch(e => fail("recovery error:", e.message));
}

function _soleLiveInFlight() {
  const live = _journal.active().filter(e => e.state === "IN_FLIGHT");
  return live.length === 1 ? live[0] : null;
}

function _applyOutcome(entry, rc, payment, remotepay) {
  if (J.isCharged(entry.state)) { log(`onSaleResponse for already-approved ${entry.externalId} ignored`); return; }
  let result; try { result = payment && payment.getResult ? payment.getResult() : null; } catch {}
  log(`onSaleResponse ${entry.externalId} result=${rc} paymentResult=${result}`);
  switch (rc) {
    case "SUCCESS":
      // Approved needs BOTH: ResponseCode SUCCESS and payment result SUCCESS. A SUCCESS code on a non-success payment proves nothing.
      if (!_approve(entry, payment, "SUCCESS", "device")) _recover(entry, { reason: "hint", hint: undefined }).catch(e => fail("recovery error:", e.message));
      return;
    case "FAIL":   return _settleNotCharged(entry, "DECLINED", "device", "FAIL");
    case "CANCEL": return _settleNotCharged(entry, "CANCELLED", "device", "CANCEL");
    default:       // ERROR, UNSUPPORTED, DUPLICATE and anything new: ask the device before concluding
      _recover(entry, { reason: "hint", hint: rc || "ERROR" }).catch(e => fail("recovery error:", e.message));
  }
}

/** A device payment for one of our ExternalIds that the journal has never heard of (journal lost). Only a proven SUCCESS is adopted. */
function _adoptOrphan(extId, payment, rc) {
  const m = EXTERNAL_ID_RE.exec(extId);
  const f = J.fromPayment(payment);
  if (!m || rc !== "SUCCESS" || f.paymentResult !== "SUCCESS") return null;
  let amt; try { amt = payment.getAmount(); } catch {}
  try {
    _journal.registerOrder(m[1]);
    fail(`CRITICAL: adopting an approved device payment ${extId} that is not in the journal`);
    return _journal.append({ externalId: extId, kioskOrderId: m[1], attempt: Number(m[2]), amountCents: Number.isInteger(amt) ? amt : undefined, state: "IN_FLIGHT", source: "device" }, { newAttempt: true });
  } catch (e) { fail(`could not adopt ${extId}: ${e.message}`); return null; }
}

// =============================================================================
// Node WebSocket factory for the SDK (unchanged behavior)
// =============================================================================

/**
 * The remote-pay-cloud SDK was authored browser-first. It expects a factory returning a CloverWebSocketInterface-compatible object.
 * We wrap the `ws` Node package in a thin shim that matches what the SDK expects.
 */
function _buildNodeWebSocketFactory() {
  const WebSocket = require("ws");
  const SDK = _requireSdk();
  const { CloverWebSocketInterface } = SDK;

  class NodeWebSocketImpl extends CloverWebSocketInterface {
    constructor(endpoint) { super(endpoint); }

    createWebSocket(endpoint, accessToken) {
      // rejectUnauthorized stays true: the Clover Root CA must be trusted by Node (NODE_EXTRA_CA_CERTS or --use-system-ca). Never disable it.
      const opts = { rejectUnauthorized: true };
      if (accessToken) return new WebSocket(endpoint, accessToken, opts);
      return new WebSocket(endpoint, opts);
    }

    sendPong() { try { if (this.webSocket && this.webSocket.readyState === WebSocket.OPEN) this.webSocket.pong(); } catch (e) { /* ignore */ } return this; }
    sendPing() { try { if (this.webSocket && this.webSocket.readyState === WebSocket.OPEN) this.webSocket.ping(); } catch (e) { /* ignore */ } return this; }
  }
  return (endpoint) => new NodeWebSocketImpl(endpoint);
}

// =============================================================================
// lazy SDK loader
// =============================================================================

let _sdkCache = null;
let _sdkLoadFailed = false;

function _requireSdk() {
  if (_deps && _deps.sdk) return _deps.sdk;
  if (_sdkCache) return _sdkCache;
  if (_sdkLoadFailed) return null;
  try {
    const sdk = require("remote-pay-cloud");
    if (!sdk.CloverConnector || !sdk.WebSocketPairedCloverDeviceConfiguration) throw new Error("SDK loaded but missing expected exports");
    const api = require("remote-pay-cloud-api");          // pinned explicitly in package.json (4.0.5)
    sdk.payments = api.payments;
    sdk.remotemessage = api.remotemessage;
    _sdkCache = sdk;
    log(`remote-pay-cloud SDK loaded (v${sdk.version || "?"})`);
    return sdk;
  } catch (e) {
    _sdkLoadFailed = true;
    fail(`failed to load remote-pay-cloud SDK: ${e.message}`);
    fail("Run: npm ci  (in the kiosk folder)");
    return null;
  }
}
