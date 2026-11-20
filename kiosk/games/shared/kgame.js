/* kgame.js: the kiosk shell for the arcade games and their picker. Loaded FIRST on every page (before the game script). Plain script, no inline code.
   It never sends a score, prize or code; the only requests are: GET /kiosk/arcade-session.json, GET /api/arcade/ping (every 20 s),
   POST /api/arcade/game/start {game}, POST /api/arcade/game/finish {sid}, POST /api/arcade/pending/dismiss {} (hands-off return only).
   Every request tolerates failure silently: the games always play.

   1. Audio guard: every AudioContext a game makes is tracked; TBK.stopAudio() closes them all, cancels speech, and refuses new ones.
   2. One VISIT across the picker and the five games (sessionStorage {s,l}: two timestamps, nothing personal). A time cap (gameMaxSeconds,
      default 150) counts from the visit start; a missing or bad arcade-session.json means the defaults, never "no limit".
   3. Idle: "Still playing?" warning, then a hands-off return to / (after telling the server to drop an unused pending prize).
   4. TBK.runStart(game) / TBK.runEnd(): a game run = one server session, one prize roll at game over (the result panel, prize-panel.js).
   5. Before play: GET /api/arcade/status fills every [data-kg-prizeline] ("Prizes are done for today. Play for fun." when the daily cap is known to be used up;
      the "chance at a prize" line only when the server says prizes are on) and every [data-kg-rules] button opens the Prize Game Rules panel (rules-panel.js). */
(function (root) {
  'use strict';
  const doc = root.document;

  /* ---------- 1. audio guard ---------- */
  const ctxs = [];
  let audioBlocked = false;
  ['AudioContext', 'webkitAudioContext'].forEach(function (name) {
    const Orig = root[name];
    if (typeof Orig !== 'function') return;
    function Guarded() {
      if (audioBlocked) throw new Error('audio stopped');
      const c = new (Function.prototype.bind.apply(Orig, [null].concat([].slice.call(arguments))))();
      ctxs.push(c);
      return c;
    }
    Guarded.prototype = Orig.prototype;
    try { root[name] = Guarded; } catch (e) { /* read-only: the visit end still pauses every game */ }
  });
  function stopAudio() {
    audioBlocked = true;
    ctxs.splice(0).forEach(function (c) { try { c.close(); } catch (e) { /* already closed */ } });
    try { if (root.speechSynthesis) root.speechSynthesis.cancel(); } catch (e) { /* no speech */ }
  }

  /* ---------- 2. limits (same sanitising as kiosk/boardwalk-slots.js sessionLimits; the game time cap is new) ---------- */
  const DEFAULTS = { enabled: true, idleSeconds: 60, idleWarnSeconds: 20, endedReturnSeconds: 30, gameMaxSeconds: 150 };
  function sessionLimits(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const num = function (v, lo, hi, d) { const n = Number(v); return typeof v !== 'boolean' && v !== null && Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : d; };
    const idleSeconds = num(src.idleSeconds, 15, 300, DEFAULTS.idleSeconds);
    return {
      enabled: src.enabled !== false,
      idleSeconds: idleSeconds,
      idleWarnSeconds: Math.min(num(src.idleWarnSeconds, 5, 120, DEFAULTS.idleWarnSeconds), idleSeconds - 5),
      endedReturnSeconds: num(src.endedReturnSeconds, 10, 180, DEFAULTS.endedReturnSeconds),
      gameMaxSeconds: num(src.gameMaxSeconds, 30, 900, DEFAULTS.gameMaxSeconds)
    };
  }
  let limits = sessionLimits(null);

  /* ---------- visit (sessionStorage) ---------- */
  const VISIT_KEY = 'tbGamesVisit';
  const OFF_KEY = 'tbPhonePathOff';        // bare flag set by the result panel after an under-13 answer: the phone path stays closed for this visit (no age data is stored)
  function clearPhoneOff() { try { root.sessionStorage.removeItem(OFF_KEY); } catch (e) { /* nothing stored */ } }
  const VISIT_GAP_MS = 90000;
  function readVisit() { try { return JSON.parse(root.sessionStorage.getItem(VISIT_KEY)); } catch (e) { return null; } }
  function writeVisit(v) { try { root.sessionStorage.setItem(VISIT_KEY, JSON.stringify(v)); } catch (e) { /* storage blocked: the visit lives in memory for this page */ } }
  function clearVisit() { try { root.sessionStorage.removeItem(VISIT_KEY); } catch (e) { /* nothing stored */ } memVisit = null; }
  let memVisit = null;
  function loadVisit() {
    const now = Date.now();
    let v = readVisit() || memVisit;
    if (v && now - v.l > VISIT_GAP_MS) clearPhoneOff();     // a stale visit means the person walked away: the next one gets the phone path
    if (!v || typeof v.s !== 'number' || typeof v.l !== 'number' || now - v.l > VISIT_GAP_MS || v.s > now + 5000 || now - v.s > 6 * 3600 * 1000) v = { s: now, l: now };
    v.l = now;
    memVisit = v; writeVisit(v);
    return v;
  }
  const visit = loadVisit();

  /* ---------- leaving ---------- */
  let leaving = false;
  function dismissPending() {
    return new Promise(function (resolve) {
      let done = false;
      const fin = function () { if (!done) { done = true; resolve(); } };
      setTimeout(fin, 800);
      try {
        root.fetch('/api/arcade/pending/dismiss', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', keepalive: true }).then(fin, fin);
      } catch (e) { fin(); }
    });
  }
  /* hands-off return: a prize nobody ordered with is not left as a banner for the next customer (the code and any phone link still keep it) */
  function leaveHandsOff() {
    if (leaving) return;
    leaving = true;
    stopAudio(); clearVisit(); clearPhoneOff();
    dismissPending().then(function () { root.location.replace('/'); });
  }

  /* ---------- time-left bar, ended panel, idle warning ---------- */
  const $ = function (id) { return doc.getElementById(id); };
  let ended = false, lastTouch = Date.now(), warnEl = null, endEl = null;
  const endCbs = [];
  function onEnd(fn) { if (typeof fn === 'function') endCbs.push(fn); }
  function fmt(s) { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

  function mk(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function endVisit() {
    if (ended) return;
    ended = true;
    lastTouch = Date.now();
    endCbs.forEach(function (fn) { try { fn(); } catch (e) { /* a game that cannot pause is still covered by the panel */ } });   // stop the game first, then its sound
    stopAudio();
    if (root.TBPrize && root.TBPrize.hide) root.TBPrize.hide();
    if (warnEl) warnEl.hidden = true;
    endEl = mk('div', 'kg-modal'); endEl.setAttribute('role', 'alertdialog'); endEl.id = 'kgEnded';
    endEl.appendChild(mk('h2', '', "Time's up!"));
    endEl.appendChild(mk('p', '', 'Thanks for playing. Others are waiting for the games. Tap ORDER DRINKS to grab a drink.'));
    const a = mk('a', 'kg-btn kg-btn--go', 'ORDER DRINKS'); a.href = '/#menu'; a.id = 'kgEndedOrder';
    a.addEventListener('click', clearVisit);
    endEl.appendChild(a);
    doc.body.appendChild(endEl);
  }

  function tick() {
    if (leaving) return;
    const now = Date.now();
    if (!ended) { visit.l = now; writeVisit(visit); }
    const timeEl = $('kgTime');
    if (limits.enabled) {
      const left = limits.gameMaxSeconds - (now - visit.s) / 1000;
      if (timeEl) {
        timeEl.hidden = false;
        const t = timeEl.querySelector('b'), bar = timeEl.querySelector('u');
        if (t) t.textContent = fmt(left);
        if (bar) bar.style.width = Math.max(0, Math.min(100, left / limits.gameMaxSeconds * 100)) + '%';
        timeEl.classList.toggle('is-low', left <= 30);
      }
      if (!ended && left <= 0) endVisit();
      const idleLimit = (ended ? Math.min(limits.idleSeconds, limits.endedReturnSeconds) : limits.idleSeconds) * 1000;
      const idleFor = now - lastTouch;
      if (idleFor >= idleLimit) { leaveHandsOff(); return; }
      if (warnEl && !ended) warnEl.hidden = idleFor < idleLimit - limits.idleWarnSeconds * 1000;
    } else if (timeEl) timeEl.hidden = true;
  }

  function touched() { lastTouch = Date.now(); if (warnEl && !warnEl.hidden) warnEl.hidden = true; }

  /* ---------- 4. one run = one server session ---------- */
  let sid = null, startP = null, runGame = null, againFn = null, runGen = 0;
  function post(path, body) {
    return root.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }, function () { return { ok: false, d: null }; }); });
  }
  function runStart(game) {
    runGame = game; sid = null; runGen++;
    if (root.TBPrize && root.TBPrize.hide) root.TBPrize.hide();
    if (ended) return;
    startP = post('/api/arcade/game/start', { game: game }).then(function (r) {
      if (r.ok && r.d && r.d.ok === true && /^[a-f0-9]{24}$/.test(String(r.d.sid))) sid = r.d.sid;
    }).catch(function () { /* offline: the game plays, no prize roll */ });
  }
  function runEnd() {
    if (ended) return Promise.resolve();
    const p = startP || Promise.resolve();
    const gen = runGen;                  // a new run started before the panel shows (quick Play again on the game's own card): no panel over a running game
    startP = null;
    return p.then(function () {
      const mine = sid; sid = null;
      if (!mine) return { ok: true, win: false, thanks: true };
      return post('/api/arcade/game/finish', { sid: mine }).then(function (r) {
        const d = r.d;
        if (r.ok && d && d.ok === true && d.win === true && /^[A-Z2-9]{4}$/.test(String(d.code))) return d;
        return { ok: true, win: false, thanks: true };
      }).catch(function () { return { ok: true, win: false, thanks: true }; });
    }).then(function (result) {
      if (ended || leaving) return;
      setTimeout(function () {
        if (ended || leaving) return;
        if (gen !== runGen && result.win !== true) return;      // already playing again: a plain thanks is not worth interrupting; a WIN is always shown
        if (root.TBPrize) root.TBPrize.show({ result: result, mode: 'game', onAgain: againFn });
      }, result.win === true ? 0 : 700);               // let the game's own game-over card land first (a win shows at once)
    });
  }
  function onAgain(fn) { againFn = fn; }

  /* ---------- 5. before play: "prizes are done today", the rules button ---------- */
  const PRIZE_LINE = 'Finish a game for a chance at a prize.', CAPPED_LINE = 'Prizes are done for today. Play for fun.';
  function wirePrizeLines() {
    Array.prototype.forEach.call(doc.querySelectorAll('[data-kg-rules]'), function (b) {
      b.addEventListener('click', function () { if (root.TBRules) root.TBRules.open(); });
    });
    const lines = doc.querySelectorAll('[data-kg-prizeline]');
    if (!lines.length) return;
    // until the server answers nothing is promised; if it cannot be reached (or prizes are off) nothing is promised either
    try {
      root.fetch('/api/arcade/status', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        const capped = !!(j && j.ok === true && j.capped === true), on = !!(j && j.ok === true && j.prizes === true);
        Array.prototype.forEach.call(lines, function (p) {
          const onlyCapped = p.getAttribute('data-kg-prizeline') === 'capped';
          p.classList.toggle('is-capped', capped);
          if (capped) { p.textContent = CAPPED_LINE; p.hidden = false; }
          else if (on && !onlyCapped) { p.textContent = PRIZE_LINE; p.hidden = false; }
          else { p.textContent = ''; p.hidden = true; }
        });
      }, function () { /* nothing promised */ });
    } catch (e) { /* nothing promised */ }
  }

  /* ---------- boot ---------- */
  function init() {
    // no context menu, no drag, no selection, no pinch: this is a public touchscreen
    ['contextmenu', 'dragstart', 'selectstart', 'gesturestart', 'gesturechange'].forEach(function (n) { doc.addEventListener(n, function (e) { e.preventDefault(); }, { passive: false }); });
    ['pointerdown', 'pointermove', 'keydown'].forEach(function (n) { doc.addEventListener(n, touched, { passive: true, capture: true }); });
    warnEl = mk('div', 'kg-modal kg-modal--idle'); warnEl.id = 'kgIdle'; warnEl.hidden = true; warnEl.setAttribute('role', 'alertdialog');
    warnEl.appendChild(mk('h2', '', 'Still playing?'));
    const keep = mk('button', 'kg-btn kg-btn--go', 'TAP TO KEEP PLAYING'); keep.type = 'button';
    keep.addEventListener('click', touched);
    warnEl.appendChild(keep);
    doc.body.appendChild(warnEl);
    // ORDER DRINKS ends the visit (a fresh one for the next person); ALL GAMES keeps it
    Array.prototype.forEach.call(doc.querySelectorAll('.kg-order'), function (a) { a.addEventListener('click', clearVisit); });
    // Kiosk idle restarts wait for customer activity: an open arcade page is activity (bounded by the idle return above)
    const ping = function () { try { root.fetch('/api/arcade/ping', { cache: 'no-store' }).catch(function () {}); } catch (e) { /* offline */ } };
    ping(); root.setInterval(ping, 20000);
    root.setInterval(tick, 1000);
    wirePrizeLines();
    root.addEventListener('pagehide', stopAudio);
    doc.addEventListener('visibilitychange', function () { if (doc.hidden) stopAudio(); });
    // the visit settings (a bad or missing file is the defaults)
    let timer = null;
    try {
      const ctl = new root.AbortController(); timer = root.setTimeout(function () { ctl.abort(); }, 2500);
      root.fetch('/kiosk/arcade-session.json', { cache: 'no-store', signal: ctl.signal }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { limits = sessionLimits(j); tick(); }, function () { /* defaults stay */ }).then(function () { root.clearTimeout(timer); });
    } catch (e) { /* defaults stay */ }
    tick();
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();

  const api = { stopAudio: stopAudio, onEnd: onEnd, runStart: runStart, runEnd: runEnd, onAgain: onAgain, sessionLimits: sessionLimits, DEFAULTS: DEFAULTS, leaveHandsOff: leaveHandsOff, clearVisit: clearVisit,
    isEnded: function () { return ended; }, isStray: function (e) { return !!e && e.pointerType === 'touch' && Math.max(e.width || 0, e.height || 0) > 220; } };
  root.TBK = api;
})(typeof window !== 'undefined' ? window : globalThis);
