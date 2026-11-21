// tests/kiosk/arcade-e2e.js — headless Chrome drives the REAL arcade page against the REAL kiosk-server.js and a FAKE Worker, then the REAL
// make-station.html against (a) the real make-station-server.js and (b) the same server behind a proxy that answers 404 to the new
// /api/kitchen/* and /api/stock* routes, exactly like a station server from before the Kitchen Board update.
//   arcade: no camera is ever requested, a win shows the Worker's code, a "no code" result says thanks-for-playing, the staff drawer is locked
//           until the staff key is typed, bad odds are refused, nothing in the drawer renders HTML from a label.
//   station: with the new server the Claims and 86 Stock buttons show; with an old server they are hidden and nothing throws.
// Needs Google Chrome (CHROME_BIN or the usual path); skips (exit 0) without it. TB_SHOTS=<dir> also writes screenshots (kiosk 1080x1920, station 1920x1080).
// Run: node tests/kiosk/arcade-e2e.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const cp = require("child_process");
const chromeGuard = require("./chrome-guard");
const assert = require("assert");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "../..");
const CHROME = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean).find(p => fs.existsSync(p));
if (!CHROME) { console.log("arcade-e2e: SKIPPED (no Chrome found; set CHROME_BIN)"); process.exit(0); }

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
async function waitFor(cond, ms = 15000, what = "condition") { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await cond(); if (last) return last; } catch (e) { last = e; } await sleep(60); } assert.fail("timed out waiting for " + what + (last instanceof Error ? ": " + last.message : "")); }
const keepAlive = setInterval(() => {}, 1000);
const KIOSK_KEY = "k".repeat(30), STAFF = "staff-secret-key-1234";

function req(port, method, p, obj, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = obj === undefined ? null : JSON.stringify(obj);
    const h = { Host: `127.0.0.1:${port}`, ...headers };
    if (method !== "GET") Object.assign(h, { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, ...headers });
    if (data !== null) h["Content-Length"] = Buffer.byteLength(data);
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: h }, res => { let b = ""; res.on("data", c => b += c); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: b, json: j }); }); });
    r.on("error", reject); if (data !== null) r.write(data); r.end();
  });
}

/* ---------------- fakes ---------------- */
let claims = 0;
const worker = http.createServer((rq, rs) => {
  let b = ""; rq.on("data", c => b += c); rq.on("end", () => {
    const j = (s, o) => { rs.writeHead(s, { "Content-Type": "application/json" }); rs.end(JSON.stringify(o)); };
    if (rq.method === "GET" && rq.url === "/scores/token") return j(200, { token: "tk" + Math.random().toString(16).slice(2), minMs: 100 });
    if (rq.method === "POST" && rq.url === "/kitchen/claim") {
      if (rq.headers["x-kiosk-key"] !== KIOSK_KEY) return j(429, { error: "daily-limit" });
      if (claims >= 1) return j(429, { error: "sold-out" });
      claims++;
      return j(200, { ok: true, code: "K7QD", ticket: { reward: "Secret Menu Unlock", drinkName: "Neon Rip Curl", build: "Sprite", expiresAt: Date.now() + 1e6 } });
    }
    j(404, {});
  });
});
const clover = http.createServer((rq, rs) => { rs.writeHead(200, { "Content-Type": "application/json" }); rs.end('{"elements":[]}'); });

function stageKiosk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-arcade-e2e-"));
  for (const f of ["kiosk-server.js", "kiosk-lib.js", "flex-pay.js", "pay-journal.js", "pay-routes.js", "catalog.js", "quote.js", "moderation.js", "arcade-routes.js", "addons.json", "drink-kiosk.html", "drink-kiosk-light.html"]) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "catalog-map.json"), JSON.stringify({ version: 1, floats: [], categories: {} }));
  fs.cpSync(path.join(ROOT, "kiosk"), path.join(dir, "kiosk"), { recursive: true });
  return dir;
}
function stageStation() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-station-e2e-"));
  for (const f of ["make-station-server.js", "make-station.html", "pickup-board.html", "recipes.json", "addons.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  return dir;
}
function spawnNode(dir, file, env) {
  const c = cp.spawn(process.execPath, [file], { cwd: dir, env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  c.out = ""; c.stdout.on("data", d => c.out += d); c.stderr.on("data", d => c.out += d);
  return c;
}

/* ---------------- headless Chrome over the DevTools protocol (the repo's own ws dependency) ---------------- */
async function launchChrome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-chrome-"));
  const proc = chromeGuard.spawnChrome(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1280,1000", "about:blank"], { stdio: "ignore" });
  const portFile = path.join(dir, "DevToolsActivePort");
  await waitFor(() => fs.existsSync(portFile) && fs.readFileSync(portFile, "utf8").split("\n").length >= 2, 20000, "Chrome to start");
  const [port, wsPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  let id = 0; const waiting = new Map();
  ws.on("message", m => { const d = JSON.parse(m); if (d.id && waiting.has(d.id)) { const w = waiting.get(d.id); waiting.delete(d.id); d.error ? w.rej(new Error(d.error.message)) : w.res(d.result); } });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId); await send("Runtime.enable", {}, sessionId);
  const page = {
    async spy() {   // before any page script runs: record every camera / microphone request and every dialog-like popup
      await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__media=[];try{const md=navigator.mediaDevices;if(md){const g=md.getUserMedia&&md.getUserMedia.bind(md);md.getUserMedia=function(c){window.__media.push(JSON.stringify(c));return g?g(c):Promise.reject(new Error('blocked'));};}}catch(e){}" }, sessionId);
    },
    async goto(url, w, h) {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
      await send("Page.navigate", { url }, sessionId);
      await waitFor(async () => (await page.eval("document.readyState")) === "complete", 20000, "page load");
    },
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error("page error: " + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result.value;
    },
    async shot(file) {
      if (!process.env.TB_SHOTS) return;
      await sleep(500);
      const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
      fs.mkdirSync(process.env.TB_SHOTS, { recursive: true });
      fs.writeFileSync(path.join(process.env.TB_SHOTS, file), Buffer.from(data, "base64"));
    },
    close() { try { ws.close(); } catch {} chromeGuard.killGroup(proc); },
  };
  return page;
}

(async () => {
  await new Promise(r => worker.listen(0, "127.0.0.1", r)); await new Promise(r => clover.listen(0, "127.0.0.1", r));
  const workerPort = worker.address().port, cloverPort = clover.address().port;
  const base = { CLOVER_API_TOKEN: "t", CLOVER_MERCHANT_ID: "M", CLOVER_BASE_URL: "http://127.0.0.1:" + cloverPort };
  const kioskPort = await freePort(), stationPort = await freePort(), oldPort = await freePort();
  const kiosk = spawnNode(stageKiosk(), "kiosk-server.js", { ...base, PORT: String(kioskPort), KIOSK_HEARTBEAT_URL: "off", PRIZE_API: "http://127.0.0.1:" + workerPort, KIOSK_KEY, STATION_KEY: STAFF, TB_CATALOG_MS: "60000" });
  const station = spawnNode(stageStation(), "make-station-server.js", { ...base, MAKE_PORT: String(stationPort), MAKE_BIND: "127.0.0.1" });
  // a station server from before the Kitchen Board update: same pages, but the new API routes do not exist (404 "Not found")
  const oldProxy = http.createServer((rq, rs) => {
    if (/^\/api\/(kitchen|stock)/.test(rq.url)) { rs.writeHead(404, { "Content-Type": "text/plain" }); return rs.end("Not found"); }
    const p = http.request({ host: "127.0.0.1", port: stationPort, path: rq.url, method: rq.method, headers: { ...rq.headers, host: "127.0.0.1:" + stationPort } }, r => { rs.writeHead(r.statusCode, r.headers); r.pipe(rs); });
    p.on("error", () => { rs.writeHead(502); rs.end(); }); rq.pipe(p);
  });
  await new Promise(r => oldProxy.listen(oldPort, "127.0.0.1", r));
  let chrome = null;
  try {
    await waitFor(async () => (await req(kioskPort, "GET", "/health").catch(() => ({}))).status === 200, 10000, "kiosk up");
    await waitFor(async () => (await req(stationPort, "GET", "/health").catch(() => ({}))).status === 200, 10000, "station up");
    // staff makes every spin a prize (standard 0, jackpot at its 2% ceiling)
    const allWin = [{ id: "standard", pct: 0 }, { id: "size_upgrade", pct: 89 }, { id: "soft_serve_topper", pct: 4 }, { id: "neon_charm", pct: 3 }, { id: "topper_or_sticker", pct: 2 }, { id: "free_drink_jackpot", pct: 2 }];
    eq((await req(kioskPort, "POST", "/api/arcade-config", { odds: allWin }, { "X-Key": STAFF })).status, 200, "staff odds saved");

    chrome = await launchChrome();
    await chrome.spy();

    /* ---------- the arcade page on the 1080x1920 kiosk screen ---------- */
    await chrome.goto(`http://127.0.0.1:${kioskPort}/arcade`, 1080, 1920);
    await waitFor(() => chrome.eval("!!document.getElementById('spinBtn') && !document.getElementById('spinBtn').disabled"), 8000, "arcade ready");
    ok(!(await chrome.eval("!!document.getElementById('camToggleBtn') || !!document.getElementById('scanVibeBtn') || !!document.querySelector('video')")), "no camera or vibe controls exist");
    ok(!/Scan My Vibe|Presence Cam|GEMINI|Dole Whip/i.test(await chrome.eval("document.body.innerText")), "no camera, vibe or Dole Whip text on the page");
    await chrome.shot("arcade-1080x1920-ready.png");
    // the first spin comes before any Worker play token is old enough: it plays, shows thanks, never a code
    await chrome.eval("document.getElementById('spinBtn').click()");
    await waitFor(() => chrome.eval("!document.getElementById('spinBtn').disabled"), 15000, "first spin finished");
    eq(await chrome.eval("document.getElementById('claimPill').hidden"), true, "no claim code without a Worker claim");
    ok(/THANKS FOR PLAYING/.test(await chrome.eval("document.getElementById('reel3Val').textContent")), "thanks for playing, no prize shown");
    await chrome.shot("arcade-1080x1920-thanks.png");
    await sleep(2600);                                         // the Worker wants the play token a little old
    await chrome.eval("document.getElementById('spinBtn').click()");
    await waitFor(() => chrome.eval("!document.getElementById('spinBtn').disabled"), 15000, "second spin finished");
    eq(await chrome.eval("document.getElementById('claimPill').hidden"), false, "a real win shows the claim pill");
    eq(await chrome.eval("document.getElementById('claimCode').textContent"), "K7QD", "the code on screen is the Worker's code");
    ok(/WINNER|JACKPOT/.test(await chrome.eval("document.getElementById('resultTitle').textContent")));
    await chrome.shot("arcade-1080x1920-win.png");
    // the cap (1) is now spent: the next spin is thanks again
    await sleep(300);
    await chrome.eval("document.getElementById('spinBtn').click()");
    await waitFor(() => chrome.eval("!document.getElementById('spinBtn').disabled"), 15000, "third spin finished");
    eq(await chrome.eval("document.getElementById('claimPill').hidden"), true, "cap hit: no code");

    // staff drawer: 3 taps, locked until the key
    await chrome.eval("(async()=>{const b=document.getElementById('staffCornerBtn');for(let i=0;i<3;i++){b.click();}})()");
    ok(await chrome.eval("document.getElementById('staffDlg').open"), "drawer opens on 3 taps");
    eq(await chrome.eval("document.getElementById('staffControls').hidden"), true, "controls are locked until the staff key");
    await chrome.eval("document.getElementById('staffKeyInput').value='not-the-key';document.getElementById('staffUnlockBtn').click()");
    await waitFor(() => chrome.eval("document.getElementById('staffLockMsg').textContent.length>0"), 5000, "wrong key message");
    ok(/Wrong staff key/.test(await chrome.eval("document.getElementById('staffLockMsg').textContent")));
    eq(await chrome.eval("document.getElementById('staffControls').hidden"), true);
    await chrome.eval(`document.getElementById('staffKeyInput').value=${JSON.stringify(STAFF)};document.getElementById('staffUnlockBtn').click()`);
    await waitFor(() => chrome.eval("!document.getElementById('staffControls').hidden"), 5000, "unlocked");
    eq(await chrome.eval("document.querySelectorAll('[data-odd-idx]').length"), 6);
    await chrome.shot("arcade-1080x1920-staff.png");
    // 3% free drink is refused in the page before it is even sent, and the server would refuse it too
    await chrome.eval("const els=[...document.querySelectorAll('[data-odd-idx]')];els[1].value=88;els[5].value=3;els[5].dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('saveOddsBtn').click()");
    await waitFor(() => chrome.eval("/Free drink odds/.test(document.getElementById('staffSaveMsg').textContent)"), 5000, "free drink cap message");
    eq((await req(kioskPort, "GET", "/api/arcade-config")).json.config.odds.find(o => o.id === "free_drink_jackpot").pct, 2, "the server still has 2%");
    // volume and mute are local: they must not touch the saved odds
    const before = (await req(kioskPort, "GET", "/api/arcade-config")).body;
    await chrome.eval("const v=document.getElementById('staffVol');v.value=30;v.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('staffMuteBtn').click()");
    await sleep(400);
    eq((await req(kioskPort, "GET", "/api/arcade-config")).body, before, "volume and mute changed nothing on the server");
    // closing the drawer forgets the key
    await chrome.eval("document.getElementById('staffCloseBtn').click()");
    await chrome.eval("(async()=>{const b=document.getElementById('staffCornerBtn');for(let i=0;i<3;i++){b.click();}})()");
    eq(await chrome.eval("document.getElementById('staffControls').hidden"), true, "locked again after close");
    eq(await chrome.eval("window.__media.length"), 0, "the page never asked for the camera or microphone");

    /* ---------- the staff screen on 1920x1080: new server vs a server from before the update ---------- */
    await chrome.goto(`http://127.0.0.1:${stationPort}/`, 1920, 1080);
    await sleep(1500);
    const vis = id => chrome.eval(`(function(){const b=document.getElementById('${id}');return !!b&&getComputedStyle(b).display!=='none'&&b.offsetWidth>0;})()`);
    ok(await vis("claimsBtn") && await vis("stock86Btn"), "new station server: Claims and 86 Stock are shown");
    await chrome.shot("station-1920x1080-new-server.png");
    await chrome.goto(`http://127.0.0.1:${oldPort}/`, 1920, 1080);
    await waitFor(async () => !(await vis("claimsBtn")) && !(await vis("stock86Btn")), 8000, "Claims and 86 Stock hidden against the old server");
    ok(await vis("mTickets") && await vis("mBatch") && await vis("mLookup"), "the ticket screen itself still works against the old server");
    eq(await chrome.eval("typeof extrasSupported==='boolean'&&extrasSupported===false"), true);
    await chrome.shot("station-1920x1080-old-server.png");
    console.log(`arcade-e2e: ${passed} checks passed (Chrome)`);
  } finally {
    if (chrome) chrome.close();
    kiosk.kill(); station.kill(); worker.close(); clover.close(); oldProxy.close(); clearInterval(keepAlive);
  }
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
