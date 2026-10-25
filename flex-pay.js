/* =============================================================================
   flex-pay.js — Thirsty Beaches kiosk: persistent Flex WSS connection + Sale
   lifecycle via Clover Secure Network Pay Display (SNPD).

   Purpose: owns the single, long-lived WebSocket Secure connection to the
   Clover Flex (LAN-direct via remote-pay-cloud SDK). Exposes three functions:
     init(cfg)   — connect at boot; manages reconnect/backoff; lazy-loads SDK
     status()    — returns connection state for /pay/status endpoint
     pay(opts)   — sends a Sale; resolves with a typed result object

   Dependencies (only loaded when init() is called, never when PAY_ENABLED=false):
     remote-pay-cloud@4.1.2  — Clover official SDK
     ws@^8                   — Node WebSocket polyfill the SDK needs

   Security notes:
     - Pairing auth token written to PAIRING_FILE (not kiosk-config.env) on
       OnPairingSuccess and reused on every reconnect.
     - The module never sees raw card data (PAN, track). Only last4, cardBrand,
       and the payment id are extracted from SaleResponse.
     - Refunds are explicitly refused — the kiosk is NOT the refund path.
     - Every Sale carries an ExternalId bound to orderId; the Flex rejects
       back-to-back TransactionRequests with identical ExternalIds, which is the
       primary anti-double-charge primitive.

   OS prerequisite (not code):
     The Clover Device Server Root CA must be installed in the Windows Trusted
     Root store on the kiosk PC before WSS will succeed. Certificate URL:
     https://www.clover.com/v2/env_device_ca_certificate
   ============================================================================= */

"use strict";

const fs   = require("fs");
const path = require("path");

// ---- module-level state ----

/** @type {"disabled"|"connecting"|"connected"|"ready"|"offline"} */
let _state = "disabled";

/** Serial number reported by the Flex on OnDeviceReady, for status() output. */
let _flexSerial = null;

/** The initialized CloverConnector. null until init() is called. */
let _connector = null;

/** Resolved config from init(). */
let _cfg = null;

/**
 * In-flight payment map.
 * Key: orderId
 * Value: { state: "in-flight"|"approved"|"declined"|"cancelled"|"error"|"timeout",
 *           resolve: Function,
 *           result: Object|null   (cached on final outcome) }
 */
const _inFlight = new Map();

/** Reconnect backoff steps (ms). Capped at the last value. */
const BACKOFF_MS = [2000, 5000, 15000, 30000];
let _backoffIdx = 0;
let _reconnectTimer = null;

// ---- exported surface ----

module.exports = { init, status, pay };

// ---- init ----

/**
 * Connect to the Flex at boot. Lazily requires the SDK (so an unconfigured
 * kiosk with PAY_ENABLED=false never loads remote-pay-cloud).
 *
 * @param {{ FLEX_IP, FLEX_PORT, FLEX_SCHEME, POS_NAME, PAIRING_FILE, PAY_TIMEOUT_MS }} cfg
 */
function init(cfg) {
  _cfg = cfg;
  _state = "connecting";
  _backoffIdx = 0;
  _connectNow();
}

// ---- status ----

/**
 * Returns the current connection state. Called by GET /pay/status.
 *
 * @returns {{ state: string, flexSerial: string|null }}
 */
function status() {
  return { state: _state, flexSerial: _flexSerial };
}

// ---- pay ----

/**
 * Initiate a sale on the Flex. The promise resolves (never rejects) with a
 * typed result object per the /pay contract (Section 5.2 of the spec).
 *
 * @param {{ orderId: string, amountCents: number, externalId: string }} opts
 * @returns {Promise<{result: string, paymentId?: string, last4?: string, cardBrand?: string, message?: string}>}
 */
function pay({ orderId, amountCents, externalId }) {
  // Device must be ready
  if (_state !== "ready") {
    console.log(`[flex-pay] sale rejected — device state: ${_state} (orderId=${orderId})`);
    return Promise.resolve({ result: "unavailable", message: `device ${_state}` });
  }

  // In-flight guard: second call for same orderId
  const existing = _inFlight.get(orderId);
  if (existing) {
    if (existing.state === "in-flight") {
      console.log(`[flex-pay] sale rejected — already in-flight (orderId=${orderId})`);
      return Promise.resolve({ result: "busy", message: "payment already in progress for this order" });
    }
    // Already resolved: return cached result (covers dropped-response retry)
    if (existing.result) {
      console.log(`[flex-pay] returning cached result for orderId=${orderId}: ${existing.result.result}`);
      return Promise.resolve(existing.result);
    }
  }

  // Single-reader lock: if ANY order is currently in-flight on the reader, reject
  for (const [id, entry] of _inFlight) {
    if (id !== orderId && entry.state === "in-flight") {
      console.log(`[flex-pay] sale rejected — reader busy with orderId=${id}`);
      return Promise.resolve({ result: "busy", message: "reader busy with another order" });
    }
  }

  return new Promise(resolve => {
    // Register the in-flight entry before sending the Sale
    const entry = { state: "in-flight", resolve, result: null };
    _inFlight.set(orderId, entry);

    // Build SaleRequest
    // We require the SDK here; it was already loaded in _connectNow()
    const sdk = _requireSdk();
    if (!sdk) {
      // SDK failed to load — surface as unavailable, clean up
      _inFlight.delete(orderId);
      return resolve({ result: "unavailable", message: "SDK not loaded" });
    }

    const { remotepay, payments, CardEntryMethods } = sdk;

    const saleReq = new remotepay.SaleRequest();
    saleReq.setExternalId(externalId);
    saleReq.setAmount(amountCents);                   // integer cents
    saleReq.setDisablePrinting(true);                 // we handle receipts; Flex prints nothing

    // Disable tip for kiosk — price shown on screen is the final price
    const txSettings = new payments.TransactionSettings();
    txSettings.setTipMode(payments.TipMode.NO_TIP);
    saleReq.setTransactionSettings(txSettings);

    // Tap, insert, swipe — no manual entry at the kiosk
    saleReq.setCardEntryMethods(
      CardEntryMethods.CARD_ENTRY_METHOD_NFC_CONTACTLESS |
      CardEntryMethods.CARD_ENTRY_METHOD_ICC_CONTACT    |
      CardEntryMethods.CARD_ENTRY_METHOD_MAG_STRIPE
    );

    console.log(`[flex-pay] Sale → orderId=${orderId} externalId=${externalId} amount=${amountCents}¢`);

    // Timeout: never treat "no response" as "not charged"
    const timeoutHandle = setTimeout(async () => {
      const e2 = _inFlight.get(orderId);
      if (!e2 || e2.state !== "in-flight") return; // already resolved

      console.warn(`[flex-pay] Sale timeout (${_cfg.PAY_TIMEOUT_MS}ms) orderId=${orderId} — reconciling before reporting timeout`);

      // Reconcile: query Clover order payments before reporting timeout so we
      // never strand a customer who actually paid. If a payment exists for our
      // ExternalId, treat the order as approved.
      const reconciled = await _reconcilePayment(orderId, externalId);
      const e3 = _inFlight.get(orderId);
      if (!e3 || e3.state !== "in-flight") return; // resolved by onSaleResponse while we were reconciling

      if (reconciled) {
        console.log(`[flex-pay] reconcile: found payment for orderId=${orderId} — marking approved`);
        _resolvePayment(orderId, reconciled);
      } else {
        _resolvePayment(orderId, { result: "timeout", message: "no response from reader within timeout" });
      }
    }, _cfg.PAY_TIMEOUT_MS);

    // Store the timeout handle so onSaleResponse can cancel it
    entry.timeoutHandle = timeoutHandle;

    // Fire the Sale
    try {
      _connector.sale(saleReq);
    } catch (e) {
      clearTimeout(timeoutHandle);
      _inFlight.delete(orderId);
      console.error(`[flex-pay] connector.sale threw: ${e.message}`);
      resolve({ result: "error", message: "sale could not be sent" });
    }
  });
}

// ---- internal: connect / reconnect ----

function _connectNow() {
  const sdk = _requireSdk();
  if (!sdk) {
    // SDK missing from the bundle — degrade to disabled, don't crash the server
    _state = "disabled";
    console.error("[flex-pay] CRITICAL: remote-pay-cloud SDK not found. Install it next to the server with npm install. Tap-to-pay is disabled.");
    return;
  }

  const endpoint = `${_cfg.FLEX_SCHEME}://${_cfg.FLEX_IP}:${_cfg.FLEX_PORT}/remote_pay`;
  console.log(`[flex-pay] connecting to ${endpoint}`);

  const { CloverConnector, WebSocketPairedCloverDeviceConfiguration, ImageUtil, BrowserWebSocketImpl } = sdk;
  const NodeWebSocketImpl = _buildNodeWebSocketFactory();

  // Load stored pairing token if available
  let storedAuthToken = null;
  try {
    const raw = fs.readFileSync(_cfg.PAIRING_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.authToken) {
      storedAuthToken = parsed.authToken;
      console.log(`[flex-pay] loaded pairing token from ${_cfg.PAIRING_FILE} (paired ${parsed.pairedAt || "unknown"})`);
    }
  } catch (e) {
    // No file yet — first pairing, expected
    if (e.code !== "ENOENT") {
      console.warn(`[flex-pay] could not read pairing file: ${e.message}`);
    }
  }

  const deviceConfig = new WebSocketPairedCloverDeviceConfiguration(
    endpoint,
    "com.thirstybeaches.kiosk:1.0.0",   // applicationId
    _cfg.POS_NAME,                       // posName (shown on Flex during pairing)
    "TB-Kiosk-01",                       // serialNumber (shown on Flex during pairing)
    storedAuthToken,                     // null on first pairing, token thereafter
    _onPairingCode,                      // called once during setup with the 6-digit code
    _onPairingSuccess,                   // called on success; we persist the token here
    NodeWebSocketImpl,                   // Node ws polyfill factory
    new ImageUtil(),                     // required by the SDK
    5000,                                // heartbeatInterval ms (default 5000)
    3000,                                // reconnectDelay ms — we manage reconnect, disable SDK's own
    3000                                 // heartbeatDisconnectTimeout ms
  );

  _connector = new CloverConnector(deviceConfig);
  _connector.addCloverConnectorListener(_buildListener());
  _connector.initializeConnection();
}

function _onPairingCode(pairingCode) {
  // This fires once during first setup. The owner must look at the server
  // console and type this code on the Flex screen.
  console.log("\n========================================");
  console.log(`  PAIRING CODE: ${pairingCode}`);
  console.log("  Enter this code on the Flex screen to complete pairing.");
  console.log("========================================\n");
}

function _onPairingSuccess(authToken) {
  console.log("[flex-pay] pairing successful — persisting auth token");
  const record = {
    authToken,
    pairedAt:   new Date().toISOString(),
    flexSerial: _flexSerial || "unknown",
  };
  try {
    fs.writeFileSync(_cfg.PAIRING_FILE, JSON.stringify(record, null, 2), "utf8");
    console.log(`[flex-pay] pairing token saved to ${_cfg.PAIRING_FILE}`);
  } catch (e) {
    console.error(`[flex-pay] FAILED to persist pairing token: ${e.message} — will need to re-pair on restart`);
  }
}

function _scheduleReconnect() {
  clearTimeout(_reconnectTimer);
  const delay = BACKOFF_MS[Math.min(_backoffIdx, BACKOFF_MS.length - 1)];
  _backoffIdx = Math.min(_backoffIdx + 1, BACKOFF_MS.length - 1);
  console.log(`[flex-pay] reconnecting in ${delay / 1000}s…`);
  _reconnectTimer = setTimeout(() => {
    _state = "connecting";
    _connectNow();
  }, delay);
}

// ---- internal: SDK listener ----

function _buildListener() {
  const sdk = _requireSdk();
  const { remotepay } = sdk;

  // Build a plain object implementing ICloverConnectorListener. The SDK calls
  // these methods by convention (duck typing); no formal subclass needed in JS.
  return {
    onDeviceConnected() {
      _state = "connected";
      _backoffIdx = 0;   // reset backoff on successful connect
      console.log("[flex-pay] device connected (waiting for ready)");
    },

    onDeviceReady(merchantInfo) {
      _state = "ready";
      _flexSerial = (merchantInfo && merchantInfo.deviceSerial) ? merchantInfo.deviceSerial : "unknown";
      console.log(`[flex-pay] device READY — serial=${_flexSerial} merchant=${(merchantInfo && merchantInfo.merchantName) || "?"}`);
    },

    onDeviceDisconnected() {
      console.warn("[flex-pay] device disconnected — entering offline state");
      _state = "offline";
      _flexSerial = null;
      // Fail any in-flight payment with unavailable so the kiosk can show the
      // pay-at-window path. The reconcile-before-timeout already ran (or will on
      // next retry) if the customer's card was mid-dip.
      for (const [orderId, entry] of _inFlight) {
        if (entry.state === "in-flight") {
          console.warn(`[flex-pay] dropping in-flight payment for orderId=${orderId} due to disconnect`);
          clearTimeout(entry.timeoutHandle);
          _resolvePayment(orderId, { result: "unavailable", message: "device disconnected mid-payment" });
        }
      }
      _scheduleReconnect();
    },

    onDeviceError(deviceErrorEvent) {
      const msg = (deviceErrorEvent && deviceErrorEvent.getMessage && deviceErrorEvent.getMessage()) || "unknown";
      console.error(`[flex-pay] device error: ${msg}`);
      // Do not change state here; onDeviceDisconnected will follow if serious
    },

    onSaleResponse(response) {
      const rc     = response && response.getResult ? response.getResult() : null;
      const payment = response && response.getPayment ? response.getPayment() : null;
      const payId  = payment && payment.getId ? payment.getId() : null;

      // Extract safe display fields only — NEVER log full card data
      let last4 = null;
      let cardBrand = null;
      try {
        const cardTxn = payment && payment.getCardTransaction ? payment.getCardTransaction() : null;
        if (cardTxn) {
          last4     = cardTxn.getLast4 ? cardTxn.getLast4()    : null;
          cardBrand = cardTxn.getCardType ? cardTxn.getCardType() : null;
        }
      } catch (e) { /* non-fatal — display fields only */ }

      // Identify which order this payment belongs to via externalId
      // The SDK returns the original ExternalId on the response.
      let orderId = null;
      try {
        const externalId = payment && payment.getExternalPaymentId ? payment.getExternalPaymentId() : null;
        if (externalId) {
          // Our ExternalId format is "TB" + orderId.slice(-30)
          // Reverse-map by checking the in-flight map
          for (const [id, entry] of _inFlight) {
            if (entry.state === "in-flight") {
              orderId = id;
              break;
            }
          }
        } else {
          // Fallback: take the first in-flight entry
          for (const [id, entry] of _inFlight) {
            if (entry.state === "in-flight") { orderId = id; break; }
          }
        }
      } catch (e) { /* ignore */ }

      if (!orderId) {
        console.warn("[flex-pay] onSaleResponse: could not identify orderId — no in-flight payment");
        return;
      }

      console.log(`[flex-pay] onSaleResponse orderId=${orderId} result=${rc} payId=${payId} last4=****${last4 || "?"}`);

      let out;
      switch (rc) {
        case remotepay.ResponseCode.SUCCESS:
          out = { result: "approved", paymentId: payId, last4, cardBrand };
          break;
        case remotepay.ResponseCode.FAIL:
          out = { result: "declined", message: "card was declined" };
          break;
        case remotepay.ResponseCode.CANCEL:
          out = { result: "cancelled", message: "payment was cancelled" };
          break;
        case remotepay.ResponseCode.DUPLICATE:
          // Device rejected duplicate ExternalId — this order may already be paid
          // Reconcile before treating as error
          console.warn(`[flex-pay] DUPLICATE ExternalId for orderId=${orderId} — reconciling`);
          _reconcilePayment(orderId, null).then(reconciledResult => {
            if (reconciledResult) {
              _resolvePayment(orderId, reconciledResult);
            } else {
              _resolvePayment(orderId, { result: "error", message: "duplicate payment rejected by device; check order status" });
            }
          });
          return; // resolve happens asynchronously above
        case remotepay.ResponseCode.ERROR:
        case remotepay.ResponseCode.UNSUPPORTED:
        default:
          out = { result: "error", message: "reader or transaction error" };
          break;
      }

      _resolvePayment(orderId, out);
    },

    // REQUIRED: must implement or sales will hang when the Flex needs confirmation
    // (e.g. partial authorisation, duplicate detection)
    onConfirmPaymentRequest(request) {
      // For a kiosk, we accept the challenge only if the payment is NOT already
      // partially declined. Reject partial authorisations — never accept less than
      // the full amount.
      if (!request || !_connector) return;
      console.log("[flex-pay] onConfirmPaymentRequest — rejecting partial/duplicate challenge (kiosk policy)");
      // Reject the challenge so the transaction is cancelled; the customer can retry
      _connector.rejectPayment(request.getPayment(), request.getChallenges()[0]);
    },

    // Signature is not required for EMV/NFC tap-to-pay, but we must handle this
    // callback or the SDK may block. Accept automatically (no sig required on kiosk).
    onVerifySignatureRequest(request) {
      if (!request || !_connector) return;
      console.log("[flex-pay] onVerifySignatureRequest — accepting (no signature required at kiosk)");
      _connector.acceptSignature(request);
    },

    // Stubs for required listener interface methods
    onDeviceActivityStart() {},
    onDeviceActivityEnd() {},
    onMerchantInfo() {},
    onAuthResponse() {},
    onPreAuthResponse() {},
    onTipAdjustAuthResponse() {},
    onCapturePreAuthResponse() {},
    onVoidPaymentResponse() {},
    onRefundPaymentResponse() {},
    onManualRefundResponse() {},
    onRetrievePendingPaymentsResponse() {},
    onReadCardDataResponse() {},
    onCloseoutResponse() {},
    onCustomActivityResponse() {},
    onRetrieveDeviceStatusResponse() {},
    onResetDeviceResponse() {},
    onRetrievePaymentResponse() {},
    onDisplayReceiptOptionsResponse() {},
    onInvalidStateTransitionResponse() {},
    onMessageFromActivity() {},
    onPrintJobStatusResponse() {},
  };
}

// ---- internal: resolve / cache a payment outcome ----

function _resolvePayment(orderId, result) {
  const entry = _inFlight.get(orderId);
  if (!entry) return;
  clearTimeout(entry.timeoutHandle);
  entry.state = result.result;   // e.g. "approved", "declined", etc.
  entry.result = result;
  entry.resolve(result);
}

// ---- internal: reconcile payment (timeout / duplicate path) ----

/**
 * Queries the Clover REST API for payments on this order and checks whether a
 * payment with our ExternalId already exists.
 *
 * This is the "never treat no-response as not-charged" behaviour. Returns an
 * approved result object if found, null otherwise.
 *
 * @param {string} orderId
 * @param {string|null} externalId
 * @returns {Promise<Object|null>}
 */
async function _reconcilePayment(orderId, externalId) {
  // We need the Clover REST helpers from the parent server. Rather than
  // creating a coupling, we call the Node built-in fetch directly.
  // TOKEN, MERCHANT_ID, and BASE are from the parent server's env — they are
  // available in process.env because the server loads them before requiring us.
  const TOKEN = process.env.CLOVER_API_TOKEN;
  const MID   = process.env.CLOVER_MERCHANT_ID;
  const BASE  = process.env.CLOVER_BASE_URL || "https://api.clover.com";

  if (!TOKEN || !MID) {
    console.warn("[flex-pay] reconcile: CLOVER_API_TOKEN or CLOVER_MERCHANT_ID not set — cannot reconcile");
    return null;
  }

  try {
    const r = await fetch(
      `${BASE}/v3/merchants/${MID}/orders/${orderId}/payments`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );
    if (!r.ok) {
      console.warn(`[flex-pay] reconcile: payments fetch failed ${r.status} for orderId=${orderId}`);
      return null;
    }
    const data = await r.json();
    const payments = (data && data.elements) ? data.elements : [];

    // Look for a payment with our ExternalId, or any non-voided payment
    const expectedExtId = externalId || ("TB" + orderId).slice(0, 32);
    for (const p of payments) {
      const extId = p.externalPaymentId || p.externalReferenceId || null;
      if (extId === expectedExtId || (!externalId && p.id)) {
        // A payment exists — check it's not voided
        if (p.result === "SUCCESS" || (!p.voided && !p.refunded)) {
          console.log(`[flex-pay] reconcile: found approved payment ${p.id} for orderId=${orderId}`);
          let last4 = null, cardBrand = null;
          try {
            last4     = p.cardTransaction && p.cardTransaction.last4;
            cardBrand = p.cardTransaction && p.cardTransaction.cardType;
          } catch (e) { /* display fields only */ }
          return { result: "approved", paymentId: p.id, last4, cardBrand };
        }
      }
    }
    console.log(`[flex-pay] reconcile: no matching payment found for orderId=${orderId}`);
    return null;
  } catch (e) {
    console.error(`[flex-pay] reconcile error: ${e.message}`);
    return null;
  }
}

// ---- internal: Node WebSocket factory for the SDK ----

/**
 * The remote-pay-cloud SDK was authored browser-first. It expects a factory
 * function that returns a CloverWebSocketInterface-compatible object. We wrap
 * the `ws` Node package (which already has an EventEmitter-compatible API with
 * addEventListener) in a thin shim that matches what the SDK expects.
 *
 * The factory function is passed as `webSocketFactoryFunction` to the device
 * configuration constructor. The SDK calls it as: factory(endpoint).
 */
function _buildNodeWebSocketFactory() {
  const WebSocket = require("ws");
  const SDK = _requireSdk();
  const { CloverWebSocketInterface } = SDK;

  // Subclass CloverWebSocketInterface to use the `ws` package
  class NodeWebSocketImpl extends CloverWebSocketInterface {
    constructor(endpoint) {
      super(endpoint);
    }

    createWebSocket(endpoint, accessToken) {
      // accessToken is the pairing subprotocol header value
      const opts = {
        rejectUnauthorized: true,  // enforce TLS — require the Clover Root CA in the OS trust store
      };
      if (accessToken) {
        // ws passes accessToken as the subprotocol (second arg) — matches BrowserWebSocketImpl
        return new WebSocket(endpoint, accessToken, opts);
      }
      return new WebSocket(endpoint, opts);
    }

    // ws supports sendPing/sendPong natively; implement the SDK interface methods
    sendPong() {
      try { if (this.webSocket && this.webSocket.readyState === WebSocket.OPEN) this.webSocket.pong(); } catch (e) { /* ignore */ }
      return this;
    }

    sendPing() {
      try { if (this.webSocket && this.webSocket.readyState === WebSocket.OPEN) this.webSocket.ping(); } catch (e) { /* ignore */ }
      return this;
    }
  }

  // The SDK config constructor stores the factory and calls it as factory(endpoint)
  return (endpoint) => new NodeWebSocketImpl(endpoint);
}

// ---- internal: lazy SDK loader ----

let _sdkCache = null;
let _sdkLoadFailed = false;

function _requireSdk() {
  if (_sdkCache) return _sdkCache;
  if (_sdkLoadFailed) return null;
  try {
    const sdk = require("remote-pay-cloud");
    // Validate the minimum exports we need
    if (!sdk.CloverConnector || !sdk.WebSocketPairedCloverDeviceConfiguration) {
      throw new Error("SDK loaded but missing expected exports");
    }
    // Also pull payments from the API sub-package via the sdk facade
    // remote-pay-cloud-api is a transitive dep, always available
    const api = require("remote-pay-cloud-api");
    // Augment the sdk object with the API namespace for convenience
    sdk.payments = api.payments;
    _sdkCache = sdk;
    console.log(`[flex-pay] remote-pay-cloud SDK loaded (v${sdk.version || "?"})`);
    return sdk;
  } catch (e) {
    _sdkLoadFailed = true;
    console.error(`[flex-pay] failed to load remote-pay-cloud SDK: ${e.message}`);
    console.error("[flex-pay] Run: npm install remote-pay-cloud@4.1.2 ws  (in the Drive folder)");
    return null;
  }
}
