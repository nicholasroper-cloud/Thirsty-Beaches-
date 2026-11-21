// tests/kiosk/games.js — the five arcade games and their picker on the kiosk (kiosk/games/*), in headless Chrome against the REAL kiosk-server.js
// (fake Worker + fake Clover), portrait 1080x1920 with touch emulation (the 47-inch panel) plus a landscape 1920x1080 sanity pass.
//   A  every page (picker + 5 games): loads with no console error / exception / CSP violation, makes NO request to any host but the kiosk, never calls
//      /api/arcade/spin, has the permanent ORDER DRINKS + back buttons (>= 64 px, bottom of the screen), controls in the lower part, no scrolling, big board.
//   B  each game is STARTED, STEERED, PAUSED, RESUMED and PLAYED TO GAME OVER with synthesized touch only (multi-touch on Tower; a second finger and a palm-sized
//      contact never break the first); keyboard is never used.
//   C  game over = exactly one start + one finish, bodies {game} / {sid} only; the result panel (mocked win): prize, code, phone keypad in the lower half,
//      save + skip paths, the typed number never stored, no-win = plain thanks with no code and no teasing.
//   D  the visit: the time cap spans pages, "Time's up" stops audio and returns, "Still playing?" then the hands-off return (which drops an unused pending
//      prize first), a missing or bad arcade-session.json means defaults (never no limit).
//   E  the REAL server roll end to end (staff odds = always a prize): a finished game wins a Worker code, one roll per run, too-soon finish = thanks.
// Needs Google Chrome (CHROME_BIN or the usual path); skips (exit 0) without it. TB_SHOTS=<dir> writes screenshots.
// Run: node tests/kiosk/games.js
"use strict";
const assert = require("assert");
const L = require("./games-lib");
const { sleep, waitFor, req, stageKiosk, launchChrome } = L;

if (!L.CHROME) { console.log("games: SKIPPED (no Chrome found; set CHROME_BIN)"); process.exit(0); }
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const keepAlive = setInterval(() => {}, 1000);

const GAMES = {
  "thirsty-blaster": { start: "#tbStart", pause: "#tbPause", mode: "window.__tb.state", playing: "playing", paused: "paused", resume: "#tbStart", controls: ["#tbPause", "#tbSound", ".tb-flavor"] },
  "thirsty-tower": { start: "#ovBtn", pause: "#pauseBtn", mode: "window.__tbdbg.mode", playing: "play", paused: "paused", resume: "#ovBtn", controls: ["#pauseBtn", "#soundBtn", "#jumpBtn", "[data-ctl]"] },
  "cup-catch": { start: "#btnStart", pause: "#btnPause", mode: "CupCatch.snapshot().mode", playing: "playing", paused: "paused", resume: "#btnResume", controls: ["#btnPause", "#btnSound"] },
  "boardwalk-dash": { start: "#bdStart", pause: "#bdPause", mode: "BoardwalkDash.getMode()", playing: "playing", paused: "paused", resume: "#bdStart", controls: ["#bdPause", "#bdSound", "[data-dir]"] },
  "soft-serve-stacker": { start: "#btnStart", pause: "#btnPause", mode: "SoftServeStacker.getState().phase", playing: "playing", paused: "paused", resume: "#btnResume", controls: ["#btnPause", "#btnSound", "#btnDrop"] },
};
const PAGES = ["/arcade/games", ...Object.keys(GAMES).map(g => "/arcade/games/" + g)];
const url = (k, p) => k.base + p + (p === "/arcade/games" ? "" : "?debug");
const sess = c => c.eval("window.__errs.concat([]).length"); // eslint-disable-line

const RULES_OK = { ok: true, rules: { sponsorName: "", sponsorAddress: "", promoStart: "", promoEnd: "", prizeLifeText: "24 hours", rulesUrl: "", privacyUrl: "", stickerSwap: true, onePerPersonPerDay: true, limitedPrizesDaily: true,
  missing: ["sponsorName", "sponsorAddress", "promoStart", "promoEnd"], prizes: [{ id: "size_upgrade", label: "Free Size Upgrade", note: "used on a drink you order" }, { id: "neon_charm", label: "Free 3D-Printed Neon Straw Charm", note: "" }, { id: "free_drink_jackpot", label: "Free Drink", note: "no purchase needed" }],
  freeDrinkOneIn: 50, mostGamesDoNotWin: true, period: "", version: 1 } };
/* the age screen and the keypad: tap a month (1-12), type four year digits, CONTINUE */
async function kpress(c, d, pad = "#kpPad") { const els = await c.eval(`(function(){var k=[].filter.call(document.querySelectorAll('${pad} .kp-key'),function(b){return b.textContent.trim()==='${d}'})[0];var r=k.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`); await c.tap(Math.round(els[0]), Math.round(els[1])); }
async function answerAge(c, month, year) {
  if (month) { const r = await c.eval(`(function(){var r=document.querySelectorAll('.kp-month')[${month - 1}].getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`); await c.tap(Math.round(r[0]), Math.round(r[1])); }
  for (const d of String(year || "")) await kpress(c, d);
}
const yearsAgo = (y, m = 6) => { const n = new Date(); return { month: m, year: n.getFullYear() - y }; };

/* ---------- mocks for /api/arcade/game/* and wallet/save, recording every body ---------- */
function installMock(c, opts = {}) {
  const log = { start: [], finish: [], save: [], dismiss: [] };
  let n = 0;
  c.mocks.length = 0;
  return c.mock(/\/api\/arcade\/(game\/start|game\/finish|wallet\/save|pending\/dismiss|rules|status)/, (u, r) => {
    if (/\/rules/.test(u)) { log.rules = (log.rules || 0) + 1; return opts.rules === null ? { status: 500, body: { ok: false } } : { body: opts.rules || RULES_OK }; }
    if (/\/status/.test(u)) return { body: opts.status || { ok: true, prizes: true, capped: false, period: "", version: 1 } };
    const body = (() => { try { return JSON.parse(r.postData || "{}"); } catch { return {}; } })();
    if (/game\/start/.test(u)) { log.start.push(body); return { body: { ok: true, sid: ("ab12" + String(++n).padStart(20, "0")).slice(0, 24), minPlayMs: 20000 } }; }
    if (/game\/finish/.test(u)) { log.finish.push(body); return { body: opts.win ? { ok: true, win: true, prizeId: "size_upgrade", label: "Free Size Upgrade", code: opts.code || "K7QD", expiresAt: Date.now() + 24 * 3600e3, orderNow: opts.orderNow !== false, saveable: opts.saveable !== false } : { ok: true, win: false, thanks: true } }; }
    if (/wallet\/save/.test(u)) { log.save.push(body); return { body: opts.saveReply || { ok: true, saved: true, last2: String(body.phone || "").slice(-2), keptUntil: Date.now() + 1e6 } }; }
    log.dismiss.push(body); return { body: { ok: true, dismissed: false } };
  }).then(() => log);
}

/* ---------- drivers: play each game to game over with touch only ---------- */
async function driveToOver(c, g) {
  const cfg = GAMES[g];
  await c.eval("window.__speed=8");
  const t0 = Date.now();
  const mode = async () => c.eval(cfg.mode);
  let cupTouch = false, hops = 0;
  while (Date.now() - t0 < 300000) {          // a generous ceiling only: nothing below waits on the wall clock, so a loaded machine just takes longer
    const m = await mode();
    if (m === "over") break;
    if (m === cfg.paused) { await c.tapEl(cfg.resume); await sleep(200); continue; }   // headless Chrome sometimes reports the tab hidden for a moment and the game pauses itself: a tap resumes
    if (g === "boardwalk-dash" && m === "playing") {
      await c.tapEl("[data-dir=up]"); await sleep(120); hops++;
      // a skilled run can go on for minutes: after 10 real hops (a count, not a time) let the drink melt (the game's own life-loss rule), every round, so the run always ends however slow the machine is
      if (hops >= 10) await c.eval("(function(){var d=BoardwalkDash.getGame().d;d.melt=Math.min(d.melt,0.15)})()");
    }
    else if (g === "soft-serve-stacker" && m === "playing") {
      const s = await c.eval("SoftServeStacker.getState()");
      if (s.pieceX != null && Math.abs(s.pieceX - s.topLeft) > Math.max(10, s.topWidth * 0.55)) await c.tapEl("#btnDrop");
      await sleep(40);
    } else if (g === "cup-catch" && m === "playing") {
      const snap = await c.eval("CupCatch.snapshot()");
      const junk = snap.items.filter(i => ["sand", "flipflop", "feather"].includes(i.kind)).sort((a, b) => b.y - a.y)[0];
      if (junk) {
        const r = await c.rect("#gameCanvas"); const px = Math.round(r.x + junk.x / 360 * r.w), py = Math.round(r.y + r.h * 0.9);
        if (!cupTouch) { await c.touch("touchStart", [{ x: px, y: py }]); cupTouch = true; } else await c.touch("touchMove", [{ x: px, y: py }]);
      }
      await sleep(60);
    } else await sleep(200);
  }
  if (cupTouch) await c.touch("touchEnd", []);
  eq(await mode(), "over", g + " reached game over by play alone");
}

async function section(name, fn) { if (process.env.ONLY && !process.env.ONLY.split(",").some(o => name.startsWith(o))) return; const t = Date.now(); await fn(); console.log("  ok  " + name + " (" + ((Date.now() - t) / 1000).toFixed(1) + "s)"); }

(async () => {
  const kiosk = await stageKiosk({ session: { gameMinSeconds: 5, gameMaxSeconds: 900, idleSeconds: 300, idleWarnSeconds: 20 } });   // long limits: this suite is slower than a customer
  const c = await launchChrome();
  const out = process.env.TB_SHOTS;
  try {
    await c.viewport(1080, 1920); await c.spy();
    const VW = 1080, VH = 1920;

    /* ======================= A. every page ======================= */
    await section("A. layout, offline, no console noise (portrait)", async () => {
      for (const p of PAGES) {
        const h = await req(kiosk.port, "GET", p);
        eq(h.status, 200, p + " is served");
        ok(/default-src 'none'/.test(h.headers["content-security-policy"]) && /script-src 'self'/.test(h.headers["content-security-policy"]), p + ": strict CSP, scripts from this kiosk only");
        ok(!/<script(?![^>]*\bsrc=)/i.test(h.body), p + ": no inline script");
        ok(!/googleapis|gstatic|https?:\/\/(?!127\.0\.0\.1)/.test(h.body.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "")), p + ": no external URL in the markup");
        await c.goto(url(kiosk, p)); await sleep(400);
        const errs = c.consoleErrors.concat(c.exceptions, await c.eval("window.__errs"));
        eq(errs, [], p + ": no console error, exception or CSP violation");
        const ext = c.requests.filter(r => !/^(http:\/\/127\.0\.0\.1|data:)/.test(r.url));
        eq(ext.map(r => r.url), [], p + ": no request to anything but the kiosk");
        const apis = c.requests.map(r => r.url.replace(kiosk.base, "")).filter(u => u.startsWith("/api/"));
        ok(apis.every(u => /^\/api\/arcade\/(ping|status)$/.test(u)), p + ": only the activity ping and the read-only prize status on load, got " + apis.join(","));
        const m = await c.eval(`(function(){var d=document.documentElement,r=function(s){var e=document.querySelector(s);if(!e)return null;var b=e.getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height,r:b.right,b:b.bottom}};
          var small=[].slice.call(document.querySelectorAll('.kg-bar a,.kg-ctl button,.kg-ctl .kg-slide,.pk-tile')).filter(function(e){return e.offsetParent}).map(function(e){var b=e.getBoundingClientRect();return [e.id||e.className,Math.min(b.width,b.height)]}).filter(function(a){return a[1]<64});
          return {sw:d.scrollWidth,sh:d.scrollHeight,bsw:document.body.scrollWidth,bsh:document.body.scrollHeight,order:r('.kg-order'),back:r('.kg-back'),board:r('.kg-board'),ctl:r('.kg-ctl'),grid:r('.pk-grid'),top:r('.kg-top'),small:small,time:!!document.getElementById('kgTime')}})()`);
        ok(m.sw <= VW && m.sh <= VH && m.bsw <= VW && m.bsh <= VH, p + ": no scrolling (" + [m.sw, m.sh] + ")");
        ok(m.order && m.order.h >= 64 && m.order.y >= VH * 0.75 && m.order.b <= VH, p + ": ORDER DRINKS is >= 64 px and in the bottom quarter");
        ok(m.back && m.back.h >= 64 && m.back.y >= VH * 0.75 && m.back.b <= VH, p + ": the way back is >= 64 px and in the bottom quarter");
        eq(m.small, [], p + ": every tap target is at least 64 px");
        ok(m.time, p + ": shows the visit time left");
        if (p === "/arcade/games") ok(m.grid.y >= VH * 0.28 && m.grid.b <= m.order.y, p + ": the tiles sit in the lower two thirds above the bar");
        else {
          ok(m.board.w >= VW * 0.6, p + ": the board fills the width (" + Math.round(m.board.w) + " of " + VW + ")");
          ok(m.ctl.y >= VH * 0.55 && m.ctl.b <= m.order.y, p + ": controls are in the lower part (" + Math.round(m.ctl.y) + ")");
          ok(m.board.b <= m.ctl.y + 2 && m.board.y >= m.top.y, p + ": board does not overlap the controls");
        }
        if (out) await c.shot("portrait-" + (p.split("/").pop() || "x") + "-start.png");
      }
      // the order link goes to the ordering screen's menu and the back link to the picker
      await c.goto(url(kiosk, PAGES[1]));
      eq(await c.eval("document.querySelector('.kg-order').getAttribute('href')"), "/#menu");
      eq(await c.eval("document.querySelector('.kg-back').getAttribute('href')"), "/arcade/games");
      await c.goto(url(kiosk, PAGES[0]));
      eq(await c.eval("document.querySelector('.kg-back').getAttribute('href')"), "/arcade");
      eq(await c.eval("[].slice.call(document.querySelectorAll('.pk-tile')).map(function(a){return a.getAttribute('href')})"),
        ["/arcade/games/thirsty-blaster", "/arcade/games/thirsty-tower", "/arcade/games/cup-catch", "/arcade/games/boardwalk-dash", "/arcade/games/soft-serve-stacker", "/arcade"]);
      // path traversal / unknown ids / odd extensions
      for (const bad of ["/arcade/games/../kiosk-server.js", "/arcade/games/nope", "/arcade/games/thirsty-blaster/../../x", "/kiosk/games/..%2f..%2fkiosk-server.js", "/kiosk/games/%2e%2e/%2e%2e/kiosk-server.js", "/kiosk/games/..%5c..%5ckiosk-server.js", "/kiosk/games/shared/kgame.js%00.png", "/kiosk/games/fonts/OFL-NOTE.TXT.bak"])
        ok([400, 403, 404].includes((await req(kiosk.port, "GET", bad)).status), "refused: " + bad);
      eq((await req(kiosk.port, "GET", "/kiosk/games/fonts/bungee.woff2")).headers["content-type"], "font/woff2");
    });

    await section("A2. landscape does not break (1920x1080)", async () => {
      await c.viewport(1920, 1080);
      for (const p of PAGES) {
        await c.goto(url(kiosk, p)); await sleep(300);
        eq(c.consoleErrors.concat(c.exceptions, await c.eval("window.__errs")), [], p + " landscape: no errors");
        const m = await c.eval(`(function(){var r=function(s){var e=document.querySelector(s);if(!e)return null;var b=e.getBoundingClientRect();return {x:b.left,y:b.top,r:b.right,b:b.bottom,w:b.width,h:b.height}};var d=document.documentElement;
          return {sw:d.scrollWidth,sh:d.scrollHeight,order:r('.kg-order'),back:r('.kg-back'),board:r('.kg-board'),ctl:r('.kg-ctl'),grid:r('.pk-grid'),top:r('.kg-top')}})()`);
        ok(m.sw <= 1920 && m.sh <= 1080, p + " landscape: no scrolling");
        ok(m.order.h >= 64 && m.order.b <= 1080 && m.order.y >= 1080 * 0.7, p + " landscape: ORDER DRINKS visible at the bottom");
        if (m.board) ok(m.board.y >= 0 && m.board.b <= m.ctl.y + 2 && m.ctl.b <= m.order.y + 2 && m.board.w > 300, p + " landscape: board, controls and the bar do not overlap");
        else ok(m.grid.b <= m.order.y + 2 && m.grid.y >= m.top.y, p + " landscape: tiles above the bar");
        if (out) await c.shot("landscape-" + (p.split("/").pop() || "x") + ".png");
      }
      await c.viewport(VW, VH);
    });

    /* ======================= B. touch play ======================= */
    await section("B1. Thirsty Blaster: drag from the lower screen, pause, stray fingers, palm", async () => {
      const g = "thirsty-blaster", cfg = GAMES[g];
      await installMock(c);
      await c.goto(url(kiosk, "/arcade/games/" + g));
      await c.tapEl(cfg.start);
      eq(await c.eval(cfg.mode), "playing", "Start by tap");
      const b = await c.rect("#tbBoard");
      // a finger in the empty strip beside the board steers (x maps to the board) and squirts while it touches
      await c.touch("touchStart", [{ id: 1, x: 40, y: Math.round(b.y + 500) }]); await sleep(200);
      ok(await c.eval("window.__tb.input.firing"), "squirts while a finger touches");
      await c.touch("touchMove", [{ id: 1, x: Math.round(b.x + b.w * 0.75), y: Math.round(b.y + 500) }]); await sleep(150);
      const tx = await c.eval("window.__tb.input.targetX");
      ok(Math.abs(tx - 270) < 12, "targetX follows the finger (" + tx + ")");
      // a second finger and a palm: ignored, and lifting them does not stop the first
      await c.touch("touchStart", [{ id: 1, x: Math.round(b.x + b.w * 0.75), y: Math.round(b.y + 500) }, { id: 2, x: 120, y: 900 }]); await sleep(120);
      await c.touch("touchMove", [{ id: 1, x: Math.round(b.x + b.w * 0.75), y: Math.round(b.y + 500) }, { id: 2, x: 130, y: 910 }]); await sleep(120);
      ok(Math.abs((await c.eval("window.__tb.input.targetX")) - 270) < 12, "a second finger does not take over");
      await c.touch("touchEnd", [{ id: 2, x: 130, y: 910 }]); await sleep(120);   // the stray (id 2) lifts, the first stays down
      ok(await c.eval("window.__tb.input.firing"), "lifting the stray finger keeps the first one squirting");
      await c.touch("touchEnd", []); await sleep(120);
      ok(!(await c.eval("window.__tb.input.firing")), "lifting the last finger stops the stream");
      await c.touch("touchStart", [{ id: 5, x: 500, y: 700, r: 160 }]); await sleep(150);
      ok(!(await c.eval("window.__tb.input.firing")), "a palm-sized contact does not steer");
      await c.touch("touchEnd", []);
      // flavor button by tap, pause and resume by tap
      await c.tapEl('.tb-flavor[data-flavor="2"]');
      eq(await c.eval("document.querySelector('.tb-flavor[data-flavor=\"2\"]').getAttribute('aria-pressed')"), "true", "flavor by tap");
      await c.tapEl(cfg.pause); eq(await c.eval(cfg.mode), "paused", "Pause by tap");
      if (out) await c.shot("portrait-thirsty-blaster-paused.png");
      await c.tapEl(cfg.resume); eq(await c.eval(cfg.mode), "playing", "Resume by tap");
      const strip = await c.rect(".kg-ctl");
      await c.touch("touchStart", [{ id: 1, x: 300, y: Math.round(strip.y + 20) }]); await sleep(150);
      ok(await c.eval("window.__tb.input.firing"), "steering also works from the control strip at the bottom");
      if (out) await c.shot("portrait-thirsty-blaster-play.png");
      await c.touch("touchEnd", []);
    });

    await section("B2. Thirsty Tower: move + jump at once, pause", async () => {
      const g = "thirsty-tower", cfg = GAMES[g];
      await c.goto(url(kiosk, "/arcade/games/" + g));
      await c.tapEl(cfg.start);
      eq(await c.eval(cfg.mode), "play", "Play by tap");
      const R = await c.rect("[data-ctl=right]"), J = await c.rect("#jumpBtn");
      ok(R.w >= 140 && R.h >= 140 && J.w >= 300 && J.h >= 140, "arrow and JUMP buttons are huge (" + [R.w, R.h, J.w, J.h].map(Math.round) + ")");
      const x0 = await c.eval("window.__tbdbg.g.p.x");
      await c.touch("touchStart", [{ id: 11, x: Math.round(R.x + R.w / 2), y: Math.round(R.y + R.h / 2) }]); await sleep(500);
      await c.touch("touchStart", [{ id: 11, x: Math.round(R.x + R.w / 2), y: Math.round(R.y + R.h / 2) }, { id: 12, x: Math.round(J.x + J.w / 2), y: Math.round(J.y + J.h / 2) }]); await sleep(120);
      eq(await c.eval("[document.querySelector('[data-ctl=right]').classList.contains('is-down'),document.getElementById('jumpBtn').classList.contains('is-down')]"), [true, true], "both fingers register at once (multi-touch)");
      await sleep(300);
      const x1 = await c.eval("window.__tbdbg.g.p.x");
      ok(x1 > x0 + 10, "holding the right arrow runs the player (" + x0 + " -> " + x1 + ")");
      await c.touch("touchEnd", [{ id: 12, x: Math.round(J.x + J.w / 2), y: Math.round(J.y + J.h / 2) }]); await sleep(100);   // jump finger lifted
      eq(await c.eval("[document.querySelector('[data-ctl=right]').classList.contains('is-down'),document.getElementById('jumpBtn').classList.contains('is-down')]"), [true, false], "lifting the jump finger leaves the run held");
      await c.touch("touchEnd", []); await sleep(100);
      eq(await c.eval("document.querySelector('[data-ctl=right]').classList.contains('is-down')"), false, "released");
      await c.touch("touchStart", [{ id: 19, x: 700, y: 1500, r: 160 }]); await sleep(100);
      ok(!(await c.eval("[].some.call(document.querySelectorAll('.ctl'),function(e){return e.classList.contains('is-down')})")), "a palm-sized contact on the pad is ignored");
      await c.touch("touchEnd", []);
      await c.tapEl(cfg.pause); eq(await c.eval(cfg.mode), "paused", "Pause by tap");
      await c.tapEl(cfg.resume); eq(await c.eval(cfg.mode), "play", "Resume by tap");
      if (out) await c.shot("portrait-thirsty-tower-play.png");
    });

    await section("B3. Cup Catch: drag from the control strip, one pointer at a time", async () => {
      const g = "cup-catch", cfg = GAMES[g];
      await c.goto(url(kiosk, "/arcade/games/" + g));
      await c.tapEl(cfg.start); eq(await c.eval(cfg.mode), "playing", "Start by tap");
      const cv = await c.rect("#gameCanvas"), S = await c.rect(".kg-slide");
      const want = px => Math.max(30, Math.min(330, (px - cv.x) / cv.w * 360));
      const tx = Math.round(cv.x + cv.w * 0.8);
      await c.touch("touchStart", [{ id: 1, x: Math.round(S.x + 40), y: Math.round(S.y + S.h / 2) }]); await sleep(100);
      await c.touch("touchMove", [{ id: 1, x: tx, y: Math.round(S.y + S.h / 2) }]); await sleep(700);
      let cx = await c.eval("CupCatch.snapshot().cupX");
      ok(Math.abs(cx - want(tx)) < 25, "the cup follows a finger in the lower strip (" + Math.round(cx) + " vs " + Math.round(want(tx)) + ")");
      await c.touch("touchStart", [{ id: 1, x: tx, y: Math.round(S.y + S.h / 2) }, { id: 2, x: Math.round(cv.x + 30), y: 900 }]); await sleep(100);
      await c.touch("touchMove", [{ id: 1, x: tx, y: Math.round(S.y + S.h / 2) }, { id: 2, x: Math.round(cv.x + 40), y: 910 }]); await sleep(500);
      cx = await c.eval("CupCatch.snapshot().cupX");
      ok(Math.abs(cx - want(tx)) < 25, "a second finger does not steal the cup (" + Math.round(cx) + ")");
      await c.touch("touchEnd", [{ id: 2, x: Math.round(cv.x + 40), y: 910 }]); await sleep(100);       // the stray lifts
      const tx2 = Math.round(cv.x + cv.w * 0.25);
      await c.touch("touchMove", [{ id: 1, x: tx2, y: Math.round(S.y + S.h / 2) }]); await sleep(900);
      cx = await c.eval("CupCatch.snapshot().cupX");
      ok(Math.abs(cx - want(tx2)) < 25, "lifting the stray finger does not let go of the real one (" + Math.round(cx) + " vs " + Math.round(want(tx2)) + ")");
      await c.touch("touchEnd", []);
      await c.touch("touchStart", [{ id: 4, x: Math.round(cv.x + cv.w * 0.9), y: 1000, r: 160 }]); await sleep(500);
      cx = await c.eval("CupCatch.snapshot().cupX");
      ok(Math.abs(cx - want(tx2)) < 30, "a palm-sized contact does not move the cup");
      await c.touch("touchEnd", []);
      await c.tapEl(cfg.pause); eq(await c.eval(cfg.mode), "paused", "Pause by tap");
      await c.tapEl(cfg.resume); eq(await c.eval(cfg.mode), "playing", "Resume by tap");
      if (out) await c.shot("portrait-cup-catch-play.png");
    });

    await section("B4. Boardwalk Dash: hop pad, swipe, tap, stray finger", async () => {
      const g = "boardwalk-dash", cfg = GAMES[g];
      await c.goto(url(kiosk, "/arcade/games/" + g));
      await c.tapEl(cfg.start); eq(await c.eval(cfg.mode), "playing", "Start by tap");
      const row = () => c.eval("BoardwalkDash.getGame().p.row"), col = () => c.eval("BoardwalkDash.getGame().p.col");
      const P = await c.rect("[data-dir=up]");
      ok(P.h >= 140 && P.w >= 140, "hop buttons are huge");
      let r0 = await row(), c0 = await col();
      await c.tapEl("[data-dir=left]"); await sleep(250);
      ok((await col()) < c0 || (await row()) !== r0, "the left hop button moves (" + c0 + " -> " + (await col()) + ")");
      c0 = await col(); await c.tapEl("[data-dir=right]"); await sleep(250);
      ok((await col()) > c0 || (await c.eval("BoardwalkDash.getGame().p.state")) !== "alive", "the right hop button moves");
      const cv = await c.rect("#bdCanvas");
      c0 = await col();
      await c.touch("touchStart", [{ id: 1, x: Math.round(cv.x + cv.w / 2), y: Math.round(cv.y + cv.h / 2) }]);
      for (let i = 1; i <= 6; i++) { await c.touch("touchMove", [{ id: 1, x: Math.round(cv.x + cv.w / 2) + i * 25, y: Math.round(cv.y + cv.h / 2) }]); await sleep(40); }
      await c.touch("touchEnd", []); await sleep(200);
      ok((await col()) !== c0 || (await c.eval("BoardwalkDash.getGame().p.state")) !== "alive", "a slow swipe on the board hops");
      // a second finger mid-swipe does not start a second swipe or break the first
      await c.touch("touchStart", [{ id: 1, x: 300, y: 900 }]); await c.touch("touchStart", [{ id: 1, x: 300, y: 900 }, { id: 2, x: 700, y: 900 }]);
      await c.touch("touchMove", [{ id: 1, x: 300, y: 900 }, { id: 2, x: 400, y: 900 }]); await sleep(100);
      await c.touch("touchEnd", []);
      await c.touch("touchStart", [{ id: 3, x: 500, y: 900, r: 160 }]); r0 = await row(); await c.touch("touchEnd", []); await sleep(150);
      eq(await row(), r0, "a palm-sized tap on the board does not hop");
      ok((await c.eval(cfg.mode)) === "playing", "still playing after stray touches");
      await c.tapEl(cfg.pause); eq(await c.eval(cfg.mode), "paused", "Pause by tap");
      await c.tapEl(cfg.resume); eq(await c.eval(cfg.mode), "playing", "Resume by tap");
      if (out) await c.shot("portrait-boardwalk-dash-play.png");
    });

    await section("B5. Soft Serve Stacker: tap the board or DROP; two fingers = one drop", async () => {
      const g = "soft-serve-stacker", cfg = GAMES[g];
      await c.goto(url(kiosk, "/arcade/games/" + g));
      await c.tapEl(cfg.start); eq(await c.eval(cfg.mode), "playing", "Play by tap");
      const D = await c.rect("#btnDrop");
      ok(D.w >= 400 && D.h >= 140, "DROP is a huge button (" + Math.round(D.w) + "x" + Math.round(D.h) + ")");
      const waitAligned = async () => waitFor(async () => { const s = await c.eval("SoftServeStacker.getState()"); return s.phase === "playing" && s.pieceX != null && Math.abs(s.pieceX - s.topLeft) < s.topWidth * 0.25 ? s : null; }, 8000, "the swirl over the tower");
      await waitAligned();
      const cv = await c.rect("#stage");
      const before = (await c.eval("SoftServeStacker.getState()")).scoops;
      await c.touch("touchStart", [{ id: 1, x: Math.round(cv.x + 200), y: Math.round(cv.y + 400) }, { id: 2, x: Math.round(cv.x + 300), y: Math.round(cv.y + 420) }]); await sleep(60);
      await c.touch("touchEnd", []); await sleep(300);
      const after = (await c.eval("SoftServeStacker.getState()")).scoops;
      eq(after - before, 1, "two fingers landing together drop ONE scoop");
      await waitAligned();
      const b2 = (await c.eval("SoftServeStacker.getState()")).scoops;
      await c.tapEl("#btnDrop"); await sleep(300);
      ok((await c.eval("SoftServeStacker.getState()")).scoops === b2 + 1 || (await c.eval(cfg.mode)) !== "playing", "the DROP button drops a scoop");
      if ((await c.eval(cfg.mode)) === "playing") {
        await c.touch("touchStart", [{ id: 7, x: Math.round(cv.x + 200), y: Math.round(cv.y + 400), r: 160 }]); await c.touch("touchEnd", []); await sleep(150);
        ok((await c.eval("SoftServeStacker.getState()")).scoops === b2 + 1, "a palm-sized tap does not drop");
        await c.tapEl(cfg.pause); eq(await c.eval(cfg.mode), "paused", "Pause by tap");
        await c.tapEl(cfg.resume); eq(await c.eval(cfg.mode), "playing", "Resume by tap");
      }
      if (out) await c.shot("portrait-soft-serve-stacker-play.png");
    });

    /* ======================= C. game over, the server session, the result panel ======================= */
    await section("C1. every game: play to game over by touch; one start + one finish ({game} / {sid} only); plain thanks panel", async () => {
      for (const g of Object.keys(GAMES).filter(x => !process.env.ONLYGAME || x === process.env.ONLYGAME)) {
        const log = await installMock(c);
        await c.goto(url(kiosk, "/arcade/games/" + g));
        await c.tapEl(GAMES[g].start);
        await waitFor(async () => log.start.length === 1, 4000, g + " start request");
        eq(log.start, [{ game: g }], g + ": the start request names only the game");
        await driveToOver(c, g);
        await waitFor(async () => c.eval("!!document.getElementById('kpPanel')"), 6000, g + " result panel");
        eq(log.finish.length, 1, g + ": exactly one finish");
        eq(Object.keys(log.finish[0]), ["sid"], g + ": finish carries only the session id");
        ok(/^[a-f0-9]{24}$/.test(log.finish[0].sid), g + ": sid is the server's");
        const txt = await c.eval("document.getElementById('kpPanel').innerText");
        ok(/Thanks for playing/i.test(txt) && !(await c.eval("!!document.getElementById('kpCode')")), g + ": no win = plain thanks, no code");
        ok(!/almost|so close|odds|chance|try again to win/i.test(txt), g + ": no teasing, no odds in the thanks panel");
        eq(await c.eval("[].map.call(document.querySelectorAll('#kpPanel .kp-btn'),function(b){return b.textContent.trim()})"), ["PLAY AGAIN", "ALL GAMES", "ORDER DRINKS"], g + ": panel buttons");
        const nav = await c.rect("#kpPanel .kp-nav");
        ok(nav.y > VH * 0.6 && nav.h >= 64, g + ": panel buttons are in the lower part and big");
        ok(!c.requests.some(r => /\/api\/arcade\/spin/.test(r.url)), g + ": never calls the slot spin endpoint");
        if (out && g === "soft-serve-stacker") await c.shot("portrait-result-thanks.png");
        // PLAY AGAIN = a fresh run = a new start, and a second finish only after that run ends
        await c.tapEl("#kpPanel .kp-again");
        await waitFor(async () => log.start.length === 2, 4000, g + " second start");
        ok(!(await c.eval("!!document.getElementById('kpPanel')")), g + ": the panel closes on PLAY AGAIN");
        eq(log.finish.length, 1, g + ": no second finish until the second run ends");
      }
    });

    await section("C2. a mocked win: prize, code, expiry, order now, phone keypad (save and skip), number never stored", async () => {
      const g = "soft-serve-stacker";
      let log = await installMock(c, { win: true, code: "K7QD" });
      await c.goto(url(kiosk, "/arcade/games/" + g));
      await c.tapEl(GAMES[g].start);
      await driveToOver(c, g);
      await waitFor(async () => c.eval("!!document.getElementById('kpCode')"), 6000, "win panel");
      eq(await c.eval("document.getElementById('kpCode').textContent"), "K7QD", "the server's code, large");
      const t = await c.eval("document.getElementById('kpPanel').innerText");
      ok(/Free Size Upgrade/.test(t) && /Good until/.test(t) && /already added to your next order here/i.test(t) && /Take a photo or write it down/.test(t), "prize, expiry in words, 'already added' and the photo line");
      ok(!/odds|%/.test(t), "no odds stated");
      const code = await c.rect("#kpCode"); ok(code.h >= 120 && code.y > VH * 0.3, "the code is huge and in the lower area");
      if (out) await c.shot("portrait-result-win.png");
      eq(await c.eval("[].map.call(document.querySelectorAll('#kpPanel .kp-btn'),function(b){return b.textContent.trim()})"), ["ORDER NOW AND USE IT", "Save to phone", "Just give me a code", "PLAY AGAIN", "ALL GAMES", "ORDER DRINKS"]);
      const skip = await c.rect(".kp-btn--skip"), save = await c.rect(".kp-btn--save");
      ok(skip.h >= 120 && save.h >= 120 && Math.abs(skip.h - save.h) < 6, "'No thanks' is as big as 'Save'");
      await c.tapEl(".kp-btn--save");
      ok(await c.eval("!!document.getElementById('kpMonths') && !document.getElementById('kpPhone')"), "the age screen comes BEFORE any phone field");
      { const a = yearsAgo(30); await answerAge(c, a.month, a.year); await c.tapEl("#kpAgeGo"); }
      await waitFor(async () => c.eval("!!document.getElementById('kpPhone')"), 3000, "phone keypad after a 13+ answer");
      if (out) await c.shot("portrait-result-keypad.png");
      const pad = await c.rect("#kpPad"); ok(pad.y > VH * 0.35 && pad.y + pad.h <= VH, "the keypad is in the lower half (y " + Math.round(pad.y) + ")");
      const keys = await c.eval("[].map.call(document.querySelectorAll('#kpPad .kp-key'),function(b){var r=b.getBoundingClientRect();return [b.textContent.trim(),Math.min(r.width,r.height)]})");
      ok(keys.length === 12 && keys.every(k => k[1] >= 90), "twelve big keys");
      eq(keys.map(k => k[0]).join(""), "123456789BACK0⌫");
      const press = async d => { const els = await c.eval(`(function(){var k=[].filter.call(document.querySelectorAll('#kpPad .kp-key'),function(b){return b.textContent.trim()==='${d}'})[0];var r=k.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`); await c.tap(Math.round(els[0]), Math.round(els[1])); };
      ok(await c.eval("document.getElementById('kpSave').disabled"), "SAVE waits for 10 digits");
      for (const d of "5551234567") await press(d);
      eq(await c.eval("document.getElementById('kpPhone').textContent"), "(555) 123-4567", "formatted");
      ok(!(await c.eval("document.getElementById('kpSave').disabled")), "SAVE ready");
      await c.tapEl("#kpSave");
      await waitFor(async () => log.save.length === 1, 4000, "save request");
      eq(log.save[0], { phone: "5551234567", code: "K7QD" }, "the save request holds exactly the number and the win's code");
      await waitFor(async () => /ending in 67/.test(await c.eval("document.getElementById('kpMsg')?document.getElementById('kpMsg').textContent:''")), 4000, "saved message");
      ok(/We will not text it/.test(await c.eval("document.getElementById('kpMsg').textContent")), "says it will not be texted");
      eq(await c.eval("document.getElementById('kpCode').textContent"), "K7QD", "the code stays visible after saving");
      const dump = await c.eval("document.documentElement.outerHTML + JSON.stringify(localStorage) + JSON.stringify(sessionStorage) + document.cookie");
      ok(!/5551234567|\(555\)/.test(dump), "the typed number is nowhere in the page, storage or cookies afterwards");
      ok(!c.consoleErrors.some(e => /555/.test(e)), "never logged");
      ok(!(await c.eval("!!document.querySelector('.kp-btn--save')")), "the offer is gone once saved");
      // skip path: just the code, no save request
      log = await installMock(c, { win: true, code: "M3PA" });
      await c.goto(url(kiosk, "/arcade/games/" + g));
      await c.tapEl(GAMES[g].start); await driveToOver(c, g);
      await waitFor(async () => c.eval("!!document.getElementById('kpCode')"), 6000, "win panel 2");
      await c.tapEl(".kp-btn--skip");
      ok(!(await c.eval("!!document.querySelector('.kp-btn--save,.kp-btn--skip')")), "skipped: the offer is gone");
      eq(await c.eval("document.getElementById('kpCode').textContent"), "M3PA", "skipped: the code is still shown");
      eq(log.save.length, 0, "skipped: nothing was sent");
      // not saveable (Worker/station off) and not orderNow (useOnSameVisit false): no save offer, no 'already added' claim
      log = await installMock(c, { win: true, code: "N4RS", saveable: false, orderNow: false });
      await c.goto(url(kiosk, "/arcade/games/" + g));
      await c.tapEl(GAMES[g].start); await driveToOver(c, g);
      await waitFor(async () => c.eval("!!document.getElementById('kpCode')"), 6000, "win panel 3");
      const t3 = await c.eval("document.getElementById('kpPanel').innerText");
      ok(!/Save to phone/i.test(t3) && !/already added/i.test(t3) && /type your phone number or this code at the order screen/i.test(t3), "saveable:false / orderNow:false: no save button, no 'already added' promise");
      // a refused save says so and keeps the code
      log = await installMock(c, { win: true, code: "T5WX", saveReply: { ok: false, error: "already-have" } });
      await c.goto(url(kiosk, "/arcade/games/" + g));
      await c.tapEl(GAMES[g].start); await driveToOver(c, g);
      await waitFor(async () => c.eval("!!document.getElementById('kpCode')"), 6000, "win panel 4");
      await c.tapEl(".kp-btn--save");
      { const a = yearsAgo(40); await answerAge(c, a.month, a.year); await c.tapEl("#kpAgeGo"); }
      await waitFor(async () => c.eval("!!document.getElementById('kpPhone')"), 3000, "keypad");
      for (const d of "5559876543") { const els = await c.eval(`(function(){var k=[].filter.call(document.querySelectorAll('#kpPad .kp-key'),function(b){return b.textContent.trim()==='${d}'})[0];var r=k.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`); await c.tap(Math.round(els[0]), Math.round(els[1])); }
      await c.tapEl("#kpSave");
      await waitFor(async () => /already has a saved prize/.test(await c.eval("document.getElementById('kpMsg')?document.getElementById('kpMsg').textContent:''")), 4000, "already-have message");
      eq(await c.eval("document.getElementById('kpCode').textContent"), "T5WX");
    });

    /* ======================= C3. the legal pass: age check, phone prompt ======================= */
    const WIN_RESULT = "{ok:true,win:true,label:'Free Drink',code:'K7QD',expiresAt:Date.now()+86400000,orderNow:true,saveable:true}";
    const showWin = () => c.eval(`TBPrize.show({result:${WIN_RESULT},mode:'game'}); 1`);
    const panelText = () => c.eval("document.getElementById('kpPanel').innerText");
    await section("C3. age check before the phone field; exact prompt wording; under 13 = code only, no phone path again, nothing stored", async () => {
      const log = await installMock(c);
      await c.goto(url(kiosk, "/arcade/games"));
      await c.eval("sessionStorage.removeItem('tbPhonePathOff')");
      await showWin();
      await waitFor(async () => c.eval("!!document.getElementById('kpPrompt')"), 3000, "the phone prompt");
      await waitFor(async () => /24 hours/.test(await c.eval("document.getElementById('kpPrompt').textContent")), 3000, "life from the rules");
      eq(await c.eval("document.getElementById('kpPrompt').textContent"), "Save this prize to a phone number? We use it only to find your prize next time. No calls, texts, or lists. Deleted when used or in 24 hours.", "the memo wording, with the duration this build really has");
      const sv = await c.rect(".kp-btn--save"), sk = await c.rect(".kp-btn--skip");
      eq([await c.eval("document.querySelector('.kp-btn--save').textContent"), await c.eval("document.querySelector('.kp-btn--skip').textContent")], ["Save to phone", "Just give me a code"]);
      ok(Math.abs(sv.w - sk.w) < 3 && Math.abs(sv.h - sk.h) < 3 && sv.h >= 120, "the two choices are the same size and big: " + [sv.w, sv.h, sk.w, sk.h].map(Math.round));
      ok(sv.y > VH * 0.45 && sk.y > VH * 0.45, "both in the lower half");
      ok(!/anonymous|30 days|grown|parent/i.test(await panelText()), "no 'anonymous', no '30 days', no grown-up wording");
      if (out) await c.shot("portrait-phone-prompt.png");
      // the age screen
      await c.tapEl(".kp-btn--save");
      eq(await c.eval("document.getElementById('kpPanel').querySelector('.kp-title').textContent"), "To save to a phone number, enter your birth month and year.");
      eq(await c.eval("document.querySelectorAll('.kp-month').length"), 12, "twelve month buttons");
      eq(await c.eval("[].some.call(document.querySelectorAll('.kp-month'),function(b){return b.getAttribute('aria-pressed')==='true'})"), false, "no month is preselected");
      eq(await c.eval("document.getElementById('kpYear').textContent"), "____", "no default year");
      ok(await c.eval("document.getElementById('kpAgeGo').disabled"), "CONTINUE waits for an answer");
      const t = await panelText();
      ok(!/13|under|minor|child|kid|parent|grown|older|years? old|age\b/i.test(t.replace("To save to a phone number, enter your birth month and year.", "")), "no age hint on the age screen: " + t.replace(/\n/g, " | ").slice(0, 160));
      const mo = await c.rect(".kp-month"); ok(mo.h >= 64 && mo.y > VH * 0.3, "month buttons are big and low");
      if (out) await c.shot("portrait-age-screen.png");
      // impossible answers ask again
      const cy = new Date().getFullYear();
      await answerAge(c, 6, cy + 1); await c.tapEl("#kpAgeGo");
      eq(await c.eval("document.getElementById('kpMsg').textContent"), "Please check the year.", "a year in the future");
      eq(await c.eval("document.getElementById('kpYear').textContent"), "____", "the answer is cleared");
      eq(await c.eval("[].some.call(document.querySelectorAll('.kp-month'),function(b){return b.getAttribute('aria-pressed')==='true'})"), false, "and the month too");
      await answerAge(c, 6, 1899); await c.tapEl("#kpAgeGo");
      eq(await c.eval("document.getElementById('kpMsg').textContent"), "Please check the year.", "before 1900");
      if (new Date().getMonth() < 11) { await answerAge(c, 12, cy); await c.tapEl("#kpAgeGo"); eq(await c.eval("document.getElementById('kpMsg').textContent"), "Please check the year.", "a month still to come this year"); }
      eq(await c.eval("!!document.getElementById('kpPhone')"), false, "no phone field while the answer is impossible");
      eq(log.save.length, 0, "the age screen sent nothing to the server");
      // the rule itself: 156 months or fewer is under 13
      eq(await c.eval("[TBPrize.ageVerdict(11,2013,new Date(2026,10,1)),TBPrize.ageVerdict(10,2013,new Date(2026,10,1)),TBPrize.ageVerdict(1,2026,new Date(2026,10,1)),TBPrize.ageVerdict(0,2000),TBPrize.ageVerdict(5,2027,new Date(2026,10,1))]"), ["under", "ok", "under", null, null], "the 156-month boundary");
      // under 13: straight to the code, nothing stored, no mention of age
      const kid = yearsAgo(9); await answerAge(c, kid.month, kid.year);
      const reqsBefore = c.requests.length;
      await c.tapEl("#kpAgeGo");
      await waitFor(async () => c.eval("!!document.getElementById('kpCode') && !document.getElementById('kpMonths')"), 3000, "the code screen");
      eq(await c.eval("document.getElementById('kpCode').textContent"), "K7QD", "the code is shown");
      eq(await c.eval("!!document.querySelector('.kp-btn--save,.kp-btn--skip,#kpPhone,#kpPrompt')"), false, "no phone block");
      ok(!/age|13|under|birth|parent|grown/i.test(await panelText()), "age is not mentioned after an under-13 answer");
      eq(await c.eval("sessionStorage.getItem('tbPhonePathOff')"), "1", "a bare flag closes the phone path for the visit");
      const keys = await c.eval("Object.keys(sessionStorage).concat(Object.keys(localStorage)).filter(function(k){return k!=='tbGamesVisit'&&!/best/i.test(k)})");
      eq(keys, ["tbPhonePathOff"], "nothing else stored (no age, no birth date, no number)");
      const dump = await c.eval("document.documentElement.outerHTML + JSON.stringify(sessionStorage) + JSON.stringify(localStorage) + document.cookie");
      ok(!new RegExp(String(kid.year)).test(dump.replace(/\d{13}/g, "")), "the birth year is nowhere in the page or storage");
      ok(!c.requests.slice(reqsBefore).some(r => /api\/arcade\/(wallet|code)/.test(r.url) || new RegExp(String(kid.year)).test(r.body || "")), "nothing was sent");
      ok(!c.consoleErrors.some(e => new RegExp(String(kid.year)).test(e)), "never logged");
      // no phone path again this visit: another win, PLAY AGAIN, another game page
      await c.eval("TBPrize.hide()"); await showWin();
      await waitFor(async () => c.eval("!!document.getElementById('kpCode')"), 3000, "second win panel");
      eq(await c.eval("!!document.querySelector('.kp-btn--save,#kpPrompt')"), false, "no phone offer on the next win");
      await c.goto(url(kiosk, "/arcade/games/cup-catch")); await showWin();
      await waitFor(async () => c.eval("!!document.getElementById('kpCode')"), 3000, "win panel on another game");
      eq(await c.eval("!!document.querySelector('.kp-btn--save,#kpPrompt')"), false, "still closed on another game in the same visit");
      // ORDER DRINKS keeps the flag (the order screen honours it and clears it at its own reset); a stale visit clears it
      await c.eval("TBPrize.hide(); sessionStorage.setItem('tbGamesVisit', JSON.stringify({s:Date.now()-400000,l:Date.now()-400000}))");
      await c.goto(url(kiosk, "/arcade/games/cup-catch"));
      eq(await c.eval("sessionStorage.getItem('tbPhonePathOff')"), null, "a stale visit (the person walked away) gives the next one the phone choice back");
      await showWin();
      await waitFor(async () => c.eval("!!document.getElementById('kpPrompt')"), 3000, "phone prompt is back");
      // a 13+ answer reaches the phone keypad; Back from the age screen returns to the prompt
      await c.tapEl(".kp-btn--save");
      await c.tapEl("#kpPad .kp-key--fn");                 // BACK
      await waitFor(async () => c.eval("!!document.getElementById('kpPrompt')"), 3000, "back to the prompt");
      await c.tapEl(".kp-btn--save"); const adult = yearsAgo(14, 1); await answerAge(c, adult.month, adult.year); await c.tapEl("#kpAgeGo");
      await waitFor(async () => c.eval("!!document.getElementById('kpPhone')"), 3000, "keypad for 13+");
      ok(/Deleted when used or in 24 hours/.test(await panelText()), "the disclosure sits next to the phone field");
      ok(!c.consoleErrors.length, "no console errors: " + c.consoleErrors.join(" | "));
      // leaving hands-off drops the flag for the next customer
      await c.eval("sessionStorage.setItem('tbPhonePathOff','1'); TBK.leaveHandsOff(); 1");
      await waitFor(async () => (await c.eval("location.pathname")) === "/", 6000, "hands-off return");
      eq(await c.eval("sessionStorage.getItem('tbPhonePathOff')"), null, "the hands-off return clears the flag");
    });

    /* ======================= C4. rules panel, "prizes are done today" ======================= */
    await section("C4. rules panel from the server's facts (placeholders, safe fallback); capped banner before play; RULES on every start screen", async () => {
      let log = await installMock(c);
      await c.goto(url(kiosk, "/arcade/games"));
      await c.tapEl("#kgRules");
      await waitFor(async () => c.eval("document.getElementById('krPanel') && /Promotion period/.test(document.getElementById('krPanel').innerText)"), 4000, "the full rules");
      const t = await c.eval("document.getElementById('krPanel').innerText");
      for (const part of ["Prize Game Rules", "Free to play. No purchase needed to play or win.", "One random prize chance per visit, shared by the slot machine and the games; most visits don't win.", "Free drink: no more than 1 in 50 games.", "Free Size Upgrade (used on a drink you order)", "Free Drink (no purchase needed)",
        "Any prize can be swapped for a sticker, no purchase.", "Limited prizes each day; when they're gone, games are just for fun.", "One prize per person per day.", "Prizes expire 24 hours after winning. No cash value.", "Promotion period:", "Sponsor:", "St. George, UT", "Full rules and privacy:"]) ok(t.includes(part), "rules say: " + part);
      eq(await c.eval("[].map.call(document.querySelectorAll('#krPanel .kr-ph'),function(e){return e.textContent.split(':')[0]})"), ["[PROMOTION START", "[PROMOTION END", "[SPONSOR NAME", "[SPONSOR ADDRESS", "[RULES AND PRIVACY WEB ADDRESS"], "every unknown fact is a visible placeholder, none invented");
      ok(!/jackpot|anonymous|%|odds/i.test(t), "no jackpot, no percentages, no 'odds'");
      const card = await c.rect(".kr-card"), cl = await c.rect("#krClose");
      ok(card.y >= 0 && card.y + card.h <= VH + 1 && cl.h >= 100 && cl.y > VH * 0.6, "fits one screen with a big CLOSE in the lower area");
      ok(await c.eval("var b=document.getElementById('krBody');b.scrollHeight<=b.clientHeight+2"), "no scrolling needed");
      if (out) await c.shot("portrait-rules-panel.png");
      await c.tapEl("#krClose"); eq(await c.eval("!!document.getElementById('krPanel')"), false, "CLOSE works");
      // filled-in values replace the placeholders; the 'most games' sentence follows the server's flag
      const filled = JSON.parse(JSON.stringify(RULES_OK)); Object.assign(filled.rules, { sponsorName: "Test Sponsor LLC", sponsorAddress: "1 Test St", promoStart: "Dec 1, 2026", promoEnd: "Dec 31, 2026", rulesUrl: "example.test/rules", missing: [], mostGamesDoNotWin: false, stickerSwap: false, onePerPersonPerDay: false, limitedPrizesDaily: false });
      await installMock(c, { rules: filled });
      await c.goto(url(kiosk, "/arcade/games")); await c.tapEl("#kgRules");
      await waitFor(async () => c.eval("document.getElementById('krPanel') && /Test Sponsor LLC/.test(document.getElementById('krPanel').innerText)"), 4000, "filled rules");
      const t2 = await c.eval("document.getElementById('krPanel').innerText");
      ok(/Dec 1, 2026 to Dec 31, 2026/.test(t2) && /Test Sponsor LLC, 1 Test St, St. George, UT/.test(t2) && /example\.test\/rules/.test(t2), "owner facts shown");
      ok(!/most visits don't win/.test(t2) && !/swapped for a sticker/.test(t2) && !/One prize per person/.test(t2) && !/Limited prizes/.test(t2), "sentences the server did not switch on are not said");
      eq(await c.eval("document.querySelectorAll('#krPanel .kr-ph').length"), 0, "no placeholders left");
      // the rules cannot be fetched: only the safe lines, no prize list, no odds
      await installMock(c, { rules: null });
      await c.goto(url(kiosk, "/arcade/games")); await c.tapEl("#kgRules");
      await waitFor(async () => c.eval("document.getElementById('krPanel') && /could not be loaded/.test(document.getElementById('krPanel').innerText)"), 4000, "fallback text");
      const t3 = await c.eval("document.getElementById('krPanel').innerText");
      ok(/Free to play. No purchase needed to play or win./.test(t3) && !/Prizes:|1 in|prize chance|expire/.test(t3), "fallback: only the safe lines");
      // capped: the banner BEFORE play (picker + each start screen), and no 'chance at a prize' line
      await installMock(c, { status: { ok: true, prizes: true, capped: true, period: "", version: 1 } });
      await c.goto(url(kiosk, "/arcade/games"));
      await waitFor(async () => /Prizes are done for today/.test(await c.eval("document.querySelector('[data-kg-prizeline]').textContent")), 4000, "capped banner on the picker");
      eq(await c.eval("document.querySelector('[data-kg-prizeline]').textContent"), "Prizes are done for today. Play for fun.");
      if (out) await c.shot("portrait-picker-capped.png");
      for (const g of Object.keys(GAMES)) {
        await c.goto(url(kiosk, "/arcade/games/" + g));
        await waitFor(async () => /Prizes are done for today/.test(await c.eval("document.querySelector('[data-kg-prizeline]').textContent")), 4000, g + " capped line");
        ok(!/prize chance per visit/i.test(await c.eval("document.body.innerText")), g + ": no 'chance at a prize' while capped");
        if (g === "soft-serve-stacker" && out) await c.shot("portrait-capped-banner.png");
      }
      // not capped: the chance line; prizes off: nothing promised; every start screen has a big RULES button that opens the panel
      await installMock(c);
      for (const g of Object.keys(GAMES)) {
        await c.goto(url(kiosk, "/arcade/games/" + g));
        await waitFor(async () => /One prize chance per visit/.test(await c.eval("document.querySelector('[data-kg-prizeline]').textContent")), 4000, g + " chance line");
        const rb = await c.rect("[data-kg-rules]"); ok(rb && rb.h >= 64 && rb.y > VH * 0.3 && rb.y + rb.h < VH, g + ": RULES button is big and in the lower area (y " + Math.round(rb.y) + ", h " + Math.round(rb.h) + ")");
        await c.tapEl("[data-kg-rules]");
        await waitFor(async () => c.eval("!!document.getElementById('krPanel')"), 3000, g + " rules open"); await c.tapEl("#krClose");
        if (g === "thirsty-tower" && out) await c.shot("portrait-tower-start-rules.png");
      }
      await installMock(c, { status: { ok: true, prizes: false, capped: false } });
      await c.goto(url(kiosk, "/arcade/games/cup-catch")); await sleep(600);
      eq(await c.eval("document.querySelector('[data-kg-prizeline]').textContent"), "", "no key / offline: nothing about prizes is promised");
      ok(!c.consoleErrors.length, "no console errors: " + c.consoleErrors.join(" | "));
    });

    await section("C5. the slots dock: RULES beside MORE GAMES and ORDER DRINKS, nothing overlapping", async () => {
      await installMock(c);
      await c.goto(kiosk.base + "/arcade");
      const [r, m, o] = [await c.rect("#rulesBtn"), await c.rect("#moreGamesBtn"), await c.rect("#orderDrinksBtn")];
      ok(r && m && o && r.h >= 64 && r.x >= m.x + m.w - 1 && o.x >= r.x + r.w - 1, "three buttons side by side: " + [m.x, r.x, o.x].map(Math.round));
      if (out) await c.shot("portrait-slots-dock.png");
      await c.tapEl("#rulesBtn");
      await waitFor(async () => c.eval("!!document.getElementById('krPanel')"), 3000, "rules on the slots page");
      ok(/Prize Game Rules/.test(await c.eval("document.getElementById('krPanel').innerText")), "the panel");
      if (out) await c.shot("portrait-slots-rules.png");
      await c.tapEl("#krClose");
    });

    /* ======================= C5b. one prize chance per visit, said plainly ======================= */
    await section("C5b. the one prize chance per visit: told before play, and plainly once it is used (slot page and games)", async () => {
      const NOTICE = "That was your prize chance this visit. Keep playing for fun.";
      const st = left => ({ ok: true, prizes: true, capped: false, rollsLeft: left, period: "", version: 1 });
      await installMock(c, { status: st(1) });
      await c.goto(kiosk.base + "/arcade");
      await waitFor(async () => /ONE PRIZE CHANCE PER VISIT/.test(await c.eval("document.getElementById('bezelStatus').textContent")), 4000, "slot page says one chance per visit before play");
      eq(await c.eval("document.body.dataset.chance"), "open", "open");
      await installMock(c, { status: st(0) });
      await c.goto(kiosk.base + "/arcade");
      await waitFor(async () => (await c.eval("document.getElementById('bezelStatus').textContent")) === NOTICE, 4000, "slot page says the chance is used");
      ok(!/FREE DRINK JACKPOT/i.test(await c.eval("document.querySelector('.led-ticker').textContent")), "and the ticker no longer advertises prizes");
      eq(await c.eval("document.body.dataset.chance"), "used", "used");
      { const t = await c.eval("document.body.textContent"); ok(!/SPIN TO WIN/.test(await c.eval("document.getElementById('reel3Val').textContent")) && /not this visit/.test(await c.eval("document.querySelector('.paytable__h').textContent")) && !/chance at a boardwalk prize/.test(await c.eval("document.getElementById('barkerMsg').textContent")), "once the chance is used the cabinet no longer says SPIN TO WIN, the awards read 'not this visit' and the barker stops promising a prize"); }
      if (out) await c.shot("portrait-slots-chance-used.png");
      for (const g of ["soft-serve-stacker", "cup-catch"]) {
        await installMock(c, { status: st(0) });
        await c.goto(url(kiosk, "/arcade/games/" + g));
        await waitFor(async () => (await c.eval("document.querySelector('[data-kg-prizeline]').textContent")) === NOTICE, 4000, g + " start card says the chance is used");
      }
      // after a finished game with the chance spent, the plain thanks says it too (status read after the finish)
      const g = "soft-serve-stacker"; await installMock(c, { status: st(0) });
      await c.goto(url(kiosk, "/arcade/games/" + g)); await c.tapEl(GAMES[g].start); await driveToOver(c, g);
      await waitFor(async () => c.eval("!!document.getElementById('kpPanel')"), 6000, "thanks panel");
      ok((await c.eval("document.getElementById('kpPanel').innerText")).includes(NOTICE), "the thanks panel says it was the visit's one chance");
      ok(!/code/i.test(await c.eval("document.getElementById('kpPanel').innerText")), "no code, no tease");
      if (out) await c.shot("portrait-thanks-chance-used.png");
      // chance still open: the start line says one chance per visit
      await installMock(c, { status: st(1) });
      await c.goto(url(kiosk, "/arcade/games/" + g));
      await waitFor(async () => /One prize chance per visit/.test(await c.eval("document.querySelector('[data-kg-prizeline]').textContent")), 4000, "start card says one chance per visit");
    });

    /* ======================= C6. the shipped files say none of the banned things ======================= */
    await section("C6. static check of kiosk/games/**: no reels, jackpot, bet, anonymous, grown-up or parent wording; no external host", async () => {
      const fs = require("fs"), path = require("path");
      const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
      const files = walk(path.join(L.ROOT || path.resolve(__dirname, "../.."), "kiosk", "games")).filter(f => /\.(html|js|css)$/.test(f));
      ok(files.length > 20, "found the shipped files: " + files.length);
      for (const f of files) {
        const src = fs.readFileSync(f, "utf8");
        const bad = /\b(jackpot|spin to win|bet|bets|betting|wager|anonymous|grown-?up|parent'?s?)\b/i.exec(src);
        ok(!bad, path.basename(f) + " contains banned wording: " + (bad && bad[0]));
        ok(!/https?:\/\/(?!www\.w3\.org)/i.test(src.replace(/example\.test/g, "")), path.basename(f) + " has an external URL");
      }
    });

    /* ======================= C7. the art (v46): every image comes from the kiosk, nothing breaks without it ======================= */
    await section("C7. every page loads all its images from the kiosk (200, right type, no CSP violation, no external host); a blocked image falls back and the game still plays", async () => {
      const A = "/kiosk/games/";
      const EXPECT = {
        "/arcade/games": ["shared/assets/miami-backdrop.webp", "assets/tile-thirsty-blaster.webp", "assets/tile-thirsty-tower.webp", "assets/tile-cup-catch.webp", "assets/tile-boardwalk-dash.webp", "assets/tile-soft-serve-stacker.webp", "assets/tile-slots.webp"],
        "/arcade/games/thirsty-blaster": ["shared/assets/miami-backdrop.webp", "thirsty-blaster/assets/bg-miami-beach.webp", "thirsty-blaster/assets/blaster-bot.png"],
        "/arcade/games/thirsty-tower": ["shared/assets/miami-backdrop.webp", "thirsty-tower/assets/bg-miami-tower.webp", "thirsty-tower/assets/crab.png"],
        "/arcade/games/cup-catch": ["shared/assets/miami-backdrop.webp", "cup-catch/assets/bg-miami-counter.webp", "cup-catch/assets/customer.png"],
        "/arcade/games/boardwalk-dash": ["shared/assets/miami-backdrop.webp", "boardwalk-dash/assets/trailer.png", "boardwalk-dash/assets/sandcastle.png", "boardwalk-dash/assets/crab.png"],
        "/arcade/games/soft-serve-stacker": ["shared/assets/miami-backdrop.webp", "soft-serve-stacker/assets/bg-miami-pier.webp", "soft-serve-stacker/assets/cone.png"],
      };
      await installMock(c);
      for (const [page, files] of Object.entries(EXPECT)) {
        await c.goto(url(kiosk, page)); await sleep(1500);
        for (const f of files) {
          const r = c.responses.find(x => x.url.endsWith(A + f));
          ok(r && r.status === 200 && /^image\/(webp|png)$/.test(r.mime), page + ": " + f + " loaded from the kiosk (200 " + (r && r.mime) + ")");
        }
        ok(c.responses.filter(x => x.url.includes("/assets/")).every(x => x.status === 200), page + ": no asset answered an error");
        ok(c.requests.every(r => /^(http:\/\/127\.0\.0\.1:|data:)/.test(r.url)), page + ": nothing requested from outside the kiosk");
        eq(await c.eval("window.__errs.length"), 0, page + ": no script error and no CSP violation");
        eq(c.exceptions.length, 0, page + ": no exception");
        if (page === "/arcade/games") ok(await c.eval("[].every.call(document.images,function(i){return i.complete&&i.naturalWidth>0})"), "every picker tile image decoded");
      }
      // served with the right type and nothing reachable by traversal
      for (const [f, t] of [["thirsty-blaster/assets/blaster-bot.png", "image/png"], ["shared/assets/miami-backdrop.webp", "image/webp"], ["fonts/bungee.woff2", "font/woff2"]]) {
        const r = await req(kiosk.port, "GET", "/kiosk/games/" + f); eq([r.status, String(r.headers["content-type"]).split(";")[0]], [200, t], f + " content type");
      }
      for (const bad of ["/kiosk/games/../../kiosk-server.js", "/kiosk/games/thirsty-blaster/assets/..%2f..%2f..%2f..%2fkiosk-server.js", "/kiosk/games/%2e%2e/%2e%2e/kiosk-server.js", "/kiosk/games/thirsty-blaster/assets/blaster-bot.png%00.js", "/kiosk/games/thirsty-blaster/assets/"]) {
        const r = await req(kiosk.port, "GET", bad); ok([400, 403, 404].includes(r.status) && !/createServer/.test(r.body || ""), bad + " -> " + r.status);
      }
      const csp = String((await req(kiosk.port, "GET", "/arcade/games/cup-catch")).headers["content-security-policy"]);
      ok(/img-src 'self' data:/.test(csp) && !/img-src[^;]*https?:/.test(csp) && /default-src 'none'/.test(csp), "game pages: images from 'self' only (data: for the heart mask and favicon), no external host: " + csp.slice(0, 120));
      // one image blocked: the previous drawn art takes over, the game starts and runs, no exception
      await c.S("Network.setBlockedURLs", { urls: ["*assets/*"] });
      try {
        for (const g of Object.keys(GAMES)) {
          await c.goto(url(kiosk, "/arcade/games/" + g)); await sleep(800);
          await c.tapEl(GAMES[g].start);
          await waitFor(async () => (await c.eval(GAMES[g].mode)) === GAMES[g].playing, 5000, g + " starts with every image blocked");
          await sleep(1200);
          eq(await c.eval(GAMES[g].mode), GAMES[g].playing, g + ": still running (no stall waiting on an image)");
          eq(c.exceptions.length, 0, g + ": no exception in the draw loop without its images");
          ok(c.consoleErrors.every(e => /ERR_BLOCKED_BY_CLIENT|blocked/i.test(e)), g + ": the only errors are the blocked loads: " + c.consoleErrors.slice(0, 2).join(" | "));
          if (g === "thirsty-blaster" && out) await c.shot("portrait-fallback-no-images.png");
        }
        await c.goto(url(kiosk, "/arcade/games")); await sleep(800);
        eq(await c.eval("[].filter.call(document.querySelectorAll('.pk-tile'),function(t){var r=t.getBoundingClientRect();return r.width>200&&r.height>200}).length"), 6, "picker: six tappable tiles even with no art");
      } finally { await c.S("Network.setBlockedURLs", { urls: [] }); }
    });

    /* ======================= C8. the slot reel icons (v48): PNGs through <use>, with the vector art as a fallback ======================= */
    await section("C8. all nine reel icons load as image/png from the kiosk (no external host); a missing icon falls back to its vector drawing, never an empty cell", async () => {
      const NAMES = ["soda", "energy", "coffee", "hot", "freeze", "palm", "pineapple", "charm", "jackpot"];
      await installMock(c);
      await c.goto(kiosk.base + "/arcade"); await sleep(1500);
      for (const n of NAMES) {
        const r = c.responses.find(x => x.url.endsWith("/kiosk/assets/slots/ico-" + n + ".png"));
        ok(r && r.status === 200 && r.mime === "image/png", "ico-" + n + ".png loaded (200 " + (r && r.mime) + ")");
        eq(await c.eval("document.querySelector('#ico-" + n + " .ico-vec').getAttribute('display')"), "none", n + ": the PNG shows, the vector fallback stays hidden");
      }
      ok(c.requests.every(r => /^(http:\/\/127\.0\.0\.1:|data:)/.test(r.url)), "nothing requested from outside the kiosk");
      eq(await c.eval("window.__errs.length"), 0, "no script error, no CSP violation"); eq(c.exceptions.length, 0, "no exception");
      // every symbol that is used on the page actually paints: draw each through <use> and look for painted pixels
      eq(await c.eval("document.querySelectorAll('.reel__cell svg use').length > 8"), true, "reel cells use the symbols");
      // one icon blocked: ONLY that symbol falls back to its vector art
      await c.S("Network.setBlockedURLs", { urls: ["*ico-soda.png*"] });
      try {
        await c.goto(kiosk.base + "/arcade"); await sleep(1500);
        eq(await c.eval("document.querySelector('#ico-soda .ico-vec').hasAttribute('display')"), false, "ico-soda: vector fallback revealed");
        eq(await c.eval("document.querySelector('#ico-soda .ico-img').getAttribute('display')"), "none", "ico-soda: the broken image is hidden");
        eq(await c.eval("document.querySelector('#ico-energy .ico-vec').getAttribute('display')"), "none", "the other icons are untouched");
        await c.eval("document.getElementById('spinBtn').click()");
        await sleep(500); await waitFor(async () => c.eval("!document.getElementById('spinBtn').disabled"), 40000, "the spin to finish with an icon missing");   // by state, not by a fixed delay: a loaded machine just takes longer
        eq(c.exceptions.length, 0, "a spin with an icon missing throws nothing");
        if (out) await c.shot("portrait-slots-icon-fallback.png");
      } finally { await c.S("Network.setBlockedURLs", { urls: [] }); }
    });

    /* ======================= D. the visit ======================= */
    await section("D1. visit cap spans pages; Time's up stops audio and returns hands-off", async () => {
      const k2 = await stageKiosk({ session: { gameMaxSeconds: 30, endedReturnSeconds: 10 } });
      try {
        const log = await installMock(c);
        await c.goto(url(k2, "/arcade/games"));
        const l0 = await c.eval("document.querySelector('#kgTime b').textContent");
        ok(/^0:(2[89]|30)$/.test(l0), "the picker starts the visit: " + l0);
        await sleep(2200);
        await c.goto(url(k2, "/arcade/games/soft-serve-stacker"));
        const l1 = await c.eval("document.querySelector('#kgTime b').textContent");
        ok(/^0:(2[0-8])$/.test(l1), "the clock carries across pages: " + l1);
        await c.tapEl(GAMES["soft-serve-stacker"].start);
        await waitFor(async () => (await c.eval("window.__ctxs.length")) >= 1, 3000, "an audio context");
        ok((await c.eval("window.__ctxs.some(function(x){return x.state!=='closed'})")), "audio is running");
        await c.eval("window.__skew=31");
        await waitFor(async () => c.eval("!!document.getElementById('kgEnded')"), 4000, "Time's up panel");
        ok(/Time's up/.test(await c.eval("document.getElementById('kgEnded').innerText")), "says time is up");
        eq(await c.eval("window.__ctxs.every(function(x){return x.state==='closed'})"), true, "all audio stopped");
        eq(await c.eval("SoftServeStacker.getState().phase"), "paused", "the game was paused");
        const o = await c.rect("#kgEndedOrder"); ok(o.h >= 100 && o.y > VH * 0.55, "a huge ORDER DRINKS button in the lower area");
        if (out) await c.shot("portrait-times-up.png");
        eq(await c.eval("document.querySelector('#kgEndedOrder').getAttribute('href')"), "/#menu");
        // hands-off: ended panel returns to / after endedReturnSeconds (10), telling the kiosk to drop an unused pending prize first
        await c.goto(url(k2, "/arcade/games/soft-serve-stacker")); await c.eval("window.__skew=40");
        await waitFor(async () => c.eval("!!document.getElementById('kgEnded')"), 4000, "Time's up again");
        await c.eval("window.__skew=52");
        await waitFor(async () => (await c.eval("location.pathname")) === "/", 6000, "the hands-off return to the ordering screen");
        ok(log.dismiss.length >= 1, "the pending prize was dropped before leaving");
      } finally { k2.stop(); }
    });

    await section("D1b. a win that arrives AFTER the visit's time ran out is still shown (above Time's up), with no way to start another game; touchdebug overlay", async () => {
      const k5 = await stageKiosk({ session: { gameMaxSeconds: 30, endedReturnSeconds: 60 } });
      try {
        await installMock(c, { win: true, code: "K7QD" });
        await c.goto(url(k5, "/arcade/games/cup-catch"));
        // hold the finish reply, end the visit, then let the win through
        await c.eval("(function(){var f=window.fetch.bind(window);window.fetch=function(u,o){if(/game\\/finish/.test(u)){return new Promise(function(res){window.__release=function(){f(u,o).then(res)}})}return f(u,o)}})()");
        await c.eval("TBK.runStart('cup-catch')"); await sleep(400);
        await c.eval("TBK.runEnd();0");
        await c.eval("window.__skew=31");
        await waitFor(async () => c.eval("!!document.getElementById('kgEnded')"), 4000, "Time's up panel while the finish is in flight");
        await c.eval("window.__release()");
        await waitFor(async () => c.eval("!!document.getElementById('kpCode')"), 4000, "the win is shown after the visit ended");
        eq(await c.eval("document.getElementById('kpCode').textContent"), "K7QD", "the real code is on screen");
        ok(await c.eval("document.getElementById('kpPanel').classList.contains('kp-over-ended')"), "above the Time's up panel");
        eq(await c.eval("[].map.call(document.querySelectorAll('#kpPanel .kp-nav .kp-btn'),function(b){return b.textContent.trim()})"), ["ORDER DRINKS"], "only ORDER DRINKS: nothing starts another game");
        if (out) await c.shot("portrait-win-after-timeup.png");
        // the touch-size overlay is opt-in on the picker and only prints sizes
        await c.goto(url(k5, "/arcade/games") + "?touchdebug=1");
        ok(await c.eval("document.body.textContent.indexOf('touchdebug')>=0"), "?touchdebug=1 shows the overlay");
        await c.tap(540, 60); await sleep(150);
        ok(/contact \d+ x \d+ px/.test(await c.eval("document.body.textContent")), "and prints the contact size");
        await c.goto(url(k5, "/arcade/games")); ok(await c.eval("document.body.textContent.indexOf('touchdebug')<0"), "off without the flag");
        { const dash = require("fs").readFileSync(require("path").join(__dirname, "../../kiosk/games/boardwalk-dash/boardwalk-dash.js"), "utf8");
          ok(/canvas\.addEventListener\('lostpointercapture', swipeEnd\)/.test(dash) && /addEventListener\('blur', function \(\) \{ sid = null; \}\)/.test(dash) && /function newGame\(\) \{\s*sid = null;/.test(dash), "Boardwalk Dash releases its tracked finger on lost capture, blur and a new game like the other four"); }
      } finally { k5.stop(); }
    });

    await section("D2. 'Still playing?' then the hands-off return (calls dismiss first); a touch keeps the visit", async () => {
      const k3 = await stageKiosk({ session: { idleSeconds: 15, idleWarnSeconds: 5, gameMaxSeconds: 900 } });
      try {
        const log = await installMock(c);
        await c.goto(url(k3, "/arcade/games/cup-catch"));
        ok(await c.eval("document.getElementById('kgIdle').hidden"), "no warning while fresh");
        await c.eval("window.__skew=11");
        await waitFor(async () => !(await c.eval("document.getElementById('kgIdle').hidden")), 3000, "the Still playing? warning");
        const keep = await c.rect("#kgIdle .kg-btn"); ok(keep.h >= 100 && keep.y > VH * 0.55, "a big tap-to-continue button in the lower area");
        if (out) await c.shot("portrait-still-playing.png");
        await c.tapEl("#kgIdle .kg-btn");
        ok(await c.eval("document.getElementById('kgIdle').hidden"), "a tap dismisses it");
        await c.eval("window.__skew=40");
        await waitFor(async () => (await c.eval("location.pathname")) === "/", 6000, "the hands-off return");
        ok(log.dismiss.length >= 1 && c.requests.some(r => /pending\/dismiss/.test(r.url) && r.method === "POST"), "dismiss was sent before the return");
        ok(!c.requests.some(r => /\/api\/arcade\/spin/.test(r.url)), "no spin endpoint was ever used");
      } finally { k3.stop(); }
    });

    await section("D3. a missing or bad arcade-session.json means the defaults, never 'no limit'; enabled:false is the only way off", async () => {
      await installMock(c);
      for (const [label, body, status] of [["missing", "", 404], ["garbage", "{not json", 200], ["wrong types", JSON.stringify({ gameMaxSeconds: "x", idleSeconds: -3, endedReturnSeconds: null, enabled: "no" }), 200], ["tiny values", JSON.stringify({ gameMaxSeconds: 1, idleSeconds: 1 }), 200]]) {
        c.mocks.length = 0;
        await c.mock(/\/kiosk\/arcade-session\.json/, () => ({ status, body, type: "application/json" }));
        await c.mock(/\/api\/arcade\/(game|wallet|pending)/, () => ({ body: { ok: true } }));
        await c.goto(url(kiosk, "/arcade/games")); await c.eval("sessionStorage.clear()");   // a brand-new visit for each case
        await c.goto(url(kiosk, "/arcade/games")); await sleep(1300);
        const t = await c.eval("document.querySelector('#kgTime b').textContent");
        ok(/^2:(2\d|30)$|^2:1\d$/.test(t) && !(await c.eval("document.getElementById('kgTime').hidden")), label + ": the 2:30 default applies (" + t + ")");
      }
      c.mocks.length = 0;
      await c.mock(/\/kiosk\/arcade-session\.json/, () => ({ body: { enabled: false } }));
      await c.mock(/\/api\/arcade\/(game|wallet|pending)/, () => ({ body: { ok: true } }));
      await c.goto(url(kiosk, "/arcade/games")); await sleep(1300);
      ok(await c.eval("document.getElementById('kgTime').hidden"), "enabled:false switches the clock off (second-screen use)");
      c.mocks.length = 0;
    });

    /* ======================= E. the REAL server roll ======================= */
    await section("E. real server: a finished game rolls once (staff odds = always a prize); too soon, repeated and forged finishes get nothing", async () => {
      const k4 = await stageKiosk({ session: { gameMinSeconds: 5, gameMaxSeconds: 900, idleSeconds: 300 } });
      try {
        const odds = [["standard", 0], ["size_upgrade", 90], ["soft_serve_topper", 4], ["neon_charm", 2], ["topper_or_sticker", 2], ["free_drink_jackpot", 2]].map(([id, pct]) => ({ id, pct }));
        eq((await req(k4.port, "POST", "/api/arcade-config", { odds }, { "X-Key": "staff-secret-key-1234" })).status, 200, "staff odds: always a prize");
        c.mocks.length = 0; await c.S("Fetch.disable");
        await c.goto(k4.base + "/arcade"); await sleep(3000);         // the slot page warms the Worker play tokens (ready ~2 s later)
        const finishes = () => c.requests.filter(r => /game\/finish/.test(r.url));
        // 1. a run that ends in ~2 s: the server says too soon, so plain thanks even though every roll would win
        await c.goto(k4.base + "/arcade/games/soft-serve-stacker?debug");
        await c.tapEl("#btnStart"); await driveToOver(c, "soft-serve-stacker");
        await waitFor(async () => c.eval("!!document.getElementById('kpPanel')"), 6000, "panel after a quick run");
        eq(finishes().length, 1, "one finish");
        ok(!(await c.eval("!!document.getElementById('kpCode')")), "finished too soon: no prize, no code");
        const quickSid = JSON.parse(finishes()[0].body).sid;
        // 2. replaying that sid, and a made-up one, are refused
        eq((await req(k4.port, "POST", "/api/arcade/game/finish", { sid: quickSid })).status, 409, "the same game cannot roll twice");
        eq((await req(k4.port, "POST", "/api/arcade/game/finish", { sid: "0".repeat(24) })).status, 404, "a forged session id is refused");
        const forged = await req(k4.port, "POST", "/api/arcade/game/finish", { sid: "0".repeat(24), prizeId: "free_drink_jackpot", code: "ZZZZ", score: 99999, label: "FREE CAR" });
        eq([forged.status, forged.json.code], [404, undefined], "extra fields (prize, code, score) are never read");
        // 3. a real run that lasts longer than gameMinSeconds wins from the server's roll, and the code is the Worker's
        await c.tapEl("#kpPanel .kp-again");
        await sleep(5600);
        await driveToOver(c, "soft-serve-stacker");
        await waitFor(async () => c.eval("!!document.getElementById('kpCode')"), 8000, "a real win panel");
        eq(await c.eval("document.getElementById('kpCode').textContent"), k4.state.winCodes[0], "the code shown is the one the Worker issued");
        eq(k4.state.claimBodies.length, 1, "exactly one Worker claim for the one qualifying run");
        eq(k4.state.claimBodies[0].key, k4.KIOSK_KEY, "the claim carries the kiosk key from the server");
        ok(["size_upgrade", "soft_serve_topper", "neon_charm", "topper_or_sticker", "free_drink_jackpot"].includes(k4.state.claimBodies[0].body.prize.id), "an arcade prize id");
        const fin = finishes();
        eq(fin.length, 2, "two finishes in total (one per run)");
        eq(Object.keys(JSON.parse(fin[1].body)), ["sid"], "the page sent only the session id");
        eq(JSON.parse(c.requests.filter(r => /game\/start/.test(r.url))[1].body), { game: "soft-serve-stacker" }, "and only the game id on start");
        const pend = (await req(k4.port, "GET", "/api/arcade/pending")).json;
        eq(pend.pending && pend.pending.code, k4.state.winCodes[0], "the win is the kiosk's pending prize (orders use it automatically)");
        ok(!c.requests.some(r => /\/api\/arcade\/spin/.test(r.url)), "the games never use the slot spin endpoint");
        ok(!/k{30}|staff-secret/.test(await c.eval("document.documentElement.outerHTML")), "no key anywhere in the page");
      } finally { k4.stop(); }
    });
  } catch (e) { console.error(e && e.stack || e); process.exitCode = 1; }
  finally { c.close(); kiosk.stop(); clearInterval(keepAlive); }
  if (!process.exitCode) console.log("games: " + passed + " checks passed ");
})();
