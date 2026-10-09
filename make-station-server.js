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
     MAKE_BIND=0.0.0.0           0.0.0.0 = reachable on the LAN; 127.0.0.1 = this PC only
     MAKE_LOOKBACK_HOURS=16      how far back to show undone tickets (and count today's stats)
     MAKE_POLL_SEC=6             how often to ask Clover for orders
     GRAB_CATEGORIES=Treats      comma list of catalog categories that are "grab", not "build"
   ============================================================================ */
const http = require("http");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

const TOKEN       = process.env.CLOVER_API_TOKEN;
const MERCHANT_ID = process.env.CLOVER_MERCHANT_ID;
const BASE        = process.env.CLOVER_BASE_URL || "https://api.clover.com";
const PORT        = parseInt(process.env.MAKE_PORT || "8140", 10);
const BIND        = (process.env.MAKE_BIND || "0.0.0.0").trim();
const LOOKBACK_MS = Math.max(1, parseFloat(process.env.MAKE_LOOKBACK_HOURS || "16")) * 3600000;
const POLL_MS     = Math.max(3, parseInt(process.env.MAKE_POLL_SEC || "6", 10)) * 1000;
const GRAB_CATS   = new Set((process.env.GRAB_CATEGORIES || "Treats").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
const STATE_FILE  = path.join(__dirname, "make-state.json");

if (!TOKEN || !MERCHANT_ID) {
  console.error("Missing CLOVER_API_TOKEN or CLOVER_MERCHANT_ID in kiosk-config.env.");
  process.exit(1);
}

const MIME = { ".html":"text/html; charset=utf-8", ".json":"application/json", ".png":"image/png", ".svg":"image/svg+xml", ".js":"text/javascript", ".css":"text/css" };
const send = (res, status, body, type) => { res.writeHead(status, { "Content-Type": type || "text/plain", "Cache-Control": "no-cache" }); res.end(body); };
const sendJSON = (res, status, obj) => send(res, status, JSON.stringify(obj), "application/json");
function sendFile(res, fp) {
  fs.readFile(fp, (err, data) => {
    if (err) return send(res, 404, "Not found");
    send(res, 200, data, MIME[path.extname(fp).toLowerCase()] || "application/octet-stream");
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ""; req.on("data", c => { b += c; if (b.length > 20000) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => resolve(b)); req.on("error", reject);
  });
}
async function cloverGet(p) {
  const r = await fetch(`${BASE}/v3/merchants/${MERCHANT_ID}${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`Clover GET ${p.split("?")[0]} -> ${r.status}`);
  return r.json();
}

// ---- local done-state (never leaves this PC) ----
let state = { done: {} };          // orderId -> epoch ms when marked done
try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); if (!state.done) state.done = {}; } catch {}
function saveState() {
  const cutoff = Date.now() - 48 * 3600000;
  for (const [id, t] of Object.entries(state.done)) if (t < cutoff) delete state.done[id];
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
function normalizeLine(li) {
  // Kiosk custom lines look like "Thirst Trap · Medium 24oz, Dr Pepper, Coconut"; Register lines carry real modifiers.
  let name = String(li.name || "Item").trim();
  let mods = (((li.modifications || {}).elements) || []).map(m => String(m.name || "").trim()).filter(Boolean);
  const sep = name.indexOf(" · ");
  if (sep > 0 && !mods.length) { mods = name.slice(sep + 3).split(",").map(s => s.trim()).filter(Boolean); name = name.slice(0, sep).trim(); }
  const itemId = li.item && li.item.id;
  const cat = itemId && catalog.byId[itemId] ? catalog.byId[itemId].category : (catalog.byName[name.toLowerCase()] || {}).category || "";
  const grab = cat.split(" / ").some(c => GRAB_CATS.has(c.toLowerCase()));
  return { name, mods, category: cat, kind: grab ? "grab" : "drink", note: String(li.note || "").trim(), price: li.price || 0 };
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
async function refreshQueue() {
  try {
    const since = Date.now() - LOOKBACK_MS;
    const r = await cloverGet(`/orders?filter=createdTime>=${since}&expand=lineItems,lineItems.modifications&orderBy=createdTime ASC&limit=100`);
    const orders = [];
    for (const o of (r.elements || [])) {
      const lines = (((o.lineItems || {}).elements) || []).filter(li => !li.exchanged && !li.refunded);
      if (!lines.length) continue;
      const items = groupLines(lines.map(normalizeLine));
      const who = parseCustomer(o);
      orders.push({
        id: o.id, ticket: o.id.slice(-4).toUpperCase(), created: o.createdTime, state: o.state || "",
        paid: (o.paymentState || "").toUpperCase() === "PAID", customer: who.name, source: who.source,
        total: o.total || 0, items, done: state.done[o.id] || 0
      });
    }
    queue = { orders, at: Date.now(), error: null };
  } catch (e) { queue = { ...queue, error: e.message, at: Date.now() }; console.error("queue refresh failed:", e.message); }
}

// ---- HTTP ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "GET" && (p === "/" || p === "/index.html")) return sendFile(res, path.join(__dirname, "make-station.html"));
  if (req.method === "GET" && (p === "/board" || p === "/board/")) return sendFile(res, path.join(__dirname, "pickup-board.html"));
  if (req.method === "GET" && p === "/recipes.json") return sendFile(res, path.join(__dirname, "recipes.json"));
  if (req.method === "GET" && p === "/addons.json") return sendFile(res, path.join(__dirname, "addons.json"));
  if (req.method === "GET" && p.startsWith("/assets/")) {
    const fp = path.normalize(path.join(__dirname, p));
    if (!fp.startsWith(path.join(__dirname, "assets"))) return send(res, 403, "Forbidden");
    return sendFile(res, fp);
  }
  if (req.method === "GET" && p === "/health") return sendJSON(res, 200, { ok: true, orders: queue.orders.length, catalogItems: Object.keys(catalog.byId).length, lastPoll: queue.at, error: queue.error });
  if (req.method === "GET" && p === "/queue") {
    const now = Date.now();
    const waiting = queue.orders.filter(o => !o.done);
    const ready   = queue.orders.filter(o => o.done && now - o.done < 30 * 60000).sort((a, b) => b.done - a.done).slice(0, 8);
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
  if (req.method === "POST" && (p === "/done" || p === "/undo")) {
    let body = {};
    try { body = JSON.parse(await readBody(req) || "{}"); } catch { return sendJSON(res, 400, { error: "bad json" }); }
    const id = String(body.id || "");
    if (!/^[A-Z0-9]{6,20}$/i.test(id)) return sendJSON(res, 400, { error: "bad id" });
    if (p === "/done") state.done[id] = Date.now(); else delete state.done[id];
    saveState();
    const o = queue.orders.find(x => x.id === id); if (o) o.done = state.done[id] || 0;
    return sendJSON(res, 200, { ok: true, id, done: !!state.done[id] });
  }
  send(res, 404, "Not found");
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
    for (const a of lanAddresses()) console.log(`  From the Echo Show: http://${a.split(" ")[0]}:${PORT}/   [${a}]`);
  });
})();
