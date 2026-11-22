/* Thirsty Tower: an original climb-and-dodge arcade game for the Thirsty Beaches site.
   Purpose: play-for-fun page. Reach the top deck, hand the sunbather the drink, beat the tide.
   Dependencies: none. Network: none. Storage: one local best-score key, wrapped in try/catch.
   Layout of this file:
     1. Pure simulation (no DOM): levels, physics, hazards, scoring. Exported for tests.
     2. Browser layer: canvas drawing, touch / keyboard / swipe input, sound, overlays. */
(function (root) {
  'use strict';

  // ======================================================================
  // 1. PURE SIMULATION
  // ======================================================================
  const W = 360;
  const H = 580;
  const GROUND_Y = 540;
  const TOP_Y = 128;
  const DECK_T = 10;
  const DT = 1 / 60;

  const TUNE = {
    RUN: 84, GROUND_ACC: 1500, AIR_ACC: 560, AIR_IDLE: 160,
    JUMP_V: 290, GRAVITY: 900, MAX_FALL: 520, HOP_V: 190,
    CLIMB: 62, NET_MOVE: 46, COYOTE: 0.1, BUFFER: 0.13, EDGE: 3,
    GRAB: 15, GRAB_NET_EXTRA: 8, LATCH_WINDOW: 0.3,
    TIDE_START: 566, TIDE_DELAY: 6, TIDE_CHECKPOINT_GAP: 70, TIDE_DELAY_CHECKPOINT: 3, TIDE_BASE: 4.0, DROWN_DEPTH: 6,
    FREEZE: 4, INVINCIBLE: 6, SPAWN_PROT: 1.8, DYING: 1.25,
    HURT_W: 4.5, HURT_H: 22,
    CLEAN_JUMP: 100, CHERRY: 300, ICE: 150, PINE: 250, ROW: 50, DELIVER: 1000, SMASH: 200,
    TIP_MAX: 3000, TIP_RATE: 25, TIP_MIN: 200,
    UMBRELLA_EXTRA: 20, UMBRELLA_COOL: 0.5, MAX_GAP: 44, LIVES: 3
  };

  /* ---------- difficulty: two tables, one switch ----------
     `classic` is the v48 tuning exactly (these are the values TUNE above starts with). `arcade86` is the harder 1986 arcade pace. gameDifficulty in kiosk/arcade-session.json picks one (the shared shell
     reads it, TBK.difficulty()); setDifficulty() is called once when a run starts, copies the tide/buff numbers into TUNE and selects the hazard ramp used by difficulty(). Nothing else differs. */
  const TUNING = {
    classic: {
      tune: { TIDE_DELAY: 6, TIDE_DELAY_CHECKPOINT: 3, TIDE_BASE: 4.0, FREEZE: 4, INVINCIBLE: 6, SPAWN_PROT: 1.8 },
      hz: { base: 1, per: 0.12, max: 2.0 }, rate: { base: 1, per: 0.1, max: 1.8 }, tide: { per: 0.15, max: 2.6 }
    },
    arcade86: {
      tune: { TIDE_DELAY: 3.5, TIDE_DELAY_CHECKPOINT: 2, TIDE_BASE: 7.2, FREEZE: 3, INVINCIBLE: 4.5, SPAWN_PROT: 1.3 },
      hz: { base: 1.35, per: 0.18, max: 2.5 }, rate: { base: 1.3, per: 0.16, max: 2.3 }, tide: { per: 0.2, max: 2.8 }
    }
  };
  let RAMP = TUNING.classic;
  function setDifficulty(mode) {
    RAMP = Object.prototype.hasOwnProperty.call(TUNING, mode) ? TUNING[mode] : TUNING.classic;
    Object.assign(TUNE, RAMP.tune);
    return RAMP === TUNING.arcade86 ? 'arcade86' : 'classic';
  }

  // ---------------------------------------------------------------------
  // Hand-authored towers. Rows are numbered from the ground (0) to the top deck.
  // segs: per row, deck pieces [x0, x1]. A hole between two pieces is a gap to jump (or a board to ride).
  // ladders: connect row r to row r+1. boards: swinging surfboard trolleys that bridge the gap a..b on row r.
  // umbrellas: spring umbrella on row r launches the runner to row r+1.
  // spawners: hazards that enter from a screen edge (side L or R), every N seconds, first after `first`.
  // ---------------------------------------------------------------------
  const LEVELS = [
    {
      name: 'Pier Steps', rows: 6, tide: 1.0,
      segs: [[[0, 360]], [[28, 360]], [[0, 140], [172, 332]], [[28, 360]], [[0, 332]], [[120, 340]]],
      ladders: [{ r: 0, x: 300 }, { r: 1, x: 60 }, { r: 2, x: 300 }, { r: 3, x: 60 }, { r: 4, x: 300 }],
      umbrellas: [{ r: 0, x: 340 }],
      crabs: [{ r: 1, x: 200, v: 15, range: [110, 270] }, { r: 4, x: 160, v: 15, range: [100, 250] }],
      spawners: [{ kind: 'ball', r: 3, side: 'R', every: 9, first: 7 }],
      pickups: [{ k: 'cherry', r: 0, x: 190 }, { k: 'cherry', r: 1, x: 180 }, { k: 'ice', r: 2, x: 235 }, { k: 'cherry', r: 3, x: 170 },
        { k: 'pine', r: 4, x: 190 }, { k: 'cherry', r: 5, x: 250 }],
      start: { x: 60 }, customer: { x: 170 }
    },
    {
      name: 'Surf Shack', rows: 6, tide: 1.08,
      segs: [[[0, 360]], [[0, 360]], [[0, 120], [210, 360]], [[0, 360]], [[30, 200], [236, 360]], [[100, 330]]],
      ladders: [{ r: 0, x: 320 }, { r: 1, x: 60 }, { r: 2, x: 320 }, { r: 3, x: 60 }, { r: 4, x: 300 }],
      boards: [{ r: 2, a: 120, b: 210, w: 48, period: 5 }],
      crabs: [{ r: 1, x: 200, v: 24, range: [110, 270] }, { r: 5, x: 220, v: 24, range: [170, 260] }],
      spawners: [{ kind: 'ball', r: 3, side: 'L', every: 7, first: 6 }, { kind: 'gull', r: 4, side: 'R', every: 9, first: 8 }],
      pickups: [{ k: 'cherry', r: 1, x: 200 }, { k: 'cherry', r: 3, x: 190 }, { k: 'ice', r: 3, x: 270 },
        { k: 'cherry', r: 4, x: 130 }, { k: 'pine', r: 5, x: 250 }],
      start: { x: 50 }, customer: { x: 160 }
    },
    {
      name: 'Tidal Tower', rows: 7, tide: 1.0,
      segs: [[[0, 360]], [[0, 360]], [[60, 360]], [[0, 160], [200, 360]], [[0, 360]], [[0, 150], [250, 360]], [[0, 260]]],
      ladders: [{ r: 0, x: 40 }, { r: 1, x: 100, kind: 'net', w: 44 }, { r: 3, x: 40 }, { r: 4, x: 310 }, { r: 5, x: 60 }],
      umbrellas: [{ r: 2, x: 335 }],
      boards: [{ r: 5, a: 150, b: 250, w: 48, period: 5.5 }],
      crabs: [{ r: 1, x: 220, v: 26, range: [150, 320] }, { r: 5, x: 300, v: 26, range: [270, 340] }],
      spawners: [{ kind: 'cooler', r: 2, side: 'R', every: 11, first: 9 }, { kind: 'ball', r: 3, side: 'L', every: 8, first: 7 },
        { kind: 'gull', r: 4, side: 'L', every: 10, first: 9 }],
      pickups: [{ k: 'cherry', r: 1, x: 180 }, { k: 'cherry', r: 2, x: 200 }, { k: 'ice', r: 3, x: 250 },
        { k: 'pine', r: 4, x: 180 }, { k: 'cherry', r: 4, x: 260 }],
      start: { x: 200 }, customer: { x: 170 }
    },
    {
      name: 'Lifeguard Maze', rows: 7, tide: 1.1,
      segs: [[[0, 360]], [[0, 150], [190, 360]], [[0, 360]], [[0, 120], [230, 360]], [[0, 360]], [[30, 180], [220, 330]], [[120, 350]]],
      ladders: [{ r: 0, x: 70 }, { r: 1, x: 310 }, { r: 2, x: 60 }, { r: 3, x: 320 }, { r: 4, x: 60 }, { r: 5, x: 290 }],
      umbrellas: [{ r: 0, x: 20 }],
      boards: [{ r: 3, a: 120, b: 230, w: 50, period: 6 }],
      crabs: [{ r: 1, x: 260, v: 28, range: [220, 330] }, { r: 3, x: 300, v: 28, range: [260, 340] }, { r: 6, x: 280, v: 28, range: [230, 330] }],
      spawners: [{ kind: 'ball', r: 2, side: 'L', every: 7, first: 6 }, { kind: 'cooler', r: 4, side: 'L', every: 9, first: 8 },
        { kind: 'gull', r: 5, side: 'R', every: 8, first: 9 }],
      pickups: [{ k: 'cherry', r: 1, x: 60 }, { k: 'ice', r: 2, x: 200 }, { k: 'cherry', r: 4, x: 200 },
        { k: 'pine', r: 4, x: 300 }, { k: 'cherry', r: 6, x: 250 }],
      start: { x: 320 }, customer: { x: 190 }
    }
  ];

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function rowY(r, n) { return Math.round(GROUND_Y - r * (GROUND_Y - TOP_Y) / (n - 1)); }

  // Turns an authored tower into the shapes the simulation uses. `mirror` flips it left to right
  // (used on every second lap so the loop is not a straight repeat).
  function resolveLevel(def, mirror) {
    const n = def.rows;
    const fx = (x) => (mirror ? W - x : x);
    const ys = [];
    for (let r = 0; r < n; r++) ys.push(rowY(r, n));
    const segs = [];
    def.segs.forEach((list, r) => list.forEach((s) => {
      const x0 = mirror ? W - s[1] : s[0];
      const x1 = mirror ? W - s[0] : s[1];
      segs.push({ row: r, x0, x1, y: ys[r], dyn: false, dx: 0 });
    }));
    segs.sort((a, b) => a.row - b.row || a.x0 - b.x0);
    const ladders = def.ladders.map((l) => {
      const net = l.kind === 'net';
      const w = l.w || (net ? 44 : 20);
      return { r: l.r, x: fx(l.x), kind: net ? 'net' : 'ladder', w,
        gw: net ? w / 2 + TUNE.GRAB_NET_EXTRA : TUNE.GRAB, yb: ys[l.r], yt: ys[l.r + 1] };
    });
    const boards = (def.boards || []).map((b, i) => {
      const a = mirror ? W - b.b : b.a;
      const bb = mirror ? W - b.a : b.b;
      const cx = (a + bb) / 2;
      const amp = (bb - a - b.w) / 2 + 8;
      return { row: b.r, y: ys[b.r], cx, amp, w: b.w, period: b.period, phase: i * 1.3, dyn: true,
        x0: cx - b.w / 2, x1: cx + b.w / 2, dx: 0, cxNow: cx, id: 'b' + i };
    });
    const sp = (GROUND_Y - TOP_Y) / (n - 1);
    return {
      name: def.name, n, sp, ys, segs, ladders, boards, mirror: !!mirror, tide: def.tide || 1,
      umbrellas: (def.umbrellas || []).map((u) => ({ r: u.r, x: fx(u.x) })),
      crabs: (def.crabs || []).map((c) => ({ r: c.r, x: fx(c.x), v: c.v, range: c.range ? [fx(c.range[1]), fx(c.range[0])].sort((p, q) => p - q) : null })),
      spawners: (def.spawners || []).map((s) => ({ kind: s.kind, r: s.r, side: mirror ? (s.side === 'L' ? 'R' : 'L') : s.side, every: s.every, first: s.first })),
      pickups: def.pickups.map((p) => ({ k: p.k, r: p.r, x: fx(p.x) })),
      start: { x: fx(def.start.x) }, customer: { x: fx(def.customer.x) }
    };
  }

  function levelFor(levelNo) {
    const idx = (levelNo - 1) % LEVELS.length;
    const lap = Math.floor((levelNo - 1) / LEVELS.length);
    return resolveLevel(LEVELS[idx], lap % 2 === 1);
  }

  // Slow first tower, then every tower a little faster; layouts loop with the speed carried over.
  function difficulty(levelNo, res) {
    const k = Math.max(0, levelNo - 1);
    return {
      hz: Math.min(RAMP.hz.base + RAMP.hz.per * k, RAMP.hz.max),
      rate: Math.min(RAMP.rate.base + RAMP.rate.per * k, RAMP.rate.max),
      tide: TUNE.TIDE_BASE * ((res && res.tide) || 1) * Math.min(1 + RAMP.tide.per * k, RAMP.tide.max)
    };
  }

  // The tide waits `delay` seconds, then rises at `speed` px/s. Frozen time does nothing.
  function tideStep(st, dt, speed, frozen) {
    if (frozen) return { y: st.y, delay: st.delay };
    if (st.delay > 0) return { y: st.y, delay: Math.max(0, st.delay - dt) };
    return { y: Math.max(0, st.y - speed * dt), delay: 0 };
  }

  // Faster delivery, bigger tip. Never below a small floor so a slow clear still pays something.
  function tipFor(seconds) {
    return Math.max(TUNE.TIP_MIN, Math.round((TUNE.TIP_MAX - TUNE.TIP_RATE * seconds) / 10) * 10);
  }

  function aabbOverlap(a, b) { return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0; }

  function playerBox(p) {
    return { x0: p.x - TUNE.HURT_W, x1: p.x + TUNE.HURT_W, y0: p.y - TUNE.HURT_H - 1, y1: p.y - 1 };
  }

  function ballHop(h) { return h.falling ? 0 : Math.abs(Math.sin(h.ph * Math.PI / 0.6)) * 10; }

  // Hit boxes are a little smaller than the drawn sprites so near misses feel fair.
  function hazardBox(h) {
    if (h.t === 'ball') { const hop = ballHop(h); return { x0: h.x - 4.5, x1: h.x + 4.5, y0: h.y - 12 - hop, y1: h.y - hop }; }
    if (h.t === 'cooler') return { x0: h.x - 10, x1: h.x + 10, y0: h.y - 17, y1: h.y };
    if (h.t === 'crab') return { x0: h.x - 6, x1: h.x + 6, y0: h.y - 8, y1: h.y };
    return { x0: h.x - 8, x1: h.x + 8, y0: h.y - 6, y1: h.y + 4 };
  }

  // Generous grab zone: dirY -1 = grab to climb up, +1 = grab to climb down. Works from the ground or mid-air.
  function ladderGrab(res, p, dirY) {
    let best = null;
    let bd = 1e9;
    for (const L of res.ladders) {
      const dx = Math.abs(p.x - L.x);
      if (dx > L.gw) continue;
      const ok = dirY < 0 ? (p.y <= L.yb + 3 && p.y > L.yt + 2) : (p.y >= L.yt - 3 && p.y < L.yb - 2);
      if (ok && dx < bd) { best = L; bd = dx; }
    }
    return best;
  }

  // ---- reachability -----------------------------------------------------
  function segContaining(res, row, x, margin) {
    const m = margin || 0;
    return res.segs.find((s) => s.row === row && x >= s.x0 + m && x <= s.x1 - m) || null;
  }

  // Walks the graph of deck pieces (walk, jump a gap, ladder, board, umbrella, fall off an end) from the start
  // to the customer. Returns { ok, errors, steps } where steps is the route the bot in the tests follows.
  function analyzeLevel(res) {
    const errors = [];
    const top = res.n - 1;
    for (let r = 0; r < res.n; r++) if (!res.segs.some((s) => s.row === r)) errors.push('row ' + r + ' has no deck');
    for (const s of res.segs) {
      if (s.x1 - s.x0 < 24) errors.push('deck too short on row ' + s.row);
      if (s.x0 < 0 || s.x1 > W) errors.push('deck outside the screen on row ' + s.row);
    }
    for (const a of res.segs) for (const b of res.segs) {
      if (a !== b && a.row === b.row && a.x0 < b.x1 && b.x0 < a.x1) errors.push('decks overlap on row ' + a.row);
    }
    const start = segContaining(res, 0, res.start.x, 10);
    const goal = segContaining(res, top, res.customer.x, 24);
    if (!start) errors.push('start is not on the ground deck');
    if (!goal) errors.push('customer is not on the top deck');
    const edges = new Map(res.segs.map((s) => [s, []]));
    const link = (a, b, step, oneWay) => {
      if (!a || !b) return;
      edges.get(a).push(Object.assign({ from: a, to: b }, step));
      if (!oneWay) edges.get(b).push(Object.assign({ from: b, to: a }, step));
    };
    for (const L of res.ladders) {
      const a = segContaining(res, L.r, L.x, 8);
      const b = segContaining(res, L.r + 1, L.x, 8);
      if (!a || !b) errors.push('ladder at row ' + L.r + ' x=' + L.x + ' does not land on a deck at both ends');
      else link(a, b, { type: 'ladder', ladder: L });
    }
    for (const U of res.umbrellas) {
      const a = segContaining(res, U.r, U.x, 12);
      const b = segContaining(res, U.r + 1, U.x, 12);
      if (!a || !b) errors.push('umbrella at row ' + U.r + ' x=' + U.x + ' has no deck under it or above it');
      else link(a, b, { type: 'umbrella', umbrella: U }, true);
    }
    for (const a of res.segs) for (const b of res.segs) {
      if (a.row !== b.row || b.x0 <= a.x1) continue;
      const gap = b.x0 - a.x1;
      if (gap <= TUNE.MAX_GAP) link(a, b, { type: 'jump', gap });
    }
    for (const B of res.boards) {
      const a = res.segs.filter((s) => s.row === B.row && s.x1 <= B.cx).sort((p, q) => q.x1 - p.x1)[0];
      const b = res.segs.filter((s) => s.row === B.row && s.x0 >= B.cx).sort((p, q) => p.x0 - q.x0)[0];
      if (!a || !b) { errors.push('board on row ' + B.row + ' has no deck on both sides'); continue; }
      const left = B.cx - B.amp - B.w / 2;
      const right = B.cx + B.amp + B.w / 2;
      if (left > a.x1 + 12 || right < b.x0 - 12) errors.push('board on row ' + B.row + ' does not reach both decks');
      else link(a, b, { type: 'board', board: B });
    }
    // Walking off an end drops to the deck below. Needed so that falling never strands a runner.
    for (const s of res.segs) {
      for (const side of [-1, 1]) {
        const off = side < 0 ? s.x0 - 6 : s.x1 + 6;
        if (off < 0 || off > W) continue;
        for (let r = s.row - 1; r >= 0; r--) {
          const t = segContaining(res, r, off, 0);
          if (t) { link(s, t, { type: 'fall', side }, true); break; }
        }
      }
    }
    // hazards must enter on a real deck
    for (const sp of res.spawners) {
      if (sp.kind === 'gull') continue; // gulls fly in, they need no deck
      const x = sp.side === 'L' ? 0 : W;
      if (!segContaining(res, sp.r, x, 0)) errors.push('spawner ' + sp.kind + ' on row ' + sp.r + ' enters where there is no deck');
    }
    for (const c of res.crabs) if (!segContaining(res, c.r, c.x, 8)) errors.push('crab not on a deck at row ' + c.r);
    for (const k of res.pickups) if (!segContaining(res, k.r, k.x, 4)) errors.push('pickup ' + k.k + ' not over a deck at row ' + k.r);
    // search
    const steps = [];
    if (start && goal) {
      const prev = new Map([[start, null]]);
      const queue = [start];
      while (queue.length) {
        const cur = queue.shift();
        if (cur === goal) break;
        for (const e of edges.get(cur)) {
          if (!prev.has(e.to)) { prev.set(e.to, e); queue.push(e.to); }
        }
      }
      if (!prev.has(goal)) errors.push('the top deck cannot be reached from the start');
      else {
        let c = goal;
        while (prev.get(c)) { steps.unshift(prev.get(c)); c = prev.get(c).from; }
      }
    }
    const reachable = new Set([start]);
    if (start) {
      const q = [start];
      while (q.length) { const c = q.shift(); for (const e of edges.get(c)) if (!reachable.has(e.to)) { reachable.add(e.to); q.push(e.to); } }
    }
    return { ok: errors.length === 0, errors, steps, reachable: reachable.size, total: res.segs.length };
  }

  // ---- game state -------------------------------------------------------
  const NO_INPUT = Object.freeze({ x: 0, y: 0, jump: false, latch: 0 });

  function ev(g, k, x, y, extra) {
    const e = { k, x: x || 0, y: y || 0 };
    if (extra) Object.assign(e, extra);
    g.events.push(e);
    if (g.events.length > 200) g.events.shift();
  }

  function platAt(g, row, x) {
    let best = null;
    for (const p of g.plats) {
      if (p.row !== row) continue;
      if (x >= p.x0 - TUNE.EDGE && x <= p.x1 + TUNE.EDGE) { if (!best || !p.dyn) best = p; }
    }
    return best;
  }

  function supportRow(g, row, x) {
    const cx = x < 0 ? 0 : x > W ? W : x;
    for (const s of g.res.segs) if (s.row === row && cx >= s.x0 - TUNE.EDGE && cx <= s.x1 + TUNE.EDGE) return s;
    return null;
  }

  // Nearest deck piece on a row, for respawning when the exact x is over a gap or a moving board.
  function nearestSeg(res, row, x) {
    let best = null;
    let bd = 1e9;
    for (const s of res.segs) {
      if (s.row !== row) continue;
      const cx = clamp(x, s.x0 + 12, s.x1 - 12);
      const d = Math.abs(cx - x);
      if (d < bd) { bd = d; best = { seg: s, x: cx }; }
    }
    return best;
  }

  // A runner who loses a life restarts from the highest deck reached so far (a kind checkpoint),
  // with the tide pushed back to a safe distance below it.
  function makePlayer(g) {
    const res = g.res;
    const cp = g.cp && g.cp.row > 0 ? nearestSeg(res, g.cp.row, g.cp.x) : null;
    const seg = cp ? cp.seg : platAt(g, 0, res.start.x);
    const x = cp ? cp.x : res.start.x;
    return { x, y: seg.y, vx: 0, vy: 0, state: 'ground', face: 1, plat: seg, ladder: null,
      coyote: 0, jumpBuf: 0, upReq: 0, downReq: 0, latch: 0, run: 0, climb: 0 };
  }

  function createGame(opts) {
    opts = opts || {};
    const g = {
      level: opts.level || 1, lives: opts.lives == null ? TUNE.LIVES : opts.lives, score: opts.score || 0,
      hazardsOn: opts.hazards !== false, events: [], status: 'play', lastTip: 0, deaths: 0
    };
    loadLevel(g, g.level);
    return g;
  }

  function loadLevel(g, levelNo) {
    const res = levelFor(levelNo);
    g.level = levelNo;
    g.res = res;
    g.diff = difficulty(levelNo, res);
    g.plats = res.segs.concat(res.boards);
    g.pickups = res.pickups.map((p) => ({ k: p.k, x: p.x, row: p.r, y: res.ys[p.r], taken: false }));
    g.umb = res.umbrellas.map((u) => ({ r: u.r, x: u.x, y: res.ys[u.r], cool: 0, squash: 0,
      v: Math.sqrt(2 * TUNE.GRAVITY * (res.sp + TUNE.UMBRELLA_EXTRA)) }));
    g.rowsSeen = { 0: true };
    g.cp = { row: 0, x: res.start.x };
    g.tipT = 0;
    resetAttempt(g);
  }

  function updateBoards(g) {
    for (const b of g.res.boards) {
      const cx = b.cx + b.amp * Math.sin(2 * Math.PI * g.time / b.period + b.phase);
      b.dx = cx - b.cxNow;
      b.cxNow = cx;
      b.x0 = cx - b.w / 2;
      b.x1 = cx + b.w / 2;
    }
  }

  // Start (or restart after losing a life) a run up the current tower.
  function resetAttempt(g) {
    const res = g.res;
    g.status = 'play';
    g.time = 0; g.dyingT = 0;
    const cpRow = g.cp ? g.cp.row : 0;
    g.tideY = cpRow > 0 ? res.ys[cpRow] + TUNE.TIDE_CHECKPOINT_GAP : TUNE.TIDE_START;
    g.tideDelay = cpRow > 0 ? TUNE.TIDE_DELAY_CHECKPOINT : TUNE.TIDE_DELAY;
    g.freezeT = 0; g.invT = 0; g.prot = TUNE.SPAWN_PROT;
    g.hazards = []; g.trail = []; g.nextId = 1;
    for (const b of res.boards) b.cxNow = b.cx + b.amp * Math.sin(b.phase);
    updateBoards(g);
    for (const b of res.boards) b.dx = 0;
    g.p = makePlayer(g);
    for (const u of g.umb) { u.cool = 0; u.squash = 0; }
    g.spawners = res.spawners.map((s) => ({ kind: s.kind, r: s.r, side: s.side, every: s.every, timer: s.first, warn: false }));
    if (g.hazardsOn) {
      for (const c of res.crabs) {
        const seg = segContaining(res, c.r, c.x, 0);
        const min = Math.max(seg.x0 + 8, c.range ? c.range[0] : 0);
        const max = Math.min(seg.x1 - 8, c.range ? c.range[1] : W);
        g.hazards.push({ id: g.nextId++, t: 'crab', row: c.r, x: clamp(c.x, min, max), y: res.ys[c.r], dir: 1, speed: c.v * g.diff.hz,
          min, max, pause: 0, ph: 0, cleared: false });
      }
    }
  }

  function nextLevel(g) { loadLevel(g, g.level + 1); }

  function noteRow(g, row) {
    if (row >= g.cp.row) g.cp = { row, x: g.p.x };
    if (g.rowsSeen[row]) return;
    g.rowsSeen[row] = true;
    g.score += TUNE.ROW;
    ev(g, 'row', g.p.x, g.p.y - 30, { text: '+' + TUNE.ROW });
  }

  function loseLife(g, cause) {
    const p = g.p;
    g.lives -= 1;
    g.deaths += 1;
    g.status = 'dying';
    g.dyingT = TUNE.DYING;
    g.cause = cause;
    p.vy = cause === 'drown' ? -60 : -210;
    p.vx = 0;
    p.state = 'air';
    p.ladder = null;
    ev(g, cause === 'drown' ? 'drown' : 'hit', p.x, p.y - 12);
  }

  function jumpNow(g) {
    const p = g.p;
    p.vy = -TUNE.JUMP_V; p.state = 'air'; p.plat = null; p.jumpBuf = 0; p.coyote = 0;
    ev(g, 'jump', p.x, p.y);
  }

  function grabLadder(g, L, input, dirY) {
    const p = g.p;
    p.state = 'ladder'; p.ladder = L; p.plat = null; p.vx = 0; p.vy = 0; p.coyote = 0;
    p.x = L.kind === 'net' ? clamp(p.x, L.x - L.w / 2 + 5, L.x + L.w / 2 - 5) : L.x;
    if (dirY > 0) p.y = Math.max(p.y, L.yt + 1);
    p.latch = input.y === 0 ? dirY : 0;
    p.jumpBuf = 0; p.upReq = 0; p.downReq = 0;
    ev(g, 'grab', p.x, p.y);
  }

  function exitLadder(g, row) {
    const p = g.p;
    p.ladder = null; p.latch = 0; p.vx = 0; p.vy = 0;
    p.plat = platAt(g, row, p.x);
    if (p.plat) { p.state = 'ground'; noteRow(g, row); } else { p.state = 'air'; p.coyote = 0; }
  }

  function stepLadder(g, input, dir) {
    const p = g.p;
    const L = p.ladder;
    if (input.y !== 0) p.latch = 0;
    if (input.latch) p.latch = input.latch;
    const cy = input.y || p.latch;
    p.y += cy * TUNE.CLIMB * DT;
    if (cy) p.climb += DT;
    if (L.kind === 'net') p.x = clamp(p.x + dir * TUNE.NET_MOVE * DT, L.x - L.w / 2 + 5, L.x + L.w / 2 - 5);
    if (p.jumpBuf > 0 && dir !== 0) {
      p.state = 'air'; p.ladder = null; p.vx = dir * TUNE.RUN; p.vy = -TUNE.HOP_V; p.coyote = 0; p.jumpBuf = 0; p.latch = 0;
      p.face = dir;
      ev(g, 'jump', p.x, p.y);
      return;
    }
    if (p.y <= L.yt) { p.y = L.yt; exitLadder(g, L.r + 1); } else if (p.y >= L.yb) { p.y = L.yb; exitLadder(g, L.r); }
  }

  function landing(g, y0, y1, x) {
    let best = null;
    for (const pl of g.plats) {
      if (x < pl.x0 - TUNE.EDGE || x > pl.x1 + TUNE.EDGE) continue;
      if (y0 <= pl.y + 1 && y1 >= pl.y) { if (!best || pl.y < best.y) best = pl; }
    }
    return best;
  }

  function stepPlayer(g, input) {
    const p = g.p;
    p.jumpBuf = Math.max(0, p.jumpBuf - DT);
    p.upReq = Math.max(0, p.upReq - DT);
    p.downReq = Math.max(0, p.downReq - DT);
    if (input.jump) p.jumpBuf = TUNE.BUFFER;
    if (input.latch < 0) p.upReq = TUNE.LATCH_WINDOW; else if (input.latch > 0) p.downReq = TUNE.LATCH_WINDOW;
    const dir = input.x > 0 ? 1 : input.x < 0 ? -1 : 0;
    const wantUp = input.y < 0 || p.upReq > 0;
    const wantDown = input.y > 0 || p.downReq > 0;
    if (p.state === 'ladder') { stepLadder(g, input, dir); return; }
    if (dir) p.face = dir;

    if (wantUp !== wantDown) {
      const L = ladderGrab(g.res, p, wantUp ? -1 : 1);
      if (L) { grabLadder(g, L, input, wantUp ? -1 : 1); return; }
    }

    const grounded = p.state === 'ground';
    const acc = grounded ? TUNE.GROUND_ACC : (dir ? TUNE.AIR_ACC : TUNE.AIR_IDLE);
    const target = dir * TUNE.RUN;
    if (p.vx < target) p.vx = Math.min(target, p.vx + acc * DT);
    else if (p.vx > target) p.vx = Math.max(target, p.vx - acc * DT);

    if (grounded) {
      if (p.plat && p.plat.dyn) p.x += p.plat.dx;
      if (p.jumpBuf > 0) {
        jumpNow(g);
        p.x += p.vx * DT;
      } else {
        p.x += p.vx * DT;
        if (Math.abs(p.vx) > 1) p.run += Math.abs(p.vx) * DT;
      }
      p.x = clamp(p.x, 8, W - 8);
      if (p.state === 'ground' && !(p.plat && p.x >= p.plat.x0 - TUNE.EDGE && p.x <= p.plat.x1 + TUNE.EDGE)) {
        const alt = p.plat ? platAt(g, p.plat.row, p.x) : null;
        if (alt) p.plat = alt;
        else { p.state = 'air'; p.coyote = TUNE.COYOTE; p.vy = 0; p.plat = null; }
      }
    } else {
      if (p.coyote > 0) p.coyote -= DT;
      if (p.jumpBuf > 0 && p.coyote > 0) jumpNow(g);
      p.vy = Math.min(TUNE.MAX_FALL, p.vy + TUNE.GRAVITY * DT);
      const y0 = p.y;
      p.y += p.vy * DT;
      p.x = clamp(p.x + p.vx * DT, 8, W - 8);
      if (p.vy >= 0) {
        const hit = landing(g, y0, p.y, p.x);
        if (hit) {
          p.y = hit.y; p.vy = 0; p.state = 'ground'; p.plat = hit; p.coyote = 0;
          ev(g, 'land', p.x, p.y);
          noteRow(g, hit.row);
        }
      }
    }

    if (p.state === 'ground' && p.plat) {
      for (const u of g.umb) {
        if (u.cool <= 0 && p.plat.row === u.r && Math.abs(p.x - u.x) < 13) {
          p.state = 'air'; p.vy = -u.v; p.plat = null; p.coyote = 0; p.jumpBuf = 0;
          u.cool = TUNE.UMBRELLA_COOL; u.squash = 0.35;
          ev(g, 'bounce', u.x, u.y);
        }
      }
    }
  }

  // ---- hazards ----------------------------------------------------------
  function spawnHazard(g, s) {
    if (g.hazards.length >= 14) return;
    const res = g.res;
    const hz = g.diff.hz;
    const dir = s.side === 'L' ? 1 : -1;
    const x = s.side === 'L' ? -16 : W + 16;
    if (s.kind === 'gull') {
      g.hazards.push({ id: g.nextId++, t: 'gull', row: s.r, x, y: res.ys[s.r] - 36, base: res.ys[s.r], dir, speed: 104 * hz, ph: 0, cleared: false });
    } else {
      g.hazards.push({ id: g.nextId++, t: s.kind, row: s.r, x, y: res.ys[s.r], dir, speed: (s.kind === 'ball' ? 40 : 58) * hz,
        vy: 0, falling: false, ph: 0, cleared: false });
    }
  }

  function stepRoller(g, h) {
    const res = g.res;
    h.ph += DT;
    if (!h.falling) {
      h.x += h.dir * h.speed * DT;
      if (h.x < -24 || h.x > W + 24) { h.dead = true; return; }
      if (!supportRow(g, h.row, h.x)) { h.falling = true; h.vy = 0; }
    } else {
      h.vy += 620 * DT;
      const y0 = h.y;
      h.y += h.vy * DT;
      h.x += h.dir * h.speed * 0.5 * DT;
      for (let r = h.row - 1; r >= 0; r--) {
        const yy = res.ys[r];
        if (y0 <= yy && h.y >= yy && supportRow(g, r, h.x)) {
          h.y = yy; h.row = r; h.falling = false; h.dir = -h.dir; h.vy = 0;
          break;
        }
      }
      if (h.y > H + 30) h.dead = true;
    }
  }

  function stepCrab(h) {
    if (h.pause > 0) { h.pause -= DT; return; }
    h.ph += DT;
    h.x += h.dir * h.speed * DT;
    if (h.x <= h.min) { h.x = h.min; h.dir = 1; h.pause = 0.5; } else if (h.x >= h.max) { h.x = h.max; h.dir = -1; h.pause = 0.5; }
  }

  function stepGull(h) {
    h.ph += DT;
    h.x += h.dir * h.speed * DT;
    const u = clamp(h.dir > 0 ? h.x / W : 1 - h.x / W, 0, 1);
    const sw = Math.sin(Math.PI * u);
    h.y = h.base - 36 + 24 * sw * sw;
    if (h.x < -30 || h.x > W + 30) h.dead = true;
  }

  function stepHazards(g) {
    for (const s of g.spawners) {
      s.timer -= DT;
      if (s.kind === 'gull' && !s.warn && s.timer <= 1.0 && s.timer > 0) {
        s.warn = true;
        ev(g, 'warn', s.side === 'L' ? 10 : W - 10, g.res.ys[s.r] - 30, { side: s.side, row: s.r });
      }
      if (s.timer <= 0) {
        spawnHazard(g, s);
        s.timer += s.every / g.diff.rate;
        s.warn = false;
      }
    }
    for (const h of g.hazards) {
      if (h.t === 'crab') stepCrab(h);
      else if (h.t === 'gull') stepGull(h);
      else stepRoller(g, h);
    }
    g.hazards = g.hazards.filter((h) => !h.dead);
  }

  function hazardTop(h) { return hazardBox(h).y0; }

  function collide(g) {
    const p = g.p;
    const pb = playerBox(p);
    for (const k of g.pickups) {
      if (k.taken) continue;
      if (Math.abs(p.x - k.x) < 13 && Math.abs((p.y - 12) - (k.y - 12)) < 17) {
        k.taken = true;
        if (k.k === 'cherry') { g.score += TUNE.CHERRY; ev(g, 'cherry', k.x, k.y - 14, { text: '+' + TUNE.CHERRY }); }
        else if (k.k === 'ice') { g.freezeT = TUNE.FREEZE; g.score += TUNE.ICE; ev(g, 'ice', k.x, k.y - 14, { text: 'FREEZE!' }); }
        else { g.invT = TUNE.INVINCIBLE; g.score += TUNE.PINE; ev(g, 'pine', k.x, k.y - 14, { text: 'SUPER SWIRL!' }); }
      }
    }
    const frozen = g.freezeT > 0;
    for (const h of g.hazards) {
      if (h.dead) continue;
      if (p.state === 'air' && !h.cleared && !(h.falling) && Math.abs(p.x - h.x) < 7) {
        const top = hazardTop(h);
        if (p.y - 1 < top && p.y > top - 48) {
          h.cleared = true;
          g.score += TUNE.CLEAN_JUMP;
          ev(g, 'clean', p.x, p.y - 26, { text: '+' + TUNE.CLEAN_JUMP });
        }
      }
      if (frozen || g.prot > 0) continue;
      if (aabbOverlap(pb, hazardBox(h))) {
        if (g.invT > 0) {
          h.dead = true;
          g.score += TUNE.SMASH;
          ev(g, 'smash', h.x, h.y - 8, { text: '+' + TUNE.SMASH });
        } else {
          loseLife(g, 'hit');
          return;
        }
      }
    }
    if (p.y - TUNE.DROWN_DEPTH > g.tideY) { loseLife(g, 'drown'); return; }
    const top = g.res.n - 1;
    if (p.state === 'ground' && p.plat && p.plat.row === top && Math.abs(p.x - g.res.customer.x) < 36) deliver(g);
  }

  function deliver(g) {
    const tip = tipFor(g.tipT);
    g.lastTip = tip;
    g.score += TUNE.DELIVER + tip;
    g.status = 'delivered';
    g.p.vx = 0;
    ev(g, 'deliver', g.res.customer.x, g.res.ys[g.res.n - 1] - 30, { text: 'TIP +' + tip });
  }

  function stepPlay(g, input) {
    g.time += DT;
    g.tipT += DT;
    if (g.freezeT > 0) g.freezeT = Math.max(0, g.freezeT - DT);
    if (g.invT > 0) g.invT = Math.max(0, g.invT - DT);
    if (g.prot > 0) g.prot = Math.max(0, g.prot - DT);
    updateBoards(g);
    for (const u of g.umb) { u.cool = Math.max(0, u.cool - DT); u.squash = Math.max(0, u.squash - DT); }
    const frozen = g.freezeT > 0;
    const wasWaiting = g.tideDelay > 0;
    const t = tideStep({ y: g.tideY, delay: g.tideDelay }, DT, g.diff.tide, frozen);
    g.tideY = t.y; g.tideDelay = t.delay;
    if (wasWaiting && g.tideDelay === 0) ev(g, 'tide', W / 2, g.tideY - 10, { text: 'TIDE IS RISING!' });
    stepPlayer(g, input);
    if (g.hazardsOn && !frozen) stepHazards(g);
    if (g.status === 'play') collide(g);
    if (g.invT > 0) { g.trail.push({ x: g.p.x, y: g.p.y }); if (g.trail.length > 16) g.trail.shift(); } else if (g.trail.length) g.trail.length = 0;
  }

  function stepDying(g) {
    const p = g.p;
    g.dyingT -= DT;
    p.vy += TUNE.GRAVITY * 0.7 * DT;
    p.y += p.vy * DT;
    if (g.dyingT <= 0) {
      if (g.lives > 0) resetAttempt(g);
      else { g.status = 'gameover'; ev(g, 'gameover', W / 2, H / 2); }
    }
  }

  // One fixed 1/60 s tick. input = { x: -1|0|1, y: -1 (up) |0| 1 (down), jump: bool (pressed this tick), latch: -1|0|1 }
  function step(g, input) {
    input = input || NO_INPUT;
    if (g.status === 'play') stepPlay(g, input);
    else if (g.status === 'dying') stepDying(g);
    return g;
  }

  const api = {
    W, H, GROUND_Y, TOP_Y, DECK_T, DT, TUNE, LEVELS, NO_INPUT,
    resolveLevel, levelFor, analyzeLevel, difficulty, tideStep, tipFor, aabbOverlap, playerBox, hazardBox, ladderGrab,
    createGame, loadLevel, resetAttempt, nextLevel, step, platAt, TUNING, setDifficulty, difficultyMode: () => (RAMP === TUNING.arcade86 ? 'arcade86' : 'classic')
  };

  // ======================================================================
  // 2. BROWSER LAYER (drawing, input, sound, overlays). Skipped when loaded in Node.
  // ======================================================================
  const COL = { pink: '#FF3CAC', teal: '#2AF5E4', gold: '#FFD166', orange: '#FF7A45', ink: '#160430', foam: '#FFF4FA', purple: '#8A3FFC' };
  const TRIM = [COL.pink, COL.teal, COL.gold];
  const FONT = '"Bungee", "Arial Black", Impact, sans-serif';
  const HORIZON = 372;

  function rr(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // ---- local 1986 Miami artwork assets ----
  const ART = {};
  let onArtLoaded = null;
  if (typeof Image !== 'undefined') {
    [['bg', '/kiosk/games/thirsty-tower/assets/bg-miami-tower.webp'],
     ['crab', '/kiosk/games/thirsty-tower/assets/crab.png']].forEach(([k, src]) => {
      const im = new Image();
      im.onload = () => { if (typeof onArtLoaded === 'function') onArtLoaded(k); };
      im.src = src;
      ART[k] = im;
    });
  }

  // ---- static scene: sky, sun, sea, palms, tower frame, decks, ladders (drawn once per size / tower) ----
  function drawScene(c, res) {
    if (ART.bg && ART.bg.complete && ART.bg.naturalWidth > 0) {
      c.save();
      if (res.mirror) { c.translate(W, 0); c.scale(-1, 1); }
      c.drawImage(ART.bg, 0, 0, W, H);
      c.restore();
    } else {
      // instant fallback twilight gradient while image decodes
      let gr = c.createLinearGradient(0, 0, 0, HORIZON);
      gr.addColorStop(0, '#090126'); gr.addColorStop(0.5, '#6A1288'); gr.addColorStop(1, '#FF8F5A');
      c.fillStyle = gr; c.fillRect(0, 0, W, HORIZON);
      gr = c.createLinearGradient(0, HORIZON, 0, H);
      gr.addColorStop(0, '#2C1B78'); gr.addColorStop(1, '#060722');
      c.fillStyle = gr; c.fillRect(0, HORIZON, W, H - HORIZON);
    }

    // tower structural frame: gleaming steel posts & neon cross braces
    for (const s of res.segs) {
      const below = res.segs.filter((o) => o.row === s.row - 1);
      const posts = s.x1 - s.x0 > 70 ? [s.x0 + 8, s.x1 - 8] : [(s.x0 + s.x1) / 2];
      for (const px of posts) {
        const under = below.find((o) => px >= o.x0 && px <= o.x1);
        const bottom = under ? under.y : H;
        c.fillStyle = '#240844'; c.fillRect(px - 3.2, s.y + DECK_T, 6.4, bottom - s.y - DECK_T);
        c.fillStyle = 'rgba(170,115,255,0.52)'; c.fillRect(px - 3, s.y + DECK_T, 1.8, bottom - s.y - DECK_T);
        c.fillStyle = 'rgba(42,245,228,0.28)'; c.fillRect(px + 1.5, s.y + DECK_T, 1.2, bottom - s.y - DECK_T);
      }
      if (posts.length === 2 && s.row > 0) {
        const under = below.find((o) => posts[0] >= o.x0 && posts[1] <= o.x1);
        const bottom = under ? under.y : s.y + res.sp;
        c.strokeStyle = 'rgba(255,60,172,0.34)'; c.lineWidth = 1.6;
        c.beginPath(); c.moveTo(posts[0], s.y + DECK_T); c.lineTo(posts[1], bottom); c.moveTo(posts[1], s.y + DECK_T); c.lineTo(posts[0], bottom); c.stroke();
      }
    }
    // ladders & neon climbing nets
    for (const L of res.ladders) {
      if (L.kind === 'net') {
        const x0 = L.x - L.w / 2;
        c.save();
        c.beginPath(); c.rect(x0, L.yt, L.w, L.yb - L.yt); c.clip();
        c.strokeStyle = 'rgba(42,245,228,0.92)'; c.lineWidth = 1.9;
        c.beginPath();
        for (let i = -L.w; i < L.yb - L.yt + L.w; i += 11) {
          c.moveTo(x0, L.yt + i); c.lineTo(x0 + L.w, L.yt + i + L.w);
          c.moveTo(x0, L.yt + i + L.w); c.lineTo(x0 + L.w, L.yt + i);
        }
        c.stroke();
        c.restore();
        c.fillStyle = '#FFF4B8'; c.fillRect(x0 - 2, L.yt, 3.2, L.yb - L.yt); c.fillRect(x0 + L.w - 1.2, L.yt, 3.2, L.yb - L.yt);
      } else {
        c.strokeStyle = '#240748'; c.lineWidth = 6.2;
        c.beginPath(); c.moveTo(L.x - 7, L.yt); c.lineTo(L.x - 7, L.yb); c.moveTo(L.x + 7, L.yt); c.lineTo(L.x + 7, L.yb); c.stroke();
        c.strokeStyle = '#FFE478'; c.lineWidth = 2.8;
        c.beginPath(); c.moveTo(L.x - 7, L.yt); c.lineTo(L.x - 7, L.yb); c.moveTo(L.x + 7, L.yt); c.lineTo(L.x + 7, L.yb); c.stroke();
        c.strokeStyle = '#FFB347'; c.lineWidth = 2.2;
        c.beginPath();
        for (let y = L.yb - 8; y > L.yt + 2; y -= 9) { c.moveTo(L.x - 7, y); c.lineTo(L.x + 7, y); }
        c.stroke();
      }
    }
    // 1986 neon-trimmed boardwalk pier decks with glowing marquee bulbs
    for (const s of res.segs) {
      const col = TRIM[s.row % 3];
      c.fillStyle = 'rgba(0,0,0,0.42)'; c.fillRect(s.x0, s.y + DECK_T, s.x1 - s.x0, 4.5);
      const wg = c.createLinearGradient(0, s.y, 0, s.y + DECK_T);
      wg.addColorStop(0, '#8A3B86'); wg.addColorStop(0.5, '#591D62'); wg.addColorStop(1, '#310E40');
      c.fillStyle = wg; c.fillRect(s.x0, s.y, s.x1 - s.x0, DECK_T);
      c.fillStyle = 'rgba(0,0,0,0.34)';
      for (let x = s.x0 + 14; x < s.x1; x += 16) c.fillRect(x, s.y + 1, 1.2, DECK_T - 1);
      // bright neon top rail tube
      c.save();
      c.shadowColor = col; c.shadowBlur = 9;
      c.fillStyle = col; c.fillRect(s.x0, s.y - 1.4, s.x1 - s.x0, 3);
      c.fillStyle = 'rgba(255,255,255,0.75)'; c.fillRect(s.x0, s.y - 1, s.x1 - s.x0, 1);
      c.restore();
      // glowing pier under-deck marquee bulbs
      for (let x = s.x0 + 10; x < s.x1 - 4; x += 20) {
        c.fillStyle = col;
        c.beginPath(); c.arc(x, s.y + DECK_T - 1.5, 1.9, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#FFF4FA';
        c.beginPath(); c.arc(x, s.y + DECK_T - 1.5, 0.8, 0, Math.PI * 2); c.fill();
      }
      if (s.x0 > 0) { c.fillStyle = '#D8ECFF'; c.fillRect(s.x0 - 2, s.y - 2, 3, DECK_T + 4); }
      if (s.x1 < W) { c.fillStyle = '#D8ECFF'; c.fillRect(s.x1 - 1, s.y - 2, 3, DECK_T + 4); }
    }
  }

  // ---- sprites -----------------------------------------------------------
  function drawCup(c, x, y, s) {
    c.save(); c.translate(x, y); c.scale(s, s);
    c.fillStyle = '#FFFFFF'; c.strokeStyle = '#160430'; c.lineWidth = 0.9;
    c.beginPath(); c.moveTo(-4.2, -9.2); c.lineTo(4.2, -9.2); c.lineTo(3.1, 0); c.lineTo(-3.1, 0); c.closePath(); c.fill(); c.stroke();
    c.fillStyle = COL.pink; c.fillRect(-3.6, -6.2, 7.2, 3.2);
    c.fillStyle = COL.teal; c.beginPath(); c.ellipse(0, -9.4, 4.6, 1.8, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = COL.pink; c.lineWidth = 1.6; c.beginPath(); c.moveTo(1, -10); c.lineTo(3.2, -15.5); c.stroke();
    c.restore();
  }

  function drawRunner(c, p, t, alpha) {
    c.save();
    c.translate(p.x, p.y);
    c.globalAlpha = alpha;
    const skin = '#F6B688';
    if (p.state === 'ladder') {
      const sw = Math.sin(p.climb * 11);
      c.strokeStyle = skin; c.lineWidth = 3.2; c.lineCap = 'round';
      c.beginPath(); c.moveTo(-3, -9); c.lineTo(-4, -2 + sw * 3); c.moveTo(3, -9); c.lineTo(4, -2 - sw * 3); c.stroke();
      c.strokeStyle = skin; c.beginPath(); c.moveTo(-5, -19); c.lineTo(-7, -27 + sw * 3); c.moveTo(5, -19); c.lineTo(7, -27 - sw * 3); c.stroke();
      c.fillStyle = COL.pink; rr(c, -6, -21, 12, 12, 3); c.fill();
      c.strokeStyle = '#160430'; c.lineWidth = 1.1; c.stroke();
      c.fillStyle = COL.teal; c.fillRect(-5.5, -16, 11, 2.2);
      c.fillStyle = COL.gold; c.fillRect(-5.5, -10, 11, 4.2);
      c.fillStyle = skin; c.beginPath(); c.arc(0, -26, 5.4, 0, Math.PI * 2); c.fill(); c.stroke();
      c.fillStyle = '#3B1D14'; c.beginPath(); c.arc(0, -27, 5.6, Math.PI, Math.PI * 2); c.fill();
      c.fillStyle = COL.teal; c.fillRect(-6, -31.2, 12, 2.6);
      drawCup(c, 10.5, -14, 0.95);
    } else {
      c.scale(p.face, 1);
      const air = p.state === 'air';
      const moving = Math.abs(p.vx) > 6 && !air;
      const ph = p.run * 0.3;
      c.strokeStyle = skin; c.lineWidth = 3.4; c.lineCap = 'round';
      let a;
      let b;
      if (air) { a = [-4, -3]; b = [5, -6]; } else if (moving) { a = [Math.sin(ph) * 6, 0]; b = [-Math.sin(ph) * 6, 0]; } else { a = [-2.5, 0]; b = [2.5, 0]; }
      c.beginPath(); c.moveTo(-1.5, -9); c.lineTo(a[0], a[1]); c.moveTo(1.5, -9); c.lineTo(b[0], b[1]); c.stroke();
      // 80s neon sneakers
      c.fillStyle = '#FFF4FA'; c.fillRect(a[0] - 2.6, a[1] - 1.8, 5.4, 2.8); c.fillRect(b[0] - 2.6, b[1] - 1.8, 5.4, 2.8);
      c.fillStyle = COL.teal; c.fillRect(a[0] - 2.6, a[1] - 0.5, 5.4, 1.4); c.fillRect(b[0] - 2.6, b[1] - 0.5, 5.4, 1.4);
      // back arm swings
      c.strokeStyle = skin; c.lineWidth = 2.8;
      c.beginPath(); c.moveTo(-3, -18); c.lineTo(-6.5, -12 + (moving ? Math.sin(ph) * 3 : 0)); c.stroke();
      c.fillStyle = COL.pink; rr(c, -5.5, -21, 11, 12, 3); c.fill();
      c.strokeStyle = '#160430'; c.lineWidth = 1.1; c.stroke();
      c.fillStyle = COL.teal; c.fillRect(-5, -16, 10, 2.2);
      c.fillStyle = COL.gold; c.fillRect(-5.8, -10.5, 11.6, 4.5);
      // ponytail, head, neon visor, shades
      c.fillStyle = '#3B1D14'; c.beginPath(); c.arc(-5.6, -25, 2.8, 0, Math.PI * 2); c.fill();
      c.fillStyle = skin; c.beginPath(); c.arc(1, -26, 5.4, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#160430'; c.lineWidth = 1; c.stroke();
      c.fillStyle = '#3B1D14'; c.beginPath(); c.arc(0.4, -27, 5.6, Math.PI * 0.95, Math.PI * 2.05); c.fill();
      c.fillStyle = COL.teal; c.fillRect(-4.2, -31.2, 10.5, 2.6); c.fillRect(2, -31.2, 8.5, 2);
      c.fillStyle = COL.ink; c.fillRect(2.2, -27.8, 5.4, 2.4);
      c.fillStyle = '#FF6AD5'; c.fillRect(2.8, -27.3, 2, 1.1);
      // front arm holds the drink high
      c.strokeStyle = skin; c.lineWidth = 3;
      c.beginPath(); c.moveTo(3, -18); c.lineTo(8, air ? -29 : -25); c.stroke();
      drawCup(c, 9.2, air ? -29 : -25, 1.05);
    }
    c.restore();
  }

  function drawBall(c, h, t) {
    const hop = ballHop(h);
    c.fillStyle = 'rgba(0,0,0,0.34)'; c.beginPath(); c.ellipse(h.x, h.y, 6.5 - hop * 0.2, 2, 0, 0, Math.PI * 2); c.fill();
    c.save(); c.translate(h.x, h.y - 7.5 - hop); c.rotate(h.ph * 5 * h.dir);
    const cols = [COL.pink, '#FFFFFF', COL.teal, '#FFFFFF', COL.gold, '#FFFFFF'];
    for (let i = 0; i < 6; i++) { c.fillStyle = cols[i]; c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, 7.6, i * Math.PI / 3, (i + 1) * Math.PI / 3); c.closePath(); c.fill(); }
    const sg = c.createRadialGradient(-2.4, -2.6, 1, 0, 0, 8);
    sg.addColorStop(0, 'rgba(255,255,255,0.52)'); sg.addColorStop(0.55, 'rgba(255,255,255,0)'); sg.addColorStop(1, 'rgba(20,3,46,0.34)');
    c.fillStyle = sg; c.beginPath(); c.arc(0, 0, 7.6, 0, Math.PI * 2); c.fill();
    c.strokeStyle = COL.ink; c.lineWidth = 1.3; c.stroke();
    c.fillStyle = '#FFD166'; c.beginPath(); c.arc(0, 0, 2, 0, Math.PI * 2); c.fill();
    c.restore();
  }

  function drawCrab(c, h) {
    c.save(); c.translate(h.x, h.y);
    if (ART.crab && ART.crab.complete && ART.crab.naturalWidth > 0) {
      const wob = Math.sin(h.ph * 12) * 0.08;
      c.rotate(wob);
      c.drawImage(ART.crab, -14, -24, 28, 26);
      c.restore();
      return;
    }
    const k = Math.sin(h.ph * 14);
    c.strokeStyle = '#C23B1F'; c.lineWidth = 1.8; c.lineCap = 'round';
    c.beginPath();
    for (let i = -1; i <= 1; i++) { c.moveTo(-5, -3); c.lineTo(-9.5 - i * 1.5, -1 + (k * i) * 1.3); c.moveTo(5, -3); c.lineTo(9.5 + i * 1.5, -1 - (k * i) * 1.3); }
    c.stroke();
    const sh = c.createRadialGradient(-2, -6.5, 1.2, 0, -5, 9);
    sh.addColorStop(0, '#FF946E'); sh.addColorStop(0.55, '#FF4D2E'); sh.addColorStop(1, '#B31D14');
    c.fillStyle = sh; c.beginPath(); c.ellipse(0, -5, 8.6, 5.4, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#6B1010'; c.lineWidth = 1; c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.45)'; c.beginPath(); c.ellipse(-2, -6.8, 3.2, 1.4, 0, 0, Math.PI * 2); c.fill();
    const open = (Math.sin(h.ph * 8) + 1) * 0.5;
    c.fillStyle = '#FF3A1C';
    c.beginPath(); c.arc(-10.5, -9.2 - open * 1.6, 3.2, 0, Math.PI * 2); c.arc(10.5, -9.2 - open * 1.6, 3.2, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#C23B1F'; c.beginPath(); c.moveTo(-6, -7); c.lineTo(-9, -8); c.moveTo(6, -7); c.lineTo(9, -8); c.stroke();
    c.strokeStyle = '#FFFFFF'; c.lineWidth = 1.3; c.beginPath(); c.moveTo(-3, -9); c.lineTo(-3, -12.5); c.moveTo(3, -9); c.lineTo(3, -12.5); c.stroke();
    c.fillStyle = '#FFFFFF'; c.beginPath(); c.arc(-3, -12.8, 1.9, 0, Math.PI * 2); c.arc(3, -12.8, 1.9, 0, Math.PI * 2); c.fill();
    c.fillStyle = COL.ink; c.beginPath(); c.arc(-3, -12.8, 0.9, 0, Math.PI * 2); c.arc(3, -12.8, 0.9, 0, Math.PI * 2); c.fill();
    c.restore();
  }

  function drawCooler(c, h) {
    c.save(); c.translate(h.x, h.y);
    c.fillStyle = 'rgba(0,0,0,0.34)'; c.beginPath(); c.ellipse(0, 0, 12.5, 2.2, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(42,245,228,0.45)'; c.lineWidth = 1.4; c.beginPath();
    for (let i = 0; i < 3; i++) { c.moveTo(-h.dir * 13, -4 - i * 4); c.lineTo(-h.dir * (19 + i * 3), -4 - i * 4); }
    c.stroke();
    const cg = c.createLinearGradient(0, -16, 0, -4);
    cg.addColorStop(0, '#30F5E6'); cg.addColorStop(1, '#0EA5B0');
    c.fillStyle = cg; rr(c, -11.5, -16, 23, 12, 3); c.fill();
    c.strokeStyle = '#160430'; c.lineWidth = 1.1; c.stroke();
    c.fillStyle = '#FFFFFF'; rr(c, -12.5, -18.8, 25, 4.8, 2); c.fill(); c.stroke();
    c.fillStyle = COL.pink; c.fillRect(-11, -11, 22, 2.8);
    c.strokeStyle = '#DCE8F5'; c.lineWidth = 1.8; c.beginPath(); c.arc(0, -18.8, 4.5, Math.PI, Math.PI * 2); c.stroke();
    for (const wx of [-7, 7]) {
      c.save(); c.translate(wx, -2.6); c.rotate(h.ph * 7 * h.dir);
      c.fillStyle = COL.ink; c.beginPath(); c.arc(0, 0, 3.4, 0, Math.PI * 2); c.fill();
      c.fillStyle = COL.gold; c.fillRect(-0.8, -3, 1.6, 6); c.restore();
    }
    c.restore();
  }

  function drawGull(c, h) {
    c.save(); c.translate(h.x, h.y); c.scale(h.dir, 1);
    const f = Math.sin(h.ph * 13);
    c.fillStyle = '#E8E4F4';
    c.beginPath(); c.moveTo(-1, 0); c.lineTo(-6, -2 - f * 9); c.lineTo(-11.5, -1 - f * 12); c.lineTo(-3, 1); c.closePath(); c.fill();
    c.fillStyle = '#FFFFFF'; c.beginPath(); c.ellipse(0, 0, 7.8, 3.6, 0, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(6.5, -1.2, 2.8, 0, Math.PI * 2); c.fill();
    c.fillStyle = COL.gold; c.beginPath(); c.moveTo(8.5, -1.8); c.lineTo(12.8, -0.6); c.lineTo(8.5, 0.3); c.closePath(); c.fill();
    c.fillStyle = COL.ink; c.fillRect(6.5, -2.3, 2.4, 1.3);
    c.fillStyle = '#CFCBE0'; c.beginPath(); c.moveTo(-1, 0); c.lineTo(5, 3 + f * 2); c.lineTo(-5, 3); c.closePath(); c.fill();
    c.restore();
  }

  function drawPickup(c, k, t) {
    const bob = Math.sin(t * 3 + k.x * 0.1) * 2.2;
    c.save(); c.translate(k.x, k.y - 12 + bob);
    const pulse = 0.28 + 0.14 * Math.sin(t * 2.8 + k.x);
    const aura = k.k === 'ice' ? '#2AF5E4' : k.k === 'pine' ? '#FFD166' : '#FF3CAC';
    c.shadowColor = aura; c.shadowBlur = 10;
    c.fillStyle = k.k === 'ice' ? 'rgba(42,245,228,' + pulse + ')' : k.k === 'pine' ? 'rgba(255,225,102,' + pulse + ')' : 'rgba(255,60,172,' + pulse + ')';
    c.strokeStyle = aura; c.lineWidth = 1.4;
    c.beginPath(); c.arc(0, 0, 13.5, 0, Math.PI * 2); c.fill(); c.stroke();
    c.shadowBlur = 0;
    if (k.k === 'ice') {
      c.rotate(0.2);
      const ig = c.createLinearGradient(-7, -7, 7, 7);
      ig.addColorStop(0, '#FFFFFF'); ig.addColorStop(0.5, '#B5FAFF'); ig.addColorStop(1, '#2AF5E4');
      c.fillStyle = ig; rr(c, -7.2, -7.2, 14.4, 14.4, 3); c.fill();
      c.strokeStyle = '#FFFFFF'; c.lineWidth = 1.6; rr(c, -7.2, -7.2, 14.4, 14.4, 3); c.stroke();
      c.strokeStyle = 'rgba(20,120,160,0.68)'; c.beginPath(); c.moveTo(-3.5, 2.5); c.lineTo(2.5, -3.5); c.stroke();
    } else if (k.k === 'cherry') {
      c.strokeStyle = '#2FCB6B'; c.lineWidth = 1.8; c.beginPath(); c.moveTo(-3, 3); c.quadraticCurveTo(-2, -6, 3, -9); c.moveTo(4, 4); c.quadraticCurveTo(3, -5, 3, -9); c.stroke();
      c.fillStyle = '#EE1D47'; c.beginPath(); c.arc(-3.5, 4, 4.8, 0, Math.PI * 2); c.arc(4.5, 5, 4.8, 0, Math.PI * 2); c.fill();
      c.fillStyle = 'rgba(255,255,255,0.85)'; c.fillRect(-5.4, 2, 1.8, 1.8); c.fillRect(2.6, 3, 1.8, 1.8);
    } else {
      c.fillStyle = '#2FCB6B';
      c.beginPath(); c.moveTo(0, -9); c.lineTo(-4.5, -15.5); c.lineTo(0, -12.5); c.lineTo(4.5, -15.5); c.closePath(); c.fill();
      c.fillStyle = '#E8A857'; c.beginPath(); c.moveTo(-6, 1); c.lineTo(6, 1); c.lineTo(0, 12.5); c.closePath(); c.fill();
      c.strokeStyle = '#9C5E22'; c.lineWidth = 0.9; c.beginPath(); c.moveTo(-3, 1); c.lineTo(1.5, 8); c.moveTo(3, 1); c.lineTo(-1.5, 8); c.stroke();
      c.fillStyle = '#FFE45E';
      c.beginPath(); c.ellipse(0, -0.5, 7.2, 3.4, 0, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.ellipse(0, -4, 5.6, 3, 0, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.ellipse(0, -7.2, 3.8, 2.5, 0, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#E6A800'; c.lineWidth = 0.9; c.beginPath(); c.moveTo(-5, -1.4); c.lineTo(5, 0.2); c.stroke();
    }
    c.restore();
  }

  function drawUmbrella(c, u) {
    const sq = u.squash / 0.35;
    const spring = 9 - 5 * sq;
    c.save(); c.translate(u.x, u.y);
    c.strokeStyle = '#E0ECF8'; c.lineWidth = 2; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(0, 0);
    for (let i = 1; i <= 5; i++) c.lineTo(i % 2 ? -4.2 : 4.2, -spring * i / 5);
    c.lineTo(0, -spring); c.stroke();
    c.translate(0, -spring);
    const cols = [COL.pink, '#FFFFFF', COL.teal, '#FFD166'];
    for (let i = 0; i < 4; i++) {
      c.fillStyle = cols[i];
      c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, 14.5, Math.PI + i * Math.PI / 4, Math.PI + (i + 1) * Math.PI / 4); c.closePath(); c.fill();
    }
    c.strokeStyle = COL.ink; c.lineWidth = 1.2; c.beginPath(); c.arc(0, 0, 14.5, Math.PI, Math.PI * 2); c.stroke();
    c.fillStyle = COL.gold; c.beginPath(); c.arc(0, -15, 2.2, 0, Math.PI * 2); c.fill();
    c.restore();
  }

  function drawBoard(c, b, t) {
    const cableY = b.y - 54;
    const l = b.cx - b.amp - b.w / 2 - 12;
    const r = b.cx + b.amp + b.w / 2 + 12;
    c.strokeStyle = 'rgba(255,244,250,0.6)'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(l, cableY); c.lineTo(r, cableY); c.stroke();
    c.fillStyle = COL.gold; c.fillRect(l - 3, cableY - 5, 4, 10); c.fillRect(r - 1, cableY - 5, 4, 10);
    const x = b.cxNow;
    c.strokeStyle = 'rgba(255,244,250,0.8)'; c.lineWidth = 1.3;
    c.beginPath(); c.moveTo(x - b.w / 2 + 4, b.y - 4); c.lineTo(x - 5, cableY); c.moveTo(x + b.w / 2 - 4, b.y - 4); c.lineTo(x + 5, cableY); c.stroke();
    c.fillStyle = COL.teal; rr(c, x - 7, cableY - 3, 14, 6, 2); c.fill();
    // 1986 neon sunset surfboard
    c.save(); c.translate(x, b.y); c.rotate(Math.max(-0.12, Math.min(0.12, -b.dx * 0.6)));
    const g2 = c.createLinearGradient(0, -6, 0, 4);
    g2.addColorStop(0, '#FFF29C'); g2.addColorStop(0.5, '#FFD166'); g2.addColorStop(1, '#FF6B4A');
    c.fillStyle = g2;
    c.beginPath(); c.moveTo(-b.w / 2, 0); c.quadraticCurveTo(-b.w / 2 + 6, -6.5, 0, -6.5); c.quadraticCurveTo(b.w / 2 - 6, -6.5, b.w / 2 + 3, 0); c.quadraticCurveTo(b.w / 2 - 6, 4.5, 0, 4.5); c.quadraticCurveTo(-b.w / 2 + 6, 4.5, -b.w / 2, 0); c.closePath(); c.fill();
    c.strokeStyle = COL.pink; c.lineWidth = 2.2; c.beginPath(); c.moveTo(-b.w / 2 + 6, -1); c.lineTo(b.w / 2 - 4, -1); c.stroke();
    c.strokeStyle = COL.ink; c.lineWidth = 1.2; c.stroke();
    c.restore();
  }

  function drawCustomer(c, res, t, happy) {
    const x = res.customer.x;
    const y = res.ys[res.n - 1];
    c.save(); c.translate(x, y);
    // 80s Miami striped beach lounger
    c.fillStyle = '#DCE8F5'; c.fillRect(-26, -9, 4, 9); c.fillRect(22, -9, 4, 9);
    c.fillStyle = COL.pink; rr(c, -26, -12.5, 52, 6.5, 3); c.fill();
    c.fillStyle = '#FFFFFF'; for (let i = 0; i < 4; i++) c.fillRect(-20 + i * 12, -12.5, 5, 6.5);
    c.strokeStyle = '#160430'; c.lineWidth = 1; rr(c, -26, -12.5, 52, 6.5, 3); c.stroke();
    c.fillStyle = COL.pink; c.beginPath(); c.moveTo(-26, -12); c.lineTo(-17, -24.5); c.lineTo(-11, -22.5); c.lineTo(-17, -12); c.closePath(); c.fill();
    // sunbather
    c.fillStyle = COL.teal; rr(c, -14, -21, 22, 9, 4); c.fill();
    c.strokeStyle = '#160430'; c.lineWidth = 1; c.stroke();
    c.fillStyle = '#F6B688'; c.fillRect(8, -18, 14, 4.2);
    c.beginPath(); c.arc(-15, -27, 5.4, 0, Math.PI * 2); c.fill();
    // glam Miami sunhat with pink ribbon & shades
    c.fillStyle = COL.gold; c.beginPath(); c.ellipse(-15, -30.5, 9.8, 2.6, 0, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(-15, -31.5, 5, Math.PI, Math.PI * 2); c.fill();
    c.fillStyle = COL.pink; c.fillRect(-20, -32.2, 10, 1.8);
    c.fillStyle = COL.ink; c.fillRect(-19, -28.2, 9.2, 2.6);
    c.fillStyle = COL.teal; c.fillRect(-18, -27.7, 2.4, 1.2);
    // waving arm
    const wav = Math.sin(t * (happy ? 12 : 6)) * 0.5;
    c.strokeStyle = '#F6B688'; c.lineWidth = 3.2; c.lineCap = 'round';
    c.beginPath(); c.moveTo(-9, -21); c.lineTo(-9 + Math.sin(wav) * 7, -21 - 12.5); c.stroke();
    // glowing neon-trimmed speech bubble with a cup
    const by = -52 + Math.sin(t * 2.6) * 2.2;
    c.save();
    c.shadowColor = COL.teal; c.shadowBlur = 8;
    c.fillStyle = '#FFFDF8'; rr(c, -17.5, by - 14, 35, 26, 8); c.fill();
    c.strokeStyle = COL.pink; c.lineWidth = 1.6; c.stroke();
    c.shadowBlur = 0;
    c.fillStyle = '#FFFDF8';
    c.beginPath(); c.moveTo(-6, by + 11.5); c.lineTo(-10, by + 19.5); c.lineTo(0, by + 11.5); c.closePath(); c.fill();
    drawCup(c, -2, by + 8, 1.5);
    c.restore();
    c.restore();
  }

  function drawTide(c, g, clock) {
    const y = g.tideY;
    if (y > H + 8) return;
    const frozen = g.freezeT > 0;
    const amp = frozen ? 1.5 : 3.2;
    const edge = (x, off) => y + off + Math.sin(x * 0.045 + clock * 2) * amp + Math.sin(x * 0.11 - clock * 1.4) * 1.7;
    // back translucent neon-pink/ice crest
    c.beginPath(); c.moveTo(0, H + 4);
    for (let x = 0; x <= W; x += 6) c.lineTo(x, edge(x, -6.5));
    c.lineTo(W, H + 4); c.closePath();
    c.fillStyle = frozen ? 'rgba(220,248,255,0.45)' : 'rgba(255,60,172,0.34)'; c.fill();
    // front glowing Miami turquoise surf body
    c.beginPath(); c.moveTo(0, H + 4);
    for (let x = 0; x <= W; x += 6) c.lineTo(x, edge(x, 0));
    c.lineTo(W, H + 4); c.closePath();
    const gr = c.createLinearGradient(0, y - 6, 0, y + 150);
    if (frozen) { gr.addColorStop(0, 'rgba(225,250,255,0.88)'); gr.addColorStop(1, 'rgba(115,195,240,0.92)'); }
    else { gr.addColorStop(0, 'rgba(42,245,228,0.78)'); gr.addColorStop(0.45, 'rgba(20,138,205,0.84)'); gr.addColorStop(1, 'rgba(10,18,88,0.94)'); }
    c.fillStyle = gr; c.fill();
    // crisp foaming surf crest
    c.strokeStyle = 'rgba(255,255,255,0.92)'; c.lineWidth = 2.6; c.beginPath();
    for (let x = 0; x <= W; x += 6) { const yy = edge(x, 0); if (x === 0) c.moveTo(x, yy); else c.lineTo(x, yy); }
    c.stroke();
    // glowing tide tag pill
    const label = g.tideDelay > 0 ? 'TIDE IN ' + Math.ceil(g.tideDelay) : (frozen ? 'FROZEN' : 'TIDE');
    c.font = '9px ' + FONT;
    const tw = c.measureText(label).width + 14;
    const ty = Math.min(y - 16, H - 18);
    c.fillStyle = 'rgba(10,2,28,0.88)'; rr(c, W - tw - 6, ty, tw, 15, 7.5); c.fill();
    c.strokeStyle = frozen ? '#BFF3FF' : COL.teal; c.lineWidth = 1.2; c.stroke();
    c.fillStyle = frozen ? '#BFF3FF' : COL.teal; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(label, W - tw / 2 - 6, ty + 7.8);
  }

  // ---- the game page ------------------------------------------------------
  function initUI() {
    const $ = (id) => document.getElementById(id);
    const canvas = $('tower');
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const html = document.documentElement;
    const els = {
      ov: $('ov'), title: $('ovTitle'), text: $('ovText'), stats: $('ovStats'), help: $('ovHelp'), btn: $('ovBtn'),
      score: $('hudScore'), best: $('hudBest'), level: $('hudLevel'), lives: $('hudLives'), tip: $('hudTip'),
      pause: $('pauseBtn'), sound: $('soundBtn'), dpad: $('dpad'), jump: $('jumpBtn'), cab: $('cab'), board: $('board')
    };
    const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    let reduced = !!(mq && mq.matches);
    if (mq && mq.addEventListener) mq.addEventListener('change', (e) => { reduced = e.matches; });

    // ---- best score (local only) ----
    const BEST_KEY = 'tbTowerBest';
    let best = 0;
    try { best = Math.max(0, parseInt(localStorage.getItem(BEST_KEY), 10) || 0); } catch (e) { best = 0; /* storage blocked: best stays in memory */ }
    function saveBest() { try { localStorage.setItem(BEST_KEY, String(best)); } catch (e) { /* storage blocked: ignore */ } }

    // ---- sound: tiny synth blips, silent until the first gesture ----
    const audio = (function () {
      let ac = null;
      let master = null;
      let on = true;
      function unlock() {
        if (!ac) {
          try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            ac = new AC(); master = ac.createGain(); master.gain.value = 0.55; master.connect(ac.destination);
          } catch (e) { ac = null; return; }
        }
        if (ac.state === 'suspended') ac.resume().catch(() => { /* needs another gesture */ });
      }
      function tone(f0, f1, dur, type, vol, delay) {
        if (!ac || !on) return;
        try {
          const t = ac.currentTime + (delay || 0);
          const o = ac.createOscillator();
          const gn = ac.createGain();
          o.type = type || 'square';
          o.frequency.setValueAtTime(f0, t);
          if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
          gn.gain.setValueAtTime(0.0001, t);
          gn.gain.exponentialRampToValueAtTime(vol || 0.07, t + 0.012);
          gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          o.connect(gn); gn.connect(master);
          o.start(t); o.stop(t + dur + 0.03);
        } catch (e) { /* audio is optional */ }
      }
      const SFX = {
        jump: () => tone(330, 640, 0.13, 'square', 0.05),
        land: () => tone(160, 90, 0.06, 'triangle', 0.05),
        clean: () => { tone(880, 1320, 0.1, 'sine', 0.07); tone(1320, 1760, 0.1, 'sine', 0.05, 0.07); },
        row: () => tone(660, 880, 0.07, 'triangle', 0.05),
        cherry: () => { [784, 988, 1318].forEach((f, i) => tone(f, f, 0.08, 'square', 0.05, i * 0.06)); },
        ice: () => { tone(1760, 2640, 0.22, 'sine', 0.06); tone(1320, 1980, 0.22, 'sine', 0.05, 0.08); },
        pine: () => { [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, f * 1.01, 0.09, 'square', 0.05, i * 0.05)); },
        bounce: () => tone(180, 760, 0.28, 'sine', 0.09),
        hit: () => { tone(330, 70, 0.4, 'sawtooth', 0.08); },
        drown: () => { tone(420, 80, 0.55, 'sine', 0.1); tone(300, 60, 0.55, 'triangle', 0.06, 0.1); },
        smash: () => tone(500, 1000, 0.1, 'square', 0.06),
        warn: () => { tone(1250, 1250, 0.08, 'square', 0.04); tone(1250, 1250, 0.08, 'square', 0.04, 0.14); },
        tide: () => tone(110, 90, 0.5, 'triangle', 0.08),
        deliver: () => { [523, 659, 784, 1046, 1318, 1568].forEach((f, i) => tone(f, f, 0.14, 'triangle', 0.07, i * 0.09)); },
        gameover: () => { [523, 440, 349, 262].forEach((f, i) => tone(f, f * 0.98, 0.22, 'square', 0.06, i * 0.18)); },
        grab: () => tone(420, 500, 0.04, 'triangle', 0.03)
      };
      return { unlock, play: (n) => { if (SFX[n]) SFX[n](); }, setOn: (v) => { on = v; }, isOn: () => on };
    })();

    // ---- game + UI state ----
    let g = api.createGame({ level: 1 });
    let mode = 'title'; // title | play | paused | between | over
    let overlayKind = 'title';
    let raf = 0;
    let last = 0;
    let acc = 0;
    let clock = 0;
    let deliverClock = 0;
    let staticLayer = null;
    let staticKey = '';
    let particles = [];
    let popups = [];
    let shakeT = 0;
    let flashT = 0;
    let celebrate = 0;
    const cached = { score: -1, best: -1, level: -1, lives: -1, tip: -1 };

    api.current = () => g;
    api.uiMode = () => mode;

    // ---- input ----
    const keys = { left: false, right: false, up: false, down: false };
    const padHeld = { left: 0, right: 0, up: 0, down: 0 };
    const swipe = { id: null, ax: 0, sy: 0, dir: 0 };
    let jumpQ = false;
    let latchQ = 0;

    function readInput() {
      const l = (keys.left ? 1 : 0) + padHeld.left + (swipe.dir < 0 ? 1 : 0);
      const r = (keys.right ? 1 : 0) + padHeld.right + (swipe.dir > 0 ? 1 : 0);
      const u = keys.up || padHeld.up > 0;
      const d = keys.down || padHeld.down > 0;
      const inp = { x: (r > 0 ? 1 : 0) - (l > 0 ? 1 : 0), y: (d ? 1 : 0) - (u ? 1 : 0), jump: jumpQ, latch: latchQ };
      jumpQ = false; latchQ = 0;
      return inp;
    }
    function clearInput() {
      keys.left = keys.right = keys.up = keys.down = false;
      for (const n of Object.keys(padHeld)) padHeld[n] = 0;
      swipe.id = null; swipe.dir = 0; jumpQ = false; latchQ = 0;
      pointerPad.clear();
      for (const b of els.dpad.querySelectorAll('.ctl')) b.classList.remove('is-down');
      els.jump.classList.remove('is-down');
    }

    // d-pad: one finger = one button, and sliding the finger from button to button re-targets it
    const pointerPad = new Map();
    const padButtons = {};
    for (const b of els.dpad.querySelectorAll('.ctl')) padButtons[b.dataset.ctl] = b;
    function padHit(x, y) {
      let bestName = null;
      let bd = 1e9;
      for (const n of Object.keys(padButtons)) {
        const r = padButtons[n].getBoundingClientRect();
        const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
        const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
        const d = Math.hypot(dx, dy);
        if (d < bd) { bd = d; bestName = n; }
      }
      return bd <= 14 ? bestName : null;
    }
    function setPad(id, name) {
      const old = pointerPad.get(id) || null;
      if (old === name) return;
      if (old) { padHeld[old] = Math.max(0, padHeld[old] - 1); if (!padHeld[old]) padButtons[old].classList.remove('is-down'); }
      if (name) { padHeld[name] += 1; padButtons[name].classList.add('is-down'); pointerPad.set(id, name); } else pointerPad.delete(id);
    }
    els.dpad.addEventListener('pointerdown', (e) => {
      e.preventDefault(); audio.unlock();
      if (window.TBK && window.TBK.isStray(e)) return;                  // a palm or sleeve on the panel
      try { els.dpad.setPointerCapture(e.pointerId); } catch (err) { /* capture is a nicety */ }
      setPad(e.pointerId, padHit(e.clientX, e.clientY));
    });
    els.dpad.addEventListener('pointermove', (e) => { if (pointerPad.has(e.pointerId)) setPad(e.pointerId, padHit(e.clientX, e.clientY)); });
    const padEnd = (e) => setPad(e.pointerId, null);
    els.dpad.addEventListener('pointerup', padEnd);
    els.dpad.addEventListener('pointercancel', padEnd);
    els.dpad.addEventListener('lostpointercapture', padEnd);

    const jumpPointers = new Set();
    els.jump.addEventListener('pointerdown', (e) => {
      e.preventDefault(); audio.unlock();
      if (window.TBK && window.TBK.isStray(e)) return;
      try { els.jump.setPointerCapture(e.pointerId); } catch (err) { /* capture is a nicety */ }
      jumpPointers.add(e.pointerId); els.jump.classList.add('is-down');
      if (mode === 'play') jumpQ = true;
    });
    const jumpEnd = (e) => { jumpPointers.delete(e.pointerId); if (!jumpPointers.size) els.jump.classList.remove('is-down'); };
    els.jump.addEventListener('pointerup', jumpEnd);
    els.jump.addEventListener('pointercancel', jumpEnd);
    els.jump.addEventListener('lostpointercapture', jumpEnd);

    // swipe on the board: drag = run, flick up = jump or grab a ladder, flick down = climb down
    canvas.addEventListener('pointerdown', (e) => {
      audio.unlock();
      if (mode !== 'play' || swipe.id !== null) return;
      if (window.TBK && window.TBK.isStray(e)) return;
      e.preventDefault();
      swipe.id = e.pointerId; swipe.ax = e.clientX; swipe.sy = e.clientY; swipe.dir = 0;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* capture is a nicety */ }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== swipe.id || mode !== 'play') return;
      const k = Math.min(1.8, canvas.getBoundingClientRect().width / W); // big kiosk boards do not need huge swipes
      const trail = 36 * k;
      let dx = e.clientX - swipe.ax;
      if (dx > trail) { swipe.ax = e.clientX - trail; dx = trail; } else if (dx < -trail) { swipe.ax = e.clientX + trail; dx = -trail; }
      swipe.dir = dx > 12 * k ? 1 : dx < -12 * k ? -1 : 0;
      const dy = e.clientY - swipe.sy;
      if (dy < -26 * k) { jumpQ = true; latchQ = -1; swipe.sy = e.clientY; } else if (dy > 26 * k) { latchQ = 1; swipe.sy = e.clientY; }
    });
    const swipeEnd = (e) => { if (e.pointerId === swipe.id) { swipe.id = null; swipe.dir = 0; } };
    canvas.addEventListener('pointerup', swipeEnd);
    canvas.addEventListener('pointercancel', swipeEnd);
    canvas.addEventListener('lostpointercapture', swipeEnd);

    const KEYMAP = { arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right', arrowup: 'up', w: 'up', arrowdown: 'down', s: 'down' };
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = (e.key || '').toLowerCase();
      audio.unlock();
      if (mode === 'play') {
        if (KEYMAP[k]) { keys[KEYMAP[k]] = true; e.preventDefault(); return; }
        if (k === ' ' || k === 'spacebar') { e.preventDefault(); if (!e.repeat) jumpQ = true; return; }
        if (k === 'p' || k === 'escape') { e.preventDefault(); pause(); }
        return;
      }
      if (mode === 'paused' && (k === 'p' || k === 'escape')) { e.preventDefault(); resume(); return; }
      if ((k === 'enter' || k === ' ') && !(document.activeElement && document.activeElement.tagName === 'BUTTON') && !els.ov.hidden) { e.preventDefault(); els.btn.click(); }
    });
    document.addEventListener('keyup', (e) => { const k = (e.key || '').toLowerCase(); if (KEYMAP[k]) keys[KEYMAP[k]] = false; });
    window.addEventListener('blur', clearInput);
    document.addEventListener('contextmenu', (e) => { if (e.target.closest && e.target.closest('.cab')) e.preventDefault(); });
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('touchmove', (e) => { if (mode === 'play') e.preventDefault(); }, { passive: false });
    document.addEventListener('visibilitychange', () => { if (document.hidden && mode === 'play') pause(); });

    // ---- HUD ----
    const lifeEls = [];
    for (let i = 0; i < TUNE.LIVES; i++) { const s = document.createElement('span'); s.className = 'life'; els.lives.appendChild(s); lifeEls.push(s); }
    const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    function updateHud() {
      if (g.score > best) best = g.score;
      if (cached.score !== g.score) { cached.score = g.score; els.score.textContent = fmt(g.score); }
      if (cached.best !== best) { cached.best = best; els.best.textContent = fmt(best); }
      if (cached.level !== g.level) { cached.level = g.level; els.level.textContent = String(g.level); }
      if (cached.lives !== g.lives) {
        cached.lives = g.lives;
        lifeEls.forEach((s, i) => s.classList.toggle('life--off', i >= g.lives));
        els.lives.setAttribute('aria-label', g.lives + (g.lives === 1 ? ' life' : ' lives'));
      }
      const tip = tipFor(g.tipT);
      if (cached.tip !== tip) { cached.tip = tip; els.tip.textContent = fmt(tip); }
    }

    // ---- effects ----
    function burst(x, y, cols, n, speed, life) {
      if (reduced) return;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = speed * (0.4 + Math.random() * 0.8);
        particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 20, life: life, max: life, col: cols[i % cols.length], size: 1.6 + Math.random() * 1.8 });
      }
      if (particles.length > 160) particles.splice(0, particles.length - 160);
    }
    function popup(x, y, text, col) { popups.push({ x, y, text, col: col || COL.gold, t: 0 }); if (popups.length > 12) popups.shift(); }
    function updateFx(dt) {
      for (const p of particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 260 * dt; p.life -= dt; }
      particles = particles.filter((p) => p.life > 0);
      for (const p of popups) { p.t += dt; p.y -= 22 * dt; }
      popups = popups.filter((p) => p.t < 1.1);
      if (shakeT > 0) shakeT = Math.max(0, shakeT - dt);
      if (flashT > 0) flashT = Math.max(0, flashT - dt);
      if (celebrate > 0) celebrate = Math.max(0, celebrate - dt);
    }
    function handleEvents() {
      for (const e of g.events.splice(0)) {
        switch (e.k) {
          case 'jump': audio.play('jump'); break;
          case 'land': audio.play('land'); break;
          case 'grab': audio.play('grab'); break;
          case 'clean': audio.play('clean'); popup(e.x, e.y, e.text, COL.teal); burst(e.x, e.y + 10, [COL.teal, COL.gold], 6, 50, 0.5); break;
          case 'row': audio.play('row'); popup(e.x, e.y, e.text, COL.foam); break;
          case 'cherry': audio.play('cherry'); popup(e.x, e.y, e.text, COL.pink); burst(e.x, e.y + 10, [COL.pink, '#E0123F'], 10, 70, 0.6); break;
          case 'ice': audio.play('ice'); popup(e.x, e.y, e.text, '#BFF3FF'); burst(e.x, e.y + 10, ['#BFF3FF', '#FFFFFF'], 14, 80, 0.7); break;
          case 'pine': audio.play('pine'); popup(e.x, e.y, e.text, COL.gold); burst(e.x, e.y + 10, [COL.gold, COL.pink, COL.teal], 16, 90, 0.8); break;
          case 'bounce': audio.play('bounce'); burst(e.x, e.y - 8, [COL.pink, '#FFFFFF'], 8, 60, 0.4); break;
          case 'smash': audio.play('smash'); popup(e.x, e.y, e.text, COL.gold); burst(e.x, e.y, [COL.gold, COL.orange], 10, 80, 0.5); break;
          case 'warn': audio.play('warn'); break;
          case 'tide': audio.play('tide'); popup(e.x, e.y - 20, e.text, COL.teal); break;
          case 'hit': audio.play('hit'); shakeT = reduced ? 0 : 0.35; flashT = reduced ? 0 : 0.3; burst(e.x, e.y, [COL.pink, COL.gold], 14, 90, 0.6); break;
          case 'drown': audio.play('drown'); burst(e.x, e.y, ['#BFF3FF', COL.teal], 14, 70, 0.7); break;
          case 'deliver': audio.play('deliver'); popup(e.x, e.y, e.text, COL.gold); celebrate = 2; burst(e.x, e.y + 20, [COL.pink, COL.teal, COL.gold], 34, 120, 1.1); break;
          case 'gameover': audio.play('gameover'); break;
          default: break;
        }
      }
    }

    // ---- drawing ----
    function layout() {
      const r = canvas.getBoundingClientRect();
      if (r.width < 2) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const w = Math.max(2, Math.round(r.width * dpr));
      const h = Math.round(w * H / W);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; staticLayer = null; }
      render();
    }
    if (ART.bg && !ART.bg._bound) {
      ART.bg._bound = true;
      ART.bg.addEventListener('load', () => { staticLayer = null; render(); });
    }
    function ensureStatic() {
      const bgOk = ART.bg && ART.bg.complete && ART.bg.naturalWidth > 0 ? 1 : 0;
      const key = g.level + ':' + canvas.width + ':' + bgOk;
      if (staticLayer && staticKey === key) return;
      staticLayer = document.createElement('canvas');
      staticLayer.width = canvas.width; staticLayer.height = canvas.height;
      const sc = staticLayer.getContext('2d');
      const s = canvas.width / W;
      sc.setTransform(s, 0, 0, s, 0, 0);
      drawScene(sc, g.res);
      staticKey = key;
    }
    function render() {
      const s = canvas.width / W;
      ensureStatic();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const sx = shakeT > 0 ? (Math.random() - 0.5) * 6 * (shakeT / 0.35) : 0;
      const sy = shakeT > 0 ? (Math.random() - 0.5) * 6 * (shakeT / 0.35) : 0;
      ctx.drawImage(staticLayer, sx * s, sy * s);
      ctx.setTransform(s, 0, 0, s, sx * s, sy * s);
      drawDynamic(ctx);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    function drawDynamic(c) {
      const res = g.res;
      const t = clock;
      for (const b of res.boards) drawBoard(c, b, t);
      for (const u of g.umb) drawUmbrella(c, u);
      drawCustomer(c, res, t, celebrate > 0 || g.status === 'delivered');
      for (const k of g.pickups) if (!k.taken) drawPickup(c, k, t);
      // gull warning signs
      for (const sp of g.spawners) {
        if (!sp.warn) continue;
        const x = sp.side === 'L' ? 14 : W - 14;
        const y = res.ys[sp.r] - 30;
        c.fillStyle = COL.pink; c.beginPath(); c.moveTo(x, y - 11); c.lineTo(x + 11, y + 8); c.lineTo(x - 11, y + 8); c.closePath(); c.fill();
        c.fillStyle = '#FFFFFF'; c.font = '12px ' + FONT; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('!', x, y + 3);
      }
      const frozen = g.freezeT > 0;
      for (const h of g.hazards) {
        if (h.t === 'ball') drawBall(c, h, t); else if (h.t === 'crab') drawCrab(c, h); else if (h.t === 'cooler') drawCooler(c, h); else drawGull(c, h);
        if (frozen) {
          const b = hazardBox(h);
          c.fillStyle = 'rgba(190,240,255,0.55)'; c.fillRect(b.x0 - 2, b.y0 - 2, b.x1 - b.x0 + 4, b.y1 - b.y0 + 4);
          c.strokeStyle = '#FFFFFF'; c.lineWidth = 1.2; c.strokeRect(b.x0 - 2, b.y0 - 2, b.x1 - b.x0 + 4, b.y1 - b.y0 + 4);
        }
      }
      // rainbow trail while the pineapple soft serve is active
      if (g.trail.length > 1) {
        for (let i = 0; i < g.trail.length; i++) {
          const q = g.trail[i];
          c.fillStyle = 'hsla(' + ((i * 26 + t * 160) % 360).toFixed(0) + ',100%,62%,' + (0.15 + 0.6 * i / g.trail.length).toFixed(2) + ')';
          c.beginPath(); c.arc(q.x, q.y - 12, 2 + 5 * i / g.trail.length, 0, Math.PI * 2); c.fill();
        }
      }
      // runner
      const p = g.p;
      let alpha = 1;
      if (g.status === 'play' && g.prot > 0) alpha = reduced ? 0.7 : (Math.floor(t * 10) % 2 ? 0.45 : 1);
      c.save();
      if (g.status === 'dying') { c.translate(p.x, p.y - 12); c.rotate((TUNE.DYING - g.dyingT) * 7); c.translate(-p.x, -(p.y - 12)); alpha = Math.max(0.2, g.dyingT / TUNE.DYING); }
      if (g.invT > 0) { c.shadowColor = 'hsl(' + ((t * 300) % 360).toFixed(0) + ',100%,60%)'; c.shadowBlur = 12; }
      drawRunner(c, p, t, alpha);
      c.restore();
      for (const q of particles) { c.globalAlpha = Math.max(0, q.life / q.max); c.fillStyle = q.col; c.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size); }
      c.globalAlpha = 1;
      drawTide(c, g, t);
      // frost tint while the tide is frozen
      if (frozen) { c.fillStyle = 'rgba(190,240,255,0.1)'; c.fillRect(0, 0, W, H); }
      // pop-up scores
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = '12px ' + FONT;
      for (const q of popups) {
        c.globalAlpha = Math.max(0, 1 - q.t / 1.1);
        c.lineWidth = 3; c.strokeStyle = 'rgba(7,1,20,0.85)'; c.strokeText(q.text, q.x, q.y);
        c.fillStyle = q.col; c.fillText(q.text, q.x, q.y);
      }
      c.globalAlpha = 1;
      // melt bar: the sooner you deliver, the bigger the tip
      const frac = Math.max(0, Math.min(1, (tipFor(g.tipT) - TUNE.TIP_MIN) / (TUNE.TIP_MAX - TUNE.TIP_MIN)));
      c.fillStyle = 'rgba(7,1,20,0.75)'; rr(c, 10, 8, W - 20, 12, 6); c.fill();
      const mg = c.createLinearGradient(10, 0, W - 10, 0); mg.addColorStop(0, COL.gold); mg.addColorStop(1, COL.pink);
      c.fillStyle = mg; if (frac > 0.02) { rr(c, 12, 10, (W - 24) * frac, 8, 4); c.fill(); }
      c.fillStyle = '#FFFFFF'; c.font = '8px ' + FONT; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText('TIP', 16, 14.5);
      // tower banner at the start of every run
      if (g.status === 'play' && g.time < 2.6) {
        c.globalAlpha = Math.min(1, (2.6 - g.time) * 1.5);
        c.textAlign = 'center'; c.font = '17px ' + FONT; c.lineWidth = 4; c.strokeStyle = 'rgba(7,1,20,0.9)';
        const line1 = 'TOWER ' + g.level;
        c.strokeText(line1, W / 2, 38); c.fillStyle = COL.gold; c.fillText(line1, W / 2, 38);
        c.font = '10px ' + FONT; c.strokeText(res.name.toUpperCase(), W / 2, 55); c.fillStyle = COL.teal; c.fillText(res.name.toUpperCase(), W / 2, 55);
        c.globalAlpha = 1;
      }
      if (flashT > 0 && !reduced) { c.fillStyle = 'rgba(255,60,172,' + (flashT * 0.8).toFixed(2) + ')'; c.fillRect(0, 0, W, H); }
    }

    // ---- flow ----
    function showOverlay(kind) {
      overlayKind = kind;
      els.ov.hidden = false;
      els.ov.classList.toggle('ov--soft', kind === 'between');
      els.help.hidden = kind !== 'title';
      els.stats.hidden = kind === 'title' || kind === 'paused';
      if (kind === 'title') {
        els.title.textContent = 'Thirsty Tower';
        els.text.textContent = 'Carry the drink up to the sunbather on the top deck before the tide catches you.';
        els.btn.textContent = 'Play';
      } else if (kind === 'paused') {
        els.title.textContent = 'Paused';
        els.text.textContent = 'Take a sip. Your run is waiting.';
        els.btn.textContent = 'Resume';
      } else if (kind === 'between') {
        els.title.textContent = 'Delivered!';
        els.text.textContent = 'The sunbather loves it. Next tower is a little faster.';
        els.stats.textContent = 'Tip +' + fmt(g.lastTip) + '  |  Score ' + fmt(g.score);
        els.btn.textContent = 'Next tower';
      } else {
        els.title.textContent = 'Game over';
        els.text.textContent = g.score >= best && g.score > 0 ? 'New best score!' : 'The tide wins this round.';
        els.stats.textContent = 'Score ' + fmt(g.score) + '  |  Best ' + fmt(best) + '  |  Tower ' + g.level;
        els.btn.textContent = 'Play again';
      }
      try { els.btn.focus({ preventScroll: true }); } catch (e) { els.btn.focus(); }
    }
    function hideOverlay() { els.ov.hidden = true; if (document.activeElement === els.btn) els.btn.blur(); }
    function setMode(m) {
      mode = m;
      html.classList.toggle('is-playing', m === 'play');
      els.pause.textContent = m === 'paused' ? 'Resume' : 'Pause';
    }
    function startLoop() {
      if (raf) return;
      last = performance.now(); acc = 0;
      raf = requestAnimationFrame(frame);
    }
    function stopLoop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
    function startNew() {
      setDifficulty(window.TBK && typeof window.TBK.difficulty === 'function' ? window.TBK.difficulty() : 'classic');   // the table is fixed for this whole run
      g = api.createGame({ level: 1 });
      resetFx(); clearInput();
      hideOverlay(); setMode('play');
      window.scrollTo(0, 0);
      if (window.TBK) window.TBK.runStart('thirsty-tower');
      updateHud(); startLoop();
    }
    function nextTower() {
      api.nextLevel(g);
      resetFx(); hideOverlay(); setMode('play'); updateHud(); startLoop();
    }
    function resetFx() { particles = []; popups = []; shakeT = 0; flashT = 0; celebrate = 0; deliverClock = 0; staticLayer = null; }
    function pause() {
      if (mode !== 'play') return;
      if (window.TBMusic) window.TBMusic.setPaused(true);
      stopLoop(); clearInput(); setMode('paused'); saveBest(); showOverlay('paused'); render();
    }
    function resume() {
      if (mode !== 'paused') return;
      if (window.TBMusic) window.TBMusic.setPaused(false);
      hideOverlay(); setMode('play'); startLoop();
    }
    function finishRun(kind) {
      stopLoop(); clearInput(); saveBest(); setMode(kind);
      updateHud(); render(); showOverlay(kind);
      if (kind === 'over' && window.TBK) window.TBK.runEnd();
    }
    function stepOnce() {
      api.step(g, readInput());
      handleEvents();
    }
    function frame(ts) {
      raf = 0;
      if (mode !== 'play') return;
      const dt = Math.min(0.1, (ts - last) / 1000);
      last = ts; acc += dt;
      let n = 0;
      while (acc >= DT && n < 6) { stepOnce(); acc -= DT; n++; }
      if (n === 6) acc = 0;
      if (g.freezeT <= 0) clock += dt;
      updateFx(dt);
      updateHud();
      render();
      if (g.status === 'delivered') { deliverClock += dt; if (deliverClock >= 1.7) { finishRun('between'); return; } }
      if (g.status === 'gameover') { finishRun('over'); return; }
      raf = requestAnimationFrame(frame);
    }

    els.btn.addEventListener('click', () => {
      audio.unlock();
      if (overlayKind === 'paused') resume();
      else if (overlayKind === 'between') nextTower();
      else startNew();
    });
    els.pause.addEventListener('click', () => { audio.unlock(); if (mode === 'play') pause(); else if (mode === 'paused') resume(); });
    if (window.TBMusic && window.TBMusic.isMuted()) { audio.setOn(false); els.sound.textContent = 'Sound Off'; els.sound.setAttribute('aria-pressed', 'false'); }      // a mute chosen on another game page in this visit carries here
    els.sound.addEventListener('click', () => {
      audio.unlock();
      const on = !audio.isOn();
      audio.setOn(on);
      if (window.TBMusic) window.TBMusic.setMuted(!on);      // the beach music follows this setting (shared/beach-music.js)
      els.sound.textContent = on ? 'Sound On' : 'Sound Off';
      els.sound.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) audio.play('row');
    });

    onArtLoaded = (k) => { if (k === 'bg') staticLayer = null; render(); };
    if (window.ResizeObserver) new ResizeObserver(layout).observe(els.board); else window.addEventListener('resize', layout);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => render());
    updateHud();
    showOverlay('title');
    layout();
    if (window.TBK) { window.TBK.onEnd(pause); window.TBK.onAgain(startNew); }
    // read-only view for the page tests (only with ?debug in the address)
    if (/[?&]debug(?:=|&|$)/.test(window.location.search)) window.__tbdbg = { get mode() { return mode; }, get g() { return g; }, get difficulty() { return api.difficultyMode(); } };
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI); else initUI();
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TBTower = api;
})(typeof window !== 'undefined' ? window : globalThis);
