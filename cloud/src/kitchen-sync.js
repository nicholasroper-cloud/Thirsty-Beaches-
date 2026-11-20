/* Kitchen Board V2 sync helpers for the Cloudflare Worker edition (cloud/src/index.js & order-ahead.js).
   Talks server-side to worker-tb-where (Secret Menu, 4-char claims, Group Drink Drops, 86 stock, Order Up webhook)
   and Salty Dog Tags (/api/tags-pickup) so secrets never reach the browser and failures never stall the make screen. */

const DEFAULT_WHERE_ORIGIN = "https://tb-where.nicholasroper.workers.dev";
const DEFAULT_SDT_PICKUP_URL = "https://saltydogtags.com/api/tags-pickup";

const FALLBACK_SECRET_MENU = [
  { id: "neon-rip-curl", name: "Neon Rip Curl", minScore: 600, base: "Sprite", syrups: "2p Blue Raspberry, 1p Coconut, 1p Fresh Lime", cream: "1oz Coconut Cream", garnish: "Fresh Lime Wedge", build: "Sprite · 2p Blue Raz, 1p Coconut, 1p Lime · 1oz Coconut Cream · Lime Wedge" },
  { id: "80s-sunset-cream", name: "80s Sunset Cream", minScore: 900, base: "Dr Pepper", syrups: "2p Peach, 1p Raspberry, 1p Vanilla", cream: "1oz Sweet Cream", garnish: "Maraschino Cherry", build: "Dr Pepper · 2p Peach, 1p Raz, 1p Vanilla · 1oz Sweet Cream · Cherry" },
  { id: "synthwave-shark-bite", name: "Synthwave Shark Bite", minScore: 1200, base: "Mountain Dew", syrups: "2p Mango Purée, 1p Strawberry Purée, 1p Passion Fruit", cream: "Splash Coconut Cream", garnish: "Passion Fruit Popping Pearls", build: "Mtn Dew · 2p Mango, 1p Strawberry, 1p Passion Fruit · Splash Coconut Cream · Popping Pearls" },
  { id: "turbo-beach-bum", name: "Turbo Beach Bum", minScore: 1500, base: "Energy Base", syrups: "2p Pineapple, 1p Blue Raspberry, 1p Coconut", cream: "1oz Vanilla Cream", garnish: "Fresh Lime Squeeze", build: "Energy · 2p Pineapple, 1p Blue Raz, 1p Coconut · 1oz Vanilla Cream · Fresh Lime" },
  { id: "velvet-palm", name: "Velvet Palm", minScore: 1800, base: "Root Beer", syrups: "2p Butterscotch, 1p Toasted Marshmallow", cream: "1oz Vanilla Cream", garnish: "Whipped Cream Swirl", build: "Root Beer · 2p Butterscotch, 1p Marshmallow · 1oz Vanilla Cream · Whip Swirl" },
];

const cache = { extras: null, extrasAt: 0, pickups: [], pickupsAt: 0 };

export function whereOrigin(env) {
  const raw = String((env && (env.TB_WHERE_ORIGIN || env.WHERE_URL)) || DEFAULT_WHERE_ORIGIN).trim();
  return raw.replace(/\/where\/?$/i, "").replace(/\/+$/, "");
}

export function whereHeaders(env, hasBody = false) {
  const h = { accept: "application/json" };
  if (hasBody) h["content-type"] = "application/json";
  const secret = String((env && env.TB_SECRET) || "").trim();
  const kioskKey = String((env && env.KIOSK_KEY) || "").trim();
  if (secret) h["authorization"] = "Bearer " + secret;
  if (kioskKey) h["x-kiosk-key"] = kioskKey;
  return h;
}

export async function fetchJsonTimeout(url, opts = {}, ms = 3500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  } finally {
    clearTimeout(t);
  }
}

export async function readStationStockOverlay(env) {
  try {
    if (!env || !env.STATE) return { items: [], ingredients: [], updatedAt: null };
    const d = await env.STATE.get("stock86_override", "json");
    if (d && Array.isArray(d.items) && Array.isArray(d.ingredients)) return d;
  } catch {}
  return { items: [], ingredients: [], updatedAt: null };
}

export async function toggleStationStock(env, body) {
  const kind = body && body.kind === "ingredient" ? "ingredients" : "items";
  const name = String((body && body.name) || "").trim().toLowerCase().replace(/[^a-z0-9 '&-]/g, "").slice(0, 60);
  if (!name) return { status: 400, body: { error: "bad-name" } };

  const cur = await readStationStockOverlay(env);
  const set = new Set(cur[kind]);
  let out;
  if (typeof body.out === "boolean") {
    if (body.out) set.add(name); else set.delete(name);
    out = body.out;
  } else {
    if (set.has(name)) { set.delete(name); out = false; }
    else { set.add(name); out = true; }
  }
  cur[kind] = [...set].sort().slice(0, 120);
  cur.updatedAt = Date.now();
  if (env && env.STATE) await env.STATE.put("stock86_override", JSON.stringify(cur));

  // Relay live to worker-tb-where so the 47" vertical kiosk and mobile web menu update immediately
  let synced = false;
  if (env && (env.TB_SECRET || env.KIOSK_KEY)) {
    const r = await fetchJsonTimeout(whereOrigin(env) + "/stock/toggle", {
      method: "POST",
      headers: whereHeaders(env, true),
      body: JSON.stringify({ kind: kind === "ingredients" ? "ingredient" : "item", name, out }),
    }, 3500);
    if (r.ok && r.data && r.data.stock) {
      synced = true;
      if (env.STATE) await env.STATE.put("stock86_override", JSON.stringify(r.data.stock));
      cache.extras = null;
      return { status: 200, body: { ok: true, kind, name, out, synced, stock: r.data.stock } };
    }
  }
  cache.extras = null;
  return { status: 200, body: { ok: true, kind, name, out, synced, stock: cur } };
}

export async function fetchPickupTags(env) {
  const now = Date.now();
  if (now - cache.pickupsAt < 60000 && cache.pickupsAt > 0) return cache.pickups;
  const key = String((env && (env.CROSS_BRAND_SECRET || env.SDT_ADMIN_TOKEN)) || "").trim();
  if (!key) return [];
  const url = String((env && env.SDT_PICKUP_URL) || DEFAULT_SDT_PICKUP_URL).trim();
  const headers = env && env.CROSS_BRAND_SECRET
    ? { accept: "application/json", "x-cross-brand-key": env.CROSS_BRAND_SECRET }
    : { accept: "application/json", authorization: "Bearer " + key };
  const r = await fetchJsonTimeout(url, { headers }, 3000);
  if (r.ok && r.data && Array.isArray(r.data.pickups)) {
    cache.pickups = r.data.pickups;
    cache.pickupsAt = now;
  }
  return cache.pickups;
}

const normName = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/* Match a drink order against pending Salty Dog Tags trailer pickups (by explicit #SDT- / VIP- note or customer name). */
export function matchTagPickup(order, pickups) {
  const note = String((order && (order.orderNote || order.note)) || "");
  const explicit = note.match(/\b(SDT-[A-Z0-9]{4,10}|SD-[A-Z0-9]{3,10})\b/i);
  const vipM = note.match(/\b(VIP-[A-Z2-9]{4,8})\b/i);
  const list = Array.isArray(pickups) ? pickups : [];
  if (explicit) {
    const code = explicit[1].toUpperCase();
    const hit = list.find(p => String(p.id || "").toUpperCase() === code);
    return hit || { id: code, customerName: order.customer || "", dogNames: [], ready: true, vipCode: vipM ? vipM[1].toUpperCase() : null };
  }
  if (vipM) {
    const vc = vipM[1].toUpperCase();
    const hit = list.find(p => String(p.vipCode || "").toUpperCase() === vc);
    if (hit) return hit;
  }
  const who = normName(order && order.customer);
  if (!who || who.length < 3 || !list.length) return null;
  const first = who.split(" ")[0];
  return list.find(p => {
    const pn = normName(p.customerName);
    if (!pn) return false;
    return pn === who || (who.includes(" ") && pn.startsWith(who)) || (first.length >= 4 && pn.split(" ")[0] === first && who.split(" ").length > 1 && pn.split(" ")[1] && pn.split(" ")[1][0] === who.split(" ")[1][0]);
  }) || null;
}

export async function fetchKitchenExtras(env) {
  const now = Date.now();
  if (cache.extras && now - cache.extrasAt < 15000) return cache.extras;
  const origin = whereOrigin(env);
  const authed = !!(env && (env.TB_SECRET || env.KIOSK_KEY));
  const [smR, clR, drR, stR, localSt, pickups] = await Promise.all([
    fetchJsonTimeout(origin + "/secret-menu", { headers: { accept: "application/json" } }, 2500),
    authed ? fetchJsonTimeout(origin + "/kitchen/claims", { headers: whereHeaders(env) }, 2500) : Promise.resolve({ ok: false }),
    authed ? fetchJsonTimeout(origin + "/kitchen/drops", { headers: whereHeaders(env) }, 2500) : Promise.resolve({ ok: false }),
    fetchJsonTimeout(origin + "/stock", { headers: { accept: "application/json" } }, 2500),
    readStationStockOverlay(env),
    fetchPickupTags(env),
  ]);
  const secretMenu = (smR.ok && smR.data && Array.isArray(smR.data.drinks) && smR.data.drinks.length) ? smR.data.drinks : FALLBACK_SECRET_MENU;
  const claims = (clR.ok && clR.data && Array.isArray(clR.data.claims)) ? clR.data.claims.filter(c => !c.redeemed).slice(0, 24) : [];
  const drops = (drR.ok && drR.data && Array.isArray(drR.data.drops)) ? drR.data.drops.slice(0, 12) : [];
  const remoteSt = (stR.ok && stR.data && Array.isArray(stR.data.items)) ? stR.data : { items: [], ingredients: [], updatedAt: null };
  const stock = (localSt.updatedAt || 0) >= (remoteSt.updatedAt || 0) ? localSt : remoteSt;
  const out = { secretMenu, claims, drops, stock, pickups, syncedAt: now };
  cache.extras = out;
  cache.extrasAt = now;
  return out;
}

/* A Salty Dog Tags "VIP-XXXX" pickup pass: the Worker redeems it only with sig = first 12 hex of HMAC-SHA256(CROSS_BRAND_SECRET, code).
   The station sends a sig only when it can prove the code itself: one scanned off the pass (body.sig), or the code is in the signed SDT
   pickup feed (then the sig is computed from the shared secret). Never sign a code nobody vouched for. Otherwise nothing goes to the
   Worker and the answer is the plain status "verify-at-sdt" (not a 403). Same rules as make-station-server.js. */
async function hmacHex12(secret, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const buf = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, "0")).join("").slice(0, 12);
}
const VIP_RE = /^VIP-?([A-Z2-9]{4,8})$/;

export async function redeemKitchenClaim(env, body) {
  const raw = String((body && body.code) || "").trim().toUpperCase();
  if (!raw) return { status: 400, body: { error: "missing-code" } };
  if (!env || (!env.TB_SECRET && !env.KIOSK_KEY)) return { status: 503, body: { error: "tb-where-not-configured" } };
  const clean = raw.replace(/[^A-Z0-9-]/g, "");
  const vip = VIP_RE.exec(clean);
  const payload = { code: vip ? "VIP-" + vip[1] : raw, by: "station", checkOnly: body.checkOnly === true };
  const ord = String(body.order || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);   // the kitchen ticket an arcade prize was honoured on
  if (ord && !vip) payload.order = ord;
  if (vip) {
    const code = payload.code;
    const typedSig = String(body.sig || "").trim().toLowerCase();
    let sig = /^[0-9a-f]{12}$/.test(typedSig) ? typedSig : "";
    const secret = String((env && env.CROSS_BRAND_SECRET) || "").trim();
    if (!sig && secret) {
      const list = await fetchPickupTags(env);
      if (list.some(p => String(p.vipCode || "").toUpperCase() === code)) sig = await hmacHex12(secret, code);
    }
    if (!sig) return { status: 200, body: { ok: false, status: "verify-at-sdt", code, message: "Verify this VIP pass on the Salty Dog Tags order (" + code + ") before handing over the free upgrade. It cannot be redeemed here without the pass signature." } };
    payload.sig = sig;
  }
  const r = await fetchJsonTimeout(whereOrigin(env) + "/kitchen/claims/redeem", {
    method: "POST",
    headers: whereHeaders(env, true),
    body: JSON.stringify(payload),
  }, 3500);
  cache.extras = null;
  if (!r.data) return { status: r.status || 502, body: { error: "redeem-failed" } };
  return { status: r.status, body: r.data };
}

export async function completeKitchenDrop(env, body) {
  const code = String((body && body.code) || "").trim().toUpperCase();
  if (!code) return { status: 400, body: { error: "missing-code" } };
  if (!env || (!env.TB_SECRET && !env.KIOSK_KEY)) return { status: 503, body: { error: "tb-where-not-configured" } };
  const r = await fetchJsonTimeout(whereOrigin(env) + "/kitchen/drops/complete", {
    method: "POST",
    headers: whereHeaders(env, true),
    body: JSON.stringify({ code }),
  }, 3500);
  cache.extras = null;
  if (!r.data) return { status: r.status || 502, body: { error: "drop-complete-failed" } };
  return { status: r.status, body: r.data };
}

/* Non-blocking "Order Up / Ready at Window" webhook to worker-tb-where when a ticket is bumped. */
export async function fireOrderReady(env, order) {
  if (!env || (!env.TB_SECRET && !env.KIOSK_KEY) || !order) return false;
  const r = await fetchJsonTimeout(whereOrigin(env) + "/kitchen/ready", {
    method: "POST",
    headers: whereHeaders(env, true),
    body: JSON.stringify({
      id: order.id,
      ticket: order.ticket || order.seq || order.id,
      customer: order.customer || "",
      source: order.source || "",
      tagId: order.tagPickup ? order.tagPickup.id : null,
    }),
  }, 2500);
  return r.ok;
}
