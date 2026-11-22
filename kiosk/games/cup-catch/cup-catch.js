/* Cup Catch: an original 1986 beach arcade game for Thirsty Beaches.
 * Purpose: play for fun. Kiosk copy: no external network; a finished game asks the kiosk server for ONE prize roll (kgame.js), no score is ever sent.
 * Layout: pure game logic first (exported for unit tests), then the canvas renderer, sound, and DOM wiring.
 * Safe DOM only: textContent and class toggles, no HTML string injection. */
(function (root) {
  'use strict';

  /* =====================================================================
   * PURE LOGIC (no DOM, no clock, deterministic given an rng)
   * ===================================================================== */

  var W = 360;            // logical board width
  var H = 560;            // logical board height
  var MAX_SPOILS = 3;     // spoils that dump a drink
  var START_LIVES = 3;
  var RUSH_EVERY = 3;     // a Rush Hour after every 3rd drink served

  /* ---------- difficulty: two tables, one switch ----------
     `classic` is the v48 tuning exactly. `arcade86` is the harder 1986 arcade pace. gameDifficulty in kiosk/arcade-session.json picks one (the shared shell reads it, TBK.difficulty());
     setDifficulty() is called once when a run starts, so a run never changes table mid-game. Nothing else differs between the two modes. */
  var TUNING = {
    classic: {
      rushSeconds: 7,
      ticketBase: 7, ticketPerItem: 3.6, ticketPerLevel: 0.25, ticketMin: 10,
      junkBase: 0.2, junkPer: 0.02, junkMax: 0.4, wrongBase: 0.12, wrongPer: 0.01, wrongMax: 0.2,
      fallBase: 150, fallPer: 15, fallMax: 330, intervalBase: 1.05, intervalPer: 0.045, intervalMin: 0.5
    },
    arcade86: {
      rushSeconds: 5.5,
      ticketBase: 5.2, ticketPerItem: 2.6, ticketPerLevel: 0.35, ticketMin: 7.5,
      junkBase: 0.26, junkPer: 0.025, junkMax: 0.46, wrongBase: 0.16, wrongPer: 0.015, wrongMax: 0.24,
      fallBase: 205, fallPer: 24, fallMax: 420, intervalBase: 0.82, intervalPer: 0.055, intervalMin: 0.36
    }
  };
  var TUNE = TUNING.classic;
  var RUSH_SECONDS = TUNE.rushSeconds;
  function setDifficulty(mode) {
    TUNE = Object.prototype.hasOwnProperty.call(TUNING, mode) ? TUNING[mode] : TUNING.classic;
    RUSH_SECONDS = TUNE.rushSeconds;
    return TUNE === TUNING.arcade86 ? 'arcade86' : 'classic';
  }

  // Ingredient catalog. `label` is what the order ticket says.
  var GOOD = {
    ice:       { label: 'ice',            color: '#7FE0F0' },
    berry:     { label: 'berry syrup',    color: '#FF3CAC' },
    coconut:   { label: 'coconut syrup',  color: '#2AF5E4' },
    mango:     { label: 'mango syrup',    color: '#FF9A3C' },
    grape:     { label: 'grape syrup',    color: '#9B5CFF' },
    cream:     { label: 'cream',          color: '#FFF4FA' },
    cherry:    { label: 'cherry',         color: '#E8203F' },
    pineapple: { label: 'pineapple soft serve', color: '#FFD93D' }
  };
  var JUNK = {
    sand:     { label: 'sand clump' },
    flipflop: { label: 'flip-flop' },
    feather:  { label: 'seagull feather' }
  };
  var GOOD_KINDS = Object.keys(GOOD);
  var JUNK_KINDS = Object.keys(JUNK);
  // The first drinks only draw from four easy, very different looking things.
  var EASY_KINDS = ['ice', 'berry', 'coconut', 'cream'];

  function isGood(kind) { return Object.prototype.hasOwnProperty.call(GOOD, kind); }
  function isJunk(kind) { return Object.prototype.hasOwnProperty.call(JUNK, kind); }

  // Small seeded generator so tests (and a replay) are deterministic.
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function level(served) { return Math.max(0, served | 0) + 1; }

  // Ticket size grows with the level: 3 items at the start, up to 9.
  function ticketTotal(lvl) { return Math.min(9, 3 + Math.floor((lvl - 1) * 0.75)); }
  function ticketKinds(lvl, total) { return Math.min(total, Math.min(4, 2 + Math.floor((lvl - 1) / 3))); }

  function shuffle(arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // A ticket is { needs: [{kind, n}], total }. Every needed kind is at least 1.
  function ticketForLevel(lvl, rng) {
    rng = rng || Math.random;
    var total = ticketTotal(lvl);
    var nKinds = ticketKinds(lvl, total);
    var pool = lvl <= 3 ? EASY_KINDS : GOOD_KINDS;
    var kinds = shuffle(pool, rng).slice(0, nKinds);
    var counts = kinds.map(function () { return 1; });
    for (var left = total - nKinds; left > 0; left--) {
      counts[Math.floor(rng() * nKinds)]++;
    }
    // Biggest count first reads best on a ticket.
    var needs = kinds.map(function (k, i) { return { kind: k, n: counts[i] }; });
    needs.sort(function (a, b) { return b.n - a.n; });
    return { needs: needs, total: total };
  }

  // "3 ice, 2 berry syrup, 1 cream"
  function ticketText(ticket) {
    return ticket.needs.map(function (n) { return n.n + ' ' + GOOD[n.kind].label; }).join(', ');
  }

  function newProgress(ticket) {
    var need = {}, got = {};
    ticket.needs.forEach(function (n) { need[n.kind] = n.n; got[n.kind] = 0; });
    return { need: need, got: got, spoils: 0, total: ticket.total, filled: 0 };
  }

  function remainingOf(prog, kind) { return (prog.need[kind] || 0) - (prog.got[kind] || 0); }

  // Seconds a drink takes to melt: longer tickets get more time, a little less each level.
  function ticketTime(total, lvl) { return Math.max(TUNE.ticketMin, TUNE.ticketBase + TUNE.ticketPerItem * total - TUNE.ticketPerLevel * (lvl - 1)); }

  // Difficulty curve for a level. Fall speed is logical px per second.
  function difficulty(lvl) {
    var l = Math.max(1, lvl | 0);
    var junk = Math.min(TUNE.junkMax, TUNE.junkBase + TUNE.junkPer * (l - 1));
    var wrong = Math.min(TUNE.wrongMax, TUNE.wrongBase + TUNE.wrongPer * (l - 1));
    return {
      fall: Math.min(TUNE.fallMax, TUNE.fallBase + TUNE.fallPer * (l - 1)),
      interval: Math.max(TUNE.intervalMin, TUNE.intervalBase - TUNE.intervalPer * (l - 1)),
      junk: junk,
      wrong: wrong,
      needed: 1 - junk - wrong
    };
  }

  // What the next falling thing is. `ctx`: { rush, sinceNeeded, inFlight: {kind: n} }
  // Guarantees a needed item at least every 3rd spawn so a kid never waits forever.
  function pickSpawn(prog, lvl, rng, ctx) {
    rng = rng || Math.random;
    ctx = ctx || {};
    var d = difficulty(lvl);
    var inFlight = ctx.inFlight || {};
    var neededKinds = Object.keys(prog.need).filter(function (k) { return remainingOf(prog, k) > 0; });
    var roll = rng();
    var wantNeeded = neededKinds.length > 0 && ((ctx.sinceNeeded || 0) >= 2 || roll < d.needed);
    if (ctx.rush) {
      // Rush Hour: a rich mix, everything is safe.
      var mixed = rng();
      if (mixed < 0.4 && neededKinds.length) wantNeeded = true;
      else wantNeeded = false;
    }
    if (wantNeeded) {
      var weights = neededKinds.map(function (k) { return Math.max(0, remainingOf(prog, k) - (inFlight[k] || 0)); });
      if (!weights.some(function (w) { return w > 0; })) weights = neededKinds.map(function (k) { return remainingOf(prog, k); });
      var sum = weights.reduce(function (a, b) { return a + b; }, 0);
      var r = rng() * sum, kind = neededKinds[neededKinds.length - 1];
      for (var i = 0; i < neededKinds.length; i++) { r -= weights[i]; if (r < 0) { kind = neededKinds[i]; break; } }
      return { kind: kind, golden: lvl >= 2 && rng() < 0.08, needed: true };
    }
    if (ctx.rush) {
      var all = GOOD_KINDS.concat(JUNK_KINDS);
      return { kind: all[Math.floor(rng() * all.length)], golden: false, needed: false };
    }
    var junkShare = d.junk / (d.junk + d.wrong);
    if (rng() < junkShare) {
      return { kind: JUNK_KINDS[Math.floor(rng() * JUNK_KINDS.length)], golden: false, needed: false };
    }
    var others = GOOD_KINDS.filter(function (k) { return remainingOf(prog, k) <= 0; });
    return { kind: others[Math.floor(rng() * others.length)], golden: false, needed: false };
  }

  function comboMultiplier(combo) { return Math.min(5, 1 + Math.floor(Math.max(0, combo) / 4)); }

  // Decide what catching `item` does. Returns a fresh progress object; never mutates the input.
  // item: { kind, golden, safe }   ctx: { combo, rush }
  // outcomes: 'fill' (a needed ingredient), 'safe' (Rush Hour freebie), 'wrong' (not on ticket or extra), 'junk'.
  function resolveCatch(prog, item, ctx) {
    ctx = ctx || {};
    var combo = ctx.combo || 0;
    var next = {
      need: prog.need, got: Object.assign({}, prog.got), spoils: prog.spoils,
      total: prog.total, filled: prog.filled
    };
    var res = {
      outcome: '', reason: '', points: 0, combo: combo, multiplier: comboMultiplier(combo),
      spoiled: false, dumped: false, complete: false, progress: next
    };
    var good = isGood(item.kind);
    if (good && remainingOf(prog, item.kind) > 0) {
      next.got[item.kind] += 1;
      next.filled += 1;
      res.outcome = 'fill';
      res.combo = combo + 1;
      res.multiplier = comboMultiplier(res.combo);
      res.points = (10 + (item.golden ? 40 : 0)) * res.multiplier;
      res.complete = next.filled >= prog.total;
      return res;
    }
    if (item.safe || ctx.rush) {
      res.outcome = 'safe';
      res.points = good ? 10 : 5;
      return res;
    }
    res.outcome = good ? 'wrong' : 'junk';
    res.reason = good ? (prog.need[item.kind] ? 'extra' : 'wrong') : 'junk';
    res.combo = 0;
    res.multiplier = 1;
    res.spoiled = true;
    next.spoils = prog.spoils + 1;
    res.dumped = next.spoils >= MAX_SPOILS;
    return res;
  }

  // Points for finishing a ticket. frac = melt time left / time limit (0 when it melted).
  function completionScore(total, frac) {
    var f = clamp(frac, 0, 1);
    var base = 40 + 10 * total;
    var tip = Math.round(60 * f);
    return { base: base, tip: tip, total: base + tip };
  }

  // Which edge of the cup mouth counts as in. Item crosses the rim line this frame and lands inside the mouth.
  function caughtBy(prevY, y, itemX, itemR, rimY, cupX, mouthHalf) {
    var crossed = prevY + itemR * 0.4 < rimY && y + itemR * 0.4 >= rimY;
    return crossed && Math.abs(itemX - cupX) <= mouthHalf - 2 + itemR * 0.3;
  }

  function shouldRush(servedCount) { return servedCount > 0 && servedCount % RUSH_EVERY === 0; }

  var api = {
    W: W, H: H, MAX_SPOILS: MAX_SPOILS, START_LIVES: START_LIVES, RUSH_SECONDS: TUNING.classic.rushSeconds, TUNING: TUNING, setDifficulty: setDifficulty, difficultyMode: function () { return TUNE === TUNING.arcade86 ? 'arcade86' : 'classic'; },
    GOOD: GOOD, JUNK: JUNK, GOOD_KINDS: GOOD_KINDS, JUNK_KINDS: JUNK_KINDS,
    mulberry32: mulberry32, level: level, ticketTotal: ticketTotal, ticketKinds: ticketKinds,
    ticketForLevel: ticketForLevel, ticketText: ticketText, newProgress: newProgress,
    remainingOf: remainingOf, ticketTime: ticketTime, difficulty: difficulty, pickSpawn: pickSpawn,
    comboMultiplier: comboMultiplier, resolveCatch: resolveCatch, completionScore: completionScore,
    caughtBy: caughtBy, shouldRush: shouldRush, isGood: isGood, isJunk: isJunk
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CupCatch = api;
  if (typeof document === 'undefined') return;

  /* =====================================================================
   * BROWSER GAME (canvas, input, sound, DOM wiring)
   * ===================================================================== */

  var BUNGEE = '"Bungee", "Archivo", Impact, sans-serif';
  var MONO = '"DM Mono", ui-monospace, monospace';
  var BEST_KEY = 'tb-cup-catch-best';
  var SOUND_KEY = 'tb-cup-catch-sound';

  var COUNTER_Y = 500;     // top of the trailer counter
  var CUP_BASE = 506;      // where the cup bottom sits
  var CUP_H = 88;
  var CUP_TOP_W = 92;
  var CUP_BOT_W = 66;
  var RIM_Y = CUP_BASE - CUP_H;
  var ITEM_R = 22;
  var SPAWN_Y = 120;       // items drop out from under the ticket

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('gameCanvas');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var board = $('board');

  var reduced = false;
  var mql = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
  if (mql) {
    reduced = mql.matches;
    var onMq = function (e) { reduced = e.matches; };
    if (mql.addEventListener) mql.addEventListener('change', onMq);
    else if (mql.addListener) mql.addListener(onMq);
  }

  var els = {
    score: $('hudScore'), combo: $('hudCombo'), best: $('hudBest'), lives: $('hudLives'),
    start: $('overlayStart'), pause: $('overlayPause'), over: $('overlayOver'),
    btnStart: $('btnStart'), btnResume: $('btnResume'), btnAgain: $('btnAgain'),
    btnSound: $('btnSound'), btnPause: $('btnPause'),
    overScore: $('overScore'), overBest: $('overBest'), overMeta: $('overMeta'), live: $('liveStatus')
  };

  // ---------- storage (never throws) ----------
  function loadBest() {
    try { var v = parseInt(root.localStorage.getItem(BEST_KEY), 10); return isFinite(v) && v > 0 ? v : 0; } catch (e) { return 0; }
  }
  function saveBest(v) { try { root.localStorage.setItem(BEST_KEY, String(v)); } catch (e) { /* private mode */ } }
  function loadSound() {
    try { return root.localStorage.getItem(SOUND_KEY) !== 'off'; } catch (e) { return true; }
  }
  function saveSound(on) { try { root.localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch (e) { /* private mode */ } }

  // ---------- state ----------
  var rng = mulberry32((Date.now() ^ (Math.random() * 4294967296)) >>> 0);
  var g = {
    mode: 'idle',            // idle | playing | paused | ending | over
    score: 0, best: loadBest(), lives: START_LIVES, served: 0,
    combo: 0, maxCombo: 0,
    ticket: null, prog: null, ticketNo: 0, limit: 20, left: 20,
    layers: [], items: [], spawnT: 0.8, sinceNeeded: 0, lastX: W / 2,
    rush: 0, rushBanner: 0,
    cupX: W / 2, targetX: W / 2, cupV: 0,
    texts: [], parts: [], served1: null, dumped: null,
    shake: 0, flashSpoil: 0, hint: 6, endT: 0,
    customer: 0, mood: 'idle', moodT: 0, spoilPulse: 0, isNewBest: false
  };
  var sound = { on: loadSound(), ctx: null };
  // the beach music follows this Sound setting; a mute chosen on another game page in this visit carries here (shared/beach-music.js)
  if (root.TBMusic) { if (root.TBMusic.isMuted()) sound.on = false; else root.TBMusic.setMuted(!sound.on); }
  var keys = { left: false, right: false };
  var rafId = 0, lastTs = 0;
  var scale = 1, dpr = 1, bgCanvas = null;

  // ---------- sound: Web Audio synth blips, created on first gesture ----------
  function unlockAudio() {
    if (sound.ctx || !sound.on) { if (sound.ctx && sound.ctx.state === 'suspended') sound.ctx.resume(); return; }
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return;
    try { sound.ctx = new AC(); if (sound.ctx.state === 'suspended') sound.ctx.resume(); } catch (e) { sound.ctx = null; }
  }
  function tone(freq, dur, type, vol, slide, delay) {
    if (!sound.on || !sound.ctx) return;
    try {
      var a = sound.ctx, t0 = a.currentTime + (delay || 0);
      var o = a.createOscillator(), gn = a.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(freq, t0);
      if (slide) o.frequency.linearRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
      gn.gain.setValueAtTime(0.0001, t0);
      gn.gain.exponentialRampToValueAtTime(vol || 0.05, t0 + 0.01);
      gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(gn); gn.connect(a.destination);
      o.start(t0); o.stop(t0 + dur + 0.03);
    } catch (e) { /* audio is optional */ }
  }
  var sfx = {
    good: function (combo) { var f = 520 + 55 * Math.min(combo, 8); tone(f, 0.08, 'square', 0.045); tone(f * 1.5, 0.09, 'square', 0.035, 0, 0.05); },
    golden: function () { tone(880, 0.1, 'triangle', 0.07); tone(1175, 0.1, 'triangle', 0.07, 0, 0.08); tone(1568, 0.18, 'triangle', 0.07, 0, 0.16); },
    safe: function () { tone(700, 0.05, 'triangle', 0.04); },
    spoil: function () { tone(170, 0.28, 'sawtooth', 0.06, -90); },
    dump: function () { tone(220, 0.5, 'sawtooth', 0.07, -170); tone(110, 0.5, 'square', 0.05, -60, 0.12); },
    serve: function () { [523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0.12, 'square', 0.05, 0, i * 0.07); }); },
    rush: function () { [392, 523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0.1, 'triangle', 0.06, 0, i * 0.06); }); },
    over: function () { [392, 330, 262, 196].forEach(function (f, i) { tone(f, 0.22, 'square', 0.05, 0, i * 0.16); }); },
    click: function () { tone(600, 0.05, 'square', 0.04); }
  };
  function announce(msg) { els.live.textContent = msg; }

  // ---------- local 1986 Miami artwork assets ----------
  var ART = {};
  (function loadArt() {
    [['bg', '/kiosk/games/cup-catch/assets/bg-miami-counter.webp'],
     ['cust', '/kiosk/games/cup-catch/assets/customer.png']].forEach(function (pair) {
      var im = new Image();
      im.onload = function () { if (pair[0] === 'bg' && canvas.width) buildBackground(); render(); };
      im.src = pair[1];
      ART[pair[0]] = im;
    });
  })();

  /* Pre-rendered "sprite + glow" cache. A drawImage with shadowBlur re-blurs the whole sprite on every frame; this renders it ONCE per (sprite, colour, size, resolution) into a small offscreen
     canvas and then just stamps that bitmap. Returns null while the image is not ready, so the caller keeps its drawn fallback. */
  var GLOW = {};
  function glowSprite(img, key, w, h, color, blur, offY, pxPerUnit) {
    if (!(img && img.complete && img.naturalWidth > 0)) return null;
    var res = Math.max(1, Math.min(4, Math.ceil(pxPerUnit * 2) / 2));
    var k = key + '|' + color + '|' + blur + '|' + (offY || 0) + '|' + w + 'x' + h + '@' + res;
    let e = GLOW[k];
    if (!e) {
      var pad = Math.ceil(blur * 1.6 + Math.abs(offY || 0) + 2);
      var cv = document.createElement('canvas');
      cv.width = Math.ceil((w + 2 * pad) * res); cv.height = Math.ceil((h + 2 * pad) * res);
      var x = cv.getContext('2d');
      if (!x) return null;
      x.shadowColor = color; x.shadowBlur = blur * res; x.shadowOffsetY = (offY || 0) * res;
      x.drawImage(img, pad * res, pad * res, w * res, h * res);
      if (Object.keys(GLOW).length > 24) for (var old in GLOW) { delete GLOW[old]; break; }
      e = GLOW[k] = { cv: cv, pad: pad, w: w, h: h };
    }
    return e;
  }
  function stampGlow(c, e, x, y, dw, dh) {
    var sx = dw / e.w, sy = dh / e.h;
    c.drawImage(e.cv, x - e.pad * sx, y - e.pad * sy, (e.w + 2 * e.pad) * sx, (e.h + 2 * e.pad) * sy);
  }

  // ---------- canvas sizing ----------
  function buildBackground() {
    bgCanvas = document.createElement('canvas');
    bgCanvas.width = canvas.width; bgCanvas.height = canvas.height;
    var c = bgCanvas.getContext('2d');
    c.setTransform(scale, 0, 0, scale, 0, 0);
    drawBackground(c);
  }
  function resize() {
    var rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    dpr = Math.min(root.devicePixelRatio || 1, 3);
    var w = Math.round(rect.width * dpr), h = Math.round(rect.width * dpr * H / W);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    scale = canvas.width / W;
    buildBackground();
    render();
  }

  // ---------- drawing helpers ----------
  function rr(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  function ell(c, x, y, rx, ry) { c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); }
  function textAt(c, s, x, y, font, color, align, glow) {
    c.font = font; c.fillStyle = color; c.textAlign = align || 'left'; c.textBaseline = 'middle';
    if (glow) { c.shadowColor = glow; c.shadowBlur = 10; }
    c.fillText(s, x, y);
    c.shadowBlur = 0;
  }

  function drawBackground(c) {
    if (ART.bg && ART.bg.complete && ART.bg.naturalWidth > 0) {
      var iw = ART.bg.naturalWidth, ih = ART.bg.naturalHeight;
      var splitY = Math.round(ih * 0.76);
      // sky, sunset, ocean, Art Deco hotels & palms aligned down to COUNTER_Y
      c.drawImage(ART.bg, 0, 0, iw, splitY, 0, 0, W, COUNTER_Y);
      // gleaming chrome counter + dual pink/cyan neon tubes aligned from COUNTER_Y..H
      c.drawImage(ART.bg, 0, splitY, iw, ih - splitY, 0, COUNTER_Y - 2, W, H - COUNTER_Y + 2);
      // subtle dark glass backdrop strip for ultra-crisp Thirsty Beaches marquee
      c.fillStyle = 'rgba(14,2,36,.42)';
      c.fillRect(0, COUNTER_Y + 25, W, H - COUNTER_Y - 25);
      textAt(c, 'THIRSTY BEACHES', W / 2, COUNTER_Y + 41, '17px ' + BUNGEE, '#FFE14D', 'center', 'rgba(255,209,102,.9)');
      textAt(c, 'DIRTY SODAS  ·  SOFT SERVE  ·  COFFEE', W / 2, COUNTER_Y + 54, '700 9px ' + MONO, '#2AF5E4', 'center', 'rgba(42,245,228,.75)');
      return;
    }

    // 1986 Miami twilight-to-coral sunset sky (instant fallback while image decodes)
    var sky = c.createLinearGradient(0, 0, 0, 415);
    sky.addColorStop(0, '#090124');
    sky.addColorStop(0.28, '#280659');
    sky.addColorStop(0.56, '#7C158C');
    sky.addColorStop(0.8, '#FF3B9A');
    sky.addColorStop(1, '#FFB566');
    c.fillStyle = sky; c.fillRect(0, 0, W, 415);

    // stars & 4-point neon sparkles
    for (var st = 0; st < 32; st++) {
      var sx0 = (st * 73.1 + 17) % W;
      var sy0 = 114 + ((st * 41.7) % 145);
      c.fillStyle = st % 5 === 0 ? 'rgba(42,245,228,.85)' : (st % 4 === 0 ? 'rgba(255,209,102,.85)' : 'rgba(255,244,250,.85)');
      if (st % 8 === 0) {
        c.fillRect(sx0 - 3, sy0, 6, 1); c.fillRect(sx0, sy0 - 3, 1, 6);
      } else {
        c.fillRect(sx0, sy0, st % 3 === 0 ? 1.8 : 1.2, st % 3 === 0 ? 1.8 : 1.2);
      }
    }

    // soft sunset cloud wisps
    [[64, 215, 76, 10, 'rgba(255,120,180,.24)'], [292, 198, 84, 11, 'rgba(255,168,112,.22)'], [118, 256, 70, 9, 'rgba(255,194,116,.24)']].forEach(function (cl) {
      c.fillStyle = cl[4];
      ell(c, cl[0], cl[1], cl[2] * 0.5, cl[3] * 0.5); c.fill();
      ell(c, cl[0] - cl[2] * 0.24, cl[1] + 2, cl[2] * 0.34, cl[3] * 0.4); c.fill();
      ell(c, cl[0] + cl[2] * 0.26, cl[1] + 1, cl[2] * 0.32, cl[3] * 0.38); c.fill();
    });

    // radiant Outrun sun halo + striped sun
    var halo = c.createRadialGradient(180, 344, 42, 180, 344, 152);
    halo.addColorStop(0, 'rgba(255,226,118,.58)');
    halo.addColorStop(0.5, 'rgba(255,70,158,.3)');
    halo.addColorStop(1, 'rgba(255,60,172,0)');
    c.fillStyle = halo;
    c.beginPath(); c.arc(180, 344, 152, 0, Math.PI * 2); c.fill();

    c.save();
    c.beginPath(); c.arc(180, 344, 96, 0, Math.PI * 2); c.clip();
    var sun = c.createLinearGradient(0, 248, 0, 412);
    sun.addColorStop(0, '#FFF8BE'); sun.addColorStop(0.36, '#FFD166'); sun.addColorStop(0.7, '#FF7A45'); sun.addColorStop(1, '#FF2E93');
    c.fillStyle = sun; c.fillRect(80, 246, 200, 175);
    c.fillStyle = '#6E1482';
    for (var i = 0; i < 6; i++) c.fillRect(80, 336 + i * 12, 200, 1.6 + i * 1.15);
    c.restore();

    // distant Miami Art Deco beachfront skyline
    [[0, 32, 42], [28, 24, 58], [48, 20, 32], [W - 72, 22, 34], [W - 52, 24, 60], [W - 30, 30, 42]].forEach(function (b, idx) {
      var bx = b[0], bw = b[1], bh = b[2], by = 400 - bh;
      c.fillStyle = '#200646';
      c.fillRect(bx, by, bw, bh);
      c.fillRect(bx + 4, by - 5, bw - 8, 5);
      c.fillStyle = idx % 2 ? 'rgba(42,245,228,.72)' : 'rgba(255,60,172,.72)';
      c.fillRect(bx + 3, by - 1, bw - 6, 1.5);
      for (var wy = by + 6; wy < 395; wy += 7) {
        for (var wx = bx + 4; wx < bx + bw - 5; wx += 6) {
          if ((wx + wy + idx * 5) % 9 < 5) {
            c.fillStyle = (wx + wy) % 3 === 0 ? 'rgba(255,209,102,.7)' : 'rgba(42,245,228,.62)';
            c.fillRect(wx, wy, 2.4, 3);
          }
        }
      }
    });

    // glowing Miami turquoise-to-indigo ocean
    var sea = c.createLinearGradient(0, 400, 0, 452);
    sea.addColorStop(0, '#FF68A5'); sea.addColorStop(0.14, '#2AF5E4'); sea.addColorStop(0.55, '#13799C'); sea.addColorStop(1, '#260E5A');
    c.fillStyle = sea; c.fillRect(0, 400, W, 52);
    for (var r0 = 0; r0 < 7; r0++) {
      var rw = Math.max(18, 96 - r0 * 11);
      c.fillStyle = r0 < 3 ? 'rgba(255,232,126,.68)' : 'rgba(255,148,186,.45)';
      c.fillRect(180 - rw / 2 + Math.sin(r0 * 1.9) * 6, 404 + r0 * 6.5, rw, 2.2);
    }
    c.fillStyle = '#2AF5E4'; c.fillRect(0, 399, W, 2.2);

    // foaming surf line + dusk Miami sand
    var sand = c.createLinearGradient(0, 450, 0, COUNTER_Y);
    sand.addColorStop(0, '#A6547F'); sand.addColorStop(0.35, '#73316D'); sand.addColorStop(1, '#3D154E');
    c.fillStyle = sand; c.fillRect(0, 450, W, COUNTER_Y - 450);
    c.strokeStyle = 'rgba(255,244,250,.65)'; c.lineWidth = 2.4;
    c.beginPath(); c.moveTo(0, 451); c.quadraticCurveTo(90, 447, 180, 451); c.quadraticCurveTo(270, 455, W, 450); c.stroke();
    c.fillStyle = 'rgba(255,214,190,.24)';
    for (var d = 0; d < 32; d++) c.fillRect((d * 53) % W, 456 + ((d * 29) % 40), 2, 1.8);

    // lush feathered palms framing the sunset
    function palm(x, lean) {
      var tx = x + lean, ty = 294;
      var qx = x + lean * 0.4, qy = 382;
      c.beginPath();
      c.moveTo(x - 6, COUNTER_Y); c.quadraticCurveTo(qx - 4, qy, tx - 2.6, ty);
      c.lineTo(tx + 2.6, ty); c.quadraticCurveTo(qx + 4, qy, x + 6, COUNTER_Y);
      c.closePath();
      c.fillStyle = '#0D0221'; c.fill();
      c.strokeStyle = 'rgba(255,122,166,.35)'; c.lineWidth = 1.2;
      c.beginPath();
      if (lean > 0) { c.moveTo(x + 5, COUNTER_Y); c.quadraticCurveTo(qx + 3.5, qy, tx + 2.2, ty); }
      else { c.moveTo(x - 5, COUNTER_Y); c.quadraticCurveTo(qx - 3.5, qy, tx - 2.2, ty); }
      c.stroke();
      // coconuts
      c.fillStyle = '#180434';
      c.beginPath(); c.arc(tx - 3, ty + 4, 3.4, 0, Math.PI * 2); c.arc(tx + 3, ty + 4.5, 3.4, 0, Math.PI * 2); c.fill();
      [[-62, 24, -28, -12, 7.2], [-54, -8, -28, -28, 6.5], [-28, -34, -12, -36, 6], [28, -32, 14, -34, 6], [56, -4, 28, -24, 6.5], [60, 26, 28, -10, 7]].forEach(function (p) {
        var ex = tx + p[0], ey = ty + p[1], cx0 = tx + p[2], cy0 = ty + p[3];
        c.strokeStyle = '#0B011D'; c.lineWidth = 2.8; c.lineCap = 'round';
        c.beginPath(); c.moveTo(tx, ty); c.quadraticCurveTo(cx0, cy0, ex, ey); c.stroke();
        for (var j = 1; j <= 10; j++) {
          var t = j / 11, omt = 1 - t;
          var px = omt * omt * tx + 2 * omt * t * cx0 + t * t * ex;
          var py = omt * omt * ty + 2 * omt * t * cy0 + t * t * ey;
          var len = Math.sin(t * Math.PI) * p[4] * 1.9 + 3;
          var sw = p[0] >= 0 ? 1 : -1;
          c.fillStyle = j % 3 === 0 ? '#1A0438' : '#0B011D';
          c.beginPath();
          c.moveTo(px, py);
          c.quadraticCurveTo(px + sw * 2.5, py + len * 0.55, px - sw * 1.5, py + len);
          c.quadraticCurveTo(px - sw * 3.5, py + len * 0.45, px, py);
          c.fill();
        }
      });
    }
    palm(20, 18); palm(342, -18);

    // 1986 Chrome & Neon Boardwalk Soda Counter
    var top = c.createLinearGradient(0, COUNTER_Y, 0, COUNTER_Y + 15);
    top.addColorStop(0, '#FFFFFF'); top.addColorStop(0.35, '#F4DCFA'); top.addColorStop(0.75, '#B7C8E6'); top.addColorStop(1, '#7D8AB0');
    c.fillStyle = top; c.fillRect(0, COUNTER_Y, W, 15);
    // dual neon under-counter edge lights
    c.fillStyle = '#2AF5E4'; c.fillRect(0, COUNTER_Y + 14, W, 2);
    c.fillStyle = '#FF3CAC'; c.shadowColor = '#FF3CAC'; c.shadowBlur = 10;
    c.fillRect(0, COUNTER_Y + 16, W, 3.2); c.shadowBlur = 0;

    var front = c.createLinearGradient(0, COUNTER_Y + 19, 0, H);
    front.addColorStop(0, '#441184'); front.addColorStop(0.55, '#250751'); front.addColorStop(1, '#11022A');
    c.fillStyle = front; c.fillRect(0, COUNTER_Y + 19, W, H - COUNTER_Y - 19);
    // retro cabana neon accent tiles
    for (var s = 0; s < W; s += 36) {
      c.fillStyle = (s / 36) % 2 ? 'rgba(42,245,228,.32)' : 'rgba(255,60,172,.32)';
      c.fillRect(s, COUNTER_Y + 20, 18, 5);
    }
    // glowing sign badge on counter front
    textAt(c, 'THIRSTY BEACHES', W / 2, COUNTER_Y + 41, '17px ' + BUNGEE, '#FFE14D', 'center', 'rgba(255,209,102,.85)');
    textAt(c, 'DIRTY SODAS  ·  SOFT SERVE  ·  COFFEE', W / 2, COUNTER_Y + 54, '700 9px ' + MONO, '#2AF5E4', 'center', 'rgba(42,245,228,.6)');
  }

  // ---------- ingredient art (centered at 0,0, radius r) ----------
  function swirl(c, r, base, shade, hi) {
    c.fillStyle = base; c.strokeStyle = shade; c.lineWidth = 2;
    ell(c, 0, r * 0.55, r * 0.94, r * 0.4); c.fill(); c.stroke();
    ell(c, 0, r * 0.12, r * 0.72, r * 0.35); c.fill(); c.stroke();
    ell(c, 0, -r * 0.26, r * 0.5, r * 0.31); c.fill(); c.stroke();
    c.beginPath(); c.moveTo(-r * 0.2, -r * 0.42); c.quadraticCurveTo(0, -r * 1.38, r * 0.2, -r * 0.46); c.closePath(); c.fill(); c.stroke();
    c.strokeStyle = hi; c.lineWidth = 2.2;
    c.beginPath(); c.moveTo(-r * 0.55, r * 0.48); c.quadraticCurveTo(-r * 0.08, r * 0.72, r * 0.52, r * 0.48); c.stroke();
    c.beginPath(); c.moveTo(-r * 0.4, r * 0.08); c.quadraticCurveTo(0, r * 0.3, r * 0.4, r * 0.08); c.stroke();
    // glossy sheen dot
    c.fillStyle = 'rgba(255,255,255,.6)';
    ell(c, -r * 0.32, r * 0.42, r * 0.16, r * 0.09); c.fill();
  }
  /* Vanilla soft serve: waffle cone, three tapering tiers, a curled tip. Fits the same r-sized box as the other icons (tip at -r, cone point at +r). */
  function softServeCone(c, r) {
    c.save(); c.lineJoin = 'round'; c.lineCap = 'round';
    // waffle cone wedge
    var cg = c.createLinearGradient(-r * 0.5, 0, r * 0.5, 0);
    cg.addColorStop(0, '#F2AE4C'); cg.addColorStop(0.5, '#FFD98A'); cg.addColorStop(1, '#C27A2C');
    c.beginPath(); c.moveTo(-r * 0.46, r * 0.2); c.lineTo(r * 0.46, r * 0.2); c.lineTo(0, r * 1.05); c.closePath();
    c.fillStyle = cg; c.fill(); c.lineWidth = 1.8; c.strokeStyle = '#7A4315'; c.stroke();
    c.save(); c.beginPath(); c.moveTo(-r * 0.46, r * 0.2); c.lineTo(r * 0.46, r * 0.2); c.lineTo(0, r * 1.05); c.closePath(); c.clip();
    c.strokeStyle = 'rgba(122,67,21,.7)'; c.lineWidth = 1.2; c.beginPath();
    for (var k = -2; k <= 2; k++) { c.moveTo(k * r * 0.3 - r * 0.5, r * 0.15); c.lineTo(k * r * 0.3 + r * 0.5, r * 1.1); c.moveTo(k * r * 0.3 + r * 0.5, r * 0.15); c.lineTo(k * r * 0.3 - r * 0.5, r * 1.1); }
    c.stroke(); c.restore();
    // three tiers, widest at the bottom
    var tiers = [[0.58, 0.04, 0.30], [0.46, -0.24, 0.28], [0.33, -0.48, 0.26]];
    for (var i = 0; i < tiers.length; i++) {
      var hw = tiers[i][0] * r, y0 = tiers[i][1] * r, hh = tiers[i][2] * r;
      var vg = c.createLinearGradient(-hw, 0, hw, 0);
      vg.addColorStop(0, '#FFFFFF'); vg.addColorStop(0.55, '#FFF6DC'); vg.addColorStop(1, '#E9D6A4');
      rr(c, -hw, y0, hw * 2, hh, hh * 0.5); c.fillStyle = vg; c.fill();
      c.lineWidth = 1.6; c.strokeStyle = '#B79B62'; c.stroke();
      c.strokeStyle = 'rgba(183,155,98,.55)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(-hw * 0.5, y0 + hh * 0.85); c.lineTo(hw * 0.3, y0 + hh * 0.12); c.stroke();
    }
    // curled tip
    c.beginPath(); c.moveTo(-r * 0.24, -r * 0.46);
    c.bezierCurveTo(-r * 0.2, -r * 0.78, r * 0.04, -r * 0.84, r * 0.2, -r * 1.02);
    c.bezierCurveTo(r * 0.3, -r * 0.82, r * 0.3, -r * 0.62, r * 0.24, -r * 0.46); c.closePath();
    var tg = c.createLinearGradient(-r * 0.2, 0, r * 0.3, 0); tg.addColorStop(0, '#FFFFFF'); tg.addColorStop(1, '#EBD9A8');
    c.fillStyle = tg; c.fill(); c.lineWidth = 1.6; c.strokeStyle = '#B79B62'; c.stroke();
    c.restore();
  }
  function drawKind(c, kind, r) {
    c.lineJoin = 'round'; c.lineCap = 'round';
    if (kind === 'ice') {
      var s = r * 0.8;
      c.save(); c.rotate(0.2);
      rr(c, -s, -s, s * 2, s * 2, s * 0.3);
      var gi = c.createLinearGradient(-s, -s, s, s);
      gi.addColorStop(0, '#FFFFFF'); gi.addColorStop(0.45, '#B8FAFF'); gi.addColorStop(1, '#3ED8EE');
      c.fillStyle = gi; c.fill(); c.lineWidth = 2.4; c.strokeStyle = '#FFFFFF'; c.stroke();
      // crisp ice crystal inner facet & sparkle
      c.fillStyle = 'rgba(255,255,255,.55)';
      rr(c, -s * 0.65, -s * 0.65, s * 0.75, s * 0.55, s * 0.15); c.fill();
      c.strokeStyle = 'rgba(18,120,155,.55)'; c.lineWidth = 1.9;
      c.beginPath(); c.moveTo(-s * 0.52, s * 0.15); c.lineTo(s * 0.15, -s * 0.52); c.stroke();
      c.beginPath(); c.moveTo(-s * 0.16, s * 0.52); c.lineTo(s * 0.52, -s * 0.16); c.stroke();
      c.restore();
    } else if (GOOD[kind] && /^(berry|coconut|mango|grape)$/.test(kind)) {
      c.beginPath(); c.moveTo(0, -r * 1.02);
      c.bezierCurveTo(r * 0.22, -r * 0.5, r * 0.88, -r * 0.1, r * 0.88, r * 0.3);
      c.arc(0, r * 0.3, r * 0.88, 0, Math.PI, false);
      c.bezierCurveTo(-r * 0.88, -r * 0.1, -r * 0.22, -r * 0.5, 0, -r * 1.02);
      c.closePath();
      var dg = c.createRadialGradient(-r * 0.28, -r * 0.1, r * 0.1, 0, r * 0.2, r * 1.1);
      dg.addColorStop(0, '#FFFFFF');
      dg.addColorStop(0.28, GOOD[kind].color);
      dg.addColorStop(1, '#2D0756');
      c.fillStyle = dg; c.fill(); c.lineWidth = 2.4; c.strokeStyle = '#160430'; c.stroke();
      c.fillStyle = 'rgba(255,255,255,.82)';
      ell(c, -r * 0.3, r * 0.08, r * 0.16, r * 0.32); c.fill();
    } else if (kind === 'cream') {
      softServeCone(c, r);
    } else if (kind === 'pineapple') {
      // soft serve in a crisp waffle cone with pineapple crown
      var cg = c.createLinearGradient(-r * 0.5, 0, r * 0.5, 0);
      cg.addColorStop(0, '#F7B759'); cg.addColorStop(0.45, '#FFE099'); cg.addColorStop(1, '#BA6C24');
      c.beginPath(); c.moveTo(-r * 0.54, r * 0.12); c.lineTo(r * 0.54, r * 0.12); c.lineTo(0, r * 1.08); c.closePath();
      c.fillStyle = cg; c.fill(); c.lineWidth = 2; c.strokeStyle = '#7A4315'; c.stroke();
      c.strokeStyle = 'rgba(122,67,21,.65)'; c.lineWidth = 1.4;
      c.beginPath(); c.moveTo(-r * 0.3, r * 0.15); c.lineTo(r * 0.2, r * 0.72); c.moveTo(r * 0.3, r * 0.15); c.lineTo(-r * 0.2, r * 0.72); c.stroke();
      c.save(); c.translate(0, -r * 0.34); swirl(c, r * 0.76, '#FFE14D', '#C98A00', 'rgba(255,255,255,.62)'); c.restore();
      c.strokeStyle = '#22C56A'; c.lineWidth = 3.4;
      [[-5, -2, -9, -12], [0, -3, 0, -15], [5, -2, 9, -12]].forEach(function (q) {
        c.beginPath(); c.moveTo(q[0] * r / 22, q[1] * r / 22 - r * 0.95); c.lineTo(q[2] * r / 22, q[3] * r / 22 - r * 0.95); c.stroke();
      });
    } else if (kind === 'cherry') {
      c.strokeStyle = '#2FCB6B'; c.lineWidth = 3;
      c.beginPath(); c.moveTo(-r * 0.35, r * 0.1); c.quadraticCurveTo(-r * 0.1, -r * 0.8, r * 0.1, -r * 0.95); c.stroke();
      c.beginPath(); c.moveTo(r * 0.4, r * 0.25); c.quadraticCurveTo(r * 0.3, -r * 0.7, r * 0.1, -r * 0.95); c.stroke();
      c.fillStyle = '#4ADE80'; ell(c, r * 0.32, -r * 0.86, r * 0.32, r * 0.15); c.fill();
      [[-r * 0.38, r * 0.38, r * 0.52], [r * 0.4, r * 0.5, r * 0.46]].forEach(function (p) {
        var chg = c.createRadialGradient(p[0] - p[2] * 0.3, p[1] - p[2] * 0.3, p[2] * 0.1, p[0], p[1], p[2]);
        chg.addColorStop(0, '#FF758F'); chg.addColorStop(0.45, '#EE1D47'); chg.addColorStop(1, '#7A0A1E');
        c.beginPath(); c.arc(p[0], p[1], p[2], 0, Math.PI * 2);
        c.fillStyle = chg; c.fill(); c.lineWidth = 2; c.strokeStyle = '#520618'; c.stroke();
        c.fillStyle = 'rgba(255,255,255,.82)'; ell(c, p[0] - p[2] * 0.34, p[1] - p[2] * 0.34, p[2] * 0.18, p[2] * 0.24); c.fill();
      });
    } else if (kind === 'sand') {
      c.beginPath();
      for (var i = 0; i <= 28; i++) {
        var th = i / 28 * Math.PI * 2;
        var rad = r * (0.82 + 0.16 * Math.sin(3 * th + 1) + 0.09 * Math.sin(5 * th));
        var px = Math.cos(th) * rad, py = Math.sin(th) * rad * 0.9;
        if (i) c.lineTo(px, py); else c.moveTo(px, py);
      }
      c.closePath();
      var sg = c.createRadialGradient(-r * 0.25, -r * 0.25, 2, 0, 0, r);
      sg.addColorStop(0, '#D4A56E'); sg.addColorStop(1, '#8A5D30');
      c.fillStyle = sg; c.fill(); c.lineWidth = 2.4; c.strokeStyle = '#4B2F16'; c.stroke();
      c.fillStyle = '#5E3F20';
      [[-8, -6, 2.5], [6, -9, 2], [3, 6, 3], [-10, 8, 2], [11, 2, 2]].forEach(function (p) { c.beginPath(); c.arc(p[0] * r / 22, p[1] * r / 22, p[2], 0, Math.PI * 2); c.fill(); });
    } else if (kind === 'flipflop') {
      c.save(); c.rotate(-0.35);
      ell(c, 0, 2, r * 0.58, r * 0.98);
      var fg = c.createLinearGradient(0, -r, 0, r);
      fg.addColorStop(0, '#2AF5E4'); fg.addColorStop(0.5, '#38BDF8'); fg.addColorStop(1, '#FF3CAC');
      c.fillStyle = fg; c.fill(); c.lineWidth = 2.4; c.strokeStyle = '#122548'; c.stroke();
      c.strokeStyle = '#FFD166'; c.lineWidth = 4.2;
      c.beginPath(); c.moveTo(0, -r * 0.55); c.lineTo(-r * 0.42, -r * 0.04); c.moveTo(0, -r * 0.55); c.lineTo(r * 0.42, -r * 0.04); c.moveTo(0, -r * 0.55); c.lineTo(0, -r * 0.76); c.stroke();
      c.restore();
    } else if (kind === 'feather') {
      c.save(); c.rotate(0.65);
      ell(c, 0, 0, r * 0.42, r * 1.0);
      var feg = c.createLinearGradient(-r * 0.4, -r, r * 0.4, r);
      feg.addColorStop(0, '#FFFFFF'); feg.addColorStop(1, '#CBD5E6');
      c.fillStyle = feg; c.fill(); c.lineWidth = 2.2; c.strokeStyle = '#74839B'; c.stroke();
      c.strokeStyle = '#5E6C84'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(0, -r * 1.05); c.lineTo(0, r * 1.15); c.stroke();
      for (var k = -2; k <= 2; k++) { c.beginPath(); c.moveTo(0, k * r * 0.3); c.lineTo(r * 0.3, k * r * 0.3 - r * 0.2); c.moveTo(0, k * r * 0.3); c.lineTo(-r * 0.3, k * r * 0.3 - r * 0.2); c.stroke(); }
      c.restore();
    }
  }

  // An item with its safety cues: needed = green tick + glow, junk = red X ring, safe (rush) = gold ring.
  function drawItem(c, it, view) {
    var r = ITEM_R;
    c.save();
    c.translate(it.x, it.y);
    c.globalAlpha = clamp((it.y - (SPAWN_Y - 6)) / 22, 0, 1);
    var junk = isJunk(it.kind);
    var cue = view.safe(it);
    if (it.golden) {
      c.shadowColor = '#FFD166'; c.shadowBlur = 20;
      c.strokeStyle = '#FFD166'; c.lineWidth = 3.2; c.beginPath(); c.arc(0, 0, r + 6, 0, Math.PI * 2); c.stroke();
      c.shadowBlur = 0;
    }
    if (cue === 'needed') {
      c.fillStyle = 'rgba(31,191,106,.16)';
      c.beginPath(); c.arc(0, 0, r + 5, 0, Math.PI * 2); c.fill();
      c.shadowColor = '#7CFFB2'; c.shadowBlur = 18;
      c.strokeStyle = '#7CFFB2'; c.lineWidth = 3.4; c.beginPath(); c.arc(0, 0, r + 5, 0, Math.PI * 2); c.stroke();
      c.shadowBlur = 0;
    } else if (cue === 'safe') {
      c.strokeStyle = 'rgba(255,225,77,.92)'; c.lineWidth = 3; c.setLineDash([5, 4]);
      c.beginPath(); c.arc(0, 0, r + 5, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
    } else if (junk) {
      c.fillStyle = 'rgba(224,45,75,.14)';
      c.beginPath(); c.arc(0, 0, r + 5, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#FF3355'; c.lineWidth = 3; c.setLineDash([4, 4]);
      c.beginPath(); c.arc(0, 0, r + 5, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
    }
    c.save();
    if (junk && cue !== 'safe') c.globalAlpha *= 0.94;
    drawKind(c, it.kind, r);
    c.restore();
    // badge
    var bx = r * 0.85, by = -r * 0.85;
    if (cue === 'needed') {
      c.beginPath(); c.arc(bx, by, 10, 0, Math.PI * 2); c.fillStyle = '#1FBF6A'; c.fill(); c.lineWidth = 2; c.strokeStyle = '#fff'; c.stroke();
      c.strokeStyle = '#fff'; c.lineWidth = 3; c.beginPath(); c.moveTo(bx - 4.5, by + 0.5); c.lineTo(bx - 1, by + 4); c.lineTo(bx + 5, by - 3.5); c.stroke();
    } else if (cue === 'junk') {
      c.beginPath(); c.arc(bx, by, 10, 0, Math.PI * 2); c.fillStyle = '#E02D4B'; c.fill(); c.lineWidth = 2; c.strokeStyle = '#fff'; c.stroke();
      c.strokeStyle = '#fff'; c.lineWidth = 3; c.beginPath(); c.moveTo(bx - 4, by - 4); c.lineTo(bx + 4, by + 4); c.moveTo(bx + 4, by - 4); c.lineTo(bx - 4, by + 4); c.stroke();
    }
    c.restore();
  }

  // ---------- the cup ----------
  function cupPath(c, cx, baseY, h, topW, botW) {
    c.beginPath(); c.moveTo(cx - topW / 2, baseY - h); c.lineTo(cx + topW / 2, baseY - h);
    c.lineTo(cx + botW / 2, baseY); c.lineTo(cx - botW / 2, baseY); c.closePath();
  }
  var LAYER_STYLE = {
    ice: ['#DCF9FF', '#7CE3F5'], berry: ['#FF7AD6', '#FF3CAC'], coconut: ['#7CFFF4', '#16D3C4'],
    mango: ['#FFCC7A', '#FF8E3C'], grape: ['#C49BFF', '#8A3FFC'], cream: ['#FFFFFF', '#F3DCEB'],
    cherry: ['#FF5E78', '#C8102E'], pineapple: ['#FFF08A', '#FFC400']
  };
  function drawCup(c, cx, baseY, layers, total, spoils, tilt, alpha) {
    var capacity = CUP_H - 10, per = capacity / Math.max(1, total);
    c.save();
    c.globalAlpha = alpha == null ? 1 : alpha;
    // soft reflection shadow on the chrome counter
    c.fillStyle = 'rgba(22,4,48,.35)';
    ell(c, cx, baseY + 3, CUP_BOT_W * 0.56, 4.5); c.fill();

    c.translate(cx, baseY); c.rotate(tilt || 0); c.translate(-cx, -baseY);
    // bendy neon striped straw
    c.strokeStyle = '#FF3CAC'; c.lineWidth = 6.5; c.lineCap = 'round'; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(cx + 15, baseY - 8); c.lineTo(cx + 28, baseY - CUP_H - 22); c.lineTo(cx + 40, baseY - CUP_H - 26); c.stroke();
    c.strokeStyle = '#FFF4FA'; c.lineWidth = 2.6; c.setLineDash([5, 6]);
    c.beginPath(); c.moveTo(cx + 15, baseY - 8); c.lineTo(cx + 28, baseY - CUP_H - 22); c.lineTo(cx + 40, baseY - CUP_H - 26); c.stroke(); c.setLineDash([]);

    // 3D shaded translucent glass body
    // frosted base: the glass is milky, not clear, so whatever stands behind it (the customer at the counter) never shows through the cup body
    cupPath(c, cx, baseY, CUP_H, CUP_TOP_W, CUP_BOT_W);
    var frost = c.createLinearGradient(0, baseY - CUP_H, 0, baseY);
    frost.addColorStop(0, 'rgb(214,236,250)'); frost.addColorStop(1, 'rgb(168,208,236)');
    c.fillStyle = frost; c.fill();
    cupPath(c, cx, baseY, CUP_H, CUP_TOP_W, CUP_BOT_W);
    var glass = c.createLinearGradient(cx - CUP_TOP_W / 2, 0, cx + CUP_TOP_W / 2, 0);
    glass.addColorStop(0, 'rgba(255,255,255,.32)');
    glass.addColorStop(0.28, 'rgba(255,244,250,.11)');
    glass.addColorStop(0.76, 'rgba(42,245,228,.12)');
    glass.addColorStop(1, 'rgba(255,255,255,.24)');
    c.fillStyle = glass; c.fill();

    c.save();
    cupPath(c, cx, baseY, CUP_H, CUP_TOP_W, CUP_BOT_W); c.clip();
    for (var i = 0; i < layers.length; i++) {
      var st = LAYER_STYLE[layers[i]] || ['#fff', '#ddd'];
      var y1 = baseY - i * per, y0 = y1 - per;
      var lg = c.createLinearGradient(0, y0, 0, y1); lg.addColorStop(0, st[0]); lg.addColorStop(1, st[1]);
      c.fillStyle = lg; c.fillRect(cx - 60, y0, 120, per + 0.8);
      // subtle curved highlight inside liquid
      c.fillStyle = 'rgba(255,255,255,.22)'; c.fillRect(cx - 32, y0, 12, per);
      c.fillStyle = 'rgba(255,255,255,.55)'; c.fillRect(cx - 60, y0, 120, 1.8);
      if (layers[i] === 'ice') {
        c.fillStyle = 'rgba(255,255,255,.78)';
        rr(c, cx - 20, y0 + per * 0.25, 10, 8, 2); c.fill();
        rr(c, cx + 8, y0 + per * 0.4, 9, 8, 2); c.fill();
      } else if (layers[i] === 'cherry') {
        c.fillStyle = '#FFE6EA'; c.beginPath(); c.arc(cx - 10, y0 + per * 0.5, 2.6, 0, Math.PI * 2); c.fill();
      }
    }
    if (spoils > 0) { c.fillStyle = 'rgba(78,52,22,' + (0.2 * spoils) + ')'; c.fillRect(cx - 60, baseY - CUP_H, 120, CUP_H); }
    c.restore();

    cupPath(c, cx, baseY, CUP_H, CUP_TOP_W, CUP_BOT_W);
    c.lineWidth = 3.2; c.strokeStyle = 'rgba(255,255,255,.95)'; c.lineJoin = 'round'; c.stroke();
    // glossy glass reflection bar
    c.strokeStyle = 'rgba(255,255,255,.62)'; c.lineWidth = 4;
    c.beginPath(); c.moveTo(cx - 33, baseY - CUP_H + 10); c.lineTo(cx - 25, baseY - 12); c.stroke();
    // glowing neon turquoise lid rim
    c.save();
    c.shadowColor = '#2AF5E4'; c.shadowBlur = 10;
    c.fillStyle = '#2AF5E4'; c.strokeStyle = '#160430'; c.lineWidth = 1.6;
    rr(c, cx - CUP_TOP_W / 2 - 5, baseY - CUP_H - 3.5, CUP_TOP_W + 10, 7, 3.5);
    c.fill(); c.shadowBlur = 0; c.stroke();
    c.fillStyle = 'rgba(255,255,255,.65)';
    c.fillRect(cx - CUP_TOP_W / 2 + 4, baseY - CUP_H - 1.8, CUP_TOP_W - 8, 1.8);
    c.restore();
    c.restore();
  }

  // ---------- 1986 Miami beachgoer customer behind the counter ----------
  var PALETTES = [
    { hair: '#3B146B', shirt: '#FF3CAC', stripe: '#2AF5E4', shades: '#2AF5E4', band: '#FFD166', skin: '#F4B68C' },
    { hair: '#FFB84D', shirt: '#2AF5E4', stripe: '#FF3CAC', shades: '#FF3CAC', band: '#FF3CAC', skin: '#E59F71' },
    { hair: '#C81D4E', shirt: '#FFD166', stripe: '#FF3CAC', shades: '#8A3FFC', band: '#2AF5E4', skin: '#F2B48C' },
    { hair: '#1B1330', shirt: '#8A3FFC', stripe: '#FFD166', shades: '#FFD166', band: '#FF7A45', skin: '#C68259' }
  ];
  function drawCustomer(c, x, mood, bob) {
    var p = PALETTES[g.customer % PALETTES.length];
    var y = COUNTER_Y - 1 + bob;
    c.save(); c.translate(x, y);

    if (ART.cust && ART.cust.complete && ART.cust.naturalWidth > 0) {
      // studio-illustrated 1986 Miami Beach surfer character standing behind the chrome counter!
      var cw = 84, ch = 95;
      var bounce = mood === 'happy' ? -6 : (mood === 'sad' ? 4 : 0);
      var tilt = mood === 'happy' ? Math.sin(g.moodT * 10) * 0.08 : (mood === 'worried' ? Math.sin(g.moodT * 14) * 0.04 : 0);
      c.save();
      c.translate(0, bounce);
      c.rotate(tilt);
      if (g.customer % 2 === 1) c.scale(-1, 1);
      // subtle neon rim glow matching customer's accent palette
      var ge = glowSprite(ART.cust, 'cust', cw, ch, p.shades, mood === 'happy' ? 16 : 6, 0, scale);   // glow baked once per colour/mood, not re-blurred every frame
      if (ge) stampGlow(c, ge, -cw / 2, -ch + 4, cw, ch);
      else c.drawImage(ART.cust, -cw / 2, -ch + 4, cw, ch);
      c.restore();
      // mood reaction sparkle / badge above head when happy or worried
      if (mood === 'happy') {
        textAt(c, '★', -34, -84, '18px ' + BUNGEE, '#FFD166', 'center', '#FF3CAC');
        textAt(c, '★', 34, -80, '15px ' + BUNGEE, '#2AF5E4', 'center', '#2AF5E4');
      } else if (mood === 'worried') {
        textAt(c, '!', 32, -82, '18px ' + BUNGEE, '#FF7A45', 'center', '#160430');
      }
      c.restore();
      return;
    }

    // cheering arms behind shoulders when happy (procedural fallback)
    if (mood === 'happy') {
      c.strokeStyle = p.skin; c.lineWidth = 7; c.lineCap = 'round';
      c.beginPath(); c.moveTo(-21, -24); c.lineTo(-34, -50); c.moveTo(21, -24); c.lineTo(34, -50); c.stroke();
      c.strokeStyle = '#160430'; c.lineWidth = 1.6;
      c.beginPath(); c.arc(-34, -51, 3.6, 0, Math.PI * 2); c.arc(34, -51, 3.6, 0, Math.PI * 2); c.fillStyle = p.skin; c.fill(); c.stroke();
    }

    // 80s Miami Vice beach tank top
    c.fillStyle = p.shirt; rr(c, -25, -34, 50, 38, 13); c.fill();
    c.save(); rr(c, -25, -34, 50, 38, 13); c.clip();
    c.fillStyle = p.stripe; c.fillRect(-26, -20, 52, 5);
    c.fillStyle = '#FFF4FA'; c.fillRect(-26, -15, 52, 2.5);
    c.restore();
    c.strokeStyle = '#160430'; c.lineWidth = 2.4; rr(c, -25, -34, 50, 38, 13); c.stroke();

    // neck
    c.fillStyle = p.skin; c.fillRect(-5.5, -38, 11, 8);

    // 80s back hair puff
    c.fillStyle = p.hair;
    c.beginPath(); c.arc(0, -56, 22, Math.PI * 0.85, Math.PI * 2.15); c.fill();
    c.strokeStyle = '#160430'; c.lineWidth = 2.2; c.stroke();

    // face
    c.fillStyle = p.skin; c.beginPath(); c.arc(0, -53, 18.5, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#160430'; c.lineWidth = 2.4; c.stroke();

    // rosy beach cheeks
    c.fillStyle = 'rgba(255,90,145,.32)';
    ell(c, -10.5, -47.5, 3.8, 2.2); c.fill();
    ell(c, 10.5, -47.5, 3.8, 2.2); c.fill();

    // 80s swept bangs + neon sweatband
    c.fillStyle = p.hair;
    c.beginPath(); c.arc(0, -58.5, 19, Math.PI * 1.02, -0.02); c.closePath(); c.fill(); c.stroke();
    c.fillStyle = p.band;
    rr(c, -18.5, -65, 37, 5.5, 2.5); c.fill();
    c.strokeStyle = '#160430'; c.lineWidth = 1.6; c.stroke();

    // rad 80s neon wrap-around shades with glossy glare
    c.fillStyle = '#12032E';
    rr(c, -16, -58, 32, 10.5, 4); c.fill();
    var sg = c.createLinearGradient(-14, -57, 14, -49);
    sg.addColorStop(0, p.shades); sg.addColorStop(0.55, '#FF3CAC'); sg.addColorStop(1, '#FFD166');
    c.fillStyle = sg;
    rr(c, -13.5, -56, 11.5, 6.8, 2); c.fill();
    rr(c, 2, -56, 11.5, 6.8, 2); c.fill();
    // sunglasses specular gleam
    c.fillStyle = 'rgba(255,255,255,.78)';
    c.fillRect(-11, -55, 3.5, 2); c.fillRect(4.5, -55, 3.5, 2);
    c.strokeStyle = '#160430'; c.lineWidth = 1.8; rr(c, -16, -58, 32, 10.5, 4); c.stroke();

    // expressive mouth
    c.strokeStyle = '#160430'; c.lineWidth = 2.4; c.beginPath();
    if (mood === 'happy') {
      c.fillStyle = '#FFF4FA';
      c.arc(0, -45, 7.5, 0.08, Math.PI - 0.08); c.closePath(); c.fill(); c.stroke();
    } else if (mood === 'sad') {
      c.arc(0, -37.5, 6.5, Math.PI + 0.3, -0.3); c.stroke();
    } else if (mood === 'worried') {
      c.moveTo(-6, -42); c.lineTo(6, -42); c.stroke();
    } else {
      c.arc(0, -46, 6, 0.2, Math.PI - 0.2); c.stroke();
    }
    c.restore();
  }

  // ---------- 1986 boardwalk diner order ticket ----------
  function drawTicket(c) {
    var t = g.ticket, p = g.prog;
    if (!t) return;
    var x = 8, y = 8, w = W - 16, h = 104;
    c.save();
    c.shadowColor = 'rgba(0,0,0,.55)'; c.shadowBlur = 12;
    rr(c, x, y, w, h, 12);
    var paper = c.createLinearGradient(0, y, 0, y + h);
    paper.addColorStop(0, '#FFFDF5'); paper.addColorStop(1, '#FFF1D4');
    c.fillStyle = paper; c.fill();
    c.shadowBlur = 0;

    c.save(); rr(c, x, y, w, h, 12); c.clip();
    var hdr = c.createLinearGradient(x, y, x + w, y);
    hdr.addColorStop(0, '#FF3CAC'); hdr.addColorStop(0.55, '#FF6B8A'); hdr.addColorStop(1, '#FF8F4C');
    c.fillStyle = hdr; c.fillRect(x, y, w, 21);
    c.fillStyle = 'rgba(255,255,255,.22)'; c.fillRect(x, y, w, 4);
    c.restore();

    c.lineWidth = 2.2; c.strokeStyle = '#160430'; rr(c, x, y, w, h, 12); c.stroke();
    textAt(c, 'ORDER #' + g.ticketNo, x + 12, y + 11.5, '12px ' + BUNGEE, '#FFFFFF', 'left', 'rgba(22,4,48,.5)');
    // spoil pips
    textAt(c, 'SPOILS', x + w - 72, y + 11.5, '700 9px ' + MONO, '#FFF4FA', 'right');
    for (var i = 0; i < MAX_SPOILS; i++) {
      c.beginPath(); c.arc(x + w - 56 + i * 16, y + 11.5, 5.5, 0, Math.PI * 2);
      if (i < p.spoils) { c.fillStyle = '#3A1D0A'; c.fill(); c.strokeStyle = '#FFD166'; c.lineWidth = 1.6; c.stroke(); }
      else { c.fillStyle = 'rgba(255,255,255,.26)'; c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.stroke(); }
    }
    // chips
    var n = t.needs.length, gap = 8, cw = Math.min(84, (w - 16 - gap * (n - 1)) / n);
    var startX = x + (w - (cw * n + gap * (n - 1))) / 2;
    for (var k = 0; k < n; k++) {
      var need = t.needs[k], got = p.got[need.kind], done = got >= need.n;
      var cx0 = startX + k * (cw + gap), cy0 = y + 25;
      rr(c, cx0, cy0, cw, 50, 9);
      c.fillStyle = done ? 'rgba(31,191,106,.24)' : 'rgba(22,4,48,.07)'; c.fill();
      c.lineWidth = 2; c.strokeStyle = done ? '#1FBF6A' : 'rgba(22,4,48,.48)'; c.stroke();
      c.save(); c.translate(cx0 + 20, cy0 + 19); drawKind(c, need.kind, 13); c.restore();
      textAt(c, got + '/' + need.n, cx0 + cw - 8, cy0 + 19, '16px ' + BUNGEE, done ? '#0E7A44' : '#160430', 'right');
      if (done) {
        c.strokeStyle = '#1FBF6A'; c.lineWidth = 3.5; c.beginPath();
        c.moveTo(cx0 + cw - 20, cy0 + 40); c.lineTo(cx0 + cw - 16, cy0 + 44); c.lineTo(cx0 + cw - 9, cy0 + 37); c.stroke();
      }
      var lab = GOOD[need.kind].label.toUpperCase();
      if (lab.length > 11) lab = lab.replace('PINEAPPLE SOFT SERVE', 'PINEAPPLE SOFT');
      textAt(c, lab, cx0 + cw / 2, cy0 + 40, '700 9px ' + MONO, '#160430', 'center');
    }
    // melt bar
    var frac = clamp(g.left / g.limit, 0, 1), bx = x + 52, bw = w - 64, by = y + h - 12;
    textAt(c, 'MELT', x + 12, by + 4, '700 9px ' + MONO, '#160430', 'left');
    rr(c, bx, by - 1, bw, 10, 5); c.fillStyle = 'rgba(22,4,48,.16)'; c.fill();
    if (frac > 0) {
      var mg = c.createLinearGradient(bx, 0, bx + bw, 0);
      mg.addColorStop(0, frac > 0.3 ? '#2AF5E4' : '#FF7A45'); mg.addColorStop(1, frac > 0.3 ? '#68D8FF' : '#FF3CAC');
      rr(c, bx, by - 1, Math.max(8, bw * frac), 10, 5); c.fillStyle = mg; c.fill();
    }
    c.lineWidth = 1.5; c.strokeStyle = '#160430'; rr(c, bx, by - 1, bw, 10, 5); c.stroke();
    if (frac > 0.5) textAt(c, 'SPEED TIP', bx + bw - 6, by + 4, '700 8px ' + MONO, '#160430', 'right');
    c.restore();
    // rush meter under the ticket
    if (g.rush > 0) {
      var rw = (W - 16) * (g.rush / RUSH_SECONDS);
      c.fillStyle = '#FFE14D'; c.fillRect(8, 114, rw, 4);
    }
  }

  // ---------- floating text and particles ----------
  function pop(x, y, text, color, big) {
    g.texts.push({ x: x, y: y, text: text, color: color || '#FFF4FA', t: 0, life: reduced ? 0.9 : 1.0, big: !!big });
  }
  function burst(x, y, color, n) {
    if (reduced) return;
    for (var i = 0; i < n; i++) {
      var a = rng() * Math.PI * 2, s = 60 + rng() * 140;
      g.parts.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 50, t: 0, life: 0.5 + rng() * 0.3, color: color });
    }
  }

  // ---------- render ----------
  var view = {
    safe: function (it) {
      var needed = isGood(it.kind) && remainingOf(g.prog, it.kind) > 0;
      if (needed) return 'needed';
      if (it.safe || g.rush > 0) return 'safe';
      return isJunk(it.kind) ? 'junk' : 'plain';
    }
  };
  function render() {
    if (!bgCanvas) return;
    var c = ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(bgCanvas, 0, 0);
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.save();
    if (g.shake > 0 && !reduced) c.translate((rng() - 0.5) * g.shake * 10, (rng() - 0.5) * g.shake * 10);

    // customer
    var bob = reduced ? 0 : Math.sin(g.moodT * 6) * (g.mood === 'happy' ? 3 : 0);
    drawCustomer(c, 296, g.mood, bob);

    // rush banner sits behind the falling items so nothing is hidden
    if (g.rushBanner > 0) {
      c.globalAlpha = clamp(g.rushBanner / 0.5, 0, 1);
      c.lineWidth = 6; c.strokeStyle = '#160430'; c.font = '32px ' + BUNGEE; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.strokeText('RUSH HOUR!', W / 2, 160); c.fillStyle = '#FFE14D'; c.fillText('RUSH HOUR!', W / 2, 160);
      c.font = '700 12px ' + MONO; c.lineWidth = 4;
      c.strokeText('everything is safe to catch', W / 2, 188); c.fillStyle = '#FFF4FA'; c.fillText('everything is safe to catch', W / 2, 188);
      c.globalAlpha = 1;
    }
    // items
    if (g.prog) for (var i = 0; i < g.items.length; i++) drawItem(c, g.items[i], view);

    // served cup sliding to the customer
    if (g.served1) {
      var s = g.served1, k = clamp(s.t / 0.7, 0, 1), e = k * k * (3 - 2 * k);
      var sx = s.x + (292 - s.x) * e;
      drawCup(c, sx, CUP_BASE, s.layers, s.total, 0, 0, 1 - clamp((s.t - 0.7) / 0.35, 0, 1));
    }
    // dumped cup tipping off the counter
    if (g.dumped) {
      var d = g.dumped, dk = d.t;
      c.save();
      c.globalAlpha = 1 - clamp((dk - 0.5) / 0.4, 0, 1);
      c.translate(d.x, CUP_BASE + dk * dk * 220);
      c.rotate(dk * 2.2);
      drawCup(c, 0, 0, d.layers, d.total, MAX_SPOILS, 0, 1);
      c.restore();
    }

    // the player's cup
    if (g.prog) {
      var tilt = reduced ? 0 : clamp(g.cupV * 0.0004, -0.16, 0.16);
      drawCup(c, g.cupX, CUP_BASE, g.layers, g.prog.total, g.prog.spoils, tilt, 1);
    }

    // particles and texts
    for (var p = 0; p < g.parts.length; p++) {
      var pt = g.parts[p];
      c.globalAlpha = clamp(1 - pt.t / pt.life, 0, 1);
      c.fillStyle = pt.color; c.fillRect(pt.x - 2, pt.y - 2, 4, 4);
    }
    c.globalAlpha = 1;
    for (var q = 0; q < g.texts.length; q++) {
      var tx = g.texts[q];
      c.globalAlpha = clamp(1 - tx.t / tx.life, 0, 1);
      var rise = reduced ? 0 : tx.t * 42;
      c.lineWidth = 4; c.strokeStyle = '#160430'; c.font = (tx.big ? '18px ' : '14px ') + BUNGEE; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.strokeText(tx.text, clamp(tx.x, 50, W - 50), tx.y - rise);
      c.fillStyle = tx.color; c.fillText(tx.text, clamp(tx.x, 50, W - 50), tx.y - rise);
    }
    c.globalAlpha = 1;
    c.restore();

    drawTicket(c);

    // banners
    if (g.rush > 0) {
      c.strokeStyle = 'rgba(255,225,77,.85)'; c.lineWidth = 6; c.strokeRect(3, 3, W - 6, H - 6);
    }
    if (g.hint > 0 && g.mode === 'playing' && g.served === 0) {
      c.globalAlpha = clamp(g.hint / 1.5, 0, 1);
      c.lineWidth = 4; c.strokeStyle = '#160430'; c.font = '700 12px ' + MONO; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.strokeText('Catch the items with a green tick', W / 2, 146); c.fillStyle = '#7CFFB2'; c.fillText('Catch the items with a green tick', W / 2, 146);
      c.globalAlpha = 1;
    }
    if (g.flashSpoil > 0 && !reduced) {
      c.fillStyle = 'rgba(224,45,75,' + (g.flashSpoil * 0.35) + ')'; c.fillRect(0, 0, W, H);
    }
  }

  // ---------- HUD ----------
  function setHud() {
    els.score.textContent = String(g.score);
    els.best.textContent = String(Math.max(g.best, g.score));
    els.combo.textContent = 'x' + comboMultiplier(g.combo);
    var hearts = els.lives.children;
    for (var i = 0; i < hearts.length; i++) hearts[i].classList.toggle('is-lost', i >= g.lives);
    els.lives.setAttribute('aria-label', g.lives + ' lives left');
  }

  // ---------- game flow ----------
  function newTicket() {
    g.ticketNo++;
    g.ticket = ticketForLevel(level(g.served), rng);
    g.prog = newProgress(g.ticket);
    g.limit = ticketTime(g.ticket.total, level(g.served));
    g.left = g.limit;
    g.layers = [];
    announce('Order ' + g.ticketNo + ': ' + ticketText(g.ticket));
  }
  function resetGame() {
    g.score = 0; g.lives = START_LIVES; g.served = 0; g.combo = 0; g.maxCombo = 0;
    g.ticketNo = 0; g.items = []; g.spawnT = 0.9; g.sinceNeeded = 0; g.rush = 0; g.rushBanner = 0;
    g.texts = []; g.parts = []; g.served1 = null; g.dumped = null; g.shake = 0; g.flashSpoil = 0;
    g.hint = 6; g.mood = 'idle'; g.moodT = 0; g.customer = Math.floor(rng() * PALETTES.length); g.isNewBest = false;
    g.cupX = W / 2; g.targetX = W / 2; g.cupV = 0;
    newTicket();
    setHud();
  }
  function showOverlay(which) {
    els.start.hidden = which !== 'start';
    els.pause.hidden = which !== 'pause';
    els.over.hidden = which !== 'over';
  }
  function setPlayingClass(on) { document.body.classList.toggle('is-playing', on); }

  function startGame() {
    unlockAudio();
    setDifficulty(root.TBK && typeof root.TBK.difficulty === 'function' ? root.TBK.difficulty() : 'classic');   // the table is fixed for this whole run
    resetGame();
    g.mode = 'playing';
    showOverlay(null);
    setPlayingClass(true);
    try {
      // keep the whole cabinet on screen: top of the page when it fits, otherwise the cabinet's top edge
      var cab = document.querySelector('.cabinet').getBoundingClientRect();
      if (cab.bottom - cab.top + 12 <= root.innerHeight) root.scrollTo(0, 0);
      else root.scrollTo(0, Math.max(0, root.scrollY + cab.top - 6));
    } catch (e) { /* scrolling is a nicety */ }
    sfx.click();
    try { canvas.focus({ preventScroll: true }); } catch (e) { /* focus is a nicety */ }
    if (root.TBK) root.TBK.runStart('cup-catch');
    startLoop();
  }
  function pauseGame() {
    if (g.mode !== 'playing') return;
    g.mode = 'paused';
    if (root.TBMusic) root.TBMusic.setPaused(true);
    stopLoop();
    showOverlay('pause');
    els.btnPause.textContent = 'Resume';
    setPlayingClass(false);
    announce('Paused');
    render();
    try { els.btnResume.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  function resumeGame() {
    if (g.mode !== 'paused') return;
    unlockAudio();
    g.mode = 'playing';
    if (root.TBMusic) root.TBMusic.setPaused(false);
    showOverlay(null);
    els.btnPause.textContent = 'Pause';
    setPlayingClass(true);
    announce('Resumed');
    startLoop();
    try { canvas.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  function finishGame() {
    g.mode = 'over';
    stopLoop();
    setPlayingClass(false);
    var wasBest = g.score > g.best;
    if (wasBest) { g.best = g.score; saveBest(g.best); }
    g.isNewBest = wasBest && g.score > 0;
    setHud();
    els.overScore.textContent = String(g.score);
    els.overBest.textContent = g.isNewBest ? 'New best!' : 'Best ' + g.best;
    els.overMeta.textContent = 'Drinks served ' + g.served + ' · Top combo ' + g.maxCombo;
    showOverlay('over');
    els.btnPause.textContent = 'Pause';
    announce('Game over. Score ' + g.score + '. ' + els.overBest.textContent);
    if (root.TBK) root.TBK.runEnd();
    render();
    try { els.btnAgain.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  function serveTicket() {
    var comp = completionScore(g.prog.total, g.left > 0 ? g.left / g.limit : 0);
    g.score += comp.total;
    g.served1 = { x: g.cupX, t: 0, layers: g.layers.slice(), total: g.prog.total };
    pop(W / 2, 262, 'SERVED! +' + comp.base, '#7CFFB2', true);
    if (comp.tip > 0) pop(W / 2, 290, 'SPEED TIP +' + comp.tip, '#FFD166', false);
    else pop(W / 2, 290, 'melted a bit, still yum', '#FFF4FA', false);
    burst(296, COUNTER_Y - 60, '#FFD166', 18);
    g.mood = 'happy'; g.moodT = 0;
    sfx.serve();
    g.served++;
    announce('Drink served. Score ' + g.score);
    if (shouldRush(g.served)) startRush();
    g.customer = (g.customer + 1) % PALETTES.length;
    newTicket();
  }
  function startRush() {
    g.rush = RUSH_SECONDS; g.rushBanner = 2.2;
    g.items.forEach(function (it) { it.safe = true; });
    sfx.rush();
    announce('Rush hour. Everything is safe to catch.');
  }
  function dumpDrink() {
    g.lives--;
    g.dumped = { x: g.cupX, t: 0, layers: g.layers.slice(), total: g.prog.total };
    g.shake = 1; g.flashSpoil = 1; g.combo = 0;
    pop(W / 2, 262, 'DRINK DUMPED!', '#FF5C7A', true);
    g.mood = 'sad'; g.moodT = 0;
    sfx.dump();
    setHud();
    if (g.lives <= 0) {
      g.mode = 'ending'; g.endT = reduced ? 0.7 : 1.1;
      g.layers = [];
      announce('Out of lives');
    } else {
      announce('Drink dumped. ' + g.lives + ' lives left.');
      newTicket();
    }
  }

  function handleCatch(it) {
    var res = resolveCatch(g.prog, it, { combo: g.combo, rush: g.rush > 0 });
    var prevMult = comboMultiplier(g.combo);
    g.prog = res.progress;
    g.combo = res.combo;
    if (g.combo > g.maxCombo) g.maxCombo = g.combo;
    g.score += res.points;
    var x = g.cupX, y = RIM_Y - 12;
    if (res.outcome === 'fill') {
      g.layers.push(it.kind);
      g.sinceNeeded = 0;
      pop(x, y, '+' + res.points, it.golden ? '#FFD166' : '#7CFFB2', it.golden);
      burst(x, RIM_Y, GOOD[it.kind].color, it.golden ? 14 : 6);
      if (it.golden) sfx.golden(); else sfx.good(g.combo);
      if (res.multiplier > prevMult) pop(x, y - 24, 'COMBO x' + res.multiplier + '!', '#FF6FC4', true);
      if (res.complete) serveTicket();
    } else if (res.outcome === 'safe') {
      pop(x, y, '+' + res.points, '#FFE14D', false);
      burst(x, RIM_Y, '#FFE14D', 4);
      sfx.safe();
    } else {
      var msg = res.reason === 'junk' ? 'YUCK!' : (res.reason === 'extra' ? 'TOO MUCH!' : 'NOT ON TICKET');
      pop(x, y, msg, '#FF5C7A', true);
      g.shake = Math.max(g.shake, 0.5); g.flashSpoil = Math.max(g.flashSpoil, 0.6);
      g.mood = res.dumped ? 'sad' : 'worried'; g.moodT = 0;
      sfx.spoil();
      if (res.dumped) dumpDrink();
    }
    setHud();
  }

  function spawn() {
    var inFlight = {};
    g.items.forEach(function (it) { inFlight[it.kind] = (inFlight[it.kind] || 0) + 1; });
    var pick = pickSpawn(g.prog, level(g.served), rng, { rush: g.rush > 0, sinceNeeded: g.sinceNeeded, inFlight: inFlight });
    var x = 0;
    for (var tries = 0; tries < 6; tries++) {
      x = 32 + rng() * (W - 64);
      if (Math.abs(x - g.lastX) >= 60) break;
    }
    g.lastX = x;
    if (pick.needed) g.sinceNeeded = 0; else g.sinceNeeded++;
    g.items.push({
      kind: pick.kind, golden: pick.golden, safe: g.rush > 0,
      x: x, y: SPAWN_Y, prevY: SPAWN_Y, wob: rng() * 6.28
    });
  }

  function update(dt) {
    g.moodT += dt;
    if (g.moodT > 1.4 && g.mood !== 'idle') { g.mood = g.prog && g.prog.spoils >= 2 ? 'worried' : 'idle'; }
    if (g.mode === 'ending') {
      g.endT -= dt;
      fxUpdate(dt);
      if (g.endT <= 0) finishGame();
      return;
    }
    // cup follows the finger directly with a light smoothing; keyboard nudges the target
    var kd = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    if (kd) g.targetX = clamp(g.targetX + kd * 560 * dt, CUP_TOP_W / 2, W - CUP_TOP_W / 2);
    var nx = g.cupX + (g.targetX - g.cupX) * (1 - Math.exp(-dt * 22));
    g.cupV = (nx - g.cupX) / Math.max(dt, 0.001);
    g.cupX = nx;

    g.left = Math.max(0, g.left - dt);
    if (g.rush > 0) { g.rush = Math.max(0, g.rush - dt); }
    if (g.rushBanner > 0) g.rushBanner -= dt;
    if (g.hint > 0) g.hint -= dt;

    var d = difficulty(level(g.served));
    g.spawnT -= dt;
    if (g.spawnT <= 0) {
      spawn();
      g.spawnT += d.interval * (g.rush > 0 ? 0.5 : 1);
    }

    var fall = d.fall;
    for (var i = g.items.length - 1; i >= 0; i--) {
      var it = g.items[i];
      it.prevY = it.y;
      it.y += fall * dt * (g.rush > 0 ? 0.9 : 1);
      if (caughtBy(it.prevY, it.y, it.x, ITEM_R, RIM_Y, g.cupX, CUP_TOP_W / 2)) {
        g.items.splice(i, 1);
        handleCatch(it);
        if (g.mode === 'ending') return;
        continue;
      }
      if (it.y > COUNTER_Y - 4) {
        if (!reduced) burst(it.x, COUNTER_Y - 6, '#E8B98A', 3);
        g.items.splice(i, 1);
      }
    }
    fxUpdate(dt);
  }
  function fxUpdate(dt) {
    var i;
    for (i = g.texts.length - 1; i >= 0; i--) { g.texts[i].t += dt; if (g.texts[i].t > g.texts[i].life) g.texts.splice(i, 1); }
    for (i = g.parts.length - 1; i >= 0; i--) {
      var p = g.parts[i]; p.t += dt; p.vy += 420 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.t > p.life) g.parts.splice(i, 1);
    }
    if (g.served1) { g.served1.t += dt; if (g.served1.t > 1.1) g.served1 = null; }
    if (g.dumped) { g.dumped.t += dt; if (g.dumped.t > 1.0) g.dumped = null; }
    g.shake = Math.max(0, g.shake - dt * 3);
    g.flashSpoil = Math.max(0, g.flashSpoil - dt * 2.5);
  }

  // ---------- loop (runs only while playing or ending) ----------
  function frame(ts) {
    rafId = 0;
    if (g.mode !== 'playing' && g.mode !== 'ending') return;
    var dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
    lastTs = ts;
    update(dt);
    render();
    if (g.mode === 'playing' || g.mode === 'ending') rafId = root.requestAnimationFrame(frame);
  }
  function startLoop() { if (!rafId) { lastTs = 0; rafId = root.requestAnimationFrame(frame); } }
  function stopLoop() { if (rafId) { root.cancelAnimationFrame(rafId); rafId = 0; } }

  // ---------- input ----------
  function logicalX(ev) {
    var rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(W, (ev.clientX - rect.left) / rect.width * W));
  }
  function setTarget(ev) {
    g.targetX = clamp(logicalX(ev), CUP_TOP_W / 2, W - CUP_TOP_W / 2);
  }
  // Steer from the whole play surface (the board AND the lower control strip), with ONE pointer at a time: a second finger, a palm or a sleeve
  // never takes the cup over, and lifting a stray finger never lets go of the real one.
  var surface = document.getElementById('cupSurface') || board;
  var dragId = null;
  surface.addEventListener('pointerdown', function (ev) {
    unlockAudio();
    if (g.mode !== 'playing') return;
    if (ev.target && ev.target.closest && ev.target.closest('button')) return;
    if (root.TBK && root.TBK.isStray(ev)) return;
    if (dragId !== null) return;
    dragId = ev.pointerId;
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    setTarget(ev);
    ev.preventDefault();
  });
  surface.addEventListener('pointermove', function (ev) {
    if (g.mode !== 'playing') return;
    if (ev.pointerId === dragId) { setTarget(ev); ev.preventDefault(); }
  });
  function endDrag(ev) { if (ev && ev.pointerId !== dragId) return; dragId = null; }
  surface.addEventListener('pointerup', endDrag);
  surface.addEventListener('pointercancel', endDrag);
  surface.addEventListener('lostpointercapture', endDrag);
  root.addEventListener('blur', function () { dragId = null; });
  surface.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
  // no page scroll or pinch zoom while a round is on
  document.addEventListener('touchmove', function (ev) {
    if (g.mode === 'playing' || g.mode === 'ending') ev.preventDefault();
  }, { passive: false });
  ['gesturestart', 'gesturechange'].forEach(function (n) {
    document.addEventListener(n, function (ev) { if (g.mode === 'playing') ev.preventDefault(); });
  });

  document.addEventListener('keydown', function (ev) {
    var k = ev.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') { keys.left = true; if (g.mode === 'playing') ev.preventDefault(); unlockAudio(); }
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') { keys.right = true; if (g.mode === 'playing') ev.preventDefault(); unlockAudio(); }
    else if ((k === 'p' || k === 'P' || k === 'Escape') && !ev.repeat) {
      if (g.mode === 'playing') pauseGame(); else if (g.mode === 'paused') resumeGame();
    }
  });
  document.addEventListener('keyup', function (ev) {
    var k = ev.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.left = false;
    if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.right = false;
  });
  root.addEventListener('blur', function () { keys.left = false; keys.right = false; });

  document.addEventListener('visibilitychange', function () { if (document.hidden) pauseGame(); });
  root.addEventListener('pagehide', pauseGame);

  els.btnStart.addEventListener('click', startGame);
  els.btnAgain.addEventListener('click', startGame);
  els.btnResume.addEventListener('click', resumeGame);
  els.btnPause.addEventListener('click', function () {
    unlockAudio();
    if (g.mode === 'playing') pauseGame(); else if (g.mode === 'paused') resumeGame();
  });
  function syncSoundBtn() {
    els.btnSound.textContent = sound.on ? 'Sound On' : 'Sound Off';
    els.btnSound.setAttribute('aria-pressed', sound.on ? 'true' : 'false');
  }
  els.btnSound.addEventListener('click', function () {
    sound.on = !sound.on;
    saveSound(sound.on);
    syncSoundBtn();
    if (root.TBMusic) root.TBMusic.setMuted(!sound.on);
    if (sound.on) { unlockAudio(); sfx.click(); }
  });

  // ---------- boot ----------
  syncSoundBtn();
  if (root.TBK) { root.TBK.onEnd(pauseGame); root.TBK.onAgain(startGame); }
  resetGame(); // the idle board shows the first order ticket so the first frame is not empty
  setHud();
  showOverlay('start');
  resize();
  if ('ResizeObserver' in root) new root.ResizeObserver(function () { resize(); }).observe(board);
  root.addEventListener('resize', resize);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { buildBackground(); render(); });

  // Read-only snapshot for automated checks.
  api.snapshot = function () {
    return {
      mode: g.mode, score: g.score, lives: g.lives, combo: g.combo, served: g.served, level: level(g.served),
      spoils: g.prog ? g.prog.spoils : 0, rush: g.rush, cupX: g.cupX, left: g.left, limit: g.limit,
      ticket: g.ticket ? ticketText(g.ticket) : '', filled: g.prog ? g.prog.filled : 0,
      items: g.items.map(function (it) {
        return { kind: it.kind, x: it.x, y: it.y, golden: it.golden, needed: !!g.prog && isGood(it.kind) && remainingOf(g.prog, it.kind) > 0 };
      })
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
