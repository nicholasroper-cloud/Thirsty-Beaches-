/* ============================================================================
   Thirsty Beaches MAKE STATION server — ZERO npm dependencies.

   A separate, read-mostly sidecar for the drink-making screen (Echo Show 21 or
   any tablet/browser on the trailer Wi-Fi). It:
     - polls Clover for recent orders (any source: kiosk, Register, Flex)
     - normalizes line items + modifiers and classifies each as a DRINK to
       build or an item to GRAB (Treats etc.), using the Clover item catalog
     - remembers which tickets were marked done (make-state.json, local only)
     - serves make-station.html + recipes.json to the LAN

   It NEVER writes to Clover, and the Clover token never leaves this process.
   The kiosk server (clover-menu-server.js) is untouched and stays localhost-only.

   Run with:  node --env-file=kiosk-config.env make-station-server.js
   (Run-MakeStation.bat does this for you using the bundled node.exe.)

   Config (kiosk-config.env, all optional):
     MAKE_PORT=8140              port the Show connects to
     STATION_KEY=<secret>        when set, /queue /done /undo /pickedup need it (X-Key header, or ?k= for one more release);
                                 the pages send it on their own once opened with ?k=<secret>
     MAKE_BIND=<this PC's LAN IP> which address to listen on. Default: 127.0.0.1 (this PC only), or 0.0.0.0 when STATION_KEY
                                 is set. 0.0.0.0 WITHOUT a STATION_KEY is refused: the ticket feed (customer names, orders)
                                 and the done/undo buttons would be open to everyone on the trailer Wi-Fi.
     MAKE_LOOKBACK_HOURS=16      how far back to show undone tickets (and count today's stats)
     MAKE_POLL_SEC=6             how often to ask Clover for orders
     GRAB_CATEGORIES=Treats      comma list of catalog categories that are "grab", not "build"
   ============================================================================ */
const http = require("http");
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const crypto = require("crypto");

const TOKEN       = process.env.CLOVER_API_TOKEN;
const MERCHANT_ID = process.env.CLOVER_MERCHANT_ID;
const BASE        = process.env.CLOVER_BASE_URL || "https://api.clover.com";
const PORT        = parseInt(process.env.MAKE_PORT || "8140", 10);
const STATION_KEY = (process.env.STATION_KEY || "").trim();
const BIND_ENV    = (process.env.MAKE_BIND || "").trim();
const BIND        = BIND_ENV || (STATION_KEY ? "0.0.0.0" : "127.0.0.1");
const WILDCARD    = BIND === "0.0.0.0" || BIND === "::" || BIND === "";
const LOOKBACK_MS = Math.max(1, parseFloat(process.env.MAKE_LOOKBACK_HOURS || "16")) * 3600000;
const POLL_MS     = Math.max(3, parseInt(process.env.MAKE_POLL_SEC || "6", 10)) * 1000;
const KIOSK_TYPE  = (process.env.KIOSK_ORDER_TYPE_ID || "").trim();   // Clover orderType id of the kiosk's orders (ticket release gate, ADR section 5)
const GRAB_CATS   = new Set((process.env.GRAB_CATEGORIES || "Treats").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
const STATE_FILE  = path.join(__dirname, "make-state.json");
const TB_WHERE_ORIGIN = (process.env.TB_WHERE_ORIGIN || process.env.WHERE_URL || "https://tb-where.nicholasroper.workers.dev").trim().replace(/\/where\/?$/i, "").replace(/\/+$/, "");
const TB_SECRET       = (process.env.TB_SECRET || "").trim();
const KIOSK_KEY       = (process.env.KIOSK_KEY || "").trim();
const SDT_PICKUP_URL  = (process.env.SDT_PICKUP_URL || "https://saltydogtags.com/api/tags-pickup").trim();
const CROSS_BRAND_KEY = (process.env.CROSS_BRAND_SECRET || "").trim();
const SDT_ADMIN_TOKEN = (process.env.SDT_ADMIN_TOKEN || "").trim();

const FALLBACK_SECRET_MENU = [
  { id: "neon-rip-curl", name: "Neon Rip Curl", minScore: 600, base: "Sprite", syrups: "2p Blue Raspberry, 1p Coconut, 1p Fresh Lime", cream: "1oz Coconut Cream", garnish: "Fresh Lime Wedge", build: "Sprite · 2p Blue Raz, 1p Coconut, 1p Lime · 1oz Coconut Cream · Lime Wedge" },
  { id: "80s-sunset-cream", name: "80s Sunset Cream", minScore: 900, base: "Dr Pepper", syrups: "2p Peach, 1p Raspberry, 1p Vanilla", cream: "1oz Sweet Cream", garnish: "Maraschino Cherry", build: "Dr Pepper · 2p Peach, 1p Raz, 1p Vanilla · 1oz Sweet Cream · Cherry" },
  { id: "synthwave-shark-bite", name: "Synthwave Shark Bite", minScore: 1200, base: "Mountain Dew", syrups: "2p Mango Purée, 1p Strawberry Purée, 1p Passion Fruit", cream: "Splash Coconut Cream", garnish: "Passion Fruit Popping Pearls", build: "Mtn Dew · 2p Mango, 1p Strawberry, 1p Passion Fruit · Splash Coconut Cream · Popping Pearls" },
  { id: "turbo-beach-bum", name: "Turbo Beach Bum", minScore: 1500, base: "Energy Base", syrups: "2p Pineapple, 1p Blue Raspberry, 1p Coconut", cream: "1oz Vanilla Cream", garnish: "Fresh Lime Squeeze", build: "Energy · 2p Pineapple, 1p Blue Raz, 1p Coconut · 1oz Vanilla Cream · Fresh Lime" },
  { id: "velvet-palm", name: "Velvet Palm", minScore: 1800, base: "Root Beer", syrups: "2p Butterscotch, 1p Toasted Marshmallow", cream: "1oz Vanilla Cream", garnish: "Whipped Cream Swirl", build: "Root Beer · 2p Butterscotch, 1p Marshmallow · 1oz Vanilla Cream · Whip Swirl" },
];

if (!TOKEN || !MERCHANT_ID) {
  console.error("Missing CLOVER_API_TOKEN or CLOVER_MERCHANT_ID in kiosk-config.env.");
  process.exit(1);
}
if (WILDCARD && !STATION_KEY) {
  console.error("Refusing to listen on " + (BIND || "all addresses") + " without a STATION_KEY: anyone on the Wi-Fi could read the tickets and mark them done.\n" +
    "Fix: set STATION_KEY=<a long random secret> in kiosk-config.env (and open the Show once with  http://<pc>:" + PORT + "/?k=<secret> ),\n" +
    "or set MAKE_BIND to this PC's own LAN address, e.g. MAKE_BIND=192.168.1.50 .");
  process.exit(78);
}
// a bad request must never take the station down
process.on("unhandledRejection", e => console.error("unhandled rejection (kept running):", (e && e.stack) || e));

const MIME = { ".html":"text/html; charset=utf-8", ".json":"application/json", ".png":"image/png", ".svg":"image/svg+xml", ".js":"text/javascript", ".css":"text/css" };
const send = (res, status, body, type) => { res.writeHead(status, { "Content-Type": type || "text/plain", "Cache-Control": "no-cache" }); res.end(body); };
const sendJSON = (res, status, obj) => send(res, status, JSON.stringify(obj), "application/json");
function sendFile(res, fp) {
  // fs.readFile throws synchronously on a NUL byte in the path (ERR_INVALID_ARG_VALUE): reject those up front
  if (typeof fp !== "string" || fp.includes("\0")) return send(res, 400, "Bad request");
  try {
    fs.readFile(fp, (err, data) => {
      if (err) return send(res, 404, "Not found");
      send(res, 200, data, MIME[path.extname(fp).toLowerCase()] || "application/octet-stream");
    });
  } catch { send(res, 404, "Not found"); }
}
// constant-time compare of the access key (hash both sides so the lengths always match)
const sha = v => crypto.createHash("sha256").update(String(v)).digest();
function keyOk(req, url) {
  if (!STATION_KEY) return true;
  const given = req.headers["x-key"] || url.searchParams.get("k") || "";   // ?k= still works for one more release
  return crypto.timingSafeEqual(sha(given), sha(STATION_KEY));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ""; req.on("data", c => { b += c; if (b.length > 20000) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => resolve(b)); req.on("error", reject); req.on("close", () => resolve(b));
  });
}
async function cloverGet(p) {
  const r = await fetch(`${BASE}/v3/merchants/${MERCHANT_ID}${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`Clover GET ${p.split("?")[0]} -> ${r.status}`);
  return r.json();
}

// ---- local done-state & 86 stock (never leaves this PC except voluntary tb-where sync) ----
let state = { done: {}, picked: {}, stock86: { items: [], ingredients: [], updatedAt: null } };
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (!state.done) state.done = {};
  if (!state.picked) state.picked = {};
  if (!state.stock86 || !Array.isArray(state.stock86.items)) state.stock86 = { items: [], ingredients: [], updatedAt: null };
} catch {}
function saveState() {
  const cutoff = Date.now() - 48 * 3600000;
  for (const [id, t] of Object.entries(state.done)) if (t < cutoff) delete state.done[id];
  for (const [id, t] of Object.entries(state.picked)) if (t < cutoff) delete state.picked[id];
  try { fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(state)); fs.renameSync(STATE_FILE + ".tmp", STATE_FILE); } catch (e) { console.error("state save failed:", e.message); }
}

// ---- Kitchen Board V2 sync helpers (worker-tb-where + Salty Dog Tags pickup feed) ----
const extrasCache = { data: null, at: 0, pickups: [], pickupsAt: 0 };
function whereHeaders(hasBody) {
  const h = { Accept: "application/json" };
  if (hasBody) h["Content-Type"] = "application/json";
  if (TB_SECRET) h["Authorization"] = "Bearer " + TB_SECRET;
  if (KIOSK_KEY) h["X-Kiosk-Key"] = KIOSK_KEY;
  return h;
}
async function fetchJsonTimeout(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 3000);
  try {
    const r = await fetch(url, Object.assign({}, opts || {}, { signal: ctl.signal }));
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: null }; }
  finally { clearTimeout(t); }
}
const normName = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function matchTagPickup(order, pickups) {
  const note = String((order && (order.orderNote || order.note)) || "");
  const explicit = note.match(/\b(SDT-[A-Z0-9]{4,10}|SD-[A-Z0-9]{3,10})\b/i);
  const vipM = note.match(/\b(VIP-[A-Z2-9]{4,8})\b/i);
  const list = Array.isArray(pickups) ? pickups : [];
  if (explicit) {
    const code = explicit[1].toUpperCase();
    return list.find(p => String(p.id || "").toUpperCase() === code) || { id: code, customerName: order.customer || "", dogNames: [], ready: true, vipCode: vipM ? vipM[1].toUpperCase() : null };
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
async function refreshPickupTags() {
  const now = Date.now();
  if (now - extrasCache.pickupsAt < 60000 && extrasCache.pickupsAt > 0) return extrasCache.pickups;
  if (!CROSS_BRAND_KEY && !SDT_ADMIN_TOKEN) return [];
  const headers = CROSS_BRAND_KEY ? { Accept: "application/json", "X-Cross-Brand-Key": CROSS_BRAND_KEY } : { Accept: "application/json", Authorization: "Bearer " + SDT_ADMIN_TOKEN };
  const r = await fetchJsonTimeout(SDT_PICKUP_URL, { headers }, 3000);
  if (r.ok && r.data && Array.isArray(r.data.pickups)) { extrasCache.pickups = r.data.pickups; extrasCache.pickupsAt = now; }
  return extrasCache.pickups;
}
/* Redeem relay. A 4-character claim goes straight to the Worker. A Salty Dog Tags "VIP-XXXX" pickup pass is different: the Worker only
   redeems it with sig = first 12 hex of HMAC-SHA256(CROSS_BRAND_SECRET, code), which proves the pass came from saltydogtags.com. The
   station may send a sig only when it can prove the code itself: a sig scanned off the pass (body.sig), or the code is in the signed
   SDT pickup feed (then the sig is computed from the shared secret). Never sign a code nobody vouched for. Otherwise nothing is sent to
   the Worker and the answer is the plain status "verify-at-sdt" (not a 403): check the order at saltydogtags.com. */
const VIP_RE = /^VIP-?([A-Z2-9]{4,8})$/;
async function buildRedeemRequest(body) {
  const clean = String((body && body.code) || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  const vip = VIP_RE.exec(clean);
  const base = { by: "station", checkOnly: !!(body && body.checkOnly === true) };
  if (!vip) return { send: { code: clean, ...base } };
  const code = "VIP-" + vip[1];
  const typedSig = String((body && body.sig) || "").trim().toLowerCase();
  let sig = /^[0-9a-f]{12}$/.test(typedSig) ? typedSig : "";
  if (!sig && CROSS_BRAND_KEY) {
    const list = await refreshPickupTags();
    if (list.some(p => String(p.vipCode || "").toUpperCase() === code)) sig = crypto.createHmac("sha256", CROSS_BRAND_KEY).update(code).digest("hex").slice(0, 12);
  }
  if (!sig) return { answer: { status: 200, data: { ok: false, status: "verify-at-sdt", code, message: "Verify this VIP pass on the Salty Dog Tags order (" + code + ") before handing over the free upgrade. It cannot be redeemed here without the pass signature." } } };
  return { send: { code, sig, ...base } };
}
async function getKitchenExtras() {
  const now = Date.now();
  if (extrasCache.data && now - extrasCache.at < 15000) return extrasCache.data;
  const authed = !!(TB_SECRET || KIOSK_KEY);
  const [smR, clR, drR, stR, pickups] = await Promise.all([
    authed ? fetchJsonTimeout(TB_WHERE_ORIGIN + "/secret-menu", { headers: { Accept: "application/json" } }, 2500) : Promise.resolve({ ok: false }),
    authed ? fetchJsonTimeout(TB_WHERE_ORIGIN + "/kitchen/claims", { headers: whereHeaders(false) }, 2500) : Promise.resolve({ ok: false }),
    authed ? fetchJsonTimeout(TB_WHERE_ORIGIN + "/kitchen/drops", { headers: whereHeaders(false) }, 2500) : Promise.resolve({ ok: false }),
    authed ? fetchJsonTimeout(TB_WHERE_ORIGIN + "/stock", { headers: { Accept: "application/json" } }, 2500) : Promise.resolve({ ok: false }),
    refreshPickupTags(),
  ]);
  const secretMenu = (smR.ok && smR.data && Array.isArray(smR.data.drinks) && smR.data.drinks.length) ? smR.data.drinks : FALLBACK_SECRET_MENU;
  const claims = (clR.ok && clR.data && Array.isArray(clR.data.claims)) ? clR.data.claims.filter(c => !c.redeemed).slice(0, 24) : [];
  const drops = (drR.ok && drR.data && Array.isArray(drR.data.drops)) ? drR.data.drops.slice(0, 12) : [];
  const remoteSt = (stR.ok && stR.data && Array.isArray(stR.data.items)) ? stR.data : state.stock86;
  const stock = (state.stock86.updatedAt || 0) >= (remoteSt.updatedAt || 0) ? state.stock86 : remoteSt;
  const out = { secretMenu, claims, drops, stock, pickups, syncedAt: now };
  extrasCache.data = out; extrasCache.at = now;
  return out;
}
function fireOrderReady(order) {
  if ((!TB_SECRET && !KIOSK_KEY) || !order) return;
  fetchJsonTimeout(TB_WHERE_ORIGIN + "/kitchen/ready", {
    method: "POST",
    headers: whereHeaders(true),
    body: JSON.stringify({ id: order.id, ticket: order.ticket || order.seq || order.id, customer: order.customer || "", source: order.source || "", tagId: order.tagPickup ? order.tagPickup.id : null }),
  }, 2500).catch(() => {});
}

// ---- catalog cache: item id -> { name, category } ----
let catalog = { byId: {}, byName: {}, at: 0 };
async function refreshCatalog() {
  try {
    const byId = {}, byName = {};
    let offset = 0;
    while (offset < 2000) {
      const r = await cloverGet(`/items?expand=categories&limit=500&offset=${offset}`);
      const els = (r && r.elements) || [];
      for (const it of els) {
        const cat = (((it.categories || {}).elements) || []).map(c => c.name).join(" / ");
        byId[it.id] = { name: it.name, category: cat };
        byName[String(it.name || "").toLowerCase()] = { id: it.id, category: cat };
      }
      if (els.length < 500) break;
      offset += 500;
    }
    catalog = { byId, byName, at: Date.now() };
    console.log(`catalog: ${Object.keys(byId).length} items`);
  } catch (e) { console.error("catalog refresh failed:", e.message); }
}

/* ---- ticket release gate (ADR 2026-11-15 section 5) ----
   The kiosk writes the order's state into its Clover title: TBK:PENDING (hidden), TBK:PAID:<id> (PAID), TBK:COLLECT (collect at the
   window), TBK:CHECK (a card payment that could not be proven: do NOT charge), and TBK:SHELL:<id> on the shell order the Flex makes for
   each card Sale. Rules, in order:
     - TBK:SHELL, or an order whose only line is "Manual transaction"      -> hidden everywhere
     - not a Kiosk order (orderType is not KIOSK_ORDER_TYPE_ID and no TBK: title) -> unchanged legacy behavior (badge null)
     - TBK:PAID and Clover also says paymentState PAID                     -> DOUBLE PAID: void one (paid twice)
     - TBK:PAID                                                            -> PAID
     - TBK:COLLECT and paymentState PAID (paid at the window)              -> PAID, else COLLECT $total
     - TBK:CHECK                                                           -> CHECK READER, do not charge
     - TBK:PENDING, a Kiosk-typed order with no title yet, anything else   -> hidden
   Same rules live in cloud/src/ticket.js; tests/kiosk/gate.js pins both to one table. */
function ticketGate(o, kioskTypeId) {
  const title = String(o.title || "");
  const lines = (((o.lineItems || {}).elements) || []).filter(li => !li.exchanged && !li.refunded);
  if (/^TBK:SHELL\b/.test(title)) return { show: false };
  if (lines.length && lines.every(li => String(li.name || "").trim().toLowerCase() === "manual transaction")) return { show: false };
  const isKiosk = title.startsWith("TBK:") || (!!kioskTypeId && !!o.orderType && o.orderType.id === kioskTypeId);
  if (!isKiosk) return { show: true, badge: null };
  const native = String(o.paymentState || "").toUpperCase() === "PAID";
  const money = "$" + ((o.total || 0) / 100).toFixed(2);
  if (/^TBK:PAID\b/.test(title)) return native ? { show: true, paid: true, badge: { kind: "DOUBLE", text: "2× DOUBLE", long: "DOUBLE PAID: void one" } } : { show: true, paid: true, badge: { kind: "PAID", text: "✓ PAID", long: "✓ PAID" } };
  if (/^TBK:COLLECT\b/.test(title)) return native ? { show: true, paid: true, badge: { kind: "PAID", text: "✓ PAID", long: "✓ PAID" } } : { show: true, paid: false, badge: { kind: "COLLECT", text: "COLLECT " + money, long: "COLLECT " + money } };
  if (/^TBK:CHECK\b/.test(title)) return { show: true, paid: false, badge: { kind: "CHECK", text: "⚠ CHECK", long: "CHECK READER, do not charge" } };
  return { show: false };
}

// ---- orders cache ----
let queue = { orders: [], at: 0, error: null };
/* The kiosk puts the drink's FULL add-on list in the line note as "MODS: a | b | c" (the Clover line name is capped at 127
   characters, which cut off the trailing add-ons). The name still carries "Drink · a, b" for receipts and older stations;
   when both exist the note wins and anything only the name has is appended. */
const MODS_NOTE = /^MODS: ([\s\S]+)$/;
function normalizeLine(li) {
  // Kiosk custom lines look like "Thirst Trap · Medium 24oz, Dr Pepper, Coconut"; Register lines carry real modifiers.
  let name = String(li.name || "Item").trim();
  let mods = (((li.modifications || {}).elements) || []).map(m => String(m.name || "").trim()).filter(Boolean);
  let note = String(li.note || "").trim();
  const mm = MODS_NOTE.exec(note);
  const full = mm ? mm[1].split(" | ").map(x => x.trim()).filter(Boolean) : null;
  if (full) note = "";
  const sep = name.indexOf(" · ");
  if (sep > 0 && (!mods.length || full)) {
    const inName = name.slice(sep + 3).split(",").map(x => x.trim()).filter(Boolean);
    name = name.slice(0, sep).trim();
    if (!mods.length) mods = full ? full.concat(inName.filter(x => !full.includes(x))) : inName;
  } else if (full && !mods.length) mods = full;
  const itemId = li.item && li.item.id;
  const cat = itemId && catalog.byId[itemId] ? catalog.byId[itemId].category : (catalog.byName[name.toLowerCase()] || {}).category || "";
  const grab = cat.split(" / ").some(c => GRAB_CATS.has(c.toLowerCase()));
  return { name, mods, category: cat, kind: grab ? "grab" : "drink", note, price: li.price || 0 };
}
function groupLines(lines) {
  const out = [];
  for (const l of lines) {
    const key = l.name + "|" + l.mods.join(",") + "|" + l.note;
    const hit = out.find(o => o.key === key);
    if (hit) hit.qty++; else out.push({ key, qty: 1, ...l });
  }
  return out.map(({ key, ...rest }) => rest);
}
function parseCustomer(o) {
  const note = String(o.note || "");
  const m = note.match(/^(.+?)\s+—\s+Kiosk order/);
  if (m) return { name: m[1].trim(), source: "Kiosk" };
  if (/kiosk order/i.test(note)) return { name: "", source: "Kiosk" };
  const dev = o.device && o.device.id ? "Register" : "Register";
  return { name: String(o.title || "").trim(), source: dev };
}
/* ---- daily order numbers: 101, 102, ... per local day (the Clover id stays the key everywhere) ----
   The kiosk server writes its number into the order note ("Sam — Kiosk order #104"). Orders without one (Register, Flex,
   phone) get 101 + their rank among that day's orders, bumped past any number already taken so two tickets never share one.
   Same rules live in kiosk-server.js (assigns the number) and cloud/src/ticket.js; tests/kiosk/seq.js keeps the three equal. */
const SEQ_START = 100;
const noteSeq = note => { const m = /Kiosk order #(\d{1,5})\b/.exec(String(note || "")); return m ? +m[1] : null; };
const dayKey = ms => { const d = new Date(ms); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); };
function assignSeq(orders) {            // [{id, created, seq|null}] -> Map(id -> number)
  const out = new Map(), byDay = new Map();
  for (const o of orders) { const k = dayKey(o.created); (byDay.get(k) || byDay.set(k, []).get(k)).push(o); }
  for (const list of byDay.values()) {
    list.sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const taken = new Set();
    for (const o of list) if (o.seq && !taken.has(o.seq)) { taken.add(o.seq); out.set(o.id, o.seq); }   // first claim of a number wins
    list.forEach((o, i) => { if (out.has(o.id)) return; let c = SEQ_START + i + 1; while (taken.has(c)) c++; taken.add(c); out.set(o.id, c); });
  }
  return out;
}
/* every order since `since`, newest first, paged (Clover hands back 100 at a time; the old single ASC query dropped the newest tickets) */
const PAGE = 100, MAX_PAGES = 10;
async function fetchOrders(since) {
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await cloverGet(`/orders?filter=createdTime>=${since}&expand=lineItems,lineItems.modifications,orderType&orderBy=createdTime DESC&limit=${PAGE}&offset=${page * PAGE}`);
    const els = (r && r.elements) || [];
    all.push(...els);
    if (els.length < PAGE) break;
  }
  return all.reverse();                 // oldest first for the screens
}
async function refreshQueue() {
  try {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const since = Math.min(Date.now() - LOOKBACK_MS, startOfDay.getTime());   // far enough back to rank today's orders too
    const raw = await fetchOrders(since);
    const live = raw.filter(o => (((o.lineItems || {}).elements) || []).some(li => !li.exchanged && !li.refunded));
    const seqs = assignSeq(live.map(o => ({ id: o.id, created: o.createdTime, seq: noteSeq(o.note) })));
    const cutoff = Date.now() - LOOKBACK_MS;
    const orders = [];
    for (const o of live) {
      if (o.createdTime < cutoff) continue;
      const gate = ticketGate(o, KIOSK_TYPE);
      if (!gate.show) continue;                                       // TBK:PENDING, shell orders: never reach the make screen or the board
      const lines = (((o.lineItems || {}).elements) || []).filter(li => !li.exchanged && !li.refunded);
      const items = groupLines(lines.map(normalizeLine));
      const who = parseCustomer(o);
      const ord = {
        id: o.id, ticket: String(seqs.get(o.id)), seq: seqs.get(o.id), ref: o.id.slice(-4).toUpperCase(), created: o.createdTime, state: o.state || "",
        paid: gate.paid !== undefined ? gate.paid : (o.paymentState || "").toUpperCase() === "PAID", badge: gate.badge || null, customer: who.name, source: who.source,
        orderNote: String(o.note || "").slice(0, 160),
        total: o.total || 0, items, done: state.done[o.id] || 0, picked: state.picked[o.id] || 0
      };
      const tp = matchTagPickup(ord, extrasCache.pickups);
      if (tp) ord.tagPickup = tp;
      orders.push(ord);
    }
    queue = { orders, at: Date.now(), error: null };
  } catch (e) { queue = { ...queue, error: e.message, at: Date.now() }; console.error("queue refresh failed:", e.message); }
}

// ---- HTTP ----
async function handle(req, res) {
  let url;
  try { url = new URL(req.url, "http://x"); } catch { return send(res, 400, "Bad request"); }   // e.g. "GET //" does not parse
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { return send(res, 400, "Bad request"); }
  if (p.includes("\0") || p.includes("\\")) return send(res, 400, "Bad request");
  // No CORS headers on purpose: the pages are same-origin, and a wildcard let any web page on the trailer Wi-Fi drive /done and /undo.
  if (req.method === "GET" && (p === "/" || p === "/index.html")) return sendFile(res, path.join(__dirname, "make-station.html"));
  if (req.method === "GET" && (p === "/board" || p === "/board/")) return sendFile(res, path.join(__dirname, "pickup-board.html"));
  if (req.method === "GET" && p === "/recipes.json") return sendFile(res, path.join(__dirname, "recipes.json"));
  if (req.method === "GET" && p === "/addons.json") return sendFile(res, path.join(__dirname, "addons.json"));
  if (req.method === "GET" && p.startsWith("/assets/")) {
    const assetsDir = path.join(__dirname, "assets");
    const fp = path.normalize(path.join(__dirname, p));
    if (!fp.startsWith(assetsDir + path.sep)) return send(res, 403, "Forbidden");   // the separator keeps a sibling like "assets-old" out
    return sendFile(res, fp);
  }
  if (req.method === "GET" && p === "/health") return sendJSON(res, 200, { ok: true, orders: queue.orders.length, catalogItems: Object.keys(catalog.byId).length, lastPoll: queue.at, error: queue.error, keyRequired: !!STATION_KEY, bind: BIND });
  if (p === "/queue" || p === "/done" || p === "/undo" || p === "/pickedup" || p.startsWith("/api/kitchen/") || p === "/api/stock" || p === "/api/stock/toggle") {
    if (!keyOk(req, url)) return sendJSON(res, 401, { error: "key required" });
  }
  if (req.method === "GET" && p === "/api/kitchen/extras") return sendJSON(res, 200, await getKitchenExtras());
  if (req.method === "GET" && p === "/api/stock") return sendJSON(res, 200, state.stock86);
  if (req.method === "POST" && (p === "/api/stock/toggle" || p === "/api/kitchen/redeem" || p === "/api/kitchen/drop-complete")) {
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return sendJSON(res, 415, { error: "json only" });
    let body = {};
    try { body = JSON.parse(await readBody(req) || "{}"); } catch { return sendJSON(res, 400, { error: "bad json" }); }
    if (p === "/api/stock/toggle") {
      const kind = body.kind === "ingredient" ? "ingredients" : "items";
      const name = String(body.name || "").trim().toLowerCase().replace(/[^a-z0-9 '&-]/g, "").slice(0, 60);
      if (!name) return sendJSON(res, 400, { error: "bad-name" });
      const set = new Set(state.stock86[kind] || []);
      let out;
      if (typeof body.out === "boolean") { if (body.out) set.add(name); else set.delete(name); out = body.out; }
      else { if (set.has(name)) { set.delete(name); out = false; } else { set.add(name); out = true; } }
      state.stock86[kind] = [...set].sort().slice(0, 120);
      state.stock86.updatedAt = Date.now();
      saveState();
      let synced = false;
      if (TB_SECRET || KIOSK_KEY) {
        const r = await fetchJsonTimeout(TB_WHERE_ORIGIN + "/stock/toggle", {
          method: "POST", headers: whereHeaders(true), body: JSON.stringify({ kind: kind === "ingredients" ? "ingredient" : "item", name, out }),
        }, 3500);
        if (r.ok && r.data && r.data.stock) { state.stock86 = r.data.stock; saveState(); synced = true; }
      }
      extrasCache.data = null;
      return sendJSON(res, 200, { ok: true, kind, name, out, synced, stock: state.stock86 });
    }
    if (!TB_SECRET && !KIOSK_KEY) return sendJSON(res, 503, { error: "tb-where-not-configured" });
    const target = p === "/api/kitchen/redeem" ? "/kitchen/claims/redeem" : "/kitchen/drops/complete";
    let payload = { code: String(body.code || "").trim().toUpperCase() };
    if (p === "/api/kitchen/redeem") {
      const built = await buildRedeemRequest(body);
      if (built.answer) return sendJSON(res, built.answer.status, built.answer.data);
      payload = built.send;
    }
    const r = await fetchJsonTimeout(TB_WHERE_ORIGIN + target, { method: "POST", headers: whereHeaders(true), body: JSON.stringify(payload) }, 3500);
    extrasCache.data = null;
    return sendJSON(res, r.status || 502, r.data || { error: "relay-failed" });
  }
  if (req.method === "GET" && p === "/queue") {
    const now = Date.now();
    const waiting = queue.orders.filter(o => !o.done);
    const ready   = queue.orders.filter(o => o.done && !o.picked && now - o.done < 30 * 60000).sort((a, b) => b.done - a.done).slice(0, 8);
    const today = new Date(now).toDateString();
    const madeToday = Object.values(state.done).filter(t => new Date(t).toDateString() === today).length;
    // today's stats from tickets done today that are still in the lookback window
    const doneToday = queue.orders.filter(o => o.done && new Date(o.done).toDateString() === today);
    const secs = doneToday.map(o => (o.done - o.created) / 1000).filter(x => x > 0 && x < 4 * 3600);
    const avgSec = secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length) : 0;
    const tally = {};
    for (const o of doneToday) for (const it of o.items) if (it.kind === "drink") tally[it.name] = (tally[it.name] || 0) + it.qty;
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));
    const byHour = {};
    for (const o of doneToday) { const h = new Date(o.done).getHours(); byHour[h] = (byHour[h] || 0) + 1; }
    const busiest = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0];
    let pageVer = 0; try { pageVer = Math.floor(fs.statSync(path.join(__dirname, "make-station.html")).mtimeMs) + Math.floor(fs.statSync(path.join(__dirname, "pickup-board.html")).mtimeMs); } catch {}
    return sendJSON(res, 200, { now, pageVer, lastPoll: queue.at, error: queue.error, waiting, ready, madeToday,
      today: { made: madeToday, avgSec, top, busiestHour: busiest ? +busiest[0] : null, busiestCount: busiest ? busiest[1] : 0 } });
  }
  if (req.method === "POST" && (p === "/done" || p === "/undo" || p === "/pickedup")) {
    // JSON only: a cross-origin form or text/plain POST would skip the preflight, so refuse anything else
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return sendJSON(res, 415, { error: "json only" });
    let body = {};
    try { body = JSON.parse(await readBody(req) || "{}"); } catch { return sendJSON(res, 400, { error: "bad json" }); }
    const id = String((body && body.id) || "");
    if (!/^[A-Z0-9]{6,20}$/i.test(id)) return sendJSON(res, 400, { error: "bad id" });
    if (p === "/done") state.done[id] = Date.now();
    else if (p === "/undo") { delete state.done[id]; delete state.picked[id]; }
    else { if (!state.done[id]) return sendJSON(res, 409, { error: "not made yet" }); state.picked[id] = Date.now(); }
    saveState();
    const o = queue.orders.find(x => x.id === id); if (o) { o.done = state.done[id] || 0; o.picked = state.picked[id] || 0; }
    if (p === "/done") fireOrderReady(o || { id, ticket: body.ticket || id.slice(-4).toUpperCase(), customer: body.customer || "", source: body.source || "", tagPickup: body.tagId ? { id: body.tagId } : null });
    return sendJSON(res, 200, { ok: true, id, done: !!state.done[id], picked: !!state.picked[id] });
  }
  send(res, 404, "Not found");
}
const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {          // one bad request never ends the process
    console.error("request failed:", e && e.message);
    try { if (!res.headersSent) send(res, 500, "Server error"); else res.end(); } catch {}
  });
});

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) out.push(`${a.address} (${name})`);
  return out;
}

(async () => {
  await refreshCatalog();
  await refreshQueue();
  setInterval(refreshQueue, POLL_MS);
  setInterval(refreshCatalog, 10 * 60000);
  server.listen(PORT, BIND, () => {
    console.log(`Make Station running on port ${PORT} (bound to ${BIND})`);
    console.log(`  On this PC:        http://localhost:${PORT}/`);
    if (BIND === "127.0.0.1" || BIND === "localhost") console.log("  LAN access is OFF (this PC only). For the Echo Show set STATION_KEY (then open  http://<pc>:" + PORT + "/?k=<key> ) or MAKE_BIND=<this PC's LAN IP>.");
    else for (const a of lanAddresses()) console.log(`  From the Echo Show: http://${a.split(" ")[0]}:${PORT}/${STATION_KEY ? "?k=<STATION_KEY>" : ""}   [${a}]`);
  });
})();
