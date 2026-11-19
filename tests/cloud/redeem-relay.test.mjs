// The staff redeem relay (make-station-server.js on the PC, cloud/src/kitchen-sync.js in the Worker) against a fake tb-where Worker that
// enforces the REAL rules from worker-tb-where/src/routes/kitchen.js:
//   - a 4-character claim: staff access (kiosk key) and a single use
//   - a Salty Dog Tags VIP-XXXX pass: needs sig = first 12 hex of HMAC-SHA256(CROSS_BRAND_SECRET, code), else 403 bad-signature
// The relay must never fail a real pass with a 403, never sign a code nobody vouched for, and say "verify-at-sdt" when it cannot prove one.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import cp from "node:child_process";
import { fileURLToPath } from "node:url";
import { redeemKitchenClaim } from "../../cloud/src/kitchen-sync.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const KIOSK_KEY = "k".repeat(30), CB = "cross-brand-secret-value-for-tests";
const hmac12 = (secret, code) => crypto.createHmac("sha256", secret).update(code).digest("hex").slice(0, 12);
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const used = new Set(), calls = [];
const claims = new Map([["K7QD", { code: "K7QD", drinkName: "Neon Rip Curl", reward: "Secret Menu Unlock", redeemed: false }]]);
const server = http.createServer((rq, rs) => {
  let b = ""; rq.on("data", c => b += c); rq.on("end", () => {
    const j = (s, o) => { rs.writeHead(s, { "Content-Type": "application/json" }); rs.end(JSON.stringify(o)); };
    const u = new URL(rq.url, "http://x");
    if (u.pathname === "/pickups") return j(rq.headers["x-cross-brand-key"] === CB ? 200 : 401, { pickups: [{ id: "SDT-AAAA1", customerName: "Pat", vipCode: "VIP-ABCD" }] });
    if (u.pathname === "/kitchen/claims/redeem" && rq.method === "POST") {
      calls.push(JSON.parse(b || "{}"));
      const body = JSON.parse(b || "{}");
      if (rq.headers["x-kiosk-key"] !== KIOSK_KEY) return j(401, { error: "unauthorized" });
      const clean = String(body.code || "").toUpperCase().replace(/[^A-Z0-9-]/g, "");
      const vip = clean.match(/^VIP-?([A-Z2-9]{4,8})$/);
      if (vip) {
        const code = "VIP-" + vip[1];
        if (!body.sig || String(body.sig).toLowerCase() !== hmac12(CB, code)) return j(403, { ok: false, status: "bad-signature" });
        if (used.has(code)) return j(200, { ok: false, status: "used", code });
        if (body.checkOnly !== true) used.add(code);
        return j(200, { ok: true, status: body.checkOnly ? "valid" : "redeemed", ticket: { code, type: "cross-brand-vip" } });
      }
      const rec = claims.get(clean.replace(/-/g, ""));
      if (!rec) return j(404, { ok: false, status: "unknown" });
      if (rec.redeemed) return j(200, { ok: false, status: "used", ticket: rec });
      if (body.checkOnly === true) return j(200, { ok: true, status: "valid", ticket: rec });
      rec.redeemed = true; return j(200, { ok: true, status: "redeemed", ticket: rec });
    }
    j(404, {});
  });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
const reset = () => { used.clear(); calls.length = 0; claims.get("K7QD").redeemed = false; };
let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; }; const eq = (a, b, m) => { assert.deepEqual(a, b, m); passed++; };

/* ---------------- the cloud Worker's relay (cloud/src/kitchen-sync.js) ---------------- */
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(String(url).replace("https://saltydogtags.com/api/tags-pickup", origin + "/pickups"), init);
  const env = { TB_WHERE_ORIGIN: origin, KIOSK_KEY, CROSS_BRAND_SECRET: CB };
  const call = (body, e = env) => redeemKitchenClaim({ ...e }, body);

  reset();
  let r = await call({ code: "k7qd" });
  eq([r.status, r.body.ok, r.body.status], [200, true, "redeemed"], "4-char claim redeems");
  r = await call({ code: "K7QD" }); eq(r.body.status, "used", "second redeem is used");

  reset();
  r = await call({ code: "VIP-ABCD" });                                  // the pass is in the signed SDT feed: the relay can prove it
  eq([r.status, r.body.ok, r.body.status], [200, true, "redeemed"], "VIP in the SDT feed redeems, no 403");
  eq(calls[0].sig, hmac12(CB, "VIP-ABCD"), "the relay sent the signature the Worker requires");
  r = await call({ code: "vip-abcd" }); eq(r.body.status, "used", "a VIP pass is single use");

  reset();
  r = await call({ code: "VIP-ZZZZ" });                                  // nobody vouched for this code
  eq([r.status, r.body.ok, r.body.status], [200, false, "verify-at-sdt"], "unknown VIP is reported, not a 403");
  ok(/Salty Dog Tags/.test(r.body.message));
  eq(calls.length, 0, "the Worker was never asked, and the relay never signed an unvouched code");

  reset();
  r = await call({ code: "VIP-ZZZZ", sig: hmac12(CB, "VIP-ZZZZ") });    // a signature scanned off the pass itself
  eq([r.body.ok, r.body.status], [true, "redeemed"], "a scanned pass signature is forwarded");
  reset();
  r = await call({ code: "VIP-ZZZZ", sig: "0123456789ab" });
  eq([r.status, r.body.status], [403, "bad-signature"], "a forged signature is still refused by the Worker");
  reset();
  r = await call({ code: "VIP-ABCD", checkOnly: true });
  eq([r.body.ok, r.body.status], [true, "valid"], "check only does not burn the pass");
  eq(used.size, 0);

  reset();
  r = await call({ code: "VIP-ABCD" }, { TB_WHERE_ORIGIN: origin, KIOSK_KEY });   // no shared secret on this Worker
  eq(r.body.status, "verify-at-sdt", "without CROSS_BRAND_SECRET the relay cannot sign: verify at the SDT order");
  eq(calls.length, 0);
  globalThis.fetch = realFetch;
}

/* ---------------- the local make-station-server.js on the PC ---------------- */
{
  const clover = http.createServer((rq, rs) => { rs.writeHead(200, { "Content-Type": "application/json" }); rs.end('{"elements":[]}'); });
  await new Promise(r => clover.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-relay-"));
  for (const f of ["make-station-server.js", "make-station.html", "pickup-board.html", "recipes.json", "addons.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  const spawnStation = async (extra) => {
    const port = await freePort();
    const c = cp.spawn(process.execPath, ["make-station-server.js"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, CLOVER_API_TOKEN: "t", CLOVER_MERCHANT_ID: "M", CLOVER_BASE_URL: "http://127.0.0.1:" + clover.address().port, MAKE_PORT: String(port), MAKE_BIND: "127.0.0.1", TB_WHERE_ORIGIN: origin, KIOSK_KEY, SDT_PICKUP_URL: origin + "/pickups", ...extra } });
    for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch {} await sleep(100); }
    const post = async (body) => { const r = await fetch(`http://127.0.0.1:${port}/api/kitchen/redeem`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    return { c, post };
  };
  let s = await spawnStation({ CROSS_BRAND_SECRET: CB });
  try {
    reset();
    let r = await s.post({ code: "k7qd" });
    eq([r.status, r.body.ok, r.body.status], [200, true, "redeemed"], "local: 4-char claim redeems");
    reset();
    r = await s.post({ code: "VIP-ABCD" });
    eq([r.status, r.body.ok, r.body.status], [200, true, "redeemed"], "local: VIP in the SDT feed redeems, no 403");
    eq(calls[0].sig, hmac12(CB, "VIP-ABCD"));
    reset();
    r = await s.post({ code: "VIP-ZZZZ" });
    eq([r.status, r.body.ok, r.body.status], [200, false, "verify-at-sdt"], "local: an unvouched VIP is reported, not a 403");
    eq(calls.length, 0, "local: the Worker was never asked");
    reset();
    r = await s.post({ code: "VIP-ZZZZ", sig: hmac12(CB, "VIP-ZZZZ") });
    eq([r.body.ok, r.body.status], [true, "redeemed"], "local: scanned signature forwarded");
    reset();
    r = await s.post({ code: "VIP-ABCD", checkOnly: true });
    eq([r.body.ok, r.body.status], [true, "valid"]);
  } finally { s.c.kill(); }
  s = await spawnStation({});   // no CROSS_BRAND_SECRET on this PC
  try {
    reset();
    const r = await s.post({ code: "VIP-ABCD" });
    eq(r.body.status, "verify-at-sdt", "local: no shared secret, so the pass is verified at the SDT order");
    eq(calls.length, 0);
  } finally { s.c.kill(); clover.close(); }
}
server.close();
console.log(`redeem relay tests ok (${passed} checks)`);
process.exit(0);
