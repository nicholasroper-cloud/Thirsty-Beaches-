/* Thirsty Beaches: BOARDWALK DASH
 *
 * Purpose: a play-for-fun hop-across-the-lanes arcade game. You are a Thirsty Beaches runner carrying a drink from the
 * trailer (bottom) to a customer on a beach towel (top). Between you and the towel: boardwalk lanes of bikes, skaters,
 * a rolling cooler, a slow ice cream cart and a jogging dog on a leash; then sand lanes with sandcastle walls and
 * scuttling crabs; then a shoreline where waves wash in and out and sweep you back a few tiles.
 *
 * Layout of this file:
 *   1. Pure game core (no DOM, no network, no storage). Exported for tests via module.exports: lane generation from
 *      parameters, hazard and wave math, scoring, the difficulty curve, a time-expanded solver that proves every
 *      generated level is crossable, and a fixed-step engine (createGame / hop / update).
 *   2. Browser shell (canvas renderer, input, Web Audio blips, HUD, overlays), started only when the page has #bdCanvas.
 *
 * Security / privacy: no network calls, no cookies, no personal data. The only storage is one numeric best score and
 * the sound setting in localStorage, each wrapped in try/catch. All text goes through textContent; no HTML is built.
 * Kiosk copy: a finished run asks the kiosk server for ONE prize roll (kgame.js); nothing about the score is ever sent.
 */
(function (root) {
  'use strict';

  /* ============================== 1. PURE GAME CORE ============================== */

  const COLS = 9;
  const ROWS = 12;                 // walkable rows, 0 = trailer row (bottom), ROWS - 1 = towel row (top)
  const START_COL = 4;
  const PAD = 2.6;                 // off-screen run-up on each side of a lane (must be >= the widest entity)
  const LOOP = COLS + 2 * PAD;     // length of one traffic loop, in tiles
  const HOP_COOLDOWN = 0.11;       // seconds between hops; one more hop may be buffered during it
  const PLAYER_HALF = 0.3;         // half width of the runner's hit box, in tiles
  const ENT_MARGIN = 0.1;          // each traffic entity's hit box is this much narrower than its drawing, per side
  const CRAB_HALF = 0.3;
  const MAX_LIVES = 3;
  const DELIVERIES_PER_LEVEL = 3;
  const FREEZE_SECONDS = 3;
  const SHIELD_INVULN = 1.6;
  const DROP_TIME = 0.95;          // how long the dropped-drink moment lasts
  const DELIVER_TIME = 1.7;        // how long the delivery moment lasts
  const SWEEP_TILES = 3;           // waves push you back at most this many rows
  const CRAB_MOVE_FRAC = 0.3;      // a crab spends this share of each step scuttling and the rest waiting

  const BASE_DELIVERY = 100;
  const LEVEL_BONUS = 25;
  const TIP_MAX = 100;
  const CHERRY_POINTS = 50;
  const STRAW_POINTS = 75;
  const ROW_POINTS = 10;

  /* Entity types for boardwalk lanes: width in tiles and a speed multiplier. */
  const TYPES = {
    skater: { w: 0.9, f: 1.0 },
    cooler: { w: 1.1, f: 0.8 },
    cart: { w: 1.8, f: 0.55 },
    bike: { w: 1.3, f: 1.25 },
    dog: { w: 2.2, f: 0.95 },
  };
  const TYPE_ORDER = ['skater', 'cooler', 'cart', 'bike', 'dog'];

  const DIRS = {
    up: { dx: 0, dy: 1 },
    down: { dx: 0, dy: -1 },
    left: { dx: -1, dy: 0 },
    right: { dx: 1, dy: 0 },
  };

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const mod = (a, n) => ((a % n) + n) % n;

  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashSeed() {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < arguments.length; i++) {
      h ^= (arguments[i] | 0) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
      h ^= h >>> 13;
      h = Math.imul(h, 2654435761) >>> 0;
    }
    return h >>> 0;
  }

  const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

  function shuffle(rng, arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---- difficulty curve ---- */

  const levelForDeliveries = (n) => 1 + Math.floor(Math.max(0, n) / DELIVERIES_PER_LEVEL);

  /* Edge-to-edge gap a boardwalk lane must keep between entities at a given speed. It is sized so that the gap is open
     at a column for at least ~0.6 s of a player's time: enough to hop in, and hop out, with human reaction jitter. */
  const gapRequired = (speed) => 0.9 + 0.6 * speed;

  function levelParams(level) {
    const L = Math.max(1, Math.floor(level) || 1);
    return {
      level: L,
      speedBase: Math.min(3.4, 1.15 + 0.3 * (L - 1)),
      gapScale: Math.max(1.0, 1.9 - 0.15 * (L - 1)),
      maxPerLane: L <= 2 ? 3 : L <= 5 ? 4 : 5,
      umbrellaChance: 0.34,
      crabLanes: L === 1 ? 1 : L <= 3 ? 2 : 3,
      crabStep: Math.max(0.8, 1.6 - 0.08 * (L - 1)),
      walls: Math.min(4, 2 + Math.floor((L - 1) / 2)),
      wavePeriod: Math.max(4.4, 6.8 - 0.3 * (L - 1)),
      dryFrac: Math.max(0.45, 0.62 - 0.02 * (L - 1)),
      melt: Math.max(38, 70 - 4 * (L - 1)),
      towelW: L <= 3 ? 3 : 2,
      speedCap: 3.8,
    };
  }

  const LANE_TABLE = [[3, 2, 1], [3, 3, 1], [4, 3, 1], [3, 3, 2], [4, 3, 1]];
  const LANE_POOL = [[4, 3, 1], [3, 3, 2], [4, 2, 2], [3, 4, 1], [5, 2, 1], [3, 2, 3]];

  function laneCounts(level, rng) {
    if (level <= LANE_TABLE.length) return LANE_TABLE[level - 1].slice();
    return LANE_POOL[Math.floor(rng() * LANE_POOL.length)].slice();
  }

  /* ---- traffic, crabs, umbrellas, waves: all pure functions of the clock ---- */

  function entityX(lane, i, t) {
    return mod(lane.offs[i] + lane.dir * lane.speed * t, LOOP) - PAD;
  }

  function umbrellaX(lane, t) {
    const u = lane.umbrella;
    return mod(u.off + u.dir * u.speed * t, LOOP) - PAD;
  }

  /* The runner is sheltered while the middle of the tile is under the umbrella's shade. */
  function inShade(lane, col, t) {
    if (!lane.umbrella) return false;
    const x = umbrellaX(lane, t);
    const c = col + 0.5;
    return c > x + 0.15 && c < x + lane.umbrella.w - 0.15;
  }

  /* Crab centre, in tile units, as it scuttles back and forth over tiles a..b. */
  function crabX(crab, t) {
    const len = crab.b - crab.a;
    const cyc = 2 * len;
    const tt = t / crab.step + crab.phase;
    const k = Math.floor(tt);
    const f = tt - k;
    const pos = (n) => { const m = mod(n, cyc); return crab.a + (m <= len ? m : cyc - m); };
    const e = Math.min(1, f / CRAB_MOVE_FRAC);
    const s = e * e * (3 - 2 * e);
    const from = pos(k);
    return from + (pos(k + 1) - from) * s + 0.5;
  }

  /* Wave depth in rows covered from the sea side (0 = dry), over one cycle: dry, wash in, hold, drain out. */
  function waveDepth(w, t) {
    const ph = mod(t / w.period + w.phase, 1);
    if (ph < w.dryFrac) return 0;
    const q = (ph - w.dryFrac) / (1 - w.dryFrac);
    if (q < 0.3) { const e = q / 0.3; return w.rows * (1 - (1 - e) * (1 - e)); }
    if (q < 0.6) return w.rows;
    const e = (q - 0.6) / 0.4;
    return w.rows * (1 - e * e * (3 - 2 * e));
  }

  /* True while the wave covers wave row j (0 = the wave row nearest the dunes). */
  function waveWet(w, j, t) {
    return waveDepth(w, t) > (w.rows - 1 - j) + 0.15;
  }

  /* The sea ripples for the last second of the dry spell before a wash-in. */
  function waveWarn(w, t) {
    const ph = mod(t / w.period + w.phase, 1);
    const warn = 1.0 / w.period;
    return ph >= w.dryFrac - warn && ph < w.dryFrac;
  }

  const waveDrySeconds = (w) => w.dryFrac * w.period;
  /* Dry seconds a human needs to cross every wave row: one hop per row at a relaxed pace, plus a cushion. */
  const waveDryNeeded = (rows) => rows * 0.5 + 1.2;

  function laneMinGap(lane) {
    const n = lane.n;
    if (n < 2) return Infinity;
    const offs = lane.offs.map((o) => mod(o, LOOP)).sort((a, b) => a - b);
    let min = Infinity;
    for (let i = 0; i < n; i++) {
      const cur = offs[i];
      const next = i === n - 1 ? offs[0] + LOOP : offs[i + 1];
      min = Math.min(min, next - cur - lane.w);
    }
    return min;
  }

  /* What would hurt a runner standing on (row, col) at traffic time tT and wave time tW?
     Returns null (safe), 'hit' (traffic or crab) or 'wave' (washed). opts.margin widens the runner's hit box (the solver
     uses it as a safety cushion); opts.noShade ignores umbrellas (the solver does not rely on them). */
  function hazardAt(lvl, row, col, tT, tW, opts) {
    const R = lvl.rows[row];
    if (!R) return null;
    const m = (opts && opts.margin) || 0;
    const c = col + 0.5;
    if (R.kind === 'board') {
      if (!(opts && opts.noShade) && inShade(R, col, tT)) return null;
      const pl = c - PLAYER_HALF - m;
      const pr = c + PLAYER_HALF + m;
      for (let i = 0; i < R.n; i++) {
        const x = entityX(R, i, tT);
        if (pl < x + R.w - ENT_MARGIN && pr > x + ENT_MARGIN) return 'hit';
      }
    } else if (R.kind === 'sand') {
      for (const crab of R.crabs) {
        if (Math.abs(crabX(crab, tT) - c) < PLAYER_HALF + CRAB_HALF + m) return 'hit';
      }
    } else if (R.kind === 'wave') {
      if (waveWet(lvl.wave, R.j, tW)) return 'wave';
      // the solver's cushion also covers a wave that arrives a moment early or late
      if (m > 0 && (waveWet(lvl.wave, R.j, tW - 0.12) || waveWet(lvl.wave, R.j, tW + 0.12))) return 'wave';
    }
    return null;
  }

  const isWall = (lvl, row, col) => {
    const R = lvl.rows[row];
    return !!(R && R.kind === 'sand' && R.walls[col]);
  };

  /* ---- level generation ---- */

  function makeBoardLane(rng, type, dir, speedBase, params) {
    const T = TYPES[type];
    const speed = clamp(speedBase * T.f * (0.85 + 0.3 * rng()), 0.7, params.speedCap);
    const gapReq = gapRequired(speed);
    const gapTarget = gapReq * params.gapScale;
    let n = clamp(Math.floor(LOOP / (T.w + gapTarget)), 2, params.maxPerLane);
    while (n > 2 && LOOP / n - T.w < gapReq) n--;
    const spacing = LOOP / n;
    const jit = Math.max(0, 0.4 * (spacing - T.w - gapReq));
    const base = rng() * LOOP;
    const offs = [];
    for (let i = 0; i < n; i++) offs.push(mod(base + i * spacing + (rng() * 2 - 1) * jit, LOOP));
    const lane = { kind: 'board', type, dir, speed, w: T.w, n, offs, umbrella: null };
    return lane;
  }

  function makeSandRows(rng, count, params) {
    // Guaranteed corridor: one open tile per row, joined to the next row by a straight run, so walls never seal a row.
    const keep = [];
    let prev = randInt(rng, 1, COLS - 2);
    for (let r = 0; r < count; r++) {
      const cur = clamp(prev + randInt(rng, -2, 2), 0, COLS - 1);
      const set = {};
      for (let c = Math.min(prev, cur); c <= Math.max(prev, cur); c++) set[c] = true;
      keep.push(set);
      prev = cur;
    }
    const rows = [];
    for (let r = 0; r < count; r++) {
      const walls = new Array(COLS).fill(false);
      const free = [];
      for (let c = 0; c < COLS; c++) if (!keep[r][c]) free.push(c);
      const maxWalls = Math.min(params.walls, COLS - 4, free.length);
      for (const c of shuffle(rng, free).slice(0, maxWalls)) walls[c] = true;
      rows.push({ kind: 'sand', walls, crabs: [] });
    }
    // Crabs patrol an open stretch of at least 3 tiles (at most 5) so they can never wedge into a single gap.
    const laneIdx = shuffle(rng, rows.map((_, i) => i)).slice(0, Math.min(params.crabLanes, count));
    for (const li of laneIdx) {
      const R = rows[li];
      const segs = [];
      let c = 0;
      while (c < COLS) {
        if (R.walls[c]) { c++; continue; }
        let e = c;
        while (e + 1 < COLS && !R.walls[e + 1]) e++;
        if (e - c >= 2) segs.push([c, e]);
        c = e + 1;
      }
      if (!segs.length) continue;
      const seg = segs[Math.floor(rng() * segs.length)];
      const span = Math.min(seg[1] - seg[0], 4);
      const a = seg[0] + randInt(rng, 0, seg[1] - seg[0] - span);
      R.crabs.push({ a, b: a + span, step: params.crabStep * (0.9 + 0.2 * rng()), phase: rng() * 2 * span });
    }
    return rows;
  }

  function generateLevel(level, seed) {
    const L = Math.max(1, Math.floor(level) || 1);
    const rng = mulberry32(hashSeed(seed, L, 7));
    const params = levelParams(L);
    const [nB, nS, nW] = laneCounts(L, rng);
    const safe = (ROWS - 2) - (nB + nS + nW);
    const sA = 1 + Math.floor(rng() * (safe - 1));
    const sB = safe - sA;

    const rows = [{ kind: 'start' }];
    // boardwalk lanes: types shuffled each level so the lane order differs; direction alternates from a random start
    const pool = TYPE_ORDER.slice(0, L === 1 ? 3 : L === 2 ? 4 : 5);
    const typeSeq = [];
    while (typeSeq.length < nB) for (const t of shuffle(rng, pool)) if (typeSeq.length < nB) typeSeq.push(t);
    let dir = rng() < 0.5 ? 1 : -1;
    const boardLanes = [];
    for (let i = 0; i < nB; i++) {
      const lane = makeBoardLane(rng, typeSeq[i], dir, params.speedBase, params);
      boardLanes.push(lane);
      dir = -dir;
    }
    // shade umbrellas: an umbrella drifts along some lanes; standing in its shade shelters the runner
    const umbIdx = shuffle(rng, boardLanes.map((_, i) => i));
    const umbCount = L === 1 ? 1 : umbIdx.filter(() => rng() < params.umbrellaChance).length;
    for (const i of umbIdx.slice(0, Math.min(umbCount, nB))) {
      const ln = boardLanes[i];
      ln.umbrella = { w: 1.6, off: rng() * LOOP, speed: Math.max(0.5, ln.speed * 0.45), dir: ln.dir };
    }
    for (const ln of boardLanes) { ln.zone = 'board'; rows.push(ln); }
    for (let i = 0; i < sA; i++) rows.push({ kind: 'safe', zone: 'promenade' });
    for (const R of makeSandRows(rng, nS, params)) { R.zone = 'sand'; rows.push(R); }
    const dunes = [];
    for (let i = 0; i < sB; i++) { const R = { kind: 'safe', zone: 'dune' }; dunes.push(rows.length); rows.push(R); }
    const firstWave = rows.length;
    const period = Math.max(params.wavePeriod, waveDryNeeded(nW) / params.dryFrac);
    for (let j = 0; j < nW; j++) rows.push({ kind: 'wave', j });
    rows.push({ kind: 'goal' });
    const wave = {
      rows: nW, firstRow: firstWave, floorRow: dunes[0], period, dryFrac: params.dryFrac, phase: rng(),
    };
    return { level: L, seed, params, rows, wave, melt: params.melt, counts: [nB, nS, nW] };
  }

  /* Tiles the runner could reach on foot ignoring traffic: walls only. Proves walls never seal the board. */
  function staticReachable(lvl) {
    const seen = new Set([START_COL]);
    const q = [[0, START_COL]];
    while (q.length) {
      const [r, c] = q.shift();
      for (const k of Object.keys(DIRS)) {
        const nr = r + DIRS[k].dy, nc = c + DIRS[k].dx;
        if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS || isWall(lvl, nr, nc)) continue;
        const key = nr * COLS + nc;
        if (seen.has(key)) continue;
        seen.add(key);
        q.push([nr, nc]);
      }
    }
    return seen;
  }

  /* One delivery: where the customer sits, the clock offset (so traffic is in a different place each time) and pickups. */
  function generateDelivery(lvl, index, seed, prevCol) {
    const rng = mulberry32(hashSeed(seed, lvl.level, index, 99));
    const w = lvl.params.towelW;
    const span = COLS - w + 1;
    let col = Math.floor(rng() * span);
    if (span > 1 && col === prevCol) col = (col + 1 + Math.floor(rng() * (span - 1))) % span;
    const reach = staticReachable(lvl);
    const laneTiles = [], safeTiles = [];
    for (let r = 1; r < ROWS - 1; r++) {
      const R = lvl.rows[r];
      for (let c = 0; c < COLS; c++) {
        if (!reach.has(r * COLS + c) || isWall(lvl, r, c)) continue;
        if (R.kind === 'safe') safeTiles.push([r, c]);
        else if (R.kind === 'board' || R.kind === 'sand') laneTiles.push([r, c]);
      }
    }
    const pickups = [];
    const used = new Set();
    const put = (type, list) => {
      if (!list.length) return;
      for (let tries = 0; tries < 12; tries++) {
        const [r, c] = list[Math.floor(rng() * list.length)];
        if (used.has(r * COLS + c)) continue;
        used.add(r * COLS + c);
        pickups.push({ type, row: r, col: c, taken: false });
        return;
      }
    };
    put(rng() < 0.5 ? 'cherry' : 'straw', laneTiles);
    if (rng() < 0.6) put('ice', safeTiles);
    if (lvl.level >= 2 && rng() < 0.5) put('swirl', safeTiles);
    return {
      index, towelCol: col, towelW: w, tOff: Math.floor(rng() * 4000) / 100, pickups,
      look: { skin: randInt(rng, 0, 3), hair: randInt(rng, 0, 4), shirt: randInt(rng, 0, 3), kind: randInt(rng, 0, 3) },
    };
  }

  /* ---- scoring ---- */

  const deliveryBase = (level) => BASE_DELIVERY + LEVEL_BONUS * (Math.max(1, level) - 1);
  const speedTip = (meltFrac) => Math.round(TIP_MAX * clamp(meltFrac, 0, 1));
  const deliveryScore = (level, meltFrac) => {
    const base = deliveryBase(level), tip = speedTip(meltFrac);
    return { base, tip, total: base + tip };
  };
  const pickupPoints = (type) => (type === 'cherry' ? CHERRY_POINTS : type === 'straw' ? STRAW_POINTS : 0);

  /* ---- input buffer: one hop may wait behind the hop in flight; the newest wins ---- */
  const bufferHop = (buf, dir) => (DIRS[dir] ? dir : buf);

  /* ---- solver: time-expanded breadth-first search with perfect knowledge of the clocks ----
     Hops at most once per `step` seconds (slower than any human), keeps `margin` tiles clear of every hazard, ignores
     umbrellas and pickups (opts.avoid lists tiles to stay off, such as ice). If it finds a route, a careful human can too. */
  function solve(lvl, o) {
    const opts = o || {};
    const step = opts.step || 0.25;
    const margin = opts.margin == null ? 0.2 : opts.margin;
    const maxTime = opts.maxTime || 70;
    const tOff = opts.tOff || 0;
    const startCol = opts.startCol == null ? START_COL : opts.startCol;
    const goal = opts.goalCols || null;
    const avoid = new Set((opts.avoid || []).map((a) => a[0] * COLS + a[1]));   // e.g. ice: it would stop the traffic clock
    const subs = Math.ceil(step / 0.05);
    const haz = { margin, noShade: true };
    const safeFor = (row, col, k) => {
      for (let s = 0; s <= subs; s++) {
        const t = tOff + k * step + (s * step) / subs;
        if (hazardAt(lvl, row, col, t, t, haz)) return false;
      }
      return true;
    };
    const N = ROWS * COLS;
    const layers = [new Int32Array(N).fill(-1)];
    layers[0][startCol] = startCol;            // value = previous state in the layer before, -1 = unreachable
    const maxK = Math.ceil(maxTime / step);
    const moves = [[0, 0], [0, 1], [0, -1], [-1, 0], [1, 0]];
    for (let k = 0; k < maxK; k++) {
      const cur = layers[k];
      const next = new Int32Array(N).fill(-1);
      let any = false;
      for (let s = 0; s < N; s++) {
        if (cur[s] < 0) continue;
        const r = Math.floor(s / COLS), c = s % COLS;
        for (const [dx, dy] of moves) {
          const nr = r + dy, nc = c + dx;
          if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
          if (isWall(lvl, nr, nc)) continue;
          const ns = nr * COLS + nc;
          if (next[ns] >= 0 || avoid.has(ns)) continue;
          if (!safeFor(nr, nc, k)) continue;
          next[ns] = s;
          any = true;
        }
      }
      layers.push(next);
      if (!any) return { ok: false, moves: [], time: null };
      // success: standing on the top row at a goal column
      for (let c = 0; c < COLS; c++) {
        if (goal && !goal.includes(c)) continue;
        const s = (ROWS - 1) * COLS + c;
        if (next[s] >= 0) {
          const plan = [];
          let state = s;
          for (let kk = k + 1; kk >= 1; kk--) {
            const prevState = layers[kk][state];
            if (prevState !== state) {
              const dr = Math.floor(state / COLS) - Math.floor(prevState / COLS);
              const dc = (state % COLS) - (prevState % COLS);
              const dir = dr > 0 ? 'up' : dr < 0 ? 'down' : dc > 0 ? 'right' : 'left';
              plan.push({ t: (kk - 1) * step, dir });
            }
            state = prevState;
          }
          plan.reverse();
          return { ok: true, moves: plan, time: (k + 1) * step };
        }
      }
    }
    return { ok: false, moves: [], time: null };
  }

  /* ---- engine ---- */

  function createGame(opts) {
    const o = opts || {};
    const seed = (o.seed == null ? (Math.random() * 4294967296) : o.seed) >>> 0;
    const g = {
      seed, level: 1, deliveries: 0, lives: MAX_LIVES, score: 0, over: false, shield: false,
      events: [], lvl: null, d: null, p: null, freeze: 0, buf: null, banner: null,
      tT: 0, tW: 0, elapsed: 0, hops: 0,
    };
    g.lvl = generateLevel(1, seed);
    startDelivery(g, -1);
    return g;
  }

  function startDelivery(g, prevCol) {
    g.d = generateDelivery(g.lvl, g.deliveries, g.seed, prevCol);
    g.d.melt = g.lvl.melt;
    g.d.meltTotal = g.lvl.melt;
    g.d.maxRow = 0;
    g.d.pickupPts = 0;
    g.tT = g.d.tOff;
    g.tW = g.d.tOff;
    g.d.elapsed = 0;
    g.freeze = 0;
    spawn(g);
  }

  function spawn(g) {
    g.p = {
      row: 0, col: START_COL, fromRow: 0, fromCol: START_COL, hopAge: 1, hopDur: HOP_COOLDOWN, cool: 0,
      face: 'up', invuln: 0, state: 'alive', stateT: 0,
    };
    g.buf = null;
  }

  const emit = (g, type, data) => { g.events.push(Object.assign({ type }, data || {})); };

  function hop(g, dir) {
    if (g.over || !DIRS[dir]) return 'ignored';
    const p = g.p;
    if (p.state !== 'alive') return 'ignored';
    if (p.cool > 0) { g.buf = bufferHop(g.buf, dir); return 'buffered'; }
    return doHop(g, dir);
  }

  function doHop(g, dir) {
    const p = g.p;
    const nr = p.row + DIRS[dir].dy, nc = p.col + DIRS[dir].dx;
    p.face = dir;
    if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) return 'edge';
    if (isWall(g.lvl, nr, nc)) { emit(g, 'wall', { row: nr, col: nc }); return 'wall'; }
    p.fromRow = p.row; p.fromCol = p.col; p.row = nr; p.col = nc;
    p.hopAge = 0; p.hopDur = HOP_COOLDOWN; p.cool = HOP_COOLDOWN;
    g.hops++;
    emit(g, 'hop', { row: nr, col: nc, dir });
    if (nr > g.d.maxRow) {
      g.d.maxRow = nr;
      g.score += ROW_POINTS;
    }
    for (const pk of g.d.pickups) {
      if (pk.taken || pk.row !== nr || pk.col !== nc) continue;
      pk.taken = true;
      if (pk.type === 'ice') { g.freeze = FREEZE_SECONDS; emit(g, 'freeze', { row: nr, col: nc }); }
      else if (pk.type === 'swirl') { g.shield = true; emit(g, 'shield', { row: nr, col: nc }); }
      else {
        const pts = pickupPoints(pk.type);
        g.score += pts; g.d.pickupPts += pts;
        emit(g, 'pickup', { kind: pk.type, points: pts, row: nr, col: nc });
      }
    }
    if (nr === ROWS - 1 && nc >= g.d.towelCol && nc < g.d.towelCol + g.d.towelW) deliver(g);
    return 'hopped';
  }

  function deliver(g) {
    const p = g.p;
    const frac = g.d.melt / g.d.meltTotal;
    const sc = deliveryScore(g.level, frac);
    g.score += sc.total;
    g.deliveries += 1;
    p.state = 'delivered'; p.stateT = 0;
    g.buf = null;
    g.banner = { base: sc.base, tip: sc.tip, total: sc.total, melted: frac <= 0 };
    emit(g, 'deliver', { base: sc.base, tip: sc.tip, total: sc.total, melted: frac <= 0, row: p.row, col: p.col });
  }

  function takeHit(g) {
    const p = g.p;
    if (g.shield) {
      g.shield = false;
      p.invuln = SHIELD_INVULN;
      emit(g, 'shieldpop', { row: p.row, col: p.col });
      return;
    }
    g.lives -= 1;
    p.state = 'dropped'; p.stateT = 0;
    g.buf = null;
    emit(g, 'hit', { lives: g.lives, row: p.row, col: p.col });
  }

  function sweep(g) {
    const p = g.p;
    const target = Math.max(g.lvl.wave.floorRow, p.row - SWEEP_TILES);
    if (target >= p.row) return;
    p.fromRow = p.row; p.fromCol = p.col; p.row = target;
    p.hopAge = 0; p.hopDur = 0.4;
    p.cool = 0.4;
    g.buf = null;
    emit(g, 'sweep', { from: p.fromRow, row: target, col: p.col });
  }

  function update(g, dtIn) {
    if (g.over) return;
    const dt = clamp(dtIn, 0, 0.05);
    g.elapsed += dt;
    g.tW += dt;
    if (g.freeze > 0) {
      g.freeze = Math.max(0, g.freeze - dt);
      if (g.freeze === 0) emit(g, 'thaw');
    } else {
      g.tT += dt;
    }
    const p = g.p;
    if (p.hopAge < p.hopDur) p.hopAge = Math.min(p.hopDur, p.hopAge + dt);
    if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);

    if (p.state === 'dropped') {
      p.stateT += dt;
      if (p.stateT >= DROP_TIME) {
        if (g.lives <= 0) { g.over = true; emit(g, 'gameover', { score: g.score }); }
        else { spawn(g); g.d.melt = g.d.meltTotal; emit(g, 'respawn'); }
      }
      return;
    }
    if (p.state === 'delivered') {
      p.stateT += dt;
      if (p.stateT >= DELIVER_TIME) {
        const prevCol = g.d.towelCol;
        const newLevel = levelForDeliveries(g.deliveries);
        if (newLevel !== g.level) {
          g.level = newLevel;
          g.lvl = generateLevel(newLevel, g.seed);
          emit(g, 'level', { level: newLevel });
        }
        g.banner = null;
        startDelivery(g, prevCol);
      }
      return;
    }

    g.d.elapsed += dt;
    g.d.melt = Math.max(0, g.d.melt - dt);
    if (p.cool > 0) p.cool = Math.max(0, p.cool - dt);
    if (p.cool === 0 && g.buf) { const b = g.buf; g.buf = null; doHop(g, b); if (p.state !== 'alive') return; }

    if (p.invuln === 0) {
      const h = hazardAt(g.lvl, p.row, p.col, g.tT, g.tW);
      if (h === 'hit') takeHit(g);
      else if (h === 'wave') sweep(g);
    }
  }

  const core = {
    COLS, ROWS, START_COL, PAD, LOOP, HOP_COOLDOWN, PLAYER_HALF, MAX_LIVES, DELIVERIES_PER_LEVEL, FREEZE_SECONDS,
    TYPES, TYPE_ORDER, DIRS, SWEEP_TILES, DROP_TIME, DELIVER_TIME, SHIELD_INVULN,
    BASE_DELIVERY, LEVEL_BONUS, TIP_MAX, CHERRY_POINTS, STRAW_POINTS, ROW_POINTS,
    mulberry32, hashSeed, levelForDeliveries, gapRequired, levelParams, laneCounts, entityX, umbrellaX, inShade, crabX,
    waveDepth, waveWet, waveWarn, waveDrySeconds, waveDryNeeded, laneMinGap, hazardAt, isWall, generateLevel,
    staticReachable, generateDelivery, deliveryBase, speedTip, deliveryScore, pickupPoints, bufferHop, solve,
    createGame, hop, update,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  root.BoardwalkDash = Object.assign(root.BoardwalkDash || {}, { core });

  /* ============================== 2. BROWSER SHELL ============================== */

  if (typeof document === 'undefined' || !document.getElementById('bdCanvas')) return;

  const $ = (id) => document.getElementById(id);
  const canvas = $('bdCanvas');
  const ctx = canvas.getContext('2d');
  const overlay = $('bdOverlay');
  const ovTitle = $('bdOvTitle');
  const ovText = $('bdOvText');
  const ovBest = $('bdOvBest');
  const startBtn = $('bdStart');
  const pauseBtn = $('bdPause');
  const soundBtn = $('bdSound');
  const statusEl = $('bdStatus');
  const hudScore = $('bdScore');
  const hudBest = $('bdBest');
  const hudLevel = $('bdLevel');
  const hudLives = $('bdLives');
  const hudMelt = $('bdMelt');
  const hudBuffs = $('bdBuffs');
  const buffFreeze = $('bdBuffFreeze');
  const buffShield = $('bdBuffShield');

  const T = 48;                       // logical pixels per tile
  const SEA = Math.round(T * 0.7);    // ocean strip above the towel row
  const W = COLS * T;
  const H = SEA + ROWS * T;
  const rowTop = (r) => SEA + (ROWS - 1 - r) * T;

  const BEST_KEY = 'tb-boardwalk-dash-best';
  const SOUND_KEY = 'tb-boardwalk-dash-sound';
  const reducedMq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = !!(reducedMq && reducedMq.matches);
  if (reducedMq) {
    const onChange = function (e) { reduced = e.matches; };
    if (reducedMq.addEventListener) reducedMq.addEventListener('change', onChange);
    else if (reducedMq.addListener) reducedMq.addListener(onChange);
  }

  let best = 0;
  try {
    const v = parseInt(window.localStorage.getItem(BEST_KEY), 10);
    if (v > 0) best = v;
  } catch (e) { /* storage blocked: best score just will not persist */ }
  function saveBest() {
    try { window.localStorage.setItem(BEST_KEY, String(best)); } catch (e) { /* private mode: fine */ }
  }

  let soundOn = true;
  try { if (window.localStorage.getItem(SOUND_KEY) === '0') soundOn = false; } catch (e) { /* default on */ }

  /* ---------------- audio: Web Audio blips, created on the first gesture ---------------- */
  let actx = null;
  let master = null;
  function ensureAudio() {
    if (actx || !soundOn) { if (actx && actx.state === 'suspended') actx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      actx = new AC();
      master = actx.createGain();
      master.gain.value = 0.5;
      master.connect(actx.destination);
    } catch (e) { actx = null; }
  }
  function tone(freq, dur, type, vol, toFreq, delay) {
    if (!actx || !soundOn) return;
    const t0 = actx.currentTime + (delay || 0);
    const osc = actx.createOscillator();
    const gain = actx.createGain();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(freq, t0);
    if (toFreq) osc.frequency.exponentialRampToValueAtTime(toFreq, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol || 0.06, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain); gain.connect(master);
    osc.start(t0); osc.stop(t0 + dur + 0.03);
  }
  const arp = (notes, step, type, vol) => notes.forEach((f, i) => tone(f, step * 1.4, type, vol, null, i * step));
  const sfx = {
    hop: () => tone(480, 0.06, 'square', 0.05, 760),
    wall: () => tone(150, 0.08, 'square', 0.05, 110),
    hit: () => { tone(330, 0.4, 'sawtooth', 0.07, 70); tone(90, 0.3, 'square', 0.06, 50, 0.05); },
    pickup: () => arp([880, 1320], 0.06, 'triangle', 0.07),
    deliver: () => arp([523, 659, 784, 1046, 1318], 0.075, 'square', 0.05),
    freeze: () => arp([1760, 2349, 1976, 2637], 0.05, 'sine', 0.05),
    shield: () => arp([659, 988], 0.07, 'triangle', 0.07),
    shieldpop: () => tone(900, 0.2, 'triangle', 0.07, 300),
    sweep: () => tone(520, 0.45, 'sine', 0.08, 110),
    wave: () => tone(140, 0.7, 'sine', 0.05, 260),
    level: () => arp([392, 523, 659, 784, 1046], 0.08, 'square', 0.05),
    gameover: () => arp([392, 330, 262, 196], 0.18, 'sawtooth', 0.06),
  };
  const play = (name) => { if (actx && soundOn && sfx[name]) sfx[name](); };
  function paintSound() {
    soundBtn.textContent = soundOn ? 'Sound On' : 'Sound Off';
    soundBtn.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
  }
  soundBtn.addEventListener('click', function () {
    soundOn = !soundOn;
    try { window.localStorage.setItem(SOUND_KEY, soundOn ? '1' : '0'); } catch (e) { /* fine */ }
    paintSound();
    if (soundOn) { ensureAudio(); play('pickup'); }
  });
  paintSound();
  const unlock = function () { if (soundOn) ensureAudio(); };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);

  /* ---------------- state ---------------- */
  let mode = 'idle';                  // idle | playing | paused | over
  let g = null;
  let rafId = 0;
  let lastTs = 0;
  let particles = [];
  let shake = 0;
  let popups = [];
  let lastWaveWet = false;

  const params = new URLSearchParams(window.location.search);
  const seedParam = params.get('seed');
  const fixedSeed = seedParam && /^\d{1,9}$/.test(seedParam) ? parseInt(seedParam, 10) : null;

  function say(msg) { statusEl.textContent = msg; }

  function paintHud() {
    hudScore.textContent = String(g ? g.score : 0);
    hudBest.textContent = String(best);
    hudLevel.textContent = String(g ? g.level : 1);
    const lives = g ? g.lives : MAX_LIVES;
    const hearts = hudLives.children;
    for (let i = 0; i < hearts.length; i++) hearts[i].classList.toggle('is-lost', i >= lives);
    hudLives.setAttribute('aria-label', 'Lives left: ' + lives + ' of ' + MAX_LIVES);
    if (g) {
      const frac = g.d.melt / g.d.meltTotal;
      hudMelt.value = Math.round(frac * 100);
      buffFreeze.hidden = !(g.freeze > 0);
      if (g.freeze > 0) buffFreeze.textContent = 'Freeze ' + g.freeze.toFixed(1);
      buffShield.hidden = !g.shield;
      hudBuffs.hidden = buffFreeze.hidden && buffShield.hidden;
    } else {
      hudMelt.value = 100;
      hudBuffs.hidden = true;
    }
  }

  function showOverlay(title, text, btnLabel, withBest) {
    ovTitle.textContent = title;
    ovText.textContent = text;
    ovBest.textContent = withBest ? 'Score ' + g.score + '  Best ' + best : '';
    ovBest.hidden = !withBest;
    startBtn.textContent = btnLabel;
    overlay.hidden = false;
    startBtn.focus({ preventScroll: true });
  }
  const hideOverlay = () => { overlay.hidden = true; };

  function newGame() {
    sid = null;                                            // a fresh run never inherits a tracked finger
    g = createGame({ seed: fixedSeed != null ? fixedSeed : undefined });
    particles = []; popups = []; shake = 0;
    lastWaveWet = false;
    mode = 'playing';
    hideOverlay();
    pauseBtn.disabled = false;
    pauseBtn.textContent = 'Pause';
    paintHud();
    say('Go! Carry the drink to the customer on the towel.');
    if (window.TBK) window.TBK.runStart('boardwalk-dash');
    startLoop();
  }

  function startLoop() {
    if (rafId) return;
    lastTs = 0;
    rafId = requestAnimationFrame(frame);
  }
  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function pause() {
    if (mode !== 'playing') return;
    mode = 'paused';
    stopLoop();
    pauseBtn.textContent = 'Resume';
    showOverlay('Paused', 'Take a breath. The traffic waits for you.', 'Resume', false);
    render(performance.now() / 1000);
  }
  function resume() {
    if (mode !== 'paused') return;
    mode = 'playing';
    hideOverlay();
    pauseBtn.textContent = 'Pause';
    startLoop();
  }
  startBtn.addEventListener('click', function () {
    ensureAudio();
    if (mode === 'paused') resume();
    else newGame();
  });
  pauseBtn.addEventListener('click', function () { if (mode === 'playing') pause(); else if (mode === 'paused') resume(); });
  if (window.TBK) { window.TBK.onEnd(pause); window.TBK.onAgain(newGame); }
  document.addEventListener('visibilitychange', function () { if (document.hidden && mode === 'playing') pause(); });

  /* ---------------- input ---------------- */
  function doHopInput(dir) {
    if (mode !== 'playing') return;
    hop(g, dir);
  }
  const KEYS = {
    ArrowUp: 'up', w: 'up', W: 'up', ArrowDown: 'down', s: 'down', S: 'down',
    ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right',
  };
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const dir = KEYS[e.key];
    if (dir) {
      if (mode === 'playing') { e.preventDefault(); if (!e.repeat) doHopInput(dir); }
      return;
    }
    if ((e.key === 'p' || e.key === 'P' || e.key === 'Escape') && !e.repeat) {
      if (mode === 'playing') pause(); else if (mode === 'paused') resume();
    }
    if (e.key === ' ' && mode === 'playing') e.preventDefault();
  });

  /* Swipe on the board: a hop registers as soon as the finger has travelled SWIPE px, without lifting, and the anchor
     moves with it, so one continuous drag can chain hops. A short touch with barely any travel is a tap: hop forward. */
  const SWIPE = 16;
  let sid = null, ax = 0, ay = 0, downX = 0, downY = 0, downT = 0, swiped = false;
  canvas.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    if (window.TBK && window.TBK.isStray(e)) return;       // a palm or sleeve on the panel
    if (sid !== null) return;                              // one finger at a time: extra pointers never take over the swipe
    sid = e.pointerId; ax = downX = e.clientX; ay = downY = e.clientY; downT = e.timeStamp; swiped = false;
    try { canvas.setPointerCapture(sid); } catch (err) { /* capture unsupported: fine */ }
  });
  canvas.addEventListener('pointermove', function (e) {
    if (e.pointerId !== sid) return;
    const dx = e.clientX - ax, dy = e.clientY - ay;
    if (Math.abs(dx) < SWIPE && Math.abs(dy) < SWIPE) return;
    if (Math.abs(dx) > Math.abs(dy)) doHopInput(dx > 0 ? 'right' : 'left');
    else doHopInput(dy > 0 ? 'down' : 'up');
    swiped = true;
    ax = e.clientX; ay = e.clientY;
  });
  const swipeEnd = function (e) {
    if (e.pointerId !== sid) return;
    const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (e.type === 'pointerup' && !swiped && moved < 10 && e.timeStamp - downT < 450) doHopInput('up');
    sid = null;
  };
  canvas.addEventListener('pointerup', swipeEnd);
  canvas.addEventListener('pointercancel', swipeEnd);
  canvas.addEventListener('lostpointercapture', swipeEnd);       // a lost capture ends the swipe like the other games (swipeEnd only hops on a real pointerup)
  window.addEventListener('blur', function () { sid = null; });  // a stuck pointer never survives a lost focus
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  document.querySelectorAll('#bdPad button').forEach(function (b) {
    const dir = b.dataset.dir;
    b.addEventListener('pointerdown', function (e) { e.preventDefault(); if (window.TBK && window.TBK.isStray(e)) return; doHopInput(dir); });
    b.addEventListener('click', function (e) { if (e.detail === 0) doHopInput(dir); });   // keyboard activation only
  });

  /* ---------------- canvas sizing ---------------- */
  let scale = 1;
  function fit() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    scale = canvas.width / W;
    if (mode !== 'playing') render(performance.now() / 1000);
  }
  window.addEventListener('resize', fit);
  if (window.ResizeObserver) new ResizeObserver(fit).observe(canvas);

  /* ---------------- main loop ---------------- */
  function frame(ts) {
    rafId = 0;
    if (mode !== 'playing') return;
    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
    lastTs = ts;
    update(g, dt);
    handleEvents();
    const wetNow = g.lvl.wave && waveDepth(g.lvl.wave, g.tW) > 0.05;
    if (wetNow && !lastWaveWet) play('wave');
    lastWaveWet = wetNow;
    stepFx(dt);
    paintHud();
    render(ts / 1000);
    if (g.over) { finishGame(); return; }
    rafId = requestAnimationFrame(frame);
  }

  function finishGame() {
    mode = 'over';
    if (g.score > best) { best = g.score; saveBest(); }
    paintHud();
    pauseBtn.disabled = true;
    pauseBtn.textContent = 'Pause';
    showOverlay('Game over', 'Out of drinks. Fancy another run?', 'Play again', true);
    say('Game over. Score ' + g.score + '. Best ' + best + '.');
    if (window.TBK) window.TBK.runEnd();
  }

  function burst(x, y, colors, n, speed, life) {
    if (reduced) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.65);
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - speed * 0.3, life: life * (0.6 + Math.random() * 0.4), max: life, c: colors[i % colors.length], s: 2 + Math.random() * 3 });
    }
  }
  const tileCx = (c) => (c + 0.5) * T;
  const tileCy = (r) => rowTop(r) + T / 2;
  function popup(text, x, y, color) {
    popups.push({ text, x, y, color, age: 0 });
    if (popups.length > 6) popups.shift();
  }

  function handleEvents() {
    const evs = g.events;
    g.events = [];
    for (const ev of evs) {
      switch (ev.type) {
        case 'hop': play('hop'); break;
        case 'wall': play('wall'); break;
        case 'hit':
          play('hit');
          if (!reduced) shake = 0.3;
          burst(tileCx(ev.col), tileCy(ev.row), ['#FF3CAC', '#FFD166', '#FFF4FA'], 16, 140, 0.7);
          say('Dropped the drink! ' + ev.lives + (ev.lives === 1 ? ' life left.' : ' lives left.'));
          break;
        case 'shieldpop':
          play('shieldpop'); burst(tileCx(ev.col), tileCy(ev.row), ['#FFD166', '#FFF4FA'], 14, 120, 0.6);
          popup('Bump!', tileCx(ev.col), tileCy(ev.row) - 20, '#FFD166'); say('Pineapple soft serve took the bump.'); break;
        case 'pickup':
          play('pickup'); burst(tileCx(ev.col), tileCy(ev.row), ['#FF3CAC', '#FFD166', '#2AF5E4'], 12, 110, 0.6);
          popup('+' + ev.points, tileCx(ev.col), tileCy(ev.row) - 18, '#FFD166'); break;
        case 'freeze': play('freeze'); popup('Freeze!', tileCx(ev.col), tileCy(ev.row) - 18, '#2AF5E4'); say('Ice! Traffic is frozen for three seconds.'); break;
        case 'thaw': say('Traffic is moving again.'); break;
        case 'shield': play('shield'); popup('One free bump', tileCx(ev.col), tileCy(ev.row) - 18, '#FFD166'); say('Pineapple soft serve! One free bump.'); break;
        case 'sweep':
          play('sweep'); burst(tileCx(ev.col), tileCy(ev.from), ['#2AF5E4', '#FFF4FA'], 14, 120, 0.6);
          say('A wave swept you back.'); break;
        case 'deliver':
          play('deliver');
          burst(tileCx(g.p.col), tileCy(g.p.row), ['#FF3CAC', '#FFD166', '#2AF5E4', '#FFF4FA'], 34, 190, 1.1);
          say('Delivered! ' + ev.base + ' plus a ' + ev.tip + ' point speed tip.'); break;
        case 'level': play('level'); say('Level ' + ev.level + '. New lanes!'); break;
        case 'respawn': say('New drink, back at the trailer.'); break;
        case 'gameover': play('gameover'); break;
        default: break;
      }
    }
  }

  function stepFx(dt) {
    shake = Math.max(0, shake - dt);
    for (const p of particles) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 260 * dt; }
    particles = particles.filter((p) => p.life > 0);
    for (const p of popups) p.age += dt;
    popups = popups.filter((p) => p.age < 1.1);
  }

  /* ================= rendering: everything is drawn from shapes ================= */
  const PAL = {
    ink: '#14032E', pink: '#FF3CAC', teal: '#2AF5E4', gold: '#FFD166', orange: '#FF7A45', foam: '#FFF4FA', purple: '#8A3FFC',
  };
  const SKIN = ['#FFD0A6', '#E8A87C', '#B9794F', '#7A4A2E'];
  const HAIR = ['#2B1B12', '#FFD166', '#FF3CAC', '#2AF5E4', '#8A3FFC'];
  const SHIRT = ['#2AF5E4', '#FF7A45', '#8A3FFC', '#FFD166'];

  function rr(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function circle(x, y, r, fill, stroke, lw) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.lineWidth = lw || 1.5; ctx.strokeStyle = stroke; ctx.stroke(); }
  }
  function ellipse(x, y, rx, ry, fill) {
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
  }
  function noise(a, b) { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); }

  const ART = {};
  (function loadArt() {
    [['trailer', '/kiosk/games/boardwalk-dash/assets/trailer.png'],
     ['sandcastle', '/kiosk/games/boardwalk-dash/assets/sandcastle.png'],
     ['crab', '/kiosk/games/boardwalk-dash/assets/crab.png']].forEach(function (pair) {
      const im = new Image();
      im.onload = function () { render(performance.now() / 1000); };
      im.src = pair[1];
      ART[pair[0]] = im;
    });
  })();

  /* Pre-rendered "sprite + glow" cache. A drawImage with shadowBlur re-blurs the whole sprite on every frame; this renders it ONCE per (sprite, colour, size, resolution) into a small offscreen
     canvas and then just stamps that bitmap. Returns null while the image is not ready, so the caller keeps its drawn fallback. */
  const GLOW = {};
  function glowSprite(img, key, w, h, color, blur, offY, pxPerUnit) {
    if (!(img && img.complete && img.naturalWidth > 0)) return null;
    const res = Math.max(1, Math.min(4, Math.ceil(pxPerUnit * 2) / 2));
    const k = key + '|' + color + '|' + blur + '|' + (offY || 0) + '|' + w + 'x' + h + '@' + res;
    let e = GLOW[k];
    if (!e) {
      const pad = Math.ceil(blur * 1.6 + Math.abs(offY || 0) + 2);
      const cv = document.createElement('canvas');
      cv.width = Math.ceil((w + 2 * pad) * res); cv.height = Math.ceil((h + 2 * pad) * res);
      const x = cv.getContext('2d');
      if (!x) return null;
      x.shadowColor = color; x.shadowBlur = blur * res; x.shadowOffsetY = (offY || 0) * res;
      x.drawImage(img, pad * res, pad * res, w * res, h * res);
      if (Object.keys(GLOW).length > 24) for (const old in GLOW) { delete GLOW[old]; break; }
      e = GLOW[k] = { cv: cv, pad: pad, w: w, h: h };
    }
    return e;
  }
  function stampGlow(c, e, x, y, dw, dh) {
    const sx = dw / e.w, sy = dh / e.h;
    c.drawImage(e.cv, x - e.pad * sx, y - e.pad * sy, (e.w + 2 * e.pad) * sx, (e.h + 2 * e.pad) * sy);
  }

  function drawBackground(time) {
    // 1986 Miami twilight sunset ocean strip at top
    const sea = ctx.createLinearGradient(0, 0, 0, SEA);
    sea.addColorStop(0, '#1B074E');
    sea.addColorStop(0.35, '#5B1A82');
    sea.addColorStop(0.68, '#148FB4');
    sea.addColorStop(1, '#2AF5E4');
    ctx.fillStyle = sea; ctx.fillRect(0, 0, W, SEA);
    // Outrun sunset shimmer bands across upper horizon
    ctx.fillStyle = 'rgba(255,60,172,0.58)';
    for (let i = 0; i < 3; i++) ctx.fillRect(0, 2 + i * 4.5, W, 1.8 + i * 0.4);
    ctx.fillStyle = 'rgba(255,209,102,0.62)';
    ctx.fillRect(W * 0.28, 7, W * 0.44, 2);
    ctx.fillRect(W * 0.35, 13, W * 0.3, 1.8);
    // animated turquoise water glints & foam edge
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    for (let i = 0; i < 9; i++) {
      const x = ((i * 53 + (reduced ? 0 : time * 14)) % (W + 40)) - 20;
      ctx.fillRect(x, SEA - 9 + (i % 3) * 2.5, 18, 2);
    }
    ctx.fillStyle = 'rgba(255,244,250,0.85)';
    ctx.fillRect(0, SEA - 2, W, 2);
    for (let r = 0; r < ROWS; r++) drawRowBg(r, time);
  }

  function drawRowBg(r, time) {
    const R = g.lvl.rows[r];
    const y = rowTop(r);
    if (R.kind === 'start') {
      const bg = ctx.createLinearGradient(0, y, 0, y + T);
      bg.addColorStop(0, '#361466'); bg.addColorStop(1, '#1B063B');
      ctx.fillStyle = bg; ctx.fillRect(0, y, W, T);
      // retro Art Deco checkerboard terrazzo floor
      ctx.fillStyle = 'rgba(42,245,228,0.07)';
      for (let c = 0; c < COLS; c++) if ((c + 1) % 2) ctx.fillRect(c * T, y, T, T);
      ctx.fillStyle = 'rgba(255,60,172,0.5)'; ctx.fillRect(0, y, W, 2);
      drawTrailer(y);
    } else if (R.kind === 'board') {
      // warm twilight wooden Miami boardwalk planks
      const pl = ctx.createLinearGradient(0, y, 0, y + T);
      pl.addColorStop(0, r % 2 ? '#592C78' : '#4E246C');
      pl.addColorStop(1, r % 2 ? '#3F1B5B' : '#361650');
      ctx.fillStyle = pl; ctx.fillRect(0, y, W, T);
      // horizontal subtle wood grain bands
      ctx.fillStyle = 'rgba(255,200,240,0.05)';
      ctx.fillRect(0, y + T * 0.28, W, 2);
      ctx.fillRect(0, y + T * 0.65, W, 2);
      // staggered vertical plank seams with nail studs
      for (let x = -((r * 37) % 64); x < W; x += 64) {
        ctx.fillStyle = 'rgba(12,2,28,0.45)'; ctx.fillRect(x, y, 2, T);
        ctx.fillStyle = 'rgba(255,244,250,0.09)'; ctx.fillRect(x + 2, y, 1, T);
        ctx.fillStyle = 'rgba(255,209,102,0.28)';
        ctx.fillRect(x + 5, y + 6, 2, 2); ctx.fillRect(x + 5, y + T - 9, 2, 2);
      }
      // glowing neon cyan lane guide rail
      ctx.fillStyle = 'rgba(42,245,228,0.62)'; ctx.fillRect(0, y + T - 2, W, 2);
    } else if (R.kind === 'safe') {
      if (R.zone === 'promenade') {
        // 1986 South Beach Art Deco neon promenade
        const pr = ctx.createLinearGradient(0, y, 0, y + T);
        pr.addColorStop(0, '#7B3DA3'); pr.addColorStop(1, '#582580');
        ctx.fillStyle = pr; ctx.fillRect(0, y, W, T);
        // subtle Art Deco diamond tiles
        ctx.strokeStyle = 'rgba(255,244,250,0.12)'; ctx.lineWidth = 1.2;
        for (let c = 0; c < COLS; c++) {
          const cx0 = c * T + T / 2, cy0 = y + T / 2;
          ctx.beginPath();
          ctx.moveTo(cx0, cy0 - 11); ctx.lineTo(cx0 + 13, cy0); ctx.lineTo(cx0, cy0 + 11); ctx.lineTo(cx0 - 13, cy0);
          ctx.closePath(); ctx.stroke();
          // glowing neon walkway studs
          const col = c % 3 === 0 ? '#FF3CAC' : c % 3 === 1 ? '#FFD166' : '#2AF5E4';
          circle(cx0, cy0, 3.2, col);
          circle(cx0, cy0, 1.3, '#FFF4FA');
        }
        ctx.fillStyle = 'rgba(255,209,102,0.45)'; ctx.fillRect(0, y, W, 2);
        ctx.fillStyle = 'rgba(255,60,172,0.45)'; ctx.fillRect(0, y + T - 2, W, 2);
      } else {
        const sg = ctx.createLinearGradient(0, y, 0, y + T);
        sg.addColorStop(0, '#F6C68C'); sg.addColorStop(1, '#E5AE74');
        ctx.fillStyle = sg; ctx.fillRect(0, y, W, T);
        sandSpeckle(r, y);
        ctx.fillStyle = 'rgba(255,250,235,0.3)'; ctx.fillRect(0, y, W, 2);
      }
    } else if (R.kind === 'sand') {
      const sg = ctx.createLinearGradient(0, y, 0, y + T);
      sg.addColorStop(0, r % 2 ? '#F6C88E' : '#F0BF84');
      sg.addColorStop(1, r % 2 ? '#E8B376' : '#E0A86C');
      ctx.fillStyle = sg; ctx.fillRect(0, y, W, T);
      sandSpeckle(r, y);
      ctx.fillStyle = 'rgba(175,95,62,0.2)'; ctx.fillRect(0, y + T - 2, W, 2);
    } else if (R.kind === 'wave') {
      const wg = ctx.createLinearGradient(0, y, 0, y + T);
      wg.addColorStop(0, '#BA8563'); wg.addColorStop(1, '#D39B6D');
      ctx.fillStyle = wg; ctx.fillRect(0, y, W, T);
      sandSpeckle(r, y);
    } else if (R.kind === 'goal') {
      const gg = ctx.createLinearGradient(0, y, 0, y + T);
      gg.addColorStop(0, '#FFE0A3'); gg.addColorStop(1, '#F2C080');
      ctx.fillStyle = gg; ctx.fillRect(0, y, W, T);
      sandSpeckle(r, y);
    }
  }
  function sandSpeckle(r, y) {
    for (let i = 0; i < 18; i++) {
      const x = noise(r, i) * W, yy = y + 4 + noise(i, r + 3) * (T - 8);
      ctx.fillStyle = i % 4 === 0 ? 'rgba(255,252,240,0.45)' : 'rgba(130,68,42,0.22)';
      ctx.fillRect(x, yy, 2.2, 2);
    }
    // tiny pastel beach shell accent on select sand rows
    if (r % 2 === 1) {
      const sx0 = 18 + noise(r, 99) * (W - 36);
      circle(sx0, y + T * 0.65, 2.6, 'rgba(255,140,190,0.45)');
    }
  }

  function drawTrailer(y) {
    const x = 3 * T, w = 3 * T;
    // glowing neon underglow beneath the trailer
    ellipse(x + w / 2, y + T - 1, w * 0.48, 5, 'rgba(42,245,228,0.38)');
    if (ART.trailer && ART.trailer.complete && ART.trailer.naturalWidth > 0) {
      const tw = 114, th = 79;
      const ge = glowSprite(ART.trailer, 'trailer', tw, th, 'rgba(255,60,172,0.45)', 10, 0, scale);   // the glow is baked once, not re-blurred every frame
      if (ge) stampGlow(ctx, ge, x + (w - tw) / 2, y + T - th + 2, tw, th);
      else ctx.drawImage(ART.trailer, x + (w - tw) / 2, y + T - th + 2, tw, th);
      return;
    }
    // white box concession trailer body (fallback, matches the sprite)
    const body = ctx.createLinearGradient(0, y + 5, 0, y + T - 2);
    body.addColorStop(0, '#FFFFFF'); body.addColorStop(0.55, '#F4E8FA'); body.addColorStop(1, '#C9B8DC');
    rr(x + 3, y + 6, w - 6, T - 8, 3); ctx.fillStyle = body; ctx.fill();      // a square-cornered box trailer, like the real one
    ctx.lineWidth = 1.8; ctx.strokeStyle = '#14032E'; ctx.stroke();
    // 80s Miami racing stripes
    ctx.fillStyle = PAL.pink; ctx.fillRect(x + 4, y + 27, w - 8, 5.5);
    ctx.fillStyle = PAL.teal; ctx.fillRect(x + 4, y + 33, w - 8, 3.2);
    ctx.fillStyle = '#FFD166'; ctx.fillRect(x + 4, y + 25, w - 8, 2);
    // illuminated service window
    rr(x + T + 7, y + 12, T - 14, 16, 3);
    const win = ctx.createLinearGradient(0, y + 12, 0, y + 28);
    win.addColorStop(0, '#2C0A5C'); win.addColorStop(1, '#12032B');
    ctx.fillStyle = win; ctx.fill();
    ctx.strokeStyle = PAL.teal; ctx.lineWidth = 1.2; ctx.stroke();
    // tiny glowing drink cup on counter inside window
    ctx.fillStyle = PAL.pink; ctx.fillRect(x + T + 18, y + 19, 6, 7);
    ctx.fillStyle = '#FFD166'; ctx.fillRect(x + T + 21, y + 15, 1.5, 5);
    // scalloped hot-pink & white cabana awning
    const segW = (w - 10) / 8;
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? '#FFF4FA' : PAL.pink;
      ctx.fillRect(x + 5 + i * segW, y + 2, segW + 0.5, 9);
      circle(x + 5 + (i + 0.5) * segW, y + 11, segW * 0.5, i % 2 ? '#FFF4FA' : PAL.pink);
    }
    // chrome wheels
    circle(x + 15, y + T - 3, 5.5, '#14032E', '#DCE8F5', 1.8);
    circle(x + 15, y + T - 3, 2, '#FFD166');
    circle(x + w - 15, y + T - 3, 5.5, '#14032E', '#DCE8F5', 1.8);
    circle(x + w - 15, y + T - 3, 2, '#FFD166');
    // crisp signage
    ctx.fillStyle = PAL.ink; ctx.font = '700 8.5px Bungee, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('THIRSTY', x + 29, y + 23); ctx.fillText('BEACHES', x + w - 29, y + 23);
  }

  function drawWaves(time) {
    const w = g.lvl.wave;
    const depth = waveDepth(w, g.tW);
    const warn = waveWarn(w, g.tW);
    const top = rowTop(w.firstRow + w.rows - 1);        // top of the highest wave row
    const bottomY = top + T * w.rows;
    if (depth > 0.02) {
      const frontY = top + depth * T;
      const grad = ctx.createLinearGradient(0, top, 0, frontY);
      grad.addColorStop(0, 'rgba(14,116,158,0.82)');
      grad.addColorStop(0.55, 'rgba(26,196,214,0.74)');
      grad.addColorStop(1, 'rgba(42,245,228,0.68)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.moveTo(0, top);
      ctx.lineTo(W, top);
      for (let x = W; x >= 0; x -= 8) ctx.lineTo(x, Math.min(bottomY, frontY) + Math.sin(x * 0.05 + (reduced ? 0 : time * 3.4)) * 3.2);
      ctx.closePath(); ctx.fill();
      // secondary inner foam lace
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 2; ctx.beginPath();
      for (let x = 0; x <= W; x += 8) {
        const yy = Math.max(top + 2, Math.min(bottomY, frontY) - 8 + Math.sin(x * 0.065 + (reduced ? 0 : time * 2.8) + 1.5) * 2.4);
        if (x === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
      // crisp frothy white surf crest
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 3.5; ctx.beginPath();
      for (let x = 0; x <= W; x += 8) {
        const yy = Math.min(bottomY, frontY) + Math.sin(x * 0.05 + (reduced ? 0 : time * 3.4)) * 3.2;
        if (x === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    } else if (warn) {
      const blink = reduced ? 1 : (Math.sin(time * 14) > 0 ? 1 : 0.35);
      ctx.strokeStyle = 'rgba(42,245,228,' + (0.9 * blink) + ')'; ctx.lineWidth = 3.5; ctx.setLineDash([10, 8]);
      ctx.beginPath(); ctx.moveTo(0, top + 2); ctx.lineTo(W, top + 2); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  /* --- sprites: (cx, cy) is the centre; dir is +1 (moving right) or -1 --- */
  function drawSkater(cx, cy, dir, time, id) {
    const wob = reduced ? 0 : Math.sin(time * 9 + id) * 2;
    ctx.save(); ctx.translate(cx, cy); ctx.scale(dir, 1);
    ellipse(0, 16, 13, 4, 'rgba(0,0,0,0.34)');
    // neon roller-skate wheels & boots
    circle(-6, 14.5, 3, '#2AF5E4', '#14032E', 1.2); circle(6, 14.5, 3, '#2AF5E4', '#14032E', 1.2);
    rr(-10, 8.5, 20, 5, 2); ctx.fillStyle = '#FFF4FA'; ctx.fill(); ctx.strokeStyle = '#14032E'; ctx.lineWidth = 1.2; ctx.stroke();
    // 80s neon leg warmers & shorts
    ctx.fillStyle = PAL.pink; ctx.fillRect(-5, 3, 10, 6);
    // Miami Vice tank top
    rr(-5.5, -7 + wob * 0.3, 11, 12, 3); ctx.fillStyle = '#2AF5E4'; ctx.fill(); ctx.strokeStyle = '#14032E'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = '#FFD166'; ctx.fillRect(-5, -3 + wob * 0.3, 10, 2.5);
    // head, flowing hair, neon headband & shades
    circle(0, -12 + wob * 0.3, 5.8, '#F0B289', '#14032E', 1.2);
    ctx.fillStyle = '#FFD166'; ctx.beginPath(); ctx.arc(-2, -14 + wob * 0.3, 5.5, Math.PI * 0.8, Math.PI * 2.1); ctx.fill();
    ctx.fillStyle = PAL.pink; ctx.fillRect(-6, -16.5 + wob * 0.3, 12, 2.8);
    ctx.fillStyle = '#14032E'; ctx.fillRect(0, -13 + wob * 0.3, 5.5, 2.4);
    ctx.strokeStyle = '#F0B289'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-4, -3); ctx.lineTo(-12, -6 + wob); ctx.moveTo(4, -3); ctx.lineTo(12, -2 - wob); ctx.stroke();
    ctx.restore();
  }
  function drawBike(cx, cy, dir, time) {
    ctx.save(); ctx.translate(cx, cy); ctx.scale(dir, 1);
    ellipse(0, 16, 18, 4, 'rgba(0,0,0,0.34)');
    const spin = reduced ? 0 : time * 10;
    for (const x of [-12, 12]) {
      circle(x, 8, 8.2, 'rgba(20,3,46,0.35)', '#2AF5E4', 2.4);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x + Math.cos(spin) * 7, 8 + Math.sin(spin) * 7); ctx.lineTo(x - Math.cos(spin) * 7, 8 - Math.sin(spin) * 7); ctx.stroke();
      circle(x, 8, 2, '#FFD166');
    }
    ctx.strokeStyle = PAL.pink; ctx.lineWidth = 3.2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-12, 8); ctx.lineTo(-2, -2); ctx.lineTo(8, -2); ctx.lineTo(12, 8); ctx.moveTo(-2, -2); ctx.lineTo(2, 8); ctx.lineTo(-12, 8); ctx.stroke();
    // chrome handlebars
    ctx.strokeStyle = '#FFF4FA'; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(8, -2); ctx.lineTo(11, -9); ctx.lineTo(7, -10); ctx.stroke();
    // rider
    rr(-5, -10, 10, 10, 3); ctx.fillStyle = '#FFD166'; ctx.fill(); ctx.strokeStyle = '#14032E'; ctx.lineWidth = 1.2; ctx.stroke();
    circle(1, -15, 5.4, '#C68259', '#14032E', 1.2);
    ctx.fillStyle = PAL.teal; ctx.fillRect(-5, -20.5, 11, 3.8);
    ctx.fillStyle = '#14032E'; ctx.fillRect(1, -16, 5, 2.2);
    ctx.restore();
  }
  function drawCooler(cx, cy, dir, time) {
    ctx.save(); ctx.translate(cx, cy); ctx.scale(dir, 1);
    ellipse(0, 15, 15, 4, 'rgba(0,0,0,0.34)');
    const cg = ctx.createLinearGradient(0, -9, 0, 11);
    cg.addColorStop(0, '#FF4D5E'); cg.addColorStop(1, '#C41838');
    rr(-13.5, -9, 27, 20, 4); ctx.fillStyle = cg; ctx.fill();
    ctx.strokeStyle = '#14032E'; ctx.lineWidth = 1.5; ctx.stroke();
    rr(-14.5, -12.5, 29, 7.5, 3.5); ctx.fillStyle = '#FFF4FA'; ctx.fill(); ctx.stroke();
    // chrome handle & turquoise racing stripe
    ctx.fillStyle = '#2AF5E4'; ctx.fillRect(-12, 1, 24, 3.5);
    ctx.fillStyle = '#B8D4EE'; ctx.fillRect(-5, -15.5, 10, 3.2);
    const w = reduced ? 0 : Math.sin(time * 12) * 0.6;
    circle(-8, 12.5 + w, 3.6, '#14032E', '#DCE8F5', 1.4); circle(8, 12.5 - w, 3.6, '#14032E', '#DCE8F5', 1.4);
    ctx.restore();
  }
  function drawCart(cx, cy, dir, time) {
    ctx.save(); ctx.translate(cx, cy); ctx.scale(dir, 1);
    ellipse(0, 17, 25, 4.5, 'rgba(0,0,0,0.34)');
    // retro ice-cream boardwalk cart body
    rr(-22, -2, 40, 17, 4); ctx.fillStyle = '#FFF4FA'; ctx.fill();
    ctx.strokeStyle = '#14032E'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = PAL.pink; ctx.fillRect(-21, 5, 38, 4.5);
    ctx.fillStyle = PAL.teal; ctx.fillRect(-21, 10, 38, 2.5);
    // brass awning poles
    ctx.fillStyle = '#FFD166'; ctx.fillRect(-20, -14, 3, 12); ctx.fillRect(14, -14, 3, 12);
    // scalloped teal & white cabana canopy
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = i % 2 ? '#FFF4FA' : PAL.teal;
      ctx.fillRect(-22 + i * 7.5, -20.5, 7.6, 7.5);
    }
    ctx.strokeStyle = '#14032E'; ctx.lineWidth = 1.2; ctx.strokeRect(-22, -20.5, 45, 7.5);
    // mini soft-serve cone emblem on cart
    ctx.fillStyle = '#E8A857'; ctx.beginPath(); ctx.moveTo(-6, -2); ctx.lineTo(6, -2); ctx.lineTo(0, 9); ctx.closePath(); ctx.fill();
    circle(0, -6, 5.5, PAL.pink, '#14032E', 1); circle(0, -12, 4, '#FFF4FA', '#14032E', 1);
    circle(-12, 15.5, 4.4, '#14032E', '#FFD166', 1.5); circle(12, 15.5, 4.4, '#14032E', '#FFD166', 1.5);
    ctx.fillStyle = '#DCE8F5'; ctx.fillRect(18, 2, 6, 3);
    ctx.restore();
  }
  function drawDog(cx, cy, dir, time, id) {
    const run = reduced ? 0 : Math.sin(time * 14 + id);
    ctx.save(); ctx.translate(cx, cy); ctx.scale(dir, 1);
    ellipse(0, 16, 48, 4.2, 'rgba(0,0,0,0.34)');
    // 80s neon jogger (rear)
    rr(-42, -8, 12, 15, 3); ctx.fillStyle = PAL.pink; ctx.fill(); ctx.strokeStyle = '#14032E'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = '#FFF4FA'; ctx.fillRect(-42, 0, 12, 3);
    circle(-36, -14, 6, '#F0B289', '#14032E', 1.2); ctx.fillStyle = PAL.teal; ctx.fillRect(-43, -20.5, 14, 4);
    ctx.strokeStyle = '#F0B289'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-36, 7); ctx.lineTo(-36 + run * 8, 16); ctx.moveTo(-36, 7); ctx.lineTo(-36 - run * 8, 16); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-30, -3); ctx.lineTo(-22, 1); ctx.stroke();
    // glowing neon leash
    ctx.strokeStyle = '#FFD166'; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(-22, 1); ctx.quadraticCurveTo(-10, 12, 6, 3); ctx.stroke();
    // happy beach pup with neon collar
    rr(4, -4, 26, 14, 6); ctx.fillStyle = '#C98354'; ctx.fill(); ctx.strokeStyle = '#14032E'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = PAL.teal; ctx.fillRect(25, -4, 4, 13);
    circle(34, -4, 7.2, '#C98354', '#14032E', 1.2); ctx.fillStyle = '#7A4A2E'; ctx.fillRect(36, -4, 6, 5);
    ctx.fillStyle = '#7A4A2E'; ctx.beginPath(); ctx.moveTo(30, -10); ctx.lineTo(36, -14); ctx.lineTo(37, -7); ctx.fill();
    circle(36, -6, 1.6, '#14032E');
    ctx.strokeStyle = '#7A4A2E'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(8, 8); ctx.lineTo(8 + run * 6, 16); ctx.moveTo(26, 8); ctx.lineTo(26 - run * 6, 16); ctx.moveTo(4, -2); ctx.lineTo(-2, -8 + run * 3); ctx.stroke();
    ctx.restore();
  }
  const DRAWERS = { skater: drawSkater, bike: drawBike, cooler: drawCooler, cart: drawCart, dog: drawDog };

  function drawCrab(cx, cy, time, id) {
    const leg = reduced ? 0 : Math.sin(time * 18 + id) * 2.2;
    ellipse(cx, cy + 12, 15, 4.2, 'rgba(80,30,15,0.34)');
    if (ART.crab && ART.crab.complete && ART.crab.naturalWidth > 0) {
      const wob = reduced ? 0 : Math.sin(time * 14 + id) * 0.1;
      ctx.save();
      ctx.translate(cx, cy - 1);
      ctx.rotate(wob);
      ctx.drawImage(ART.crab, -20, -19, 40, 39);
      ctx.restore();
      return;
    }
    ctx.strokeStyle = '#B8261A'; ctx.lineWidth = 2.6; ctx.lineCap = 'round';
    for (let i = -1; i <= 1; i += 2) for (let k = 0; k < 3; k++) {
      ctx.beginPath(); ctx.moveTo(cx + i * 7, cy + 3 + k * 3); ctx.lineTo(cx + i * 16.5, cy + 6 + k * 3 + (k % 2 ? leg : -leg)); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(cx - 9, cy - 4); ctx.lineTo(cx - 15.5, cy - 11); ctx.moveTo(cx + 9, cy - 4); ctx.lineTo(cx + 15.5, cy - 11); ctx.stroke();
    // snapping coral pincers
    circle(cx - 16, cy - 13, 4.8, '#FF5A3C', '#7A1610', 1.3); circle(cx + 16, cy - 13, 4.8, '#FF5A3C', '#7A1610', 1.3);
    // glossy shaded crab shell
    const sh = ctx.createRadialGradient(cx - 4, cy - 2, 2, cx, cy + 2, 13);
    sh.addColorStop(0, '#FF8F6B'); sh.addColorStop(0.55, '#FF4D33'); sh.addColorStop(1, '#B31D15');
    ellipse(cx, cy + 2, 12.5, 8.8, sh);
    ctx.strokeStyle = '#6B1010'; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ellipse(cx - 4, cy - 2, 4.2, 1.8, 'rgba(255,255,255,0.45)');
    circle(cx - 4.2, cy - 6.5, 3, '#FFF4FA', '#14032E', 1.1); circle(cx + 4.2, cy - 6.5, 3, '#FFF4FA', '#14032E', 1.1);
    circle(cx - 4.2, cy - 6.5, 1.3, '#14032E'); circle(cx + 4.2, cy - 6.5, 1.3, '#14032E');
  }

  function drawSandcastle(c, r) {
    const x = c * T + 4, y = rowTop(r) + 5, w = T - 8;
    ellipse(c * T + T / 2, y + 37, 20, 4.5, 'rgba(95,48,20,0.38)');
    if (ART.sandcastle && ART.sandcastle.complete && ART.sandcastle.naturalWidth > 0) {
      const sw = T + 4, sh = T + 8;
      ctx.drawImage(ART.sandcastle, c * T - 2, rowTop(r) - 6, sw, sh);
      return;
    }
    const sg = ctx.createLinearGradient(x, y + 8, x + w, y + 36);
    sg.addColorStop(0, '#FFF0C2'); sg.addColorStop(0.55, '#F4CE8E'); sg.addColorStop(1, '#C99358');
    rr(x, y + 12, w, 25, 3.5); ctx.fillStyle = sg; ctx.fill(); ctx.lineWidth = 1.6; ctx.strokeStyle = '#7D4D28'; ctx.stroke();
    // sculpted turrets with warm highlight
    for (let i = 0; i < 3; i++) {
      const tx = x + 1 + i * (w / 3);
      ctx.fillStyle = i === 0 ? '#FFF0C2' : '#F2CB89';
      ctx.fillRect(tx, y + 6, w / 3 - 2.5, 7);
      ctx.strokeStyle = '#7D4D28'; ctx.strokeRect(tx, y + 6, w / 3 - 2.5, 7);
    }
    // arched castle doorway
    rr(x + w / 2 - 5.5, y + 20, 11, 17, 5.5); ctx.fillStyle = '#7E4E2E'; ctx.fill();
    ctx.strokeStyle = '#5B3A2A'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(x + w / 2, y + 6); ctx.lineTo(x + w / 2, y - 5); ctx.stroke();
    // vibrant neon pennant flag
    ctx.fillStyle = (c + r) % 2 ? PAL.pink : PAL.teal;
    ctx.beginPath(); ctx.moveTo(x + w / 2, y - 5); ctx.lineTo(x + w / 2 + 10, y - 1.5); ctx.lineTo(x + w / 2, y + 2); ctx.closePath(); ctx.fill();
  }

  function drawUmbrella(lane, r, time) {
    const x = (umbrellaX(lane, g.tT) + lane.umbrella.w / 2) * T;
    const y = rowTop(r) + T / 2;
    const rx = lane.umbrella.w * T / 2;
    ellipse(x, y + 7, rx, 14.5, 'rgba(10,2,28,0.34)');
    const cols = [PAL.pink, '#FFF4FA', PAL.teal, '#FFF4FA', '#FFD166', '#FFF4FA'];
    for (let i = 0; i < 6; i++) {
      ctx.beginPath(); ctx.ellipse(x, y, rx, 16.5, 0, Math.PI + (i * Math.PI) / 6, Math.PI + ((i + 1) * Math.PI) / 6);
      ctx.lineTo(x, y); ctx.closePath(); ctx.fillStyle = cols[i]; ctx.fill();
    }
    ctx.beginPath(); ctx.ellipse(x, y, rx, 16.5, 0, Math.PI, Math.PI * 2); ctx.strokeStyle = '#14032E'; ctx.lineWidth = 1.8; ctx.stroke();
    ctx.fillStyle = '#FFD166'; ctx.fillRect(x - 1.8, y - 2, 3.6, 15);
    circle(x, y - 17.5, 3, '#FFD166', '#14032E', 1.2);
  }

  function drawPickup(pk, time) {
    const cx = tileCx(pk.col);
    const bob = reduced ? 0 : Math.sin(time * 4 + pk.row) * 2.2;
    const cy = tileCy(pk.row) + bob;
    ellipse(cx, tileCy(pk.row) + 14, 10, 3.2, 'rgba(0,0,0,0.28)');
    // crisp neon pickup aura ring
    const aura = pk.type === 'ice' ? '#2AF5E4' : pk.type === 'swirl' ? '#FFD166' : '#FF3CAC';
    ctx.save();
    circle(cx, cy, 13.5, 'rgba(20,4,48,0.42)', aura, 1.8);
    ctx.restore();
    if (pk.type === 'cherry') {
      ctx.strokeStyle = '#2FCB6B'; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(cx - 5, cy + 3); ctx.quadraticCurveTo(cx - 2, cy - 12, cx + 5, cy - 12); ctx.moveTo(cx + 6, cy + 4); ctx.quadraticCurveTo(cx + 4, cy - 8, cx + 5, cy - 12); ctx.stroke();
      circle(cx - 6, cy + 5, 6, '#EE1D47', '#6B081B', 1.3); circle(cx + 6, cy + 6, 6, '#EE1D47', '#6B081B', 1.3);
      circle(cx - 8, cy + 3, 1.8, 'rgba(255,255,255,0.85)'); circle(cx + 4, cy + 4, 1.8, 'rgba(255,255,255,0.85)');
    } else if (pk.type === 'straw') {
      ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.strokeStyle = '#FFF4FA';
      ctx.beginPath(); ctx.moveTo(cx - 6, cy + 12); ctx.lineTo(cx - 6, cy - 6); ctx.quadraticCurveTo(cx - 6, cy - 12, cx + 2, cy - 12); ctx.lineTo(cx + 8, cy - 12); ctx.stroke();
      ctx.lineWidth = 6; ctx.strokeStyle = PAL.pink; ctx.setLineDash([5, 5]);
      ctx.beginPath(); ctx.moveTo(cx - 6, cy + 12); ctx.lineTo(cx - 6, cy - 6); ctx.quadraticCurveTo(cx - 6, cy - 12, cx + 2, cy - 12); ctx.lineTo(cx + 8, cy - 12); ctx.stroke(); ctx.setLineDash([]);
    } else if (pk.type === 'ice') {
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(reduced ? 0.2 : Math.sin(time * 2) * 0.15);
      const ig = ctx.createLinearGradient(-9, -9, 9, 9);
      ig.addColorStop(0, '#FFFFFF'); ig.addColorStop(0.5, '#A8FAFF'); ig.addColorStop(1, '#2AF5E4');
      rr(-9, -9, 18, 18, 3.5); ctx.fillStyle = ig; ctx.fill(); ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 2; ctx.stroke();
      ctx.strokeStyle = 'rgba(20,110,145,0.55)'; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(-5, 2); ctx.lineTo(2, -5); ctx.stroke();
      ctx.restore();
    } else if (pk.type === 'swirl') {
      ctx.fillStyle = '#E3A152'; ctx.beginPath(); ctx.moveTo(cx - 7, cy + 1); ctx.lineTo(cx + 7, cy + 1); ctx.lineTo(cx, cy + 13); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#FFE45E'; rr(cx - 9, cy - 2, 18, 5, 2.5); ctx.fill(); rr(cx - 7, cy - 7, 14, 5, 2.5); ctx.fill(); rr(cx - 4.5, cy - 11, 9, 5, 2.5); ctx.fill();
      circle(cx, cy - 13, 2.2, '#2FCB6B');
    }
  }

  function drawCustomer(d, time) {
    const cx = (d.towelCol + d.towelW / 2) * T;
    const y = rowTop(ROWS - 1);
    const L = d.look;
    // vibrant fringed Miami cabana beach towel
    const tx = d.towelCol * T + 3, tw = d.towelW * T - 6;
    ctx.fillStyle = 'rgba(100,55,25,0.28)';
    rr(tx + 2, y + 24, tw, 24, 3); ctx.fill();
    rr(tx, y + 21, tw, 24, 3); ctx.fillStyle = '#FFF4FA'; ctx.fill();
    ctx.save(); ctx.clip();
    for (let i = 0; i < d.towelW * 4; i++) {
      ctx.fillStyle = i % 2 ? PAL.pink : PAL.teal;
      ctx.fillRect(tx + i * (tw / (d.towelW * 4)), y + 21, 7.5, 24);
    }
    ctx.restore();
    ctx.strokeStyle = '#14032E'; ctx.lineWidth = 1.4; rr(tx, y + 21, tw, 24, 3); ctx.stroke();

    const kid = L.kind === 3;
    const s = kid ? 0.82 : 1;
    const by = y + 26;
    ctx.save(); ctx.translate(cx, by); ctx.scale(s, s);
    ctx.fillStyle = SHIRT[L.shirt]; rr(-8.5, -16, 17, 16, 4.5); ctx.fill();
    ctx.strokeStyle = '#14032E'; ctx.lineWidth = 1.3; ctx.stroke();
    ctx.fillStyle = SKIN[L.skin]; ctx.fillRect(-12, -2, 7, 5); ctx.fillRect(5, -2, 7, 5);
    circle(0, -23, 7.2, SKIN[L.skin], '#14032E', 1.3);
    ctx.fillStyle = HAIR[L.hair]; ctx.beginPath(); ctx.arc(0, -25, 7.5, Math.PI, Math.PI * 2); ctx.fill();
    if (L.kind === 0) { ctx.fillStyle = '#14032E'; ctx.fillRect(-6, -24.5, 12, 3.2); ctx.fillStyle = PAL.teal; ctx.fillRect(-5, -24, 4, 1.5); ctx.fillRect(1, -24, 4, 1.5); }
    if (L.kind === 1) { ctx.fillStyle = '#FFD166'; ctx.fillRect(-12, -27.5, 24, 3.2); ctx.fillRect(-7, -33.5, 14, 7); ctx.fillStyle = PAL.pink; ctx.fillRect(-7, -28.5, 14, 2); }
    if (L.kind === 2) { ctx.fillStyle = PAL.teal; ctx.fillRect(-9, -28.5, 18, 3.2); }
    // waving arm
    const wave = reduced ? 0 : Math.sin(time * 6) * 0.5;
    ctx.save(); ctx.translate(8, -12); ctx.rotate(-1.1 + wave);
    ctx.fillStyle = SKIN[L.skin]; ctx.fillRect(0, -2, 13, 4); ctx.restore();
    ctx.restore();
    // glowing neon-trimmed thirsty speech bubble
    const bx = cx + (d.towelCol + d.towelW / 2 > COLS / 2 ? -34 : 34);
    const bob = reduced ? 0 : Math.sin(time * 3.5) * 2.2;
    ctx.save();
    ctx.shadowColor = PAL.teal; ctx.shadowBlur = 8;
    rr(bx - 14.5, y - 4 + bob, 29, 23, 8); ctx.fillStyle = '#FFFDF8'; ctx.fill();
    ctx.strokeStyle = PAL.pink; ctx.lineWidth = 1.8; ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = PAL.pink; ctx.beginPath(); ctx.moveTo(bx - 7, y + 4 + bob); ctx.lineTo(bx + 7, y + 4 + bob); ctx.lineTo(bx + 5, y + 15.5 + bob); ctx.lineTo(bx - 5, y + 15.5 + bob); ctx.closePath(); ctx.fill();
    ctx.fillStyle = PAL.teal; ctx.fillRect(bx + 2, y - 1 + bob, 2.2, 8);
    ctx.restore();
  }

  function drawRunner(time) {
    const p = g.p;
    const prog = p.hopDur > 0 ? clamp(p.hopAge / p.hopDur, 0, 1) : 1;
    const e = prog * (2 - prog);
    const col = p.fromCol + (p.col - p.fromCol) * e;
    const row = p.fromRow + (p.row - p.fromRow) * e;
    const cx = (col + 0.5) * T;
    const cy = rowTop(0) - row * T + T / 2;
    const lift = Math.sin(prog * Math.PI) * 9 * (p.hopDur === HOP_COOLDOWN ? 1 : 0.4);
    const frac = g.d.melt / g.d.meltTotal;
    const blink = p.invuln > 0 && !reduced && Math.floor(time * 14) % 2 === 0;
    if (p.state === 'dropped') { drawSpill(cx, cy, p.stateT, time); return; }
    ellipse(cx, cy + 15.5, 11.5 - lift * 0.2, 3.8, 'rgba(10,2,28,0.42)');
    if (blink) ctx.globalAlpha = 0.4;
    ctx.save(); ctx.translate(cx, cy - lift);
    const lean = p.face === 'left' ? -0.12 : p.face === 'right' ? 0.12 : 0;
    ctx.rotate(lean);
    // legs & white 80s sneakers
    ctx.fillStyle = '#F0B289'; ctx.fillRect(-5, 8, 4, 6); ctx.fillRect(1, 8, 4, 6);
    ctx.fillStyle = '#FFF4FA'; ctx.fillRect(-6, 13, 5.5, 3); ctx.fillRect(0.5, 13, 5.5, 3);
    ctx.fillStyle = PAL.pink; ctx.fillRect(-6.5, 3.5, 13, 6);
    // vibrant Miami surf tee
    rr(-7.5, -8.5, 15, 14, 3.5); ctx.fillStyle = PAL.teal; ctx.fill();
    ctx.strokeStyle = '#14032E'; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.fillStyle = '#FFF4FA'; ctx.fillRect(-7, -3, 14, 2.4);
    ctx.fillStyle = '#FFD166'; ctx.fillRect(-7, -0.5, 14, 1.8);
    // head & neon beach visor
    circle(0, -13.5, 6.2, '#FFD0A6', '#14032E', 1.3);
    ctx.fillStyle = PAL.pink; ctx.fillRect(-7.5, -18, 15, 3.8); ctx.fillRect(1, -16.2, 9.5, 2.6);
    circle(-2, -12, 1.1, '#14032E'); circle(2.5, -12, 1.1, '#14032E');
    // glowing icy Thirsty Beaches drink cup held high
    ctx.fillStyle = '#FFD0A6'; ctx.fillRect(5, -5.5, 6, 3.2);
    ctx.beginPath(); ctx.moveTo(8, -21); ctx.lineTo(17, -21); ctx.lineTo(15.2, -4); ctx.lineTo(9.8, -4); ctx.closePath();
    ctx.fillStyle = 'rgba(255,244,250,0.96)'; ctx.fill();
    ctx.strokeStyle = '#14032E'; ctx.lineWidth = 1.2; ctx.stroke();
    const fh = 14.5 * clamp(frac, 0, 1);
    ctx.beginPath(); ctx.moveTo(10, -5 - fh); ctx.lineTo(15, -5 - fh); ctx.lineTo(14.8, -5); ctx.lineTo(10.2, -5); ctx.closePath();
    ctx.fillStyle = frac > 0.35 ? PAL.pink : '#FF9B6B'; ctx.fill();
    ctx.strokeStyle = PAL.teal; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(13.5, -21); ctx.lineTo(16, -26.5); ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;
    if (g.shield) {
      ctx.save();
      ctx.shadowColor = '#FFD166'; ctx.shadowBlur = 12;
      ctx.strokeStyle = 'rgba(255,209,102,0.98)'; ctx.lineWidth = 2.6;
      ctx.beginPath(); ctx.ellipse(cx, cy - lift - 2, 18, 22, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(255,209,102,0.16)'; ctx.fill();
      ctx.restore();
    }
    if (g.freeze > 0 && !reduced) { /* frost on the board is drawn in drawFreeze */ }
  }
  function drawSpill(cx, cy, t, time) {
    const k = clamp(t / DROP_TIME, 0, 1);
    ellipse(cx, cy + 13, 8 + 10 * Math.min(1, k * 3), 3 + 3 * Math.min(1, k * 3), 'rgba(255,60,172,0.75)');
    ctx.save(); ctx.translate(cx, cy);
    ctx.fillStyle = PAL.teal; rr(-6, -4, 12, 16, 3); ctx.fill();
    ctx.fillStyle = '#FFF4FA'; ctx.fillRect(-6, 2, 12, 2.5);
    circle(0, -10, 6, '#FFD0A6'); ctx.fillStyle = PAL.pink; ctx.fillRect(-7, -14.5, 14, 3.5);
    ctx.strokeStyle = '#14032E'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(-3, -11); ctx.lineTo(-1, -9); ctx.moveTo(-1, -11); ctx.lineTo(-3, -9); ctx.moveTo(2, -11); ctx.lineTo(4, -9); ctx.moveTo(4, -11); ctx.lineTo(2, -9); ctx.stroke();
    ctx.restore();
    ctx.save(); ctx.translate(cx + 16 + k * 10, cy + 8 - Math.sin(k * Math.PI) * 10);
    ctx.rotate(k * 3); ctx.fillStyle = 'rgba(255,244,250,0.95)'; ctx.fillRect(-4, -6, 8, 12); ctx.restore();
  }

  function drawText(text, x, y, size, fill, stroke) {
    ctx.font = size + 'px Bungee, "Arial Black", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(3, size / 5); ctx.strokeStyle = stroke || '#14032E';
    ctx.strokeText(text, x, y); ctx.fillStyle = fill; ctx.fillText(text, x, y);
  }

  function render(time) {
    if (!g) {
      // idle backdrop: a sample board so the cabinet is never blank
      g = createGame({ seed: fixedSeed != null ? fixedSeed : 20261119 });
      g.idle = true;
    }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    if (shake > 0 && !reduced) ctx.translate((Math.random() - 0.5) * 6 * (shake / 0.3), (Math.random() - 0.5) * 6 * (shake / 0.3));
    ctx.textBaseline = 'alphabetic';
    drawBackground(time);
    drawWaves(time);
    const lvl = g.lvl;
    // walls and pickups sit under the traffic
    for (let r = 0; r < ROWS; r++) {
      const R = lvl.rows[r];
      if (R.kind === 'sand') for (let c = 0; c < COLS; c++) if (R.walls[c]) drawSandcastle(c, r);
    }
    for (const pk of g.d.pickups) if (!pk.taken) drawPickup(pk, time);
    drawCustomer(g.d, time);
    // traffic and crabs
    for (let r = 0; r < ROWS; r++) {
      const R = lvl.rows[r];
      const cy = rowTop(r) + T / 2;
      if (R.kind === 'board') {
        for (let i = 0; i < R.n; i++) {
          const x = entityX(R, i, g.tT);
          if (x > COLS + 0.1 || x + R.w < -0.1) continue;
          DRAWERS[R.type]((x + R.w / 2) * T, cy, R.dir, time, i);
        }
      } else if (R.kind === 'sand') {
        R.crabs.forEach((crab, i) => drawCrab(crabX(crab, g.tT) * T, cy, time, i));
      }
    }
    for (let r = 0; r < ROWS; r++) if (lvl.rows[r].kind === 'board' && lvl.rows[r].umbrella) drawUmbrella(lvl.rows[r], r, time);
    if (g.freeze > 0) {
      ctx.fillStyle = 'rgba(160,255,250,0.14)'; ctx.fillRect(0, rowTop(ROWS - 1) + T, W, rowTop(0) - rowTop(ROWS - 1) - T);
      ctx.strokeStyle = 'rgba(200,255,252,0.5)'; ctx.lineWidth = 1;
      for (let i = 0; i < 12; i++) { const x = noise(i, 2) * W, y = SEA + T + noise(2, i) * (H - SEA - T * 2); ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y); ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5); ctx.stroke(); }
    }
    if (!g.idle) drawRunner(time);
    else drawIdleRunner(time);
    for (const p of particles) {
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1); ctx.fillStyle = p.c; ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
    }
    ctx.globalAlpha = 1;
    for (const p of popups) drawText(p.text, p.x, p.y - p.age * 26, 16, p.color);
    if (!g.idle && g.p.state === 'delivered' && g.banner) {
      rr(W / 2 - 128, H / 2 - 66, 256, 130, 16); ctx.fillStyle = 'rgba(20,3,46,0.78)'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = PAL.teal; ctx.stroke();
      drawText(g.banner.melted ? 'DELIVERED' : 'DELIVERED!', W / 2, H / 2 - 30, 30, PAL.gold);
      drawText('+' + g.banner.total, W / 2, H / 2 + 6, 34, PAL.teal);
      drawText(g.banner.melted ? 'a little melted' : 'speed tip +' + g.banner.tip, W / 2, H / 2 + 40, 15, PAL.foam);
    }
    if (!g.idle && !g.over && g.p.state === 'dropped') drawText('OOPS!', W / 2, H / 2, 30, PAL.pink);
    ctx.restore();
  }
  function drawIdleRunner(time) {
    const cx = (START_COL + 0.5) * T, cy = tileCy(0);
    ellipse(cx, cy + 15, 11, 3.5, 'rgba(0,0,0,0.35)');
    ctx.save(); ctx.translate(cx, cy - (reduced ? 0 : Math.abs(Math.sin(time * 3)) * 3));
    ctx.fillStyle = '#E8A87C'; ctx.fillRect(-5, 8, 4, 7); ctx.fillRect(1, 8, 4, 7);
    ctx.fillStyle = PAL.pink; ctx.fillRect(-6, 4, 12, 6);
    ctx.fillStyle = PAL.teal; rr(-7, -8, 14, 14, 3); ctx.fill();
    circle(0, -13, 6, '#FFD0A6'); ctx.fillStyle = PAL.pink; ctx.fillRect(-7, -17.5, 14, 3.5);
    ctx.beginPath(); ctx.moveTo(8, -20); ctx.lineTo(16, -20); ctx.lineTo(14.5, -4); ctx.lineTo(9.5, -4); ctx.closePath(); ctx.fillStyle = 'rgba(255,244,250,0.95)'; ctx.fill();
    ctx.fillStyle = PAL.pink; ctx.fillRect(9.7, -17, 4.6, 12);
    ctx.restore();
  }

  /* ---------------- boot ---------------- */
  paintHud();
  fit();
  showOverlay('Boardwalk Dash', 'Carry the drink from the trailer to the customer on the towel before it melts. Tap the arrow buttons, or swipe the board, to hop.', 'Start', false);
  ovBest.textContent = best > 0 ? 'Best ' + best : '';
  ovBest.hidden = best <= 0;
  render(performance.now() / 1000);

  // Test hook: lets the page tests drive the same game object the player sees.
  root.BoardwalkDash.getGame = function () { return g; };
  root.BoardwalkDash.getMode = function () { return mode; };
})(typeof window !== 'undefined' ? window : globalThis);
