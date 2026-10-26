/* "Order ahead": customers order from their own phone at station.thirstybeaches.com/order
   (the kiosk page built in phone mode by build.js) and pay through the same Clover Hosted Checkout
   as "Pay on my phone" (qr.js). Everything that is different for these orders lives here:

     GET /api/order-ahead  -> {enabled, open, label}   public, cached; the website shows its
                                                        "Order ahead" button only when both are true
     GET /api/control      -> sold-out drinks/options + specials for the phone page, read from the
                              same kiosk-control.json the trailer kiosk uses (nothing else from it)
     onlineGate()          -> the extra checks qr.js runs for a cart with source:"online"

   On when ORDER_AHEAD is "true" (set in wrangler.toml [vars], see OPS.md). Needs CLOVER_ECOMM_TOKEN or RELAY_KEY too.
   Orders are only taken while the trailer is live: tb-where /where says open:true (cached 60 s).
   Kiosk carts (no source) never come through here.                                              */
import { norm } from "./pricebook.js";
import { checkoutConfigured } from "./relay.js";

const WHERE_URL = "https://tb-where.nicholasroper.workers.dev/where";
const CONTROL_URL = "https://raw.githubusercontent.com/nicholasroper-cloud/Thirsty-Beaches-Control/main/kiosk-control.json";
const WHERE_TTL_MS = 60000, WHERE_FAIL_TTL_MS = 15000;
const CONTROL_TTL_MS = 60000;

export const oaMemo = { where: null, whereAt: 0, control: null, controlAt: 0 };   // per-isolate caches

const truthy = v => /^(1|true|yes|on)$/i.test(String(v == null ? "" : v).trim());
export const orderAheadOn = env => truthy(env.ORDER_AHEAD) && checkoutConfigured(env) && env.QR_ENABLED !== "0";
const intVar = (v, def, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
export const limits = env => ({
  maxItems: intVar(env.ORDER_AHEAD_MAX_ITEMS, 8, 1, 30),                 // drinks + treats per order
  maxCents: intVar(env.ORDER_AHEAD_MAX_TOTAL, 100, 5, 500) * 100,        // dollars
  perHour: intVar(env.ORDER_AHEAD_RATE_PER_HOUR, 12, 1, 1000),          // online carts per IP per hour
});

async function getJson(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { cf: { cacheTtl: 0 }, headers: { accept: "application/json" }, signal: ctl.signal });
    if (!r.ok) throw new Error(url.split("?")[0] + " -> " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* Is the trailer live? -> {open, label}. Fails closed: if tb-where can't be read, online orders wait. */
export async function trailerStatus(env) {
  const now = Date.now();
  const m = oaMemo.where;
  if (m && now - oaMemo.whereAt < (m.failed ? WHERE_FAIL_TTL_MS : WHERE_TTL_MS) && now >= oaMemo.whereAt) return m;
  let out;
  try {
    const d = await getJson(env.WHERE_URL || WHERE_URL, 5000);
    out = { open: !!(d && d.open === true), label: d && typeof d.label === "string" ? d.label.slice(0, 80) : "" };
  } catch (e) {
    console.error("order-ahead: tb-where unreachable", e && e.message);
    out = { open: false, label: "", failed: true };
  }
  oaMemo.where = out; oaMemo.whereAt = now;
  return out;
}

const strList = (a, n) => Array.isArray(a) ? a.filter(x => typeof x === "string" && x.length <= 120).slice(0, n) : [];
function cleanSpecial(s) {
  if (!s || typeof s !== "object") return null;
  const str = (v, n) => typeof v === "string" ? v.slice(0, n) : "";
  return { id: str(s.id, 60), name: str(s.name, 60), blurb: str(s.blurb, 200), label: str(s.label, 40), catKey: str(s.catKey, 40),
    base: str(s.base, 120), baseItemId: str(s.baseItemId, 60), mods: strList(s.mods, 25), updated: str(s.updated, 40) };
}
/* The public slice of kiosk-control.json. Never the health-check URL, commands or settings. */
export async function controlData(env) {
  const now = Date.now();
  if (oaMemo.control && now - oaMemo.controlAt < CONTROL_TTL_MS && now >= oaMemo.controlAt) return oaMemo.control;
  let out;
  try {
    const d = await getJson((env.CONTROL_URL || CONTROL_URL) + "?t=" + Math.floor(now / CONTROL_TTL_MS), 6000);
    out = { soldOut: strList(d && d.soldOut, 500), soldOutOptions: strList(d && d.soldOutOptions, 500),
      specials: (Array.isArray(d && d.specials) ? d.specials : []).slice(0, 20).map(cleanSpecial).filter(s => s && s.id && s.catKey),
      updated: typeof (d && d.updated) === "string" ? d.updated.slice(0, 40) : "" };
  } catch (e) {
    console.error("order-ahead: control file unreachable", e && e.message);
    if (oaMemo.control) return oaMemo.control;                      // keep the last good copy
    out = { soldOut: [], soldOutOptions: [], specials: [], updated: "", stale: true };
  }
  oaMemo.control = out; oaMemo.controlAt = now;
  return out;
}

/* First cart line asking for something marked sold out -> {line, what} | null.
   Same ids the kiosk greys out: drink ids (soldOut) and "<option key>:<choice name>" (soldOutOptions). */
export function soldOutProblem(lines, control, menu) {
  const ids = new Set(control.soldOut || []), opts = new Set(control.soldOutOptions || []);
  if (!ids.size && !opts.size) return null;
  for (const [i, l] of lines.entries()) {
    const n = norm(l.name);
    const cats = l.catKey && Object.prototype.hasOwnProperty.call(menu.cats, l.catKey) ? [menu.cats[l.catKey]] : Object.values(menu.cats);
    for (const cat of cats) for (const it of cat.items) if (ids.has(it.id) && norm(it.name) === n) return { line: i, what: it.name };
    for (const m of l.mods || []) for (const cat of cats) for (const o of cat.options)
      if (opts.has(o.key + ":" + m) && o.choices.some(ch => ch.name === m)) return { line: i, what: m };
  }
  return null;
}

async function onlineRateLimited(env, req, perHour) {
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const key = `rlo:${ip}:${Math.floor(Date.now() / 3600000)}`;
  const n = parseInt((await env.STATE.get(key)) || "0", 10) || 0;
  if (n >= perHour) return true;
  await env.STATE.put(key, String(n + 1), { expirationTtl: 7200 });
  return false;
}

/* Checks before the cart is priced. -> null (go on) | {status, body} (refuse). */
export async function onlineGate(req, env, body, site) {
  if (!orderAheadOn(env)) return { status: 503, body: { error: "order-ahead-off" } };
  if (req.headers.get("origin") !== site) return { status: 403, body: { error: "origin not allowed" } };
  const lim = limits(env);
  if (await onlineRateLimited(env, req, lim.perHour)) return { status: 429, body: { error: "rate-limited" } };
  if (body && Array.isArray(body.lines)) {
    const qty = body.lines.reduce((a, l) => a + (l && Number.isInteger(l.qty) && l.qty > 0 ? l.qty : 1), 0);
    if (body.lines.length > lim.maxItems || qty > lim.maxItems) return { status: 400, body: { error: "too-big", max: lim.maxItems } };
  }
  const st = await trailerStatus(env);
  if (!st.open) return { status: 409, body: { error: "closed" } };
  return null;
}

/* Checks after the cart is priced (v.lines carry the server's prices). */
export async function onlineAfterPricing(env, lines, menu) {
  const lim = limits(env);
  const total = lines.reduce((a, l) => a + l.price * l.qty, 0);
  if (total > lim.maxCents) return { status: 400, body: { error: "too-big", maxTotal: lim.maxCents } };
  const sold = soldOutProblem(lines, await controlData(env), menu);
  if (sold) return { status: 409, body: { error: "sold-out", line: sold.line, item: sold.what } };
  return null;
}

const pubJson = (obj, status = 200, maxAge = 30) => new Response(JSON.stringify(obj), { status, headers: {
  "content-type": "application/json", "cache-control": `public, max-age=${maxAge}`,
  "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "x-content-type-options": "nosniff" } });

/* Public routes. -> Response | null */
export async function handleOrderAhead(req, env, url) {
  const p = url.pathname;
  if (p !== "/api/order-ahead" && p !== "/api/control") return null;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-max-age": "600" } });
  if (req.method !== "GET") return pubJson({ error: "method" }, 405, 0);
  if (p === "/api/control") return pubJson(await controlData(env), 200, 60);
  const enabled = orderAheadOn(env);
  const st = enabled ? await trailerStatus(env) : { open: false, label: "" };
  return pubJson({ enabled, open: enabled && st.open, label: enabled && st.open ? st.label : "", maxItems: limits(env).maxItems });
}
