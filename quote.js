/* =============================================================================
   quote.js — Thirsty Beaches kiosk: server-side pricing (POST /quote) and atomic order creation (POST /order {quoteId}).
   ADR 2026-11-15 sections 4 and 1; security review Q5 (rate limit), Q6 (catalog), S8 (burn only inside /order with a valid quote).

   Purpose: the page sends WHAT the customer picked (category, item, option choices, quantity), never a price. The server prices
   it from the catalog table (catalog.js, keys mapped in catalog-map.json), asks Clover's own checkout for its total and tax, and
   sets payNow true only when the two agree to the cent. /order then creates the order atomically from the stored quote.

   Flow:
     POST /quote {cart:[{catKey, itemId, sel:{optKey: name|[names]}, float?, notes?:[], nick?, qty}], code?}
        -> {ok, quoteId, payNow, subtotal, discount, tax, total (cents), taxName, taxPct, lines, codeStatus, reason}
        ok:false (+ unmapped:[keys]) when a cart key is not mapped: the page then uses the legacy order path
     POST /order {quoteId, name, payMode:"card"|"window"}
        1. burn the Maze code (if the quote has one) BEFORE anything exists in Clover; a failed burn is a failed order (400 bad-code)
        2. atomic_order/orders with the Kiosk orderType id (config KIOSK_ORDER_TYPE_ID), read the order back
        3. write `total` if Clover left it out or differs from the checkout, then title (TBK:PENDING or TBK:COLLECT) and the note
        On any failure after creation the order is deleted (never leave a half-made ticket).
   Quotes live in memory for 10 minutes and are single use. ORDER_PATH=legacy turns the whole thing off.

   ASSUMPTIONS to verify against the live Clover account (listed in the Part 2 report): the field names read from the checkout response
   (parseCheckout), the tax rate unit (catalog.js RATE_PER_PERCENT), and that a line-level discount object is accepted as built here.
   Anything unreadable makes payNow false; it never guesses.
   ============================================================================= */
"use strict";

const crypto = require("crypto");

const QUOTE_TTL_MS = 10 * 60000;
const MAX_QUOTES = 300;
const MAZE_CAP_CENTS = 80;
const MAZE_NAME = "Thirsty Maze · Free Upsize";

const cleanNote = s => String(s == null ? "" : s).replace(/[\u0000-\u001f|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

/** Read Clover's checkout answer. Returns { total, tax } in cents or null when it cannot be read with certainty. */
function parseCheckout(r) {
  if (!r || typeof r !== "object") return null;
  const intOf = v => (Number.isInteger(v) ? v : null);
  const total = intOf(r.total) ?? intOf(r.orderCart && r.orderCart.total) ?? intOf(r.order && r.order.total);
  let tax = null;
  const els = r.lineItems && Array.isArray(r.lineItems.elements) ? r.lineItems.elements : (r.orderCart && r.orderCart.lineItems && Array.isArray(r.orderCart.lineItems.elements) ? r.orderCart.lineItems.elements : null);
  if (els) {
    tax = 0;
    for (const li of els) {
      const trs = li && li.taxRates && Array.isArray(li.taxRates.elements) ? li.taxRates.elements : [];
      for (const t of trs) { if (!Number.isInteger(t.taxAmount)) return null; tax += t.taxAmount; }
    }
  } else tax = intOf(r.totalTaxAmount) ?? intOf(r.taxAmount);
  return total === null || tax === null ? null : { total, tax };
}

/**
 * @param {{ catalog, map, cloverGet, cloverPost, cloverDelete, prizeCheck, nextOrderSeq, cleanCustomerName,
 *           orderTypeId: string, orderPath: string, quoteAllowed: () => boolean, payRegister: (orderId, mode) => string|null,
 *           modsNote: (mods) => string, now?: () => number, log?: object }} d
 */
function createQuoteApi(d) {
  const now = d.now || Date.now;
  const log = d.log || console;
  const quotes = new Map();
  const enabled = () => d.orderPath !== "legacy" && !!d.orderTypeId;

  // ---- index of the map: ordered options per category ----
  const cats = (d.map && d.map.categories) || {};
  const floats = new Map(((d.map && d.map.floats) || []).map(f => [f.mod, f]));

  function sweep() {
    const t = now();
    for (const [id, q] of quotes) if (t - q.createdAt > QUOTE_TTL_MS || q.used) quotes.delete(id);
    while (quotes.size > MAX_QUOTES) quotes.delete(quotes.keys().next().value);
  }

  /** Price a cart from the catalog table. -> { lines } or { unmapped:[...] } or { error } */
  function priceCart(cart) {
    const table = d.catalog.table();
    if (!table) return { soft: "catalog not synced" };
    if (!Array.isArray(cart) || !cart.length) return { error: "empty cart" };
    if (cart.length > 30) return { error: "too many lines" };
    const unmapped = [], lines = [];
    for (const raw of cart) {
      if (!raw || typeof raw !== "object") return { error: "bad line" };
      const cat = cats[raw.catKey], item = cat && cat.items && cat.items[raw.itemId];
      if (!item) return { error: "unknown item" };
      const qty = Math.min(Math.max(1, parseInt(raw.qty, 10) || 1), 20);
      const sel = raw.sel && typeof raw.sel === "object" && !Array.isArray(raw.sel) ? raw.sel : {};
      const key = `${raw.catKey}/${raw.itemId}`;
      const itemEl = item.clover && table.items[item.clover];
      if (!itemEl || itemEl.price === null) { unmapped.push("item " + key); continue; }
      let unit = itemEl.price;
      const modNames = [], modIds = [];
      let sizeIdx = -1, sizeStep = 0;
      let lineOk = true;
      for (const o of cat.options || []) {
        const v = sel[o.key];
        const picks = o.multi ? (Array.isArray(v) ? v : (v ? [v] : [])) : (v ? [v] : []);
        if (!o.multi && Array.isArray(v)) return { error: "bad selection" };
        if (picks.length > 12) return { error: "too many choices" };
        for (const name of picks) {
          const idx = (o.choices || []).findIndex(c => c.name === name);
          if (idx < 0) return { error: "unknown choice" };
          const ch = o.choices[idx];
          const el = ch.clover && table.modifiers[ch.clover];
          if (!el) { unmapped.push(`mod ${raw.catKey}/${o.key}/${name}`); lineOk = false; continue; }
          unit += el.price; modNames.push(name); modIds.push(ch.clover);
          if (o.key === "size") {
            sizeIdx = idx;
            const prev = idx > 0 ? o.choices[idx - 1] : null;
            const pel = prev && prev.clover && table.modifiers[prev.clover];
            sizeStep = idx > 0 && pel ? el.price - pel.price : 0;
          }
        }
      }
      if (raw.float) {
        const f = floats.get(String(raw.float)), el = f && f.clover && table.modifiers[f.clover];
        if (!f) return { error: "unknown float" };
        if (!el) { unmapped.push(`float ${raw.float}`); lineOk = false; } else { unit += el.price; modNames.push(f.mod); modIds.push(f.clover); }
      }
      if (!lineOk) continue;
      const notes = (Array.isArray(raw.notes) ? raw.notes : []).slice(0, 8).map(cleanNote).filter(Boolean);
      const nick = cleanNote(raw.nick || "");
      if (nick) notes.push("AKA " + nick);
      if (unit <= 0 || unit > 100000) return { error: "bad price" };
      lines.push({ key, catKey: raw.catKey, itemId: raw.itemId, itemClover: item.clover, name: item.name || itemEl.name, qty, unit,
        modNames, modIds, notes, sizeIdx, sizeStep, rates: d.catalog.ratesFor(table, item.clover) });
    }
    if (unmapped.length) return { unmapped: [...new Set(unmapped)] };
    return { lines };
  }

  /** Maze: valid only on a line whose size is above the smallest; the most expensive such line; equal to its size step, at most 80 cents. */
  function mazeDiscount(lines) {
    let best = -1;
    lines.forEach((l, i) => { if (l.sizeIdx > 0 && l.sizeStep > 0 && (best < 0 || l.unit > lines[best].unit)) best = i; });
    if (best < 0) return null;
    const l = lines[best];
    return { lineIndex: best, cents: Math.min(MAZE_CAP_CENTS, l.sizeStep, l.unit - 1) };
  }

  /** Per-unit expansion (Clover wants one line item per cup) with the discount on ONE unit of the chosen line, and local tax per unit. */
  function expand(lines, discount) {
    const units = [];
    lines.forEach((l, li) => {
      for (let n = 0; n < l.qty; n++) {
        const disc = discount && discount.lineIndex === li && n === 0 ? discount.cents : 0;
        const taxable = l.unit - disc;
        const frac = l.rates.reduce((a, r) => a + r.rate, 0) / (d.catalog.RATE_PER_PERCENT * 100);
        units.push({ line: l, unit: l.unit, disc, tax: Math.round(taxable * frac) });
      }
    });
    return units;
  }

  async function quote(body) {
    sweep();
    if (!enabled()) return { status: 200, body: { ok: false, payNow: false, error: "not-enabled", reason: d.orderPath === "legacy" ? "ORDER_PATH=legacy" : "KIOSK_ORDER_TYPE_ID not set" } };
    if (!d.quoteAllowed()) return { status: 429, body: { ok: false, payNow: false, error: "slow-down" } };
    const priced = priceCart(body && body.cart);
    if (priced.soft) return { status: 200, body: { ok: false, payNow: false, error: priced.soft } };
    if (priced.error) return { status: 400, body: { ok: false, payNow: false, error: priced.error } };
    if (priced.unmapped) return { status: 200, body: { ok: false, payNow: false, error: "unmapped", unmapped: priced.unmapped.slice(0, 20) } };
    const lines = priced.lines;

    // Maze code: checked (never burned) here; burned only inside /order with this quote (S8)
    let codeStatus = null, discount = null, code = null;
    if (body && body.code) {
      const chk = await d.prizeCheck(body.code, false);
      if (!chk || !chk.ok) codeStatus = (chk && chk.status) || "bad";
      else { discount = mazeDiscount(lines); if (!discount) codeStatus = "no-upsizable-line"; else { codeStatus = "ok"; code = String(body.code); } }
    }
    const units = expand(lines, discount);
    const subtotal = units.reduce((a, u) => a + u.unit, 0);
    const disc = units.reduce((a, u) => a + u.disc, 0);
    const tax = units.reduce((a, u) => a + u.tax, 0);
    const total = subtotal - disc + tax;

    // Clover's own answer for the same cart
    let payNow = false, reason = d.catalog.payBlock(), clover = null;
    const cart = orderCart(units, null);
    try { clover = parseCheckout(await d.cloverPost("/atomic_order/checkouts", { orderCart: cart })); }
    catch (e) { reason = reason || "checkout failed"; log.warn("quote: checkout failed: " + e.message); }
    if (!reason) {
      if (!clover) reason = "checkout answer not understood";
      else if (clover.total !== total || clover.tax !== tax) { reason = `totals disagree (local ${total}/${tax}, Clover ${clover.total}/${clover.tax})`; log.warn("quote: " + reason); }
      else payNow = true;
    }
    const rate = lines[0].rates[0];
    const quoteId = crypto.randomBytes(16).toString("hex");
    quotes.set(quoteId, { createdAt: now(), used: false, lines, discount, code, units, subtotal, disc, tax, total, payNow, clover });
    const out = {
      ok: true, quoteId, payNow, subtotal, discount: disc, tax, total, codeStatus,
      taxName: rate ? rate.name : "Tax", taxPct: rate ? rate.rate / d.catalog.RATE_PER_PERCENT : 0,
      lines: lines.map(l => ({ name: l.name, qty: l.qty, unit: l.unit, mods: l.modNames })), expiresInMs: QUOTE_TTL_MS,
    };
    if (reason) out.reason = reason;
    return { status: 200, body: out };
  }

  function orderCart(units, extra) {
    return {
      orderType: { id: d.orderTypeId },
      lineItems: units.map(u => {
        const li = { item: { id: u.line.itemClover }, printed: false };
        if (u.line.modIds.length) li.modifications = u.line.modIds.map(id => ({ modifier: { id } }));
        const note = d.modsNote([...u.line.modNames, ...u.line.notes]);
        if (note) li.note = note;
        if (u.disc) li.discounts = [{ name: MAZE_NAME, amount: -u.disc }];
        return li;
      }),
      ...(extra || {}),
    };
  }

  async function createOrder(body) {
    sweep();
    if (!enabled()) return { status: 409, body: { error: "atomic path off" } };
    const q = quotes.get(String(body && body.quoteId || ""));
    if (!q || q.used || now() - q.createdAt > QUOTE_TTL_MS) return { status: 409, body: { error: "quote-expired" } };
    q.used = true;                                                      // CR-011: single use, claimed in the same tick as the check (two concurrent /order calls cannot both pass); given back only if the Maze burn is refused
    const name = d.cleanCustomerName(String((body && body.name) || "").trim().slice(0, 60));
    const wantCard = body && body.payMode === "card";

    // burn FIRST: a failed burn (offline, already used, wrong key) is a failed order, never a discount on a code that stays reusable
    if (q.code) {
      const chk = await d.prizeCheck(q.code, false);
      if (!chk || !chk.ok) { q.used = false; return { status: 400, body: { error: "bad-code", status: (chk && chk.status) || "unknown" } }; }
      const burn = await d.prizeCheck(q.code, true);
      if (!burn || !burn.ok) { q.used = false; return { status: 400, body: { error: "bad-code", status: (burn && burn.status) || "burn-failed" } }; }
    }

    const mode = wantCard && q.payNow && d.payRunning() ? "card" : "window";
    let order;
    try { order = await d.cloverPost("/atomic_order/orders", { orderCart: orderCart(q.units, null) }); }
    catch (e) { log.error("order: atomic create failed: " + e.message); return { status: 502, body: { error: "Could not create Clover order" } }; }
    if (!order || typeof order.id !== "string") return { status: 502, body: { error: "Could not create Clover order" } };
    const id = order.id;
    let seq = null;
    try {
      let cur = order;
      try { cur = await d.cloverGet(`/orders/${id}`); } catch { /* the create answer is the fallback */ }
      const want = q.clover ? q.clover.total : q.total;
      if (!Number.isInteger(cur && cur.total) || cur.total !== want) await d.cloverPost(`/orders/${id}`, { total: want });   // Clover docs: API orders need a manual total
      seq = await d.nextOrderSeq(id);
      const tag = q.discount ? " · MAZE UPSIZE" : "";
      const num = seq ? ` #${seq}` : "";
      await d.cloverPost(`/orders/${id}`, { title: mode === "card" ? "TBK:PENDING" : "TBK:COLLECT", note: (name ? `${name} — Kiosk order${num}` : `Kiosk order${num} — Thirsty Beaches`) + tag });
    } catch (e) {
      try { await d.cloverDelete(id); } catch { /* best effort */ }
      log.error("order: finishing the atomic order failed: " + e.message);
      return { status: 502, body: { error: "Could not create Clover order" } };
    }
    const payToken = d.payRegister(id, mode);
    const out = { ok: true, orderId: id, ticket: id.slice(-4).toUpperCase(), seq, name, upsize: !!q.discount, total: q.clover ? q.clover.total : q.total, tax: q.tax, payMode: mode };
    if (payToken && mode === "card") out.payToken = payToken;
    return { status: 200, body: out };
  }

  return { quote, createOrder, enabled, _quotes: quotes, _price: priceCart };
}

module.exports = { createQuoteApi, parseCheckout, MAZE_CAP_CENTS, QUOTE_TTL_MS };
