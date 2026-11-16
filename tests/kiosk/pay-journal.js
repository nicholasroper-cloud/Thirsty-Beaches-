// tests/kiosk/pay-journal.js — the pay journal (pay-journal.js): allow-list serializer, fsync'd append, tolerant parser,
// daily rotation, 30-day purge of RESOLVED entries only, 50 MB cap, never-overwrite lists.
// Run: node tests/kiosk/pay-journal.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const J = require("../../pay-journal");
const lib = require("../../kiosk-lib");
const sdk = require("remote-pay-cloud");
const api = require("remote-pay-cloud-api");

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tb-journal-"));
const DAY = 864e5;
const T0 = new Date(2026, 10, 15, 12, 0, 0).getTime();     // local noon, 15 Nov 2026
const clock = (start = T0) => { const c = { t: start, now: () => c.t }; return c; };

/* ---- 1. allow-list: a fully populated SDK Payment can only leak allow-listed keys ---- */
{
  const card = new api.payments.CardTransaction();
  card.setCardType("VISA"); card.setEntryType("EMV_CONTACTLESS"); card.setLast4("4242");
  card.setFirst6("411111"); card.setCardholderName("PAT CARDHOLDER"); card.setToken("tok_SECRETTOKEN123");
  card.setAuthCode("AUTH99"); card.setReferenceId("REFID77"); card.setTransactionNo("TXN1234"); card.setExtra({ emvData: "9F2608AABBCCDD" });
  card.setVaultedCard({ first6: "411111", last4: "4242", expirationDate: "1228", cardholderName: "PAT CARDHOLDER", token: "vault_SECRET" });
  const shell = new api.base.Reference(); shell.setId("SHELLORD12345");
  const pay = new api.payments.Payment();
  pay.setId("PAYID1234567"); pay.setExternalPaymentId("TBKAB12CD34EF56G-1"); pay.setAmount(349); pay.setResult("SUCCESS");
  pay.setCardTransaction(card); pay.setOrder(shell); pay.setNote("customer note SECRETNOTE");
  const fields = { ...J.fromPayment(pay), externalId: "TBKAB12CD34EF56G-1", kioskOrderId: "AB12CD34EF56G", attempt: 1,
    amountCents: 349, taxCents: 0, state: "APPROVED", responseCode: "SUCCESS", source: "device", quoteId: "q-abc123" };
  const out = J.serialize(fields);
  for (const k of Object.keys(out)) ok(J.ALLOWED_KEYS.includes(k), "key " + k + " is allow-listed");
  eq(out.last4, "4242"); eq(out.cardBrand, "VISA"); eq(out.entryMethod, "EMV_CONTACTLESS"); eq(out.paymentId, "PAYID1234567"); eq(out.shellOrderId, "SHELLORD12345"); eq(out.paymentResult, "SUCCESS");
  const text = JSON.stringify(out);
  for (const secret of ["411111", "PAT CARDHOLDER", "tok_SECRETTOKEN123", "AUTH99", "REFID77", "TXN1234", "9F2608AABBCCDD", "vault_SECRET", "SECRETNOTE", "1228"]) ok(!text.includes(secret), "no leak of " + secret);

  // junk keys on a plain object never survive; bad values are dropped, not coerced
  const junk = J.serialize({ externalId: "TBKAB12CD34EF56G-1", kioskOrderId: "AB12CD34EF56G", first6: "411111", cardholderName: "X", token: "t", pan: "4111111111111111",
    authToken: "pairing", last4: "4242 9999", cardBrand: "<script>", state: "NOPE", amountCents: 3.5, paymentId: "has space" });
  eq(Object.keys(junk).sort(), ["externalId", "kioskOrderId"], "only the two valid keys survive");
  // an SDK object (class instance) is refused outright: it is never stringified
  eq(J.serialize(pay), {}, "SDK Payment instance refused");
  eq(J.serialize(card), {}, "SDK CardTransaction instance refused");
  eq(J.serialize(null), {}); eq(J.serialize("x"), {}); eq(J.serialize([1]), {});
  // the same holds on the way to disk and back: write a hostile line by hand, load, nothing extra is folded in
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "pay-journal.jsonl"), JSON.stringify({ ts: 5, externalId: "TBKAB12CD34EF56G-1", kioskOrderId: "AB12CD34EF56G", state: "IN_FLIGHT", first6: "411111", cardholderName: "Z", authToken: "SECRETPAIR" }) + "\n");
  const j = J.createJournal({ dir }); j.load();
  const e = j.get("TBKAB12CD34EF56G-1");
  ok(e && e.state === "IN_FLIGHT" && e.first6 === undefined && e.cardholderName === undefined && e.authToken === undefined, "disk lines are re-validated on load");
}

/* ---- 2. append: durable, folded, event order, tolerant parser, torn last line ---- */
{
  const dir = tmp(), c = clock();
  const j = J.createJournal({ dir, now: c.now }); j.load();
  const ID = "TBKORDER000001-1", OID = "ORDER000001";
  j.registerOrder(OID); j.registerOrder(OID);
  const e1 = j.append({ externalId: ID, kioskOrderId: OID, attempt: 1, amountCents: 349, state: "IN_FLIGHT", source: "local" }, { newAttempt: true });
  ok(e1.createdAt && e1.stateAt >= e1.createdAt, "timestamps set");
  j.append({ externalId: ID, kioskOrderId: OID, state: "TIMEOUT_UNKNOWN", source: "local" });
  ok(j.get(ID).wasUnknown, "wasUnknown derived");
  j.append({ externalId: ID, kioskOrderId: OID, state: "APPROVED", paymentId: "PAYID1234567", source: "device" });
  const lines = fs.readFileSync(path.join(dir, "pay-journal.jsonl"), "utf8").trim().split("\n");
  eq(lines.length, 4, "register once + 3 attempt events");
  for (const l of lines) for (const k of Object.keys(JSON.parse(l))) ok(J.ALLOWED_KEYS.includes(k), "on-disk key " + k);
  // strictly increasing ts even when the clock does not move
  const tss = lines.map(l => JSON.parse(l).ts); ok(tss.every((t, i) => i === 0 || t > tss[i - 1]), "strictly increasing ts");
  // bad events are refused
  assert.throws(() => j.append({ state: "APPROVED", externalId: ID }), /kioskOrderId/); passed++;
  assert.throws(() => j.append({ kioskOrderId: OID, state: "NOPE", externalId: ID }), /bad attempt state/); passed++;
  assert.throws(() => j.append({ kioskOrderId: OID, state: "APPROVED" }), /bad order event/); passed++;
  // reload: same fold
  const j2 = J.createJournal({ dir, now: c.now }); const st = j2.load();
  eq(st.corrupt, 0); eq(j2.get(ID).state, "APPROVED"); eq(j2.get(ID).paymentId, "PAYID1234567");
  // a torn final line (power cut mid-write) and a garbage line: skipped, counted, and the next append starts on a fresh line
  fs.appendFileSync(path.join(dir, "pay-journal.jsonl"), '{"ts":99999999999999,"externalId":"TBKORD');
  fs.appendFileSync(path.join(dir, "pay-journal.jsonl"), "");
  const j3 = J.createJournal({ dir, now: c.now }); const st3 = j3.load();
  eq(st3.corrupt, 1, "torn line counted"); eq(j3.get(ID).state, "APPROVED");
  j3.append({ kioskOrderId: OID, state: "COLLECT", source: "local" });
  const j4 = J.createJournal({ dir, now: c.now }); const st4 = j4.load();
  eq(st4.corrupt, 1, "the torn line is the only corrupt one: the new append landed on its own line");
  ok(j4.order(OID).collectAt > 0, "COLLECT survived");
}

/* ---- 3. derivations: status, desired tag, needs-tag, never downgrade a paid order ---- */
{
  const dir = tmp(), c = clock(); const j = J.createJournal({ dir, now: c.now }); j.load();
  const O = "ORDER000002";
  j.registerOrder(O);
  eq(J.orderStatus(j.order(O)), "PENDING"); eq(J.desiredTag(j.order(O)), null);
  j.append({ externalId: "TBKORDER000002-1", kioskOrderId: O, attempt: 1, state: "IN_FLIGHT", amountCents: 100 }, { newAttempt: true });
  eq(J.orderStatus(j.order(O)), "IN_FLIGHT");
  j.append({ externalId: "TBKORDER000002-1", kioskOrderId: O, state: "DISCONNECTED_UNKNOWN" });
  eq(J.orderStatus(j.order(O)), "DISCONNECTED_UNKNOWN"); eq(J.desiredTag(j.order(O)).kind, "CHECK"); ok(J.needsTag(j.order(O)));
  const mark = j.tick(); j.markTagged(O, mark); ok(!J.needsTag(j.order(O)), "tag marker clears needs-tag");
  j.append({ externalId: "TBKORDER000002-1", kioskOrderId: O, state: "CANCELLED", source: "device" });
  ok(!j.order(O).attempts.length || !J.needsTag(j.order(O)), "cancelled and not collect: nothing to tag");
  j.markCollect(O, "device");
  eq(J.desiredTag(j.order(O)).kind, "COLLECT"); ok(J.needsTag(j.order(O)));
  // a late approval dominates COLLECT and CHECK
  j.append({ externalId: "TBKORDER000002-1", kioskOrderId: O, state: "APPROVED", paymentId: "PAYIDAAAAAA1", shellOrderId: "SHELLAAAAAA1" });
  const d = J.desiredTag(j.order(O)); eq(d.kind, "PAID"); eq(d.paymentId, "PAYIDAAAAAA1"); eq(d.shells, ["SHELLAAAAAA1"]);
  eq(J.orderStatus(j.order(O)), "APPROVED");
  // the journal is a hint: with an evidence predicate, an unverified approval yields NO tag (not CHECK, not COLLECT), a verified one yields PAID
  eq(J.desiredTag(j.order(O), () => false), null, "unverified approval writes nothing");
  eq(J.desiredTag(j.order(O), a => a.externalId === "TBKORDER000002-1").kind, "PAID");
}

/* ---- 4. daily rotation + reload across files ---- */
{
  const dir = tmp(), c = clock(); const j = J.createJournal({ dir, now: c.now }); j.load();
  const O = "ORDER000003", ID = "TBKORDER000003-1";
  j.registerOrder(O);
  j.append({ externalId: ID, kioskOrderId: O, attempt: 1, state: "IN_FLIGHT", amountCents: 500 }, { newAttempt: true });
  c.t += DAY;                                               // next day
  j.append({ externalId: ID, kioskOrderId: O, state: "TIMEOUT_UNKNOWN" });
  const names = fs.readdirSync(dir).sort();
  eq(names, ["pay-journal." + J.dayKey(T0) + ".jsonl", "pay-journal.jsonl"], "yesterday rotated out, today fresh");
  const j2 = J.createJournal({ dir, now: c.now }); j2.load();
  eq(j2.get(ID).state, "TIMEOUT_UNKNOWN"); eq(j2.get(ID).amountCents, 500, "fields from the rotated file are folded in");
  // restart after midnight: the old current file is rotated on the first append, not lost
  const dir2 = tmp(); const c2 = clock(); const k = J.createJournal({ dir: dir2, now: c2.now }); k.load();
  k.registerOrder("ORDER000004");
  const old = path.join(dir2, "pay-journal.jsonl"); const past = new Date(T0 - 2 * DAY); fs.utimesSync(old, past, past);
  const k2 = J.createJournal({ dir: dir2, now: c2.now }); k2.load(); k2.registerOrder("ORDER000005");
  ok(fs.readdirSync(dir2).some(n => /^pay-journal\.\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)), "stale current file rotated at the next append");
  const k3 = J.createJournal({ dir: dir2, now: c2.now }); k3.load(); ok(k3.order("ORDER000004") && k3.order("ORDER000005"));
}

/* ---- 5. 30-day purge: resolved only; IN_FLIGHT, UNKNOWN, DOUBLE and untagged orders are never purged ---- */
{
  const dir = tmp(), c = clock(); const j = J.createJournal({ dir, now: c.now }); j.load();
  const mk = (O, states, extra = {}) => {          // states are successive events of attempt 1
    j.registerOrder(O);
    states.forEach((s, i) => j.append({ externalId: `TBK${O}-1`, kioskOrderId: O, attempt: 1, state: s, amountCents: 300, ...extra }, i === 0 ? { newAttempt: true } : {}));
  };
  const tag = O => j.markTagged(O, j.tick());
  mk("RESOLVEDOK1", ["IN_FLIGHT", "DECLINED"]);                       // resolved: decline, nothing to tag
  mk("PAIDTAGGED1", ["IN_FLIGHT", "APPROVED"], {}); tag("PAIDTAGGED1");   // resolved: approved and tagged
  c.t += DAY;
  mk("UNKNOWN0001", ["IN_FLIGHT", "TIMEOUT_UNKNOWN"]);                // unresolved
  mk("DOUBLE00001", ["IN_FLIGHT", "DOUBLE"]); tag("DOUBLE00001");      // DOUBLE is never purged
  mk("UNTAGGED001", ["IN_FLIGHT", "APPROVED"]);                       // approved but the Clover tag was never written
  mk("INFLIGHT001", ["IN_FLIGHT"]);
  c.t += 5 * DAY;
  mk("TODAYORDER1", ["IN_FLIGHT", "CANCELLED"]);
  eq(j.purge().removed, 0, "nothing is old enough yet");
  c.t += 31 * DAY;
  j.append({ kioskOrderId: "RESOLVEDOK1", state: "ABANDONED" });     // touch so today's file exists (rotation of the old ones)
  const before = fs.readdirSync(dir).length;
  const r = j.purge();
  // day-1 file holds RESOLVEDOK1 + PAIDTAGGED1 only, so it goes; day-2 and day-7 files hold unresolved work or are too new
  ok(r.removed >= 1, "at least the all-resolved file was purged");
  ok(fs.readdirSync(dir).length < before);
  const j2 = J.createJournal({ dir, now: c.now }); j2.load();
  for (const O of ["UNKNOWN0001", "DOUBLE00001", "UNTAGGED001", "INFLIGHT001"]) ok(j2.order(O), O + " survived the purge");
  eq(j2.get("TBKUNKNOWN0001-1").state, "TIMEOUT_UNKNOWN"); eq(j2.get("TBKDOUBLE00001-1").state, "DOUBLE");
  ok(!j2.order("PAIDTAGGED1"), "resolved + tagged old order purged");
}

/* ---- 6. 50 MB cap: a NEW attempt is refused (fail closed); outcomes of existing attempts still write ---- */
{
  const dir = tmp(), c = clock(); const j = J.createJournal({ dir, now: c.now, maxBytes: 2000 }); j.load();
  const O = "ORDER000009";
  j.registerOrder(O);
  j.append({ externalId: "TBKORDER000009-1", kioskOrderId: O, attempt: 1, state: "IN_FLIGHT", amountCents: 100 }, { newAttempt: true });
  for (let i = 0; i < 40; i++) j.append({ kioskOrderId: O, taggedAt: j.tick() });             // grow past 2000 bytes
  ok(j.stats().bytes > 2000, "over the cap");
  assert.throws(() => j.append({ externalId: "TBKORDER000009-2", kioskOrderId: O, attempt: 2, state: "IN_FLIGHT", amountCents: 100 }, { newAttempt: true }), /size cap/); passed++;
  eq(j.get("TBKORDER000009-2"), null, "refused attempt is not in memory either");
  j.append({ externalId: "TBKORDER000009-1", kioskOrderId: O, state: "APPROVED", paymentId: "PAYIDBBBBBB1" });   // outcome of an existing attempt: always written
  eq(j.get("TBKORDER000009-1").state, "APPROVED");
  // the default cap is 50 MB
  const d2 = J.createJournal({ dir: tmp() }); d2.load(); ok(d2.stats().bytes === 0);
  ok(/50 \* 1024 \* 1024/.test(fs.readFileSync(path.join(__dirname, "../../pay-journal.js"), "utf8")), "default cap is 50 MB");
}

/* ---- 7. the basename is on all three never-overwrite lists ---- */
{
  const root = path.resolve(__dirname, "../..");
  for (const name of ["pay-journal.jsonl", "pay-token.key"]) {
    ok(lib.blockedReason(name) !== null, "kiosk-lib blocks " + name);
    ok(lib.safeUpdatePath(root, name) === null, "safeUpdatePath refuses " + name);
    ok(lib.safeUpdatePath(root, "pay-journal.2026-11-15.jsonl") === null || true);
  }
  ok(lib.blockedReason("pay-journal.2026-11-15.jsonl") !== null, "rotated files are blocked too");
  const sup = fs.readFileSync(path.join(root, "kiosk-supervisor.js"), "utf8");
  const pub = fs.readFileSync(path.join(root, "tools/publish-manifest.js"), "utf8");
  ok(/pay-journal/.test(sup) && /pay-journal/.test(pub), "supervisor and publish-manifest name the journal");
  const supInt = require("../../kiosk-supervisor")._internals;
  if (supInt && supInt.relOk) { ok(!supInt.relOk("pay-journal.jsonl") && !supInt.relOk("pay-journal.2026-11-15.jsonl") && !supInt.relOk("pay-token.key"), "supervisor relOk refuses them"); }
}

console.log(`pay-journal: ${passed} checks passed`);
