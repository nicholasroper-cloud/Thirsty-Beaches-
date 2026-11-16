// tests/kiosk/pay-state.js — flex-pay.js state machine against the REAL remote-pay-cloud 4.1.2 objects and a FAKE connector.
// No sockets, no Flex, no Clover. Covers ADR section 8 cases A to E, G, H in fake form, plus DUPLICATE, REST positive-only evidence,
// DOUBLE, the kill switch (new sales only), executor guards, the SaleRequest build against the real SDK, and journal hygiene.
// Run: node tests/kiosk/pay-state.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const fp = require("../../flex-pay");
const J = require("../../pay-journal");

const { sdk, api } = require("./pay-fakes");

let passed = 0, scenarios = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, ms = 3000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return; await sleep(10); }
  assert.fail("timed out waiting for " + what);
}
const mute = (() => { const o = { log: console.log, warn: console.warn, error: console.error }; return on => { for (const k of Object.keys(o)) console[k] = on ? () => {} : o[k]; }; })();

const { mkPayment, mkSale, mkRetrieve, mkStatus, FakeConnector } = require("./pay-fakes");

const TIMING = { PAY_TIMEOUT_MS: 150, EXTENSION_MS: 100, CANCEL_WAIT_MS: 80, ANSWER_MS: 300, RECONCILE_MS: 60, REST_AFTER_MS: 120 };
let orderSeq = 0;
const newOrderId = () => "ORDER" + String(++orderSeq).padStart(6, "0");

/** rig: a fresh (or reused) journal dir, a fake connector, a recording tagger, and flexPay initialised against them. */
function rig(opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), "tb-paystate-"));
  const r = { dir, fc: new FakeConnector(), allowed: true, tags: [], tagFail: 0, rest: opts.rest || null };
  r.journal = opts.journal || J.createJournal({ dir }); if (!opts.journal) r.journal.load();
  const deps = {
    journal: r.journal, sdk, connectorFactory: () => r.fc,
    tagOrder: async t => { r.tags.push(t); if (r.tagFail > 0) { r.tagFail--; throw new Error("clover 500"); } },
  };
  if (r.rest) deps.restFindPayments = async id => r.rest(id);
  if (opts.getOrder) deps.getOrder = opts.getOrder;
  fp.init({ FLEX_IP: "x", FLEX_PORT: 1, FLEX_SCHEME: "wss", POS_NAME: "t", PAIRING_FILE: "x", JOURNAL_DIR: dir, PAY_TIMEOUT_MS: (opts.timing && opts.timing.PAY_TIMEOUT_MS) || TIMING.PAY_TIMEOUT_MS,
    timing: { ...TIMING, ...(opts.timing || {}) }, payAllowed: () => r.allowed, ...(opts.cfgExtra || {}) }, deps);
  r.ready = () => { r.fc.listener.onDeviceConnected(); r.fc.listener.onDeviceReady({ deviceSerial: "C0TEST", merchantName: "Test" }); };
  r.disconnect = () => r.fc.listener.onDeviceDisconnected();
  r.order = (id = newOrderId()) => { fp.registerOrder(id); return id; };
  r.ext = (order, n = 1) => `TBK${order}-${n}`;
  r.respond = (rc, payment, msg) => r.fc.listener.onSaleResponse(mkSale(rc, payment, msg));
  r.state = ext => (r.journal.get(ext) || {}).state;
  r.lastTag = () => r.tags[r.tags.length - 1];
  return r;
}
async function scenario(name, fn) {
  scenarios++;
  mute(true);
  try { await fn(); } catch (e) { mute(false); console.error(`FAIL scenario "${name}"`); throw e; } finally { fp.shutdown(); mute(false); }
}

const keepAlive = setInterval(() => {}, 1000);   // flex-pay's own timers are unref'd (the real server's HTTP listener holds the loop open)
(async () => {
  /* ================= SaleRequest against the real SDK (ADR section 2) ================= */
  await scenario("SaleRequest build", async () => {
    const r = fp.buildSaleRequest(sdk, { externalId: "TBKAB12CD34EF56G-1", amountCents: 349, taxCents: 24 });
    eq(r.getExternalId(), "TBKAB12CD34EF56G-1"); eq(r.getAmount(), 349); eq(r.getTaxAmount(), 24); eq(r.getTipAmount(), 0);
    eq(r.getTipMode(), api.payments.TipMode.NO_TIP); eq(r.getTipMode(), "NO_TIP");
    eq(r.getCardEntryMethods(), 33796 | 33282 | 33025, "tap | insert | swipe, never manual");
    const MAN = require("remote-pay-cloud/dist/com/clover/remote/client/CardEntryMethods.js").CardEntryMethods;
    ok((r.getCardEntryMethods() & (MAN.CARD_ENTRY_METHOD_MANUAL & ~MAN.KIOSK_CARD_ENTRY_METHODS)) === 0, "no manual-entry bit");
    eq(r.getCardEntryMethods(), MAN.DEFAULT, "same as the SDK default: NFC | ICC | MAG, manual off");
    eq(r.getAllowOfflinePayment(), false); eq(r.getForceOfflinePayment(), false); eq(r.getApproveOfflinePaymentWithoutPrompt(), false);
    eq(r.getDisableRestartTransactionOnFail(), true); eq(r.getDisableDuplicateChecking(), false);
    eq(r.getAutoAcceptSignature(), true); eq(r.getDisableCashback(), true); eq(r.getDisablePrinting(), true); eq(r.getDisableReceiptSelection(), true);
    eq(typeof r.setTransactionSettings, "undefined", "SaleRequest has no setTransactionSettings in 4.1.2");
    eq(typeof new sdk.remotepay.SaleRequest().setTipMode, "function");
    // fail closed on bad input
    assert.throws(() => fp.buildSaleRequest(sdk, { externalId: "TBKX-1", amountCents: 0 }), /positive integer/); passed++;
    assert.throws(() => fp.buildSaleRequest(sdk, { externalId: "x".repeat(33), amountCents: 5 }), /externalId/); passed++;
    assert.throws(() => fp.buildSaleRequest(sdk, { externalId: "has space", amountCents: 5 }), /externalId/); passed++;
    assert.throws(() => fp.buildSaleRequest({ ...sdk, remotepay: { SaleRequest: function () {} } }, { externalId: "TBKX1234-1", amountCents: 5 }), /missing in this SDK/); passed++;
    // the dist CardEntryMethods class is what the constants come from
    const CEM = require("remote-pay-cloud/dist/com/clover/remote/client/CardEntryMethods.js").CardEntryMethods;
    eq([CEM.CARD_ENTRY_METHOD_NFC_CONTACTLESS, CEM.CARD_ENTRY_METHOD_ICC_CONTACT, CEM.CARD_ENTRY_METHOD_MAG_STRIPE], [33796, 33282, 33025]);
    // the pinned versions are the installed ones
    const pkg = require("../../package.json");
    eq(pkg.dependencies["remote-pay-cloud"], "4.1.2"); eq(pkg.dependencies["remote-pay-cloud-api"], "4.0.5");
    eq(require("remote-pay-cloud/package.json").version, "4.1.2"); eq(require("remote-pay-cloud-api/package.json").version, "4.0.5");
    ok(fs.existsSync(path.join(__dirname, "../../package-lock.json")), "package-lock.json is committed");
  });

  /* ================= A: approve ================= */
  await scenario("A approve", async () => {
    const r = rig(); r.ready();
    const order = r.order(), ext = r.ext(order);
    r.fc.script.sale = (id) => r.respond("SUCCESS", mkPayment({ extId: id, amount: 349, id: "PAYIDAAAAAA1", shell: "SHELLAAAAAA1" }));
    const out = await fp.pay({ orderId: order, amountCents: 349 });
    eq(out.result, "approved"); eq(out.paymentId, "PAYIDAAAAAA1"); eq(out.last4, "4242"); eq(out.cardBrand, "VISA");
    eq(r.fc.calls.filter(c => c.m === "sale").length, 1);
    eq(r.fc.calls[0].extId, ext, "ExternalId is TBK<order>-<attempt>"); ok(ext.length <= 32);
    eq(r.fc.calls[0].req.getTipMode(), "NO_TIP");
    // journal-before-sale: the IN_FLIGHT line exists and precedes the outcome
    const lines = fs.readFileSync(path.join(r.dir, "pay-journal.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    const iF = lines.findIndex(l => l.state === "IN_FLIGHT" && l.externalId === ext), iA = lines.findIndex(l => l.state === "APPROVED" && l.externalId === ext);
    ok(iF >= 0 && iA > iF, "IN_FLIGHT journaled before APPROVED");
    eq(lines[iA].responseCode, "SUCCESS"); eq(lines[iA].paymentResult, "SUCCESS"); eq(lines[iA].source, "device");
    // tags: PAID + locked on the kiosk order, SHELL on the payment's order, then the tag marker
    await waitFor(() => r.tags.length >= 1 && !J.needsTag(r.journal.order(order)), 2000, "PAID tag");
    eq(r.tags[0].title, "TBK:PAID:PAYIDAAAAAA1"); eq(r.tags[0].lock, true); eq(r.tags[0].shells, [{ orderId: "SHELLAAAAAA1", title: `TBK:SHELL:${order}` }]);
    // only APPROVED is cached: a retry returns the approval and sends no second sale
    const again = await fp.pay({ orderId: order, amountCents: 349 });
    eq(again.result, "approved"); eq(again.cached, true); eq(r.fc.count("sale"), 1);
    // nothing sensitive reached the disk
    const text = fs.readFileSync(path.join(r.dir, "pay-journal.jsonl"), "utf8");
    for (const s of ["411111", "PAT CARDHOLDER", "tok_SECRET", "AUTH99"]) ok(!text.includes(s), "journal has no " + s);
  });

  await scenario("approval needs BOTH response code and payment result", async () => {
    const r = rig(); r.ready();
    const order = r.order(), ext = r.ext(order);
    r.fc.script.retrievePayment = () => ({ status: "IN_PROGRESS" });
    r.fc.script.sale = (id) => r.respond("SUCCESS", mkPayment({ extId: id, result: "FAIL" }));      // SUCCESS code, failed payment
    const p = fp.pay({ orderId: order, amountCents: 349 });
    await sleep(120);
    eq(r.state(ext), "IN_FLIGHT", "a SUCCESS code on a non-success payment is not an approval");
    // a payment whose externalPaymentId is somebody else's is not approval either
    r.respond("SUCCESS", mkPayment({ extId: "TBKOTHERORDER1-1", result: "SUCCESS" }));
    eq(r.state(ext), "IN_FLIGHT", "a foreign payment id never approves our attempt");
    r.respond("SUCCESS", mkPayment({ extId: ext, result: "SUCCESS" }));
    eq((await p).result, "approved");
  });

  /* ================= B: decline, then a retry gets a NEW ExternalId ================= */
  await scenario("B decline then retry with a new attempt id", async () => {
    const r = rig(); r.ready();
    const order = r.order();
    // the SDK reality: a decline arrives as ResponseCode.FAIL with NO payment; the kiosk verifies with the device before saying so
    r.fc.script.sale = () => r.respond("FAIL", null, "Card declined");
    const first = await fp.pay({ orderId: order, amountCents: 349 });
    eq(first.result, "declined"); eq(r.state(r.ext(order, 1)), "DECLINED");
    ok(r.fc.count("retrievePayment") >= 1 && r.fc.count("status") >= 1, "decline was verified with the device");
    eq(r.fc.count("cancel"), 0, "no cancel/reset dance when the reader itself said the sale ended");
    eq(r.tags.length, 0, "a decline writes no tag and releases nothing to the station");
    eq(fp.orderState(order).state, "DECLINED");
    r.fc.script.sale = (id) => r.respond("SUCCESS", mkPayment({ extId: id, amount: 349, id: "PAYIDBBBBBB1" }));
    const second = await fp.pay({ orderId: order, amountCents: 349 });
    eq(second.result, "approved");
    eq(r.fc.calls.filter(c => c.m === "sale").map(c => c.extId), [r.ext(order, 1), r.ext(order, 2)], "each attempt has its own ExternalId");
    ok(fp._internals.rt.size === 0, "terminal states leave no runtime behind");
  });

  await scenario("B2 decline matched by id, and an attempt limit", async () => {
    const r = rig(); r.ready();
    const order = r.order();
    r.fc.script.sale = (id) => r.respond("FAIL", mkPayment({ extId: id, result: "FAIL" }));
    for (let i = 1; i <= 3; i++) eq((await fp.pay({ orderId: order, amountCents: 349 })).result, "declined");
    const fourth = await fp.pay({ orderId: order, amountCents: 349 });
    eq(fourth.result, "unavailable"); ok(/attempt limit/.test(fourth.message)); eq(r.fc.count("sale"), 3);
    ok(fp._internals.rt.size === 0, "terminal non-approved states leave nothing cached at runtime");
  });

  /* ================= C: cancel on the Flex, then pay-at-window ================= */
  await scenario("C cancel then COLLECT", async () => {
    const r = rig(); r.ready();
    const order = r.order();
    r.fc.script.sale = () => r.respond("CANCEL", null, "Request Canceled");
    const out = await fp.pay({ orderId: order, amountCents: 349 });
    eq(out.result, "cancelled"); eq(r.state(r.ext(order)), "CANCELLED"); eq(r.tags.length, 0);
    const w = await fp.collect(order); eq(w.result, "collect");
    await waitFor(() => r.tags.length === 1 && !J.needsTag(r.journal.order(order)), 2000, "COLLECT tag");
    eq(r.tags[0].title, "TBK:COLLECT"); eq(r.tags[0].lock, false);
    eq((await fp.collect(order)).result, "collect", "idempotent");
    const blocked = await fp.pay({ orderId: order, amountCents: 349 });
    eq(blocked.result, "unavailable"); eq(r.fc.count("sale"), 1, "no card attempt after the order went to the window");
  });

  /* ================= timeout recovery (ADR section 3) ================= */
  await scenario("timeout: NOT_FOUND -> ESC -> no CANCEL -> reset -> NOT_FOUND + IDLE = CANCELLED", async () => {
    const r = rig(); r.ready();
    const order = r.order(), ext = r.ext(order);
    const out = await fp.pay({ orderId: order, amountCents: 349 });                // reader never answers
    eq(out.result, "cancelled");
    eq(r.state(ext), "CANCELLED");
    const seq = r.fc.calls.map(c => c.m);
    eq(seq.filter(m => m !== "status"), ["sale", "retrievePayment", "cancel", "reset", "retrievePayment"], "sale, ask, ESC, reset, ask again");
    eq(r.fc.calls.find(c => c.m === "cancel").key, "ESC", "cancel is the ESC key press");
    ok(seq.includes("status"), "NOT_FOUND only counts with the reader IDLE");
    eq(r.tags.length, 0, "a first-attempt NOT_FOUND is safe to retry: nothing is locked or released");
  });

  await scenario("timeout: a CANCEL response to our ESC skips the reset", async () => {
    const r = rig(); r.ready();
    const order = r.order(), ext = r.ext(order);
    r.fc.script.cancel = () => r.respond("CANCEL", null, "Request Canceled");
    const out = await fp.pay({ orderId: order, amountCents: 349 });
    eq(out.result, "cancelled"); eq(r.state(ext), "CANCELLED"); eq(r.fc.count("reset"), 0);
  });

  await scenario("timeout: reader not IDLE after reset = UNKNOWN (not proven)", async () => {
    const r = rig(); r.ready(); r.fc.deviceState = "BUSY";
    const order = r.order(), ext = r.ext(order);
    const out = await fp.pay({ orderId: order, amountCents: 349 });
    eq(out.result, "unknown"); eq(r.state(ext), "TIMEOUT_UNKNOWN");
    await waitFor(() => r.tags.length >= 1, 2000, "CHECK tag");
    eq(r.tags[0].title, "TBK:CHECK"); eq(r.tags[0].lock, true);
  });

  await scenario("timeout: IN_PROGRESS extends once, then FOUND SUCCESS approves", async () => {
    const r = rig(); r.ready();
    const order = r.order(), ext = r.ext(order);
    r.fc.script.retrievePayment = (id, n) => n === 1 ? { status: "IN_PROGRESS" } : { status: "FOUND", payment: mkPayment({ extId: id, id: "PAYIDCCCCCC1" }) };
    const t0 = Date.now();
    const out = await fp.pay({ orderId: order, amountCents: 349 });
    eq(out.result, "approved"); ok(Date.now() - t0 >= TIMING.PAY_TIMEOUT_MS + TIMING.EXTENSION_MS - 20, "waited the extension");
    eq(r.fc.count("cancel"), 0, "a mid-PIN customer is never cancelled");
    eq(r.state(ext), "APPROVED");
  });

  await scenario("timeout: IN_PROGRESS after the extension = UNKNOWN", async () => {
    const r = rig(); r.ready();
    const order = r.order(), ext = r.ext(order);
    r.fc.script.retrievePayment = () => ({ status: "IN_PROGRESS" });
    const out = await fp.pay({ orderId: order, amountCents: 349 });
    eq(out.result, "unknown"); eq(r.state(ext), "TIMEOUT_UNKNOWN"); eq(r.fc.count("retrievePayment"), 2); eq(r.fc.count("cancel"), 0);
  });

  await scenario("timeout: no answer from the device = UNKNOWN", async () => {
    const r = rig({ timing: { ANSWER_MS: 60 } }); r.ready();
    const order = r.order(), ext = r.ext(order);
    r.fc.script.retrievePayment = () => null;                                       // silence
    const out = await fp.pay({ orderId: order, amountCents: 349 });
    eq(out.result, "unknown"); eq(r.state(ext), "TIMEOUT_UNKNOWN");
  });

  /* ================= E + H: timeout, UNKNOWN, repeat /pay blocked, late approval ================= */
  await scenario("E+H timeout then late approval; repeat pay during UNKNOWN is blocked", async () => {
    const r = rig(); r.ready(); r.fc.deviceState = "BUSY";
    const order = r.order(), ext = r.ext(order);
    const out = await fp.pay({ orderId: order, amountCents: 349 });
    eq(out.result, "unknown");
    const salesBefore = r.fc.count("sale");
    // H: repeat /pay, repeat window, another order: no new Sale on the reader
    eq((await fp.pay({ orderId: order, amountCents: 349 })).result, "blocked-unknown");
    eq((await fp.collect(order)).result, "blocked-unknown");
    const other = r.order();
    eq((await fp.pay({ orderId: other, amountCents: 349 })).result, "reader-busy", "one reader: an unresolved attempt keeps it (CR-005: its own result, so the page goes to the window)");
    eq(r.fc.count("sale"), salesBefore, "no second prompt");
    ok((await fp.canAbandon(order)).ok === false, "an UNKNOWN order cannot be abandoned");
    await waitFor(() => r.tags.some(t => t.title === "TBK:CHECK") && !J.needsTag(r.journal.order(order)), 2000, "CHECK tag written");
    // the late approval arrives (customer tapped at 40 s): same attempt, same ExternalId
    r.respond("SUCCESS", mkPayment({ extId: ext, id: "PAYIDDDDDDD1", shell: "SHELLDDDDDD1" }));
    eq(r.state(ext), "APPROVED", "late SUCCESS accepted for a non-approved attempt");
    await waitFor(() => r.lastTag().title === "TBK:PAID:PAYIDDDDDDD1" && !J.needsTag(r.journal.order(order)), 2000, "PAID tag");
    eq(r.journal.attemptsFor(order).length, 1, "no second attempt in the journal");
    eq(fp.orderState(order).state, "APPROVED");
    eq((await fp.pay({ orderId: order, amountCents: 349 })).result, "approved");
  });

  await scenario("stray CANCEL for an old sale cannot cancel the live one (hint is verified)", async () => {
    const r = rig({ timing: { PAY_TIMEOUT_MS: 800 } }); r.ready();
    const order = r.order(), ext = r.ext(order);
    r.fc.script.retrievePayment = () => ({ status: "IN_PROGRESS" });
    const p = fp.pay({ orderId: order, amountCents: 349 });
    await sleep(30);
    r.respond("CANCEL", null, "Request Canceled");                                  // late cancel from some earlier sale: no payment, no id
    await sleep(120);
    eq(r.state(ext), "IN_FLIGHT", "device says IN_PROGRESS, so the hint is discarded");
    ok(r.fc.count("retrievePayment") >= 1);
    r.respond("SUCCESS", mkPayment({ extId: ext }));
    eq((await p).result, "approved");
  });

  /* ================= D: disconnect while in flight, reconnect ================= */
  await scenario("D disconnect -> UNKNOWN -> reconnect -> FOUND SUCCESS (one payment)", async () => {
    const r = rig({ timing: { PAY_TIMEOUT_MS: 5000 } }); r.ready();
    const order = r.order(), ext = r.ext(order);
    const p = fp.pay({ orderId: order, amountCents: 349 });
    await sleep(20);
    r.disconnect();
    const out = await p;
    eq(out.result, "unknown", "disconnect is UNKNOWN, never 'unavailable'");
    eq(r.state(ext), "DISCONNECTED_UNKNOWN");
    await waitFor(() => r.lastTag() && r.lastTag().title === "TBK:CHECK", 2000, "CHECK tag while offline");
    eq((await fp.pay({ orderId: order, amountCents: 349 })).result, "blocked-unknown");
    eq(fp.status().state, "offline");
    // the reader comes back and the card WAS charged
    r.fc.script.retrievePayment = (id) => ({ status: "FOUND", payment: mkPayment({ extId: id, id: "PAYIDEEEEEE1" }) });
    r.ready();
    await waitFor(() => r.state(ext) === "APPROVED", 2000, "reconcile approval");
    await waitFor(() => r.lastTag().title === "TBK:PAID:PAYIDEEEEEE1" && !J.needsTag(r.journal.order(order)), 2000, "PAID tag");
    eq(r.fc.count("sale"), 1, "exactly one Sale was ever sent");
    ok(r.fc.calls.some(c => c.m === "status" && c.replay === true), "reconcile asks the device to replay its last message");
  });

  await scenario("D2 disconnect -> reconnect -> proven NOT charged releases the order to COLLECT", async () => {
    const r = rig({ timing: { PAY_TIMEOUT_MS: 5000 } }); r.ready();
    const order = r.order(), ext = r.ext(order);
    const p = fp.pay({ orderId: order, amountCents: 349 });
    await sleep(20); r.disconnect(); await p;
    r.fc.script.retrievePayment = () => ({ status: "NOT_FOUND" });
    r.ready();
    await waitFor(() => r.state(ext) === "CANCELLED", 2000, "proven not charged");
    await waitFor(() => r.lastTag().title === "TBK:COLLECT" && !J.needsTag(r.journal.order(order)), 2000, "COLLECT tag");
    eq(r.lastTag().lock, false, "unlocked so the window can tender it");
    eq(fp.orderState(order).state, "COLLECT");
  });

  /* ================= G: restart while IN_FLIGHT, journal replay ================= */
  await scenario("G restart replay: IN_FLIGHT becomes UNKNOWN, the device settles it", async () => {
    const r1 = rig(); r1.ready();
    const order = r1.order(), ext = r1.ext(order);
    fp.pay({ orderId: order, amountCents: 349 });                                   // never answers; "taskkill node" now
    await sleep(30);
    eq(r1.state(ext), "IN_FLIGHT"); eq(r1.fc.count("sale"), 1);
    fp.shutdown();
    const j2 = J.createJournal({ dir: r1.dir }); j2.load();                        // the new process reads the journal back from disk
    const r2 = rig({ dir: r1.dir, journal: j2 });
    eq(r2.state(ext), "DISCONNECTED_UNKNOWN", "boot replay never trusts an in-flight state");
    await waitFor(() => r2.tags.some(t => t.title === "TBK:CHECK"), 2000, "CHECK tag after restart");
    eq((await fp.pay({ orderId: order, amountCents: 349 })).result, "blocked-unknown", "after a restart the UNKNOWN attempt blocks a second card attempt");
    r2.fc.script.retrievePayment = (id) => ({ status: "FOUND", payment: mkPayment({ extId: id, id: "PAYIDFFFFFF1" }) });
    r2.ready();
    await waitFor(() => r2.state(ext) === "APPROVED", 2000, "replayed approval");
    await waitFor(() => r2.lastTag().title === "TBK:PAID:PAYIDFFFFFF1", 2000, "PAID tag");
    eq(r2.fc.count("sale"), 0, "the restarted server sent no Sale");
    eq(r2.journal.attemptsFor(order).length, 1);
  });

  await scenario("G2 restart replay with a journal on disk: not charged -> COLLECT", async () => {
    const r1 = rig(); r1.ready();
    const order = r1.order(), ext = r1.ext(order);
    fp.pay({ orderId: order, amountCents: 349 }); await sleep(30); fp.shutdown();
    const j2 = J.createJournal({ dir: r1.dir }); j2.load();
    const r2 = rig({ dir: r1.dir, journal: j2 });
    r2.fc.script.retrievePayment = () => ({ status: "NOT_FOUND" });
    r2.ready();
    await waitFor(() => r2.state(ext) === "CANCELLED", 2500, "proven not charged after restart");
    await waitFor(() => r2.lastTag() && r2.lastTag().title === "TBK:COLLECT" && !J.needsTag(r2.journal.order(order)), 2000, "COLLECT tag");
  });

  /* ================= DUPLICATE ================= */
  await scenario("DUPLICATE: the SDK reports it as CANCEL naming the id; the device says it was charged", async () => {
    const r = rig({ timing: { PAY_TIMEOUT_MS: 5000 } }); r.ready();
    const order = r.order(), ext = r.ext(order);
    r.fc.script.retrievePayment = (id) => ({ status: "FOUND", payment: mkPayment({ extId: id, id: "PAYIDGGGGGG1" }) });
    r.fc.script.sale = () => r.respond("CANCEL", null, `The provided transaction id of ${ext} has already been processed and cannot be resubmitted.`);
    const out = await fp.pay({ orderId: order, amountCents: 349 });
    eq(out.result, "approved", "a duplicate is reconciled against the device, never reported as an error");
    eq(r.fc.count("cancel"), 0);
  });
  await scenario("DUPLICATE: literal ResponseCode.DUPLICATE, device has nothing -> not charged", async () => {
    const r = rig({ timing: { PAY_TIMEOUT_MS: 5000 } }); r.ready();
    const order = r.order(), ext = r.ext(order);
    r.fc.script.sale = () => r.respond("DUPLICATE", null, "duplicate");
    const out = await fp.pay({ orderId: order, amountCents: 349 });
    eq(out.result, "cancelled"); eq(r.state(ext), "CANCELLED");
  });
  await scenario("ERROR response is verified, not trusted", async () => {
    const r = rig({ timing: { PAY_TIMEOUT_MS: 5000 } }); r.ready();
    const order = r.order(), ext = r.ext(order);
    r.fc.script.retrievePayment = (id) => ({ status: "FOUND", payment: mkPayment({ extId: id }) });   // an ERROR that was really a charge
    r.fc.script.sale = () => r.respond("ERROR", null, "reader or transaction error");
    eq((await fp.pay({ orderId: order, amountCents: 349 })).result, "approved");
    const r2o = r.order();
    r.fc.script.retrievePayment = () => ({ status: "NOT_FOUND" });
    r.fc.script.sale = () => r.respond("ERROR", null, "reader or transaction error");
    const out = await fp.pay({ orderId: r2o, amountCents: 349 });
    eq(out.result, "error"); eq(r.state(r.ext(r2o)), "CANCELLED");
  });

  /* ================= DOUBLE ================= */
  await scenario("DOUBLE: a late approval on an order that already has a charge or went to the window", async () => {
    const r = rig(); r.ready();
    const order = r.order();
    r.fc.script.sale = () => r.respond("CANCEL", null, "x");
    eq((await fp.pay({ orderId: order, amountCents: 349 })).result, "cancelled");   // attempt 1 settled "not charged"
    r.fc.script.sale = (id) => r.respond("SUCCESS", mkPayment({ extId: id, id: "PAYIDHHHHHH2", shell: "SHELLHHHHHH2" }));
    eq((await fp.pay({ orderId: order, amountCents: 349 })).result, "approved");     // attempt 2 charged
    r.respond("SUCCESS", mkPayment({ extId: r.ext(order, 1), id: "PAYIDHHHHHH1", shell: "SHELLHHHHHH1" }));   // attempt 1 was actually charged too
    eq(r.state(r.ext(order, 1)), "DOUBLE"); eq(r.state(r.ext(order, 2)), "APPROVED");
    eq(fp.orderState(order).state, "APPROVED");
    await waitFor(() => !J.needsTag(r.journal.order(order)), 2000, "tags settle");
    eq(r.lastTag().kind, "PAID"); eq(r.lastTag().shells.length, 2, "both shell orders get titled");
    // window first, then a late card approval
    const o2 = r.order();
    r.fc.script.sale = () => r.respond("CANCEL", null, "x");
    await fp.pay({ orderId: o2, amountCents: 349 }); await fp.collect(o2);
    r.respond("SUCCESS", mkPayment({ extId: r.ext(o2, 1), id: "PAYIDIIIIII1" }));
    eq(r.state(r.ext(o2, 1)), "DOUBLE", "approved after COLLECT is DOUBLE so the owner can void one");
  });

  /* ================= REST: positive evidence only ================= */
  await scenario("REST evidence: only SUCCESS, unvoided, matching id and amount can approve", async () => {
    let answer = [];
    const r = rig({ timing: { PAY_TIMEOUT_MS: 5000, REST_AFTER_MS: 60 }, rest: id => { if (answer instanceof Error) throw answer; return answer; } }); r.ready();
    const order = r.order(), ext = r.ext(order);
    const p = fp.pay({ orderId: order, amountCents: 349 });
    await sleep(20); r.disconnect(); await p;
    eq(r.state(ext), "DISCONNECTED_UNKNOWN");
    const restPay = (o = {}) => ({ id: "PAYIDJJJJJJ1", externalPaymentId: ext, result: "SUCCESS", amount: 349, order: { id: "SHELLJJJJJJ1" }, cardTransaction: { cardType: "VISA", last4: "1111", entryType: "EMV_CONTACTLESS" }, ...o });
    await sleep(200);                                                               // device down longer than REST_AFTER_MS
    for (const [label, ans] of [["no payments", []], ["REST error", new Error("503")], ["voided", [restPay({ voids: { elements: [{ id: "v" }] } })]],
      ["result VOIDED", [restPay({ result: "VOIDED" })]], ["other id", [restPay({ externalPaymentId: "TBKOTHER00001-1" })]], ["amount differs", [restPay({ amount: 100 })]]]) {
      answer = ans; await sleep(150);
      eq(r.state(ext), "DISCONNECTED_UNKNOWN", `REST "${label}" never resolves anything`);
    }
    answer = [restPay()];
    await waitFor(() => r.state(ext) === "APPROVED", 2000, "positive REST evidence");
    eq(r.journal.get(ext).source, "rest"); eq(r.journal.get(ext).shellOrderId, "SHELLJJJJJJ1");
    await waitFor(() => r.lastTag().title === "TBK:PAID:PAYIDJJJJJJ1", 2000, "PAID tag from REST evidence");
  });

  /* ================= kill switch: new sales only ================= */
  await scenario("kill switch stops NEW sales; reconcile, late approvals, tags and cached approvals continue", async () => {
    const r = rig({ timing: { PAY_TIMEOUT_MS: 5000 } }); r.ready();
    const order = r.order(), ext = r.ext(order);
    const p = fp.pay({ orderId: order, amountCents: 349 });
    await sleep(20); r.disconnect(); await p;
    r.allowed = false;                                                              // kill
    const fresh = r.order();
    eq((await fp.pay({ orderId: fresh, amountCents: 349 })).result, "unavailable", "no new sale while killed");
    ok(/off/.test((await fp.pay({ orderId: fresh, amountCents: 349 })).message));
    eq(r.fc.count("sale"), 1);
    r.fc.script.retrievePayment = (id) => ({ status: "FOUND", payment: mkPayment({ extId: id, id: "PAYIDKKKKKK1" }) });
    r.ready();
    await waitFor(() => r.state(ext) === "APPROVED", 2000, "reconcile while killed");
    await waitFor(() => r.lastTag().title === "TBK:PAID:PAYIDKKKKKK1", 2000, "tag while killed");
    eq((await fp.pay({ orderId: order, amountCents: 349 })).cached, true, "an approved order still answers while killed");
    r.respond("SUCCESS", mkPayment({ extId: "TBKNEVERSEENORDER-1", id: "PAYIDKKKKKK2" }));   // late device message still handled
  });

  await scenario("kill switch fails closed when cfg.payAllowed is missing", async () => {
    const r = rig(); r.ready();
    fp.init({ FLEX_IP: "x", FLEX_PORT: 1, FLEX_SCHEME: "wss", POS_NAME: "t", PAIRING_FILE: "x", JOURNAL_DIR: r.dir, PAY_TIMEOUT_MS: 150, timing: TIMING },
      { journal: r.journal, sdk, connectorFactory: () => r.fc });
    r.ready();
    const order = r.order();
    eq((await fp.pay({ orderId: order, amountCents: 349 })).result, "unavailable");
    eq(r.fc.count("sale"), 0);
  });

  /* ================= executor guards ================= */
  await scenario("executor: build failure, journal failure and a throwing sale()", async () => {
    // bad amount: nothing journaled, nothing sent
    let r = rig(); r.ready();
    let order = r.order();
    eq((await fp.pay({ orderId: order, amountCents: 0 })).result, "error");
    eq(r.journal.attemptsFor(order).length, 0); eq(r.fc.count("sale"), 0);
    eq((await fp.pay(null)).result !== undefined, true);
    eq((await fp.pay({ orderId: "../etc", amountCents: 100 })).result, "mismatch");
    eq((await fp.pay({ orderId: "NEVERREGISTERED", amountCents: 100 })).result, "mismatch", "only orders in this server's journal");
    // journal cannot be written: the Sale must NOT be sent
    fp.shutdown();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-paystate-")); const j = J.createJournal({ dir }); j.load();
    const bad = { ...j, append: (f, o) => { if (o && o.newAttempt) throw new Error("disk full"); return j.append(f, o); } };
    r = rig({ dir, journal: bad }); r.ready(); order = r.order();
    const out = await fp.pay({ orderId: order, amountCents: 349 });
    eq(out.result, "error"); eq(r.fc.count("sale"), 0, "no journal line, no Sale");
    // sale() throws after the SDK was called: the request may have left, so UNKNOWN and locked, not "error and retry"
    fp.shutdown();
    r = rig(); r.ready(); order = r.order(); r.fc.script.saleThrows = true;
    const out2 = await fp.pay({ orderId: order, amountCents: 349 });
    eq(out2.result, "unknown"); eq(r.state(r.ext(order)), "DISCONNECTED_UNKNOWN");
    eq((await fp.pay({ orderId: order, amountCents: 349 })).result, "blocked-unknown");
  });

  await scenario("device not ready / one reader / listener never throws", async () => {
    const r = rig();                                                                // not ready yet
    const order = r.order();
    eq((await fp.pay({ orderId: order, amountCents: 349 })).result, "unavailable");
    r.ready();
    r.fc.script.sale = () => {};                                                    // stays in flight
    const p = fp.pay({ orderId: order, amountCents: 349 });
    await sleep(20);
    eq((await fp.pay({ orderId: order, amountCents: 349 })).result, "busy");
    eq((await fp.pay({ orderId: r.order(), amountCents: 349 })).result, "reader-busy");
    // garbage into every handler: no throw escapes
    const l = r.fc.listener;
    l.onSaleResponse(null); l.onSaleResponse({}); l.onRetrievePaymentResponse(null); l.onRetrieveDeviceStatusResponse(undefined); l.onDeviceError(null);
    l.onConfirmPaymentRequest(null); l.onVerifySignatureRequest(null);
    passed++;
    r.respond("SUCCESS", mkPayment({ extId: r.ext(order) }));
    eq((await p).result, "approved");
    // the duplicate/partial challenge is rejected by policy
    l.onConfirmPaymentRequest({ getPayment: () => ({}), getChallenges: () => [{}] });
    eq(r.fc.count("rejectPayment"), 1);
  });

  /* ================= tags: retried until they succeed; paid never downgraded ================= */
  await scenario("tag writes retry from the journal; PAID wins over an older CHECK still being retried", async () => {
    const r = rig({ timing: { PAY_TIMEOUT_MS: 5000 } }); r.ready(); r.tagFail = 3;
    const order = r.order(), ext = r.ext(order);
    const p = fp.pay({ orderId: order, amountCents: 349 });
    await sleep(20); r.disconnect(); await p;                                       // CHECK write fails (1)
    await waitFor(() => r.tags.length >= 1, 1000, "first CHECK attempt");
    ok(J.needsTag(r.journal.order(order)), "tag not marked written while Clover refuses");
    r.fc.script.retrievePayment = (id) => ({ status: "FOUND", payment: mkPayment({ extId: id, id: "PAYIDLLLLLL1" }) });
    r.ready();                                                                      // approval while the CHECK write keeps failing
    await waitFor(() => r.state(ext) === "APPROVED", 2000, "approval");
    await waitFor(() => !J.needsTag(r.journal.order(order)), 3000, "tag finally written");
    eq(r.lastTag().title, "TBK:PAID:PAYIDLLLLLL1", "the last write is PAID, derived from the journal, never the stale CHECK");
    ok(r.tags.length >= 3, "the writes were retried");
    // a restart with an approved-but-untagged order: the journal's word is NOT evidence. PAID is written only after the device says FOUND + SUCCESS.
    fp.shutdown();
    const o2 = r.order(); const e2 = r.ext(o2);
    r.journal.append({ externalId: e2, kioskOrderId: o2, attempt: 1, state: "IN_FLIGHT", amountCents: 349, source: "local" }, { newAttempt: true });
    r.journal.append({ externalId: e2, kioskOrderId: o2, state: "APPROVED", paymentId: "PAYIDLLLLLL2", source: "device" });
    const r2 = rig({ dir: r.dir, journal: r.journal });
    r2.ready();
    r2.fc.script.retrievePayment = (id) => id === e2 ? { status: "FOUND", payment: mkPayment({ extId: id, id: "PAYIDLLLLLL2" }) } : { status: "NOT_FOUND" };
    await waitFor(() => r2.tags.some(t => t.title === "TBK:PAID:PAYIDLLLLLL2") && !J.needsTag(r2.journal.order(o2)), 3000, "PAID written once the device confirms");
    ok(r2.fc.calls.some(c => c.m === "retrievePayment" && c.extId === e2), "the device was asked before PAID was written");
  });

  await scenario("a tampered journal cannot make the kiosk write TBK:PAID", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-paystate-"));
    const j = J.createJournal({ dir }); j.load();
    const O = "ORDERTAMPER01", ext = `TBK${O}-1`;
    j.registerOrder(O);
    j.append({ externalId: ext, kioskOrderId: O, attempt: 1, state: "IN_FLIGHT", amountCents: 349, source: "local" }, { newAttempt: true });
    j.append({ externalId: ext, kioskOrderId: O, state: "APPROVED", paymentId: "PAYIDFAKE001", source: "device" });   // a line an attacker (or a bug) wrote by hand
    const j2 = J.createJournal({ dir }); j2.load();
    const r = rig({ dir, journal: j2 });
    r.fc.script.retrievePayment = () => ({ status: "NOT_FOUND" });                // the device has no such payment
    r.ready();
    await sleep(500);
    eq(r.tags.length, 0, "no PAID (and no CHECK or COLLECT) tag from the journal's word alone");
    ok(J.needsTag(r.journal.order(O)), "still pending evidence");
    eq(r.state(ext), "APPROVED", "the journal entry itself is left alone: a NOT_FOUND never downgrades a charged attempt");
  });

  await scenario("REST evidence verifies a journal approval while the device is down", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-paystate-"));
    const j = J.createJournal({ dir }); j.load();
    const O = "ORDERRESTV001", ext = `TBK${O}-1`;
    j.registerOrder(O);
    j.append({ externalId: ext, kioskOrderId: O, attempt: 1, state: "IN_FLIGHT", amountCents: 349, source: "local" }, { newAttempt: true });
    j.append({ externalId: ext, kioskOrderId: O, state: "APPROVED", paymentId: "PAYIDRESTV01", source: "device" });
    const j2 = J.createJournal({ dir }); j2.load();
    let answer = [];
    const r = rig({ dir, journal: j2, timing: { REST_AFTER_MS: 60 }, rest: () => answer });
    await sleep(250);                                                              // device never connected: down longer than REST_AFTER_MS
    eq(r.tags.length, 0, "REST says nothing: nothing written");
    answer = [{ id: "PAYIDRESTV01", externalPaymentId: ext, result: "SUCCESS", amount: 349, order: { id: "SHELLRESTV01" } }];
    await waitFor(() => r.tags.some(t => t.title === "TBK:PAID:PAYIDRESTV01"), 3000, "PAID after REST evidence");
  });

  /* ================= abandon: only PENDING/DECLINED/CANCELLED, reader idle ================= */
  await scenario("canAbandon: needs a quiet order and an idle reader", async () => {
    const r = rig(); r.ready();
    const order = r.order();
    eq((await fp.canAbandon(order)).ok, true); fp.releaseAbandon(order);
    r.fc.deviceState = "BUSY"; eq((await fp.canAbandon(order)).ok, false); r.fc.deviceState = "IDLE";
    r.fc.script.sale = () => r.respond("CANCEL", null, "x");
    await fp.pay({ orderId: order, amountCents: 349 });
    eq((await fp.canAbandon(order)).ok, true, "CANCELLED may be abandoned"); fp.releaseAbandon(order);
    await fp.collect(order); eq((await fp.canAbandon(order)).ok, false, "a COLLECT order has a ticket the window will take");
    const o2 = r.order();
    r.fc.script.sale = (id) => r.respond("SUCCESS", mkPayment({ extId: id }));
    await fp.pay({ orderId: o2, amountCents: 349 }); eq((await fp.canAbandon(o2)).ok, false, "a paid order is never deleted");
    eq((await fp.canAbandon("NOPE000000")).ok, false);
    r.disconnect(); eq((await fp.canAbandon(r.order())).ok, false, "device not confirmed idle");
  });

  /* ================= Round 3 (Flint CR-001..016, Snake Eyes 4): each scenario reproduces the reviewer's trigger ================= */

  await scenario("CR-002 canAbandon marks the order closed in the same tick; pay and collect refuse until it is released", async () => {
    const r = rig(); r.ready();
    const order = r.order();
    const c = await fp.canAbandon(order); eq(c.ok, true);
    eq((await fp.pay({ orderId: order, amountCents: 349 })).result, "unavailable", "no Sale while the order is being deleted");
    eq(r.fc.count("sale"), 0);
    eq((await fp.collect(order)).result, "unavailable");
    eq((await fp.canAbandon(order)).ok, false, "a second abandon cannot start either");
    fp.releaseAbandon(order);
    r.fc.script.sale = (id) => r.respond("SUCCESS", mkPayment({ extId: id, amount: 349 }));
    eq((await fp.pay({ orderId: order, amountCents: 349 })).result, "approved", "released: the customer can pay again");
    // markAbandoned also clears the mark and the order stays abandoned
    const o2 = r.order(); eq((await fp.canAbandon(o2)).ok, true); fp.markAbandoned(o2);
    eq((await fp.pay({ orderId: o2, amountCents: 349 })).result, "mismatch");
    // a sale that starts DURING the reader-idle check is caught by the re-check
    const o3 = r.order(); r.fc.script.sale = () => {};
    const slow = r.fc.retrieveDeviceStatus.bind(r.fc);
    r.fc.retrieveDeviceStatus = req => { setImmediate(() => { fp.pay({ orderId: o3, amountCents: 349 }); }); slow(req); };
    const racing = await fp.canAbandon(o3);
    r.fc.retrieveDeviceStatus = slow;
    eq(racing.ok, false, "an attempt that started while the reader was being asked blocks the abandon");
  });

  await scenario("CR-003 a SUCCESS payment for less than the sale is not an approval: CHECK, CRITICAL, the paid amount journaled", async () => {
    const r = rig(); r.ready();
    const order = r.order(), ext = r.ext(order);
    const errs = []; const oe = console.error; console.error = (...a) => errs.push(a.join(" "));
    r.fc.script.sale = (id) => r.respond("SUCCESS", mkPayment({ extId: id, amount: 1, id: "PAYIDPART001" }));      // 1 cent against a 349 cent sale
    const out = await fp.pay({ orderId: order, amountCents: 349 });
    console.error = oe;
    eq(out.result, "unknown", "not approved");
    eq(r.state(ext), "TIMEOUT_UNKNOWN"); eq(r.journal.get(ext).paidCents, 1, "the amount the device really took is in the journal");
    ok(errs.some(e => /CRITICAL/.test(e) && /349/.test(e)), "CRITICAL logged");
    await waitFor(() => r.tags.some(t => t.title === "TBK:CHECK"), 2000, "CHECK tag");
    ok(!r.tags.some(t => /PAID/.test(t.title)), "never PAID");
    // the same payment found by a later lookup is still refused, and the CRITICAL line is not repeated
    r.fc.script.retrievePayment = (id) => ({ status: "FOUND", payment: mkPayment({ extId: id, amount: 1, id: "PAYIDPART001" }) });
    await sleep(900);
    eq(r.state(ext), "TIMEOUT_UNKNOWN"); ok(!r.tags.some(t => /PAID/.test(t.title)));
    eq((await fp.pay({ orderId: order, amountCents: 349 })).result, "blocked-unknown");
    // an unreadable amount is refused too
    const o2 = r.order(); r.fc.script.sale = (id) => { const p = mkPayment({ extId: id }); p.setAmount(undefined); r.respond("SUCCESS", p); };
    eq((await fp.pay({ orderId: o2, amountCents: 349 })).result === "approved", false);
  });

  await scenario("CR-006 a SUCCESS payment under a FAIL or CANCEL code is evidence of a charge, never 'not charged'", async () => {
    for (const rc of ["FAIL", "CANCEL"]) {
      const r = rig(); r.ready();
      const order = r.order(), ext = r.ext(order);
      const oe = console.error; console.error = () => {};
      r.fc.script.sale = (id) => r.respond(rc, mkPayment({ extId: id, amount: 349, id: "PAYIDCONTRA1" }));
      const out = await fp.pay({ orderId: order, amountCents: 349 });
      console.error = oe;
      eq(out.result, "approved", rc + " code with a SUCCESS payment: verified and approved");
      eq(r.state(ext), "APPROVED"); eq(r.fc.count("sale"), 1);
      eq((await fp.pay({ orderId: order, amountCents: 349 })).cached, true, "no second Sale");
      fp.shutdown();
    }
    // when the contradictory payment cannot be verified (wrong amount) the attempt is recovered, never declared DECLINED
    const r = rig(); r.ready();
    const order = r.order(), ext = r.ext(order);
    const oe = console.error; console.error = () => {};
    r.fc.script.retrievePayment = () => ({ status: "IN_PROGRESS" });
    r.fc.script.sale = (id) => r.respond("FAIL", mkPayment({ extId: id, amount: 5, id: "PAYIDCONTRA2" }));
    const p = fp.pay({ orderId: order, amountCents: 349 }); await sleep(150); console.error = oe;
    ok(r.state(ext) !== "DECLINED" && r.state(ext) !== "CANCELLED", "never settled not-charged on top of a SUCCESS payment (" + r.state(ext) + ")");
    eq((await p).result, "unknown", "a payment of the wrong size under a FAIL code holds the order as CHECK"); eq(r.state(ext), "TIMEOUT_UNKNOWN");
    r.respond("SUCCESS", mkPayment({ extId: ext, amount: 349 })); eq(r.state(ext), "APPROVED", "and the real full-size approval still lands");
  });

  await scenario("CR-007 the old connector is disposed on reconnect and its late callbacks are ignored", async () => {
    const r = rig({ timing: { PAY_TIMEOUT_MS: 5000 } }); r.ready();
    const order = r.order(), ext = r.ext(order);
    const stale = r.fc.listener;                                        // the connector generation that is about to be replaced
    const p = fp.pay({ orderId: order, amountCents: 349 }); await sleep(30);
    eq(r.state(ext), "IN_FLIGHT");
    fp._internals.reconnectNow();                                       // what a reconnect does: build a new connector + listener
    ok(r.fc.calls.some(c => c.m === "dispose"), "the old connector was disposed before it was replaced");
    ok(r.fc.listener !== stale, "a new listener generation is installed");
    stale.onDeviceDisconnected();                                       // a late callback from the dead connector
    stale.onSaleResponse(mkSale("CANCEL", null, "stale"));
    eq(fp.status().state !== "offline", true, "a stale disconnect does not flip the device offline");
    eq(r.state(ext), "IN_FLIGHT", "and cannot turn the live sale UNKNOWN or cancel it");
    r.fc.listener.onSaleResponse(mkSale("SUCCESS", mkPayment({ extId: ext, amount: 349 })));
    eq((await p).result, "approved");
  });

  await scenario("CR-008 a payment without an externalPaymentId is not accepted for our attempt", async () => {
    const r = rig(); r.ready();
    const order = r.order(), ext = r.ext(order);
    const oe = console.warn; console.warn = () => {};
    r.fc.script.retrievePayment = (id) => { const p = mkPayment({ extId: undefined, amount: 349 }); return { status: "FOUND", payment: p }; };
    r.fc.script.sale = () => {};
    const out = await fp.pay({ orderId: order, amountCents: 349 });                // times out; the device "finds" an id-less payment
    console.warn = oe;
    ok(out.result !== "approved", "id-less payment refused: " + out.result);
    ok(r.state(ext) !== "APPROVED");
  });

  await scenario("CR-009 an orphan device approval is adopted only after Clover confirms a Kiosk order with the same total", async () => {
    const TYPE = "KIOSKTYPE0001";
    const cases = [
      ["matching Kiosk order", { orderType: { id: TYPE }, total: 349 }, true],
      ["wrong total", { orderType: { id: TYPE }, total: 500 }, false],
      ["not a Kiosk order", { orderType: { id: "DUOTYPE00001" }, total: 349 }, false],
      ["no such order", null, false],
    ];
    for (const [label, order, adopted] of cases) {
      const r = rig({ getOrder: async () => { if (!order) throw new Error("404"); return order; }, cfgExtra: { KIOSK_ORDER_TYPE_ID: TYPE } }); r.ready();
      const oe = console.error; console.error = () => {};
      r.respond("SUCCESS", mkPayment({ extId: "TBKLOSTORDER0001-1", amount: 349, id: "PAYIDORPH001", shell: "SHELLORPH001" }));
      await sleep(80); console.error = oe;
      eq(r.state("TBKLOSTORDER0001-1") === "APPROVED", adopted, label);
      if (adopted) await waitFor(() => r.lastTag() && r.lastTag().title === "TBK:PAID:PAYIDORPH001", 2000, "orphan PAID tag");
      else { eq(r.tags.length, 0, label + ": nothing tagged"); eq(r.journal.order("LOSTORDER0001"), null, label + ": no order registered"); }
      fp.shutdown();
    }
    const r = rig(); r.ready();                                                          // no lookup configured: nothing is adopted
    const oe = console.error; console.error = () => {};
    r.respond("SUCCESS", mkPayment({ extId: "TBKLOSTORDER0002-1", amount: 349 })); await sleep(50); console.error = oe;
    eq(r.journal.get("TBKLOSTORDER0002-1"), null);
    r.respond("SUCCESS", mkPayment({ extId: "NOTOURS-1" })); eq(r.journal.get("NOTOURS-1"), null);
  });

  await scenario("CR-010 DOUBLE shows in status() until acknowledged", async () => {
    const r = rig(); r.ready();
    const order = r.order();
    r.fc.script.sale = () => r.respond("CANCEL", null, "x");
    await fp.pay({ orderId: order, amountCents: 349 });
    r.fc.script.sale = (id) => r.respond("SUCCESS", mkPayment({ extId: id, amount: 349 }));
    await fp.pay({ orderId: order, amountCents: 349 });
    const oe = console.error; console.error = () => {};
    r.respond("SUCCESS", mkPayment({ extId: r.ext(order, 1), amount: 349, id: "PAYIDDBL0001" })); console.error = oe;
    eq(r.state(r.ext(order, 1)), "DOUBLE"); eq(fp.status().doubles, 1, "the heartbeat can report it");
    r.journal.append({ externalId: r.ext(order, 1), kioskOrderId: order, ackedAt: r.journal.tick() });
    eq(fp.status().doubles, 0, "acknowledged");
  });

  await scenario("CR-012 the 30 day purge runs at boot", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-paystate-"));
    const old = new Date(); old.setDate(old.getDate() - 45);
    const key = J.dayKey(old.getTime()); const f = path.join(dir, `pay-journal.${key}.jsonl`);
    const ts = old.getTime();
    fs.writeFileSync(f, JSON.stringify({ ts, kioskOrderId: "OLDORDER0001", state: "PENDING" }) + "\n" + JSON.stringify({ ts: ts + 1, externalId: "TBKOLDORDER0001-1", kioskOrderId: "OLDORDER0001", attempt: 1, state: "DECLINED", amountCents: 349, createdAt: ts, stateAt: ts + 1 }) + "\n");
    const r = rig({ dir, journal: J.createJournal({ dir }) });
    ok(!fs.existsSync(f), "a resolved journal file older than 30 days is gone after init");
    fp.shutdown();
    const f2 = path.join(dir, `pay-journal.${J.dayKey(old.getTime() - 864e5)}.jsonl`);
    fs.writeFileSync(f2, JSON.stringify({ ts: ts - 864e5, kioskOrderId: "OLDORDER0002", state: "PENDING" }) + "\n" + JSON.stringify({ ts: ts - 864e5 + 1, externalId: "TBKOLDORDER0002-1", kioskOrderId: "OLDORDER0002", attempt: 1, state: "TIMEOUT_UNKNOWN", amountCents: 349, createdAt: ts - 864e5, stateAt: ts - 864e5 + 1 }) + "\n");
    const j2 = J.createJournal({ dir }); j2.load(); rig({ dir, journal: j2 });
    ok(fs.existsSync(f2), "an UNKNOWN attempt's file is never purged");
  });

  await scenario("pay-resolve: the owner's decision for a stuck UNKNOWN (CR-013)", async () => {
    const resolve = require("../../tools/pay-resolve");
    const mk = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-paystate-")); const j = J.createJournal({ dir }); j.load(); const O = "OWNERORDER" + String(Math.floor(Math.random() * 1e4)).padStart(4, "0"); j.registerOrder(O);
      j.append({ externalId: `TBK${O}-1`, kioskOrderId: O, attempt: 1, state: "IN_FLIGHT", amountCents: 349, source: "local" }, { newAttempt: true });
      j.append({ externalId: `TBK${O}-1`, kioskOrderId: O, state: "DISCONNECTED_UNKNOWN", source: "local" }); return { dir, O, ext: `TBK${O}-1` }; };
    const lines = []; const out = l => lines.push(l);
    // not-charged -> COLLECT tag, no device needed
    let w = mk();
    eq(resolve.run(["--dir", w.dir, "--list"], out), 0); ok(lines.some(l => l.includes(w.ext)), "--list names the stuck attempt");
    eq(resolve.run(["--dir", w.dir, w.ext, "not-charged"], out), 0);
    let r = rig({ dir: w.dir, journal: (() => { const j = J.createJournal({ dir: w.dir }); j.load(); return j; })() });
    eq(r.state(w.ext), "CANCELLED"); eq(r.journal.get(w.ext).source, "local");
    await waitFor(() => r.lastTag() && r.lastTag().title === "TBK:COLLECT", 2000, "COLLECT tag from the owner's decision"); fp.shutdown();
    // charged -> PAID tag WITHOUT asking the reader (the owner vouches); the device is not even connected
    w = mk();
    eq(resolve.run(["--dir", w.dir, w.ext, "charged", "PAYIDOWNER01"], out), 0);
    r = rig({ dir: w.dir, journal: (() => { const j = J.createJournal({ dir: w.dir }); j.load(); return j; })() });
    await waitFor(() => r.lastTag() && r.lastTag().title === "TBK:PAID:PAYIDOWNER01", 2000, "PAID tag from the owner's decision"); fp.shutdown();
    // refuses what is not stuck, a bad verb and a bad payment id; ack-double
    eq(resolve.run(["--dir", w.dir, w.ext, "not-charged"], out), 1, "already resolved: refused");
    eq(resolve.run(["--dir", w.dir, w.ext, "maybe"], out), 2);
    w = mk(); eq(resolve.run(["--dir", w.dir, w.ext, "charged", "bad id!"], out), 2);
    const dj = J.createJournal({ dir: w.dir }); dj.load();
    dj.append({ externalId: w.ext, kioskOrderId: w.O, state: "DOUBLE", source: "device" });
    eq(resolve.run(["--dir", w.dir, "--list"], out), 0);
    eq(resolve.run(["--dir", w.dir, w.ext, "ack-double"], out), 0);
    const dj2 = J.createJournal({ dir: w.dir }); dj2.load(); eq(dj2.doubles().length, 0, "acknowledged");
  });

  await scenario("Snake Eyes 4: Pay at the window while the reader is waiting cancels the prompt and resolves COLLECT", async () => {
    const r = rig({ timing: { PAY_TIMEOUT_MS: 5000 } }); r.ready();
    const order = r.order(), ext = r.ext(order);
    r.fc.script.cancel = () => r.respond("CANCEL", null, "Request Canceled");          // the reader answers the ESC with a CANCEL response
    r.fc.script.sale = () => {};                                                       // the customer has not tapped
    const p = fp.pay({ orderId: order, amountCents: 349 }); await sleep(30);
    eq(r.state(ext), "IN_FLIGHT");
    const w = await fp.collect(order);
    eq(w.result, "collect", "the button does what it says");
    eq(r.fc.calls.filter(c => c.m === "cancel").length, 1, "an ESC (CANCEL_INPUT_OPTION) was sent to the reader");
    eq(r.fc.calls.find(c => c.m === "cancel").key, "ESC");
    eq(r.state(ext), "CANCELLED"); eq((await p).result, "cancelled");
    await waitFor(() => r.lastTag() && r.lastTag().title === "TBK:COLLECT", 2000, "COLLECT tag");
    eq((await fp.pay({ orderId: order, amountCents: 349 })).result, "unavailable", "and no card attempt can follow");
    // the customer's tap wins the race: the card is charged, so the answer is "approved", not COLLECT
    const o2 = r.order(), e2 = r.ext(o2); r.fc.script.cancel = () => r.respond("SUCCESS", mkPayment({ extId: e2, amount: 349, id: "PAYIDRACE999" }));
    const p2 = fp.pay({ orderId: o2, amountCents: 349 }); await sleep(30);
    eq((await fp.collect(o2)).result, "approved", "a charge always beats the window release");
    eq(r.state(e2), "APPROVED"); await p2;
    // if the reader never answers the ESC, the window release says "busy" (the page keeps waiting) and the sale stays IN_FLIGHT
    const o3 = r.order(); r.fc.script.cancel = () => {}; r.fc.script.sale = () => {};
    const p3 = fp.pay({ orderId: o3, amountCents: 349 }); await sleep(30);
    const slow = fp.collect(o3); const fast = await Promise.race([slow, sleep(300).then(() => "pending")]);
    eq(fast, "pending", "still waiting for the reader"); eq(r.state(r.ext(o3)), "IN_FLIGHT");
    fp.shutdown(); void p3;
  });

  /* ================= orphan device payment (superseded by CR-009 above; kept for a not-ours id) ================= */
  await scenario("a payment that is not one of ours is ignored", async () => {
    const r = rig(); r.ready();
    r.respond("SUCCESS", mkPayment({ extId: "NOTOURS-1" }));
    eq(r.journal.get("NOTOURS-1"), null);
  });

  mute(false);
  console.log(`pay-state: ${passed} checks passed across ${scenarios} scenarios`);
  process.exit(0);
})().catch(e => { mute(false); console.error(e); process.exit(1); });
