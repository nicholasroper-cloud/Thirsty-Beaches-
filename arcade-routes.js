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

   The five arcade GAMES (kiosk/games/*) use the SAME roll: the page may only say "a game finished" (POST /api/arcade/game/finish {sid}); the
   server opened that session itself (POST /api/arcade/game/start {game}, game from GAME_IDS), checks it ran for a believable minimum time on
   the SERVER clock, allows one roll per session, and shares one per-visit roll cap with the slots (arcade-session.json maxPrizeRolls). The page
   never supplies a prize id, label, code or score: a skill game is still a chance roll at the staff odds table, not a reward for a score.

   A win can ride a LATER order two more ways, both ending in the same pending prize + ARCADE note tag + make-station badge:
     phone number : the customer saves a win to a phone number (POST /api/arcade/wallet/save) and types it on the order screen later
                    (POST /api/arcade/wallet/lookup). The number is only ever sent to the station Worker (HMAC with a secret kept there, never
                    stored or logged here); this file keeps no copy of it and logs no digits.
     claim code   : POST /api/arcade/code checks a 4-character code with the tb-where Worker (check only, burned at redeem as today).

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
/* The five games the kiosk serves (kiosk/games/<id>/). A session can only be opened for one of these; the id is used for the log and nothing else. */
const GAME_IDS = ["thirsty-blaster", "thirsty-tower", "cup-catch", "boardwalk-dash", "soft-serve-stacker"];
/* visitGapSeconds: an open arcade page pings every 20 s, so a visit is over once nothing (ping, game or spin) has been heard for this long; keep it a little over 20 so the next customer never inherits a used-up roll count.
   Server-side visit settings, read from kiosk/arcade-session.json on every use (the page reads the same file for its own limits). A missing or
   bad file or value falls back to these, never to "no limit". Only `useOnSameVisit: false` (literally) turns the win-rides-this-order path off. */
const SESSION_DEFAULTS = { maxPrizeRolls: 4, useOnSameVisit: true, gameMinSeconds: 20, visitGapSeconds: 40 };
function sessionSettings(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const num = (v, lo, hi, d) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : d);
  return {
    maxPrizeRolls: num(src.maxPrizeRolls, 1, 20, SESSION_DEFAULTS.maxPrizeRolls),
    useOnSameVisit: src.useOnSameVisit !== false,
    gameMinSeconds: num(src.gameMinSeconds, 5, 300, SESSION_DEFAULTS.gameMinSeconds),
    visitGapSeconds: num(src.visitGapSeconds, 25, 900, SESSION_DEFAULTS.visitGapSeconds),
  };
}
const CODE_RE = /^[A-Z2-9]{4}$/;
/* Plain names for every place outside the slot machine's own page (game results, the rules panel, the order-screen banner and cart line). The slot page keeps its own label. */
const PLAIN_LABEL = { free_drink_jackpot: "Free Drink" };
const GAME_LABEL = PLAIN_LABEL;
/* US phone, as the page types it: 10 digits (a leading 1 is dropped), area code and exchange start 2-9. Returns the 10 digits or "". */
function normPhone(v) {
  let d = String(v == null ? "" : v).replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? d : "";
}
/* A small sliding-window counter: take() is true while fewer than `max` takes happened in the last `ms`. */
function makeLimit(max, ms, nowFn) {
  let hits = [];
  const prune = () => { const t = nowFn(); hits = hits.filter(x => t - x < ms); return t; };
  return { take() { const t = prune(); if (hits.length >= max) return false; hits.push(t); return true; },
    full() { prune(); return hits.length >= max; }, add() { const t = prune(); hits.push(t); } };
}
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
  const sessionFile = o.sessionFile || null;
  const rulesFile = o.rulesFile || null;
  const STATION_API = String(o.stationApi || "").replace(/\/+$/, "");

  const prizesOn = () => !!(KIOSK_KEY && API && doFetch);

  // ---------- config ----------
  /* period = the promotion period these odds belong to (a short label the staff set), version = counts every odds/period change; both go on every win log line so a period's odds are traceable. */
  function defaults() { return { personaMode: "auto", volume: 0.75, muted: false, pgMode: true, winterEnabled: true, odds: defaultOdds(), period: "", version: 1, updatedAt: null }; }
  const cleanPeriod = v => (typeof v === "string" ? v.replace(/[^A-Za-z0-9 .,:\/_-]/g, "").trim().slice(0, 40) : "");
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
      period: cleanPeriod(s.period), version: Number.isInteger(s.version) && s.version >= 1 && s.version < 1e6 ? s.version : 1,
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
    if ("period" in body) { if (typeof body.period !== "string") return { status: 400, body: { ok: false, error: "period must be text" } }; next.period = cleanPeriod(body.period); }
    if (("odds" in body && JSON.stringify(next.odds) !== JSON.stringify(cur.odds)) || next.period !== cur.period) next.version = cur.version + 1;   // a real odds or period change is a new version
    next.updatedAt = t;
    try {
      fs.mkdirSync(tbDir, { recursive: true });
      const tmp = cfgFile + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(next, null, 2)); fs.renameSync(tmp, cfgFile);
    } catch (e) { return { status: 500, body: { ok: false, error: "could not save" } }; }
    return { status: 200, body: { ok: true, config: next } };
  }

  // ---------- play tokens (the Worker needs one per claim, at least minMs old) ----------
  const TOKEN_TARGET = 3, TOKEN_MAX_AGE_MS = 5 * 3600e3, MINTS_PER_HOUR = 12;
  const CAP_REPROBE_MS = 30 * 60e3;
  let tokens = [], mintTimes = [], blockedUntil = 0, capUntil = 0, refilling = null, lastSeen = 0;

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
  function touch() { lastSeen = now(); probeWallet().catch(() => {}); return refill(); }
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
    if (now() < Math.max(blockedUntil, capUntil)) return null;
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
    /* tb-where: "sold-out" = the GLOBAL daily mint count (shared with the website, PRIZE_DAILY_CAP, day = America/Denver) is used up, it is not one prize's stock; "daily-limit" = this network's own daily allowance
       (kiosk 40 a day) or a key problem. Either way no code can be issued right now: say so before play, and ask again in 30 minutes (the owner may have raised the cap, the day may have turned). */
    if (err === "sold-out" || err === "daily-limit") capUntil = now() + CAP_REPROBE_MS;
    else if (r.status === 429) blockedUntil = now() + 10 * 60000;   // slowed down: stop asking for a while
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
    const cap = +v.issuedAt + PENDING_TTL_MS;
    const until = Number.isFinite(+v.expiresAt) && +v.expiresAt > +v.issuedAt ? Math.min(+v.expiresAt, cap) : cap;   // never longer than 15 min, shorter if the claim itself ends sooner
    return { code: v.code, prizeId: p.id, label: PLAIN_LABEL[p.id] || p.label, issuedAt: +v.issuedAt, expiresAt: until };
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
  function setPending(prize, code, claimExpiresAt) {
    const v = cleanPending({ code, prizeId: prize.id, issuedAt: now(), expiresAt: claimExpiresAt });
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
      markAttached(p.code);                                   // this code is spoken for: it cannot ride a second order while the first ticket waits to be bumped
      walletClear(p.code).catch(() => {});                    // the phone link (if any) is deleted with the use
      return { status: 200, body: { ok: true, code: p.code, label: p.label } };
    } finally { attaching = false; }
  }

  // ---------- visit settings, the shared per-visit roll cap, codes already spoken for ----------
  function settings() {
    let raw = typeof o.settings === "function" ? o.settings() : o.settings && typeof o.settings === "object" ? o.settings : null;   // tests inject; the kiosk reads the file
    if (!raw && sessionFile) { try { raw = JSON.parse(fs.readFileSync(sessionFile, "utf8")); } catch { raw = null; } }
    return sessionSettings(raw);
  }
  let visit = { rolls: 0, lastAt: 0 };
  function touchVisit() {
    const t = now();
    if (!visit.lastAt || t - visit.lastAt > settings().visitGapSeconds * 1000) visit = { rolls: 0, lastAt: t };   // nobody around for a while: a new visit
    visit.lastAt = t;
  }
  const attachedFile = tbDir ? path.join(tbDir, "arcade-attached.json") : null;
  const ATTACHED_KEEP_MS = 72 * 3600e3;
  let attachedCodes = [];
  if (attachedFile) { try { const a = JSON.parse(fs.readFileSync(attachedFile, "utf8")); if (Array.isArray(a)) attachedCodes = a.filter(x => x && CODE_RE.test(x.code) && Number.isFinite(+x.at)); } catch {} }
  function markAttached(code) {
    const t = now();
    attachedCodes = attachedCodes.filter(x => t - x.at < ATTACHED_KEEP_MS && x.code !== code).concat({ code, at: t }).slice(-200);
    if (!attachedFile) return;
    try { fs.mkdirSync(tbDir, { recursive: true }); const tmp = attachedFile + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(attachedCodes)); fs.renameSync(tmp, attachedFile); } catch {}
  }
  const isAttached = code => { const t = now(); return attachedCodes.some(x => x.code === code && t - x.at < ATTACHED_KEEP_MS); };

  /* wins this server issued (code -> what it was). Saving to a phone number may only name one of these: the browser's code is a selector, never a prize. */
  const recent = new Map();
  const RECENT_KEEP_MS = 6 * 3600e3;
  function rememberWin(code, prize, expiresAt) {
    const t = now();
    for (const [k, v] of recent) if (t - v.at > RECENT_KEEP_MS) recent.delete(k);
    recent.set(code, { prizeId: prize.id, label: prize.label, expiresAt: Number.isFinite(+expiresAt) ? +expiresAt : t + 24 * 3600e3, at: t });
    while (recent.size > 60) recent.delete(recent.keys().next().value);
  }

  /* One roll, for a slot spin or a finished game. The prize is decided here from the staff odds; a code exists only if the Worker issued it.
     Returns { capped } (visit cap reached, nothing rolled) | { prize, noCode } | { prize, code, expiresAt, orderNow }. */
  async function roll(source) {
    touchVisit();
    if (visit.rolls >= settings().maxPrizeRolls) return { capped: true };
    visit.rolls++;
    const prize = rollPrize(getConfig().odds, rng);
    if (!prize.isPrize) return { prize, plain: true };
    const c = await claim(prize);
    if (!c) return { prize, noCode: true };
    const exp = c.ticket && Number.isFinite(+c.ticket.expiresAt) ? +c.ticket.expiresAt : now() + 24 * 3600e3;
    rememberWin(c.code, prize, exp);
    const cfg = getConfig();
    log("arcade: win " + prize.id + " via " + source + " period=" + (cfg.period || "-") + " odds-v=" + cfg.version);   // never the code: the period's odds stay traceable
    const orderNow = settings().useOnSameVisit;
    if (orderNow) setPending(prize, c.code, exp);          // only a Worker-issued code ever becomes a pending prize
    return { prize, code: c.code, ticket: c.ticket, expiresAt: exp, orderNow: orderNow && !!pending };
  }
  /* The slot machine keeps its own look and label. A finished GAME gets a plain result: the prize's plain name (no "jackpot"), no mega flag, no sound trigger. */
  const winBody = (r, plain) => ({ ok: true, prizeId: r.prize.id, label: plain ? (GAME_LABEL[r.prize.id] || r.prize.label) : r.prize.label, win: true, ...(plain ? {} : { mega: r.prize.id === "free_drink_jackpot", trigger: r.prize.trigger }),
    code: r.code, ticket: r.ticket, expiresAt: r.expiresAt, orderNow: r.orderNow, pendingUntil: r.orderNow && pending ? pending.expiresAt : null, saveable: walletUsable() });

  /* One slot spin. Returns what the page may show:
       { ok, prizeId, win:false, thanks:false }            a normal drink reveal
       { ok, prizeId, win:false, thanks:true }             a prize was rolled but there is no code to hand out: "thanks for playing"
       { ok, prizeId, label, win:true, code, ticket, mega, expiresAt, orderNow, saveable }  a real code from the Worker */
  async function spin() {
    lastSeen = now();
    const r = await roll("slot");
    if (r.capped || r.plain) return { ok: true, prizeId: "standard", win: false, thanks: false };   // cap reached looks like an ordinary reveal: no teasing, no code
    if (r.noCode) return { ok: true, prizeId: "standard", win: false, thanks: true };
    return winBody(r);
  }

  // ---------- the five games: open a session, then ONE roll when the game ends ----------
  const sessions = new Map();
  const SESSION_KEEP_MS = 30 * 60e3;
  function gameStart(game) {
    touchVisit(); lastSeen = now();
    if (typeof game !== "string" || !GAME_IDS.includes(game)) return { status: 400, body: { ok: false, error: "unknown-game" } };
    const t = now();
    for (const [k, v] of sessions) if (t - v.at > SESSION_KEEP_MS) sessions.delete(k);
    while (sessions.size >= 40) sessions.delete(sessions.keys().next().value);
    const sid = crypto.randomBytes(12).toString("hex");
    sessions.set(sid, { game, at: t, done: false });
    return { status: 200, body: { ok: true, sid, minPlayMs: settings().gameMinSeconds * 1000 } };
  }
  /* The page says only "this game finished" ({sid}). Nothing about score, prize or code is read. A session rolls at most once, and not before
     gameMinSeconds have passed on THIS server's clock; an early or repeated finish is refused/answered with plain thanks, never a prize. */
  async function gameFinish(sid) {
    touchVisit(); lastSeen = now();
    const s = typeof sid === "string" && /^[a-f0-9]{24}$/.test(sid) ? sessions.get(sid) : null;
    if (!s || now() - s.at > SESSION_KEEP_MS) return { status: 404, body: { ok: false, error: "no-session" } };
    if (s.done) return { status: 409, body: { ok: false, error: "already-finished" } };
    s.done = true;                                          // consumed at once, whatever happens next: one roll per game played
    if (now() - s.at < settings().gameMinSeconds * 1000) { log("arcade: game finish too soon (" + s.game + ")"); return { status: 200, body: { ok: true, win: false, thanks: true } }; }
    const r = await roll("game");
    if (r.capped || r.plain || r.noCode) return { status: 200, body: { ok: true, win: false, thanks: true } };
    return { status: 200, body: winBody(r, true) };
  }

  // ---------- status and rules (what the pages may say BEFORE play) ----------
  /* prizes: this kiosk can hand out codes at all; capped: the Worker's daily cap is known to be used up today (say so before play). */
  function status() { const cfg = getConfig(); return { ok: true, prizes: prizesOn(), capped: now() < capUntil, period: cfg.period, version: cfg.version }; }
  const RULES_DEFAULTS = { sponsorName: "", sponsorAddress: "", promoStart: "", promoEnd: "", prizeLifeText: "24 hours", stickerSwap: true, onePerPersonPerDay: true, limitedPrizesDaily: true, rulesUrl: "", privacyUrl: "" };
  const PRIZE_NOTES = { size_upgrade: "used on a drink you order", soft_serve_topper: "used on a drink you order", topper_or_sticker: "topper used on a drink you order, or a sticker", neon_charm: "", free_drink_jackpot: "no purchase needed" };
  /* The rules panel's facts. Text the staff own comes from kiosk/arcade-rules.json (empty = a visible placeholder, never an invented name, address or date). Odds are stated ONLY
     as what this server enforces: the free-drink ceiling (MAX_FREE_DRINK_PCT) and, only while the live table really makes it true, "most games do not win". */
  function rules() {
    let raw = null; if (rulesFile) { try { raw = JSON.parse(fs.readFileSync(rulesFile, "utf8")); } catch { raw = null; } }
    const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const txt = (k, n) => (typeof src[k] === "string" ? src[k].replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, n) : RULES_DEFAULTS[k]);
    const flag = k => (typeof src[k] === "boolean" ? src[k] : RULES_DEFAULTS[k]);
    const cfg = getConfig();
    const std = cfg.odds.find(x => x.id === "standard");
    const out = { sponsorName: txt("sponsorName", 80), sponsorAddress: txt("sponsorAddress", 160), promoStart: txt("promoStart", 40), promoEnd: txt("promoEnd", 40), prizeLifeText: txt("prizeLifeText", 40) || RULES_DEFAULTS.prizeLifeText,
      rulesUrl: txt("rulesUrl", 120), privacyUrl: txt("privacyUrl", 120), stickerSwap: flag("stickerSwap"), onePerPersonPerDay: flag("onePerPersonPerDay"), limitedPrizesDaily: flag("limitedPrizesDaily") };
    const missing = ["sponsorName", "sponsorAddress", "promoStart", "promoEnd"].filter(k => !out[k]);
    return { ok: true, rules: { ...out, missing, prizes: PRIZES.filter(p => p.isPrize).map(p => ({ id: p.id, label: p.id === "free_drink_jackpot" ? GAME_LABEL.free_drink_jackpot : p.label, note: PRIZE_NOTES[p.id] || "" })),
      freeDrinkOneIn: Math.floor(100 / MAX_FREE_DRINK_PCT), mostGamesDoNotWin: !!(std && std.pct > 50), period: cfg.period, version: cfg.version } };
  }

  // ---------- phone number and code lookups (the station Worker holds the phone link; tb-where holds the codes) ----------
  const walletSaveLimit = makeLimit(10, 10 * 60e3, now), lookupFails = makeLimit(Math.max(1, Math.min(60, parseInt(o.lookupsPer10Min, 10) || 20)), 10 * 60e3, now), lookupDayLimit = makeLimit(60, 24 * 3600e3, now);
  /* Only MISSES count toward the 10-minute brake (a customer who typed it wrong a few times is not locked out; number guessing is all misses), the daily cap counts every lookup. */
  const lookupGate = () => !lookupFails.full() && lookupDayLimit.take();
  /* Is the station's prize-link route really there? "on" only after the station answered like the real thing (JSON from the route, not its static-file 404): until then, and whenever it
     says off / 404 / 405 / non-JSON, nothing is OFFERED (saveable false) and no number is ever sent. Re-probed every 10 minutes; a probe sends no number (an invalid phone, refused before any storage). */
  let walletState = "unknown", walletOffUntil = 0, walletProbeAt = 0, walletProbing = null;
  const WALLET_RECHECK_MS = 10 * 60e3;
  const walletConfigured = () => !!(STATION_API && STATION_KEY && doFetch);
  const walletUsable = () => walletConfigured() && walletState === "on" && now() >= walletOffUntil;
  function classify(r) {            // -> "on" | "off" | "unknown" (unknown = could not reach it: say unavailable, try again soon)
    if (r.status === 0) return "unknown";
    if (r.status === 404 || r.status === 405 || !r.data || typeof r.data !== "object") return "off";                   // route not deployed yet (falls through to static files) or not our JSON
    if (r.status === 503 && r.data.error === "prize-link-off") return "off";
    return r.status === 401 || r.status === 403 || r.status >= 500 ? "unknown" : "on";
  }
  function probeWallet() {
    if (!walletConfigured()) return Promise.resolve();
    const age = now() - walletProbeAt;
    if (walletState === "unknown" ? age < 60e3 : age < WALLET_RECHECK_MS) return Promise.resolve();   // unknown: try again each minute; known: every 10 minutes
    if (walletProbing) return walletProbing;
    walletProbing = (async () => {
      const r = await stationJson("/api/prize-link/lookup", { phone: "0" });
      walletState = classify(r); walletProbeAt = now();
      if (walletState === "off") walletOffUntil = now() + 10 * 60e3;
    })().finally(() => { walletProbing = null; });
    return walletProbing;
  }
  async function stationJson(p, body) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      const r = await doFetch(STATION_API + p, { method: "POST", signal: ctl.signal, headers: { Accept: "application/json", "Content-Type": "application/json", "X-Key": STATION_KEY }, body: JSON.stringify(body) });
      let data = null; try { data = await r.json(); } catch {}
      return { status: r.status, data };
    } catch { return { status: 0, data: null }; }
    finally { clearTimeout(timer); }
  }
  const slow = () => ({ status: 429, body: { ok: false, error: "slow-down" } });
  const off = () => ({ status: 200, body: { ok: false, error: "off" } });
  const gone = () => ({ status: 200, body: { ok: false, error: "unavailable" } });
  /* An answer that says the link is not there at all (503 off, 404/405, or not JSON): treat the feature as off for 10 minutes. */
  function noteOff(r) { if (classify(r) === "off") { walletState = "off"; walletProbeAt = now(); walletOffUntil = now() + 10 * 60e3; return true; } return false; }

  /* Keep a win on a phone number. {phone, code}: code must be a win THIS server issued in the last 6 hours (so the page cannot save an arbitrary
     claim). The number goes to the station Worker only; it is never logged, stored or echoed here (only its last two digits come back for the screen). */
  async function walletSave(phone, code) {
    const ph = normPhone(phone);
    if (!ph) return { status: 400, body: { ok: false, error: "bad-phone" } };
    const c = typeof code === "string" ? code.toUpperCase() : "";
    const w = CODE_RE.test(c) ? recent.get(c) : null;
    if (!w || now() - w.at > RECENT_KEEP_MS || now() >= w.expiresAt || isAttached(c)) return { status: 200, body: { ok: false, error: "unknown-code" } };   // an attached code is spoken for
    await probeWallet();
    if (!walletUsable()) return walletConfigured() && walletState === "unknown" ? gone() : off();
    if (!walletSaveLimit.take()) return slow();
    const r = await stationJson("/api/prize-link/save", { phone: ph, code: c });
    const d = r.data;
    if (noteOff(r)) return off();
    if (r.status === 200 && d && d.ok === true) return { status: 200, body: { ok: true, saved: true, last2: ph.slice(-2), keptUntil: Number.isFinite(+d.keptUntil) ? +d.keptUntil : w.expiresAt } };
    if (d && d.error === "already-have") return { status: 200, body: { ok: false, error: "already-have" } };
    if (r.status === 429) return slow();
    log("arcade: could not save a win to a phone number (" + r.status + (d && d.error ? " " + d.error : "") + ")");
    return gone();
  }
  async function walletClear(code) {
    if (!walletUsable() || !CODE_RE.test(String(code))) return;
    await stationJson("/api/prize-link/clear", { code });
  }
  /* A prize found (by phone or code) becomes the kiosk's ONE pending prize, exactly like a win from this visit, so the order screen banner and the
     attach-after-order flow need nothing new. The label and prize id come from this file's fixed table, never from the Worker's or the page's text. */
  function adopt(prizeId, code, expiresAt) {
    const prize = PRIZES.find(p => p.id === prizeId && p.isPrize);
    const exp = Number(expiresAt);
    if (!prize || !CODE_RE.test(String(code)) || !(exp > now())) return null;
    if (isAttached(code)) return { used: true };
    const p = setPending(prize, code, exp);
    return p ? { prize, exp } : null;
  }
  async function walletLookup(phone) {
    const ph = normPhone(phone);
    if (!ph) return { status: 400, body: { ok: false, error: "bad-phone" } };
    await probeWallet();
    if (!walletUsable()) return walletConfigured() && walletState === "unknown" ? gone() : off();
    if (!lookupGate()) return slow();
    const r = await stationJson("/api/prize-link/lookup", { phone: ph });
    const d = r.data;
    if (noteOff(r)) return off();
    if (r.status === 429) return slow();
    if (r.status === 200 && d && d.ok === true && d.found === false) { lookupFails.add(); return { status: 200, body: { ok: true, found: false } }; }
    if (r.status === 200 && d && d.ok === true && d.found === true) {
      const a = adopt(d.prizeId, d.code, d.expiresAt);
      if (a && a.prize) return { status: 200, body: { ok: true, found: true, label: PLAIN_LABEL[a.prize.id] || a.prize.label, expiresAt: a.exp } };
      lookupFails.add(); return { status: 200, body: { ok: true, found: false } };       // used, expired or malformed: indistinguishable from "nothing there"
    }
    return gone();
  }
  /* A 4-character claim code typed on the order screen: checked with tb-where (check only; the claim is burned at redeem as always). */
  async function codeLookup(code) {
    const c = String(code == null ? "" : code).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!CODE_RE.test(c)) return { status: 200, body: { ok: true, found: false, status: "unknown" } };
    if (!prizesOn()) return off();
    if (!lookupGate()) return slow();
    if (isAttached(c)) { lookupFails.add(); return { status: 200, body: { ok: true, found: false, status: "used" } }; }
    const r = await workerJson("POST", "/kitchen/claims/redeem", { code: c, checkOnly: true, by: "kiosk" }, { "X-Kiosk-Key": KIOSK_KEY });
    const d = r.data;
    if (r.status === 200 && d && d.ok === true && d.status === "valid") {
      const tk = d.ticket && typeof d.ticket === "object" ? d.ticket : {};
      const a = adopt(tk.prize && typeof tk.prize === "object" ? tk.prize.id : "", c, tk.expiresAt);
      if (a && a.prize) return { status: 200, body: { ok: true, found: true, label: PLAIN_LABEL[a.prize.id] || a.prize.label, expiresAt: a.exp } };
      lookupFails.add();
      if (a && a.used) return { status: 200, body: { ok: true, found: false, status: "used" } };
      return { status: 200, body: { ok: true, found: false, status: "unknown" } };   // not an arcade prize, or past its expiry
    }
    if (d && d.status === "used") { lookupFails.add(); return { status: 200, body: { ok: true, found: false, status: "used" } }; }
    if (r.status === 404 || (d && d.status === "unknown")) { lookupFails.add(); return { status: 200, body: { ok: true, found: false, status: "unknown" } }; }
    return gone();
  }

  return { getConfig, saveConfig, spin, gameStart, gameFinish, walletSave, walletLookup, codeLookup, walletClear, touchVisit, settings, status, rules, getPending, dismissPending, attachToOrder, refill, touch, refillIfActive, prizesOn, validateOdds, _state: () => ({ tokens: tokens.length, blockedUntil }) };
}

module.exports = { PENDING_TTL_MS, GAME_IDS, SESSION_DEFAULTS, sessionSettings, normPhone, PRIZES, PRIZE_IDS, MAX_FREE_DRINK_PCT, defaultOdds, validateOdds, rollPrize, createArcade };
