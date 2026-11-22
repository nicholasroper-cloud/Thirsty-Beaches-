// tests/kiosk/difficulty.js — the two difficulty tables of the five games (no browser needed).
//   classic  = the v48 numbers EXACTLY: every pure function gives the same answer as the v48 files (taken from git, commit 9f860af) over wide ranges
//   arcade86 = Gemini's harder numbers (spot-checked), selected only through setDifficulty(); a bad / missing / odd value is classic
//   the shipped arcade-session.json asks for arcade86, and the shared shell only accepts the two known names
// Run: node tests/kiosk/difficulty.js
"use strict";
const assert = require("assert");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ROOT = path.resolve(__dirname, "../..");
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const close = (a, b, m) => { assert.ok(Math.abs(a - b) < 1e-12, m + ": " + a + " vs " + b); passed++; };

// ---- the v48 reference files, straight from git ----
const REF = "9f860af";
const refDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-diff-ref-"));
const IDS = ["thirsty-blaster", "thirsty-tower", "cup-catch", "boardwalk-dash", "soft-serve-stacker"];
let haveRef = true;
try { cp.execSync(`git -C "${ROOT}" archive ${REF} kiosk/games | tar -x -C "${refDir}"`, { stdio: "ignore" }); } catch { haveRef = false; }
const load = (base, id) => { const p = path.join(base, "kiosk/games", id, id + ".js"); delete require.cache[require.resolve(p)]; const m = require(p); return m.core || m; };
const cur = {}; for (const id of IDS) cur[id] = load(ROOT, id);
const mkrng = seed => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

for (const id of IDS) {
  const m = cur[id];
  ok(m.TUNING && m.TUNING.classic && m.TUNING.arcade86, id + ": both tables exist side by side in one TUNING object");
  ok(typeof m.setDifficulty === "function" && typeof m.difficultyMode === "function", id + ": setDifficulty / difficultyMode exported");
  eq(m.difficultyMode(), "classic", id + ": starts in classic (the safe default)");
  // a bad value is classic; the object prototype is never a table
  m.setDifficulty("arcade86"); eq(m.difficultyMode(), "arcade86", id + ": arcade86 selected");
  for (const bad of ["", "ARCADE86", "hard", "constructor", "__proto__", "toString", undefined, null, 5, {}, []]) { m.setDifficulty("arcade86"); eq(m.setDifficulty(bad), "classic", id + ": '" + String(bad) + "' falls back to classic"); eq(m.difficultyMode(), "classic", id + ": and stays there"); }
  m.setDifficulty("classic");
}

if (!haveRef) { console.log("difficulty: v48 reference not available from git (" + REF + "); classic-equals-v48 checks SKIPPED"); }
else {
  // ---- classic == v48, function by function ----
  const ref = {}; for (const id of IDS) ref[id] = load(refDir, id);
  { const a = cur["thirsty-blaster"], b = ref["thirsty-blaster"]; a.setDifficulty("classic");
    for (let n = 1; n <= 40; n++) eq(a.waveParams(n), b.waveParams(n), "blaster waveParams(" + n + ")");
    for (let n = 1; n <= 24; n++) for (const seed of [1, 7, 99]) eq(a.buildWave(n, mkrng(seed)), b.buildWave(n, mkrng(seed)), "blaster buildWave(" + n + "," + seed + ")");
    eq([a.ICE_SECS, a.CREAM_SECS], [b.ICE_SECS, b.CREAM_SECS], "blaster buff seconds");
    eq([a.TUNING.classic.ICE_SLOW], [0.4], "blaster ice slow-down is the v48 0.4"); }
  { const a = cur["thirsty-tower"], b = ref["thirsty-tower"]; a.setDifficulty("classic");
    for (let l = 1; l <= 30; l++) eq(a.difficulty(l, { tide: 1 }), b.difficulty(l, { tide: 1 }), "tower difficulty(" + l + ")");
    eq(a.TUNE, b.TUNE, "tower TUNE (every physics, tide, buff and score number)");
    a.setDifficulty("arcade86"); a.setDifficulty("classic"); eq(a.TUNE, b.TUNE, "tower TUNE is restored exactly after a round trip through arcade86"); }
  { const a = cur["cup-catch"], b = ref["cup-catch"]; a.setDifficulty("classic");
    for (let l = 1; l <= 40; l++) { eq(a.difficulty(l), b.difficulty(l), "cup difficulty(" + l + ")"); for (let t = 1; t <= 8; t++) close(a.ticketTime(t, l), b.ticketTime(t, l), "cup ticketTime(" + t + "," + l + ")"); }
    eq(a.RUSH_SECONDS, b.RUSH_SECONDS, "cup rush seconds"); }
  { const a = cur["boardwalk-dash"], b = ref["boardwalk-dash"]; a.setDifficulty("classic");
    for (let l = 1; l <= 40; l++) eq(a.levelParams(l), b.levelParams(l), "dash levelParams(" + l + ")");
    for (let l = 1; l <= 14; l++) for (const seed of [1, 2, 3]) { const g1 = a.createGame({ seed, level: l }), g2 = b.createGame({ seed, level: l }); eq(JSON.stringify(g1.lvl), JSON.stringify(g2.lvl), "dash level " + l + " layout seed " + seed); } }
  { const a = cur["soft-serve-stacker"], b = ref["soft-serve-stacker"]; a.setDifficulty("classic");
    for (let n = 0; n <= 80; n++) close(a.speedFor(n), b.speedFor(n), "stacker speedFor(" + n + ")");
    for (const k of ["START_W", "MIN_OVERLAP", "TOL", "TOL_EARLY", "REGROW", "WIND_START", "WIND_DRIFT"]) eq(a[k], b[k], "stacker " + k);
    for (let n = 0; n < 60; n++) { eq(a.perfectTol(n), b.perfectTol(n), "stacker perfectTol(" + n + ")"); eq(a.windForLayer(n), b.windForLayer(n), "stacker windForLayer(" + n + ")"); } }
}

// ---- arcade86 = Gemini's numbers (spot checks) ----
{ const a = cur["thirsty-blaster"]; a.setDifficulty("arcade86");
  const w1 = a.waveParams(1); eq([w1.cups, w1.interval, w1.speed], [8, 1.65, 58], "blaster wave 1"); close(a.waveParams(19).speed, 155, "blaster speed cap (wave 19, not a happy-hour wave)"); eq(a.TUNING.arcade86.ICE_SECS, 4.5, "ice 4.5 s"); eq(a.TUNING.arcade86.gullFromWave, 1, "gulls from wave 1"); a.setDifficulty("classic"); }
{ const a = cur["thirsty-tower"]; a.setDifficulty("arcade86"); eq([a.TUNE.TIDE_DELAY, a.TUNE.TIDE_BASE, a.TUNE.FREEZE, a.TUNE.INVINCIBLE, a.TUNE.SPAWN_PROT, a.TUNE.TIDE_DELAY_CHECKPOINT], [3.5, 7.2, 3, 4.5, 1.3, 2], "tower arcade86 tide and buffs");
  const d = a.difficulty(1, { tide: 1 }); close(d.hz, 1.35, "tower hz"); close(d.rate, 1.3, "tower rate"); a.setDifficulty("classic"); }
{ const a = cur["cup-catch"]; a.setDifficulty("arcade86"); const d = a.difficulty(1); eq([d.fall, d.interval], [205, 0.82], "cup level 1 fall / interval"); close(d.junk, 0.26, "cup junk share"); close(a.ticketTime(2, 1), 10.4, "cup ticketTime(2,1)"); a.setDifficulty("classic"); }
{ const a = cur["boardwalk-dash"]; a.setDifficulty("arcade86"); const p = a.levelParams(1); eq([p.crabLanes, p.melt, p.towelW, p.maxPerLane], [2, 48, 2, 3], "dash level 1"); close(p.speedBase, 1.55, "dash speed"); close(p.gapScale, 1.45, "dash gap scale"); close(a.levelParams(30).melt, 24, "dash melt floor"); a.setDifficulty("classic"); }
{ const a = cur["soft-serve-stacker"]; a.setDifficulty("arcade86"); eq([a.START_W, a.MIN_OVERLAP, a.TOL, a.TOL_EARLY, a.REGROW, a.WIND_START, a.WIND_DRIFT], [132, 14, 4, 5.5, 10, 5, 11], "stacker constants"); close(a.speedFor(0), 105, "stacker first slider"); close(a.speedFor(100), 310, "stacker cap"); a.setDifficulty("classic"); eq(a.START_W, 150, "stacker back to classic"); }

// ---- the shipped setting and the shared shell ----
const sess = JSON.parse(fs.readFileSync(path.join(ROOT, "kiosk/arcade-session.json"), "utf8"));
eq(sess.gameDifficulty, "arcade86", "the shipped file asks for arcade86");
ok(/gameDifficulty/.test(sess._gameKeys) && /classic/.test(sess._gameKeys), "and documents the key");
{ // kgame.js sessionLimits: load it in a stub window
  const stub = { document: { readyState: "loading", addEventListener() {}, getElementById() { return null; }, body: null, hidden: false }, setInterval() {}, setTimeout() {}, clearTimeout() {}, addEventListener() {}, fetch() { return Promise.reject(new Error("x")); }, location: { href: "" }, sessionStorage: null };
  const src = fs.readFileSync(path.join(ROOT, "kiosk/games/shared/kgame.js"), "utf8");
  const vm = require("vm"); const ctx = vm.createContext(Object.assign({}, stub, { window: stub, AbortController, Date, JSON, Math, console }));
  vm.runInContext(src, ctx); const TBK = ctx.TBK || stub.TBK;
  ok(TBK && typeof TBK.difficulty === "function", "TBK.difficulty exists");
  eq(TBK.difficulty(), "classic", "TBK.difficulty() is classic until the settings are read");
  eq(TBK.sessionLimits({ gameDifficulty: "arcade86" }).gameDifficulty, "arcade86", "arcade86 accepted"); eq(TBK.sessionLimits({ gameDifficulty: "classic" }).gameDifficulty, "classic", "classic accepted");
  for (const bad of [undefined, null, "", "Arcade86", "hard", 1, true, {}, "arcade86 "]) eq(TBK.sessionLimits({ gameDifficulty: bad }).gameDifficulty, "classic", "bad value " + JSON.stringify(bad) + " -> classic");
  eq(TBK.sessionLimits(null).gameDifficulty, "classic", "no file -> classic"); eq(TBK.sessionLimits("garbage").gameDifficulty, "classic", "garbage -> classic"); }

try { fs.rmSync(refDir, { recursive: true, force: true }); } catch {}
console.log(`difficulty: ${passed} checks passed`);
