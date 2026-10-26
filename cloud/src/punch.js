/* Punch-card punches from a paid phone order (CONTRACTS item 3).
     GET /api/qr/<ref>/punch -> 200 {url:"https://thirstybeaches.com/card?claim=<token>", drinks}
                                404 unknown ref, 409 not paid yet (or no drinks on it), 503 punch-off
   Only the station makes tokens, and only for a ref it knows is paid/ready. The website card page
   (thirstybeaches.com/card) sends the token to tb-where POST /card/claim, which checks the signature
   and expiry and allows one claim per ref.
     payload = `${ref}.${drinks}.${expMs}`   drinks = drinks on the order (not grab-and-go treats), 1..5
     sig     = first 32 hex chars of HMAC-SHA256(PUNCH_KEY, payload)
     token   = `${payload}.${sig}`            expMs = now + 7 days
   The HMAC key is the PUNCH_KEY secret string as stored (64 hex chars, trimmed), UTF-8 encoded, not
   hex-decoded; tb-where does the same. Without PUNCH_KEY (fewer than 32 chars) the feature is off:
   503 {error:"punch-off"}, and the tracker / kiosk show no punch button.                          */
import { KIOSK_MENU } from "./kiosk-menu.js";
import { norm } from "./pricebook.js";

export const PUNCH_TTL_MS = 7 * 86400000;
export const PUNCH_MAX = 5;
const CARD_URL = "https://thirstybeaches.com/card";

export const punchKey = env => (typeof env.PUNCH_KEY === "string" && env.PUNCH_KEY.trim().length >= 32 ? env.PUNCH_KEY.trim() : "");
export const punchOn = env => !!punchKey(env);

/* Kiosk menu categories that are grab-and-go treats (GRAB_CATEGORIES, default "Treats" -> cat key "treats"). */
function grabNames(env, menu = KIOSK_MENU) {
  const keys = new Set((env.GRAB_CATEGORIES || "Treats").split(",").map(s => s.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean));
  const out = new Set();
  for (const [k, cat] of Object.entries(menu.cats)) if (keys.has(k)) for (const it of cat.items) out.add(norm(it.name));
  return out;
}
/* Drinks on a stored order record (qr:<ref>), treats left out, capped at PUNCH_MAX. */
export function drinkCount(env, rec, menu = KIOSK_MENU) {
  const grab = grabNames(env, menu);
  const n = (rec.lines || []).reduce((a, l) => a + (grab.has(norm(l.name)) ? 0 : Math.max(0, l.qty | 0)), 0);
  return Math.min(PUNCH_MAX, n);
}

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
  return [...sig].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function punchToken(key, ref, drinks, expMs) {
  const payload = `${ref}.${drinks}.${expMs}`;
  return `${payload}.${(await hmacHex(key, payload)).slice(0, 32)}`;
}

/* s = qrStatus() result for ref (or null). -> {status, body} */
export async function punchFor(env, ref, s, now = Date.now()) {
  if (!punchOn(env)) return { status: 503, body: { error: "punch-off" } };
  if (!s) return { status: 404, body: { error: "not-found" } };
  if (s.status !== "paid" && s.status !== "ready") return { status: 409, body: { error: "not-paid" } };
  const drinks = drinkCount(env, s.rec);
  if (drinks < 1) return { status: 409, body: { error: "no-drinks" } };
  const token = await punchToken(punchKey(env), ref, drinks, now + PUNCH_TTL_MS);
  return { status: 200, body: { url: `${CARD_URL}?claim=${token}`, drinks } };
}
