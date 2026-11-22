/* Thirsty Beaches: Soft Serve Stacker. A one-tap, play-for-fun stacking game for the website.
   Kiosk copy: a finished game asks the kiosk server for ONE prize roll (kgame.js); nothing about the score is ever sent, and there are no external network calls. The only storage is the
   player's own best scoop count in localStorage (try/catch). Sound is Web Audio synth blips, created on the first gesture.
   All page text is set with textContent. The first half of this file is pure, exported game math (unit tested in node);
   the second half is the canvas game, which only runs in a browser. */
(function (root) {
  'use strict';

  /* ---------- Board and tuning (logical units; the canvas scales these to any screen) ---------- */
  const W = 360;              // board width
  const H = 600;              // board height
  const GROUND_Y = 520;       // sand line on screen when the camera is at rest
  const RIM_Y = 104;          // world height of the cone / cup rim
  const LH = 24;              // vertical step between layers
  const PILL_H = 32;          // drawn height of one swirl layer (overlaps the one below)
  let START_W = 150;          // starting layer width (also the widest a layer can regrow to). The tuned values (START_W ... WIND_DRIFT, the slider speeds) come from TUNING below.
  const SLIDER_Y = 150;       // screen y of the bottom of the sliding layer
  const CAM_LEAD = 230;       // the camera keeps the tower top this far above the sand line once it scrolls
  let MIN_OVERLAP = 8;      // less overlap than this and the tower topples
  let TOL_EARLY = 8;        // perfect window for the first layers (kind to small hands)
  let TOL = 6;                // perfect window afterwards
  let EARLY_LAYERS = 5;
  let REGROW = 16;            // width given back by a perfect streak
  const STREAK_FOR_REGROW = 3;
  let WIND_START = 7;         // first layer that can meet a sea breeze
  let WIND_PERIOD = 11;     // a breeze block repeats every 11 layers
  const WIND_LEN = 3;         // and lasts 3 layers
  let WIND_DRIFT = 7;         // how far a breeze nudges a dropped layer
  const TOP_W = 34;           // width of a topping on its slider
  const TOP_EVERY = 10;       // topping round every 10 layers

  const FLAVORS = ['vanilla', 'pineapple', 'strawberry', 'chocolate'];
  const TOPPINGS = ['cherry', 'sprinkles', 'umbrella'];
  const TOPPING_LABEL = { cherry: 'Cherry', sprinkles: 'Sprinkles', umbrella: 'Little Umbrella' };

  const RANKS = [
    { min: 0, title: 'Beach Newbie' },
    { min: 4, title: 'Kiddie Cone' },
    { min: 8, title: 'Single Scoop' },
    { min: 13, title: 'Double Dip' },
    { min: 19, title: 'Triple Swirl' },
    { min: 26, title: 'Pier Pro' },
    { min: 35, title: 'Boardwalk Legend' },
    { min: 50, title: 'Sunset Cone King' },
  ];

  /* ---------- Pure helpers ---------- */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ---------- difficulty: two tables, one switch ----------
     `classic` is the v48 tuning exactly. `arcade86` is the harder 1986 arcade pace. gameDifficulty in kiosk/arcade-session.json picks one (the shared shell reads it, TBK.difficulty());
     setDifficulty() is called once when a run starts, so a run never changes table mid-game. Nothing else differs between the two modes. */
  const TUNING = {
    classic: { START_W: 150, MIN_OVERLAP: 8, TOL_EARLY: 8, TOL: 6, EARLY_LAYERS: 5, REGROW: 16, WIND_START: 7, WIND_PERIOD: 11, WIND_DRIFT: 7,
      slow: [62, 68, 74, 80], speedBase: 80, speedPer: 4.2, speedMax: 235 },
    arcade86: { START_W: 132, MIN_OVERLAP: 14, TOL_EARLY: 5.5, TOL: 4, EARLY_LAYERS: 4, REGROW: 10, WIND_START: 5, WIND_PERIOD: 8, WIND_DRIFT: 11,
      slow: [105, 118, 132, 146], speedBase: 146, speedPer: 9.5, speedMax: 310 }
  };
  let TUNE = TUNING.classic;
  function setDifficulty(mode) {
    TUNE = Object.prototype.hasOwnProperty.call(TUNING, mode) ? TUNING[mode] : TUNING.classic;
    START_W = TUNE.START_W; MIN_OVERLAP = TUNE.MIN_OVERLAP; TOL_EARLY = TUNE.TOL_EARLY; TOL = TUNE.TOL; EARLY_LAYERS = TUNE.EARLY_LAYERS; REGROW = TUNE.REGROW;
    WIND_START = TUNE.WIND_START; WIND_PERIOD = TUNE.WIND_PERIOD; WIND_DRIFT = TUNE.WIND_DRIFT;
    return TUNE === TUNING.arcade86 ? 'arcade86' : 'classic';
  }

  /* Slide speed in units per second for the layer about to be dropped. The first four are slow so a small kid stacks several
     scoops; after that it climbs gently and stops at a ceiling so it stays fair. */
  function speedFor(layer) {
    const n = Math.max(0, Math.floor(Number(layer) || 0));
    const slow = TUNE.slow;
    if (n < slow.length) return slow[n];
    return Math.min(TUNE.speedMax, TUNE.speedBase + TUNE.speedPer * (n - 3));
  }

  /* Where the slider is after `elapsed` seconds: a triangle wave between minX and maxX, entering from the left or the right. */
  function sliderX(elapsed, speed, minX, maxX, fromRight) {
    const range = maxX - minX;
    if (!(range > 0)) return minX;
    const m = (Math.max(0, elapsed) * speed) % (2 * range);
    const p = m < range ? m : 2 * range - m;
    return fromRight ? maxX - p : minX + p;
  }

  function perfectTol(layer) { return layer < EARLY_LAYERS ? TOL_EARLY : TOL; }

  /* The core trim: `top` is the layer being landed on, `piece` is where the new layer arrives (already including wind drift).
     perfect: within tol, snaps to the layer below and keeps its full width.
     trim: the overlap stays, the overhang slides off. miss: not enough overlap, the tower topples. */
  function resolveDrop(top, piece, tol) {
    const topL = top.left, topR = top.left + top.width;
    const pL = piece.left, pR = piece.left + piece.width;
    const dx = pL - topL;
    if (Math.abs(dx) <= tol) {
      return { kind: 'perfect', left: topL, width: piece.width, overhang: null, offset: dx };
    }
    const overlap = Math.min(pR, topR) - Math.max(pL, topL);
    if (overlap < MIN_OVERLAP) {
      return { kind: 'miss', left: pL, width: piece.width, overhang: null, offset: dx, side: dx < 0 ? 'left' : 'right' };
    }
    const left = Math.max(pL, topL);
    if (dx < 0) {
      return { kind: 'trim', left, width: overlap, overhang: { side: 'left', left: pL, width: topL - pL }, offset: dx };
    }
    return { kind: 'trim', left, width: overlap, overhang: { side: 'right', left: topR, width: pR - topR }, offset: dx };
  }

  function streakAfter(streak, kind) { return kind === 'perfect' ? streak + 1 : 0; }
  function shouldRegrow(streak) { return streak > 0 && streak % STREAK_FOR_REGROW === 0; }

  /* Give width back, split on both sides, never wider than the start width and never off the board. */
  function regrow(layer, amount, maxWidth, boardWidth) {
    const width = Math.min(maxWidth, layer.width + amount);
    const grown = width - layer.width;
    const left = clamp(layer.left - grown / 2, 0, boardWidth - width);
    return { left, width };
  }

  function flavorFor(layer) {
    const n = Math.max(0, Math.floor(layer));
    return n % 7 === 6 ? 'rainbow' : FLAVORS[n % FLAVORS.length];
  }

  /* Score for one landed layer. A perfect is worth double a trim and a streak adds up to +25; rainbow doubles the lot. */
  function scoreForDrop(opts) {
    const kind = opts && opts.kind;
    if (kind !== 'perfect' && kind !== 'trim') return 0;
    let pts = kind === 'perfect' ? 20 + 5 * Math.min(Math.max((opts.streak || 1) - 1, 0), 5) : 10;
    if (opts.rainbow) pts *= 2;
    return pts;
  }

  /* A topping round comes up when the scoop count reaches 10, 20, 30... */
  function isToppingRound(scoops) { return scoops > 0 && scoops % TOP_EVERY === 0; }
  function toppingFor(scoops) { return TOPPINGS[(Math.floor(scoops / TOP_EVERY) - 1 + TOPPINGS.length * 100) % TOPPINGS.length]; }

  /* A topping lands when its centre is over the top layer (a few units of forgiveness); dead centre earns the bigger bonus. */
  function landTopping(top, centerX) {
    const slack = 4;
    const landed = centerX >= top.left - slack && centerX <= top.left + top.width + slack;
    const mid = top.left + top.width / 2;
    const centered = landed && Math.abs(centerX - mid) <= Math.max(6, top.width * 0.2);
    return { landed, centered, bonus: !landed ? 0 : centered ? 60 : 30 };
  }

  /* Sea breeze forecast: -1 pushes left, 1 pushes right, 0 is calm. Deterministic per seed so the sock can be trusted. */
  function windForLayer(layer, seed) {
    if (layer < WIND_START) return 0;
    const n = layer - WIND_START;
    if (n % WIND_PERIOD >= WIND_LEN) return 0;
    const block = Math.floor(n / WIND_PERIOD);
    const h = Math.imul((block + 1) * 2654435761 ^ Math.imul((seed | 0) + 12345, 40503), 2246822519) >>> 0;
    return (h >>> 13) & 1 ? 1 : -1;
  }
  function applyWind(x, wind) { return x + wind * WIND_DRIFT; }

  function rankFor(scoops) {
    let title = RANKS[0].title;
    for (const r of RANKS) if (scoops >= r.min) title = r.title;
    return title;
  }

  /* Blip pitch rises with height along a major pentatonic scale, a few octaves, then holds. */
  function noteFreq(scoops) {
    const idx = Math.min(17, Math.max(0, Math.floor(scoops)));
    const steps = [0, 2, 4, 7, 9];
    const semis = steps[idx % 5] + 12 * Math.floor(idx / 5);
    return 196 * Math.pow(2, semis / 12);
  }

  /* Camera: once the tower top climbs above the lead line, scroll so it stays there. */
  function cameraTarget(topWorld) { return Math.max(0, topWorld - CAM_LEAD); }
  function layerWorldY(index) { return RIM_Y - 4 + index * LH; }

  function mixColor(a, b, t) {
    const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
    const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
    return 'rgb(' + pa.map((v, i) => Math.round(lerp(v, pb[i], t))).join(',') + ')';
  }

  const api = {
    W, H, GROUND_Y, RIM_Y, LH, STREAK_FOR_REGROW, TOP_EVERY, TOP_W, TUNING, setDifficulty, difficultyMode: () => (TUNE === TUNING.arcade86 ? 'arcade86' : 'classic'),
    get START_W() { return START_W; }, get MIN_OVERLAP() { return MIN_OVERLAP; }, get WIND_START() { return WIND_START; }, get TOL() { return TOL; }, get TOL_EARLY() { return TOL_EARLY; },
    get REGROW() { return REGROW; }, get WIND_DRIFT() { return WIND_DRIFT; },
    FLAVORS, TOPPINGS, TOPPING_LABEL, RANKS,
    speedFor, sliderX, perfectTol, resolveDrop, streakAfter, shouldRegrow, regrow, flavorFor, scoreForDrop,
    isToppingRound, toppingFor, landTopping, windForLayer, applyWind, rankFor, noteFreq, cameraTarget, layerWorldY, mixColor,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SoftServeStacker = api;
  if (typeof document === 'undefined') return;

  /* ====================================================================================================================
     Browser game
     ==================================================================================================================== */
  const BEST_KEY = 'tb_soft_serve_stacker_best_v1';
  const SOUND_KEY = 'tb_soft_serve_stacker_sound_v1';

  const COLORS = {
    vanilla: { light: '#FFF8E1', base: '#FCE8B8', shade: '#DDB872' },
    pineapple: { light: '#FFF59A', base: '#FFD93B', shade: '#E39A12' },
    strawberry: { light: '#FFC4DB', base: '#FF7FB0', shade: '#D4407F' },
    chocolate: { light: '#B97C55', base: '#7A4326', shade: '#47210F' },
  };
  const RAINBOW = ['#FF3CAC', '#FFD166', '#2AF5E4', '#8A3FFC', '#FF3CAC'];

  const $ = (id) => document.getElementById(id);
  const canvas = $('stage');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const board = $('board');
  const el = {
    scoops: $('hudScoops'), score: $('hudScore'), best: $('hudBest'),
    start: $('overlayStart'), over: $('overlayOver'), pause: $('overlayPause'),
    btnStart: $('btnStart'), btnAgain: $('btnAgain'), btnResume: $('btnResume'),
    btnSound: $('btnSound'), btnPause: $('btnPause'),
    overRank: $('overRank'), overScoops: $('overScoops'), overScore: $('overScore'), overBest: $('overBest'), overNew: $('overNew'),
    live: $('srStatus'),
  };

  const mqReduce = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = !!(mqReduce && mqReduce.matches);
  if (mqReduce && mqReduce.addEventListener) mqReduce.addEventListener('change', (e) => { reduced = e.matches; render(); });

  function loadBest() { try { const v = parseInt(root.localStorage.getItem(BEST_KEY), 10); return v > 0 ? v : 0; } catch (e) { return 0; } }
  function saveBest(v) { try { root.localStorage.setItem(BEST_KEY, String(v)); } catch (e) { /* private mode: best just lasts this visit */ } }
  function loadSound() { try { return root.localStorage.getItem(SOUND_KEY) !== 'off'; } catch (e) { return true; } }
  function saveSound(on) { try { root.localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch (e) { /* ignore */ } }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- State ---------- */
  const g = {
    phase: 'idle',            // idle | playing | paused | toppling | over
    seed: 1, rng: Math.random,
    base: { left: (W - START_W) / 2, width: START_W, kind: 'cone' },
    layers: [], scoops: 0, score: 0, best: loadBest(), streak: 0, newBest: false, toppingDoneAt: -1,
    piece: null, wind: 0, windBanner: -1,
    cam: 0, camT: 0, time: 0, sway: 0,
    chunks: [], splats: [], parts: [], rings: [], floaters: [], drops: [],
    flash: 0, shake: 0, topple: null, overAt: 0,
  };
  let scale = 1;              // css px per logical unit
  let dpr = 1;
  let raf = 0;
  let lastTs = 0;
  let soundOn = loadSound();
  // the beach music follows this Sound setting; a mute chosen on another game page in this visit carries here (shared/beach-music.js)
  if (root.TBMusic) { if (root.TBMusic.isMuted()) soundOn = false; else root.TBMusic.setMuted(!soundOn); }
  let ac = null;
  let layoutW = 0;

  const sy = (worldY, f) => GROUND_Y + g.cam * (f === undefined ? 1 : f) - worldY;
  const topLayer = () => (g.layers.length ? g.layers[g.layers.length - 1] : g.base);
  const topSurfaceWorld = () => (g.layers.length ? g.layers[g.layers.length - 1].y + PILL_H - 5 : RIM_Y);

  /* ---------- Sound (synth only, silent until a gesture) ---------- */
  function unlockAudio() {
    if (!ac) {
      try { const AC = root.AudioContext || root.webkitAudioContext; if (AC) ac = new AC(); } catch (e) { ac = null; }
    }
    if (ac && ac.state === 'suspended') { try { ac.resume(); } catch (e) { /* ignore */ } }
  }
  function blip(freq, dur, type, vol, toFreq, delay) {
    if (!soundOn || !ac || ac.state !== 'running') return;
    try {
      const t0 = ac.currentTime + (delay || 0);
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = type || 'square';
      osc.frequency.setValueAtTime(freq, t0);
      if (toFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, toFreq), t0 + dur);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol || 0.08, t0 + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain); gain.connect(ac.destination);
      osc.start(t0); osc.stop(t0 + dur + 0.03);
    } catch (e) { /* audio is optional */ }
  }
  const sfx = {
    land: (n) => blip(noteFreq(n), 0.09, 'square', 0.07),
    perfect: (n) => { const f = noteFreq(n); blip(f, 0.08, 'square', 0.07); blip(f * 1.5, 0.12, 'triangle', 0.09, null, 0.06); blip(f * 2, 0.16, 'triangle', 0.08, null, 0.13); },
    trim: (n) => { blip(noteFreq(n), 0.08, 'square', 0.06); blip(noteFreq(0) * 0.8, 0.12, 'triangle', 0.08, 90, 0.03); },
    topping: (n) => { const f = noteFreq(n); [1, 1.25, 1.5, 2].forEach((m, i) => blip(f * m, 0.1, 'square', 0.06, null, i * 0.07)); },
    toppingMiss: () => blip(330, 0.2, 'triangle', 0.07, 140),
    breeze: () => blip(520, 0.35, 'sine', 0.035, 380),
    topple: () => { blip(420, 0.8, 'sawtooth', 0.07, 55); blip(210, 0.9, 'triangle', 0.07, 40, 0.1); },
    start: () => { [262, 330, 392].forEach((f, i) => blip(f, 0.09, 'square', 0.06, null, i * 0.07)); },
  };

  /* ---------- HUD, overlays, announcements ---------- */
  function setText(node, v) { if (node && node.textContent !== String(v)) node.textContent = String(v); }
  function updateHud() { setText(el.scoops, g.scoops); setText(el.score, g.score); setText(el.best, g.best); }
  function say(msg) { if (el.live) el.live.textContent = msg; }
  function showOverlay(which) {
    el.start.hidden = which !== 'start';
    el.over.hidden = which !== 'over';
    el.pause.hidden = which !== 'pause';
    board.classList.toggle('is-covered', !!which);
  }
  function setSoundButton() {
    el.btnSound.textContent = soundOn ? 'Sound On' : 'Sound Off';
    el.btnSound.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
  }

  /* ---------- Layout ---------- */
  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    dpr = Math.min(3, Math.max(1, root.devicePixelRatio || 1));
    const cw = Math.round(r.width * dpr), ch = Math.round(r.width * (H / W) * dpr);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    scale = r.width / W;
    layoutW = r.width;
    render();
  }

  /* ---------- Game flow ---------- */
  function newGame() {
    g.seed = (Math.random() * 1e9) | 0;
    g.rng = mulberry32(g.seed);
    g.base = { left: (W - START_W) / 2, width: START_W, kind: g.rng() < 0.5 ? 'cone' : 'cup' };
    g.layers = []; g.scoops = 0; g.score = 0; g.streak = 0; g.newBest = false; g.toppingDoneAt = -1;
    g.cam = 0; g.camT = 0; g.sway = 0; g.wind = 0; g.windBanner = -1;
    g.chunks = []; g.splats = []; g.parts = []; g.rings = []; g.floaters = []; g.drops = [];
    g.flash = 0; g.shake = 0; g.topple = null;
    spawnPiece();
    updateHud();
  }

  function spawnPiece() {
    const n = g.scoops;
    const top = topLayer();
    const wind = windForLayer(n, g.seed);
    if (wind !== 0 && g.windBanner !== Math.floor((n - WIND_START) / WIND_PERIOD)) {
      g.windBanner = Math.floor((n - WIND_START) / WIND_PERIOD);
      addFloater('SEA BREEZE ' + (wind > 0 ? '>>' : '<<'), W / 2, 98, '#2AF5E4', 1.8);
      sfx.breeze();
      say('Sea breeze. The wind sock shows which way it pushes.');
    }
    g.wind = wind;
    let piece;
    if (isToppingRound(n) && g.toppingDoneAt !== n) {
      piece = { kind: 'topping', id: toppingFor(n), width: TOP_W, speed: Math.min(235, speedFor(n) * 1.12) };
      addFloater('TOPPING ROUND!', W / 2, 98, '#FFD166', 1.6);
      say('Topping round. Drop the ' + TOPPING_LABEL[piece.id] + ' onto the tower.');
    } else {
      const flavor = flavorFor(n);
      piece = { kind: 'layer', flavor, rainbow: flavor === 'rainbow', width: top.width, speed: speedFor(n) };
    }
    piece.min = 0; piece.max = W - piece.width; piece.fromRight = g.rng() < 0.5; piece.t = 0;
    g.piece = piece;
  }

  function pieceX() { const p = g.piece; return sliderX(p.t, p.speed, p.min, p.max, p.fromRight); }

  function startGame() {
    unlockAudio();
    setDifficulty(root.TBK && typeof root.TBK.difficulty === 'function' ? root.TBK.difficulty() : 'classic');   // the table is fixed for this whole run
    newGame();
    g.phase = 'playing';
    showOverlay(null);
    root.scrollTo(0, 0);
    document.body.classList.add('is-playing');
    sfx.start();
    say('Game on. Tap to drop each scoop.');
    if (root.TBK) root.TBK.runStart('soft-serve-stacker');
    try { board.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    ensureLoop();
  }

  function pauseGame() {
    if (g.phase !== 'playing') return;
    g.phase = 'paused';
    if (root.TBMusic) root.TBMusic.setPaused(true);
    showOverlay('pause');
    document.body.classList.remove('is-playing');
    render();
  }
  function resumeGame() {
    if (g.phase !== 'paused') return;
    g.phase = 'playing';
    if (root.TBMusic) root.TBMusic.setPaused(false);
    showOverlay(null);
    document.body.classList.add('is-playing');
    try { board.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    ensureLoop();
  }

  function addFloater(text, x, y, color, dur) { g.floaters.push({ text, x, y, color, t: 0, dur: dur || 1.1 }); }

  function burst(x, y, colors, n, power) {
    if (reduced) return;
    for (let i = 0; i < n && g.parts.length < 120; i++) {
      const a = Math.random() * Math.PI * 2, s = (0.35 + Math.random() * 0.65) * power;
      g.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - power * 0.25, life: 0, max: 0.55 + Math.random() * 0.5, c: colors[(Math.random() * colors.length) | 0], r: 1.6 + Math.random() * 2.2 });
    }
  }

  function drop() {
    if (g.phase !== 'playing' || !g.piece) return;
    const p = g.piece;
    const x = pieceX();
    if (p.kind === 'topping') { dropTopping(p, x); return; }

    const top = topLayer();
    const n = g.scoops;
    const left = applyWind(x, g.wind);
    const res = resolveDrop(top, { left, width: p.width }, perfectTol(n));
    const fromWorldY = GROUND_Y + g.cam - SLIDER_Y;

    if (res.kind === 'miss') { startTopple({ left, width: p.width, flavor: p.flavor, rainbow: p.rainbow, y: layerWorldY(n), fromWorldY }, res.side === 'left' ? -1 : 1); return; }

    g.streak = streakAfter(g.streak, res.kind);
    let layer = { left: res.left, width: res.width, flavor: p.flavor, rainbow: p.rainbow, y: layerWorldY(n), topping: null };
    let regrown = false;
    if (res.kind === 'perfect' && shouldRegrow(g.streak) && layer.width < START_W) {
      const grown = regrow(layer, REGROW, START_W, W);
      layer.left = grown.left; layer.width = grown.width; regrown = true;
    }
    const pts = scoreForDrop({ kind: res.kind, streak: g.streak, rainbow: p.rainbow });
    g.score += pts;
    g.scoops += 1;
    layer.anim = {
      t: 0, dur: reduced ? 0.05 : 0.13, fromX: x, fromWorldY,
      full: { left, width: p.width }, overhang: res.overhang, kind: res.kind, pts, regrown, streak: g.streak,
    };
    g.layers.push(layer);
    if (res.kind === 'perfect') sfx.perfect(g.scoops); else if (res.overhang && res.overhang.width > 14) sfx.trim(g.scoops); else sfx.land(g.scoops);
    g.camT = cameraTarget(topSurfaceWorld());
    updateHud();
    spawnPiece();
  }

  function dropTopping(p, x) {
    const top = topLayer();
    const cx = applyWind(x + p.width / 2, g.wind);
    const res = landTopping(top, cx);
    const fromWorldY = GROUND_Y + g.cam - SLIDER_Y + 14;
    g.toppingDoneAt = g.scoops;
    if (res.landed) {
      const layer = g.layers[g.layers.length - 1];
      const tx = clamp(cx, top.left + 4, top.left + top.width - 4);
      g.drops.push({ id: p.id, x0: x + p.width / 2, y0: fromWorldY, x1: tx, y1: layer.y + PILL_H - 5, t: 0, dur: reduced ? 0.05 : 0.16, res, layer });
      g.score += res.bonus;
      sfx.topping(g.scoops);
      updateHud();
    } else {
      g.chunks.push({ kind: 'topping', id: p.id, x: cx, y: fromWorldY, w: p.width, h: 24, vx: (cx < top.left ? -1 : 1) * 55, vy: 40, rot: 0, vr: (cx < top.left ? -1 : 1) * 3, life: 0 });
      addFloater('Off it goes!', cx, sy(topSurfaceWorld()) - 30, '#FFF4FA', 1.1);
      sfx.toppingMiss();
    }
    spawnPiece();
  }

  /* A finished landing: ring and sparkles, the overhang slides off, score pops. */
  function onLand(layer) {
    const a = layer.anim;
    layer.anim = null;
    const cx = layer.left + layer.width / 2;
    const topY = sy(layer.y + PILL_H / 2);
    if (a.overhang && a.overhang.width > 0.5) {
      const o = a.overhang;
      g.chunks.push({
        kind: 'layer', x: o.left + o.width / 2, y: layer.y + PILL_H / 2, w: o.width, h: PILL_H, flavor: layer.flavor, rainbow: layer.rainbow,
        vx: (o.side === 'left' ? -1 : 1) * (28 + Math.random() * 24), vy: 20, rot: 0, vr: (o.side === 'left' ? -1 : 1) * (1.4 + Math.random()), life: 0,
      });
    }
    if (a.kind === 'perfect') {
      const label = a.streak >= 2 ? 'PERFECT x' + a.streak : 'PERFECT!';
      addFloater(label, cx, topY - 24, '#FFD166', 1.1);
      if (layer.rainbow) addFloater('RAINBOW x2', cx, topY - 48, '#FF3CAC', 1.1);
      if (a.regrown) addFloater('LAYER GREW BACK!', cx, topY - (layer.rainbow ? 72 : 48), '#2AF5E4', 1.3);
      g.rings.push({ x: cx, y: layer.y + PILL_H / 2, w: layer.width, t: 0 });
      g.flash = reduced ? 0 : 1;
      burst(cx, topY, ['#FFD166', '#FF3CAC', '#2AF5E4', '#FFF4FA'], 14, 150);
      say('Perfect. ' + g.scoops + ' scoops.');
    } else {
      if (!reduced) g.shake = Math.min(3, 1 + (a.overhang ? a.overhang.width / 40 : 0));
      addFloater('+' + a.pts, cx, topY - 18, layer.rainbow ? '#FF3CAC' : '#FFF4FA', 0.8);
      burst(cx, topY, ['#FFF4FA', COLORS[layer.flavor] ? COLORS[layer.flavor].base : '#FFD166'], 5, 80);
    }
    if (layer.rainbow && a.kind !== 'perfect') addFloater('RAINBOW x2', cx, topY - 42, '#FF3CAC', 1.1);
  }

  function startTopple(piece, dir) {
    g.phase = 'toppling';
    g.piece = null;
    g.wind = 0;
    g.topple = { t: 0, dir, stage: 0, angle: 0 };
    g.chunks.push({ kind: 'layer', x: piece.left + piece.width / 2, y: piece.fromWorldY, w: piece.width, h: PILL_H, flavor: piece.flavor, rainbow: piece.rainbow, vx: dir * 20, vy: 0, rot: 0, vr: dir * 0.9, life: 0 });
    sfx.topple();
    finalizeScore();
    document.body.classList.remove('is-playing');
    if (reduced) { g.topple.stage = 2; finishOver(); } else g.shake = 7;
  }

  function finalizeScore() {
    if (g.scoops > g.best) { g.best = g.scoops; g.newBest = g.scoops > 0; saveBest(g.best); }
    updateHud();
  }

  function finishOver() {
    g.phase = 'over';
    g.overAt = performance.now();
    setText(el.overRank, rankFor(g.scoops));
    setText(el.overScoops, g.scoops);
    setText(el.overScore, g.score);
    setText(el.overBest, g.best);
    el.overNew.hidden = !g.newBest;
    showOverlay('over');
    say('Tower toppled. ' + g.scoops + ' scoops. Rank: ' + rankFor(g.scoops) + '.');
    if (root.TBK) root.TBK.runEnd();
    render();
    try { el.btnAgain.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  function toppleToDebris() {
    const t = g.topple;
    const px = W / 2, py = RIM_Y;
    const th = t.angle;
    const c = Math.cos(th), s = Math.sin(th);
    for (const L of g.layers) {
      const rx = L.left + L.width / 2 - px, ry = L.y + PILL_H / 2 - py;
      g.chunks.push({
        kind: 'layer', x: px + rx * c + ry * s, y: py - rx * s + ry * c, w: L.width, h: PILL_H, flavor: L.flavor, rainbow: L.rainbow, topping: L.topping ? { id: L.topping.id, dx: L.topping.x - (L.left + L.width / 2) } : null,
        vx: t.dir * (70 + Math.random() * 90), vy: 40 + Math.random() * 90, rot: th, vr: t.dir * (1.5 + Math.random() * 2.5), life: 0,
      });
    }
    g.layers = [];
    g.camT = 0;   // the camera drops back to the cone so the pile lands in the sand
  }

  /* ---------- Update ---------- */
  function update(dt) {
    g.time += dt;
    if (g.phase === 'playing' && g.piece) g.piece.t += dt;

    // camera
    g.cam = reduced ? g.camT : g.cam + (g.camT - g.cam) * Math.min(1, dt * (g.phase === 'toppling' ? 3.2 : 5));
    if (Math.abs(g.camT - g.cam) < 0.05) g.cam = g.camT;

    // sway toward the breeze (visual only)
    const swayTarget = !reduced && g.wind !== 0 && g.phase === 'playing' ? 1 : 0;
    g.sway += (swayTarget - g.sway) * Math.min(1, dt * 1.5);

    // landings
    for (const L of g.layers) {
      if (L.anim) { L.anim.t += dt; if (L.anim.t >= L.anim.dur) onLand(L); }
    }
    for (let i = g.drops.length - 1; i >= 0; i--) {
      const d = g.drops[i];
      d.t += dt;
      if (d.t >= d.dur) {
        d.layer.topping = { id: d.id, x: d.x1 };
        const res = d.res;
        addFloater('+' + res.bonus + ' ' + TOPPING_LABEL[d.id].toUpperCase(), d.x1, sy(d.y1) - 30, '#FFD166', 1.3);
        if (res.centered) addFloater('BULLSEYE!', d.x1, sy(d.y1) - 54, '#2AF5E4', 1.1);
        g.rings.push({ x: d.x1, y: d.y1, w: 40, t: 0 });
        burst(d.x1, sy(d.y1), ['#FF3CAC', '#FFD166', '#2AF5E4'], 12, 130);
        say(TOPPING_LABEL[d.id] + ' landed. Bonus ' + res.bonus + '.');
        g.drops.splice(i, 1);
      }
    }

    // falling chunks and sand splats
    for (let i = g.chunks.length - 1; i >= 0; i--) {
      const c = g.chunks[i];
      c.life += dt;
      c.vy -= 900 * dt;
      c.x += c.vx * dt; c.y += c.vy * dt; c.rot += c.vr * dt;
      if (c.y - c.h / 2 <= 0 && c.life > 0.05) {
        g.splats.push({ x: c.x, w: Math.max(10, c.w), t: 0, color: c.kind === 'layer' ? (c.rainbow ? '#FF7FB0' : COLORS[c.flavor].base) : '#FF4D6D' });
        if (g.splats.length > 36) g.splats.shift();
        burst(c.x, sy(0), ['#F6C27A', '#FFF4FA'], 4, 60);
        g.chunks.splice(i, 1);
      } else if (c.y < -80) {
        g.chunks.splice(i, 1);
      }
    }
    for (const s of g.splats) s.t += dt;

    // particles, rings, floaters
    for (let i = g.parts.length - 1; i >= 0; i--) {
      const p = g.parts[i];
      p.life += dt; p.vy += 520 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.life >= p.max) g.parts.splice(i, 1);
    }
    for (let i = g.rings.length - 1; i >= 0; i--) { g.rings[i].t += dt; if (g.rings[i].t > 0.5) g.rings.splice(i, 1); }
    for (let i = g.floaters.length - 1; i >= 0; i--) { g.floaters[i].t += dt; if (g.floaters[i].t >= g.floaters[i].dur) g.floaters.splice(i, 1); }
    g.flash = Math.max(0, g.flash - dt * 4);
    g.shake = Math.max(0, g.shake - dt * 18);

    // topple sequence
    if (g.phase === 'toppling' && g.topple) {
      const t = g.topple;
      t.t += dt;
      if (t.stage === 0) {
        t.angle = t.dir * 0.95 * Math.pow(Math.min(1, t.t / 0.55), 2);
        if (t.t >= 0.55) { toppleToDebris(); t.stage = 1; }
      }
      if (t.t >= 1.7 && (g.chunks.length === 0 || t.t >= 2.8)) finishOver();
    }
  }

  function shouldRun() { return g.phase === 'playing' || g.phase === 'toppling'; }
  function frame(ts) {
    raf = 0;
    const dt = Math.min(0.05, Math.max(0, (ts - lastTs) / 1000));
    lastTs = ts;
    update(dt);
    render();
    if (shouldRun()) raf = root.requestAnimationFrame(frame);
  }
  function ensureLoop() {
    if (raf) return;
    lastTs = performance.now();
    raf = root.requestAnimationFrame(frame);
  }

  /* ---------- Local 1986 Miami artwork assets (preloaded, zero network) ---------- */
  const ART = {};
  (function loadArt() {
    [['bg', '/kiosk/games/soft-serve-stacker/assets/bg-miami-pier.webp'],
     ['cone', '/kiosk/games/soft-serve-stacker/assets/cone.png']].forEach(([k, src]) => {
      const im = new Image();
      im.onload = () => { if (layoutW) render(); };
      im.src = src;
      ART[k] = im;
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

  let bgCache = null, bgCacheKey = '';
  function bgSprite() {
    if (!(ART.bg && ART.bg.complete && ART.bg.naturalWidth > 0)) return null;
    const pw = Math.max(1, Math.round(W * scale * dpr)), ph = Math.max(1, Math.round(H * scale * dpr)), key = pw + 'x' + ph;
    if (!bgCache || bgCacheKey !== key) {
      const cv = document.createElement('canvas'); cv.width = pw; cv.height = ph;
      const x = cv.getContext('2d'); if (!x) return null;
      x.drawImage(ART.bg, 0, 0, pw, ph);
      bgCache = cv; bgCacheKey = key;
    }
    return bgCache;
  }

  /* ---------- Drawing ---------- */
  const STARS = (() => { const r = mulberry32(86); return Array.from({ length: 70 }, () => ({ x: r() * W, y: r() * H, r: 0.6 + r() * 1.4, ph: r() * 6.28 })); })();
  const CLOUDS = [
    { x: 40, y: -120, w: 110 }, { x: 250, y: -230, w: 90 }, { x: 120, y: -340, w: 120 },
    { x: 280, y: -450, w: 100 }, { x: 60, y: -560, w: 96 }, { x: 210, y: -690, w: 130 },
  ];
  const GULLS = [
    { x: 70, y: -20, s: 14 }, { x: 250, y: -80, s: -11 }, { x: 160, y: -150, s: 9 },
    { x: 300, y: -230, s: -13 }, { x: 40, y: -300, s: 10 }, { x: 200, y: -380, s: -8 },
  ];

  function pillPath(x, y, w, h) {
    const r = Math.min(h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    ctx.lineTo(x + w, y + h - r);
    ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    ctx.lineTo(x + r, y + h);
    ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    ctx.lineTo(x, y + r);
    ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
    ctx.closePath();
  }

  /* Organic plump scalloped soft-serve ribbon silhouette (looks piped, never a flat pill). */
  function swirlCoilPath(x, y, w, h) {
    const r = Math.min(h * 0.56, w * 0.45);
    const leftX = x - 2, rightX = x + w + 2;
    const midY = y + h * 0.52;
    const botY = y + h + 1.5;
    const topY = y - 1.5;
    ctx.beginPath();
    ctx.moveTo(leftX + r, topY);
    // gentle plump top curve
    const topLobes = Math.max(2, Math.round(w / 32));
    for (let i = 0; i < topLobes; i++) {
      const x0 = leftX + r + ((rightX - leftX - 2 * r) * i) / topLobes;
      const x1 = leftX + r + ((rightX - leftX - 2 * r) * (i + 1)) / topLobes;
      ctx.quadraticCurveTo((x0 + x1) / 2, topY - 2.6, x1, topY);
    }
    // plump bulging right end
    ctx.bezierCurveTo(rightX + 3, topY, rightX + 4, botY, rightX - r, botY);
    // creamy scalloped bottom billows
    const lobes = Math.max(2, Math.round(w / 24));
    for (let i = lobes - 1; i >= 0; i--) {
      const x1 = leftX + r + ((rightX - leftX - 2 * r) * (i + 1)) / lobes;
      const x0 = leftX + r + ((rightX - leftX - 2 * r) * i) / lobes;
      ctx.quadraticCurveTo((x0 + x1) / 2, botY + 3.2, x0, botY - 0.5);
    }
    // plump bulging left end
    ctx.bezierCurveTo(leftX - 4, botY, leftX - 3, topY, leftX + r, topY);
    ctx.closePath();
  }

  /* One swirl layer: lush 3D-shaded sculpted piped soft-serve coil with glossy creamy flutes. */
  function drawSwirl(x, y, w, h, flavor, rainbow) {
    ctx.save();
    // soft dark drop shadow onto the layer below
    ctx.fillStyle = 'rgba(18,2,42,0.38)';
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h + 2.5, Math.max(4, w * 0.48), 5.5, 0, 0, Math.PI * 2);
    ctx.fill();

    swirlCoilPath(x, y, w, h);
    let fill;
    let ridgeDark = 'rgba(46,12,68,0.28)', ridgeLight = 'rgba(255,255,255,0.72)';
    if (rainbow) {
      fill = ctx.createLinearGradient(x, 0, x + Math.max(40, w), 0);
      RAINBOW.forEach((c, i) => fill.addColorStop(i / (RAINBOW.length - 1), c));
      ridgeDark = 'rgba(44,10,74,0.26)';
    } else {
      const c = COLORS[flavor] || COLORS.vanilla;
      fill = ctx.createLinearGradient(0, y - 3, 0, y + h + 4);
      fill.addColorStop(0, '#FFFFFF');
      fill.addColorStop(0.18, c.light);
      fill.addColorStop(0.56, c.base);
      fill.addColorStop(0.88, c.shade);
      fill.addColorStop(1, mixColor(c.shade, '#2D074A', 0.32));
      if (flavor === 'chocolate') ridgeLight = 'rgba(255,226,192,0.44)';
    }
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.save();
    ctx.clip();
    if (rainbow) {
      const sh = ctx.createLinearGradient(0, y - 2, 0, y + h + 3);
      sh.addColorStop(0, 'rgba(255,255,255,0.55)'); sh.addColorStop(0.45, 'rgba(255,255,255,0)'); sh.addColorStop(1, 'rgba(40,0,65,0.42)');
      ctx.fillStyle = sh; ctx.fillRect(x - 6, y - 4, w + 12, h + 10);
    }
    // plump side-to-side 3D form shading + sunset neon rim bounce on right
    const cyl = ctx.createLinearGradient(x - 4, 0, x + w + 4, 0);
    cyl.addColorStop(0, 'rgba(38,6,68,0.32)');
    cyl.addColorStop(0.15, 'rgba(255,255,255,0.18)');
    cyl.addColorStop(0.72, 'rgba(255,255,255,0)');
    cyl.addColorStop(0.92, 'rgba(255,110,190,0.18)');
    cyl.addColorStop(1, 'rgba(38,6,68,0.34)');
    ctx.fillStyle = cyl;
    ctx.fillRect(x - 6, y - 4, w + 12, h + 10);

    // sculpted S-curved whipped cream folds
    ctx.lineCap = 'round';
    for (let px = x - h * 0.5; px < x + w + 8; px += 15) {
      ctx.beginPath();
      ctx.moveTo(px, y + h + 3);
      ctx.bezierCurveTo(px + 5, y + h * 0.65, px + 7, y + h * 0.35, px + 14, y - 3);
      ctx.strokeStyle = ridgeDark; ctx.lineWidth = 3.2; ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(px + 3.2, y + h + 3);
      ctx.bezierCurveTo(px + 8.2, y + h * 0.65, px + 10.2, y + h * 0.35, px + 17.2, y - 3);
      ctx.strokeStyle = ridgeLight; ctx.lineWidth = 2.1; ctx.stroke();
    }
    // luscious glossy specular highlights along top ridge
    ctx.fillStyle = 'rgba(255,255,255,0.58)';
    for (let hx = x + 12; hx < x + w - 10; hx += 26) {
      ctx.beginPath();
      ctx.ellipse(hx, y + h * 0.24, 9, h * 0.12, -0.22, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    swirlCoilPath(x, y, w, h);
    ctx.lineWidth = 1.9; ctx.strokeStyle = 'rgba(28,5,54,0.58)'; ctx.stroke();
    ctx.restore();
  }

  /* Lush, sculpted 3D whipped cream swirl peak (classic curly dairy S-peak, never a triangle). */
  function drawTip(cx, top, flavor, rainbow) {
    const c = rainbow ? { light: '#FFF2FA', base: '#FF85D8', shade: '#C42B84' } : (COLORS[flavor] || COLORS.vanilla);
    ctx.save();
    // plump coiled collar at base of tip
    const baseGrad = ctx.createLinearGradient(cx - 18, top - 12, cx + 18, top + 8);
    baseGrad.addColorStop(0, '#FFFFFF');
    baseGrad.addColorStop(0.28, c.light || '#FFF4FA');
    baseGrad.addColorStop(0.68, c.base);
    baseGrad.addColorStop(1, c.shade || c.base);
    ctx.beginPath();
    ctx.ellipse(cx, top + 2, 18, 9.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = baseGrad; ctx.fill();
    ctx.strokeStyle = 'rgba(28,5,54,0.52)'; ctx.lineWidth = 1.6; ctx.stroke();

    // sculpted curling dairy peak rising out of the collar
    const tg = ctx.createLinearGradient(cx - 12, top - 24, cx + 12, top + 4);
    tg.addColorStop(0, '#FFFFFF');
    tg.addColorStop(0.25, c.light || '#FFF4FA');
    tg.addColorStop(0.65, c.base);
    tg.addColorStop(1, c.shade || c.base);
    ctx.beginPath();
    ctx.moveTo(cx - 14, top + 3);
    ctx.bezierCurveTo(cx - 16, top - 11, cx - 2, top - 19, cx + 5, top - 24);
    ctx.bezierCurveTo(cx + 10, top - 27, cx + 14, top - 23, cx + 10, top - 19);
    ctx.bezierCurveTo(cx + 6, top - 16, cx + 15, top - 8, cx + 13, top + 3);
    ctx.quadraticCurveTo(cx, top + 7, cx - 14, top + 3);
    ctx.closePath();
    ctx.fillStyle = tg; ctx.fill();
    ctx.strokeStyle = 'rgba(28,5,54,0.55)'; ctx.lineWidth = 1.7; ctx.stroke();

    // glossy whipped cream curl highlight
    ctx.beginPath();
    ctx.moveTo(cx - 7, top - 1);
    ctx.bezierCurveTo(cx - 8, top - 10, cx - 1, top - 16, cx + 6, top - 21);
    ctx.strokeStyle = 'rgba(255,255,255,0.78)'; ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.stroke();
    ctx.restore();
  }

  const SPRINKLES = [[-12, -3, '#FF3CAC', 0.6], [-6, -6, '#2AF5E4', -0.4], [0, -2, '#FFD166', 0.2], [6, -7, '#FF3CAC', -0.8], [12, -3, '#8A3FFC', 0.5],
    [-9, -10, '#FFD166', 1.1], [3, -11, '#2AF5E4', 0.1], [9, -12, '#FF7A45', -0.3], [-2, -14, '#FF3CAC', 0.9]];

  /* Topping drawn centred on x with its feet on baseY. */
  function drawTopping(id, x, baseY, glow) {
    ctx.save();
    if (glow) { ctx.shadowColor = '#FFD166'; ctx.shadowBlur = 16; }
    if (id === 'cherry') {
      ctx.beginPath(); ctx.arc(x, baseY - 9, 9.5, 0, Math.PI * 2);
      const g1 = ctx.createRadialGradient(x - 3, baseY - 13, 1, x, baseY - 9, 10.5);
      g1.addColorStop(0, '#FF94A8'); g1.addColorStop(0.45, '#ED143D'); g1.addColorStop(1, '#7D051B');
      ctx.fillStyle = g1; ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(30,4,40,0.5)'; ctx.lineWidth = 1.4; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + 1, baseY - 18); ctx.quadraticCurveTo(x + 4, baseY - 27, x + 11, baseY - 28);
      ctx.strokeStyle = '#2FCB6B'; ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.stroke();
      ctx.beginPath(); ctx.ellipse(x - 3, baseY - 13, 2.8, 1.8, -0.6, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fill();
    } else if (id === 'sprinkles') {
      ctx.lineCap = 'round'; ctx.lineWidth = 3.2;
      for (const s of SPRINKLES) {
        ctx.strokeStyle = s[2];
        ctx.beginPath(); ctx.moveTo(x + s[0] - Math.cos(s[3]) * 3.2, baseY + s[1] - Math.sin(s[3]) * 3.2); ctx.lineTo(x + s[0] + Math.cos(s[3]) * 3.2, baseY + s[1] + Math.sin(s[3]) * 3.2); ctx.stroke();
      }
    } else {
      ctx.shadowBlur = glow ? 14 : 0;
      ctx.beginPath(); ctx.moveTo(x, baseY); ctx.lineTo(x + 1, baseY - 24);
      ctx.strokeStyle = '#FFF4FA'; ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.stroke();
      const cols = ['#FF3CAC', '#FFF4FA', '#2AF5E4', '#FFD166'];
      for (let i = 0; i < 4; i++) {
        ctx.beginPath(); ctx.moveTo(x + 1, baseY - 24);
        ctx.arc(x + 1, baseY - 24, 15.5, Math.PI + (i * Math.PI) / 4, Math.PI + ((i + 1) * Math.PI) / 4);
        ctx.closePath(); ctx.fillStyle = cols[i]; ctx.fill();
      }
      ctx.beginPath(); ctx.arc(x + 1, baseY - 40.5, 2.3, 0, Math.PI * 2); ctx.fillStyle = '#FFD166'; ctx.fill();
      ctx.beginPath(); ctx.arc(x + 1, baseY - 24, 15.5, Math.PI, Math.PI * 2);
      ctx.strokeStyle = 'rgba(30,5,50,0.5)'; ctx.lineWidth = 1.4; ctx.stroke();
    }
    ctx.restore();
  }

  function drawBase(b) {
    const cx = b.left + b.width / 2;
    const rim = sy(RIM_Y);
    ctx.save();
    if (b.kind === 'cone') {
      const tipY = sy(0);
      if (ART.cone && ART.cone.complete && ART.cone.naturalWidth > 0) {
        // draw the studio-illustrated crispy waffle cone with 1986 neon paper wrapper
        const drawW = b.width * 1.04;                       // art fit (Gemini v49): the first swirl sits on the waffle cone rim
        const drawH = (tipY - rim) + 12;
        const ge = glowSprite(ART.cone, 'cone', 100, 170, 'rgba(10,2,28,0.55)', 12, 4, scale * dpr);   // soft shadow baked once at a fixed size, then stamped scaled
        if (ge) stampGlow(ctx, ge, cx - drawW / 2, rim - 8, drawW, drawH);
        else ctx.drawImage(ART.cone, cx - drawW / 2, rim - 8, drawW, drawH);
      } else {
        const tY = sy(8);
        ctx.beginPath(); ctx.moveTo(b.left + 4, rim); ctx.lineTo(b.left + b.width - 4, rim); ctx.lineTo(cx + 6, tY); ctx.quadraticCurveTo(cx, tY + 6, cx - 6, tY); ctx.closePath();
        const cg = ctx.createLinearGradient(b.left, 0, b.left + b.width, 0);
        cg.addColorStop(0, '#BA661E'); cg.addColorStop(0.5, '#FFDA8E'); cg.addColorStop(1, '#9E4D14');
        ctx.fillStyle = cg; ctx.fill();
        ctx.strokeStyle = 'rgba(54,18,6,0.78)'; ctx.lineWidth = 2.2; ctx.stroke();
      }
    } else {
      const bot = sy(6);
      ctx.beginPath(); ctx.moveTo(b.left, rim - 4); ctx.lineTo(b.left + b.width, rim - 4); ctx.lineTo(cx + 40, bot); ctx.lineTo(cx - 40, bot); ctx.closePath();
      const cg = ctx.createLinearGradient(b.left, 0, b.left + b.width, 0);
      cg.addColorStop(0, 'rgba(180,240,255,0.58)'); cg.addColorStop(0.35, 'rgba(255,255,255,0.86)'); cg.addColorStop(1, 'rgba(140,200,255,0.52)');
      ctx.fillStyle = cg; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 2.2; ctx.stroke();
      ctx.save(); ctx.clip();
      ctx.fillStyle = '#FF3CAC'; ctx.fillRect(b.left, rim + 22, b.width, 12);
      ctx.fillStyle = '#2AF5E4'; ctx.fillRect(b.left, rim + 36, b.width, 5);
      ctx.fillStyle = '#FFD166'; ctx.fillRect(b.left, rim + 42, b.width, 3);
      ctx.restore();
      ctx.fillStyle = '#FFF4FA'; ctx.font = '700 15px Bungee, Impact, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('TB', cx, rim + 60);
      pillPath(b.left - 4, rim - 10, b.width + 8, 12);
      ctx.fillStyle = '#FFF4FA'; ctx.fill(); ctx.strokeStyle = 'rgba(60,20,80,0.5)'; ctx.stroke();
    }
    // subtle glowing neon shadow ring on boardwalk beneath cone
    ctx.save();
    ctx.shadowColor = '#2AF5E4'; ctx.shadowBlur = 12;
    ctx.fillStyle = 'rgba(20,5,48,0.65)';
    ctx.beginPath(); ctx.ellipse(cx, sy(0) + 2, 34, 5.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#2AF5E4'; ctx.lineWidth = 1.8; ctx.stroke();
    ctx.restore();
    ctx.restore();
  }

  function drawSky() {
    const t = clamp(g.cam / 640, 0, 1);
    const grd = ctx.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, mixColor('#090122', '#02000A', t));
    grd.addColorStop(0.45, mixColor('#23074E', '#08032A', t));
    grd.addColorStop(1, mixColor('#581174', '#1E0A52', t));
    ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);

    // full painted 1986 Miami Beach pier + neon Ferris wheel + Art Deco backdrop anchored to boardwalk!
    const gy = sy(0);
    if (ART.bg && ART.bg.complete && ART.bg.naturalWidth > 0) {
      const bgY = gy - 512;
      if (bgY < H + 40) {
        ctx.drawImage(bgSprite() || ART.bg, 0, bgY, W, H);      // the painted backdrop is resampled to the canvas size ONCE (bgSprite), then only blitted 1:1 each frame
        // smooth cosmic blend above top edge of painted backdrop when tower climbs super high
        if (bgY > 0) {
          const blend = ctx.createLinearGradient(0, bgY - 40, 0, bgY + 60);
          blend.addColorStop(0, '#090122');
          blend.addColorStop(1, 'rgba(9,1,34,0)');
          ctx.fillStyle = blend;
          ctx.fillRect(0, bgY - 40, W, 100);
        }
      }
    }

    // twinkling stars across upper sky & high altitude
    const sa = clamp(0.45 + (g.cam - 80) / 360, 0.4, 1);
    for (let si = 0; si < STARS.length; si++) {
      const s = STARS[si];
      const y = (s.y + g.cam * 0.12) % H;
      if (g.cam < 180 && y > 230) continue;
      const tw = reduced ? 1 : 0.6 + 0.4 * Math.sin(g.time * 2.4 + s.ph);
      ctx.globalAlpha = sa * tw;
      ctx.fillStyle = si % 5 === 0 ? '#2AF5E4' : (si % 4 === 0 ? '#FFD166' : '#FFF4FA');
      ctx.fillRect(s.x, y, s.r, s.r);
    }
    ctx.globalAlpha = 1;

    // high-altitude clouds and gulls (appear as you climb above the pier!)
    const ca = 1 - clamp((g.cam - 700) / 300, 0, 0.6);
    for (const c of CLOUDS) {
      const y = c.y + g.cam * 0.85, x = c.x + (reduced ? 0 : Math.sin(g.time * 0.15 + c.y) * 6);
      if (y < -40 || y > H + 40) continue;
      ctx.globalAlpha = 0.52 * ca;
      ctx.fillStyle = '#FFA8DF';
      [[0, 0, 0.32, 13], [0.28, -5, 0.3, 16], [0.55, 0, 0.3, 13], [0.78, 2, 0.24, 10]].forEach((e) => { ctx.beginPath(); ctx.ellipse(x + c.w * e[0], y + e[1], c.w * e[2], e[3], 0, 0, Math.PI * 2); ctx.fill(); });
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#1B0536'; ctx.lineWidth = 1.8; ctx.lineCap = 'round';
    for (const b of GULLS) {
      const y = b.y + g.cam * 0.9;
      if (y < -20 || y > H) continue;
      const x = ((b.x + (reduced ? 0 : g.time * b.s)) % (W + 60) + W + 60) % (W + 60) - 30;
      const flap = reduced ? 5 : 4 + Math.sin(g.time * 7 + b.x) * 4;
      ctx.beginPath(); ctx.moveTo(x - 9, y + flap); ctx.quadraticCurveTo(x - 4, y - flap, x, y); ctx.quadraticCurveTo(x + 4, y - flap, x + 9, y + flap); ctx.stroke();
    }
  }

  function drawScenery() {
    const gy = sy(0);
    if (gy < -60) return;

    // Only draw procedural fallback scenery if bg-miami-pier.webp hasn't loaded yet
    if (!ART.bg || !ART.bg.complete || !ART.bg.naturalWidth) {
      const sg = ctx.createLinearGradient(0, gy, 0, gy + 95);
      sg.addColorStop(0, '#FFD493'); sg.addColorStop(1, '#BD5E72');
      ctx.fillStyle = sg; ctx.fillRect(0, gy, W, H - gy + 120);
    }

    // splats where trimmed soft-serve overhangs landed on the boardwalk
    for (const s of g.splats) {
      const a = clamp(1 - Math.max(0, s.t - 6) / 2, 0, 1);
      if (a <= 0) continue;
      const grow = Math.min(1, s.t * 8);
      const rx = (s.w * 0.55 + 8) * grow;
      ctx.globalAlpha = a; ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.ellipse(s.x, gy + 12, rx, 6 * grow, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(s.x - rx * 0.12, gy + 8, rx * 0.62, 7 * grow, 0, Math.PI, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(s.x - rx * 0.95, gy + 11, 4 * grow, 2.6 * grow, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(s.x + rx * 1.05, gy + 13, 5 * grow, 2.8 * grow, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(30,5,50,0.35)'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(s.x, gy + 12, rx, 6 * grow, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function layerDrawRect(L) {
    // while landing, draw the whole arriving piece sliding down to its spot
    if (L.anim) {
      const a = L.anim, e = Math.min(1, a.t / a.dur), k = e * e;
      const wy = lerp(a.fromWorldY, L.y, k);
      return { x: lerp(a.fromX, a.full.left, k), w: a.full.width, top: sy(wy + PILL_H) };
    }
    return { x: L.left, w: L.width, top: sy(L.y + PILL_H) };
  }

  function drawTower() {
    drawBase(g.base);
    const n = g.layers.length;
    for (let i = 0; i < n; i++) {
      const L = g.layers[i];
      const r = layerDrawRect(L);
      drawSwirl(r.x, r.top, r.w, PILL_H, L.flavor, L.rainbow);
      if (L.topping && !L.anim) drawTopping(L.topping.id, L.topping.x, r.top + 5, false);
      if (i === n - 1 && !L.anim && g.phase !== 'toppling' && g.phase !== 'over' && !(L.topping)) drawTip(r.x + r.w / 2, r.top, L.flavor, L.rainbow);
    }
    for (const d of g.drops) {
      const e = Math.min(1, d.t / d.dur), k = e * e;
      drawTopping(d.id, lerp(d.x0, d.x1, k), sy(lerp(d.y0, d.y1, k)) + 0, false);
    }
  }

  /* Wind sock: hangs limp when calm, streams out downwind (the way a drop will drift) when it is breezy. */
  function drawWindsock() {
    const px = 60, top = 34, ground = 92;
    const dir = g.wind || 0;
    ctx.save();
    ctx.strokeStyle = '#F4EDE4'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(px, ground); ctx.lineTo(px, top); ctx.stroke();
    ctx.beginPath(); ctx.arc(px, top - 2, 3, 0, Math.PI * 2); ctx.fillStyle = '#FFD166'; ctx.fill();
    ctx.translate(px, top + 4);
    ctx.scale(dir === 0 ? 1 : dir, 1);
    const flutter = reduced ? 0 : Math.sin(g.time * 9) * 0.08;
    ctx.rotate(dir === 0 ? 1.4 : 0.1 + flutter);
    const cols = ['#FF7A45', '#FFF4FA', '#FF7A45', '#FFF4FA'];
    for (let i = 0; i < 4; i++) {
      const x0 = i * 11, h0 = 8.5 - i * 1.7, h1 = 8.5 - (i + 1) * 1.7;
      ctx.beginPath(); ctx.moveTo(x0, -h0); ctx.lineTo(x0 + 11, -h1); ctx.lineTo(x0 + 11, h1); ctx.lineTo(x0, h0); ctx.closePath();
      ctx.fillStyle = cols[i]; ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = dir === 0 ? 'rgba(255,244,250,0.75)' : '#2AF5E4';
    ctx.font = '600 9px "DM Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(dir === 0 ? 'CALM' : (dir > 0 ? 'BREEZE >' : '< BREEZE'), px, ground + 12);
  }

  function drawSlider() {
    const p = g.piece;
    if (!p || g.phase === 'toppling') return;
    const x = pieceX();
    const bob = reduced ? 0 : Math.sin(g.time * 8) * 1.2;
    // guide lines: where the layer below begins and ends
    const top = topLayer();
    const tsy = sy(topSurfaceWorld());
    ctx.save();
    ctx.setLineDash([3, 5]); ctx.lineWidth = 1.3; ctx.strokeStyle = 'rgba(42,245,228,0.55)';
    ctx.beginPath(); ctx.moveTo(top.left, SLIDER_Y + 4); ctx.lineTo(top.left, tsy); ctx.moveTo(top.left + top.width, SLIDER_Y + 4); ctx.lineTo(top.left + top.width, tsy); ctx.stroke();
    ctx.restore();
    if (p.kind === 'layer') {
      drawSwirl(x, SLIDER_Y - PILL_H + bob, p.width, PILL_H, p.flavor, p.rainbow);
      drawTip(x + p.width / 2, SLIDER_Y - PILL_H + bob, p.flavor, p.rainbow);
    } else {
      drawTopping(p.id, x + p.width / 2, SLIDER_Y - 6 + bob, true);
    }
    // breeze chevrons under the slider show which way a drop will drift
    if (g.wind !== 0) {
      ctx.save(); ctx.strokeStyle = '#2AF5E4'; ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const cx = x + p.width / 2;
      for (let i = 0; i < 2; i++) {
        const ox = cx + g.wind * (6 + i * 9);
        ctx.beginPath(); ctx.moveTo(ox - g.wind * 3, SLIDER_Y + 12); ctx.lineTo(ox + g.wind * 3, SLIDER_Y + 17); ctx.lineTo(ox - g.wind * 3, SLIDER_Y + 22); ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawChunks() {
    for (const c of g.chunks) {
      ctx.save();
      ctx.translate(c.x, sy(c.y));
      ctx.rotate(c.rot);
      if (c.kind === 'layer') {
        drawSwirl(-c.w / 2, -PILL_H / 2, c.w, PILL_H, c.flavor, c.rainbow);
        if (c.topping) drawTopping(c.topping.id, c.topping.dx, -PILL_H / 2 + 5, false);
      } else {
        drawTopping(c.id, 0, 10, false);
      }
      ctx.restore();
    }
  }

  function drawFx() {
    for (const r of g.rings) {
      const k = r.t / 0.5;
      ctx.save(); ctx.globalAlpha = 1 - k; ctx.strokeStyle = '#FFD166'; ctx.shadowColor = '#FF3CAC'; ctx.shadowBlur = 12; ctx.lineWidth = 3 * (1 - k) + 1;
      const w = r.w / 2 + 8 + k * 34;
      ctx.beginPath(); ctx.ellipse(r.x, sy(r.y), w, 10 + k * 12, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    for (const p of g.parts) {
      ctx.globalAlpha = clamp(1 - p.life / p.max, 0, 1); ctx.fillStyle = p.c;
      ctx.beginPath(); ctx.arc(p.x, p.y > H + 50 ? p.y : (p.y), p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const f of g.floaters) {
      const k = f.t / f.dur;
      ctx.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      ctx.font = '700 17px Bungee, Impact, sans-serif';
      const y = f.y - (reduced ? 0 : k * 22);
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(20,3,40,0.85)'; ctx.lineJoin = 'round';
      const x = clamp(f.x, 80, W - 80);
      ctx.strokeText(f.text, x, y); ctx.fillStyle = f.color; ctx.fillText(f.text, x, y);
    }
    ctx.globalAlpha = 1;
    if (g.flash > 0) { ctx.fillStyle = 'rgba(255,209,102,' + (g.flash * 0.28).toFixed(3) + ')'; ctx.fillRect(0, 0, W, H); }
  }

  /* An idle preview so the start screen shows what you are building. */
  function demoLayers() {
    const widths = [150, 150, 138, 138];
    const out = []; let left = (W - START_W) / 2;
    widths.forEach((w, i) => { left = i === 2 ? left + 6 : left; out.push({ left, width: w, y: layerWorldY(i), flavor: flavorFor(i), rainbow: false, topping: i === 3 ? { id: 'cherry', x: left + w / 2 } : null }); });
    return out;
  }

  function render() {
    if (!layoutW) return;
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    ctx.save();
    if (g.shake > 0 && !reduced) ctx.translate((Math.random() - 0.5) * g.shake * 1.6, (Math.random() - 0.5) * g.shake * 1.6);
    drawSky();
    drawScenery();

    const idle = g.phase === 'idle';
    const saved = g.layers;
    if (idle) g.layers = demoLayers();

    // tower: slight sway about its base in a breeze; tilts over when toppling
    ctx.save();
    const pivotX = W / 2;
    if (g.phase === 'toppling' && g.topple && g.topple.stage === 0) {
      drawBase(g.base);
      const keep = g.layers; // draw swirl layers rotated about the rim, base stays put
      ctx.translate(pivotX, sy(RIM_Y)); ctx.rotate(g.topple.angle); ctx.translate(-pivotX, -sy(RIM_Y));
      for (const L of keep) {
        drawSwirl(L.left, sy(L.y + PILL_H), L.width, PILL_H, L.flavor, L.rainbow);
        if (L.topping) drawTopping(L.topping.id, L.topping.x, sy(L.y + PILL_H) + 5, false);
      }
    } else {
      if (g.sway > 0.001) { ctx.translate(pivotX, sy(0)); ctx.rotate(g.sway * (g.wind || 1) * 0.0045 * Math.sin(g.time * 1.7) + g.wind * g.sway * 0.003); ctx.translate(-pivotX, -sy(0)); }
      if (g.phase === 'over' && reduced) ctx.globalAlpha = 0.55;
      drawTower();
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    if (idle) g.layers = saved;
    drawChunks();
    if (g.phase === 'playing' || g.phase === 'paused') drawSlider();
    drawWindsock();
    drawFx();
    ctx.restore();
  }

  /* ---------- Input ---------- */
  function onBoardDown(e) {
    if (e.button !== undefined && e.button > 0) return;
    if (e.target && e.target.closest && e.target.closest('.overlay')) return;   // overlay buttons are not drops
    e.preventDefault();
    unlockAudio();
    if (root.TBK && root.TBK.isStray(e)) return;      // a palm or sleeve on the panel
    tapDrop();
  }
  /* One drop per tap: two fingers landing together (or a finger plus a palm) are one drop, not two. */
  let lastDropAt = -1e9;
  function tapDrop() {
    const t = performance.now();
    if (t - lastDropAt < 140) return;
    lastDropAt = t;
    if (g.phase === 'playing') drop();
  }

  function onKey(e) {
    const k = e.key;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'm' || k === 'M') { toggleSound(); return; }
    if (k === 'p' || k === 'P' || k === 'Escape') { if (g.phase === 'playing') pauseGame(); else if (g.phase === 'paused') resumeGame(); return; }
    if (k !== ' ' && k !== 'Enter' && k !== 'Spacebar') return;
    const t = e.target;
    if (t && t.closest && t.closest('a, button')) return;   // let focused buttons and links do their own thing
    e.preventDefault();
    if (e.repeat) return;
    unlockAudio();
    if (g.phase === 'playing') drop();
    else if (g.phase === 'idle' || (g.phase === 'over' && performance.now() - g.overAt > 600)) startGame();
    else if (g.phase === 'paused') resumeGame();
  }

  function toggleSound() {
    soundOn = !soundOn;
    saveSound(soundOn);
    setSoundButton();
    if (root.TBMusic) root.TBMusic.setMuted(!soundOn);
    if (soundOn) { unlockAudio(); blip(660, 0.08, 'square', 0.06); }
  }

  function init() {
    setSoundButton();
    updateHud();
    showOverlay('start');
    board.addEventListener('pointerdown', onBoardDown);
    board.addEventListener('contextmenu', (e) => e.preventDefault());
    const dropBtn = document.getElementById('btnDrop');
    if (dropBtn) dropBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); if (root.TBK && root.TBK.isStray(e)) return; unlockAudio(); tapDrop(); });
    if (root.TBK) { root.TBK.onEnd(pauseGame); root.TBK.onAgain(() => { if (g.phase === 'over') startGame(); }); }
    el.start.addEventListener('pointerdown', (e) => { if (e.target && e.target.closest && e.target.closest('[data-kg-rules]')) { e.stopPropagation(); return; }   // the RULES button is not a start tap
      e.preventDefault(); e.stopPropagation(); if (g.phase === 'idle') startGame(); });
    el.btnStart.addEventListener('click', () => { if (g.phase === 'idle') startGame(); });
    el.btnAgain.addEventListener('click', () => { if (g.phase === 'over' && performance.now() - g.overAt > 450) startGame(); });
    el.btnResume.addEventListener('click', () => resumeGame());
    // after a mouse or touch press on a control, hand focus back to the board so Space and Enter go on dropping scoops
    const refocus = (e) => { if (e.detail > 0) { try { board.focus({ preventScroll: true }); } catch (err) { /* ignore */ } } };
    el.btnSound.addEventListener('click', (e) => { toggleSound(); refocus(e); });
    el.btnPause.addEventListener('click', (e) => { if (g.phase === 'playing') pauseGame(); else if (g.phase === 'paused') resumeGame(); refocus(e); });
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });
    root.addEventListener('pagehide', pauseGame);
    if (root.ResizeObserver) new root.ResizeObserver(resize).observe(canvas); else root.addEventListener('resize', resize);
    resize();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(render);
  }

  /* Read-only snapshot for automated checks (no way to change the game). */
  api.getState = function () {
    const p = g.piece;
    const top = topLayer();
    return {
      phase: g.phase, scoops: g.scoops, score: g.score, best: g.best, streak: g.streak, wind: g.wind, cam: g.cam,
      pieceKind: p ? p.kind : null, flavor: p ? p.flavor || null : null, toppingId: p && p.kind === 'topping' ? p.id : null,
      pieceX: p ? pieceX() : null, pieceWidth: p ? p.width : null, pieceSpeed: p ? p.speed : null, pieceMin: p ? p.min : null, pieceMax: p ? p.max : null,
      topLeft: top.left, topWidth: top.width, tol: perfectTol(g.scoops), drift: g.wind * WIND_DRIFT,
      chunks: g.chunks.length, reduced,
    };
  };

  init();
})(typeof window !== 'undefined' ? window : globalThis);
