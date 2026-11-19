/* arcade-routes.js — the Boardwalk Slots arcade on the kiosk PC: prize odds, the staff-guarded config, and REAL prize codes.

   Why this file exists: the page used to roll the prize and invent a 4-digit "claim code" in the browser, so there was no record, no cap
   and nothing the window could verify. Now the prize is rolled HERE, and a code exists only if the tb-where Worker issued it:

     page  --POST /api/arcade/spin-->  this server  --GET /scores/token-->  Worker       (a play token; the Worker wants it >= minMs old)
                                                    --POST /kitchen/claim + X-Kiosk-Key-->  Worker   (single-use token, global daily cap)
     page  <-- { win, code, ticket } --

   The Worker's own rules apply (global daily cap shared with the website, kiosk allowance per network, one claim per play token).
   The code it returns is a 4-character Kitchen Board claim that the staff make station already lists and redeems (/kitchen/claims).
   If the Worker is unreachable, KIOSK_KEY is unset, the daily cap is hit, or no play token is old enough yet: the arcade still plays and
   the answer is "thanks for playing" with NO code. Nothing here ever invents a code.

   A win that came with a Worker code also becomes the kiosk's ONE "pending prize" (code, prize id, label, issuedAt), kept in memory and in
   .tb/arcade-pending.json, for 15 minutes or until it is used or declined. The ordering page reads it (GET /api/arcade/pending) and shows a
   banner. When the order is placed the page sends only the new ORDER ID (/api/arcade/pending/attach); THIS server adds its own pending
   prize to that Clover order's note (" · ARCADE <id> <CODE>"), the same way " · MAZE UPSIZE" rides there. No price, total, discount or
   line item is touched, and the browser never supplies a prize id, label or code.

   KIOSK_KEY stays on this PC (kiosk-config.env). The browser never sees it. Zero npm dependencies. */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* The prize table. The ids are the only ids the staff config may name; labels, "isPrize" and the audio trigger are fixed here, so a
   config file (or a POST) can never inject text or a new prize. tests/boardwalk-arcade.test.mjs pins kiosk/boardwalk-slots.js to this table. */
const PRIZES = [
  { id: "standard",           label: "Standard Custom Drink",                         pct: 81, isPrize: false, trigger: "drink_reveal" },
  { id: "size_upgrade",       label: "Free Size Upgrade",                             pct: 6,  isPrize: true,  trigger: "prize_win" },
  { id: "soft_serve_topper",  label: "Free Pineapple Soft Serve or Vanilla Soft Serve Topper",   pct: 5,  isPrize: true,  trigger: "prize_win" },
  { id: "neon_charm",         label: "Free 3D-Printed Neon Straw Charm",              pct: 4,  isPrize: true,  trigger: "arcade_charm_win" },
  { id: "topper_or_sticker",  label: "Free Freeze-Dried Topper or UV-DTF Sticker",    pct: 3,  isPrize: true,  trigger: "prize_win" },
  { id: "free_drink_jackpot", label: "FREE DRINK JACKPOT!",                           pct: 1,  isPrize: true,  trigger: "mega_jackpot" },
];
const PRIZE_IDS = PRIZES.map(p => p.id);
const MAX_FREE_DRINK_PCT = 2;      // hard ceiling on the free-drink odds, whatever the staff drawer says
const PERSONAS = ["shredder", "neon86", "auto"];

/* The Worker's claim ladder (routes/kitchen.js): score >= 600 unlocks a secret-menu code, >= 2000 an "Arcade Champ" code. */
const SCORE_FOR = { free_drink_jackpot: 2000 };
const SCORE_DEFAULT = 600;

const defaultOdds = () => PRIZES.map(p => ({ id: p.id, label: p.label, pct: p.pct, isPrize: p.isPrize, trigger: p.trigger }));

/* Validate a staff odds list. Returns { ok:true, odds } (full table, fixed labels) or { ok:false, error }. */
function validateOdds(list) {
  if (!Array.isArray(list)) return { ok: false, error: "odds must be a list" };
  if (list.length !== PRIZES.length) return { ok: false, error: "odds must list every prize exactly once" };
  const seen = new Map();
  for (const o of list) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, error: "bad odds entry" };
    if (typeof o.id !== "string" || !PRIZE_IDS.includes(o.id)) return { ok: false, error: "unknown prize id" };
    if (seen.has(o.id)) return { ok: false, error: "duplicate prize id " + o.id };
    if (typeof o.pct !== "number" || !Number.isFinite(o.pct) || o.pct < 0 || o.pct > 100) return { ok: false, error: "odds must be numbers from 0 to 100" };
    seen.set(o.id, Math.round(o.pct * 100) / 100);
  }
  let sum = 0; for (const v of seen.values()) sum += v;
  if (Math.abs(sum - 100) > 0.001) return { ok: false, error: "prize odds must sum to 100%" };
  if (seen.get("free_drink_jackpot") > MAX_FREE_DRINK_PCT) return { ok: false, error: "free drink odds cannot be more than " + MAX_FREE_DRINK_PCT + "%" };
  return { ok: true, odds: PRIZES.map(p => ({ id: p.id, label: p.label, pct: seen.get(p.id), isPrize: p.isPrize, trigger: p.trigger })) };
}

/* Weighted roll over a validated table. rng() is in [0,1). */
function rollPrize(odds, rng) {
  const list = Array.isArray(odds) && odds.length ? odds : defaultOdds();
  const r = rng || Math.random;
  const total = list.reduce((s, o) => s + Math.max(0, +o.pct || 0), 0);
  if (total <= 0) return list[0];
  let t = r() * total;
  for (const o of list) { t -= Math.max(0, +o.pct || 0); if (t < 0) return o; }
  return list[list.length - 1];
}

const safeEq = (a, b) => {
  const h = v => crypto.createHash("sha256").update(String(v)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
};

/* opts: { tbDir, apiBase, kioskKey, stationKey, fetchImpl, now, rng, log, clover: { get(path), post(path, body) } }  (everything injectable for tests) */
const PENDING_TTL_MS = 15 * 60000;          // a win waits this long for an order, then it is just a code in the customer's hand
const ATTACH_WINDOW_MS = 15 * 60000;       // the order a prize is attached to must have been created this recently
const ORDER_ID_RE = /^[A-Za-z0-9]{6,20}$/;
function createArcade(opts) {
  const o = opts || {};
  const tbDir = o.tbDir;
  const API = String(o.apiBase || "").replace(/\/+$/, "");
  const KIOSK_KEY = String(o.kioskKey || "").trim();
  const STATION_KEY = String(o.stationKey || "").trim();
  const doFetch = o.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const now = o.now || Date.now;
  const rng = o.rng || Math.random;
  const log = o.log || (() => {});
  const clover = o.clover && typeof o.clover.get === "function" && typeof o.clover.post === "function" ? o.clover : null;
  const cfgFile = tbDir ? path.join(tbDir, "arcade-config.json") : null;

  const prizesOn = () => !!(KIOSK_KEY && API && doFetch);

  // ---------- config ----------
  function defaults() { return { personaMode: "auto", volume: 0.75, muted: false, pgMode: true, winterEnabled: true, odds: defaultOdds(), updatedAt: null }; }
  function readSaved() { try { return JSON.parse(fs.readFileSync(cfgFile, "utf8")); } catch { return null; } }
  function cleanSaved(s) {
    const d = defaults();
    if (!s || typeof s !== "object") return d;
    const v = validateOdds(s.odds);
    return {
      personaMode: PERSONAS.includes(s.personaMode) ? s.personaMode : d.personaMode,
      volume: typeof s.volume === "number" && s.volume >= 0 && s.volume <= 1 ? s.volume : d.volume,
      muted: s.muted === true, pgMode: s.pgMode !== false, winterEnabled: s.winterEnabled !== false,
      odds: v.ok ? v.odds : d.odds,                       // a hand-edited or corrupt file falls back to the defaults, never to its own numbers
      updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : null,
    };
  }
  const getConfig = () => cleanSaved(cfgFile ? readSaved() : null);

  /* Staff-only write. key = what the caller sent in X-Key. Fails CLOSED: with STATION_KEY unset nobody can write.
     Partial updates are fine: odds are touched only when `odds` is in the body. Returns { status, body }. */
  const fails = [];
  function saveConfig(key, body) {
    const t = now();
    while (fails.length && t - fails[0] > 15 * 60000) fails.shift();
    if (fails.length >= 8) return { status: 429, body: { ok: false, error: "too many tries, wait a few minutes" } };
    if (!STATION_KEY) return { status: 403, body: { ok: false, error: "staff key not set on this kiosk (STATION_KEY in kiosk-config.env)" } };
    if (typeof key !== "string" || !key || !safeEq(key, STATION_KEY)) { fails.push(t); return { status: 401, body: { ok: false, error: "staff key required" } }; }
    if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { ok: false, error: "bad config" } };
    if (body.check === true) return { status: 200, body: { ok: true, config: getConfig() } };   // the drawer's "is this the right key" probe: writes nothing
    const cur = getConfig();
    const next = { ...cur };
    if ("odds" in body) {
      const v = validateOdds(body.odds);
      if (!v.ok) return { status: 400, body: { ok: false, error: v.error } };
      next.odds = v.odds;
    }
    if ("personaMode" in body) { if (!PERSONAS.includes(body.personaMode)) return { status: 400, body: { ok: false, error: "bad persona" } }; next.personaMode = body.personaMode; }
    if ("volume" in body) { if (typeof body.volume !== "number" || !(body.volume >= 0 && body.volume <= 1)) return { status: 400, body: { ok: false, error: "volume must be 0 to 1" } }; next.volume = body.volume; }
    for (const k of ["muted", "pgMode", "winterEnabled"]) if (k in body) { if (typeof body[k] !== "boolean") return { status: 400, body: { ok: false, error: k + " must be true or false" } }; next[k] = body[k]; }
    next.updatedAt = t;
    try {
      fs.mkdirSync(tbDir, { recursive: true });
      const tmp = cfgFile + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(next, null, 2)); fs.renameSync(tmp, cfgFile);
    } catch (e) { return { status: 500, body: { ok: false, error: "could not save" } }; }
    return { status: 200, body: { ok: true, config: next } };
  }

  // ---------- play tokens (the Worker needs one per claim, at least minMs old) ----------
  const TOKEN_TARGET = 3, TOKEN_MAX_AGE_MS = 5 * 3600e3, MINTS_PER_HOUR = 12;
  let tokens = [], mintTimes = [], blockedUntil = 0, refilling = null, lastSeen = 0;

  async function workerJson(method, p, body, extraHeaders) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await doFetch(API + p, { method, signal: ctl.signal, headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...(extraHeaders || {}) }, body: body ? JSON.stringify(body) : undefined });
      let data = null; try { data = await r.json(); } catch {}
      return { status: r.status, data };
    } catch { return { status: 0, data: null }; }
    finally { clearTimeout(timer); }
  }

  function refill() {
    if (!prizesOn()) return Promise.resolve();
    if (refilling) return refilling;
    refilling = (async () => {
      for (let i = 0; i < TOKEN_TARGET; i++) {
        const t = now();
        tokens = tokens.filter(x => t - x.at < TOKEN_MAX_AGE_MS);
        mintTimes = mintTimes.filter(x => t - x < 3600e3);
        if (tokens.length >= TOKEN_TARGET || mintTimes.length >= MINTS_PER_HOUR) break;
        mintTimes.push(t);
        const r = await workerJson("GET", "/scores/token");
        if (r.status === 200 && r.data && typeof r.data.token === "string") {
          const minMs = Number.isFinite(+r.data.minMs) ? Math.max(0, Math.min(120000, +r.data.minMs)) : 45000;
          tokens.push({ token: r.data.token, at: now(), readyAt: now() + minMs + 2000 });
        } else { log("arcade: play token unavailable (" + r.status + ")"); break; }
      }
    })().finally(() => { refilling = null; });
    return refilling;
  }
  /* The page was opened or a spin happened: remember it, and keep tokens warm for the next few hours only (no mints on a kiosk nobody plays on). */
  function touch() { lastSeen = now(); return refill(); }
  function refillIfActive() { return lastSeen && now() - lastSeen < 6 * 3600e3 ? refill() : Promise.resolve(); }
  function takeToken() {
    const t = now();
    tokens = tokens.filter(x => t - x.at < TOKEN_MAX_AGE_MS);
    const i = tokens.findIndex(x => x.readyAt <= t);
    if (i < 0) return null;
    return tokens.splice(i, 1)[0].token;
  }

  /* Ask the Worker for a real code. Returns { code, ticket } or null (and says why in the log, never to the page). */
  async function claim(prize) {
    if (!prizesOn()) return null;
    if (now() < blockedUntil) return null;
    const token = takeToken();
    if (!token) { log("arcade: no play token old enough yet, no code for this win"); refill(); return null; }
    const r = await workerJson("POST", "/kitchen/claim", { score: SCORE_FOR[prize.id] || SCORE_DEFAULT, who: "TB", token, prize: { id: prize.id, label: prize.label } }, { "X-Kiosk-Key": KIOSK_KEY });
    refill();
    const d = r.data;
    if (r.status === 200 && d && d.ok === true && typeof d.code === "string" && /^[A-Z2-9]{4}$/.test(d.code)) {
      const tk = d.ticket && typeof d.ticket === "object" ? d.ticket : {};
      const s = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, n) : "");
      return { code: d.code, ticket: { reward: s(tk.reward, 80), drinkName: s(tk.drinkName, 60), build: s(tk.build, 200), expiresAt: Number.isFinite(+tk.expiresAt) ? +tk.expiresAt : null } };
    }
    const err = d && d.error;
    if (r.status === 429 || err === "sold-out" || err === "daily-limit") blockedUntil = now() + 10 * 60000;   // cap hit: stop asking for a while
    log("arcade: claim refused (" + r.status + (err ? " " + err : "") + ")");
    return null;
  }


  // ---------- the pending prize (one per kiosk) ----------
  const pendingFile = tbDir ? path.join(tbDir, "arcade-pending.json") : null;
  const cleanPending = v => {
    if (!v || typeof v !== "object") return null;
    if (typeof v.code !== "string" || !/^[A-Z2-9]{4}$/.test(v.code)) return null;
    const p = PRIZES.find(x => x.id === v.prizeId && x.isPrize);
    if (!p || !Number.isFinite(+v.issuedAt)) return null;
    return { code: v.code, prizeId: p.id, label: p.label, issuedAt: +v.issuedAt, expiresAt: +v.issuedAt + PENDING_TTL_MS };
  };
  function savePending(v) {
    if (!pendingFile) return;
    try {
      fs.mkdirSync(tbDir, { recursive: true });
      if (!v) { try { fs.unlinkSync(pendingFile); } catch {} return; }
      const tmp = pendingFile + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(v)); fs.renameSync(tmp, pendingFile);
    } catch (e) { log("arcade: could not save the pending prize (" + e.message + ")"); }
  }
  let pending = null, lastAttached = null, attaching = false;
  if (pendingFile) { try { pending = cleanPending(JSON.parse(fs.readFileSync(pendingFile, "utf8"))); } catch { pending = null; } if (pending && now() >= pending.expiresAt) { pending = null; savePending(null); } }

  /* The pending prize, or null. An expired one is dropped here. */
  function getPending() {
    if (pending && now() >= pending.expiresAt) { pending = null; savePending(null); }
    return pending ? { ...pending } : null;
  }
  function setPending(prize, code) {
    const v = cleanPending({ code, prizeId: prize.id, issuedAt: now() });
    if (!v) return null;
    pending = v; savePending(v);
    return { ...v };
  }
  function dismissPending() { const had = !!getPending(); pending = null; savePending(null); return { ok: true, dismissed: had }; }

  /* The ordering page placed an order and sent its ORDER ID (nothing else is read). The prize attached is this server's own pending one.
     The order must be a kiosk order (its note says so) created a moment ago; its note gets " · ARCADE <id> <CODE>" appended and nothing else
     about the order changes (no price, discount, line item, title or state). Idempotent for the same order. Returns { status, body }. */
  async function attachToOrder(orderId) {
    const id = typeof orderId === "string" ? orderId.trim() : "";
    if (!ORDER_ID_RE.test(id)) return { status: 400, body: { ok: false, error: "bad order id" } };
    if (lastAttached && lastAttached.orderId === id) return { status: 200, body: { ok: true, already: true, code: lastAttached.code, label: lastAttached.label } };
    const p = getPending();
    if (!p) return { status: 200, body: { ok: false, error: "no-pending" } };
    if (!clover) return { status: 200, body: { ok: false, error: "clover-unavailable" } };
    if (attaching) return { status: 200, body: { ok: false, error: "busy" } };
    attaching = true;
    try {
      let cur = null;
      try { cur = await clover.get("/orders/" + encodeURIComponent(id)); } catch { cur = null; }
      if (!cur || typeof cur !== "object") return { status: 200, body: { ok: false, error: "order-unreadable" } };
      const note = typeof cur.note === "string" ? cur.note : "";
      const age = now() - Number(cur.createdTime);
      if (!/Kiosk order/.test(note) || !Number.isFinite(age) || Math.abs(age) > ATTACH_WINDOW_MS) return { status: 200, body: { ok: false, error: "not-a-fresh-kiosk-order" } };
      if (!/ · ARCADE /.test(note)) {
        try { await clover.post("/orders/" + encodeURIComponent(id), { note: note + " · ARCADE " + p.prizeId + " " + p.code }); }
        catch (e) { log("arcade: could not write the prize onto the order (" + e.message + ")"); return { status: 200, body: { ok: false, error: "order-write-failed" } }; }
      }
      lastAttached = { orderId: id, code: p.code, label: p.label };
      pending = null; savePending(null);
      return { status: 200, body: { ok: true, code: p.code, label: p.label } };
    } finally { attaching = false; }
  }

  /* One spin. The prize is decided here. Returns what the page may show:
       { ok, prizeId, win:false, thanks:false }            a normal drink reveal
       { ok, prizeId, win:false, thanks:true }             a prize was rolled but there is no code to hand out: "thanks for playing"
       { ok, prizeId, label, win:true, code, ticket, mega }  a real code from the Worker (also held as the pending prize) */
  async function spin() {
    lastSeen = now();
    const prize = rollPrize(getConfig().odds, rng);
    if (!prize.isPrize) return { ok: true, prizeId: prize.id, win: false, thanks: false };
    const c = await claim(prize);
    if (!c) return { ok: true, prizeId: "standard", win: false, thanks: true };
    setPending(prize, c.code);                              // only a Worker-issued code ever becomes a pending prize
    return { ok: true, prizeId: prize.id, label: prize.label, win: true, mega: prize.id === "free_drink_jackpot", trigger: prize.trigger, code: c.code, ticket: c.ticket, pendingUntil: pending ? pending.expiresAt : null };
  }

  return { getConfig, saveConfig, spin, getPending, dismissPending, attachToOrder, refill, touch, refillIfActive, prizesOn, validateOdds, _state: () => ({ tokens: tokens.length, blockedUntil }) };
}

module.exports = { PENDING_TTL_MS, PRIZES, PRIZE_IDS, MAX_FREE_DRINK_PCT, defaultOdds, validateOdds, rollPrize, createArcade };
