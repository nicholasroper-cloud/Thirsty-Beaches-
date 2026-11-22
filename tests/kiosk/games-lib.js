// tests/kiosk/games-lib.js — shared harness for tests/kiosk/games.js: stage the REAL kiosk-server.js with a fake Worker + fake Clover, drive headless Chrome over CDP
// with touch emulation, record console errors / every network request / CSP violations.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const cp = require("child_process");
const chromeGuard = require("./chrome-guard");

const ROOT = path.resolve(__dirname, "../..");
const CHROME = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean).find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
async function waitFor(cond, ms = 15000, what = "condition") { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await cond(); if (last) return last; } catch (e) { last = e; } await sleep(50); } throw new Error("timed out waiting for " + what + (last instanceof Error ? ": " + last.message : "")); }

function req(port, method, p, obj, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = obj === undefined ? null : JSON.stringify(obj);
    const h = { Host: `127.0.0.1:${port}`, ...headers };
    if (method !== "GET") Object.assign(h, { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, ...headers });
    if (data !== null) h["Content-Length"] = Buffer.byteLength(data);
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: h }, res => { let b = ""; res.on("data", c => b += c); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, headers: res.headers, body: b, json: j }); }); });
    r.on("error", reject); if (data !== null) r.write(data); r.end();
  });
}

/* A real kiosk server in a temp dir. opts.session overrides kiosk/arcade-session.json keys. Returns { port, base, worker, stop(), claims }. */
async function stageKiosk(opts = {}) {
  const KIOSK_KEY = "k".repeat(30);
  const state = { claims: [], tokens: 0, claimBodies: [], winCodes: opts.codes || ["K7QD", "M3PA", "N4RS", "T5WX", "P6VZ", "H8GC", "R2LM", "S9BF"], issued: 0 };
  const worker = http.createServer((rq, rs) => {
    let b = ""; rq.on("data", c => b += c); rq.on("end", () => {
      const j = (s, o) => { rs.writeHead(s, { "Content-Type": "application/json" }); rs.end(JSON.stringify(o)); };
      let body = {}; try { body = JSON.parse(b || "{}"); } catch {}
      if (rq.method === "GET" && rq.url === "/scores/token") { state.tokens++; return j(200, { token: "tk" + Math.random().toString(16).slice(2), minMs: 100 }); }
      if (rq.method === "POST" && rq.url === "/kitchen/claim") {
        state.claimBodies.push({ body, key: rq.headers["x-kiosk-key"] });
        if (rq.headers["x-kiosk-key"] !== KIOSK_KEY || state.issued >= state.winCodes.length || opts.workerDown) return j(429, { error: "daily-limit" });
        const code = state.winCodes[state.issued++];
        return j(200, { ok: true, code, ticket: { reward: "Secret Menu Unlock", drinkName: "Neon Rip Curl", build: "Sprite", expiresAt: Date.now() + 24 * 3600e3 } });
      }
      j(404, {});
    });
  });
  const clover = http.createServer((rq, rs) => { rs.writeHead(200, { "Content-Type": "application/json" }); rs.end('{"elements":[]}'); });
  const wp = await freePort(); await new Promise(r => worker.listen(wp, "127.0.0.1", r));
  const cp_ = await freePort(); await new Promise(r => clover.listen(cp_, "127.0.0.1", r));
  const dir = tmp("tb-games-");
  for (const f of ["kiosk-server.js", "kiosk-lib.js", "flex-pay.js", "pay-journal.js", "pay-routes.js", "catalog.js", "quote.js", "moderation.js", "arcade-routes.js", "addons.json", "drink-kiosk.html", "drink-kiosk-light.html"]) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "catalog-map.json"), JSON.stringify({ version: 1, floats: [], categories: {} }));
  fs.cpSync(path.join(ROOT, "kiosk"), path.join(dir, "kiosk"), { recursive: true });
  const sess = JSON.parse(fs.readFileSync(path.join(dir, "kiosk", "arcade-session.json"), "utf8"));
  if (process.env.TB_DIFFICULTY) sess.gameDifficulty = process.env.TB_DIFFICULTY;   // run the whole games suite in one mode: TB_DIFFICULTY=classic|arcade86 (default: whatever the shipped arcade-session.json says)
  Object.assign(sess, opts.session || {});
  fs.writeFileSync(path.join(dir, "kiosk", "arcade-session.json"), JSON.stringify(sess));
  const port = await freePort();
  const child = cp.spawn(process.execPath, ["kiosk-server.js"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: Object.assign({
    PATH: process.env.PATH, CLOVER_API_TOKEN: "t", CLOVER_MERCHANT_ID: "M", CLOVER_BASE_URL: "http://127.0.0.1:" + cp_, PORT: String(port), KIOSK_HEARTBEAT_URL: "off",
    PRIZE_API: "http://127.0.0.1:" + wp, KIOSK_KEY: opts.noKey ? "" : KIOSK_KEY, STATION_KEY: "staff-secret-key-1234", TB_CATALOG_MS: "60000" }, opts.env || {}) });
  let out = ""; child.stdout.on("data", d => out += d); child.stderr.on("data", d => out += d);
  for (let i = 0; i < 80; i++) { try { if ((await req(port, "GET", "/health")).status) break; } catch {} await sleep(100); }
  return { port, dir, state, KIOSK_KEY, log: () => out, base: `http://127.0.0.1:${port}`, child,
    stop() { try { child.kill(); } catch {} worker.close(); clover.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

/* Headless Chrome over CDP, portrait 1080x1920 with touch emulation by default. */
async function launchChrome() {
  const WebSocket = require("ws");
  const dir = tmp("tb-chrome-");
  const proc = chromeGuard.spawnChrome(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1100,2000", "about:blank"], { stdio: "ignore" });
  const portFile = path.join(dir, "DevToolsActivePort");
  await waitFor(() => fs.existsSync(portFile) && fs.readFileSync(portFile, "utf8").split("\n").length >= 2, 20000, "Chrome to start");
  const [port, wsPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  let id = 0; const waiting = new Map(); const listeners = [];
  ws.on("message", m => { const d = JSON.parse(m); if (d.id && waiting.has(d.id)) { const w = waiting.get(d.id); waiting.delete(d.id); d.error ? w.rej(new Error(d.error.message)) : w.res(d.result); } else if (d.method) for (const l of listeners) l(d); });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S("Page.enable"); await S("Runtime.enable"); await S("Network.enable");
  const page = { requests: [], responses: [], failed: [], consoleErrors: [], exceptions: [], mocks: [], size: [1080, 1920] };
  listeners.push(d => {
    if (d.sessionId !== sessionId) return;
    if (d.method === "Network.requestWillBeSent") page.requests.push({ url: d.params.request.url, method: d.params.request.method, body: d.params.request.postData || "" });
    else if (d.method === "Network.responseReceived") page.responses.push({ url: d.params.response.url, status: d.params.response.status, mime: d.params.response.mimeType });
    else if (d.method === "Network.loadingFailed") page.failed.push({ id: d.params.requestId, error: d.params.errorText, blocked: d.params.blockedReason || "" });
    else if (d.method === "Runtime.consoleAPICalled" && (d.params.type === "error" || d.params.type === "warning")) page.consoleErrors.push(d.params.type + ": " + d.params.args.map(a => a.value || a.description || "").join(" "));
    else if (d.method === "Runtime.exceptionThrown") page.exceptions.push((d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description) || d.params.exceptionDetails.text);
    else if (d.method === "Log.entryAdded" && d.params.entry.level === "error") page.consoleErrors.push("log: " + d.params.entry.text + " " + (d.params.entry.url || ""));
    else if (d.method === "Fetch.requestPaused") {
      const url = d.params.request.url; const m = page.mocks.find(x => x.re.test(url));
      if (m) { const out = m.fn(url, d.params.request); if (out) return void S("Fetch.fulfillRequest", { requestId: d.params.requestId, responseCode: out.status || 200, responseHeaders: [{ name: "Content-Type", value: out.type || "application/json" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(typeof out.body === "string" ? out.body : JSON.stringify(out.body)).toString("base64") }).catch(() => {}); }
      S("Fetch.continueRequest", { requestId: d.params.requestId }).catch(() => {});
    }
  });
  await S("Log.enable");
  Object.assign(page, {
    S,
    async viewport(w, h) { page.size = [w, h]; await S("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await S("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }); },
    /* before any page script: skewable Date.now, error capture, CSP violation capture, every AudioContext */
    async spy() {
      await S("Page.addScriptToEvaluateOnNewDocument", { source: `(function(){window.__skew=0;var rn=Date.now.bind(Date);Date.now=function(){return rn()+window.__skew*1000;};
        window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});window.addEventListener('unhandledrejection',function(e){window.__errs.push('rejection: '+(e.reason&&e.reason.message||e.reason))});
        document.addEventListener('securitypolicyviolation',function(e){window.__errs.push('CSP: '+e.violatedDirective+' '+e.blockedURI)});
        window.__ctxs=[];var AC=window.AudioContext||window.webkitAudioContext;if(AC){var W=function(){var c=new AC(...arguments);window.__ctxs.push(c);return c};W.prototype=AC.prototype;window.AudioContext=W;window.webkitAudioContext=W;}
        window.__speech=0;window.__speed=1;var raf=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=function(cb){return raf(function(ts){cb(ts*(window.__speed||1));});};})()` });
    },
    async mock(re, fn) { page.mocks.push({ re, fn }); await S("Fetch.enable", { patterns: [{ urlPattern: "*" }] }); },
    async goto(url) {
      page.requests.length = 0; page.responses.length = 0; page.failed.length = 0; page.consoleErrors.length = 0; page.exceptions.length = 0;
      page._down = new Map();   // a fresh touch device per page: a finger left down by the last test can never leak into this one
      // Headless Chrome quirk: after a HELD finger (or a moved one) on one page the first held finger on the NEXT page is swallowed unless the old page is reloaded first.
      if (page._moved) { page._moved = false; await S("Page.reload").catch(() => {}); await sleep(500); }
      await S("Emulation.setTouchEmulationEnabled", { enabled: false }); await S("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await S("Page.navigate", { url });
      const u = new URL(url);   // wait for the NEW document (the old one is also 'complete' for a moment after navigate)
      await waitFor(async () => (await page.eval("location.pathname+location.search")) === u.pathname + u.search && (await page.eval("document.readyState")) === "complete", 20000, "page load " + url);
      await sleep(250);
    },
    async eval(expr) {
      const r = await S("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error("page error: " + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result.value;
    },
    async shot(file) {
      if (!process.env.TB_SHOTS) return;
      await sleep(350);
      const { data } = await S("Page.captureScreenshot", { format: "png" });
      fs.mkdirSync(process.env.TB_SHOTS, { recursive: true });
      fs.writeFileSync(path.join(process.env.TB_SHOTS, file), Buffer.from(data, "base64"));
    },
    /* touch: points = [{id,x,y}] */
    /* touchStart / touchMove: the points that go down / move (others stay down). touchEnd: the points that lift; an empty list lifts EVERY finger still down. */
    async touch(type, points) {
      const down = page._down || (page._down = new Map());
      let pts = points;
      if (type === "touchEnd" && !points.length) pts = [...down.values()];
      if (type === "touchMove" || (type === "touchStart" && !page._inTap)) page._moved = true;   // a held finger (not a plain tap)
      for (const p of pts) { if (type === "touchEnd") down.delete(p.id || 0); else down.set(p.id || 0, p); }
      if (type === "touchEnd" && !pts.length) return;
      await S("Input.dispatchTouchEvent", { type, touchPoints: pts.map(p => ({ id: p.id || 0, x: p.x, y: p.y, radiusX: p.r || 8, radiusY: p.r || 8, force: 1 })) });
    },
    async tap(x, y, hold = 60) { page._inTap = true; await page.touch("touchStart", [{ x, y }]); await sleep(hold); await page.touch("touchEnd", []); page._inTap = false; await sleep(40); },
    async tapEl(sel) { const r = await page.rect(sel); if (!r) throw new Error("no element " + sel); await page.tap(Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2)); return r; },
    async rect(sel) { return page.eval(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;var r=e.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height,hidden:getComputedStyle(e).display==='none'||getComputedStyle(e).visibility==='hidden'}})()`); },
    close() { try { ws.close(); } catch {} chromeGuard.killGroup(proc); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  });
  return page;
}
module.exports = { ROOT, CHROME, sleep, freePort, tmp, waitFor, req, stageKiosk, launchChrome };
