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
const GRAB_CATS   = new Set((process.env.GRAB_CATEGORIES || "Treats").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
const STATE_FILE  = path.join(__dirname, "make-state.json");

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

// ---- local done-state (never leaves this PC) ----
let state = { done: {}, picked: {} };   // orderId -> epoch ms when marked done / handed to the customer ("Picked up")
try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); if (!state.done) state.done = {}; if (!state.picked) state.picked = {}; } catch {}
function saveState() {
  const cutoff = Date.now() - 48 * 3600000;
  for (const [id, t] of Object.entries(state.done)) if (t < cutoff) delete state.done[id];
  for (const [id, t] of Object.entries(state.picked)) if (t < cutoff) delete state.picked[id];
  try { fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(state)); fs.renameSync(STATE_FILE + ".tmp", STATE_FILE); } catch (e) { console.error("state save failed:", e.message); }
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
    const r = await cloverGet(`/orders?filter=createdTime>=${since}&expand=lineItems,lineItems.modifications&orderBy=createdTime DESC&limit=${PAGE}&offset=${page * PAGE}`);
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
      const lines = (((o.lineItems || {}).elements) || []).filter(li => !li.exchanged && !li.refunded);
      const items = groupLines(lines.map(normalizeLine));
      const who = parseCustomer(o);
      orders.push({
        id: o.id, ticket: String(seqs.get(o.id)), seq: seqs.get(o.id), ref: o.id.slice(-4).toUpperCase(), created: o.createdTime, state: o.state || "",
        paid: (o.paymentState || "").toUpperCase() === "PAID", customer: who.name, source: who.source,
        total: o.total || 0, items, done: state.done[o.id] || 0, picked: state.picked[o.id] || 0
      });
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
  if (p === "/queue" || p === "/done" || p === "/undo" || p === "/pickedup") {
    if (!keyOk(req, url)) return sendJSON(res, 401, { error: "key required" });
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
