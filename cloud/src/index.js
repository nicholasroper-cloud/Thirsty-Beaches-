/* Thirsty Beaches Make Station — cloud edition (Cloudflare Worker).
   Same job as make-station-server.js, but nothing has to run in the trailer:
   the Worker reads Clover orders on demand, remembers which tickets are done
   in KV, and serves the station + pickup board pages from ./public.
   The Clover token lives only in the Worker's secrets. Every data route needs
   the STATION_KEY (as ?k=... or X-Key header) so the ticket feed isn't public. */

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const text = (s, status = 200) => new Response(s, { status, headers: { "content-type": "text/plain" } });

let memo = { orders: null, at: 0, catalog: null, catAt: 0 };   // per-isolate cache to coalesce polling

async function cloverGet(env, p) {
  const r = await fetch(`${env.CLOVER_BASE_URL || "https://api.clover.com"}/v3/merchants/${env.CLOVER_MERCHANT_ID}${p}`,
    { headers: { Authorization: `Bearer ${env.CLOVER_API_TOKEN}` } });
  if (!r.ok) throw new Error(`Clover ${p.split("?")[0]} -> ${r.status}`);
  return r.json();
}

async function getCatalog(env) {
  if (memo.catalog && Date.now() - memo.catAt < 10 * 60000) return memo.catalog;
  const cached = await env.STATE.get("catalog", "json");
  if (cached && Date.now() - (cached.at || 0) < 10 * 60000) { memo.catalog = cached; memo.catAt = cached.at; return cached; }
  const byId = {}, byName = {};
  let offset = 0;
  while (offset < 2000) {
    const r = await cloverGet(env, `/items?expand=categories&limit=500&offset=${offset}`);
    const els = (r && r.elements) || [];
    for (const it of els) {
      const cat = (((it.categories || {}).elements) || []).map(c => c.name).join(" / ");
      byId[it.id] = { name: it.name, category: cat };
      byName[String(it.name || "").toLowerCase()] = { id: it.id, category: cat };
    }
    if (els.length < 500) break;
    offset += 500;
  }
  const cat = { byId, byName, at: Date.now() };
  memo.catalog = cat; memo.catAt = cat.at;
  await env.STATE.put("catalog", JSON.stringify(cat), { expirationTtl: 3600 });
  return cat;
}

function normalizeLine(li, catalog, grabCats) {
  let name = String(li.name || "Item").trim();
  let mods = (((li.modifications || {}).elements) || []).map(m => String(m.name || "").trim()).filter(Boolean);
  const sep = name.indexOf(" · ");
  if (sep > 0 && !mods.length) { mods = name.slice(sep + 3).split(",").map(s => s.trim()).filter(Boolean); name = name.slice(0, sep).trim(); }
  const itemId = li.item && li.item.id;
  const cat = itemId && catalog.byId[itemId] ? catalog.byId[itemId].category : (catalog.byName[name.toLowerCase()] || {}).category || "";
  const grab = cat.split(" / ").some(c => grabCats.has(c.toLowerCase()));
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
  return { name: String(o.title || "").trim(), source: "Register" };
}

async function getOrders(env, done) {
  if (memo.orders && Date.now() - memo.orders.at < 4000) return memo.orders.list.map(o => ({ ...o, done: done[o.id] || 0 }));
  const catalog = await getCatalog(env);
  const grabCats = new Set((env.GRAB_CATEGORIES || "Treats").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
  const since = Date.now() - Math.max(1, parseFloat(env.MAKE_LOOKBACK_HOURS || "16")) * 3600000;
  const r = await cloverGet(env, `/orders?filter=createdTime>=${since}&expand=lineItems,lineItems.modifications&orderBy=createdTime ASC&limit=100`);
  const list = [];
  for (const o of (r.elements || [])) {
    const lines = (((o.lineItems || {}).elements) || []).filter(li => !li.exchanged && !li.refunded);
    if (!lines.length) continue;
    const who = parseCustomer(o);
    list.push({ id: o.id, ticket: o.id.slice(-4).toUpperCase(), created: o.createdTime, state: o.state || "",
      paid: (o.paymentState || "").toUpperCase() === "PAID", customer: who.name, source: who.source, total: o.total || 0,
      items: groupLines(lines.map(li => normalizeLine(li, catalog, grabCats))) });
  }
  memo.orders = { list, at: Date.now() };
  return list.map(o => ({ ...o, done: done[o.id] || 0 }));
}

async function getDone(env) { return (await env.STATE.get("done", "json")) || {}; }
async function putDone(env, done) {
  const cutoff = Date.now() - 48 * 3600000;
  for (const [id, t] of Object.entries(done)) if (t < cutoff) delete done[id];
  await env.STATE.put("done", JSON.stringify(done));
}

function authorized(req, env) {
  if (!env.STATION_KEY) return true;                        // no key configured = open (not recommended)
  const url = new URL(req.url);
  const k = url.searchParams.get("k") || req.headers.get("x-key") || "";
  return k === env.STATION_KEY;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/health") {
      return json({ ok: true, cloud: true, version: env.PAGE_VERSION || "1", keyRequired: !!env.STATION_KEY });
    }
    if (p === "/queue" || p === "/done" || p === "/undo") {
      if (!authorized(req, env)) return json({ error: "key required" }, 401);
      let done = await getDone(env);
      if (req.method === "POST" && (p === "/done" || p === "/undo")) {
        let body = {};
        try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
        const id = String(body.id || "");
        if (!/^[A-Z0-9]{6,20}$/i.test(id)) return json({ error: "bad id" }, 400);
        if (p === "/done") done[id] = Date.now(); else delete done[id];
        await putDone(env, done);
        return json({ ok: true, id, done: !!done[id] });
      }
      let orders = [], error = null;
      try { orders = await getOrders(env, done); } catch (e) { error = e.message; }
      const now = Date.now();
      const waiting = orders.filter(o => !o.done);
      const ready = orders.filter(o => o.done && now - o.done < 30 * 60000).sort((a, b) => b.done - a.done).slice(0, 8);
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
    const res = await env.ASSETS.fetch(areq);
    if (res.status === 404) return text("Not found", 404);
    const h = new Headers(res.headers); h.set("cache-control", "no-cache");
    return new Response(res.body, { status: res.status, headers: h });
  }
};
