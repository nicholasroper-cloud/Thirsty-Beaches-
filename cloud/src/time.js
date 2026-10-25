/* Wall-clock helpers for one IANA time zone (default America/Denver, override with OWNER_TZ).
   Cron triggers run in UTC; these turn UTC instants into local dates/hours and back, so
   "yesterday" and "8am" stay right across daylight-saving changes. */

export const ownerTz = env => (env && env.OWNER_TZ) || "America/Denver";

const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) fmtCache.set(tz, new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" }));
  return fmtCache.get(tz);
}

/* UTC ms -> { y, m, d, h, min, s, weekday: "Sun".."Sat", date: "YYYY-MM-DD" } in tz */
export function localParts(ms, tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  const r = { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute, s: +o.second, weekday: o.weekday };
  r.date = `${o.year}-${o.month}-${o.day}`;
  return r;
}

/* local wall time in tz -> UTC ms (for a time skipped by DST, lands just after the gap) */
export function zonedToUtc(y, m, d, h, min, tz) {
  const want = Date.UTC(y, m - 1, d, h, min);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = localParts(t, tz);
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
    const diff = want - seen;
    if (!diff) break;
    t += diff;
  }
  return t;
}

export const parseDay = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const chk = new Date(Date.UTC(y, mo - 1, d));
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
  return { y, m: mo, d };
};
export function addDays(day, n) {
  const p = parseDay(day);
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return t.toISOString().slice(0, 10);
}
/* [start, end) UTC ms of a local calendar day (23 or 25 hours long on DST days) */
export function dayRange(day, tz) {
  const a = parseDay(day), b = parseDay(addDays(day, 1));
  return [zonedToUtc(a.y, a.m, a.d, 0, 0, tz), zonedToUtc(b.y, b.m, b.d, 0, 0, tz)];
}
export const weekdayOf = day => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(day + "T12:00:00Z").getUTCDay()];
export const hourLabel = h => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
export function clockLabel(ms, tz) {
  const p = localParts(ms, tz);
  return `${p.h % 12 || 12}:${String(p.min).padStart(2, "0")} ${p.h < 12 ? "AM" : "PM"}`;
}
