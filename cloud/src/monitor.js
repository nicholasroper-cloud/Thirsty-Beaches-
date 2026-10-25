/* Site monitoring for Nick. Every 5 minutes (MONITOR_CRON) it checks the sites below and messages only when
   something CHANGES: "down" after 2 failed checks in a row, "back up" once it recovers, never more
   than one message per target per 30 min (a flapping site waits, then reports where it settled).
   State lives in the STATE KV under "mon:state" and is only written when something changed.
   Kiosk heartbeat (tb-where /kiosk/status): 404 = not set up yet (never alerts); "down" when the
   kiosk has been offline more than 15 min inside KIOSK_HOURS (e.g. "08-21", local time; default
   always), counting from when the hours opened, so a kiosk that is off overnight is fine.
   Dormant until a notify channel exists (notify.js); MONITOR_ENABLED = "0" switches it off.
   GET /api/monitor (STATION_KEY) shows the current state; &run=1 runs a check now. */
import { cloverGet } from "./clover.js";
import { notify, notifyConfigured, notifyChannels } from "./notify.js";
import { ownerTz, localParts, zonedToUtc, clockLabel } from "./time.js";

export const MONITOR_CRON = "*/5 * * * *";
const KEY = "mon:state";
const TIMEOUT_MS = 10000;
const FAILS_FOR_DOWN = 2;
const ALERT_GAP_MS = 30 * 60000;
const KIOSK_OFFLINE_MS = 15 * 60000;
const WHERE = "https://tb-where.nicholasroper.workers.dev";

const textHas = word => (r, body) => (body.includes(word) ? null : `page loaded but "${word}" is missing`);
const jsonWith = test => (r, body) => {
  let d; try { d = JSON.parse(body); } catch { return "not JSON"; }
  return test(d);
};
export const TARGETS = [
  { id: "tb-site", name: "thirstybeaches.com", url: "https://thirstybeaches.com/", check: textHas("Thirsty") },
  { id: "sdt-site", name: "saltydogtags.com", url: "https://saltydogtags.com/", check: textHas("Salty") },
  { id: "sdt-pay", name: "Salty Dog Tags checkout", url: "https://saltydogtags.com/api/config",
    check: jsonWith(d => (d && d.pay === true ? null : "pay is not true in /api/config")) },
  { id: "tb-where", name: "Trailer locator (tb-where)", url: WHERE + "/where", check: jsonWith(() => null) },
];

async function get(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { "user-agent": "ThirstyBeaches-Monitor/1", accept: "*/*" }, redirect: "follow",
      cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await r.text();
    return { r, body, ms: Date.now() - t0 };
  } catch (e) {
    const name = e && (e.name || "");
    const err = name === "TimeoutError" || name === "AbortError" ? `timeout after ${TIMEOUT_MS / 1000}s` : `network error: ${String(e && e.message || e).slice(0, 80)}`;
    return { err, ms: Date.now() - t0 };
  }
}

/* -> { ok:true } | { ok:false, err } | { skip:"note" } (not checked / no change) */
async function checkUrl(t) {
  const g = await get(t.url);
  if (g.err) return { ok: false, err: g.err };
  if (g.r.status !== 200) return { ok: false, err: `HTTP ${g.r.status}` };
  const why = t.check(g.r, g.body);
  return why ? { ok: false, err: why } : { ok: true };
}

/* The station itself: its static pages (ASSETS) and its line to Clover. A Worker can't usefully
   fetch its own hostname, so this checks the parts from inside. If the whole Worker were down this
   cron wouldn't run either; the other targets (and Cloudflare's own alerts) cover that. */
async function checkStation(env) {
  try {
    const r = await env.ASSETS.fetch(new Request("https://station.internal/"));
    if (r.status !== 200) return { ok: false, err: `station page HTTP ${r.status}` };
    await r.arrayBuffer();
  } catch (e) { return { ok: false, err: "station page error: " + String(e && e.message).slice(0, 80) }; }
  return { ok: true };
}
async function checkClover(env) {
  try { await cloverGet(env, "/orders?limit=1"); return { ok: true }; }
  catch (e) { return { ok: false, err: String(e && e.message || e).slice(0, 100) }; }   // e.g. "Clover /orders -> 401"
}

export function parseHours(s) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(String(s || ""));
  if (!m) return null;
  const a = +m[1] * 60 + +(m[2] || 0), b = +m[3] * 60 + +(m[4] || 0);
  if (a > 1440 || b > 1440 || a === b) return null;
  return { a, b };
}
/* null = no hours set (always on). Otherwise { open, openedAt } (openedAt = when this window opened). */
export function hoursState(env, now) {
  const h = parseHours(env.KIOSK_HOURS);
  if (!h) return null;
  const tz = ownerTz(env), p = localParts(now, tz), mins = p.h * 60 + p.min;
  const at = (dayShift, m) => { const d = new Date(Date.UTC(p.y, p.m - 1, p.d + dayShift)); return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), Math.floor(m / 60), m % 60, tz); };
  if (h.a < h.b) return mins >= h.a && mins < h.b ? { open: true, openedAt: at(0, h.a) } : { open: false };
  if (mins >= h.a) return { open: true, openedAt: at(0, h.a) };               // window over midnight, e.g. "18-02"
  if (mins < h.b) return { open: true, openedAt: at(-1, h.a) };
  return { open: false };
}

const toMs = v => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const n = Number(v); if (isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(v); return isFinite(t) ? t : null;
};

/* Kiosk: -> { ok:true } | { kioskOffline:true, lastSeen, version } | { skip } */
async function checkKiosk(now) {
  const g = await get(WHERE + "/kiosk/status");
  if (g.err) return { skip: "kiosk status unreachable: " + g.err };
  if (g.r.status === 404) return { skip: "not set up yet", notSetUp: true };
  if (g.r.status !== 200) return { skip: `kiosk status HTTP ${g.r.status}` };
  let d; try { d = JSON.parse(g.body); } catch { return { skip: "kiosk status not JSON" }; }
  const lastSeen = toMs(d && d.lastSeen);
  const stale = lastSeen != null && now - lastSeen > KIOSK_OFFLINE_MS;
  if (d && d.online !== false && !stale) return { ok: true, version: d.version };
  return { kioskOffline: true, lastSeen, version: d && d.version };
}

const ago = ms => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

export async function runMonitor(env, now = Date.now()) {
  if (env.MONITOR_ENABLED === "0" || !notifyConfigured(env)) return { skipped: "not configured" };
  const tz = ownerTz(env);
  const prev = (await env.STATE.get(KEY, "json")) || { t: {} };
  const state = JSON.parse(JSON.stringify(prev));
  state.t = state.t || {};

  const jobs = TARGETS.map(t => checkUrl(t).then(res => [t.id, t.name, res]));
  jobs.push(checkStation(env).then(res => ["station", "Station pages", res]));
  if (env.CLOVER_API_TOKEN) jobs.push(checkClover(env).then(res => ["clover", "Station → Clover API", res]));
  jobs.push(checkKiosk(now).then(res => ["kiosk", "Drink kiosk", res]));
  const results = await Promise.all(jobs);

  const changes = [];
  for (const [id, name, res] of results) {
    const st = state.t[id] || (state.t[id] = { up: true, fails: 0 });
    let want = st.up;
    if (id === "kiosk") {
      if (res.notSetUp) { st.setup = false; continue; }
      if (res.skip) continue;                                          // can't tell; the tb-where target covers that host
      st.setup = true;
      if (res.ok) { want = true; delete st.offSince; }
      else {
        if (!st.offSince) st.offSince = res.lastSeen || now;
        const hrs = hoursState(env, now);
        const from = Math.max(st.offSince, hrs && hrs.open ? hrs.openedAt : 0);
        if ((!hrs || hrs.open) && now - from > KIOSK_OFFLINE_MS) want = false;
        st.err = "offline" + (res.lastSeen ? `, last seen ${clockLabel(res.lastSeen, tz)}` : "");
      }
    } else if (res.ok) { st.fails = 0; want = true; }
    else {
      st.fails = (st.fails || 0) + 1;
      st.err = res.err;
      if (st.fails === 1) st.failSince = now;
      if (st.fails >= FAILS_FOR_DOWN) want = false;
    }
    if (want !== st.up && now - (st.alertAt || 0) >= ALERT_GAP_MS) {
      changes.push({ id, name, up: want, err: st.err, since: want ? st.downAt : (id === "kiosk" ? st.offSince : st.failSince), fails: st.fails });
      st.up = want; st.alertAt = now;
      if (!want) st.downAt = id === "kiosk" ? st.offSince : st.failSince;
    }
    if (res.ok && st.up) { delete st.err; delete st.failSince; delete st.downAt; }   // fully recovered and announced
  }

  let errors = [];
  if (changes.length) {
    const lines = changes.map(c => c.up
      ? `✅ ${c.name} is back up` + (c.since ? ` (down ${ago(now - c.since)})` : "")
      : `🔴 ${c.name} is DOWN: ${c.err}` + (c.id === "kiosk" ? "" : ` (${c.fails} checks in a row, since ${clockLabel(c.since || now, tz)})`));
    const downs = changes.filter(c => !c.up);
    const title = changes.length === 1 ? `${changes[0].up ? "Back up" : "Down"}: ${changes[0].name}`
      : downs.length === changes.length ? `${downs.length} sites down` : downs.length ? `${downs.length} down, ${changes.length - downs.length} back up` : `${changes.length} sites back up`;
    const one = changes.length === 1 ? TARGETS.find(t => t.id === changes[0].id) : null;
    errors = await notify(env, { title, body: lines.join("\n"), priority: downs.length ? "high" : "normal",
      tags: [downs.length ? "rotating_light" : "white_check_mark"], ...(one ? { click: one.url } : {}) });
    if (errors.length >= notifyChannels(env).length) {                  // nothing got through: try again next run
      for (const c of changes) { const st = state.t[c.id], old = (prev.t || {})[c.id] || { up: true }; st.up = old.up; st.alertAt = old.alertAt; if (old.downAt) st.downAt = old.downAt; else delete st.downAt; }
    }
  }
  if (JSON.stringify(state) !== JSON.stringify(prev)) await env.STATE.put(KEY, JSON.stringify(state));
  return { checked: results.map(([id, , r]) => [id, r.ok ? "ok" : r.skip ? "skip: " + r.skip : r.kioskOffline ? "offline" : r.err]), changes, errors };
}

/* GET /api/monitor[?run=1]; the caller has already checked STATION_KEY. */
export async function handleMonitor(req, env, url) {
  const json = (o, st = 200) => new Response(JSON.stringify(o, null, 2), { status: st, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const configured = env.MONITOR_ENABLED !== "0" && notifyConfigured(env);
  const run = url.searchParams.get("run") === "1" && configured ? await runMonitor(env) : null;
  return json({ configured, channels: notifyChannels(env), kioskHours: env.KIOSK_HOURS || "always", run, state: (await env.STATE.get(KEY, "json")) || null });
}
