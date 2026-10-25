/* "Pay on my phone" for the drink kiosk. All routes here are PUBLIC (no STATION_KEY):
     GET  /api/qr          -> {enabled:true} or 503 {error:'qr-off'}   (the kiosk's "show the QR choice?" probe)
     POST /api/qr          -> checks the cart, creates a Clover Hosted Checkout, returns {ref, payUrl, total, expires}
     GET  /api/qr/<ref>    -> {status:'pending'|'paid'|'ready'|'expired', ticket, total, ...}
     GET  /r/<ref>         -> the customer's phone page (pay button + "your drink is ready" tracker)
   Payment is detected by polling Clover REST orders for a line item whose note carries KQ-<ref>
   (the merchant's one checkout webhook belongs to Salty Dog Tags). Money is only ever charged
   at the price computed by pricebook.js. Needs secrets CLOVER_API_TOKEN (REST, read) and either
   CLOVER_ECOMM_TOKEN (Hosted Checkout private key) or RELAY_KEY (the checkout is then made with the
   Salty Dog Tags site's key through its relay, see relay.js); with neither the feature is off.   */
import { KIOSK_MENU } from "./kiosk-menu.js";
import { kioskCandidates, cloverCandidates, buildCloverBook, pickPrice } from "./pricebook.js";
import { phonePage } from "./phone-page.js";
import { onlineGate, onlineAfterPricing, trailerStatus } from "./order-ahead.js";
import { checkoutConfigured, checkoutViaRelay, relayPost, RELAY_LIMITS } from "./relay.js";

const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";          // no 0/O/1/I/L
const REF_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const SESSION_MS = 15 * 60000;                                    // Clover checkout sessions last 15 min
const EXPIRE_MS = 16 * 60000;                                     // 'expired' once still unpaid 16 min after creation
const CHECK_EVERY_MS = 4000;                                      // each ref asks Clover at most this often (per isolate)
const INV_TTL_MS = 5 * 60000;
const ALLOWED_ORIGINS = new Set([
  "http://localhost:8137", "http://127.0.0.1:8137",               // the trailer PC's kiosk server (Run-Kiosk.bat)
  "http://localhost:8080", "http://127.0.0.1:8080",
  "https://station.thirstybeaches.com",
]);

export const qrMemo = { inv: null, invAt: 0, orders: null, lastCheck: new Map() };   // per-isolate caches

const stationOrigin = env => (env.STATION_ORIGIN || "https://station.thirstybeaches.com").replace(/\/+$/, "");
const qrOn = env => checkoutConfigured(env) && env.QR_ENABLED !== "0";

function cors(req, extra = {}) {
  const h = { "content-type": "application/json", "cache-control": "no-store", vary: "Origin", ...extra };
  const o = req.headers.get("origin");
  if (o && ALLOWED_ORIGINS.has(o)) {
    h["access-control-allow-origin"] = o;
    h["access-control-allow-methods"] = "GET, POST, OPTIONS";
    h["access-control-allow-headers"] = "content-type";
    h["access-control-max-age"] = "600";
  }
  return h;
}
const jsonC = (req, obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors(req) });

function makeRef() {
  const out = [];
  const buf = new Uint8Array(32);
  while (out.length < 8) {
    crypto.getRandomValues(buf);
    for (const b of buf) { if (b < 248 && out.length < 8) out.push(REF_ALPHABET[b % 31]); }   // 248 = 8*31: no modulo bias
  }
  return out.join("");
}

async function cloverGet(env, p) {
  const r = await fetch(`${env.CLOVER_BASE_URL || "https://api.clover.com"}/v3/merchants/${env.CLOVER_MERCHANT_ID}${p}`,
    { headers: { Authorization: `Bearer ${env.CLOVER_API_TOKEN}` } });
  if (!r.ok) throw new Error(`Clover ${p.split("?")[0]} -> ${r.status}`);
  return r.json();
}
async function cloverAll(env, p) {
  const out = [];
  for (let offset = 0; offset < 5000; offset += 500) {
    const r = await cloverGet(env, `${p}${p.includes("?") ? "&" : "?"}limit=500&offset=${offset}`);
    const els = (r && r.elements) || [];
    out.push(...els);
    if (els.length < 500) break;
  }
  return out;
}
async function cloverBook(env) {
  if (qrMemo.inv && Date.now() - qrMemo.invAt < INV_TTL_MS) return qrMemo.inv;
  const cached = await env.STATE.get("qrinv", "json");
  if (cached && Date.now() - (cached.at || 0) < INV_TTL_MS) { qrMemo.inv = cached.book; qrMemo.invAt = cached.at; return cached.book; }
  const [items, groups] = await Promise.all([cloverAll(env, "/items?expand=modifierGroups"), cloverAll(env, "/modifier_groups?expand=modifiers")]);
  const book = buildCloverBook(items, groups);
  qrMemo.inv = book; qrMemo.invAt = Date.now();
  await env.STATE.put("qrinv", JSON.stringify({ at: qrMemo.invAt, book }), { expirationTtl: 3600 });
  return book;
}

/* ---- cart checks (same limits as the kiosk's local server) ---- */
function cleanName(s) {
  return String(s || "").normalize("NFC").replace(/[^\p{L}\p{N} .'\-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 24);
}
function shapeError(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.lines)) return "lines required";
  if (body.lines.length < 1 || body.lines.length > 30) return "1-30 lines";
  if (body.name != null && typeof body.name !== "string") return "bad name";
  for (const [i, l] of body.lines.entries()) {
    if (!l || typeof l !== "object") return `line ${i}: bad line`;
    if (typeof l.name !== "string" || !l.name.trim() || l.name.length > 80 || l.name.includes(" · ")) return `line ${i}: bad name`;
    if (typeof l.unit !== "number" || !isFinite(l.unit)) return `line ${i}: bad unit`;
    const c = Math.round(l.unit * 100);
    if (c < 1 || c > 10000) return `line ${i}: unit out of range`;
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 20) return `line ${i}: qty 1-20`;
    if (l.mods != null && (!Array.isArray(l.mods) || l.mods.length > 25 || l.mods.some(m => typeof m !== "string" || !m.trim() || m.length > 60 || m.includes(",") || m.includes("·"))))
      return `line ${i}: bad mods`;
    if (l.catKey != null && (typeof l.catKey !== "string" || l.catKey.length > 40)) return `line ${i}: bad catKey`;
  }
  return null;
}

/* -> {ok:true, lines:[{name, mods, qty, price}]} | {ok:false, status, error, line} */
export async function validateCart(env, body) {
  const bad = shapeError(body);
  if (bad) return { ok: false, status: 400, error: "bad-cart", detail: bad };
  const out = [];
  let inv = null, invErr = null;
  for (const [i, raw] of body.lines.entries()) {
    const line = { name: raw.name.trim(), unit: raw.unit, qty: raw.qty, mods: (raw.mods || []).map(m => m.trim()), catKey: raw.catKey || null };
    const cents = Math.round(line.unit * 100);
    let k;
    try { k = kioskCandidates(line, KIOSK_MENU); } catch { return { ok: false, status: 400, error: "bad-cart", line: i, detail: "too complex" }; }
    let price = pickPrice(cents, [k.totals]);
    let found = k.found, anyTotals = k.totals.size > 0;
    if (price === null) {
      if (!inv && !invErr) { try { inv = await cloverBook(env); } catch (e) { invErr = e; } }
      if (inv) {
        let c;
        try { c = cloverCandidates(line, inv); } catch { c = { found: false, totals: new Set() }; }
        found = found || c.found; anyTotals = anyTotals || c.totals.size > 0;
        price = pickPrice(cents, [k.totals, c.totals]);
      }
    }
    if (price === null) {
      if (!inv && invErr && !k.found) return { ok: false, status: 503, error: "validate-unavailable", line: i };
      return { ok: false, status: 400, line: i, error: !found ? "unknown-item" : !anyTotals ? "unknown-modifier" : "price-mismatch" };
    }
    out.push({ name: line.name, mods: line.mods, qty: line.qty, price });
  }
  return { ok: true, lines: out };
}

/* Same line name format as the kiosk's local server, so the make station splits name/mods the same way. */
export const lineName = l => `${l.name}${l.mods.length ? " · " + l.mods.join(", ") : ""}`;

async function rateLimited(env, req) {
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const limit = Math.max(1, parseInt(env.QR_RATE_PER_HOUR || "60", 10) || 60);
  const key = `rl:${ip}:${Math.floor(Date.now() / 3600000)}`;
  const n = parseInt((await env.STATE.get(key)) || "0", 10) || 0;
  if (n >= limit) return true;
  await env.STATE.put(key, String(n + 1), { expirationTtl: 7200 });
  return false;
}

async function createQr(req, env) {
  if (!qrOn(env)) return jsonC(req, { error: "qr-off" }, 503);
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return jsonC(req, { error: "origin not allowed" }, 403);
  const raw = await req.text();
  if (raw.length > 32000) return jsonC(req, { error: "bad-cart", detail: "too large" }, 413);
  let body; try { body = JSON.parse(raw); } catch { return jsonC(req, { error: "bad json" }, 400); }
  const site = stationOrigin(env);
  const online = !!body && body.source === "online";                 // "Order ahead" (/order); kiosk carts carry no source
  if (online) {
    const g = await onlineGate(req, env, body, site);
    if (g) return jsonC(req, g.body, g.status);
    if (!cleanName(body.name)) return jsonC(req, { error: "name-required" }, 400);
  }
  if (await rateLimited(env, req)) return jsonC(req, { error: "rate-limited" }, 429);

  const v = await validateCart(env, body);
  if (!v.ok) return jsonC(req, { error: v.error, line: v.line, detail: v.detail }, v.status);
  if (online) {
    const g = await onlineAfterPricing(env, v.lines, KIOSK_MENU);
    if (g) return jsonC(req, g.body, g.status);
  }

  const name = cleanName(body.name);
  const ref = makeRef();
  const created = Date.now();
  const lineItems = [];
  for (const l of v.lines) for (let q = 0; q < l.qty; q++) lineItems.push({ name: lineName(l), price: l.price, unitQty: 1 });   // one line per drink, like the local server
  lineItems[0].note = online ? `KQ-${ref} · Online · ${name}` : `KQ-${ref} · ${name || "Kiosk"}`;
  const total = v.lines.reduce((a, l) => a + l.price * l.qty, 0);
  const checkout = {
    customer: { firstName: name || "Kiosk" },
    shoppingCart: { lineItems },
    redirectUrls: { success: `${site}/r/${ref}?paid=1`, failure: `${site}/r/${ref}?failed=1` },
    tips: { enabled: env.TIPS === "1" || env.TIPS === "true" },
  };
  const viaRelay = checkoutViaRelay(env);
  if (viaRelay && lineItems.length > RELAY_LIMITS.items) return jsonC(req, { error: "too-big", max: RELAY_LIMITS.items }, 400);
  if (viaRelay && total > RELAY_LIMITS.cents) return jsonC(req, { error: "too-big" }, 400);
  let data, status = 0;
  if (viaRelay) {                                                    // Salty Dog Tags' Hosted Checkout key, same merchant
    const res = await relayPost(env, { kind: "checkout", ...checkout, merchantId: env.CLOVER_MERCHANT_ID });
    status = res.status; data = res.data;
  } else try {
    const r = await fetch(`${env.CLOVER_BASE_URL || "https://api.clover.com"}/invoicingcheckoutservice/v1/checkouts`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "X-Clover-Merchant-Id": env.CLOVER_MERCHANT_ID, authorization: "Bearer " + env.CLOVER_ECOMM_TOKEN },
      body: JSON.stringify(checkout),
    });
    status = r.status;
    const t = await r.text();
    try { data = JSON.parse(t); } catch { data = { raw: t.slice(0, 300) }; }
  } catch (e) { data = { raw: String(e && e.message) }; }
  let hrefOk = false;
  try { const u = new URL(data && data.href); hrefOk = u.protocol === "https:" && (u.hostname === "clover.com" || u.hostname.endsWith(".clover.com")); } catch {}
  if (status < 200 || status >= 300 || !hrefOk || !data.checkoutSessionId) {
    console.error("QR checkout failed", viaRelay ? "(relay)" : "", status, JSON.stringify(data).slice(0, 300));
    return jsonC(req, { error: "checkout-failed" }, 502);
  }
  let expires = typeof data.expirationTime === "number" ? (data.expirationTime < 1e12 ? data.expirationTime * 1000 : data.expirationTime) : Date.parse(data.expirationTime || "");
  if (!isFinite(expires) || expires < created || expires > created + SESSION_MS + 60000) expires = created + SESSION_MS;
  const rec = { sid: data.checkoutSessionId, href: data.href, total, name, created, expires, status: "pending",
    lines: v.lines.map(l => ({ name: l.name, mods: l.mods, qty: l.qty, price: l.price })) };
  if (online) { rec.source = "online"; rec.pickup = (await trailerStatus(env)).label || ""; }
  await env.STATE.put("qr:" + ref, JSON.stringify(rec), { expirationTtl: 86400 });
  if (online) return jsonC(req, { ref, payUrl: `${site}/r/${ref}`, checkoutUrl: data.href, total, expires });   // the phone goes straight to Clover
  return jsonC(req, { ref, payUrl: `${site}/r/${ref}`, total, expires });
}

/* Find the Clover order the hosted checkout made for this ref. Paid only when Clover says so. */
async function findPaidOrder(env, ref, rec) {
  const since = rec.created - 60000;
  let els;
  const m = qrMemo.orders;
  const mAge = m ? Date.now() - m.at : -1;
  if (m && mAge >= 0 && mAge < CHECK_EVERY_MS && m.since <= since) els = m.els;    // coalesce refs polled together
  else {
    const r = await cloverGet(env, `/orders?filter=createdTime>=${since}&expand=lineItems,payments&orderBy=createdTime DESC&limit=100`);
    els = (r && r.elements) || [];
    qrMemo.orders = { at: Date.now(), since, els };
  }
  const tag = "KQ-" + ref;
  for (const o of els) {
    const lines = ((o.lineItems || {}).elements) || [];
    if (!lines.some(li => String(li.note || "").includes(tag))) continue;
    const paidState = String(o.paymentState || "").toUpperCase() === "PAID";
    const paidSum = (((o.payments || {}).elements) || []).filter(p => String(p.result || "").toUpperCase() === "SUCCESS")
      .reduce((a, p) => a + (+p.amount || 0), 0);
    return { orderId: o.id, paid: paidState || paidSum >= rec.total };
  }
  return null;
}

export async function qrStatus(env, ref, opts = {}) {
  const key = "qr:" + ref;
  const rec = await env.STATE.get(key, "json");
  if (!rec) return null;
  const now = Date.now();
  if (rec.status === "pending") {
    const age = now - rec.created;
    const last = qrMemo.lastCheck.get(ref) || 0;
    const due = now - last >= CHECK_EVERY_MS || now < last;          // (now < last: clock moved back)
    let checked = false;
    if (due || age >= EXPIRE_MS) {                                  // always one fresh look before calling it expired
      qrMemo.lastCheck.set(ref, now);
      if (qrMemo.lastCheck.size > 500) qrMemo.lastCheck.delete(qrMemo.lastCheck.keys().next().value);
      try {
        const hit = await findPaidOrder(env, ref, rec);
        checked = true;
        if (hit && (hit.paid || rec.orderId !== hit.orderId)) {     // write KV only when something changed
          rec.orderId = hit.orderId;
          rec.ticket = hit.orderId.slice(-4).toUpperCase();         // same ticket as the make station / pickup board
          if (hit.paid) { rec.status = "paid"; rec.paidAt = now; }
          await env.STATE.put(key, JSON.stringify(rec), { expirationTtl: 86400 });
        }
      } catch (e) { console.error("QR status check failed", e.message); }
    }
    if (rec.status === "pending" && age >= EXPIRE_MS && checked) {
      rec.status = "expired";
      await env.STATE.put(key, JSON.stringify(rec), { expirationTtl: 86400 });
    }
  }
  let status = rec.status, readyAt = null;
  if (status === "paid" && rec.orderId) {
    const done = opts.done || (await env.STATE.get("done", "json")) || {};
    if (done[rec.orderId]) { status = "ready"; readyAt = done[rec.orderId]; }
  }
  return { rec, status, readyAt };
}

function publicView(ref, s) {
  const r = s.rec;
  const items = r.lines.map(l => ({ name: l.name, mods: l.mods, qty: l.qty }));
  const v = { ref, status: s.status, ticket: (s.status === "paid" || s.status === "ready") ? r.ticket : null, total: r.total,
    name: r.name || "", items, created: r.created, expires: r.expires, readyAt: s.readyAt };
  if (r.source === "online") { v.online = true; v.pickup = r.pickup || ""; }
  if (s.status === "pending") v.href = r.href;
  return v;
}

export async function handleQr(req, env, url) {
  const p = url.pathname;
  if (req.method === "OPTIONS" && (p === "/api/qr" || p.startsWith("/api/qr/"))) return new Response(null, { status: 204, headers: cors(req) });
  if (p === "/api/qr") {
    if (req.method === "POST") return createQr(req, env);
    if (req.method === "GET") return qrOn(env) ? jsonC(req, { enabled: true }) : jsonC(req, { error: "qr-off" }, 503);
    return jsonC(req, { error: "method" }, 405);
  }
  if (p.startsWith("/api/qr/")) {
    if (req.method !== "GET") return jsonC(req, { error: "method" }, 405);
    const ref = p.slice(8);
    if (!REF_RE.test(ref)) return jsonC(req, { error: "not-found" }, 404);
    const s = await qrStatus(env, ref);
    if (!s) return jsonC(req, { error: "not-found" }, 404);
    return jsonC(req, publicView(ref, s));
  }
  if (p.startsWith("/r/")) {
    const ref = p.slice(3).replace(/\/$/, "");
    const s = REF_RE.test(ref) ? await qrStatus(env, ref) : null;
    const html = phonePage(s ? publicView(ref, s) : null, { reviewUrl: env.REVIEW_URL });
    return new Response(html, { status: s ? 200 : 404, headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    } });
  }
  return null;
}
