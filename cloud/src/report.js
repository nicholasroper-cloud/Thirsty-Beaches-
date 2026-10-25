/* Daily sales report for Nick.
   Cron "30 13,14 * * *" (UTC) runs twice each morning; whichever run is first at or after
   REPORT_HOUR (default 7) local time sends yesterday's numbers, so it lands at 7:30 am Denver
   time both in summer (13:30 UTC) and winter (14:30 UTC). A KV marker stops a second send.
   GET /api/report?day=YYYY-MM-DD (STATION_KEY) returns the same numbers as JSON; add &send=1
   to also push it (handy to test the notification setup).
   Dormant until a notify channel (see notify.js) exists; REPORT_ENABLED = "0" switches it off.
   Counting rules: only orders Clover marks PAID (or PARTIALLY_REFUNDED); refunded/exchanged
   lines are left out; gross = line prices + modifier prices, before tax, discounts and tips;
   each Clover line counts as one item (the kiosk and phone pay send one line per drink). */
import { cloverGet, getCatalog } from "./clover.js";
import { notify, notifyConfigured, notifyChannels } from "./notify.js";
import { ownerTz, localParts, dayRange, addDays, parseDay, weekdayOf, hourLabel } from "./time.js";

export const REPORT_CRON = "30 13,14 * * *";
const PAGE = 500;
const PAID_STATES = new Set(["PAID", "PARTIALLY_REFUNDED"]);
const money = c => "$" + (Math.round(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const pct = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
const signed = n => (n > 0 ? "+" : n < 0 ? "−" : "±") + Math.abs(n) + "%";

async function dayOrders(env, start, end) {
  const out = [];
  for (let offset = 0; offset < 20000; offset += PAGE) {
    const r = await cloverGet(env, `/orders?filter=createdTime>=${start}&filter=createdTime<${end}` +
      `&expand=lineItems,lineItems.modifications,payments&orderBy=createdTime ASC&limit=${PAGE}&offset=${offset}`);
    const els = (r && r.elements) || [];
    out.push(...els);
    if (els.length < PAGE) break;
  }
  return out.filter(o => o.createdTime >= start && o.createdTime < end);   // belt and braces
}

function source(o, lines) {
  if (lines.some(li => String(li.note || "").includes("KQ-"))) return "phone";
  if (/kiosk order/i.test(String(o.note || ""))) return "kiosk";
  return "other";
}
const baseName = n => { const s = String(n || "Item").trim(), i = s.indexOf(" · "); return i > 0 ? s.slice(0, i).trim() : s; };

/* Pure: Clover orders -> numbers. catalog/grabCats decide drink vs treat (optional). */
export function summarize(orders, tz, catalog, grabCats) {
  const s = { orders: 0, items: 0, drinks: 0, grossCents: 0, tipsCents: 0, sources: { kiosk: 0, phone: 0, other: 0 }, byHour: {}, tally: {} };
  for (const o of orders) {
    if (!PAID_STATES.has(String(o.paymentState || "").toUpperCase())) continue;
    const all = ((o.lineItems || {}).elements) || [];
    const lines = all.filter(li => !li.refunded && !li.exchanged);
    if (!lines.length) continue;
    s.orders++;
    s.sources[source(o, all)]++;
    const h = localParts(o.createdTime, tz).h;
    s.byHour[h] = (s.byHour[h] || 0) + 1;
    for (const li of lines) {
      const mods = ((li.modifications || {}).elements) || [];
      s.grossCents += (+li.price || 0) + mods.reduce((a, m) => a + (+m.amount || 0), 0);
      const name = baseName(li.name);
      s.items++;
      let cat = "";
      if (catalog) {
        const id = li.item && li.item.id;
        cat = id && catalog.byId[id] ? catalog.byId[id].category : (catalog.byName[name.toLowerCase()] || {}).category || "";
      }
      const grab = grabCats && cat.split(" / ").some(c => grabCats.has(c.toLowerCase()));
      if (!grab) s.drinks++;
      s.tally[name] = (s.tally[name] || 0) + 1;
    }
    for (const p of ((o.payments || {}).elements) || [])
      if (String(p.result || "SUCCESS").toUpperCase() === "SUCCESS") s.tipsCents += +p.tipAmount || 0;
  }
  s.top = Object.entries(s.tally).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([name, count]) => ({ name, count }));
  delete s.tally;
  const busy = Object.entries(s.byHour).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  s.busiestHour = busy ? { hour: +busy[0], label: hourLabel(+busy[0]), orders: busy[1] } : null;
  s.avgTicketCents = s.orders ? Math.round(s.grossCents / s.orders) : 0;
  return s;
}

function prettyDay(day) {
  const p = parseDay(day);
  return `${weekdayOf(day)} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][p.m - 1]} ${p.d}`;
}

export function reportMessage(r) {
  if (!r.orders) return { title: `Thirsty Beaches · ${prettyDay(r.day)}`, body: "No sales yesterday." };
  const lines = [
    `${r.orders} order${r.orders === 1 ? "" : "s"} · ${r.drinks} drink${r.drinks === 1 ? "" : "s"} · avg ticket ${money(r.avgTicketCents)}` +
      (r.tipsCents ? ` · tips ${money(r.tipsCents)}` : ""),
    "Top: " + r.top.map(t => `${t.name} ×${t.count}`).join(", "),
    r.busiestHour ? `Busiest: ${r.busiestHour.label} (${r.busiestHour.orders} order${r.busiestHour.orders === 1 ? "" : "s"})` : "",
    `Kiosk ${r.sources.kiosk} · Phone/QR ${r.sources.phone} · Register/other ${r.sources.other}`,
    r.vsLastWeek.ordersPct === null
      ? `vs last ${weekdayOf(r.day)}: no sales that day`
      : `vs last ${weekdayOf(r.day)}: orders ${signed(r.vsLastWeek.ordersPct)}, sales ${signed(r.vsLastWeek.grossPct)} (${r.lastWeek.orders} orders, ${money(r.lastWeek.grossCents)})`,
  ].filter(Boolean);
  return { title: `Thirsty Beaches · ${prettyDay(r.day)}: ${money(r.grossCents)}`, body: lines.join("\n") };
}

export async function buildReport(env, day) {
  const tz = ownerTz(env);
  const grabCats = new Set((env.GRAB_CATEGORIES || "Treats").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
  let catalog = null;
  try { catalog = await getCatalog(env); } catch (e) { console.warn("report: no catalog, counting every item as a drink", e.message); }
  const prev = addDays(day, -7);
  const [[a0, a1], [b0, b1]] = [dayRange(day, tz), dayRange(prev, tz)];
  const [cur, old] = await Promise.all([dayOrders(env, a0, a1), dayOrders(env, b0, b1)]);
  const s = summarize(cur, tz, catalog, grabCats), p = summarize(old, tz, catalog, grabCats);
  const r = { day, tz, from: a0, to: a1, ...s, gross: money(s.grossCents), avgTicket: money(s.avgTicketCents),
    lastWeek: { day: prev, orders: p.orders, grossCents: p.grossCents, drinks: p.drinks },
    vsLastWeek: { ordersPct: pct(s.orders, p.orders), grossPct: pct(s.grossCents, p.grossCents) } };
  r.message = reportMessage(r);
  return r;
}

const reportOn = env => env.REPORT_ENABLED !== "0" && notifyConfigured(env) && !!env.CLOVER_API_TOKEN;

/* Cron entry. Returns what it did (for logs/tests). Makes no request at all while dormant. */
export async function runDailyReport(env, now = Date.now()) {
  if (!reportOn(env)) return { skipped: "not configured" };
  const tz = ownerTz(env);
  const local = localParts(now, tz);
  const hour = Math.min(23, Math.max(0, parseInt(env.REPORT_HOUR || "7", 10) || 7));
  if (local.h < hour) return { skipped: "too early", local: local.date + " " + local.h + "h" };
  const day = addDays(local.date, -1);
  const mark = "report:sent:" + day;
  if (await env.STATE.get(mark)) return { skipped: "already sent", day };
  const r = await buildReport(env, day);
  if (!r.orders && env.REPORT_EMPTY !== "true") {
    await env.STATE.put(mark, "empty", { expirationTtl: 3 * 86400 });
    return { skipped: "no orders", day };
  }
  const errs = await notify(env, { ...r.message, priority: "low", tags: ["bar_chart"] });
  const channels = notifyChannels(env).length;
  if (errs.length < channels) await env.STATE.put(mark, String(now), { expirationTtl: 3 * 86400 });   // all failed: next run retries
  return { sent: errs.length < channels, day, errors: errs, orders: r.orders };
}

/* GET /api/report?day=YYYY-MM-DD[&send=1]; the caller has already checked STATION_KEY. */
export async function handleReport(req, env, url) {
  const json = (o, st = 200) => new Response(JSON.stringify(o, null, 2), { status: st, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  if (req.method !== "GET") return json({ error: "method" }, 405);
  if (!env.CLOVER_API_TOKEN) return json({ error: "CLOVER_API_TOKEN not set" }, 503);
  const tz = ownerTz(env);
  const day = url.searchParams.get("day") || addDays(localParts(Date.now(), tz).date, -1);
  if (!parseDay(day)) return json({ error: "day must be YYYY-MM-DD" }, 400);
  let r;
  try { r = await buildReport(env, day); } catch (e) { return json({ error: e.message }, 502); }
  if (url.searchParams.get("send") === "1") r.notifyErrors = await notify(env, { ...r.message, priority: "low", tags: ["bar_chart"] });
  return json(r);
}
