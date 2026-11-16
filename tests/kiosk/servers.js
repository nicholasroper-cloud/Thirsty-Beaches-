// tests/kiosk/servers.js — real processes against a fake Clover: make-station-server.js and kiosk-server.js.
// Covers server hardening (NUL path, "GET //", assets prefix, key / bind rules, no wildcard CORS), the order feed beyond 100
// orders, daily order numbers, Picked up, the "MODS:" line note, and server-side customer-name rules.
// Run: node tests/kiosk/servers.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const cp = require("child_process");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "../..");
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

/* ---------------- fake Clover ---------------- */
const fake = { orders: [], posts: [], pageSizes: [], control: {}, mixBodies: [], vibeCalls: 0, hdrs: [], prize: { check: { ok: true }, burn: { ok: true } }, prizeCalls: [] };
let seqId = 0;
const mkOrder = (o = {}) => ({ id: "ORD" + String(++seqId).padStart(6, "0"), createdTime: Date.now() - 1000, state: "open", paymentState: "OPEN", total: 0, note: "", lineItems: { elements: [{ name: "Thirst Trap", price: 349 }] }, ...o });
const clover = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let body = ""; req.on("data", c => body += c); req.on("end", () => {
    const j = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const m = u.pathname.replace(/^\/v3\/merchants\/[^/]+/, "");
    if (req.method === "GET" && u.pathname === "/control.json") return j(200, fake.control);
    if (req.method === "POST" && u.pathname === "/redeem") { const b = JSON.parse(body || "{}"); fake.prizeCalls.push({ redeem: !!b.redeem, key: req.headers["x-kiosk-key"] || null }); return j(200, b.redeem ? fake.prize.burn : fake.prize.check); }
    if (req.method === "POST" && u.pathname === "/api/mix") { fake.hdrs.push({ route: "mix", key: req.headers["x-kiosk-key"] || null }); const b = JSON.parse(body || "{}"); fake.mixBodies.push(b); return j(200, { name: "Boozy Bikini", why: "Pure vodka vibes", base: "Sprite", size: "16oz" }); }
    if (req.method === "POST" && u.pathname === "/api/vibe") { fake.hdrs.push({ route: "vibe", key: req.headers["x-kiosk-key"] || null }); fake.vibeCalls++; return j(200, { ai: true, id: "thirst-trap", nickname: "Drunk Pirate", reading: "Smells like weed", why: "A shot of rum" }); }
    if (req.method === "GET" && m === "/items") return j(200, { elements: [] });
    if (req.method === "GET" && m === "/orders") {
      const lim = +u.searchParams.get("limit") || 100, off = +u.searchParams.get("offset") || 0;
      const desc = /DESC/.test(u.searchParams.get("orderBy") || "");
      const all = fake.orders.slice().sort((a, b) => desc ? b.createdTime - a.createdTime : a.createdTime - b.createdTime);
      fake.pageSizes.push({ lim, off, desc });
      return j(200, { elements: all.slice(off, off + lim) });
    }
    if (req.method === "POST" && m === "/orders") { const o = mkOrder({ lineItems: { elements: [] } }); fake.orders.push(o); fake.posts.push({ m, body: JSON.parse(body) }); return j(200, o); }
    let mm;
    if (req.method === "POST" && /^\/orders\/[^/]+\/discounts$/.test(m)) { fake.posts.push({ m, body: JSON.parse(body) }); return j(200, {}); }
    if (req.method === "POST" && (mm = /^\/orders\/([^/]+)\/line_items$/.exec(m))) {
      const b = JSON.parse(body); fake.posts.push({ m, body: b });
      const o = fake.orders.find(x => x.id === mm[1]); o.lineItems.elements.push(b); return j(200, { id: "LI" + (++seqId), ...b });
    }
    if (req.method === "POST" && (mm = /^\/orders\/([^/]+)$/.exec(m))) {
      const b = JSON.parse(body); fake.posts.push({ m, body: b });
      Object.assign(fake.orders.find(x => x.id === mm[1]), b); return j(200, {});
    }
    j(404, { message: "no" });
  });
});

/* ---------------- helpers ---------------- */
function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method: "GET", headers }, res => { let b = ""; res.on("data", c => b += c); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    r.on("error", reject); r.end();
  });
}
function post(port, p, obj, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof obj === "string" ? obj : JSON.stringify(obj);
    const r = http.request({ host: "127.0.0.1", port, path: p, method: "POST", headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:" + port, "Content-Length": Buffer.byteLength(data), ...headers } },
      res => { let b = ""; res.on("data", c => b += c); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    r.on("error", reject); r.write(data); r.end();
  });
}
function raw(port, requestLine) {   // send a request line the http client would refuse to build (e.g. "GET // HTTP/1.1")
  return new Promise(resolve => {
    const s = net.connect(port, "127.0.0.1", () => s.write(requestLine + "\r\nHost: x\r\nConnection: close\r\n\r\n"));
    let b = ""; s.on("data", c => b += c); s.on("close", () => resolve(b)); s.on("error", () => resolve(b));
  });
}
async function waitUp(port, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await get(port, "/health"); if (r.status) return true; } catch {} await sleep(100); } return false; }
function spawnNode(dir, file, env) {
  const child = cp.spawn(process.execPath, [file], { cwd: dir, env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.out = ""; child.stdout.on("data", d => child.out += d); child.stderr.on("data", d => child.out += d);
  return child;
}
const stop = c => new Promise(r => { if (c.exitCode !== null) return r(); c.on("exit", () => r()); c.kill(); });
function stage(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-srv-"));
  for (const f of files) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, "assets")); fs.writeFileSync(path.join(dir, "assets", "ok.txt"), "asset");
  fs.mkdirSync(path.join(dir, "assets-old")); fs.writeFileSync(path.join(dir, "assets-old", "secret.txt"), "SIBLING-SECRET");
  return dir;
}

/* ---------------- make-station-server.js ---------------- */
async function stationTests(cloverPort) {
  const dir = stage(["make-station-server.js", "make-station.html", "pickup-board.html", "recipes.json", "addons.json"]);
  const base = { CLOVER_API_TOKEN: "t", CLOVER_MERCHANT_ID: "M", CLOVER_BASE_URL: "http://127.0.0.1:" + cloverPort, MAKE_POLL_SEC: "3" };

  // a wildcard bind with no key is refused outright
  let c = spawnNode(dir, "make-station-server.js", { ...base, MAKE_PORT: String(await freePort()), MAKE_BIND: "0.0.0.0" });
  await new Promise(r => c.on("exit", r));
  eq(c.exitCode, 78, "0.0.0.0 without STATION_KEY must refuse to start: " + c.out);
  ok(/STATION_KEY/.test(c.out), "the refusal explains the fix");

  // 150 orders: the feed must keep the NEWEST, not the first 100
  fake.orders = []; fake.pageSizes = [];
  const t0 = Date.now() - 3 * 3600000;
  for (let i = 0; i < 150; i++) fake.orders.push(mkOrder({ createdTime: t0 + i * 1000 }));
  fake.orders[149].lineItems.elements = [{ name: "Thirst Trap · Medium 24oz, Dr Pepper", note: "MODS: Medium 24oz | Dr Pepper | Coconut | Float: Vanilla | Freeze-dried candy", price: 349 }];
  fake.orders[148].note = "Sam — Kiosk order #777";
  const port = await freePort();
  c = spawnNode(dir, "make-station-server.js", { ...base, MAKE_PORT: String(port), STATION_KEY: "s3cret-key" });
  ok(await waitUp(port), "station starts with a key (binds 0.0.0.0): " + c.out);
  try {
    let r = await get(port, "/queue");
    eq(r.status, 401, "no key -> 401");
    { const h = JSON.parse((await get(port, "/health")).body); eq([h.keyRequired, h.bind], [true, "0.0.0.0"], "/health reports keyRequired and the bind address (the launcher warns on 127.0.0.1)"); }
    r = await get(port, "/queue", { "X-Key": "wrong-key" });
    eq(r.status, 401, "wrong key -> 401");
    r = await get(port, "/queue", { "X-Key": "s3cret-key" });
    eq(r.status, 200, "X-Key works");
    r = await get(port, "/queue?k=s3cret-key");
    eq(r.status, 200, "?k= still works for one more release");
    ok(!("access-control-allow-origin" in r.headers), "no CORS header");
    const q = JSON.parse(r.body);
    await sleep(0);
    eq(q.waiting.length, 150, "all 150 tickets present (old query kept only the oldest 100)");
    ok(fake.pageSizes.every(p => p.desc), "feed asks Clover newest-first");
    ok(fake.pageSizes.some(p => p.off === 100), "and pages past 100");
    const newest = q.waiting[q.waiting.length - 1];
    eq(newest.items[0].mods, ["Medium 24oz", "Dr Pepper", "Coconut", "Float: Vanilla", "Freeze-dried candy"], "full add-on list read from the MODS note");
    eq(newest.items[0].name, "Thirst Trap");
    eq(newest.items[0].note, "", "the MODS note is not shown as a customer note");
    const nums = q.waiting.map(o => +o.ticket);
    eq(nums[0], 101, "daily numbers start at 101"); eq(new Set(nums).size, 150, "numbers are unique");
    ok(q.waiting.find(o => o.id === fake.orders[148].id).ticket === "777", "a number written by the kiosk is kept");
    ok(newest.ref && newest.ref.length === 4, "the 4-character Clover code stays available as ref");

    // done / picked up / undo
    const id = newest.id;
    r = await post(port, "/pickedup", { id }, { "X-Key": "s3cret-key" });
    eq(r.status, 409, "cannot pick up what is not made");
    r = await post(port, "/done", { id }, { "X-Key": "s3cret-key" }); eq(r.status, 200);
    let q2 = JSON.parse((await get(port, "/queue", { "X-Key": "s3cret-key" })).body);
    ok(q2.ready.some(o => o.id === id), "made ticket is Ready"); eq(q2.waiting.length, 149);
    r = await post(port, "/pickedup", { id }, { "X-Key": "s3cret-key" }); eq(r.status, 200);
    q2 = JSON.parse((await get(port, "/queue", { "X-Key": "s3cret-key" })).body);
    ok(!q2.ready.some(o => o.id === id), "Picked up clears it from Ready");
    r = await post(port, "/undo", { id }, { "X-Key": "s3cret-key" }); eq(r.status, 200);
    q2 = JSON.parse((await get(port, "/queue", { "X-Key": "s3cret-key" })).body);
    eq(q2.waiting.length, 150, "undo brings it back");
    r = await post(port, "/done", '{"id":"' + id + '"}', { "X-Key": "s3cret-key", "Content-Type": "text/plain" });
    eq(r.status, 415, "text/plain POST (no CORS preflight) is refused");
    r = await post(port, "/done", { id }, {}); eq(r.status, 401, "POST without key");

    // hardening
    ok(/^HTTP\/1\.1 400/.test(await raw(port, "GET // HTTP/1.1")), "GET // answers 400 instead of killing the process");
    eq((await get(port, "/assets/%00")).status, 400, "NUL byte in an asset path");
    eq((await get(port, "/assets/ok.txt")).body, "asset", "normal asset still served");
    const sib = await get(port, "/assets/..%2fassets-old%2fsecret.txt");
    ok(sib.status === 403 && !/SIBLING/.test(sib.body), "a sibling folder named assets-* is not served: " + sib.status);
    eq((await get(port, "/assets/..%2fmake-station-server.js")).status, 403, "traversal out of assets");
    eq((await get(port, "/health")).status, 200, "still serving after all of that");
  } finally { await stop(c); }

  // no key, no bind: loopback only
  const p2 = await freePort();
  c = spawnNode(dir, "make-station-server.js", { ...base, MAKE_PORT: String(p2) });
  ok(await waitUp(p2), "default start (loopback only)");
  ok(/LAN access is OFF/.test(c.out), "says why the Show cannot reach it");
  eq(JSON.parse((await get(p2, "/health")).body).bind, "127.0.0.1", "/health says it is loopback-only");
  await stop(c);
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------------- kiosk-server.js ---------------- */
async function kioskTests(cloverPort) {
  const dir = stage(["kiosk-server.js", "kiosk-lib.js", "flex-pay.js", "moderation.js", "addons.json", "drink-kiosk.html", "drink-kiosk-light.html"]);
  fake.orders = []; fake.posts = [];
  fake.control = { soldOut: ["thirst-trap"], healthcheckUrl: "http://10.0.0.1/steal", settings: { UPDATE_INTERVAL_MIN: 30 }, commands: {},
    greeter: { enabled: "true", volume: 0.5 },
    specials: [
      { id: "ok-special", name: "Sunset Fizz", blurb: "Peach and coconut", label: "NEW", catKey: "dirtysodas", base: "base:Dr Pepper", baseItemId: "pour-decisions", mods: ["flavor:Coconut"], updated: "2026-11-15T10:00:00Z" },
      { id: "x');alert(1);//", name: "Evil", blurb: "", label: "", catKey: "dirtysodas", mods: [] },
      { id: "ok-two", name: "<img src=x onerror=alert(1)>", blurb: "", label: "", catKey: "dirtysodas", mods: [] },
      { id: "ok-three", name: "Fine", blurb: "x".repeat(500), label: "", catKey: "dirtysodas", mods: [] },
      { id: "ok-four", name: "Fine", blurb: "", label: "", catKey: "dirtysodas", mods: ["flavor:<script>"] },
    ] };
  const port = await freePort();
  const c = spawnNode(dir, "kiosk-server.js", { CLOVER_API_TOKEN: "t", CLOVER_MERCHANT_ID: "M", CLOVER_BASE_URL: "http://127.0.0.1:" + cloverPort, PORT: String(port), KIOSK_HEARTBEAT_URL: "off", MIX_URL: "http://127.0.0.1:" + cloverPort + "/api/mix", VIBE_URL: "http://127.0.0.1:" + cloverPort + "/api/vibe", PRIZE_API: "http://127.0.0.1:" + cloverPort, KIOSK_KEY: "kiosk-secret-xyz", CONTROL_URL: "http://127.0.0.1:" + cloverPort + "/control.json" });
  ok(await waitUp(port), "kiosk server starts: " + c.out);
  try {
    eq((await get(port, "/assets/%00")).status, 400, "NUL byte in an asset path");
    eq((await get(port, "/health")).body, "ok", "kiosk server survived /assets/%00");
    const sib = await get(port, "/assets/..%2fassets-old%2fsecret.txt");
    ok(sib.status === 403 && !/SIBLING/.test(sib.body), "sibling folder not served: " + sib.status);
    eq((await get(port, "/assets/ok.txt")).body, "asset");
    // ---- S7: Host / Origin / content type / Sec-Fetch-Site, no CORS ----
    eq((await get(port, "/health", { Host: "evil.example:" + port })).status, 403, "wrong Host (DNS rebinding) refused");
    eq((await get(port, "/health", { Host: "localhost:" + port })).status, 200, "localhost:PORT accepted");
    eq((await get(port, "/health", { "Sec-Fetch-Site": "cross-site" })).status, 403, "cross-site fetch refused");
    eq((await get(port, "/health", { "Sec-Fetch-Site": "same-origin" })).status, 200);
    eq((await get(port, "/health", { "Sec-Fetch-Site": "none" })).status, 200);
    const noOrigin = await new Promise((resolve, reject) => { const d = JSON.stringify({ cart: [] }); const r = http.request({ host: "127.0.0.1", port, path: "/order", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": d.length } }, res => { res.resume(); resolve(res.statusCode); }); r.on("error", reject); r.end(d); });
    eq(noOrigin, 403, "POST without Origin refused");
    eq((await post(port, "/order", { cart: [] }, { Origin: "http://evil.example" })).status, 403, "POST from another origin refused");
    eq((await post(port, "/order", { cart: [] }, { "Content-Type": "text/plain" })).status, 403, "text/plain POST refused (no-preflight CSRF)");
    eq((await post(port, "/order", { cart: [] }, { Origin: "http://localhost:" + port })).status, 400, "same-origin JSON POST reaches the route (empty cart -> 400)");
    const pg = await get(port, "/");
    ok(!("access-control-allow-origin" in pg.headers), "no CORS headers");
    const csp = pg.headers["content-security-policy"] || "";
    for (const d of ["default-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'none'", "object-src 'none'"]) ok(csp.includes(d), "CSP has " + d);
    ok(!/connect-src[^;]*\*/.test(csp), "no wildcard connect-src");

    // ---- S2: the page only gets validated control data ----
    const ctl = JSON.parse((await get(port, "/control")).body);
    eq(ctl.specials.map(x => x.id), ["ok-special"], "only the valid special survives (bad id, markup in name, long blurb, markup in a mod all dropped)");
    eq(ctl.soldOut, ["thirst-trap"]);
    ok(!("healthcheckUrl" in ctl) && !("settings" in ctl) && !("commands" in ctl), "the page never sees the health URL, settings or commands");
    eq(ctl.greeter.enabled, false, 'greeter.enabled is true only for the literal boolean true ("true" is not)');
    // ---- compliance: AI text is moderated, and no photo goes anywhere without the age screen's yes ----
    const img = "data:image/jpeg;base64," + Buffer.from("fakejpeg").toString("base64");
    let m = JSON.parse((await post(port, "/mix", { image: img, mood: "Sunny" })).body);
    ok(!/boozy|vodka/i.test(m.name + m.why), "Snap name/why pass the denylist: " + m.name + " / " + m.why); ok(m.name.length > 0 && m.why.length > 0, "with a curated fallback");
    eq(fake.mixBodies.length, 1); ok(!("image" in fake.mixBodies[0]), "no age13 = the photo is NOT forwarded (mood only)");
    await post(port, "/mix", { image: img, mood: "Sunny", age13: true });
    ok("image" in fake.mixBodies[1], "age screen yes = photo forwarded");
    await post(port, "/mix", { image: img, kid: true, age13: true });
    ok(!("image" in fake.mixBodies[2]), "kid mode never forwards a photo");
    eq(JSON.parse((await post(port, "/vibe", { image: "AAAA", candidates: [{ id: "thirst-trap", name: "Thirst Trap", desc: "x" }] })).body), { ai: false }, "Vibe without the age yes = no analysis");
    eq(fake.vibeCalls, 0, "and nothing was sent upstream");
    const vb = JSON.parse((await post(port, "/vibe", { image: "AAAA", age13: true, candidates: [{ id: "thirst-trap", name: "Thirst Trap", desc: "x" }] })).body);
    ok(vb.ai === true && vb.nickname === "" && !/weed|rum|shot/i.test(vb.reading + vb.why), "Vibe nickname/reading/why are moderated (nickname empty -> the page makes its own)");
    ok(/process\.on\("unhandledRejection"/.test(fs.readFileSync(path.join(ROOT, "kiosk-server.js"), "utf8")), "unhandledRejection handler present");

    const mods = ["Medium 24oz", "Dr Pepper", "Coconut", "Vanilla", "Cherry", "Peach", "Raspberry", "Caramel", "Lime", "Blue Raspberry", "Strawberry", "Mango", "Pineapple", "Vanilla Sweet Cream", "Blended / frozen", "Fresh lime", "Popping boba", "Extra pump", "Whipped cream", "Sweet cream cold foam", "Freeze-dried candy", "Float: Dole Whip"];
    ok(mods.join(", ").length > 127, "test cart is longer than the Clover name cap");
    let r = await post(port, "/order", { cart: [{ name: "Thirst Trap", mods, unit: 9.5, qty: 1 }], name: "Sam Roper" });
    eq(r.status, 200, r.body);
    let d = JSON.parse(r.body);
    eq(d.seq, 101, "first order of the day is 101"); eq(d.name, "Sam", "first word only");
    const li = fake.posts.find(p => /line_items$/.test(p.m)).body;
    ok(li.name.length <= 127, "line name within the cap"); ok(li.name.startsWith("Thirst Trap · Medium 24oz, Dr Pepper"), li.name);
    ok(!/[,·] [^,·]*$/.test(li.name) || mods.some(m => li.name.endsWith(m)), "the name ends on a whole add-on, not half of one");
    eq(li.note, "MODS: " + mods.join(" | "), "the note carries EVERY add-on");
    eq(fake.orders[0].note, "Sam — Kiosk order #101");
    r = await post(port, "/order", { cart: [{ name: "Thirst Trap", mods: ["Small 16oz"], unit: 3.49, qty: 1 }], name: "fuck" });
    d = JSON.parse(r.body);
    eq(d.seq, 102, "second order is 102"); ok(/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(d.name), "denylisted name becomes a beach name: " + d.name);
    r = await post(port, "/order", { cart: [{ name: "Thirst Trap", mods: [], unit: 3.49, qty: 1 }], name: "A-b'c defghijklmnop 12" });
    eq(JSON.parse(r.body).name, "A-b'c", "letters, hyphen and apostrophe only; first word");
    r = await post(port, "/order", { cart: [{ name: "Thirst Trap", mods: [], unit: 3.49, qty: 1 }], name: "Maximilianoooooo" });
    eq(JSON.parse(r.body).name, "Maximilianoo", "capped at 12 characters");
    eq(JSON.parse((await post(port, "/order", { cart: [{ name: "Thirst Trap", mods: [], unit: 3.49, qty: 1 }], name: "" })).body).name, "", "no name stays no name");
    ok(!fake.orders.some(o => /Roper/.test(o.note)), "the second word never reaches Clover");
    eq(JSON.parse((await post(port, "/order", { cart: [{ name: "Thirst Trap", mods: [], unit: 3.49, qty: 1 }], name: "Captain Riptide" })).body).name, "Captain Riptide", "the kiosk's own two-word beach name is kept");
    eq(JSON.parse((await post(port, "/order", { cart: [{ name: "Thirst Trap", mods: [], unit: 3.49, qty: 1 }], name: "Captain Hottie" })).body).name, "Captain", "a made-up two-word name is cut to its first word");

    // ---- Worker handshake: X-Kiosk-Key on the Maze burn and the AI forwards; a failed burn is a failed order ----
    const cart1 = { cart: [{ name: "Thirst Trap", mods: ["Small 16oz"], unit: 3.49, qty: 1 }], name: "Sam", code: "MAZE123456" };
    const ordersBefore = fake.orders.length, postsBefore = fake.posts.length;
    fake.prizeCalls = []; fake.prize = { check: { ok: true }, burn: { ok: false, status: "offline" } };
    let pr = await post(port, "/order", cart1);
    eq(pr.status, 400, "burn failed -> the order fails");
    eq(JSON.parse(pr.body).error, "bad-code", "the page is told the code did not work");
    eq(fake.orders.length, ordersBefore, "NO Clover order was created"); eq(fake.posts.length, postsBefore, "and no discount or line was posted");
    ok(fake.prizeCalls.length === 2 && fake.prizeCalls[1].redeem === true, "check, then burn");
    ok(fake.prizeCalls.every(c => c.key === "kiosk-secret-xyz"), "every prize call carries X-Kiosk-Key");
    fake.prize = { check: { ok: true }, burn: { ok: true } }; fake.prizeCalls = [];
    pr = await post(port, "/order", cart1);
    eq(pr.status, 200, "burn ok -> order goes through: " + pr.body);
    ok(fake.posts.some(p => /discounts$/.test(p.m) && p.body.amount === -80), "discount applied");
    ok(fake.prizeCalls.filter(c => c.redeem).length === 1, "burned exactly once");
    fake.prize = { check: { ok: false, status: "used" }, burn: { ok: true } }; fake.prizeCalls = [];
    pr = await post(port, "/order", cart1);
    eq(pr.status, 400, "an already-used code is refused at the check"); ok(fake.prizeCalls.every(c => !c.redeem), "and never burned");
    fake.prize = { check: { ok: true }, burn: { ok: true } };
    fake.hdrs = [];
    await post(port, "/mix", { image: "data:image/jpeg;base64," + Buffer.from("x").toString("base64"), age13: true });
    await post(port, "/vibe", { image: "AAAA", age13: true, candidates: [{ id: "thirst-trap", name: "T", desc: "x" }] });
    ok(fake.hdrs.length === 2 && fake.hdrs.every(h => h.key === "kiosk-secret-xyz"), "/mix and /vibe forwards carry X-Kiosk-Key: " + JSON.stringify(fake.hdrs));
    
  } finally { await stop(c); }
  fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  await new Promise(r => clover.listen(0, "127.0.0.1", r));
  const cp_ = clover.address().port;
  try { await stationTests(cp_); await kioskTests(cp_); }
  catch (e) { console.error(e); clover.close(); process.exit(1); }
  clover.close();
  console.log("servers: " + passed + " checks passed");
  process.exit(0);
})();
