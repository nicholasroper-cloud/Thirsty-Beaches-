/* Prize-to-phone link: lets a customer who won an arcade prize (a 4-character Kitchen Board claim issued by tb-where) attach it to a phone
   number, so a LATER order (kiosk now; phone-order page or window later) can find it by typing that number.

   THIS IS PRIZE LOOKUP ONLY. It is not marketing consent, it never joins a text or email list, and it sends nothing. It is kept apart
   from the kiosk's "Tide list" sign-up (tb-where /subscribe + consent/sms-consent-kiosk-v1.txt) on purpose: different storage, different purpose.

     POST /api/prize-link/save    {phone, code}  -> {ok:true, keptUntil} | {ok:true, already:true, keptUntil} | {ok:false, error}
     POST /api/prize-link/lookup  {phone}        -> {ok:true, found:false} | {ok:true, found:true, code, prizeId, label, expiresAt} | {ok:false, error}
     POST /api/prize-link/clear   {code}         -> {ok:true}   (idempotent)
   All three need the STATION_KEY (index.js gate), JSON bodies only.

   What is stored (KV STATE): pz:<HMAC> = {code, prizeId, label, expiresAt, at} and the reverse index pzc:<code> = <HMAC>, both with a TTL
   that ends when the claim does. <HMAC> = HMAC-SHA256(PRIZE_PHONE_KEY, "tb-prize-phone|+1" + 10 digits (E.164)). The raw number is never stored, logged
   or returned, and neither is the hash. PRIZE_PHONE_KEY is a Worker secret (>= 32 chars); without it the feature is off (503 prize-link-off).
   The prize itself (id, label, expiry, still unredeemed) is always re-read from tb-where (/kitchen/claims/redeem with checkOnly), never taken
   from the caller. One unredeemed prize per number; a new win never replaces a saved one ("already-have"). */
import { whereOrigin, whereHeaders, fetchJsonTimeout } from "./kitchen-sync.js";

/* Must match arcade-routes.js PRIZES (isPrize:true) in the kiosk server: the only prize ids a link may carry. */
export const LINK_PRIZE_IDS = ["size_upgrade", "soft_serve_topper", "neon_charm", "topper_or_sticker", "free_drink_jackpot"];
const CODE_RE = /^[A-Z2-9]{4}$/;
const MIN_TTL_S = 60;                                   // Cloudflare KV's minimum expirationTtl
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const linkKey = env => (typeof env.PRIZE_PHONE_KEY === "string" && env.PRIZE_PHONE_KEY.trim().length >= 32 ? env.PRIZE_PHONE_KEY.trim() : "");
export const linkOn = env => !!(linkKey(env) && env.STATE);

/* Digits only; 10 digits, or 11 starting with 1; NANP shape (area code and exchange start 2-9). Returns the 10 digits or "". */
export function normalizePhone(raw) {
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  let d = String(raw).replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? d : "";
}
async function phoneHash(env, digits) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(linkKey(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("tb-prize-phone|+1" + digits)));
  return [...sig].map(b => b.toString(16).padStart(2, "0")).join("");
}

/* Best-effort rate limit (saves + lookups together) per caller per hour. KV has no atomic counter, so two simultaneous requests can both pass:
   this is a brake on guessing, not an exact meter; the kiosk server has its own limiter in front of it. */
const isoRl = new Map();
async function rateOk(env, req) {
  const limit = Math.max(1, parseInt(env.PRIZE_LINK_PER_HOUR || "60", 10) || 60);
  const who = (req.headers.get("cf-connecting-ip") || "k").slice(0, 45);
  const key = "pzrl:" + who + ":" + Math.floor(Date.now() / 3600e3);
  let n = 0;
  try { n = parseInt(await env.STATE.get(key), 10) || 0; } catch { n = isoRl.get(key) || 0; }
  if (n >= limit) return false;
  try { await env.STATE.put(key, String(n + 1), { expirationTtl: 3700 }); } catch { isoRl.set(key, n + 1); }
  return true;
}

/* Is this claim still good? -> {state:"valid", ticket} | {state:"dead"} (used, unknown or expired) | {state:"unavailable"} */
async function checkClaim(env, code) {
  if (!env.TB_SECRET && !env.KIOSK_KEY) return { state: "unavailable" };
  const r = await fetchJsonTimeout(whereOrigin(env) + "/kitchen/claims/redeem", {
    method: "POST", headers: whereHeaders(env, true), body: JSON.stringify({ code, by: "station", checkOnly: true }),
  }, 3500);
  const d = r.data;
  if (r.status === 200 && d && d.ok === true && d.status === "valid" && d.ticket && typeof d.ticket === "object") {
    const t = d.ticket, exp = Number(t.expiresAt);
    if (!(exp > Date.now())) return { state: "dead" };
    return { state: "valid", ticket: t };
  }
  if ((r.status === 404 && d && d.status === "unknown") || (r.status === 200 && d && d.ok === false && d.status === "used")) return { state: "dead" };
  return { state: "unavailable" };
}
const cleanLabel = s => (typeof s === "string" ? s.replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 80) : "");
const ttlFor = exp => Math.max(MIN_TTL_S, Math.ceil((exp - Date.now()) / 1000));

async function dropLink(env, h, code) {
  try { if (h) await env.STATE.delete("pz:" + h); } catch {}
  try { if (code) await env.STATE.delete("pzc:" + code); } catch {}
}
async function readLink(env, h) {
  try { const v = await env.STATE.get("pz:" + h, "json"); return v && typeof v === "object" && CODE_RE.test(String(v.code)) ? v : null; } catch { return null; }
}

/* Delete the link for a claim code (after the prize was attached to an order, or redeemed at the window). Never throws. */
export async function clearPrizeLinkByCode(env, code) {
  try {
    const c = String(code || "").trim().toUpperCase();
    if (!CODE_RE.test(c) || !env || !env.STATE) return false;
    const h = await env.STATE.get("pzc:" + c);
    if (typeof h === "string" && h) {
      const cur = await readLink(env, h);
      if (!cur || cur.code === c) await env.STATE.delete("pz:" + h);
    }
    await env.STATE.delete("pzc:" + c);
    return true;
  } catch { return false; }
}

/* path is one of the three routes above; the STATION_KEY gate has already passed (index.js). */
export async function handlePrizeLink(req, env, path) {
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  if (!/^application\/json\b/i.test(req.headers.get("content-type") || "")) return json({ ok: false, error: "json only" }, 415);
  let body = null;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "bad json" }, 400);

  if (path === "/api/prize-link/clear") {
    const c = String(body.code || "").trim().toUpperCase();
    if (!CODE_RE.test(c)) return json({ ok: false, error: "bad-claim" }, 400);
    await clearPrizeLinkByCode(env, c);
    return json({ ok: true });
  }
  if (path !== "/api/prize-link/save" && path !== "/api/prize-link/lookup") return json({ ok: false, error: "not-found" }, 404);
  if (!linkOn(env)) return json({ ok: false, error: "prize-link-off" }, 503);
  const digits = normalizePhone(body.phone);
  if (!digits) return json({ ok: false, error: "bad-phone" }, 400);
  if (!(await rateOk(env, req))) return json({ ok: false, error: "slow-down" }, 429);
  const h = await phoneHash(env, digits);
  const cur = await readLink(env, h);

  if (path === "/api/prize-link/lookup") {
    if (!cur) return json({ ok: true, found: false });
    const v = await checkClaim(env, cur.code);
    if (v.state === "unavailable") return json({ ok: false, error: "unavailable" }, 503);
    if (v.state === "dead" || !(Number(cur.expiresAt) > Date.now())) { await dropLink(env, h, cur.code); return json({ ok: true, found: false }); }
    return json({ ok: true, found: true, code: cur.code, prizeId: cur.prizeId, label: cur.label, expiresAt: cur.expiresAt });
  }

  // ---- save ----
  const code = String(body.code || "").trim().toUpperCase();
  if (!CODE_RE.test(code)) return json({ ok: false, error: "bad-claim" }, 400);
  if (cur) {
    const v = await checkClaim(env, cur.code);
    if (v.state === "unavailable") return json({ ok: false, error: "unavailable" }, 503);
    if (v.state === "dead" || !(Number(cur.expiresAt) > Date.now())) await dropLink(env, h, cur.code);   // the saved one is spent or gone: this number is free again
    else if (cur.code === code) return json({ ok: true, already: true, keptUntil: cur.expiresAt });
    else return json({ ok: false, error: "already-have" }, 409);
  }
  const owner = await env.STATE.get("pzc:" + code);
  if (owner && owner !== h) return json({ ok: false, error: "bad-claim" }, 409);        // a code can be saved to one number only
  const v = await checkClaim(env, code);
  if (v.state === "unavailable") return json({ ok: false, error: "unavailable" }, 503);
  const prize = v.state === "valid" && v.ticket.prize && typeof v.ticket.prize === "object" ? v.ticket.prize : null;
  if (!prize || !LINK_PRIZE_IDS.includes(prize.id)) return json({ ok: false, error: "bad-claim" }, 409);
  const expiresAt = Number(v.ticket.expiresAt);
  const rec = { code, prizeId: prize.id, label: cleanLabel(prize.label) || prize.id, expiresAt, at: Date.now() };
  const ttl = { expirationTtl: ttlFor(expiresAt) };
  await env.STATE.put("pz:" + h, JSON.stringify(rec), ttl);
  await env.STATE.put("pzc:" + code, h, ttl);
  return json({ ok: true, keptUntil: expiresAt });
}
