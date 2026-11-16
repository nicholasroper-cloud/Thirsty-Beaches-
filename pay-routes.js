/* =============================================================================
   pay-routes.js — Thirsty Beaches kiosk: the tap-to-pay HTTP routes.

   Purpose: /pay/status, /payconfig, /pay, /pay/state, /pay/window, /pay/abandon, with the
   security review Q5 conditions applied in one place:
     - /order returns a 128-bit payToken (registerOrder); every pay route that acts on an
       order requires it, in constant time, and acts only on orders in this server's journal
     - /pay/abandon deletes only PENDING, DECLINED or CANCELLED orders that have no charge in
       the journal and no payment in Clover, and only when the reader is confirmed idle
     - /pay is rate limited to 6 per minute (and quoteAllowed() gives /quote its 30 per minute)
     - kill switch: payAllowed() false means no NEW Sale (the answer is "unavailable", which the
       page already treats as "pay at the window"); journal answers, reconcile and tags go on
   The Host / Origin / Sec-Fetch-Site guard stays in kiosk-server.js (lib.requestProblem) and runs
   before anything in here. No CORS headers are ever sent.

   Dependencies: kiosk-lib.js helpers, flex-pay.js (injected). Node built-ins only.
   ============================================================================= */
"use strict";

const lib = require("./kiosk-lib");

const ORDER_ID_RE = /^[A-Za-z0-9]{4,24}$/;

/**
 * @param {{ flexPay, payEnabled: boolean, payAllowed: () => boolean, tokenKey: Buffer,
 *           cloverGet: (p: string) => Promise<any>, cloverDelete: (orderId: string) => Promise<void>,
 *           sendJSON: (res, status, obj) => void, readBody: (req) => Promise<string>,
 *           readerTimeoutMs: number, recoveryMs: number, now?: () => number }} d
 */
function createPayApi(d) {
  const payLimiter   = lib.makeRateLimiter(6, 60000, d.now);
  const quoteLimiter = lib.makeRateLimiter(30, 60000, d.now);
  const send = d.sendJSON;

  const authorized = (orderId, token) =>
    typeof orderId === "string" && ORDER_ID_RE.test(orderId) && lib.payTokenOk(d.tokenKey, orderId, token) && d.flexPay.orderState(orderId) !== null;

  /** Called by POST /order. Returns the payToken, or null when pay is not running (no token = the page falls back to the window). */
  function registerOrder(orderId) {
    if (!d.payEnabled || !d.flexPay.registerOrder(orderId)) return null;
    return lib.payTokenFor(d.tokenKey, orderId);
  }

  async function body(req) { try { const j = JSON.parse((await d.readBody(req)) || "{}"); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch { return null; } }
  const tokenOf = (req, b) => (b && typeof b.payToken === "string" ? b.payToken : (typeof req.headers["x-pay-token"] === "string" ? req.headers["x-pay-token"] : ""));

  /** @returns {Promise<boolean>} true when the request was handled */
  async function handle(req, res, pathname) {
    const m = req.method;

    if (m === "GET" && pathname === "/pay/status") {
      const st = d.flexPay.status();
      return send(res, 200, d.payAllowed() ? st : { ...st, state: "off" }), true;       // killed: the page must not offer the card path
    }
    if (m === "GET" && pathname === "/payconfig")
      return send(res, 200, { enabled: d.payAllowed(), readerTimeoutMs: d.readerTimeoutMs, recoveryMs: d.recoveryMs }), true;

    if (m === "GET" && pathname === "/pay/state") {
      const orderId = new URL(req.url, "http://x").searchParams.get("orderId") || "";
      if (!d.payEnabled || !authorized(orderId, String(req.headers["x-pay-token"] || ""))) return send(res, 403, { error: "forbidden" }), true;
      return send(res, 200, d.flexPay.orderState(orderId)), true;
    }

    if (m !== "POST" || !["/pay", "/pay/window", "/pay/abandon"].includes(pathname)) return false;

    try {
      if (!d.payEnabled) return send(res, 200, { result: "unavailable", reason: "pay disabled" }), true;
      if (pathname === "/pay" && !payLimiter.take()) return send(res, 429, { result: "unavailable", message: "too many payment requests" }), true;
      const b = await body(req);
      if (!b) return send(res, 200, { result: "mismatch", message: "invalid JSON body" }), true;
      const orderId = String(b.orderId || "").trim();
      if (!authorized(orderId, tokenOf(req, b))) return send(res, 403, { result: "forbidden", error: "forbidden" }), true;

      if (pathname === "/pay/window") return send(res, 200, d.flexPay.collect(orderId)), true;

      if (pathname === "/pay/abandon") {
        const chk = await d.flexPay.canAbandon(orderId);
        if (!chk.ok) return send(res, 200, { result: "refused", message: chk.reason }), true;
        let order;
        try { order = await d.cloverGet(`/orders/${orderId}?expand=payments`); } catch { return send(res, 200, { result: "refused", message: "order could not be checked" }), true; }
        const pays = order && order.payments && Array.isArray(order.payments.elements) ? order.payments.elements.length : (order && order.payments ? 1 : 0);
        if (!order || order.state !== "open" || pays > 0) return send(res, 200, { result: "refused", message: "order is not an empty open order" }), true;
        try { await d.cloverDelete(orderId); } catch (e) { return send(res, 502, { result: "error", message: "could not delete the order" }), true; }
        d.flexPay.markAbandoned(orderId);
        return send(res, 200, { result: "abandoned" }), true;
      }

      // ---- POST /pay ----
      const amtClient = parseInt(b.amountCents, 10);
      if (!(amtClient > 0)) return send(res, 200, { result: "mismatch", message: "amountCents must be a positive integer" }), true;
      const st = d.flexPay.orderState(orderId);
      let out;
      if (["APPROVED", "IN_FLIGHT", "TIMEOUT_UNKNOWN", "DISCONNECTED_UNKNOWN", "COLLECT", "ABANDONED"].includes(st.state)) {
        // answered from the journal alone: a paid or locked order is no longer "open" in Clover, and that must not turn "approved" or
        // "do not pay again" into a mismatch
        out = await d.flexPay.pay({ orderId, amountCents: amtClient });
      } else {
        // the server, not the browser, decides the charge: refuse a page amount that differs from the Clover order total
        let order;
        try { order = await d.cloverGet(`/orders/${orderId}`); }
        catch (e) { console.error(`pay: order lookup failed: ${e.message}`); return send(res, 200, { result: "mismatch", message: "order not found" }), true; }
        if (!order || order.state !== "open") return send(res, 200, { result: "mismatch", message: `order not open (state: ${order && order.state})` }), true;
        const total = Number(order.total) || 0;
        if (total <= 0) return send(res, 200, { result: "mismatch", message: "order total is zero" }), true;
        if (total !== amtClient) { console.warn(`pay: amount mismatch for ${orderId}: client=${amtClient} order=${total}`); return send(res, 200, { result: "mismatch", message: "amount does not match order total" }), true; }
        out = await d.flexPay.pay({ orderId, amountCents: total });
      }
      if (out.result === "approved") { out.ticket = orderId.slice(-4).toUpperCase(); out.orderId = orderId; }
      console.log(`pay: orderId=${orderId} result=${out.result} paymentId=${out.paymentId || "-"} last4=****${out.last4 || "?"} cardBrand=${out.cardBrand || "?"}`);
      return send(res, 200, out), true;
    } catch (e) {
      console.error("pay: unhandled error:", e && e.message);
      return send(res, 500, { result: "error", message: "server error" }), true;
    }
  }

  return { handle, registerOrder, quoteAllowed: () => quoteLimiter.take(), _authorized: authorized };
}

module.exports = { createPayApi };
