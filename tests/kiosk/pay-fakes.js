// tests/kiosk/pay-fakes.js — shared test doubles for the pay tests: REAL remote-pay-cloud objects plus a FAKE connector.
// Nothing here opens a socket, talks to a Flex, or talks to Clover.
"use strict";
const sdk = require("remote-pay-cloud");
const api = require("remote-pay-cloud-api");
sdk.payments = api.payments; sdk.remotemessage = api.remotemessage;

function mkPayment({ extId, amount = 349, result = "SUCCESS", id = "PAYID0000001", shell = "SHELLORD00001", last4 = "4242", brand = "VISA", entry = "EMV_CONTACTLESS" }) {
  const card = new api.payments.CardTransaction();
  card.setCardType(brand); card.setEntryType(entry); card.setLast4(last4);
  card.setFirst6("411111"); card.setCardholderName("PAT CARDHOLDER"); card.setToken("tok_SECRET"); card.setAuthCode("AUTH99");
  const ref = new api.base.Reference(); ref.setId(shell);
  const p = new api.payments.Payment();
  p.setId(id); p.setAmount(amount); p.setResult(result); p.setCardTransaction(card); p.setOrder(ref);
  if (extId) p.setExternalPaymentId(extId);
  return p;
}
function mkSale(rc, payment, message) {
  const r = new sdk.remotepay.SaleResponse();
  r.setResult(rc); r.setSuccess(rc === "SUCCESS");
  if (payment) r.setPayment(payment);
  if (message) r.setMessage(message);
  return r;
}
function mkRetrieve(extId, qs, payment) {
  const r = new sdk.remotepay.RetrievePaymentResponse();
  r.setExternalPaymentId(extId); r.setQueryStatus(qs); if (payment) r.setPayment(payment);
  return r;
}
function mkStatus(state) { const r = new sdk.remotepay.RetrieveDeviceStatusResponse(); r.setState(state); return r; }

/* ---------------- fake connector ---------------- */
class FakeConnector {
  constructor() { this.calls = []; this.listener = null; this.script = {}; this.deviceState = "IDLE"; }
  addCloverConnectorListener(l) { this.listener = l; }
  initializeConnection() {}
  sale(req) {
    const extId = req.getExternalId();
    this.calls.push({ m: "sale", extId, amount: req.getAmount(), req });
    if (this.script.saleThrows) throw new Error("socket exploded");
    if (this.script.sale) setImmediate(() => this.script.sale(extId, req));
  }
  retrievePayment(req) {
    const extId = req.getExternalPaymentId();
    this.calls.push({ m: "retrievePayment", extId });
    const r = this.script.retrievePayment ? this.script.retrievePayment(extId, this.calls.filter(c => c.m === "retrievePayment" && c.extId === extId).length) : { status: "NOT_FOUND" };
    if (r) setImmediate(() => this.listener.onRetrievePaymentResponse(mkRetrieve(extId, r.status, r.payment)));
  }
  retrieveDeviceStatus(req) {
    this.calls.push({ m: "status", replay: req.getSendLastMessage() });
    if (this.script.noStatus) return;
    setImmediate(() => { this.listener.onRetrieveDeviceStatusResponse(mkStatus(this.deviceState)); if (req.getSendLastMessage() && this.script.replay) this.script.replay(); });
  }
  invokeInputOption(io) { this.calls.push({ m: "cancel", key: io.getKeyPress() }); if (this.script.cancel) setImmediate(() => this.script.cancel()); }
  resetDevice() { this.calls.push({ m: "reset" }); setImmediate(() => this.listener.onResetDeviceResponse(new sdk.remotepay.ResetDeviceResponse())); }
  dispose() { this.calls.push({ m: "dispose" }); }
  rejectPayment() { this.calls.push({ m: "rejectPayment" }); }
  acceptSignature() { this.calls.push({ m: "acceptSignature" }); }
  count(m) { return this.calls.filter(c => c.m === m).length; }
}


module.exports = { sdk, api, mkPayment, mkSale, mkRetrieve, mkStatus, FakeConnector };
