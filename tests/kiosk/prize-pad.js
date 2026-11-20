// tests/kiosk/prize-pad.js — the order screen's "Have an arcade prize?" pad (phone number or 4-letter code), headless Chrome at 1080x1920 with touch.
//   The page runs against a small fake kiosk server (the real drink-kiosk.html, assets, and stateful fakes of /api/arcade/*, /order) so this test does not
//   depend on the server side of the feature; it pins the PAGE side of the contract:
//     POST /api/arcade/wallet/lookup {phone}  and  POST /api/arcade/code {code}  ->  found makes the server's ONE pending prize, the existing banner and
//     attach flow carry it onto the order. Not found / wrong / used / slow-down / unavailable never block the order.
//   Privacy: the typed number appears in exactly ONE request body (the lookup), never in the console, storage, the DOM after the answer, the cart or /order.
// TB_SHOTS=<dir> writes screenshots. Skips (exit 0) when Chrome is not installed. Run: node tests/kiosk/prize-pad.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const cp = require("child_process");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "../..");
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, ms = 10000, what = "condition") { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await cond(); if (last) return last; } catch (e) { last = e; } await sleep(60); } throw new Error("timed out waiting for " + what + (last instanceof Error ? ": " + last.message : "")); }
const CHROME = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean).find(p => fs.existsSync(p));
if (!CHROME) { console.log("prize-pad: skipped (no Chrome found; set CHROME_BIN)"); process.exit(0); }
const SHOTS = process.env.TB_SHOTS || "";
const PHONE = "5551234567";
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/* ---------------- fake kiosk server: the real page + stateful fakes of the endpoints the pad uses ---------------- */
const world = { pending: null, lookup: null, code: null, requests: [], orders: [], dismissed: 0, nextRaw: null };
const PRIZE = { code: "K7QD", prizeId: "size_upgrade", label: "Free Size Upgrade" };
const setPending = () => { const t = Date.now(); world.pending = { ...PRIZE, issuedAt: t, expiresAt: t + 15 * 60000 }; };
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".json": "application/json", ".svg": "image/svg+xml", ".mp3": "audio/mpeg" };
const server = http.createServer((rq, rs) => {
  const chunks = []; rq.on("data", d => chunks.push(d));
  rq.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(rq.url, "http://x"); const p = url.pathname;
    world.requests.push({ method: rq.method, path: p, body });
    const j = (code, o) => { rs.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); rs.end(JSON.stringify(o)); };
    let b = {}; try { b = body ? JSON.parse(body) : {}; } catch {}
    if (rq.method === "GET" && (p === "/" || p === "/index.html")) { rs.writeHead(200, { "Content-Type": MIME[".html"] }); return rs.end(fs.readFileSync(path.join(ROOT, "drink-kiosk.html"))); }
    if (rq.method === "GET" && p.startsWith("/assets/")) { const f = path.join(ROOT, p); if (f.startsWith(path.join(ROOT, "assets") + path.sep) && fs.existsSync(f)) { rs.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" }); return rs.end(fs.readFileSync(f)); } rs.writeHead(404); return rs.end(); }
    if (p === "/api/arcade/pending" && rq.method === "GET") return j(200, { ok: true, pending: world.pending });
    if (p === "/api/arcade/pending/dismiss") { world.dismissed++; world.pending = null; return j(200, { ok: true, dismissed: true }); }
    if (p === "/api/arcade/wallet/lookup") { const r = world.lookup; if (r === "raw500") { rs.writeHead(500); return rs.end("nope"); } if (r && r.ok && r.found) setPending(); return j(200, r || { ok: true, found: false }); }
    if (p === "/api/arcade/code") { const r = world.code; if (r && r.ok && r.found) setPending(); return j(200, r || { ok: true, found: false, status: "unknown" }); }
    if (p === "/api/arcade/pending/attach") {
      const o = world.orders.find(x => x.orderId === b.orderId);
      if (!world.pending || !o) return j(200, { ok: false, error: "no-pending" });
      o.note += " · ARCADE " + world.pending.prizeId + " " + world.pending.code;
      const out = { ok: true, code: world.pending.code, label: world.pending.label }; world.pending = null; return j(200, out);
    }
    if (p === "/order" && rq.method === "POST") { const id = "ORDER" + String(world.orders.length + 1).padStart(6, "0"); world.orders.push({ orderId: id, note: "Kiosk order", cart: b }); return j(200, { ok: true, orderId: id, ticket: id.slice(-4), seq: world.orders.length, name: b.name || "", upsize: false }); }
    if (rq.method === "GET" && p === "/menu") { rs.writeHead(404); return rs.end(); }
    return j(200, {});
  });
});

/* ---------------- Chrome over CDP with touch emulation ---------------- */
async function launchChrome() {
  const WebSocket = require("ws");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-pad-chrome-"));
  const proc = cp.spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1280,1000", "about:blank"], { stdio: "ignore" });
  const portFile = path.join(dir, "DevToolsActivePort");
  await waitFor(() => fs.existsSync(portFile) && fs.readFileSync(portFile, "utf8").split("\n").length >= 2, 20000, "Chrome to start");
  const [port, wsPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  let id = 0; const waiting = new Map(); const logs = [];
  ws.on("message", m => {
    const d = JSON.parse(m);
    if (d.id && waiting.has(d.id)) { const w = waiting.get(d.id); waiting.delete(d.id); d.error ? w.rej(new Error(d.error.message)) : w.res(d.result); }
    if (d.method === "Runtime.consoleAPICalled") logs.push({ type: d.params.type, text: d.params.args.map(a => String(a.value !== undefined ? a.value : a.description)).join(" ") });
    if (d.method === "Runtime.exceptionThrown") logs.push({ type: "exception", text: JSON.stringify(d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description || d.params.exceptionDetails.text) });
    if (d.method === "Log.entryAdded") logs.push({ type: d.params.entry.level, text: d.params.entry.text + " " + (d.params.entry.url || "") });
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId); await send("Runtime.enable", {}, sessionId); await send("Log.enable", {}, sessionId);
  const page = {
    logs,
    async size(w, h) {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
      await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sessionId);
    },
    async goto(url, w, h) {
      await page.size(w, h);
      await send("Page.navigate", { url }, sessionId);
      await waitFor(async () => (await page.eval("document.readyState")) === "complete", 20000, "page load");
    },
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error("page error: " + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result.value;
    },
    rect: sel => page.eval(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;var r=e.getBoundingClientRect();return {l:r.left,t:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height};})()`),
    async tap(sel) {   // a real touch: touchStart + touchEnd at the element's centre (the page sees a pointer + click like a finger)
      const r = await page.rect(sel); if (!r || r.w === 0) throw new Error("nothing to tap: " + sel);
      const x = r.l + r.w / 2, y = r.t + r.h / 2;
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] }, sessionId);
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, sessionId);
      await sleep(70);
    },
    async shot(file) {
      if (!SHOTS) return;
      await sleep(400);
      const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
      fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, file), Buffer.from(data, "base64"));
    },
    close() { try { ws.close(); } catch {} proc.kill("SIGKILL"); },
  };
  return page;
}

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chrome = await launchChrome();
  try {
    const tapDigits = async s => { for (const c of s) await chrome.tap(`.krow.numpad .kkey[onclick="pzPhoneKey('${c}')"]`); };
    const tapCode = async s => { for (const c of s) await chrome.tap(`.krow.pzalpha .kkey[onclick="pzCodeKey('${c}')"]`); };
    const fresh = async (w = 1080, h = 1920) => {
      world.pending = null; world.lookup = null; world.code = null;
      await chrome.goto("about:blank", w, h); await chrome.goto(base + "/#menu", w, h);
      await waitFor(() => chrome.eval("typeof openCart==='function'&&!document.getElementById('app')?.hidden"), 10000, "the order screen");
      await chrome.eval(`cart.push({icon:"",name:"Neon Sunset Float",mods:["Large"],unit:6.5,qty:1,catKey:"floats",sel:{}}); updateCartBtn(); openCart(); 1`);
      await waitFor(() => chrome.rect("#arcPrizeRow"), 5000, "the cart sheet with the prize row");
    };
    const tapYear = async y => { for (const c of String(y)) await chrome.tap(`.krow.numpad .kkey[onclick="pzYearKey('${c}')"]`); };
    const ymAgo = k => { const d = new Date(); const t = d.getFullYear() * 12 + d.getMonth() - k; return { y: Math.floor(t / 12), m: (t % 12) + 1 }; };   // k whole months before this month
    const openAge = async () => { await chrome.tap("#arcAsk"); await waitFor(() => chrome.rect("#pzMonths"), 3000, "the age screen"); };
    const answerAge = async ({ y, m }) => { await chrome.tap(`#pzMonths button[data-m="${m}"]`); await tapYear(y); await chrome.tap("#pzGo"); };
    // the normal way to the phone pad: the neutral birth month/year screen first (an adult answer; the answers are discarded at once)
    const open = async () => { await openAge(); await answerAge({ y: 1990, m: 6 }); await waitFor(() => chrome.rect(".krow.numpad .kkey[onclick^='pzPhoneKey']"), 3000, "the phone pad"); };
    const msg = () => chrome.eval("document.getElementById('pzMsg').textContent");
    const lookups = () => world.requests.filter(r => r.path === "/api/arcade/wallet/lookup");

    /* ---- 0. the neutral age check before the phone field (legal memo): no defaults, under 13 -> code only, nothing kept ---- */
    await fresh();
    const bodies = () => world.requests.filter(r => r.body).length;   // anything the page POSTs (the pending poll is a bodiless GET)
    const reqBefore = bodies();
    await openAge();
    eq(await chrome.eval("document.querySelector('#sheet h3').textContent"), "To save to a phone number, enter your birth month and year.", "the age screen says exactly the memo line");
    eq(await chrome.eval("[...document.querySelectorAll('#pzMonths button')].map(b=>b.textContent).join()"), "Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec", "twelve month buttons");
    eq(await chrome.eval("[_pzMonth,_pzYear,document.querySelectorAll('#pzMonths .on,#pzMonths [aria-pressed=true]').length,document.getElementById('pzBox').innerText.replace(/\\s+/g,'')]"), [0, "", 0, "____"], "no default month, no default year, nothing preselected");
    ok(await chrome.eval("document.getElementById('pzGo').classList.contains('disabled')"), "Continue is disabled until both are answered");
    ok(!/13|parent|grown|old enough|under|too young|must be/i.test(await chrome.eval("document.getElementById('sheet').innerText")), "no age rule, parent or grown-up wording on the age screen");
    for (const k of await chrome.eval("[...document.querySelectorAll('#pzMonths button')].map(e=>{var r=e.getBoundingClientRect();return [e.textContent,r.height,r.width,r.top+r.height/2];})")) ok(k[1] >= 64 && k[2] >= 64 && k[3] > 700, "month " + k[0] + " is big and low (" + Math.round(k[2]) + "x" + Math.round(k[1]) + " y=" + Math.round(k[3]) + ")");
    for (const k of await chrome.eval("[...document.querySelectorAll('.krow.numpad .kkey:not(.kblank)')].map(e=>{var r=e.getBoundingClientRect();return [e.textContent,r.height,r.width,r.top+r.height/2];})")) ok(k[1] >= 96 && k[2] >= 96 && k[3] > 960, "year key " + k[0] + " is big and in the lower half");
    await chrome.shot("0-age-check-1080x1920.png");
    // impossible answers ask again, without saying why
    await chrome.tap('#pzMonths button[data-m="3"]'); await tapYear(new Date().getFullYear() + 1); await chrome.tap("#pzGo");
    eq(await msg(), "Please check the year.", "a year in the future: asked again"); eq(await chrome.eval("[_pzMonth,_pzYear]"), [0, ""], "and the wrong answer is not kept");
    await chrome.tap('#pzMonths button[data-m="3"]'); await tapYear(1850); await chrome.tap("#pzGo");
    eq(await msg(), "Please check the year.", "a year before 1900: asked again");
    { const n = ymAgo(-1); if (n.y === new Date().getFullYear()) { await chrome.tap(`#pzMonths button[data-m="${n.m}"]`); await tapYear(n.y); await chrome.tap("#pzGo"); eq(await msg(), "Please check the year.", "a month still to come this year: asked again"); } }
    ok(!(await chrome.rect(".krow.numpad .kkey[onclick^='pzPhoneKey']")), "still on the age screen: no phone field yet");
    // boundary: 157 whole months ago = 13 and over -> phone pad; 156 = treated as under 13 -> code pad only
    await answerAge(ymAgo(157)); await waitFor(() => chrome.rect(".krow.numpad .kkey[onclick^='pzPhoneKey']"), 3000, "13+ reaches the phone pad");
    ok(!!(await chrome.rect("#pzAlt")), "13+: both choices are there"); eq(await chrome.eval("[_pzMonth,_pzYear]"), [0, ""], "13+: the answers are discarded at once");
    ok(await chrome.eval("sessionStorage.getItem('tbPhonePathOff')===null"), "13+: nothing is stored");
    await chrome.tap("#pzAlt"); await waitFor(() => chrome.rect(".krow.pzalpha"), 3000, "code pad from the phone pad");
    ok(!!(await chrome.rect("#pzAlt")) && /Use my phone number instead/.test(await chrome.eval("document.getElementById('pzAlt').textContent")), "13+: the code pad offers the phone path");
    { const a = await chrome.rect("#pzGo"), b = await chrome.rect("#pzAlt"); ok(Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1, "code pad: both choices are the same size " + JSON.stringify([a, b])); }
    await chrome.tap("#pzAlt"); await waitFor(() => chrome.rect("#pzMonths"), 3000, "switching to phone asks the age screen again (answers were discarded)");
    const under = ymAgo(156), underYear = String(under.y);
    await answerAge(under); await waitFor(() => chrome.rect(".krow.pzalpha"), 3000, "under 13 lands on the code pad");
    ok(!(await chrome.rect("#pzAlt")) && !/phone number instead|birth|age/i.test(await chrome.eval("document.getElementById('sheet').innerText")), "under 13: straight to the code screen, no phone choice, nothing said about age");
    eq(await chrome.eval("[_pzMonth,_pzYear]"), [0, ""], "under 13: the answers are gone");
    eq(await chrome.eval("JSON.stringify(sessionStorage)"), '{"tbPhonePathOff":"1"}', "under 13: only a bare flag is kept, no age, no birth date");
    ok(await chrome.eval("!JSON.stringify(localStorage).includes('" + underYear + "')"), "under 13: nothing in localStorage");
    // back out and re-open: the phone path is not offered again
    await chrome.tap(".sheet-ft .linkbtn"); await waitFor(() => chrome.rect("#arcPrizeRow"), 3000, "back on the cart");
    await chrome.tap("#arcAsk"); await waitFor(() => chrome.rect(".krow.pzalpha"), 3000, "re-opened on the code pad, not the age screen");
    ok(!(await chrome.rect("#pzMonths")) && !(await chrome.rect("#pzAlt")), "after backing out and re-opening: still code only");
    await chrome.tap(".close"); await chrome.eval("openCart(); 1"); await waitFor(() => chrome.rect("#arcAsk"), 3000, "cart again"); await chrome.tap("#arcAsk"); await waitFor(() => chrome.rect(".krow.pzalpha"), 3000, "closed and re-opened");
    ok(!(await chrome.rect("#pzMonths")) && !(await chrome.rect("#pzAlt")), "after closing and re-opening: still code only");
    await chrome.shot("0b-under13-code-only-1080x1920.png");
    eq(bodies(), reqBefore, "the age screen sent nothing to the server (no POST of any kind)");
    ok(!world.requests.some(r => (r.body + r.path).includes(underYear)) && !chrome.logs.some(l => l.text.includes(underYear)), "no birth year in any request or console line");
    // an arcade page's flag is honoured too, and a reset opens the phone path again for the next customer
    await chrome.eval("resetAll(); 1");
    ok(await chrome.eval("sessionStorage.getItem('tbPhonePathOff')===null && _pzNoPhone===false"), "resetAll clears the flag");
    await fresh(); await chrome.eval("sessionStorage.setItem('tbPhonePathOff','1'); 1");
    await chrome.tap("#arcAsk"); await waitFor(() => chrome.rect(".krow.pzalpha"), 3000, "arcade-set flag: code pad");
    ok(!(await chrome.rect("#pzMonths")) && !(await chrome.rect("#pzAlt")), "a flag set by an arcade page closes the phone path here too");
    await chrome.eval("resetAll(); 1");

    /* ---- the wording: memo text with the real keep time; never "anonymous"; code path never asks age ---- */
    await fresh();
    eq(await chrome.eval("PZW.saveExplainer()"), "Save this prize to a phone number? We use it only to find your prize next time. No calls, texts, or lists. Deleted when used or in 24 hours.", "the memo wording, with the real keep time (24 hours, not the memo's 30 days)");
    ok(await chrome.eval("!/anonymous/i.test(JSON.stringify(Object.values(PZW).map(v=>typeof v==='function'?v('x','y'):v)))&&!/anonymous/i.test(document.documentElement.outerHTML)"), "the word anonymous appears nowhere");
    ok(await chrome.eval("!/parent|grown|ask a/i.test(JSON.stringify(Object.values(PZW).map(v=>typeof v==='function'?v('x','y'):v)))"), "no parent / grown-up wording in the prize wording block");
    await chrome.tap("#arcAsk"); await waitFor(() => chrome.rect("#pzMonths"), 3000, "age"); await chrome.tap(".close");
    await chrome.eval("openCart(); pzOpenPhone(); pzShowCode(); $('#overlay').classList.add('pzpad','show'); 1"); ok(!!(await chrome.rect(".krow.pzalpha")), "the code pad opens without any age question (code path)");
    ok(!(await chrome.rect("#pzMonths")), "no age screen on the code path");

    /* ---- no purchase tie: nothing at or after checkout points at the arcade; the entry works with no order and no phone ---- */
    await chrome.goto("about:blank", 1080, 1920); await chrome.goto(base + "/#menu", 1080, 1920);
    await waitFor(() => chrome.eval("typeof openCart==='function'&&!document.getElementById('app')?.hidden"), 10000, "the order screen");
    eq(await chrome.eval("cart.length=0; updateArcadeEntry(); [document.getElementById('arcadeRow').hidden, arcadeSafe(), !!document.getElementById('arcadeAttractBtn'), document.getElementById('arcadeBtn').getAttribute('onclick')]"), [false, true, true, "goArcade()"], "with an empty cart (no order, receipt or phone) the arcade entry is shown and allowed");
    eq(await chrome.eval("cart.push({icon:'',name:'x',mods:[],unit:5,qty:1,catKey:'floats',sel:{}}); updateArcadeEntry(); document.getElementById('arcadeRow').hidden"), true, "an order in progress hides it");
    const tie = await chrome.eval(String.raw`(function(){
      var out = {};
      ["confirm","payscreen","windowFallback"].forEach(function(id){ var e = document.getElementById(id); if (!e) { out[id] = "missing"; return; }
        var c = e.cloneNode(true); var n = c.querySelector("#arcadeNote"); if (n) n.remove();
        out[id] = { links: c.querySelectorAll("[onclick*=arcade i],a[href*=arcade i],[onclick*=goArcade]").length, text: /\bplay\b|play (to|and|&) win|spin|jackpot/i.test(c.textContent) }; });
      var src = [typeof showConfirm==="function"?showConfirm:"", typeof placeOrder==="function"?placeOrder:"", typeof armConfirmReset==="function"?armConfirmReset:"", typeof startQr==="function"?startQr:"", typeof punchQr==="function"?punchQr:""].map(String).join("\n");
      out.js = /goArcade|play to win|play & win|play and win|thanks for your order, play/i.test(src);
      return out; })()`);
    eq(tie, { confirm: { links: 0, text: false }, payscreen: { links: 0, text: false }, windowFallback: { links: 0, text: false }, js: false }, "the confirm and pay screens and the order flow have no arcade link and no play prompt");

    /* ---- 1. the cart row, the phone pad: reachable, big, lower half ---- */
    await fresh();
    const rowTxt = await chrome.eval("document.getElementById('arcPrizeRow').innerText");
    ok(/Have an arcade prize\? Tap here/.test(rowTxt), "the cart row says what it is");
    ok(/Thirsty Maze code/.test(await chrome.eval("document.querySelector('.prizerow').innerText")), "the Maze code row is still there, unchanged");
    ok((await chrome.rect("#arcAsk")).h >= 64, "the row button is a real touch target");
    await chrome.shot("1-cart-prize-row-1080x1920.png");
    await open();
    ok(await chrome.eval("document.getElementById('overlay').classList.contains('pzpad')"), "the pad sheet sits at the bottom of the screen");
    for (const k of await chrome.eval("[...document.querySelectorAll('.krow.numpad .kkey:not(.kblank)')].map(e=>{var r=e.getBoundingClientRect();return [e.textContent,r.height,r.width,r.top+r.height/2];})")) {
      ok(k[1] >= 96 && k[2] >= 96, "phone key " + k[0] + " is big (>=96px, got " + k[2] + "x" + k[1] + ")");
      ok(k[3] > 960, "phone key " + k[0] + " is in the lower half (y=" + Math.round(k[3]) + ")");
    }
    for (const sel of ["#pzGo", ".pz-switch", ".close"]) { const r = await chrome.rect(sel); ok(r && r.h >= 64, sel + " is a real touch target"); }
    { const a = await chrome.rect("#pzGo"), b = await chrome.rect("#pzAlt"); ok(Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1, "[Find my prize] and [Use my code instead] are the same size: " + a.w + "x" + a.h + " vs " + b.w + "x" + b.h); ok(a.t > 960 && b.t > 960, "both choices sit in the lower half"); }
    const phoneTxt = await chrome.eval("document.getElementById('sheet').innerText");
    ok(phoneTxt.includes("We use your number only to find your prize for this order. No calls, texts, or lists. Deleted when used or in 24 hours."), "the sheet says what the number is for, no calls/texts/lists, and the real keep time: " + phoneTxt.slice(-260));
    ok(!/consent|marketing|subscribe|join|anonymous|parent|grown|ask a/i.test(phoneTxt), "no consent / marketing / join / anonymous / parent wording on the lookup pad");
    ok(/Use my code instead/.test(phoneTxt), "the code path is offered as clearly as the phone");
    await tapDigits("55512");
    eq(await chrome.eval("document.getElementById('pzBox').innerText.replace(/\\s+/g,'')"), "(555)12_-____", "the display fills (###) ###-####");
    ok(await chrome.eval("document.getElementById('pzGo').classList.contains('disabled')"), "Find is disabled until 10 digits");
    await chrome.tap(".krow.numpad .kkey[aria-label=delete]"); eq(await chrome.eval("_pzDigits"), "5551", "backspace works");
    await tapDigits("234567"); eq(await chrome.eval("_pzDigits"), PHONE, "only 10 digits are accepted (extra taps ignored)");
    await tapDigits("9"); eq(await chrome.eval("_pzDigits"), PHONE, "an 11th digit is ignored");
    await chrome.shot("2-phone-pad-1080x1920.png");
    await chrome.tap("#pzGo"); await waitFor(async () => /\S/.test((await msg()) || ""), 4000, "the answer");
    eq(lookups().length, 1, "exactly one lookup request"); eq(JSON.parse(lookups()[0].body), { phone: PHONE }, "the lookup sends the 10 digits and nothing else");
    eq(await chrome.eval("_pzDigits"), "", "the typed number is cleared from memory once the answer is back");

    /* ---- 2. phone found: world.lookup was null -> default not found; now found ---- */
    ok(!world.pending, "default answer: not found, nothing pending");
    ok(/No prize found on that number\./.test(await msg()), "not found: the plain line, nothing else revealed");
    eq(await chrome.eval("document.getElementById('pzBox').innerText.replace(/[^0-9]/g,'')"), "", "not found: the number is not echoed back");
    await chrome.shot("3-phone-not-found-1080x1920.png");
    world.lookup = { ok: true, found: true, label: PRIZE.label, expiresAt: Date.now() + 20 * 3600e3 };
    await tapDigits(PHONE); await chrome.tap("#pzGo");
    await waitFor(() => chrome.eval("!!document.getElementById('arcFound')"), 5000, "the cart shows the prize line");
    const found = await chrome.eval("document.getElementById('arcFound').innerText");
    ok(/Prize found: Free Size Upgrade/.test(found) && /good until/.test(found) && /added to this order automatically/.test(found) && /Nothing to show/.test(found), "found: " + found);
    ok(!(await chrome.rect("#arcAsk")), "the ask button is gone while a prize is on the order");
    ok(await chrome.eval("!document.getElementById('arcadeWin').hidden") && /Free Size Upgrade/.test(await chrome.eval("document.getElementById('arcadeWin').innerText")), "the existing banner shows the prize");
    await chrome.shot("4-phone-found-cart-1080x1920.png");

    /* ---- 3. the order takes it: only the order id is sent, the note carries the tag, the number is nowhere ---- */
    await chrome.eval(`_orderName="Sam"; placeOrder(); 1`);
    await waitFor(() => chrome.eval("document.getElementById('confirm').classList.contains('show')"), 10000, "confirm screen");
    await waitFor(() => chrome.eval("!document.getElementById('arcadeNote').hidden"), 8000, "arcade note on the confirm screen");
    ok(/Arcade win on your order: Free Size Upgrade · K7QD\. The crew has it\./.test(await chrome.eval("document.getElementById('arcadeNote').textContent")), "confirm note");
    const att = world.requests.filter(r => r.path === "/api/arcade/pending/attach");
    ok(att.length >= 1 && att.every(a => Object.keys(JSON.parse(a.body)).join() === "orderId"), "attach sends only the order id");
    eq(world.orders.length, 1); ok(/Kiosk order · ARCADE size_upgrade K7QD$/.test(world.orders[0].note), "the order note carries the ARCADE tag: " + world.orders[0].note);
    ok(!JSON.stringify(world.orders[0].cart).includes(PHONE), "the number is not in the order payload");
    await chrome.shot("5-order-confirmed-1080x1920.png");

    /* ---- 4. privacy: one request body, no console, no storage, no DOM ---- */
    const withNum = world.requests.filter(r => (r.body + r.path).includes(PHONE));
    eq(withNum.length, 2, "the number is in exactly the lookup bodies sent (two lookups)"); ok(withNum.every(r => r.path === "/api/arcade/wallet/lookup"), "...and only in the lookup requests");
    ok(!world.requests.some(r => /\/(order|quote|pay|subscribe)/.test(r.path) && r.body.includes(PHONE)), "never in order/quote/pay/subscribe");
    ok(!world.requests.some(r => r.path === "/subscribe"), "the pad never calls /subscribe (it is not marketing consent)");
    ok(!chrome.logs.some(l => /5551234567|555\D*123\D*4567/.test(l.text)), "the number never reaches the console");
    ok(await chrome.eval("!/5551234567/.test(JSON.stringify(localStorage)+JSON.stringify(sessionStorage)+document.cookie+document.documentElement.outerHTML)"), "not in storage, cookies or the DOM");

    /* ---- 5. refusals never block: slow-down, unavailable (junk), off, bad-phone; the order sheet still works ---- */
    for (const [lookup, re, name] of [[{ ok: false, error: "slow-down" }, /Too many tries/, "slow-down"], ["raw500", /Can't check prizes right now/, "unavailable (server junk)"], [{ ok: false, error: "unavailable" }, /Can't check prizes right now/, "unavailable"], [{ ok: false, error: "off" }, /4-letter code instead/, "off"], [{ ok: false, error: "bad-phone" }, /all 10 digits/, "bad-phone"]]) {
      await fresh(); world.lookup = lookup; await open(); await tapDigits(PHONE); await chrome.tap("#pzGo");
      await waitFor(async () => /\S/.test((await msg()) || ""), 5000, name + " message");
      ok(re.test(await msg()), name + " says: " + (await msg()));
      eq(await chrome.eval("_pzDigits"), "", name + ": number cleared");
      ok(!world.pending, name + ": nothing pending");
      await chrome.tap(".sheet-ft .linkbtn");     // Back
      await waitFor(() => chrome.rect("#arcPrizeRow"), 3000, name + ": back on the cart");
      ok(!!(await chrome.rect("#arcAsk")), name + ": the cart is intact and the order can go on");
      eq(await chrome.eval("cart.length"), 1);
      if (name === "slow-down") await chrome.shot("6-phone-slow-down-1080x1920.png");
    }

    /* ---- 6. the code pad: the real alphabet, big keys, lower half ---- */
    await fresh(); await open(); await chrome.tap(".pz-switch"); await waitFor(() => chrome.rect(".krow.pzalpha"), 3000, "code pad");
    const keys = await chrome.eval("[...document.querySelectorAll('.krow.pzalpha .kkey')].map(e=>({t:e.textContent,h:e.getBoundingClientRect().height,w:e.getBoundingClientRect().width,y:e.getBoundingClientRect().top+e.getBoundingClientRect().height/2}))");
    eq(keys.filter(k => k.t !== "⌫").map(k => k.t).join(""), ALPHA, "the keys are exactly the Worker's claim alphabet");
    ok(!/[ILO01]/.test(keys.map(k => k.t).join("")), "no look-alike characters (I L O 0 1)");
    for (const k of keys) { ok(k.h >= 64 && k.w >= 64, "code key " + k.t + " is >=64px (got " + Math.round(k.w) + "x" + Math.round(k.h) + ")"); ok(k.y > 960, "code key " + k.t + " is in the lower half"); }
    ok(/Use my phone number instead/.test(await chrome.eval("document.getElementById('sheet').innerText")), "and a way back to the phone pad");
    await tapCode("K7"); await chrome.tap(".krow.pzalpha .kkey[aria-label=delete]"); eq(await chrome.eval("_pzCode"), "K", "backspace");
    await tapCode("7QDX"); eq(await chrome.eval("_pzCode"), "K7QD", "a fifth letter is ignored");
    await chrome.shot("7-code-pad-1080x1920.png");
    world.code = { ok: true, found: true, label: PRIZE.label, expiresAt: Date.now() + 3600e3 };
    await chrome.tap("#pzGo");
    await waitFor(() => chrome.eval("!!document.getElementById('arcFound')"), 5000, "code found: the cart shows the prize");
    ok(/Prize found: Free Size Upgrade/.test(await chrome.eval("document.getElementById('arcFound').innerText")), "code found line");
    const codeReq = world.requests.filter(r => r.path === "/api/arcade/code"); eq(JSON.parse(codeReq[codeReq.length - 1].body), { code: "K7QD" }, "the code request is {code} only");
    eq(await chrome.eval("_pzCode"), "", "the code is cleared after the answer");
    // the cart sheet covers the banner, so the cart line has its own skip button (the same dismiss the banner uses)
    ok((await chrome.rect("#arcSkip")).h >= 64, "the skip button on the cart line is a real touch target");
    await chrome.tap("#arcSkip"); await waitFor(() => chrome.rect("#arcAsk"), 3000, "ask button returns after No thanks");
    ok(world.dismissed >= 1 && !world.pending, "skip used the existing dismiss and cleared the pending prize");

    for (const [code, re, name] of [[{ ok: true, found: false, status: "unknown" }, /isn't valid.*mistyped.*expired/, "unknown/expired"], [{ ok: true, found: false, status: "used" }, /already been used/, "used"], [{ ok: false, error: "slow-down" }, /Too many tries/, "slow-down"], [{ ok: false, error: "unavailable" }, /Can't check prizes right now/, "unavailable"]]) {
      await fresh(); world.code = code; await open(); await chrome.tap(".pz-switch"); await waitFor(() => chrome.rect(".krow.pzalpha"), 3000, "code pad"); await tapCode("ABCD"); await chrome.tap("#pzGo");
      await waitFor(async () => /\S/.test((await msg()) || ""), 5000, name + " message");
      ok(re.test(await msg()), "code " + name + ": " + (await msg()));
      ok(!world.pending && (await chrome.eval("cart.length")) === 1, "code " + name + ": nothing pending, cart intact");
      if (name === "used") await chrome.shot("8-code-used-1080x1920.png");
    }

    /* ---- 7. a reset (idle) leaves no typed number or code and no open pad ---- */
    await fresh(); await open(); await tapDigits("55512");
    await chrome.eval("resetAll(); 1");
    eq(await chrome.eval("[_pzDigits,_pzCode,_pzBusy]"), ["", "", false], "idle reset clears the pad state");
    ok(!(await chrome.eval("document.getElementById('overlay').classList.contains('show')||document.getElementById('overlay').classList.contains('pzpad')")), "idle reset closes the sheet and drops the pad layout");
    ok(!(await chrome.eval("/\\(555\\)/.test(document.documentElement.outerHTML)")), "no typed digits left in the DOM");
    // closing with the X also clears
    await fresh(); await open(); await tapDigits("55512"); await chrome.tap(".close");
    eq(await chrome.eval("_pzDigits"), "", "closing the sheet clears the number");

    /* ---- 8. landscape must not break ---- */
    await fresh(1920, 1080); await open();
    for (const k of await chrome.eval("[...document.querySelectorAll('.krow.numpad .kkey:not(.kblank)')].map(e=>e.getBoundingClientRect().height)")) ok(k >= 64, "landscape phone key >=64px");
    ok((await chrome.rect("#pzGo")).h >= 56, "landscape: Find is reachable"); await chrome.shot("9-phone-pad-1920x1080.png");
    await chrome.tap(".pz-switch"); await waitFor(() => chrome.rect(".krow.pzalpha"), 3000, "code pad (landscape)");
    for (const k of await chrome.eval("[...document.querySelectorAll('.krow.pzalpha .kkey')].map(e=>e.getBoundingClientRect().height)")) ok(k >= 60, "landscape code key >=60px");

    /* ---- 9. no console errors anywhere ---- */
    // page noise that exists without this feature: images the bare test server does not carry, and the page's own probe of the live station (blocked by CORS from 127.0.0.1)
    const noise = l => /Failed to load resource/.test(l.text) || /station\.thirstybeaches\.com/.test(l.text);
    const bad = chrome.logs.filter(l => (/error|exception/i.test(l.type) && !noise(l)) || (l.type === "warning" && /prize|pz|arcade/i.test(l.text)));
    eq(bad, [], "no console errors or exceptions during the whole run");
    console.log(`prize-pad: ${passed} checks passed` + (SHOTS ? ` (screenshots in ${SHOTS})` : ""));
  } catch (e) {
    console.error("prize-pad FAILED:", e.message, process.env.TB_DEBUG ? e.stack : ""); if (process.env.TB_DEBUG) console.error(chrome.logs.slice(-15));
    process.exitCode = 1;
  } finally { chrome.close(); server.close(); }
})();
