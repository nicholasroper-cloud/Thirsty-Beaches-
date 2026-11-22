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
  const STEP = 1 / 60;

  /* ---------- difficulty: two tables, one switch ----------
     `classic` is the v48 tuning exactly. `arcade86` is the harder 1986 arcade pace. gameDifficulty in kiosk/arcade-session.json picks one (the shared shell reads it, TBK.difficulty());
     the choice is made once, when a run starts (setDifficulty), so a run never changes table mid-game. Nothing else differs between the two modes. */
  const TUNING = {
    classic: {
      ICE_SECS: 6, CREAM_SECS: 8, ICE_SLOW: 0.4,
      speedBase: 36, speedPer: 6, speedMax: 110,
      happy: { cups: 14, interval: 0.5, speedMax: 80, pLarge: 0, pMedium: 0.3 },
      cupsBase: 6, cupsPer: 2, cupsMax: 24,
      intervalBase: 2.2, intervalPer: 0.18, intervalMin: 0.8,
      pLargeOffset: 2, pLargePer: 0.07, pLargeMax: 0.3,
      pMediumBase: 0.1, pMediumPer: 0.07, pMediumMax: 0.45,
      gullFromWave: 2, gullTwoFromWave: 6, umbrellaFromWave: 3
    },
    arcade86: {
      ICE_SECS: 4.5, CREAM_SECS: 6, ICE_SLOW: 0.45,
      speedBase: 58, speedPer: 11, speedMax: 155,
      happy: { cups: 18, interval: 0.42, speedMax: 105, pLarge: 0, pMedium: 0.35 },
      cupsBase: 8, cupsPer: 3, cupsMax: 30,
      intervalBase: 1.65, intervalPer: 0.18, intervalMin: 0.52,
      pLargeOffset: 1, pLargePer: 0.1, pLargeMax: 0.4,
      pMediumBase: 0.2, pMediumPer: 0.08, pMediumMax: 0.45,
      gullFromWave: 1, gullTwoFromWave: 4, umbrellaFromWave: 2
    }
  };
  let TUNE = TUNING.classic;
  function setDifficulty(mode) { TUNE = Object.prototype.hasOwnProperty.call(TUNING, mode) ? TUNING[mode] : TUNING.classic; return TUNE === TUNING.arcade86 ? 'arcade86' : 'classic'; }

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
    const T = TUNE;
    const speed = Math.min(T.speedMax, T.speedBase + T.speedPer * (n - 1));
    if (happy) {
      return { n, happy: true, cups: T.happy.cups, interval: T.happy.interval, speed: Math.min(T.happy.speedMax, speed), pLarge: T.happy.pLarge, pMedium: T.happy.pMedium };
    }
    return {
      n, happy: false,
      cups: Math.min(T.cupsMax, T.cupsBase + T.cupsPer * (n - 1)),
      interval: Math.max(T.intervalMin, T.intervalBase - T.intervalPer * (n - 1)),
      speed,
      pLarge: clamp((n - T.pLargeOffset) * T.pLargePer, 0, T.pLargeMax),
      pMedium: clamp(T.pMediumBase + (n - 1) * T.pMediumPer, 0, T.pMediumMax)
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
    if (!p.happy && n >= TUNE.gullFromWave) {
      const gulls = n < TUNE.gullTwoFromWave ? 1 : 2;
      for (let i = 0; i < gulls; i++) {
        events.push({ kind: 'gull', t: span * (0.25 + 0.3 * i) + rng() * 2, side: rng() < 0.5 ? -1 : 1, tries: 0 });
      }
    }
    if (!p.happy && n >= TUNE.umbrellaFromWave) {
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
    if (p.type === 'ice') g.fx.ice = TUNE.ICE_SECS;
    else if (p.type === 'cream') g.fx.cream = TUNE.CREAM_SECS;
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
    const sdt = g.fx.ice > 0 ? dt * TUNE.ICE_SLOW : dt;

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
    W, H, GROUND, NOZ_TIP_Y, NOZ_HALF, FIRE_INTERVAL, DROP_SPEED, INTRO, START_LIVES, STEP, ICE_SECS: TUNING.classic.ICE_SECS, CREAM_SECS: TUNING.classic.CREAM_SECS, TUNING, setDifficulty, getTune: function () { return TUNE; }, difficultyMode: function () { return TUNE === TUNING.arcade86 ? 'arcade86' : 'classic'; },
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

  /* ---------- local 1986 Miami artwork assets ---------- */
  const ART = {};
  (function loadArt() {
    [['bg', '/kiosk/games/thirsty-blaster/assets/bg-miami-beach.webp'],
     ['bot', '/kiosk/games/thirsty-blaster/assets/blaster-bot.png']].forEach(function (pair) {
      const im = new Image();
      im.onload = function () { if (pair[0] === 'bg') bg = null; render(); };
      im.src = pair[1];
      ART[pair[0]] = im;
    });
  })();

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
    // radiant sunset halo behind the Outrun sun
    const halo = c2.createRadialGradient(W / 2, 314, 42, W / 2, 314, 155);
    halo.addColorStop(0, 'rgba(255,224,120,.55)');
    halo.addColorStop(0.45, 'rgba(255,88,150,.32)');
    halo.addColorStop(1, 'rgba(255,60,172,0)');
    c2.fillStyle = halo;
    c2.beginPath();
    c2.arc(W / 2, 314, 155, 0, Math.PI * 2);
    c2.fill();

    // retro striped Outrun sun, cut by bands that thicken toward the horizon
    const sc = document.createElement('canvas');
    sc.width = canvas.width;
    sc.height = canvas.height;
    const s = sc.getContext('2d');
    s.setTransform(sx, 0, 0, sy, 0, 0);
    const g = s.createLinearGradient(0, 224, 0, 344);
    g.addColorStop(0, '#FFF7B8');
    g.addColorStop(0.32, '#FFD166');
    g.addColorStop(0.68, '#FF7A45');
    g.addColorStop(1, '#FF2E93');
    s.fillStyle = g;
    s.beginPath();
    s.arc(W / 2, 314, 92, 0, Math.PI * 2);
    s.fill();
    s.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 7; i++) {
      const y = 278 + i * 11;
      s.fillRect(0, y, W, 1.3 + i * 0.85);
    }
    c2.setTransform(1, 0, 0, 1, 0, 0);
    c2.drawImage(sc, 0, 0);
    c2.setTransform(sx, 0, 0, sy, 0, 0);
  }

  function drawMiamiSkyline(c2) {
    // 1986 Miami Beach Art Deco hotel silhouettes flanking the bay horizon
    const bldgs = [
      [0, 34, 44], [30, 26, 62], [52, 22, 36], [70, 18, 26],
      [W - 88, 20, 28], [W - 72, 24, 44], [W - 50, 26, 66], [W - 26, 28, 42]
    ];
    const base = 340;
    bldgs.forEach(function (b, idx) {
      const bx = b[0], bw = b[1], bh = b[2];
      const by = base - bh;
      const gr = c2.createLinearGradient(0, by, 0, base);
      gr.addColorStop(0, '#2B0956');
      gr.addColorStop(1, '#12032B');
      c2.fillStyle = gr;
      c2.fillRect(bx, by, bw, bh);
      // Art Deco stepped crown
      c2.fillRect(bx + 4, by - 5, bw - 8, 5);
      c2.fillRect(bx + bw * 0.35, by - 10, bw * 0.3, 5);
      // neon rooftop trim
      c2.fillStyle = idx % 2 === 0 ? 'rgba(42,245,228,.75)' : 'rgba(255,60,172,.75)';
      c2.fillRect(bx + 3, by - 1, bw - 6, 1.5);
      // glowing Art Deco hotel windows
      for (let wy = by + 6; wy < base - 5; wy += 7) {
        for (let wx = bx + 4; wx < bx + bw - 5; wx += 6) {
          if (((wx + wy + idx * 7) % 11) < 6) {
            c2.fillStyle = (wx + wy) % 3 === 0 ? 'rgba(255,209,102,.7)' : (wx % 2 === 0 ? 'rgba(42,245,228,.65)' : 'rgba(255,106,213,.65)');
            c2.fillRect(wx, wy, 2.5, 3.2);
          }
        }
      }
    });
  }

  function palm(c2, x, baseY, topY, lean) {
    const tx = x + lean;
    const cx = x + lean * 0.36;
    const cy = (baseY + topY) * 0.52;
    // tapered curved palm trunk
    c2.save();
    c2.beginPath();
    c2.moveTo(x - 6, baseY);
    c2.quadraticCurveTo(cx - 4, cy, tx - 2.6, topY);
    c2.lineTo(tx + 2.6, topY);
    c2.quadraticCurveTo(cx + 4, cy, x + 6, baseY);
    c2.closePath();
    const tg = c2.createLinearGradient(x - 8, topY, x + 8, baseY);
    tg.addColorStop(0, '#1D0538');
    tg.addColorStop(1, '#0C011F');
    c2.fillStyle = tg;
    c2.fill();
    // warm sunset rim highlight on inner edge
    c2.strokeStyle = 'rgba(255,112,166,.35)';
    c2.lineWidth = 1.2;
    c2.beginPath();
    if (lean > 0) {
      c2.moveTo(x + 5, baseY);
      c2.quadraticCurveTo(cx + 3.5, cy, tx + 2.2, topY);
    } else {
      c2.moveTo(x - 5, baseY);
      c2.quadraticCurveTo(cx - 3.5, cy, tx - 2.2, topY);
    }
    c2.stroke();

    // coconuts tucked under crown
    c2.fillStyle = '#190432';
    c2.beginPath();
    c2.arc(tx - 3.2, topY + 4, 3.4, 0, Math.PI * 2);
    c2.arc(tx + 3.2, topY + 4.5, 3.4, 0, Math.PI * 2);
    c2.arc(tx, topY + 6.5, 3.2, 0, Math.PI * 2);
    c2.fill();

    // lush feathered arching palm fronds
    const fronds = [
      [-58, 22, -26, -12, 7],
      [-52, -4, -26, -24, 6.5],
      [-32, -28, -14, -30, 6],
      [0, -36, 4, -24, 5.5],
      [32, -28, 14, -30, 6],
      [52, -4, 26, -24, 6.5],
      [58, 22, 26, -12, 7]
    ];
    fronds.forEach(function (f) {
      const ex = tx + f[0], ey = topY + f[1];
      const qx = tx + f[2], qy = topY + f[3];
      // main rib
      c2.strokeStyle = '#120229';
      c2.lineWidth = 2.6;
      c2.beginPath();
      c2.moveTo(tx, topY);
      c2.quadraticCurveTo(qx, qy, ex, ey);
      c2.stroke();
      // feathered leaflets along the curve
      const steps = 11;
      for (let i = 1; i <= steps; i++) {
        const t = i / (steps + 1);
        const omt = 1 - t;
        const px = omt * omt * tx + 2 * omt * t * qx + t * t * ex;
        const py = omt * omt * topY + 2 * omt * t * qy + t * t * ey;
        const len = Math.sin(t * Math.PI) * f[4] * 1.9 + 3;
        const dx = ex - tx;
        const sway = dx >= 0 ? 1 : -1;
        c2.fillStyle = i % 3 === 0 ? '#1C053A' : '#110226';
        c2.beginPath();
        c2.moveTo(px, py);
        c2.quadraticCurveTo(px + sway * 2.5, py + len * 0.55, px - sway * 1.5, py + len);
        c2.quadraticCurveTo(px - sway * 3.5, py + len * 0.45, px, py);
        c2.fill();
      }
      // subtle sunset rim glint on top edge of frond
      c2.strokeStyle = 'rgba(255,155,105,.24)';
      c2.lineWidth = 0.9;
      c2.beginPath();
      c2.moveTo(tx, topY - 0.5);
      c2.quadraticCurveTo(qx, qy - 1, ex, ey - 0.5);
      c2.stroke();
    });
    c2.restore();
  }

  function buildBackground() {
    bg = document.createElement('canvas');
    bg.width = canvas.width;
    bg.height = canvas.height;
    const b = bg.getContext('2d');
    b.setTransform(sx, 0, 0, sy, 0, 0);

    if (ART.bg && ART.bg.complete && ART.bg.naturalWidth > 0) {
      b.drawImage(ART.bg, 0, 0, W, H);
      return;
    }

    // 1986 Miami twilight-to-sunset sky (instant fallback while image decodes)
    let g = b.createLinearGradient(0, 0, 0, 345);
    g.addColorStop(0, '#090123');
    g.addColorStop(0.24, '#240552');
    g.addColorStop(0.52, '#6A128A');
    g.addColorStop(0.75, '#D92B95');
    g.addColorStop(0.9, '#FF6884');
    g.addColorStop(1, '#FFC46B');
    b.fillStyle = g;
    b.fillRect(0, 0, W, 345);

    // stars & 4-point neon twinkles
    for (let i = 0; i < 46; i++) {
      const x = (i * 97.3 + 11) % W;
      const y = (i * 53.7 + 7) % 185;
      const big = i % 7 === 0;
      b.fillStyle = i % 5 === 0 ? 'rgba(42,245,228,.85)' : (i % 4 === 0 ? 'rgba(255,209,102,.85)' : 'rgba(255,244,250,.88)');
      if (big) {
        b.fillRect(x - 3, y, 6, 1);
        b.fillRect(x, y - 3, 1, 6);
      } else {
        b.fillRect(x, y, i % 3 === 0 ? 1.8 : 1.1, i % 3 === 0 ? 1.8 : 1.1);
      }
    }

    // soft Miami sunset cloud wisps
    const clouds = [
      [54, 148, 72, 9, 'rgba(255,118,176,.22)'],
      [282, 126, 86, 10, 'rgba(255,155,112,.22)'],
      [110, 212, 96, 11, 'rgba(255,178,107,.24)'],
      [272, 236, 78, 9, 'rgba(255,96,174,.25)']
    ];
    clouds.forEach(function (cl) {
      b.fillStyle = cl[4];
      b.beginPath();
      b.ellipse(cl[0], cl[1], cl[2] * 0.5, cl[3] * 0.5, 0, 0, Math.PI * 2);
      b.ellipse(cl[0] - cl[2] * 0.24, cl[1] + 2, cl[2] * 0.34, cl[3] * 0.4, 0, 0, Math.PI * 2);
      b.ellipse(cl[0] + cl[2] * 0.28, cl[1] + 1, cl[2] * 0.3, cl[3] * 0.38, 0, 0, Math.PI * 2);
      b.fill();
    });

    sunStripes(b);
    drawMiamiSkyline(b);

    // lush Miami sunset ocean
    g = b.createLinearGradient(0, 338, 0, 434);
    g.addColorStop(0, '#FF68A5');
    g.addColorStop(0.14, '#A832A8');
    g.addColorStop(0.42, '#41187C');
    g.addColorStop(0.82, '#143875');
    g.addColorStop(1, '#1BA6B8');
    b.fillStyle = g;
    b.fillRect(0, 338, W, 96);

    // glowing sun reflection path on water
    for (let i = 0; i < 12; i++) {
      const rw = Math.max(12, 118 - i * 8.5);
      const ry = 342 + i * 7.2;
      b.fillStyle = i < 4 ? 'rgba(255,232,126,.62)' : 'rgba(255,134,168,.42)';
      b.beginPath();
      b.roundRect ? b.roundRect(W / 2 - rw / 2 + Math.sin(i * 1.7) * 5, ry, rw, 2.4, 1.2) : b.fillRect(W / 2 - rw / 2, ry, rw, 2.4);
      b.fill();
    }

    // electric horizon line
    b.strokeStyle = 'rgba(42,245,228,.75)';
    b.lineWidth = 1.6;
    b.beginPath();
    b.moveTo(0, 338.5);
    b.lineTo(W, 338.5);
    b.stroke();

    // shoreline surf foam ribbon
    b.strokeStyle = 'rgba(255,244,250,.72)';
    b.lineWidth = 3;
    b.beginPath();
    b.moveTo(0, 433);
    b.quadraticCurveTo(W * 0.25, 424, W * 0.5, 421);
    b.quadraticCurveTo(W * 0.75, 424, W, 435);
    b.stroke();

    // lush framing palms
    palm(b, 18, 452, 286, 26);
    palm(b, W - 16, 452, 298, -24);

    // warm sunset Miami sand dune
    g = b.createLinearGradient(0, 421, 0, 488);
    g.addColorStop(0, '#FFD29D');
    g.addColorStop(0.35, '#FFA57A');
    g.addColorStop(1, '#C9567B');
    b.fillStyle = g;
    b.beginPath();
    b.moveTo(0, 435);
    b.quadraticCurveTo(W * 0.5, 418, W, 437);
    b.lineTo(W, 490);
    b.lineTo(0, 490);
    b.closePath();
    b.fill();

    // wet shoreline shadow + sand sparkle speckles
    b.fillStyle = 'rgba(42,245,228,.16)';
    b.beginPath();
    b.moveTo(0, 435);
    b.quadraticCurveTo(W * 0.5, 418, W, 437);
    b.lineTo(W, 444);
    b.quadraticCurveTo(W * 0.5, 427, 0, 442);
    b.closePath();
    b.fill();
    for (let i = 0; i < 34; i++) {
      b.fillStyle = i % 3 === 0 ? 'rgba(255,250,235,.45)' : 'rgba(130,30,75,.2)';
      b.fillRect((i * 61.7) % W, 440 + ((i * 29) % 44), 2, 1.5);
    }

    // 1986 neon-lit wooden boardwalk pier the blaster slides along
    g = b.createLinearGradient(0, 486, 0, H);
    g.addColorStop(0, '#58176B');
    g.addColorStop(0.45, '#330C4F');
    g.addColorStop(1, '#14032A');
    b.fillStyle = g;
    b.fillRect(0, 486, W, H - 486);
    // perspective plank seams
    b.strokeStyle = 'rgba(255,60,172,.22)';
    b.lineWidth = 1;
    for (let i = -3; i <= 11; i++) {
      const tx = i * 36;
      const bx = W / 2 + (tx - W / 2) * 1.45;
      b.beginPath();
      b.moveTo(tx, 488);
      b.lineTo(bx, H);
      b.stroke();
    }
    b.strokeStyle = 'rgba(0,0,0,.4)';
    for (let i = 0; i < 6; i++) {
      b.beginPath();
      b.moveTo(0, 496 + i * 8);
      b.lineTo(W, 496 + i * 8);
      b.stroke();
    }
    // dual neon boardwalk trim strip (cyan top + hot pink glow)
    b.fillStyle = '#FF3CAC';
    b.fillRect(0, 488, W, 2);
    b.fillStyle = '#2AF5E4';
    b.shadowColor = '#2AF5E4';
    b.shadowBlur = 12;
    b.fillRect(0, 485, W, 2.8);
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
    c2.save();
    // outer glowing neon ring
    c2.shadowColor = f.color;
    c2.shadowBlur = 7;
    c2.fillStyle = f.color;
    c2.strokeStyle = '#FFF4FA';
    c2.lineWidth = 1.8;
    c2.beginPath();
    c2.arc(x, y, r, 0, Math.PI * 2);
    c2.fill();
    c2.shadowBlur = 0;
    c2.stroke();
    // crisp inner dark hairline
    c2.strokeStyle = '#14032E';
    c2.lineWidth = 1;
    c2.beginPath();
    c2.arc(x, y, r - 1.2, 0, Math.PI * 2);
    c2.stroke();
    // glossy top crescent
    c2.fillStyle = 'rgba(255,255,255,.35)';
    c2.beginPath();
    c2.ellipse(x, y - r * 0.42, r * 0.55, r * 0.25, 0, 0, Math.PI * 2);
    c2.fill();
    c2.fillStyle = '#14032E';
    c2.font = '800 ' + Math.round(r * 1.28) + 'px ' + BODY_FONT;
    c2.textAlign = 'center';
    c2.textBaseline = 'middle';
    c2.fillText(f.letter, x, y + 0.6);
    c2.restore();
  }

  function drawCarrierBack(c2, c) {
    const top = -c.h / 2;
    if (c.carrier === 'parachute') {
      const R = Math.max(19, c.w * 0.92);
      const cy = top - 26;
      c2.strokeStyle = 'rgba(255,244,250,.8)';
      c2.lineWidth = 1.1;
      [-0.95, -0.35, 0.35, 0.95].forEach(function (k) {
        c2.beginPath();
        c2.moveTo(k * R, cy);
        c2.lineTo(k * c.w * 0.45, top);
        c2.stroke();
      });
      c2.save();
      c2.translate(0, cy);
      c2.scale(1, 0.74);
      const cols = ['#FF3CAC', '#FFD166', '#2AF5E4', '#FF7A45'];
      for (let i = 0; i < 4; i++) {
        c2.fillStyle = cols[i];
        c2.beginPath();
        c2.moveTo(0, 0);
        c2.arc(0, 0, R, Math.PI + (i * Math.PI) / 4, Math.PI + ((i + 1) * Math.PI) / 4);
        c2.closePath();
        c2.fill();
      }
      // top glossy sheen on canopy
      const sheen = c2.createRadialGradient(-R * 0.25, -R * 0.55, 2, 0, -R * 0.3, R);
      sheen.addColorStop(0, 'rgba(255,255,255,.45)');
      sheen.addColorStop(0.55, 'rgba(255,255,255,0)');
      sheen.addColorStop(1, 'rgba(20,3,46,.32)');
      c2.fillStyle = sheen;
      c2.beginPath();
      c2.arc(0, 0, R, Math.PI, 2 * Math.PI);
      c2.closePath();
      c2.fill();
      c2.strokeStyle = '#FFF4FA';
      c2.lineWidth = 1.7;
      c2.stroke();
      c2.restore();
    } else if (c.carrier === 'ball') {
      const r = Math.max(12, c.w * 0.52);
      const cy = top - r - 6;
      c2.strokeStyle = 'rgba(255,244,250,.82)';
      c2.lineWidth = 1.5;
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
      // 3D sphere shading + glossy highlight
      const sg = c2.createRadialGradient(-r * 0.32, cy - r * 0.35, r * 0.1, 0, cy, r);
      sg.addColorStop(0, 'rgba(255,255,255,.55)');
      sg.addColorStop(0.5, 'rgba(255,255,255,0)');
      sg.addColorStop(1, 'rgba(20,3,46,.38)');
      c2.fillStyle = sg;
      c2.beginPath();
      c2.arc(0, cy, r, 0, Math.PI * 2);
      c2.fill();
      c2.strokeStyle = '#FFF4FA';
      c2.lineWidth = 1.6;
      c2.stroke();
      // beach ball center cap
      c2.fillStyle = '#FFD166';
      c2.beginPath();
      c2.arc(0, cy, r * 0.2, 0, Math.PI * 2);
      c2.fill();
    } else if (c.carrier === 'float') {
      // pool float ring: back half drawn behind the cup
      const rx = c.w * 0.8 + 5;
      c2.strokeStyle = '#D61E88';
      c2.lineWidth = 8;
      c2.beginPath();
      c2.ellipse(0, top + 7, rx, 6.5, 0, Math.PI, 2 * Math.PI);
      c2.stroke();
      c2.strokeStyle = '#FF66C4';
      c2.lineWidth = 4;
      c2.beginPath();
      c2.ellipse(0, top + 5.5, rx, 6.5, 0, Math.PI, 2 * Math.PI);
      c2.stroke();
    }
  }

  function drawCarrierFront(c2, c) {
    if (c.carrier !== 'float') return;
    const top = -c.h / 2;
    const rx = c.w * 0.8 + 5;
    c2.strokeStyle = '#FF3CAC';
    c2.lineWidth = 8;
    c2.beginPath();
    c2.ellipse(0, top + 7, rx, 6.5, 0, 0, Math.PI);
    c2.stroke();
    c2.strokeStyle = '#FFF4FA';
    c2.lineWidth = 2.6;
    c2.setLineDash([5, 7]);
    c2.beginPath();
    c2.ellipse(0, top + 7, rx, 6.5, 0, 0, Math.PI * 2);
    c2.stroke();
    c2.setLineDash([]);
    // glossy inflatable highlight
    c2.strokeStyle = 'rgba(255,255,255,.55)';
    c2.lineWidth = 1.6;
    c2.beginPath();
    c2.ellipse(0, top + 5.2, rx * 0.85, 4.5, 0, 0.2, Math.PI - 0.2);
    c2.stroke();
  }

  function drawCup(c2, c, t) {
    c2.save();
    c2.translate(c.x, c.y);
    const w = c.wob > 0 ? Math.sin(c.wob * 70) * c.wob * 0.9 : 0;
    c2.rotate(Math.sin(c.age * 2 + c.phase) * 0.05 + w);
    drawCarrierBack(c2, c);

    // striped bendy straw
    c2.strokeStyle = '#FFF4FA';
    c2.lineWidth = 3.4;
    c2.lineCap = 'round';
    c2.beginPath();
    c2.moveTo(c.w * 0.1, -c.h / 2 + 5);
    c2.lineTo(c.w * 0.28, -c.h / 2 - 9);
    c2.lineTo(c.w * 0.44, -c.h / 2 - 11);
    c2.stroke();
    c2.strokeStyle = '#FF3CAC';
    c2.lineWidth = 3.2;
    c2.setLineDash([3, 3]);
    c2.stroke();
    c2.setLineDash([]);

    // translucent glass body with 3D sheen
    cupPath(c2, c.w, c.h);
    const glass = c2.createLinearGradient(-c.w / 2, 0, c.w / 2, 0);
    glass.addColorStop(0, 'rgba(255,255,255,.28)');
    glass.addColorStop(0.3, 'rgba(255,244,250,.09)');
    glass.addColorStop(0.75, 'rgba(42,245,228,.12)');
    glass.addColorStop(1, 'rgba(255,255,255,.22)');
    c2.fillStyle = glass;
    c2.fill();

    c2.save();
    cupPath(c2, c.w, c.h);
    c2.clip();
    const band = (c.h - 4) / c.cap;
    for (let i = 0; i < c.layers.length; i++) {
      const ly = c.h / 2 - (i + 1) * band;
      c2.fillStyle = FLAVORS[c.layers[i]].color;
      c2.fillRect(-c.w, ly, c.w * 2, band + 0.8);
      // subtle liquid sheen
      c2.fillStyle = 'rgba(255,255,255,.16)';
      c2.fillRect(-c.w * 0.45, ly, c.w * 0.24, band);
    }
    if (c.layers.length) {
      const topLiq = c.h / 2 - c.layers.length * band;
      // fizzy cream foam meniscus
      c2.fillStyle = 'rgba(255,255,255,.85)';
      c2.fillRect(-c.w, topLiq - 1, c.w * 2, 2.5);
      // tiny carbonation bubbles
      c2.fillStyle = 'rgba(255,255,255,.6)';
      for (let bi = 0; bi < 3; bi++) {
        const bx = ((bi - 1) * c.w * 0.22) + Math.sin(c.age * 4 + bi) * 2;
        const by = topLiq + 4 + ((c.age * 16 + bi * 7) % Math.max(4, c.layers.length * band - 3));
        c2.beginPath(); c2.arc(bx, by, 1.3, 0, Math.PI * 2); c2.fill();
      }
    }
    c2.restore();

    // crisp cup rim & glass specular streak
    cupPath(c2, c.w, c.h);
    c2.strokeStyle = '#FFF4FA';
    c2.lineWidth = 2.1;
    c2.lineJoin = 'round';
    c2.stroke();
    // top glossy lid rim
    c2.fillStyle = '#2AF5E4';
    c2.strokeStyle = '#14032E';
    c2.lineWidth = 1.2;
    c2.beginPath();
    if (c2.roundRect) c2.roundRect(-c.w * 0.54, -c.h / 2 - 2.2, c.w * 1.08, 4.4, 2.2);
    else c2.rect(-c.w * 0.54, -c.h / 2 - 2.2, c.w * 1.08, 4.4);
    c2.fill(); c2.stroke();

    c2.fillStyle = 'rgba(255,255,255,.52)';
    c2.beginPath();
    c2.moveTo(-c.w * 0.38, -c.h * 0.34);
    c2.lineTo(-c.w * 0.3, -c.h * 0.34);
    c2.lineTo(-c.w * 0.24, c.h * 0.34);
    c2.lineTo(-c.w * 0.31, c.h * 0.34);
    c2.closePath();
    c2.fill();

    badge(c2, 0, (c.size === 'small' ? -1 : 1) + (c.carrier === 'float' ? 5 : 0), c.size === 'small' ? 7.2 : c.size === 'medium' ? 8.8 : 10.2, c.flavor);
    drawCarrierFront(c2, c);
    c2.restore();
  }

  function drawNozzle(c2, g, firing) {
    const x = g.nozzle.x;
    const f = FLAVORS[g.flavor];
    c2.save();
    c2.translate(x, 0);

    // boardwalk drop shadow & active flavor neon underglow
    c2.fillStyle = 'rgba(6,1,20,.65)';
    c2.beginPath();
    c2.ellipse(0, 536.5, 30, 5.5, 0, 0, Math.PI * 2);
    c2.fill();

    const ug = c2.createRadialGradient(0, 533, 3, 0, 533, 36);
    ug.addColorStop(0, f.color);
    ug.addColorStop(1, 'rgba(0,0,0,0)');
    c2.globalAlpha = 0.62;
    c2.fillStyle = ug;
    c2.beginPath();
    c2.ellipse(0, 533, 36, 9, 0, 0, Math.PI * 2);
    c2.fill();
    c2.globalAlpha = 1;

    if (ART.bot && ART.bot.complete && ART.bot.naturalWidth > 0) {
      // draw gleaming illustrated 1986 Chrome & Neon Soda Blaster Bot!
      const bw = 60, bh = 65;                                  // art fit (Gemini v49): never clips the bottom edge of the 540 board
      c2.drawImage(ART.bot, -bw / 2, 469, bw, bh);
      // active flavor neon glow orb right on the nozzle muzzle
      c2.save();
      c2.shadowColor = f.color;
      c2.shadowBlur = 12;
      c2.fillStyle = f.color;
      c2.beginPath(); c2.arc(1, 473, 5.2, 0, Math.PI * 2); c2.fill();
      c2.fillStyle = '#FFFFFF';
      c2.beginPath(); c2.arc(0, 472, 2.2, 0, Math.PI * 2); c2.fill();
      c2.restore();
      if (firing) {
        c2.save();
        c2.shadowColor = f.color;
        c2.shadowBlur = 18;
        c2.fillStyle = f.color;
        c2.beginPath(); c2.ellipse(1, 466, 7.5, 11, 0, 0, Math.PI * 2); c2.fill();
        c2.fillStyle = '#FFFFFF';
        c2.beginPath(); c2.ellipse(1, 468, 3.6, 6.5, 0, 0, Math.PI * 2); c2.fill();
        c2.restore();
      }
      c2.restore();
      return;
    }

    // fallback procedural chassis if image hasn't decoded yet
    let gr = c2.createLinearGradient(-22, 502, 22, 532);
    gr.addColorStop(0, '#FF7AD9');
    gr.addColorStop(0.35, '#FF3CAC');
    gr.addColorStop(0.75, '#7E1FA2');
    gr.addColorStop(1, '#3D0E6E');
    c2.fillStyle = gr;
    c2.strokeStyle = '#FFF4FA';
    c2.lineWidth = 2;
    c2.beginPath();
    c2.moveTo(-24, 532);
    c2.lineTo(-19, 505);
    c2.quadraticCurveTo(0, 498, 19, 505);
    c2.lineTo(24, 532);
    c2.closePath();
    c2.fill();
    c2.stroke();

    // retro 80s side racing stripes
    c2.fillStyle = '#FFD166';
    c2.fillRect(-20.5, 524, 41, 2.5);
    c2.fillStyle = '#2AF5E4';
    c2.fillRect(-21.5, 527.2, 43, 2.2);

    // glossy chassis top highlight
    c2.fillStyle = 'rgba(255,255,255,.32)';
    c2.beginPath();
    c2.ellipse(0, 505, 14, 2.8, 0, 0, Math.PI * 2);
    c2.fill();

    // rad 80s wrap-around neon shades/visor
    c2.fillStyle = '#12032E';
    c2.strokeStyle = '#2AF5E4';
    c2.lineWidth = 1.4;
    c2.beginPath();
    if (c2.roundRect) c2.roundRect(-14.5, 509, 29, 9.5, 4.5);
    else c2.rect(-14.5, 509, 29, 9.5);
    c2.fill();
    c2.stroke();
    // visor cyber-sunset reflection streak
    const vg = c2.createLinearGradient(-12, 510, 12, 518);
    vg.addColorStop(0, '#2AF5E4');
    vg.addColorStop(0.5, '#FF3CAC');
    vg.addColorStop(1, '#FFD166');
    c2.fillStyle = vg;
    c2.fillRect(-11.5, 512.2, 23, 2.8);
    c2.fillStyle = 'rgba(255,255,255,.85)';
    c2.beginPath();
    c2.moveTo(-8, 510.5); c2.lineTo(-4, 510.5); c2.lineTo(-7, 517); c2.lineTo(-10, 517); c2.closePath();
    c2.fill();

    // happy smile below shades
    c2.strokeStyle = '#FFF4FA';
    c2.lineWidth = 1.7;
    c2.beginPath(); c2.arc(0, 519.5, 4.6, 0.15 * Math.PI, 0.85 * Math.PI); c2.stroke();

    // chrome-rimmed neon wheels
    [-14, 14].forEach(function (wx) {
      c2.fillStyle = '#14032E';
      c2.strokeStyle = '#FFD166';
      c2.lineWidth = 2;
      c2.beginPath(); c2.arc(wx, 534, 4.6, 0, Math.PI * 2); c2.fill(); c2.stroke();
      c2.fillStyle = '#2AF5E4';
      c2.beginPath(); c2.arc(wx, 534, 1.8, 0, Math.PI * 2); c2.fill();
    });

    // gleaming chrome hydraulic neck & flared blaster head
    gr = c2.createLinearGradient(-11, 0, 11, 0);
    gr.addColorStop(0, '#5D6E87');
    gr.addColorStop(0.32, '#FFFFFF');
    gr.addColorStop(0.55, '#C4DCF2');
    gr.addColorStop(0.85, '#687992');
    gr.addColorStop(1, '#2D3A52');
    c2.fillStyle = gr;
    c2.fillRect(-7.5, 489, 15, 16);
    c2.beginPath();
    if (c2.roundRect) c2.roundRect(-12, 474, 24, 17, 5); else c2.rect(-12, 474, 24, 17);
    c2.fill();
    c2.strokeStyle = '#14032E';
    c2.lineWidth = 1.4;
    c2.stroke();

    // glowing active flavor LED ring & nozzle tip
    c2.save();
    c2.shadowColor = f.color;
    c2.shadowBlur = 10;
    c2.fillStyle = f.color;
    c2.fillRect(-12, 483.5, 24, 4.5);
    c2.beginPath(); c2.arc(0, 474, 5, 0, Math.PI * 2); c2.fill();
    c2.restore();
    c2.fillStyle = '#FFF4FA';
    c2.beginPath(); c2.arc(-1.4, 472.8, 1.6, 0, Math.PI * 2); c2.fill();

    if (firing) {
      // neon fizz muzzle burst
      c2.save();
      c2.shadowColor = f.color;
      c2.shadowBlur = 14;
      c2.fillStyle = f.color;
      c2.beginPath(); c2.ellipse(0, 469, 6.5, 9, 0, 0, Math.PI * 2); c2.fill();
      c2.fillStyle = '#FFFFFF';
      c2.beginPath(); c2.ellipse(0, 470, 3, 5.5, 0, 0, Math.PI * 2); c2.fill();
      c2.restore();
    }
    c2.restore();
  }

  function drawDroplets(c2, g) {
    for (let i = 0; i < g.droplets.length; i++) {
      const d = g.droplets[i];
      const col = FLAVORS[d.flavor].color;
      c2.save();
      c2.shadowColor = col;
      c2.shadowBlur = 8;
      c2.fillStyle = col;
      c2.beginPath();
      if (c2.roundRect) c2.roundRect(d.x - 3.6, d.y - 10, 7.2, 20, 3.6); else c2.rect(d.x - 3.6, d.y - 10, 7.2, 20);
      c2.fill();
      c2.shadowBlur = 0;
      c2.fillStyle = 'rgba(255,255,255,.85)';
      c2.beginPath();
      if (c2.roundRect) c2.roundRect(d.x - 1.4, d.y - 7.5, 2.8, 10, 1.4); else c2.rect(d.x - 1.4, d.y - 7.5, 2.8, 10);
      c2.fill();
      // trailing fizz sparkle dot
      c2.fillStyle = 'rgba(255,244,250,.65)';
      c2.beginPath(); c2.arc(d.x + ((i % 2) ? 2.6 : -2.6), d.y + 11, 1.4, 0, Math.PI * 2); c2.fill();
      c2.restore();
    }
  }

  function drawGull(c2, gu) {
    if (gu.phase === 'warn') {
      // glowing neon telegraph badge on edge
      const ex = gu.side < 0 ? 18 : W - 18;
      c2.save();
      c2.shadowColor = '#FFD166';
      c2.shadowBlur = 12;
      c2.fillStyle = '#FFD166';
      c2.strokeStyle = '#FFF4FA';
      c2.lineWidth = 2.2;
      c2.beginPath(); c2.arc(ex, gu.y, 13.5, 0, Math.PI * 2); c2.fill(); c2.stroke();
      c2.shadowBlur = 0;
      c2.fillStyle = '#14032E';
      c2.font = '900 17px ' + FONT;
      c2.textAlign = 'center';
      c2.textBaseline = 'middle';
      c2.fillText('!', ex, gu.y + 1);
      c2.restore();
      return;
    }
    c2.save();
    c2.translate(gu.x, gu.y);
    const dirX = gu.phase === 'in' ? (gu.target && gu.target.x < gu.x ? -1 : 1) : gu.dir;
    c2.scale(dirX, 1);
    const flap = Math.sin(gu.age * 11) * (reduced ? 0.4 : 1);
    const bodyCol = gu.flash > 0 ? '#FFD166' : '#FFF4FA';
    c2.fillStyle = bodyCol;
    c2.strokeStyle = '#14032E';
    c2.lineWidth = 1.6;
    // back wing
    c2.beginPath();
    c2.moveTo(-3, -2);
    c2.quadraticCurveTo(-15, -17 - flap * 9, -27, -6 - flap * 12);
    c2.quadraticCurveTo(-15, -5, -3, 2);
    c2.fill(); c2.stroke();
    // wingtip dark accents
    c2.fillStyle = '#2B1152';
    c2.beginPath();
    c2.arc(-24, -6 - flap * 11, 3.2, 0, Math.PI * 2);
    c2.fill();
    // front wing
    c2.fillStyle = bodyCol;
    c2.beginPath();
    c2.moveTo(3, -2);
    c2.quadraticCurveTo(15, -17 + flap * 9, 27, -6 + flap * 12);
    c2.quadraticCurveTo(15, -5, 3, 2);
    c2.fill(); c2.stroke();
    // body + head with soft underside shade
    c2.beginPath(); c2.ellipse(0, 2, 12.5, 7.2, 0, 0, Math.PI * 2); c2.fill(); c2.stroke();
    c2.beginPath(); c2.arc(11, -3, 5.8, 0, Math.PI * 2); c2.fill(); c2.stroke();
    // orange beak
    c2.fillStyle = '#FF7A45';
    c2.beginPath(); c2.moveTo(15.5, -4.5); c2.lineTo(23, -1.8); c2.lineTo(15.5, -0.5); c2.closePath(); c2.fill(); c2.stroke();
    // cheeky tiny 80s shades on the gull!
    c2.fillStyle = '#14032E';
    c2.fillRect(10.5, -6, 5.5, 2.8);
    c2.fillStyle = '#2AF5E4';
    c2.fillRect(11.3, -5.4, 3.5, 1.2);
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
    // gleaming chrome pole and crook
    c2.strokeStyle = '#DCE9F7';
    c2.lineWidth = 3.2;
    c2.lineCap = 'round';
    c2.beginPath();
    c2.moveTo(0, 0); c2.lineTo(0, 42);
    c2.arc(-5, 42, 5, 0, Math.PI);
    c2.stroke();
    // vibrant 80s beach canopy panels
    const R = 41;
    c2.save();
    c2.scale(1, 0.68);
    const cols = ['#FF3CAC', '#FFF4FA', '#2AF5E4', '#FFF4FA', '#FFD166', '#FFF4FA'];
    for (let i = 0; i < 6; i++) {
      c2.fillStyle = cols[i];
      c2.beginPath();
      c2.moveTo(0, 0);
      c2.arc(0, 0, R, Math.PI + (i * Math.PI) / 6, Math.PI + ((i + 1) * Math.PI) / 6);
      c2.closePath();
      c2.fill();
    }
    const sh = c2.createRadialGradient(-10, -24, 4, 0, -10, R);
    sh.addColorStop(0, 'rgba(255,255,255,.35)');
    sh.addColorStop(1, 'rgba(20,3,46,.28)');
    c2.fillStyle = sh;
    c2.beginPath(); c2.arc(0, 0, R, Math.PI, 2 * Math.PI); c2.closePath(); c2.fill();
    c2.strokeStyle = '#14032E';
    c2.lineWidth = 2;
    c2.stroke();
    c2.restore();
    c2.fillStyle = '#FFD166';
    c2.strokeStyle = '#14032E';
    c2.lineWidth = 1.4;
    c2.beginPath(); c2.arc(0, -27, 3.6, 0, Math.PI * 2); c2.fill(); c2.stroke();
    c2.restore();
  }

  function drawPickup(c2, p) {
    c2.save();
    c2.translate(p.x, p.y + Math.sin(p.age * 3.5) * 2);
    const aura = p.type === 'ice' ? '#2AF5E4' : p.type === 'cream' ? '#FF6AD5' : '#FFD166';
    c2.shadowColor = aura;
    c2.shadowBlur = 12;
    c2.fillStyle = 'rgba(18,4,46,.55)';
    c2.strokeStyle = aura;
    c2.lineWidth = 2.2;
    c2.beginPath(); c2.arc(0, 0, 17, 0, Math.PI * 2); c2.fill(); c2.stroke();
    c2.shadowBlur = 0;
    if (p.type === 'ice') {
      const ig = c2.createLinearGradient(-8, -8, 8, 8);
      ig.addColorStop(0, '#FFFFFF');
      ig.addColorStop(0.5, '#9CF6FF');
      ig.addColorStop(1, '#2AF5E4');
      c2.fillStyle = ig;
      c2.strokeStyle = '#FFFFFF';
      c2.lineWidth = 1.6;
      c2.beginPath();
      if (c2.roundRect) c2.roundRect(-8.5, -8.5, 17, 17, 3.5); else c2.rect(-8.5, -8.5, 17, 17);
      c2.fill(); c2.stroke();
      c2.strokeStyle = '#FFFFFF';
      c2.beginPath(); c2.moveTo(-4.5, -4.5); c2.lineTo(1, -4.5); c2.moveTo(-4.5, -4.5); c2.lineTo(-4.5, 1); c2.stroke();
    } else if (p.type === 'cream') {
      c2.fillStyle = '#FFFDF8';
      c2.strokeStyle = '#FF3CAC';
      c2.lineWidth = 1.6;
      [[0, 5.5, 9.5], [0, -0.5, 7.2], [0, -6.5, 4.6]].forEach(function (e) {
        c2.beginPath(); c2.ellipse(e[0], e[1], e[2], 4.2, 0, 0, Math.PI * 2); c2.fill(); c2.stroke();
      });
      c2.fillStyle = '#FF2A6D';
      c2.beginPath(); c2.arc(0, -10.5, 2.5, 0, Math.PI * 2); c2.fill();
    } else {
      // pineapple soft serve swirl in a waffle cone, with green crown
      c2.fillStyle = '#E8A857';
      c2.strokeStyle = '#14032E';
      c2.lineWidth = 1.2;
      c2.beginPath(); c2.moveTo(-6.5, 1); c2.lineTo(6.5, 1); c2.lineTo(0, 13.5); c2.closePath(); c2.fill(); c2.stroke();
      c2.fillStyle = '#FFE14D';
      c2.strokeStyle = '#FF9A2E';
      c2.lineWidth = 1.3;
      [[0, 0, 8.5], [0, -5, 6.2], [0, -9.5, 3.8]].forEach(function (e) {
        c2.beginPath(); c2.ellipse(e[0], e[1], e[2], 3.7, 0, 0, Math.PI * 2); c2.fill(); c2.stroke();
      });
      c2.strokeStyle = '#2FCB6B';
      c2.lineWidth = 2.2;
      c2.beginPath(); c2.moveTo(0, -12.5); c2.lineTo(-4.5, -17.5); c2.moveTo(0, -12.5); c2.lineTo(0, -18.5); c2.moveTo(0, -12.5); c2.lineTo(4.5, -17.5); c2.stroke();
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
    [['ice', 'ICE', '#9CF6FF', TUNE.ICE_SECS], ['cream', 'CREAM', '#FFFDF8', TUNE.CREAM_SECS]].forEach(function (e) {
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
    setDifficulty(window.TBK && typeof window.TBK.difficulty === 'function' ? window.TBK.difficulty() : 'classic');   // the table is fixed for this whole run
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
