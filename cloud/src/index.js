/* Thirsty Beaches Make Station — cloud edition (Cloudflare Worker).
   Same job as make-station-server.js, but nothing has to run in the trailer:
   the Worker reads Clover orders on demand, remembers which tickets are done
   in KV, and serves the station + pickup board pages from ./public.
   The Clover token lives only in the Worker's secrets. Every data route needs
   the STATION_KEY (X-Key header; ?k=... still works for one more release) so the ticket feed isn't public. With no
   STATION_KEY set the data routes refuse everyone (503), they never fall open.
   Exception, on purpose: the "Pay on my phone" routes in qr.js (/api/qr, /api/qr/<ref>, /r/<ref>)
   are public; they only ever reveal one order to whoever holds its random 8-character ref.
   Also public: "Order ahead" (/order page, /api/order-ahead, /api/control; see order-ahead.js). */

import { handleOrderAhead } from "./order-ahead.js";
import { handleQr } from "./qr.js";
import { cloverGet, getCatalog } from "./clover.js";
import { REPORT_CRON, runDailyReport, handleReport } from "./report.js";
import { MONITOR_CRON, runMonitor, handleMonitor } from "./monitor.js";
import { splitLine, authFailure, fetchOrders, seqMap, startOfDayMs, loadState, markDone, markPicked, markUndo, ticketGate } from "./ticket.js";
import { fetchKitchenExtras, redeemKitchenClaim, completeKitchenDrop, readStationStockOverlay, toggleStationStock, fetchPickupTags, matchTagPickup, fireOrderReady } from "./kitchen-sync.js";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const text = (s, status = 200) => new Response(s, { status, headers: { "content-type": "text/plain" } });

let memo = { orders: null, at: 0 };   // per-isolate cache to coalesce polling

function normalizeLine(li, catalog, grabCats) {
  const { name, mods, note } = splitLine(li);                 // add-ons come from the "MODS:" line note first (see ticket.js)
  const itemId = li.item && li.item.id;
  const cat = itemId && catalog.byId[itemId] ? catalog.byId[itemId].category : (catalog.byName[name.toLowerCase()] || {}).category || "";
  const grab = cat.split(" / ").some(c => grabCats.has(c.toLowerCase()));
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
  for (const li of (((o.lineItems || {}).elements) || [])) {              // "Pay on my phone" order (Clover Hosted Checkout)
    const q = String(li.note || "").match(/^KQ-[A-Z0-9]{8} · (.+)$/);
    const online = q && q[1].match(/^Online · (.+)$/);                  // "Order ahead" from the customer's own phone
    if (online) return { name: online[1].trim(), source: "Online" };
    if (q) return { name: q[1].trim() === "Kiosk" ? "" : q[1].trim(), source: "Kiosk" };
  }
  return { name: String(o.title || "").trim(), source: "Register" };
}

async function getOrders(env, st) {
  const stamp = o => ({ ...o, done: st.done[o.id] || 0, picked: st.picked[o.id] || 0 });
  if (memo.orders && Date.now() - memo.orders.at < 4000) return memo.orders.list.map(stamp);
  const catalog = await getCatalog(env);
  const grabCats = new Set((env.GRAB_CATEGORIES || "Treats").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
  const lookback = Date.now() - Math.max(1, parseFloat(env.MAKE_LOOKBACK_HOURS || "16")) * 3600000;
  const raw = await fetchOrders(env, Math.min(lookback, startOfDayMs(env)));     // far enough back to rank today's orders too
  const seqs = seqMap(env, raw);                                                  // daily numbers: 101, 102, ... (the Clover id stays the key)
  const list = [];
  for (const o of raw) {
    const lines = (((o.lineItems || {}).elements) || []).filter(li => !li.exchanged && !li.refunded);
    if (!lines.length || o.createdTime < lookback) continue;
    const gate = ticketGate(o, (env.KIOSK_ORDER_TYPE_ID || "").trim());
    if (!gate.show) continue;                                                      // TBK:PENDING and shell orders never reach the make screen or the board
    const who = parseCustomer(o);
    list.push({ id: o.id, ticket: String(seqs.get(o.id)), seq: seqs.get(o.id), ref: o.id.slice(-4).toUpperCase(), created: o.createdTime, state: o.state || "",
      paid: gate.paid !== undefined ? gate.paid : (o.paymentState || "").toUpperCase() === "PAID", badge: gate.badge || null, customer: who.name, source: who.source, total: o.total || 0,
      orderNote: String(o.note || "").slice(0, 160),
      items: groupLines(lines.map(li => normalizeLine(li, catalog, grabCats))) });
  }
  const pickups = await fetchPickupTags(env);
  for (const ord of list) {
    const tp = matchTagPickup(ord, pickups);
    if (tp) ord.tagPickup = tp;
  }
  memo.orders = { list, at: Date.now() };
  return list.map(stamp);
}

/* CORS for GET /api/report: only the owner app's origin; the STATION_KEY (X-Key header or ?k=) is still required. */
const OWNER_ORIGINS = new Set(["https://nicholasroper-cloud.github.io"]);
function reportCors(req) {
  const o = req.headers.get("origin") || "";
  if (!OWNER_ORIGINS.has(o)) return { vary: "Origin" };
  return { "access-control-allow-origin": o, "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "X-Key, Content-Type",
    "access-control-max-age": "600", vary: "Origin" };
}
/* null = allowed. Fails closed: no STATION_KEY configured means 503 for everyone, a wrong or missing key is 401. */
async function denied(req, env) {
  const f = await authFailure(req, env);
  return f ? json({ error: f.error }, f.status) : null;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/health") {
      return json({ ok: true, cloud: true, version: env.PAGE_VERSION || "1", keyRequired: !!env.STATION_KEY });
    }
    if (p === "/api/order-ahead" || p === "/api/control") {     // public: "Order ahead" switch + sold-out list (order-ahead.js)
      const res = await handleOrderAhead(req, env, url);
      if (res) return res;
    }
    if (p === "/api/qr" || p.startsWith("/api/qr/") || p.startsWith("/r/")) {   // public: phone pay + tracker
      const res = await handleQr(req, env, url);
      if (res) return res;
    }
    if (p === "/api/report") {                                  // owner: daily sales numbers (report.js)
      // The owner app (GitHub Pages) reads this from the browser with the key in the X-Key header.
      const ownerCors = OWNER_ORIGINS.has(req.headers.get("origin") || "");
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: reportCors(req) });
      const res = (await denied(req, env)) || await handleReport(req, env, url);
      if (!ownerCors) return res;
      const h = new Headers(res.headers); for (const [k, v] of Object.entries(reportCors(req))) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    }
    if (p === "/api/monitor") {                                 // owner: site monitoring state (monitor.js)
      const no = await denied(req, env); if (no) return no;
      return handleMonitor(req, env, url);
    }
    if (p === "/api/kitchen/extras" || p === "/api/kitchen/redeem" || p === "/api/kitchen/drop-complete" || p === "/api/stock" || p === "/api/stock/toggle") {
      const no = await denied(req, env); if (no) return no;
      if (p === "/api/kitchen/extras" && req.method === "GET") return json(await fetchKitchenExtras(env));
      if (p === "/api/stock" && req.method === "GET") return json(await readStationStockOverlay(env));
      if (req.method !== "POST") return json({ error: "method" }, 405);
      if (!/^application\/json\b/i.test(req.headers.get("content-type") || "")) return json({ error: "json only" }, 415);
      let body = {};
      try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      if (p === "/api/kitchen/redeem") { const r = await redeemKitchenClaim(env, body); return json(r.body, r.status); }
      if (p === "/api/kitchen/drop-complete") { const r = await completeKitchenDrop(env, body); return json(r.body, r.status); }
      if (p === "/api/stock/toggle") { const r = await toggleStationStock(env, body); return json(r.body, r.status); }
    }
    if (p === "/queue" || p === "/done" || p === "/undo" || p === "/pickedup") {
      const no = await denied(req, env); if (no) return no;
      if (req.method === "POST" && (p === "/done" || p === "/undo" || p === "/pickedup")) {
        // JSON only: a form or text/plain cross-site POST would skip the preflight
        if (!/^application\/json\b/i.test(req.headers.get("content-type") || "")) return json({ error: "json only" }, 415);
        let body = {};
        try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
        const id = String((body && body.id) || "");
        if (!/^[A-Z0-9]{6,20}$/i.test(id)) return json({ error: "bad id" }, 400);
        let st = await loadState(env);
        if (p === "/done") {
          await markDone(env, id);
          st = { ...st, done: { ...st.done, [id]: Date.now() } };
          const hit = memo.orders && memo.orders.list.find(x => x.id === id);
          const readyPayload = hit
            ? { ...hit, tagPickup: hit.tagPickup || (body.tagId ? { id: body.tagId } : null) }
            : { id, ticket: body.ticket || id.slice(-4).toUpperCase(), customer: body.customer || "", source: body.source || "", tagPickup: body.tagId ? { id: body.tagId } : null };
          const job = fireOrderReady(env, readyPayload).catch(() => {});
          if (ctx && ctx.waitUntil) ctx.waitUntil(job);
        }
        else if (p === "/undo") { await markUndo(env, id); }
        else { if (!st.done[id]) return json({ error: "not made yet" }, 409); await markPicked(env, id); }
        st = await loadState(env);
        return json({ ok: true, id, done: !!st.done[id], picked: !!st.picked[id] });
      }
      const st = await loadState(env);
      const done = st.done;
      let orders = [], error = null;
      try { orders = await getOrders(env, st); } catch (e) { error = e.message; }
      const now = Date.now();
      const waiting = orders.filter(o => !o.done);
      const ready = orders.filter(o => o.done && !o.picked && now - o.done < 30 * 60000).sort((a, b) => b.done - a.done).slice(0, 8);
      const today = new Date(now).toDateString();
      const doneToday = orders.filter(o => o.done && new Date(o.done).toDateString() === today);
      const madeToday = Object.values(done).filter(t => new Date(t).toDateString() === today).length;
      const secs = doneToday.map(o => (o.done - o.created) / 1000).filter(x => x > 0 && x < 4 * 3600);
      const avgSec = secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length) : 0;
      const tally = {}; for (const o of doneToday) for (const it of o.items) if (it.kind === "drink") tally[it.name] = (tally[it.name] || 0) + it.qty;
      const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));
      const byHour = {}; for (const o of doneToday) { const h = new Date(o.done).getHours(); byHour[h] = (byHour[h] || 0) + 1; }
      const busiest = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0];
      return json({ now, pageVer: env.PAGE_VERSION || "1", lastPoll: memo.orders ? memo.orders.at : now, error, waiting, ready, madeToday,
        today: { made: madeToday, avgSec, top, busiestHour: busiest ? +busiest[0] : null, busiestCount: busiest ? busiest[1] : 0 } });
    }
    // everything else: the static pages + files in ./public
    let areq = req;
    if (p === "/board" || p === "/board/") areq = new Request(new URL("/board.html", req.url), req);
    if (p === "/order" || p === "/order/") areq = new Request(new URL("/order.html", req.url), req);
    const res = await env.ASSETS.fetch(areq);
    if (res.status === 404) return text("Not found", 404);
    const h = new Headers(res.headers); h.set("cache-control", "no-cache");
    return new Response(res.body, { status: res.status, headers: h });
  },

  // Cron triggers (wrangler.toml [triggers]). Each job is a no-op until its settings exist.
  async scheduled(event, env, ctx) {
    const jobs = [];
    if (event.cron === REPORT_CRON) jobs.push(runDailyReport(env, event.scheduledTime || Date.now()).then(r => console.log("daily report", JSON.stringify(r))));
    if (event.cron === MONITOR_CRON) jobs.push(runMonitor(env, event.scheduledTime || Date.now()).then(r => { if (r.changes && r.changes.length) console.log("monitor", JSON.stringify(r)); }));
    await Promise.all(jobs.map(j => j.catch(e => console.error("cron job failed", event.cron, e && e.message))));
  }
};
