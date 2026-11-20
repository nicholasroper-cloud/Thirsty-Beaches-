/* Thirsty Beaches: THIRSTY BLASTER
 *
 * Purpose: a play-for-fun cup-filling arcade game. Slide a soda nozzle along the sand, squirt streams up at
 * empty cups drifting down on parachutes, beach balls and pool floats, and fill them before they land.
 *
 * Layout of this file:
 *   1. Pure game core (no DOM, no network, no storage). Exported for tests via module.exports: wave
 *      generation, scoring, fill math and a fixed-step simulation (createGame / update).
 *   2. Browser shell (canvas renderer, input, Web Audio blips, HUD, overlays), started only when the page
 *      has the #tbCanvas element.
 *
 * Security / privacy: no external network calls, no cookies, no personal data. The only storage is one numeric best
 * score in localStorage, wrapped in try/catch. All text goes through textContent; no HTML is ever built.
 * Kiosk copy: a finished game asks the kiosk server for ONE prize roll (kgame.js); the page never sends a score, prize or code.
 */
(function (root) {
  'use strict';

  /* ============================== 1. PURE GAME CORE ============================== */

  const W = 360;            // logical board width
  const H = 540;            // logical board height
  const GROUND = 470;       // cups that reach this line have landed on the sand
  const NOZ_TIP_Y = 474;    // droplets leave the nozzle here
  const NOZ_HALF = 24;      // half width of the nozzle body
  const FIRE_INTERVAL = 0.1;   // seconds between droplets (10 a second)
  const DROP_SPEED = 600;      // logical units per second
  const NOZ_GLIDE = 1100;      // how fast the nozzle chases a finger or mouse
  const NOZ_KEY = 340;         // keyboard speed
  const INTRO = 2.0;           // wave banner time before the first cup of a wave
  const START_LIVES = 3;
  const ICE_SECS = 6;
  const CREAM_SECS = 8;
  const ICE_SLOW = 0.4;
  const STEP = 1 / 60;

  const FLAVORS = [
    { id: 'cherry', name: 'Cherry', letter: 'C', color: '#FF3CAC' },
    { id: 'wave', name: 'Blue Wave', letter: 'B', color: '#2AF5E4' },
    { id: 'mango', name: 'Mango', letter: 'M', color: '#FFB02E' },
    { id: 'grape', name: 'Grape', letter: 'G', color: '#A56BFF' }
  ];

  // cap = droplets needed to fill, pts = points for a pop, w/h = drawn size (also the hit box)
  const SIZES = {
    small: { cap: 4, pts: 10, w: 28, h: 34 },
    medium: { cap: 6, pts: 25, w: 38, h: 46 },
    large: { cap: 10, pts: 50, w: 50, h: 60 }
  };

  const CARRIERS = ['parachute', 'ball', 'float'];
  const CARRIER_SPEED = { parachute: 0.8, ball: 1, float: 1.1 };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // Small seeded generator so waves are reproducible in tests and varied in play.
  function makeRng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function isHappyHour(n) { return n >= 4 && n % 4 === 0; }

  // How hard a wave is. Gentle at the start, faster and denser as waves climb, capped so it stays playable.
  function waveParams(n) {
    n = Math.max(1, Math.floor(n) || 1);
    const happy = isHappyHour(n);
    const speed = Math.min(110, 36 + 6 * (n - 1));
    if (happy) {
      return { n, happy: true, cups: 14, interval: 0.5, speed: Math.min(80, speed), pLarge: 0, pMedium: 0.3 };
    }
    return {
      n, happy: false,
      cups: Math.min(24, 6 + 2 * (n - 1)),
      interval: Math.max(0.8, 2.2 - 0.18 * (n - 1)),
      speed,
      pLarge: clamp((n - 2) * 0.07, 0, 0.3),
      pMedium: clamp(0.1 + (n - 1) * 0.07, 0, 0.45)
    };
  }

  function fillFraction(hits, cap) { return cap > 0 ? clamp(hits / cap, 0, 1) : 0; }

  // Matching flavor means most of the droplets that went in were the cup's own flavor.
  function isMatch(matchHits, hits) { return hits > 0 && matchHits * 2 > hits; }

  function popScore(size, match, happy) {
    const s = SIZES[size];
    return s ? s.pts * (match ? 2 : 1) * (happy ? 2 : 1) : 0;
  }

  function waveBonus(n) { return 10 * Math.max(1, n | 0); }

  // The full schedule for one wave: when each cup, pickup, seagull and umbrella shows up, and how it moves.
  function buildWave(n, rng) {
    const p = waveParams(n);
    rng = rng || Math.random;
    const events = [];
    let t = 0.6;
    for (let i = 0; i < p.cups; i++) {
      const r = rng();
      let size = 'small';
      if (n === 1 && i === p.cups - 1) size = 'medium';
      else if (r < p.pLarge) size = 'large';
      else if (r < p.pLarge + p.pMedium) size = 'medium';
      const carrier = CARRIERS[Math.floor(rng() * CARRIERS.length) % CARRIERS.length];
      // golden-ratio spread so neighbours rarely line up, plus jitter
      const x0 = 44 + (((i * 0.618034 + rng() * 0.22) % 1) * (W - 88));
      let amp, freq;
      if (carrier === 'parachute') { amp = 22 + rng() * 26; freq = 0.8 + rng() * 0.4; }
      else if (carrier === 'ball') { amp = 10 + rng() * 18; freq = 1.4 + rng() * 0.8; }
      else { amp = 14 + rng() * 20; freq = 1.0 + rng() * 0.6; }
      events.push({
        kind: 'cup', t, size, carrier, x0, amp, freq,
        phase: rng() * Math.PI * 2,
        drift: (rng() - 0.5) * 28,
        vyMul: 0.9 + rng() * 0.2,
        flavor: Math.floor(rng() * FLAVORS.length) % FLAVORS.length
      });
      t += p.interval * (0.8 + rng() * 0.4);
    }
    const span = Math.max(3, t);

    function pickupType() {
      const r = rng();
      return r < 0.4 ? 'ice' : r < 0.75 ? 'cream' : 'pineapple';
    }
    if (p.happy) {
      events.push({ kind: 'pickup', type: 'pineapple', t: span * 0.45, x: 60 + rng() * 240 });
    } else {
      events.push({ kind: 'pickup', type: n === 1 ? 'cream' : pickupType(), t: 3 + rng() * Math.max(1, span * 0.5 - 3), x: 40 + rng() * 280 });
      if (n >= 6) events.push({ kind: 'pickup', type: pickupType(), t: span * 0.5 + rng() * span * 0.3, x: 40 + rng() * 280 });
    }
    if (!p.happy && n >= 2) {
      const gulls = n < 6 ? 1 : 2;
      for (let i = 0; i < gulls; i++) {
        events.push({ kind: 'gull', t: span * (0.25 + 0.3 * i) + rng() * 2, side: rng() < 0.5 ? -1 : 1, tries: 0 });
      }
    }
    if (!p.happy && n >= 3) {
      events.push({ kind: 'umbrella', t: span * 0.2 + rng() * span * 0.3, side: rng() < 0.5 ? -1 : 1, y: 270 + rng() * 90, tries: 0 });
    }
    return { params: p, events };
  }

  function createGame(opts) {
    opts = opts || {};
    const g = {
      rng: makeRng(opts.seed == null ? 1 : opts.seed),
      state: 'playing',          // playing | over
      time: 0,
      score: 0,
      lives: START_LIVES,
      wave: 0,
      happy: false,
      params: null,
      nozzle: { x: W / 2 },
      flavor: opts.flavor | 0,
      fireCd: 0,
      droplets: [],
      cups: [],
      pickups: [],
      gull: null,
      umbrella: null,
      pending: [],
      clock: 0,
      fx: { ice: 0, cream: 0 },
      events: [],
      stats: { pops: 0, misses: 0, stolen: 0, shots: 0 },
      nextId: 1
    };
    startWave(g, 1);
    return g;
  }

  function startWave(g, n) {
    const built = buildWave(n, g.rng);
    g.wave = n;
    g.params = built.params;
    g.happy = built.params.happy;
    g.pending = built.events;
    g.clock = -INTRO;
    if (g.happy) {
      if (g.umbrella) g.umbrella.leaving = true;
      if (g.gull && g.gull.phase === 'in') g.gull.phase = 'flee';
    }
    g.events.push({ type: 'wave', n, happy: g.happy });
  }

  function setFlavor(g, i) {
    g.flavor = ((i % FLAVORS.length) + FLAVORS.length) % FLAVORS.length;
  }

  function spawnEvent(g, e) {
    const p = g.params;
    if (e.kind === 'cup') {
      const s = SIZES[e.size];
      g.cups.push({
        id: g.nextId++, size: e.size, cap: s.cap, w: s.w, h: s.h, carrier: e.carrier,
        x0: e.x0, x: e.x0, y: -s.h, amp: e.amp, freq: e.freq, phase: e.phase, drift: e.drift,
        baseV: p.speed * CARRIER_SPEED[e.carrier] * e.vyMul,
        age: 0, hits: 0, matchHits: 0, layers: [], flavor: e.flavor, wob: 0
      });
      return true;
    }
    if (e.kind === 'pickup') {
      g.pickups.push({ id: g.nextId++, type: e.type, x: clamp(e.x, 30, W - 30), y: -20, vy: 56, age: 0 });
      return true;
    }
    if (e.kind === 'gull') {
      if (g.gull) return false;
      const target = pickGullTarget(g);
      if (!target) return false;
      g.gull = {
        id: g.nextId++, phase: 'warn', warn: 1.2, side: e.side,
        x: e.side < 0 ? -34 : W + 34, y: clamp(target.y - 60, 40, 240),
        target, hp: 2, flash: 0, age: 0, carrying: null, dir: e.side
      };
      g.events.push({ type: 'gullWarn', side: e.side, y: g.gull.y });
      return true;
    }
    if (e.kind === 'umbrella') {
      if (g.umbrella) return false;
      g.umbrella = {
        id: g.nextId++, x: e.side < 0 ? -56 : W + 56, y0: e.y, y: e.y,
        vx: -e.side * 34, age: 0, jiggle: 0, leaving: false
      };
      return true;
    }
    return true;
  }

  function pickGullTarget(g) {
    const ok = g.cups.filter(function (c) { return c.y > 20 && c.y < 300; });
    if (!ok.length) return null;
    return ok[Math.floor(g.rng() * ok.length) % ok.length];
  }

  function removeCup(g, c) {
    const i = g.cups.indexOf(c);
    if (i >= 0) g.cups.splice(i, 1);
  }

  function popCup(g, c, swirl) {
    const match = swirl ? false : isMatch(c.matchHits, c.hits);
    const pts = popScore(c.size, match, g.happy);
    g.score += pts;
    g.stats.pops++;
    removeCup(g, c);
    g.events.push({ type: 'pop', x: c.x, y: c.y, size: c.size, pts, match, swirl: !!swirl, color: FLAVORS[c.flavor].color });
  }

  function hitCup(g, c, d) {
    c.hits++;
    c.layers.push(d.flavor);
    if (d.flavor === c.flavor) c.matchHits++;
    c.wob = 0.22;
    g.score += 1;
    g.events.push({ type: 'hit', x: d.x, y: d.y, ratio: fillFraction(c.hits, c.cap), color: FLAVORS[d.flavor].color });
    if (c.hits >= c.cap) popCup(g, c, false);
  }

  function collectPickup(g, p) {
    const i = g.pickups.indexOf(p);
    if (i >= 0) g.pickups.splice(i, 1);
    if (p.type === 'ice') g.fx.ice = ICE_SECS;
    else if (p.type === 'cream') g.fx.cream = CREAM_SECS;
    else if (p.type === 'pineapple') {
      g.cups.slice().forEach(function (c) { popCup(g, c, true); });
    }
    g.events.push({ type: 'pickup', kind: p.type, x: p.x, y: p.y });
  }

  function hitGull(g, gu) {
    gu.hp--;
    gu.flash = 0.18;
    g.events.push({ type: 'gullHit', x: gu.x, y: gu.y });
    if (gu.hp > 0) return;
    g.score += 5;
    g.events.push({ type: 'shoo', x: gu.x, y: gu.y });
    if (gu.carrying) {
      // the cup is dropped and floats down again on a little parachute, keeping what it has collected
      const c = gu.carrying;
      c.carrier = 'parachute';
      c.x0 = gu.x; c.x = gu.x; c.y = gu.y + 22; c.drift = 0; c.amp = 10; c.phase = 0; c.age = 0;
      c.freq = 1; c.baseV = Math.max(40, g.params.speed * 0.8);
      g.cups.push(c);
      gu.carrying = null;
      g.events.push({ type: 'rescue', x: c.x, y: c.y });
    }
    gu.phase = 'flee';
    gu.dir = gu.x < W / 2 ? -1 : 1;
  }

  function updateDroplets(g, dt) {
    const keep = [];
    for (let k = 0; k < g.droplets.length; k++) {
      const d = g.droplets[k];
      const prev = d.y;
      d.y -= DROP_SPEED * dt;
      let best = null;
      let bestY = -1e9;
      const consider = function (kind, ref, left, right, top, bottom) {
        if (d.x < left || d.x > right) return;
        if (top > prev || bottom < d.y) return;
        const cy = Math.min(prev, bottom);
        if (cy > bestY) { bestY = cy; best = { kind, ref }; }
      };
      for (let i = 0; i < g.cups.length; i++) {
        const c = g.cups[i];
        consider('cup', c, c.x - c.w / 2 - 3, c.x + c.w / 2 + 3, c.y - c.h / 2, c.y + c.h / 2);
      }
      const u = g.umbrella;
      if (u) consider('umb', u, u.x - 40, u.x + 40, u.y - 26, u.y + 4);
      for (let i = 0; i < g.pickups.length; i++) {
        const q = g.pickups[i];
        consider('pick', q, q.x - 17, q.x + 17, q.y - 17, q.y + 17);
      }
      const gu = g.gull;
      if (gu && (gu.phase === 'in' || gu.phase === 'carry')) consider('gull', gu, gu.x - 20, gu.x + 20, gu.y - 12, gu.y + 12);

      if (best) {
        if (best.kind === 'cup') hitCup(g, best.ref, d);
        else if (best.kind === 'umb') {
          best.ref.jiggle = 0.25;
          g.events.push({ type: 'block', x: d.x, y: bestY, color: FLAVORS[d.flavor].color });
        } else if (best.kind === 'pick') collectPickup(g, best.ref);
        else if (best.kind === 'gull') hitGull(g, best.ref);
        continue;
      }
      if (d.y > -12) keep.push(d);
    }
    g.droplets = keep;
  }

  function shoot(g) {
    const offs = g.fx.cream > 0 ? [-14, 0, 14] : [0];
    for (let i = 0; i < offs.length; i++) {
      g.droplets.push({ x: g.nozzle.x + offs[i], y: NOZ_TIP_Y, flavor: g.flavor });
    }
    g.stats.shots++;
    g.events.push({ type: 'squirt' });
  }

  function updateCups(g, sdt) {
    for (let i = g.cups.length - 1; i >= 0; i--) {
      const c = g.cups[i];
      c.age += sdt;
      if (c.wob > 0) c.wob = Math.max(0, c.wob - sdt);
      const bob = c.carrier === 'ball' ? 1 + 0.3 * Math.sin(2.3 * c.age + c.phase) : 1;
      c.x = clamp(c.x0 + c.drift * c.age + c.amp * Math.sin(c.freq * c.age + c.phase), c.w / 2 + 6, W - c.w / 2 - 6);
      c.y += c.baseV * bob * sdt;
      if (c.y + c.h / 2 >= GROUND) {
        g.cups.splice(i, 1);
        if (g.happy) {
          g.events.push({ type: 'plop', x: c.x, y: GROUND });
        } else {
          g.lives--;
          g.stats.misses++;
          g.events.push({ type: 'miss', x: c.x, y: GROUND, lives: g.lives });
          if (g.lives <= 0) {
            g.state = 'over';
            g.events.push({ type: 'over', score: g.score, wave: g.wave });
            return;
          }
        }
      }
    }
  }

  function updatePickups(g, sdt) {
    for (let i = g.pickups.length - 1; i >= 0; i--) {
      const p = g.pickups[i];
      p.age += sdt;
      p.y += p.vy * sdt;
      p.x = clamp(p.x + Math.sin(p.age * 2.2) * 14 * sdt, 24, W - 24);
      if (Math.abs(p.x - g.nozzle.x) < NOZ_HALF + 6 && p.y + 14 >= NOZ_TIP_Y - 12) {
        collectPickup(g, p);
      } else if (p.y > GROUND + 10) {
        g.pickups.splice(i, 1);
      }
    }
  }

  function updateGull(g, sdt) {
    const gu = g.gull;
    if (!gu) return;
    gu.age += sdt;
    if (gu.flash > 0) gu.flash = Math.max(0, gu.flash - sdt);
    const speed = Math.min(140, 85 + 6 * g.wave);
    if (gu.phase === 'warn') {
      gu.warn -= sdt;
      if (gu.warn <= 0) gu.phase = 'in';
      return;
    }
    if (gu.phase === 'in') {
      let t = gu.target;
      if (!t || g.cups.indexOf(t) < 0) {
        t = pickGullTarget(g);
        gu.target = t;
        if (!t) { gu.phase = 'flee'; gu.dir = gu.x < W / 2 ? -1 : 1; return; }
      }
      const dx = t.x - gu.x;
      const dy = t.y - gu.y;
      const dist = Math.hypot(dx, dy) || 1;
      gu.x += (dx / dist) * speed * sdt;
      gu.y += (dy / dist) * speed * sdt + Math.sin(gu.age * 5) * 18 * sdt;
      if (dist < t.w / 2 + 14) {
        removeCup(g, t);
        gu.carrying = t;
        gu.phase = 'carry';
        gu.dir = gu.x < W / 2 ? -1 : 1;
        g.events.push({ type: 'steal', x: gu.x, y: gu.y });
      }
    } else {
      // carrying a cup away, or startled and leaving
      gu.x += gu.dir * speed * 1.15 * sdt;
      gu.y -= (gu.phase === 'flee' ? 40 : 14) * sdt;
      if (gu.x < -60 || gu.x > W + 60) {
        if (gu.carrying) g.stats.stolen++;
        g.gull = null;
      }
    }
  }

  function updateUmbrella(g, sdt) {
    const u = g.umbrella;
    if (!u) return;
    u.age += sdt;
    if (u.jiggle > 0) u.jiggle = Math.max(0, u.jiggle - sdt);
    u.x += u.vx * sdt * (u.leaving ? 2.2 : 1);
    u.y = u.y0 + 10 * Math.sin(u.age * 1.1);
    if (u.age > 2 && (u.x < -70 || u.x > W + 70)) g.umbrella = null;
  }

  function completeWave(g) {
    const bonus = waveBonus(g.wave);
    g.score += bonus;
    g.events.push({ type: 'waveClear', n: g.wave, bonus });
    if (g.happy && g.lives < START_LIVES) {
      g.lives++;
      g.events.push({ type: 'life', lives: g.lives });
    }
    startWave(g, g.wave + 1);
  }

  /* Advance the game by dt seconds. input = { targetX: logical x or null, dir: -1|0|1, firing: bool } */
  function update(g, dt, input) {
    if (g.state !== 'playing') return;
    input = input || {};
    g.time += dt;
    g.fx.ice = Math.max(0, g.fx.ice - dt);
    g.fx.cream = Math.max(0, g.fx.cream - dt);
    const sdt = g.fx.ice > 0 ? dt * ICE_SLOW : dt;

    // nozzle: glide to a finger/mouse x, or move with the keyboard
    const nz = g.nozzle;
    if (input.targetX != null) {
      const dx = clamp(input.targetX, NOZ_HALF, W - NOZ_HALF) - nz.x;
      const m = NOZ_GLIDE * dt;
      nz.x += Math.abs(dx) <= m ? dx : Math.sign(dx) * m;
    } else if (input.dir) {
      nz.x += input.dir * NOZ_KEY * dt;
    }
    nz.x = clamp(nz.x, NOZ_HALF, W - NOZ_HALF);

    g.fireCd = Math.max(0, g.fireCd - dt);
    if (input.firing && g.fireCd <= 0) { shoot(g); g.fireCd = FIRE_INTERVAL; }

    updateDroplets(g, dt);

    // spawn whatever is due (deferred hazards retry a little later)
    g.clock += sdt;
    for (let i = 0; i < g.pending.length;) {
      const e = g.pending[i];
      if (e.t <= g.clock) {
        if (spawnEvent(g, e)) { g.pending.splice(i, 1); continue; }
        e.tries = (e.tries || 0) + 1;
        e.t = g.clock + 0.8;
        if (e.tries > 6) { g.pending.splice(i, 1); continue; }
      }
      i++;
    }

    updateCups(g, sdt);
    if (g.state !== 'playing') return;
    updatePickups(g, sdt);
    updateGull(g, sdt);
    updateUmbrella(g, sdt);

    if (g.cups.length === 0 && !g.pending.some(function (e) { return e.kind === 'cup'; })) completeWave(g);
  }

  const core = {
    W, H, GROUND, NOZ_TIP_Y, NOZ_HALF, FIRE_INTERVAL, DROP_SPEED, INTRO, START_LIVES, STEP, ICE_SECS, CREAM_SECS,
    FLAVORS, SIZES, CARRIERS,
    makeRng, isHappyHour, waveParams, buildWave, fillFraction, isMatch, popScore, waveBonus,
    createGame, update, setFlavor
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  if (typeof document === 'undefined' || !document.getElementById || !document.getElementById('tbCanvas')) return;

  /* ============================== 2. BROWSER SHELL ============================== */

  const $ = function (id) { return document.getElementById(id); };
  const canvas = $('tbCanvas');
  const board = $('tbBoard');
  const ctx = canvas.getContext('2d');
  const overlay = $('tbOverlay');
  const ovTitle = $('tbOvTitle');
  const ovText = $('tbOvText');
  const ovBtn = $('tbStart');
  const pauseBtn = $('tbPause');
  const soundBtn = $('tbSound');
  const statusEl = $('tbStatus');
  const hudScore = $('tbScore');
  const hudWave = $('tbWave');
  const hudBest = $('tbBest');
  const hudLives = $('tbLives');
  const flavorBtns = Array.prototype.slice.call(document.querySelectorAll('.tb-flavor'));

  const BEST_KEY = 'tb-blaster-best';
  const FONT = '"Bungee", "Arial Black", Impact, sans-serif';
  const BODY_FONT = '"Archivo", system-ui, sans-serif';

  const reducedMq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = !!(reducedMq && reducedMq.matches);
  if (reducedMq) {
    const onChange = function (e) { reduced = e.matches; };
    if (reducedMq.addEventListener) reducedMq.addEventListener('change', onChange);
    else if (reducedMq.addListener) reducedMq.addListener(onChange);
  }

  let state = 'idle';           // idle | playing | paused | over
  let game = null;
  let preview = null;           // static demo scene shown before the first game
  let flavorIdx = 0;
  let best = 0;
  let raf = 0;
  let lastTs = 0;
  let acc = 0;
  let sx = 1;
  let sy = 1;
  let bg = null;
  let particles = [];
  let floaters = [];
  let hudCache = { score: -1, wave: -1, lives: -1, best: -1 };

  function loadBest() {
    try {
      const v = parseInt(window.localStorage.getItem(BEST_KEY), 10);
      best = Number.isFinite(v) && v > 0 ? Math.min(v, 9999999) : 0;
    } catch (e) { best = 0; }
  }
  function saveBest() {
    try { window.localStorage.setItem(BEST_KEY, String(best)); } catch (e) { /* private mode or blocked: fine */ }
  }

  function announce(msg) { statusEl.textContent = msg; }

  /* ---------- sound: tiny Web Audio synth, nothing loaded, silent until a gesture ---------- */
  let ac = null;
  let master = null;
  let soundOn = false;
  let soundTouched = false;
  const lastPlayed = {};

  function ensureAudio() {
    if (ac) { if (ac.state === 'suspended' && ac.resume) ac.resume(); return ac; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ac = new AC();
      master = ac.createGain();
      master.gain.value = 0.16;
      master.connect(ac.destination);
    } catch (e) { ac = null; }
    return ac;
  }
  function tone(freq, dur, type, vol, slideTo, delay) {
    if (!soundOn || !ac || ac.state === 'closed') return;
    const t = ac.currentTime + (delay || 0);
    const o = ac.createOscillator();
    const gn = ac.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.exponentialRampToValueAtTime(vol || 0.3, t + 0.008);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(gn);
    gn.connect(master);
    o.start(t);
    o.stop(t + dur + 0.03);
  }
  function sfx(name, a) {
    if (!soundOn || !ac) return;
    const now = performance.now();
    const gap = name === 'squirt' ? 160 : name === 'hit' ? 60 : 0;
    if (gap && now - (lastPlayed[name] || 0) < gap) return;
    lastPlayed[name] = now;
    switch (name) {
      case 'squirt': tone(420 + Math.random() * 60, 0.04, 'sine', 0.07); break;
      case 'hit': tone(300 + (a || 0) * 420, 0.05, 'triangle', 0.2); break;
      case 'pop': [523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0.09, 'square', 0.2, null, i * 0.055); }); break;
      case 'match': [784, 988, 1319].forEach(function (f, i) { tone(f, 0.1, 'triangle', 0.22, null, 0.18 + i * 0.06); }); break;
      case 'miss': tone(330, 0.28, 'sawtooth', 0.22, 110); break;
      case 'pickup': [440, 554, 659, 880].forEach(function (f, i) { tone(f, 0.08, 'square', 0.18, null, i * 0.05); }); break;
      case 'gull': tone(900, 0.12, 'sawtooth', 0.14, 600); tone(950, 0.12, 'sawtooth', 0.14, 620, 0.16); break;
      case 'shoo': tone(600, 0.12, 'square', 0.18, 1100); break;
      case 'wave': [392, 523, 659].forEach(function (f, i) { tone(f, 0.1, 'triangle', 0.22, null, i * 0.09); }); break;
      case 'happy': [523, 659, 784, 1047, 1319].forEach(function (f, i) { tone(f, 0.1, 'square', 0.18, null, i * 0.08); }); break;
      case 'over': [392, 330, 262, 196].forEach(function (f, i) { tone(f, 0.2, 'triangle', 0.24, null, i * 0.17); }); break;
      case 'block': tone(180, 0.05, 'square', 0.1); break;
      default: break;
    }
  }
  function setSound(on) {
    soundOn = on;
    soundBtn.textContent = on ? 'Sound On' : 'Sound Off';
    soundBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) {
      ensureAudio();
      sfx('pickup');
    }
  }

  /* ---------- canvas sizing and the cached background ---------- */
  function resize() {
    const cssW = board.clientWidth;
    const cssH = board.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    sx = canvas.width / W;
    sy = canvas.height / H;
    bg = null;
    render();
  }

  function sunStripes(c2) {
    // retro striped sun, cut by bands that get thicker toward the bottom
    const sc = document.createElement('canvas');
    sc.width = canvas.width;
    sc.height = canvas.height;
    const s = sc.getContext('2d');
    s.setTransform(sx, 0, 0, sy, 0, 0);
    const g = s.createLinearGradient(0, 230, 0, 345);
    g.addColorStop(0, '#FFE98A');
    g.addColorStop(0.5, '#FF8A4C');
    g.addColorStop(1, '#FF3CAC');
    s.fillStyle = g;
    s.beginPath();
    s.arc(W / 2, 318, 86, 0, Math.PI * 2);
    s.fill();
    s.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 6; i++) {
      const y = 290 + i * 12;
      s.fillRect(0, y, W, 1.5 + i * 0.9);
    }
    c2.setTransform(1, 0, 0, 1, 0, 0);
    c2.drawImage(sc, 0, 0);
    c2.setTransform(sx, 0, 0, sy, 0, 0);
  }

  function palm(c2, x, baseY, topY, lean) {
    c2.strokeStyle = '#17042F';
    c2.lineCap = 'round';
    c2.lineWidth = 7;
    c2.beginPath();
    c2.moveTo(x, baseY);
    c2.quadraticCurveTo(x + lean * 0.3, (baseY + topY) / 2, x + lean, topY);
    c2.stroke();
    c2.lineWidth = 4;
    const tx = x + lean;
    const fronds = [[-46, 18], [-38, -8], [-16, -26], [16, -26], [38, -8], [46, 18]];
    fronds.forEach(function (f) {
      c2.beginPath();
      c2.moveTo(tx, topY);
      c2.quadraticCurveTo(tx + f[0] * 0.6, topY + f[1] - 16, tx + f[0], topY + f[1]);
      c2.stroke();
    });
  }

  function buildBackground() {
    bg = document.createElement('canvas');
    bg.width = canvas.width;
    bg.height = canvas.height;
    const b = bg.getContext('2d');
    b.setTransform(sx, 0, 0, sy, 0, 0);
    // sky
    let g = b.createLinearGradient(0, 0, 0, 345);
    g.addColorStop(0, '#12033A');
    g.addColorStop(0.32, '#3A0A6E');
    g.addColorStop(0.62, '#B0239F');
    g.addColorStop(0.84, '#FF5A8A');
    g.addColorStop(1, '#FFB457');
    b.fillStyle = g;
    b.fillRect(0, 0, W, 345);
    // stars
    b.fillStyle = 'rgba(255,244,250,.85)';
    for (let i = 0; i < 38; i++) {
      const x = (i * 97.3) % W;
      const y = (i * 53.7) % 170;
      b.fillRect(x, y, i % 5 === 0 ? 2 : 1, i % 5 === 0 ? 2 : 1);
    }
    sunStripes(b);
    // ocean
    g = b.createLinearGradient(0, 338, 0, 430);
    g.addColorStop(0, '#FF6AA0');
    g.addColorStop(0.18, '#7B2CBF');
    g.addColorStop(1, '#1B0F5C');
    b.fillStyle = g;
    b.fillRect(0, 338, W, 92);
    b.fillStyle = 'rgba(255,209,102,.55)';
    for (let i = 0; i < 9; i++) b.fillRect(W / 2 - 60 + i * 9 - (i % 3) * 6, 344 + i * 8, 34 - i * 2.5, 2);
    b.strokeStyle = 'rgba(42,245,228,.55)';
    b.lineWidth = 1.5;
    b.beginPath();
    b.moveTo(0, 338.5);
    b.lineTo(W, 338.5);
    b.stroke();
    // palms
    palm(b, 22, 446, 292, 22);
    palm(b, W - 20, 446, 304, -20);
    // sand
    g = b.createLinearGradient(0, 424, 0, 488);
    g.addColorStop(0, '#FFB27A');
    g.addColorStop(1, '#D9667F');
    b.fillStyle = g;
    b.beginPath();
    b.moveTo(0, 436);
    b.quadraticCurveTo(W * 0.5, 418, W, 438);
    b.lineTo(W, 490);
    b.lineTo(0, 490);
    b.closePath();
    b.fill();
    b.fillStyle = 'rgba(255,244,250,.28)';
    for (let i = 0; i < 26; i++) b.fillRect((i * 61.7) % W, 442 + ((i * 29) % 44), 2, 1.5);
    // boardwalk the nozzle slides along
    g = b.createLinearGradient(0, 486, 0, H);
    g.addColorStop(0, '#4A1458');
    g.addColorStop(1, '#1A0636');
    b.fillStyle = g;
    b.fillRect(0, 486, W, H - 486);
    b.strokeStyle = 'rgba(0,0,0,.35)';
    b.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      b.beginPath();
      b.moveTo(0, 498 + i * 6.2);
      b.lineTo(W, 498 + i * 6.2);
      b.stroke();
    }
    b.fillStyle = '#2AF5E4';
    b.shadowColor = '#2AF5E4';
    b.shadowBlur = 10;
    b.fillRect(0, 485, W, 2.5);
    b.shadowBlur = 0;
  }

  /* ---------- drawing helpers ---------- */
  function cupPath(c2, w, h) {
    const hw = w / 2;
    const bw = w * 0.36;
    c2.beginPath();
    c2.moveTo(-hw, -h / 2);
    c2.lineTo(hw, -h / 2);
    c2.lineTo(bw, h / 2 - 3);
    c2.quadraticCurveTo(bw - 1, h / 2, bw - 4, h / 2);
    c2.lineTo(-bw + 4, h / 2);
    c2.quadraticCurveTo(-bw + 1, h / 2, -bw, h / 2 - 3);
    c2.closePath();
  }

  function badge(c2, x, y, r, flavor) {
    const f = FLAVORS[flavor];
    c2.fillStyle = f.color;
    c2.strokeStyle = '#14032E';
    c2.lineWidth = 1.5;
    c2.beginPath();
    c2.arc(x, y, r, 0, Math.PI * 2);
    c2.fill();
    c2.stroke();
    c2.fillStyle = '#14032E';
    c2.font = '700 ' + Math.round(r * 1.25) + 'px ' + BODY_FONT;
    c2.textAlign = 'center';
    c2.textBaseline = 'middle';
    c2.fillText(f.letter, x, y + 0.5);
  }

  function drawCarrierBack(c2, c) {
    const top = -c.h / 2;
    if (c.carrier === 'parachute') {
      const R = Math.max(19, c.w * 0.92);
      const cy = top - 26;
      c2.strokeStyle = 'rgba(255,244,250,.75)';
      c2.lineWidth = 1;
      [-0.95, -0.35, 0.35, 0.95].forEach(function (k) {
        c2.beginPath();
        c2.moveTo(k * R, cy);
        c2.lineTo(k * c.w * 0.45, top);
        c2.stroke();
      });
      c2.save();
      c2.translate(0, cy);
      c2.scale(1, 0.72);
      const cols = ['#FF3CAC', '#FFD166', '#2AF5E4', '#FF3CAC'];
      for (let i = 0; i < 4; i++) {
        c2.fillStyle = cols[i];
        c2.beginPath();
        c2.moveTo(0, 0);
        c2.arc(0, 0, R, Math.PI + (i * Math.PI) / 4, Math.PI + ((i + 1) * Math.PI) / 4);
        c2.closePath();
        c2.fill();
      }
      c2.strokeStyle = '#FFF4FA';
      c2.lineWidth = 1.6;
      c2.beginPath();
      c2.arc(0, 0, R, Math.PI, 2 * Math.PI);
      c2.closePath();
      c2.stroke();
      c2.restore();
    } else if (c.carrier === 'ball') {
      const r = Math.max(12, c.w * 0.5);
      const cy = top - r - 6;
      c2.strokeStyle = 'rgba(255,244,250,.8)';
      c2.lineWidth = 1.4;
      c2.beginPath();
      c2.moveTo(0, cy + r);
      c2.lineTo(0, top);
      c2.stroke();
      const cols = ['#FF3CAC', '#FFF4FA', '#2AF5E4', '#FFF4FA', '#FFD166', '#FFF4FA'];
      const rot = c.age * 1.6;
      for (let i = 0; i < 6; i++) {
        c2.fillStyle = cols[i];
        c2.beginPath();
        c2.moveTo(0, cy);
        c2.arc(0, cy, r, rot + (i * Math.PI) / 3, rot + ((i + 1) * Math.PI) / 3);
        c2.closePath();
        c2.fill();
      }
      c2.strokeStyle = '#FFF4FA';
      c2.lineWidth = 1.6;
      c2.beginPath();
      c2.arc(0, cy, r, 0, Math.PI * 2);
      c2.stroke();
      c2.fillStyle = 'rgba(255,255,255,.55)';
      c2.beginPath();
      c2.ellipse(-r * 0.35, cy - r * 0.4, r * 0.22, r * 0.12, -0.6, 0, Math.PI * 2);
      c2.fill();
    } else if (c.carrier === 'float') {
      // pool float ring: back half drawn behind the cup
      const rx = c.w * 0.78 + 5;
      c2.strokeStyle = '#FF3CAC';
      c2.lineWidth = 7;
      c2.beginPath();
      c2.ellipse(0, top + 7, rx, 6, 0, Math.PI, 2 * Math.PI);
      c2.stroke();
    }
  }

  function drawCarrierFront(c2, c) {
    if (c.carrier !== 'float') return;
    const top = -c.h / 2;
    const rx = c.w * 0.78 + 5;
    c2.strokeStyle = '#FF3CAC';
    c2.lineWidth = 7;
    c2.beginPath();
    c2.ellipse(0, top + 7, rx, 6, 0, 0, Math.PI);
    c2.stroke();
    c2.strokeStyle = '#FFF4FA';
    c2.lineWidth = 2.5;
    c2.setLineDash([5, 7]);
    c2.beginPath();
    c2.ellipse(0, top + 7, rx, 6, 0, 0, Math.PI * 2);
    c2.stroke();
    c2.setLineDash([]);
  }

  function drawCup(c2, c, t) {
    c2.save();
    c2.translate(c.x, c.y);
    const w = c.wob > 0 ? Math.sin(c.wob * 70) * c.wob * 0.9 : 0;
    c2.rotate(Math.sin(c.age * 2 + c.phase) * 0.05 + w);
    drawCarrierBack(c2, c);
    // straw
    c2.strokeStyle = '#FFD166';
    c2.lineWidth = 3;
    c2.lineCap = 'round';
    c2.beginPath();
    c2.moveTo(c.w * 0.12, -c.h / 2 + 4);
    c2.lineTo(c.w * 0.3, -c.h / 2 - 9);
    c2.stroke();
    // glass
    cupPath(c2, c.w, c.h);
    c2.fillStyle = 'rgba(255,255,255,.12)';
    c2.fill();
    c2.save();
    cupPath(c2, c.w, c.h);
    c2.clip();
    const band = (c.h - 4) / c.cap;
    for (let i = 0; i < c.layers.length; i++) {
      c2.fillStyle = FLAVORS[c.layers[i]].color;
      c2.fillRect(-c.w, c.h / 2 - (i + 1) * band, c.w * 2, band + 0.6);
    }
    if (c.layers.length) {
      c2.fillStyle = 'rgba(255,255,255,.55)';
      c2.fillRect(-c.w, c.h / 2 - c.layers.length * band, c.w * 2, 1.4);
    }
    c2.restore();
    cupPath(c2, c.w, c.h);
    c2.strokeStyle = '#FFF4FA';
    c2.lineWidth = 2;
    c2.lineJoin = 'round';
    c2.stroke();
    c2.fillStyle = 'rgba(255,255,255,.35)';
    c2.fillRect(-c.w * 0.38, -c.h * 0.36, 2.2, c.h * 0.5);
    badge(c2, 0, (c.size === 'small' ? -2 : 0) + (c.carrier === 'float' ? 5 : 0), c.size === 'small' ? 7 : c.size === 'medium' ? 8.5 : 10, c.flavor);
    drawCarrierFront(c2, c);
    c2.restore();
  }

  function drawNozzle(c2, g, firing) {
    const x = g.nozzle.x;
    const f = FLAVORS[g.flavor];
    c2.save();
    c2.translate(x, 0);
    // base (a little mascot on wheels)
    let gr = c2.createLinearGradient(0, 504, 0, 532);
    gr.addColorStop(0, '#FF6FCB');
    gr.addColorStop(1, '#8A1FA8');
    c2.fillStyle = gr;
    c2.strokeStyle = '#FFF4FA';
    c2.lineWidth = 2;
    c2.beginPath();
    c2.moveTo(-22, 532);
    c2.lineTo(-18, 506);
    c2.quadraticCurveTo(0, 500, 18, 506);
    c2.lineTo(22, 532);
    c2.closePath();
    c2.fill();
    c2.stroke();
    // eyes
    c2.fillStyle = '#FFF4FA';
    c2.beginPath(); c2.arc(-7, 516, 4.2, 0, Math.PI * 2); c2.arc(7, 516, 4.2, 0, Math.PI * 2); c2.fill();
    c2.fillStyle = '#14032E';
    c2.beginPath(); c2.arc(-7, 514.6, 2, 0, Math.PI * 2); c2.arc(7, 514.6, 2, 0, Math.PI * 2); c2.fill();
    // smile
    c2.strokeStyle = '#14032E';
    c2.lineWidth = 1.6;
    c2.beginPath(); c2.arc(0, 522, 5, 0.15 * Math.PI, 0.85 * Math.PI); c2.stroke();
    // wheels
    c2.fillStyle = '#FFD166';
    c2.beginPath(); c2.arc(-13, 534, 4.2, 0, Math.PI * 2); c2.arc(13, 534, 4.2, 0, Math.PI * 2); c2.fill();
    // neck + head
    gr = c2.createLinearGradient(-10, 0, 10, 0);
    gr.addColorStop(0, '#8592A5');
    gr.addColorStop(0.4, '#F4F7FB');
    gr.addColorStop(1, '#7D889A');
    c2.fillStyle = gr;
    c2.fillRect(-7, 490, 14, 16);
    c2.beginPath();
    if (c2.roundRect) c2.roundRect(-11, 476, 22, 16, 5); else c2.rect(-11, 476, 22, 16);
    c2.fill();
    c2.strokeStyle = '#14032E';
    c2.lineWidth = 1.2;
    c2.stroke();
    // flavor ring and tip
    c2.fillStyle = f.color;
    c2.fillRect(-11, 486, 22, 4);
    c2.beginPath(); c2.arc(0, 476, 4.2, 0, Math.PI * 2); c2.fill();
    if (firing) {
      c2.fillStyle = 'rgba(255,255,255,.8)';
      c2.beginPath(); c2.arc(0, 474, 2.2, 0, Math.PI * 2); c2.fill();
    }
    c2.restore();
  }

  function drawDroplets(c2, g) {
    for (let i = 0; i < g.droplets.length; i++) {
      const d = g.droplets[i];
      c2.fillStyle = FLAVORS[d.flavor].color;
      c2.beginPath();
      if (c2.roundRect) c2.roundRect(d.x - 3.2, d.y - 9, 6.4, 18, 3.2); else c2.rect(d.x - 3.2, d.y - 9, 6.4, 18);
      c2.fill();
      c2.fillStyle = 'rgba(255,255,255,.7)';
      c2.fillRect(d.x - 1.6, d.y - 6, 1.6, 7);
    }
  }

  function drawGull(c2, gu) {
    if (gu.phase === 'warn') {
      // telegraph: a "!" marker on the edge it will fly in from
      const ex = gu.side < 0 ? 18 : W - 18;
      c2.fillStyle = '#FFD166';
      c2.strokeStyle = '#14032E';
      c2.lineWidth = 2;
      c2.beginPath(); c2.arc(ex, gu.y, 13, 0, Math.PI * 2); c2.fill(); c2.stroke();
      c2.fillStyle = '#14032E';
      c2.font = '900 17px ' + FONT;
      c2.textAlign = 'center';
      c2.textBaseline = 'middle';
      c2.fillText('!', ex, gu.y + 1);
      return;
    }
    c2.save();
    c2.translate(gu.x, gu.y);
    const dirX = gu.phase === 'in' ? (gu.target && gu.target.x < gu.x ? -1 : 1) : gu.dir;
    c2.scale(dirX, 1);
    const flap = Math.sin(gu.age * 11) * (reduced ? 0.4 : 1);
    c2.fillStyle = gu.flash > 0 ? '#FFD166' : '#FFF4FA';
    c2.strokeStyle = '#14032E';
    c2.lineWidth = 1.6;
    // wings
    c2.beginPath();
    c2.moveTo(-3, -2);
    c2.quadraticCurveTo(-14, -16 - flap * 9, -26, -6 - flap * 12);
    c2.quadraticCurveTo(-14, -6, -3, 2);
    c2.fill(); c2.stroke();
    c2.beginPath();
    c2.moveTo(3, -2);
    c2.quadraticCurveTo(14, -16 + flap * 9, 26, -6 + flap * 12);
    c2.quadraticCurveTo(14, -6, 3, 2);
    c2.fill(); c2.stroke();
    // body + head
    c2.beginPath(); c2.ellipse(0, 2, 12, 7, 0, 0, Math.PI * 2); c2.fill(); c2.stroke();
    c2.beginPath(); c2.arc(11, -3, 5.5, 0, Math.PI * 2); c2.fill(); c2.stroke();
    c2.fillStyle = '#FF7A45';
    c2.beginPath(); c2.moveTo(15.5, -4); c2.lineTo(22, -2); c2.lineTo(15.5, -1); c2.closePath(); c2.fill();
    c2.fillStyle = '#14032E';
    c2.beginPath(); c2.arc(12.5, -4.5, 1.2, 0, Math.PI * 2); c2.fill();
    c2.restore();
    if (gu.carrying) {
      const c = gu.carrying;
      c2.strokeStyle = '#FFF4FA';
      c2.lineWidth = 1.2;
      c2.beginPath(); c2.moveTo(gu.x, gu.y + 8); c2.lineTo(gu.x, gu.y + 18); c2.stroke();
      const sv = { x: c.x, y: c.y, wob: c.wob, age: c.age, carrier: c.carrier };
      c.x = gu.x; c.y = gu.y + 18 + c.h / 2; c.carrier = 'none'; c.age = gu.age;
      drawCup(c2, c, 0);
      c.x = sv.x; c.y = sv.y; c.carrier = sv.carrier; c.age = sv.age;
    }
  }

  function drawUmbrella(c2, u) {
    c2.save();
    c2.translate(u.x, u.y);
    c2.rotate(Math.sin(u.age * 1.4) * 0.1 + (u.jiggle > 0 ? Math.sin(u.jiggle * 80) * u.jiggle * 0.5 : 0));
    // pole and crook
    c2.strokeStyle = '#E8EDF3';
    c2.lineWidth = 3;
    c2.lineCap = 'round';
    c2.beginPath();
    c2.moveTo(0, 0); c2.lineTo(0, 42);
    c2.arc(-5, 42, 5, 0, Math.PI);
    c2.stroke();
    // canopy panels
    const R = 40;
    c2.save();
    c2.scale(1, 0.66);
    const cols = ['#FF3CAC', '#FFF4FA'];
    for (let i = 0; i < 6; i++) {
      c2.fillStyle = cols[i % 2];
      c2.beginPath();
      c2.moveTo(0, 0);
      c2.arc(0, 0, R, Math.PI + (i * Math.PI) / 6, Math.PI + ((i + 1) * Math.PI) / 6);
      c2.closePath();
      c2.fill();
    }
    c2.strokeStyle = '#14032E';
    c2.lineWidth = 2;
    c2.beginPath(); c2.arc(0, 0, R, Math.PI, 2 * Math.PI); c2.closePath(); c2.stroke();
    c2.restore();
    c2.fillStyle = '#FFD166';
    c2.beginPath(); c2.arc(0, -26, 3, 0, Math.PI * 2); c2.fill();
    c2.restore();
  }

  function drawPickup(c2, p) {
    c2.save();
    c2.translate(p.x, p.y + Math.sin(p.age * 3) * 1.5);
    c2.fillStyle = 'rgba(255,255,255,.18)';
    c2.strokeStyle = '#FFF4FA';
    c2.lineWidth = 2;
    c2.beginPath(); c2.arc(0, 0, 16, 0, Math.PI * 2); c2.fill(); c2.stroke();
    if (p.type === 'ice') {
      c2.fillStyle = '#9CF6FF';
      c2.strokeStyle = '#FFFFFF';
      c2.lineWidth = 1.5;
      c2.beginPath();
      if (c2.roundRect) c2.roundRect(-8, -8, 16, 16, 3); else c2.rect(-8, -8, 16, 16);
      c2.fill(); c2.stroke();
      c2.strokeStyle = '#FFFFFF';
      c2.beginPath(); c2.moveTo(-4, -4); c2.lineTo(0, -4); c2.moveTo(-4, -4); c2.lineTo(-4, 0); c2.stroke();
    } else if (p.type === 'cream') {
      c2.fillStyle = '#FFFDF8';
      c2.strokeStyle = '#FF3CAC';
      c2.lineWidth = 1.5;
      [[0, 5, 9], [0, -1, 7], [0, -7, 4.5]].forEach(function (e) {
        c2.beginPath(); c2.ellipse(e[0], e[1], e[2], 4.2, 0, 0, Math.PI * 2); c2.fill(); c2.stroke();
      });
    } else {
      // pineapple soft serve swirl in a cone, with a tiny green crown
      c2.fillStyle = '#E8A857';
      c2.beginPath(); c2.moveTo(-6, 1); c2.lineTo(6, 1); c2.lineTo(0, 13); c2.closePath(); c2.fill();
      c2.fillStyle = '#FFD84A';
      c2.strokeStyle = '#FF9A2E';
      c2.lineWidth = 1.2;
      [[0, 0, 8], [0, -5, 6], [0, -9, 3.6]].forEach(function (e) {
        c2.beginPath(); c2.ellipse(e[0], e[1], e[2], 3.6, 0, 0, Math.PI * 2); c2.fill(); c2.stroke();
      });
      c2.strokeStyle = '#2FCB6B';
      c2.lineWidth = 2;
      c2.beginPath(); c2.moveTo(0, -12); c2.lineTo(-4, -17); c2.moveTo(0, -12); c2.lineTo(0, -18); c2.moveTo(0, -12); c2.lineTo(4, -17); c2.stroke();
    }
    c2.restore();
  }

  function addPop(x, y, color, n) {
    const count = reduced ? Math.ceil(n * 0.4) : n;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 40 + Math.random() * 110;
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, life: 0.7, max: 0.7, r: 2 + Math.random() * 2.5, color });
    }
  }
  function addFloater(x, y, text, color) {
    floaters.push({ x: clamp(x, 28, W - 28), y, text, color, life: 1.1 });
  }

  function updateFx(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.vy += 320 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.life -= dt;
      if (f.life <= 0) { floaters.splice(i, 1); continue; }
      f.y -= 26 * dt;
    }
  }

  function drawFx(c2) {
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      c2.globalAlpha = Math.max(0, p.life / p.max);
      c2.fillStyle = p.color;
      c2.beginPath(); c2.arc(p.x, p.y, p.r, 0, Math.PI * 2); c2.fill();
    }
    c2.globalAlpha = 1;
    c2.textAlign = 'center';
    c2.textBaseline = 'middle';
    for (let i = 0; i < floaters.length; i++) {
      const f = floaters[i];
      c2.globalAlpha = Math.min(1, f.life * 2);
      c2.font = '16px ' + FONT;
      c2.lineWidth = 4;
      c2.strokeStyle = '#14032E';
      c2.strokeText(f.text, f.x, f.y);
      c2.fillStyle = f.color;
      c2.fillText(f.text, f.x, f.y);
    }
    c2.globalAlpha = 1;
  }

  function drawBanner(c2, g) {
    if (g.clock >= -0.2 || g.state !== 'playing') return;
    const left = -g.clock;
    const alpha = left < 0.6 ? Math.max(0, (left - 0.2) / 0.4) : Math.min(1, (INTRO - left) / 0.3 + 0.2);
    c2.save();
    c2.globalAlpha = clamp(alpha, 0, 1);
    c2.textAlign = 'center';
    c2.textBaseline = 'middle';
    c2.lineJoin = 'round';
    if (g.happy) {
      c2.font = '34px ' + FONT;
      c2.lineWidth = 7;
      c2.strokeStyle = '#14032E';
      c2.strokeText('HAPPY HOUR!', W / 2, 190);
      c2.fillStyle = '#FFD166';
      c2.fillText('HAPPY HOUR!', W / 2, 190);
      c2.font = '700 14px ' + BODY_FONT;
      c2.lineWidth = 4;
      c2.strokeText('No thirst lost. Double points!', W / 2, 222);
      c2.fillStyle = '#FFF4FA';
      c2.fillText('No thirst lost. Double points!', W / 2, 222);
    } else {
      c2.font = '38px ' + FONT;
      c2.lineWidth = 7;
      c2.strokeStyle = '#14032E';
      c2.strokeText('WAVE ' + g.wave, W / 2, 190);
      c2.fillStyle = '#FF9ADF';
      c2.fillText('WAVE ' + g.wave, W / 2, 190);
    }
    c2.restore();
  }

  function drawEffectBars(c2, g) {
    let y = 10;
    [['ice', 'ICE', '#9CF6FF', ICE_SECS], ['cream', 'CREAM', '#FFFDF8', CREAM_SECS]].forEach(function (e) {
      const left = g.fx[e[0]];
      if (left <= 0) return;
      c2.fillStyle = 'rgba(9,1,15,.65)';
      c2.beginPath();
      if (c2.roundRect) c2.roundRect(8, y, 112, 18, 9); else c2.rect(8, y, 112, 18);
      c2.fill();
      c2.fillStyle = e[2];
      c2.fillRect(14, y + 11, 100 * (left / e[3]), 4);
      c2.font = '10px ' + FONT;
      c2.textAlign = 'left';
      c2.textBaseline = 'middle';
      c2.fillText(e[1], 14, y + 5);
      y += 22;
    });
  }

  function scene(g, firing) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!bg) buildBackground();
    ctx.drawImage(bg, 0, 0);
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (!reduced) {
      // a few drifting glints on the water
      const t = performance.now() / 1000;
      ctx.fillStyle = 'rgba(255,244,250,.5)';
      for (let i = 0; i < 6; i++) {
        const x = ((i * 71 + t * (6 + i)) % (W + 40)) - 20;
        ctx.fillRect(x, 360 + i * 12, 14, 1.5);
      }
    }
    if (g.umbrella) drawUmbrella(ctx, g.umbrella);
    // cups lowest first so higher ones overlap their carriers naturally
    const order = g.cups.slice().sort(function (a, b) { return a.y - b.y; });
    for (let i = 0; i < order.length; i++) drawCup(ctx, order[i], 0);
    g.pickups.forEach(function (p) { drawPickup(ctx, p); });
    if (g.gull) drawGull(ctx, g.gull);
    drawDroplets(ctx, g);
    drawNozzle(ctx, g, firing);
    drawFx(ctx);
    drawEffectBars(ctx, g);
    drawBanner(ctx, g);
  }

  function render() {
    const g = game || preview;
    if (!g) return;
    scene(g, state === 'playing' && input.firing);
  }

  /* ---------- HUD and overlay ---------- */
  function updateHud(force) {
    const g = game;
    const score = g ? g.score : 0;
    const wave = g ? g.wave : 1;
    const lives = g ? g.lives : START_LIVES;
    if (force || score !== hudCache.score) { hudScore.textContent = String(score); hudCache.score = score; }
    if (force || wave !== hudCache.wave) { hudWave.textContent = String(wave); hudCache.wave = wave; }
    if (force || best !== hudCache.best) { hudBest.textContent = String(best); hudCache.best = best; }
    if (force || lives !== hudCache.lives) {
      const drops = hudLives.children;
      for (let i = 0; i < drops.length; i++) drops[i].classList.toggle('is-lost', i >= lives);
      hudLives.setAttribute('aria-label', 'Thirst lives left: ' + Math.max(0, lives) + ' of ' + START_LIVES);
      hudCache.lives = lives;
    }
  }

  function showOverlay(kind) {
    overlay.hidden = false;
    overlay.dataset.kind = kind;
    if (kind === 'idle') {
      ovTitle.textContent = 'Thirsty Blaster';
      ovText.textContent = 'Squirt the empty cups full before they land on the sand! Drag a finger to slide the nozzle. It squirts while you touch.';
      ovBtn.textContent = 'Start';
    } else if (kind === 'paused') {
      ovTitle.textContent = 'Paused';
      ovText.textContent = 'Take a sip. Your game is waiting.';
      ovBtn.textContent = 'Resume';
    } else {
      ovTitle.textContent = 'Game over';
      ovText.textContent = 'Score ' + game.score + '. Best ' + best + '. You reached wave ' + game.wave + '.';
      ovBtn.textContent = 'Play again';
    }
    pauseBtn.disabled = kind !== 'idle' ? kind === 'over' : true;
    try { ovBtn.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  function hideOverlay() { overlay.hidden = true; }

  /* ---------- game flow ---------- */
  function randomSeed() {
    try {
      const a = new Uint32Array(1);
      window.crypto.getRandomValues(a);
      return a[0];
    } catch (e) { return (Math.random() * 4294967296) >>> 0; }
  }

  function startGame() {
    const url = new URLSearchParams(window.location.search);
    const seed = url.has('debug') && url.get('seed') ? parseInt(url.get('seed'), 10) : randomSeed();
    game = createGame({ seed, flavor: flavorIdx });
    particles = [];
    floaters = [];
    input.firing = false;
    input.targetX = null;
    keys.clear();
    state = 'playing';
    hideOverlay();
    pauseBtn.disabled = false;
    pauseBtn.textContent = 'Pause';
    updateHud(true);
    announce('Game started. Wave 1.');
    if (window.TBK) window.TBK.runStart('thirsty-blaster');
    startLoop();
  }

  function pauseGame() {
    if (state !== 'playing') return;
    state = 'paused';
    stopLoop();
    input.firing = false;
    keys.clear();
    if (ac && ac.state === 'running' && ac.suspend) ac.suspend();
    pauseBtn.textContent = 'Resume';
    showOverlay('paused');
    render();
  }
  function resumeGame() {
    if (state !== 'paused') return;
    state = 'playing';
    hideOverlay();
    pauseBtn.textContent = 'Pause';
    if (soundOn) ensureAudio();
    startLoop();
  }
  function endGame() {
    state = 'over';
    stopLoop();
    input.firing = false;
    if (game.score > best) { best = game.score; saveBest(); }
    updateHud(true);
    render();
    announce('Game over. Score ' + game.score + '. Best ' + best + '.');
    showOverlay('over');
    if (window.TBK) window.TBK.runEnd();
  }

  function handleEvent(e) {
    switch (e.type) {
      case 'hit':
        addPop(e.x, e.y, e.color, 2);
        sfx('hit', e.ratio);
        break;
      case 'pop':
        addPop(e.x, e.y, e.color, 16);
        addFloater(e.x, e.y - 20, '+' + e.pts, e.match ? '#FFD166' : '#FFF4FA');
        if (e.match) addFloater(e.x, e.y - 40, 'DOUBLE!', '#2AF5E4');
        sfx('pop');
        if (e.match) sfx('match');
        break;
      case 'miss':
        addPop(e.x, e.y, '#B9A7D4', 8);
        addFloater(e.x, e.y - 24, 'OOPS!', '#FF9ADF');
        sfx('miss');
        announce('A cup landed. ' + e.lives + ' thirst left.');
        break;
      case 'plop':
        addPop(e.x, e.y, '#B9A7D4', 4);
        break;
      case 'pickup': {
        const label = e.kind === 'ice' ? 'ICE!' : e.kind === 'cream' ? 'CREAM!' : 'SOFT SERVE!';
        addFloater(e.x, e.y - 14, label, '#2AF5E4');
        addPop(e.x, e.y, e.kind === 'ice' ? '#9CF6FF' : e.kind === 'cream' ? '#FFFDF8' : '#FFD84A', 14);
        sfx('pickup');
        announce(e.kind === 'ice' ? 'Ice. Everything slows down.' : e.kind === 'cream' ? 'Cream. Wide triple stream.' : 'Pineapple soft serve. Every cup fills.');
        break;
      }
      case 'gullWarn': sfx('gull'); announce('A seagull is coming. Splash it twice to shoo it away.'); break;
      case 'steal': addFloater(e.x, e.y + 20, 'STOLEN!', '#FF9ADF'); sfx('gull'); break;
      case 'gullHit': addPop(e.x, e.y, '#FFF4FA', 4); break;
      case 'shoo': addFloater(e.x, e.y - 16, 'SHOO! +5', '#FFD166'); sfx('shoo'); break;
      case 'rescue': addFloater(e.x, e.y + 14, 'CUP SAVED', '#2AF5E4'); break;
      case 'block': addPop(e.x, e.y, e.color, 2); sfx('block'); break;
      case 'squirt': sfx('squirt'); break;
      case 'waveClear': addFloater(W / 2, 130, 'WAVE CLEAR +' + e.bonus, '#FFD166'); break;
      case 'life': addFloater(W / 2, 150, 'THIRST REFILLED', '#2AF5E4'); break;
      case 'wave':
        if (e.n > 1) { sfx(e.happy ? 'happy' : 'wave'); }
        announce(e.happy ? 'Happy hour. No thirst lost, double points.' : 'Wave ' + e.n + '.');
        break;
      case 'over': sfx('over'); break;
      default: break;
    }
  }

  function stepGame() {
    update(game, STEP, input);
    const ev = game.events;
    for (let i = 0; i < ev.length; i++) handleEvent(ev[i]);
    ev.length = 0;
  }

  function frame(ts) {
    raf = window.requestAnimationFrame(frame);
    const dt = Math.min(0.1, (ts - lastTs) / 1000 || 0);
    lastTs = ts;
    acc += dt;
    while (acc >= STEP && game.state === 'playing') {
      stepGame();
      acc -= STEP;
    }
    updateFx(dt);
    if (game.state === 'over') { endGame(); return; }
    updateHud(false);
    render();
  }
  function startLoop() {
    if (raf) return;
    lastTs = performance.now();
    acc = 0;
    raf = window.requestAnimationFrame(frame);
  }
  function stopLoop() {
    if (raf) window.cancelAnimationFrame(raf);
    raf = 0;
  }

  /* ---------- input: touch, mouse, keyboard ---------- */
  const input = { targetX: null, dir: 0, firing: false };
  const keys = new Set();
  let activePointer = null;

  function toLogical(clientX) {
    const r = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(W, ((clientX - r.left) / r.width) * W));   // a finger below or beside the board still steers to its x
  }
  function syncKeys() {
    input.dir = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
    if (input.dir) input.targetX = null;
    input.firing = activePointer !== null || keys.has('fire');
  }

  const surface = $('tbSurface') || canvas;
  surface.addEventListener('pointerdown', function (e) {
    if (state !== 'playing') return;
    if (e.target && e.target.closest && e.target.closest('button')) return;       // flavor / pause / sound buttons are not steering
    if (window.TBK && window.TBK.isStray(e)) return;                              // a palm or sleeve on the panel
    if (activePointer !== null && e.pointerId !== activePointer) return;          // extra fingers never take over
    e.preventDefault();
    activePointer = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    input.targetX = toLogical(e.clientX);
    syncKeys();
  });
  surface.addEventListener('pointermove', function (e) {
    if (state !== 'playing') return;
    if (e.pointerId === activePointer || (e.pointerType === 'mouse' && activePointer === null)) {
      input.targetX = toLogical(e.clientX);
    }
  });
  function endPointer(e) {
    if (e.pointerId !== activePointer) return;
    activePointer = null;
    syncKeys();
  }
  surface.addEventListener('pointerup', endPointer);
  surface.addEventListener('pointercancel', endPointer);
  surface.addEventListener('lostpointercapture', endPointer);
  surface.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  function keyName(e) {
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') return 'left';
    if (k === 'ArrowRight' || k === 'd' || k === 'D') return 'right';
    if (k === ' ' || k === 'Spacebar') return 'fire';
    return null;
  }
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const name = keyName(e);
    if (state === 'playing') {
      // Space on a focused button keeps its normal "press the button" meaning
      if (name === 'fire' && tag === 'BUTTON') return;
      if (name) {
        keys.add(name);
        if (name === 'left' || name === 'right') input.targetX = null;
        syncKeys();
        e.preventDefault();
        unlockAudio();
        return;
      }
      if (e.key >= '1' && e.key <= '4') { selectFlavor(parseInt(e.key, 10) - 1); return; }
      if (e.key === 'f' || e.key === 'F') { selectFlavor(flavorIdx + 1); return; }
      if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') { pauseGame(); return; }
    } else if (state === 'paused') {
      if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') { resumeGame(); return; }
    }
    if (e.key === 'm' || e.key === 'M') { toggleSound(); return; }
    if ((state === 'idle' || state === 'over' || state === 'paused') && (e.key === 'Enter' || name === 'fire') && tag !== 'BUTTON' && tag !== 'A') {
      e.preventDefault();
      if (state === 'paused') resumeGame(); else begin();
    }
  });
  window.addEventListener('keyup', function (e) {
    const name = keyName(e);
    if (name) { keys.delete(name); syncKeys(); }
  });
  window.addEventListener('blur', function () { keys.clear(); activePointer = null; syncKeys(); });

  function unlockAudio() {
    // first gesture: the Sound button decides; the Start gesture turns sound on unless the player already chose
    if (soundOn) ensureAudio();
  }
  function toggleSound() {
    soundTouched = true;
    setSound(!soundOn);
  }
  function begin() {
    if (!soundTouched) { soundTouched = true; setSound(true); }
    startGame();
  }

  function selectFlavor(i) {
    flavorIdx = ((i % FLAVORS.length) + FLAVORS.length) % FLAVORS.length;
    if (game) setFlavor(game, flavorIdx);
    flavorBtns.forEach(function (b, k) { b.setAttribute('aria-pressed', k === flavorIdx ? 'true' : 'false'); });
    if (state !== 'playing') render();
  }

  flavorBtns.forEach(function (b, k) {
    b.addEventListener('click', function (e) {
      selectFlavor(k);
      if (e.detail > 0) b.blur();
    });
  });
  ovBtn.addEventListener('click', function () { if (state === 'paused') resumeGame(); else begin(); });
  pauseBtn.addEventListener('click', function (e) {
    if (state === 'playing') pauseGame(); else if (state === 'paused') resumeGame();
    if (e.detail > 0) pauseBtn.blur();
  });
  soundBtn.addEventListener('click', function (e) {
    toggleSound();
    if (e.detail > 0) soundBtn.blur();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) pauseGame();
  });
  window.addEventListener('pagehide', pauseGame);

  /* ---------- boot ---------- */
  loadBest();
  if (window.TBK) { window.TBK.onEnd(pauseGame); window.TBK.onAgain(begin); }
  setSound(false);
  selectFlavor(0);
  // a static preview scene behind the start screen: a few seconds of a quiet wave 1
  preview = createGame({ seed: 7 });
  for (let i = 0; i < 360; i++) update(preview, STEP, { targetX: 200 });
  preview.events.length = 0;
  updateHud(true);
  showOverlay('idle');
  pauseBtn.disabled = true;

  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(board);
  else window.addEventListener('resize', resize);
  resize();
  if (document.fonts && document.fonts.load) {
    document.fonts.load('20px Bungee').then(function () { if (state !== 'playing') render(); }, function () { /* fonts are decoration */ });
  }

  if (/[?&]debug(?:=|&|$)/.test(window.location.search)) {
    window.__tb = {
      get game() { return game; },
      get state() { return state; },
      get input() { return input; },
      core: core
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
