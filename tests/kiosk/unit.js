// tests/kiosk/unit.js — pure-function checks for kiosk-lib.js and the supervisor helpers.
// Run: node tests/kiosk/unit.js
"use strict";
const path = require("path");
const assert = require("assert");
const lib = require("../../kiosk-lib");
const sup = require("../../kiosk-supervisor")._internals;

let n = 0;
const t = (name, fn) => { fn(); n++; };
const root = path.resolve("/kiosk");

t("safe paths", () => {
  for (const ok of ["drink-kiosk.html", "assets/logo.png", "kiosk-server.js", "clover-menu-server.js", "flex-pay.js",
                    "kiosk-lockdown/Setup-Appliance.ps1", "Run-Kiosk.bat", "clover-menu-server.next.js"])
    assert.ok(lib.safeUpdatePath(root, ok), ok);
  for (const bad of ["../x.js", "/etc/passwd", "a/../../x", "..", "", "C:\\x.js", "a\\b.js", "kiosk-config.env", "KIOSK-CONFIG.ENV",
                     "kiosk-config.env.", "kiosk-config.env.bak", "x.env", "update-state.json", "Update-State.json", "flex-pairing.json",
                     "node.exe", "evil.dll", "node_modules/ws/index.js", ".tb/supervisor-state.json", ".git/config", "assets/.hidden",
                     "CON", "nul.txt", "com1.js", "a:b.js", "KIOSK~1.ENV", "x/", "a//b", "drink kiosk.html", "x.js ", 42, null])
    assert.strictEqual(lib.safeUpdatePath(root, bad), null, String(bad));
  for (const bad of ["../x", "kiosk-config.env.", ".tb/x", "a\\b", "x.env", "node.exe", "update-state.json"])
    assert.strictEqual(sup.relOk(bad), false, "supervisor relOk " + bad);
  assert.strictEqual(sup.relOk("kiosk-server.js"), true);
});

t("restart classification", () => {
  for (const r of ["kiosk-server.js", "kiosk-lib.js", "flex-pay.js", "moderation.js", "kiosk-supervisor.js", "clover-menu-server.js", "addons.json", "Kiosk-Server.JS"])
    assert.ok(lib.isRestartFile(r), r);
  for (const c of ["drink-kiosk.html", "assets/logo.png", "make-station-server.js", "clover-menu-server.next.js", "Run-Kiosk.bat", "recipes.json", "assets/x.js", "package.json"])
    assert.ok(!lib.isRestartFile(c), c);
});

t("settings validation", () => {
  const { settings, errors } = lib.validateSettings({
    UPDATE_INTERVAL_MIN: 30, HIDE_CATEGORIES: "A, B,,C",
    AI_DESIGN_ENABLED: false, VIBE_MODEL: "claude-haiku-4-5", DRINK_MODEL: "claude-opus-4-8",
  });
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(settings, { UPDATE_INTERVAL_MIN: 30,
    HIDE_CATEGORIES: ["A", "B", "C"], AI_DESIGN_ENABLED: false, VIBE_MODEL: "claude-haiku-4-5", DRINK_MODEL: "claude-opus-4-8" });
  const bad = lib.validateSettings({ CLOVER_API_TOKEN: "x", PORT: 1,
    UPDATE_INTERVAL_MIN: 1, VIBE_MODEL: "gpt-4", DRINK_MODEL: "claude-x; rm -rf", HIDE_CATEGORIES: [1], AI_DESIGN_ENABLED: 1,
    UPDATE_MANIFEST_URL: "https://evil" });
  assert.deepStrictEqual(bad.settings, {});
  assert.strictEqual(bad.errors.length, 8);
  assert.ok(bad.errors.some(e => /CLOVER_API_TOKEN is not allowed/.test(e)));
  assert.ok(bad.errors.some(e => /UPDATE_MANIFEST_URL is not allowed/.test(e)));
  assert.deepStrictEqual(lib.validateSettings(null), { settings: {}, errors: [] });
  assert.strictEqual(lib.validateSettings([1]).errors.length, 1);
  assert.strictEqual(lib.settingsHash({ a: 1, b: 2 }), lib.settingsHash({ b: 2, a: 1 }));
  assert.notStrictEqual(lib.settingsHash({}), lib.settingsHash({ a: 1 }));
});

t("commands", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  const st = {};
  let r = lib.dueCommands({ restartAt: "2026-10-25T11:59:00Z", reloadScreenAt: "2026-10-25T12:30:00Z", checkUpdateAt: "nope", wipe: "x" }, st, now);
  assert.deepStrictEqual(r.due.map(d => d.name), ["restartAt"]);
  assert.strictEqual(r.errors.length, 2);
  st.restartAt = r.due[0].t;
  r = lib.dueCommands({ restartAt: "2026-10-25T11:59:00Z" }, st, now);
  assert.strictEqual(r.due.length, 0, "runs once");
  r = lib.dueCommands({ restartAt: "2026-10-25T11:58:00Z" }, st, now);
  assert.strictEqual(r.due.length, 0, "older than last run");
  r = lib.dueCommands({ restartAt: "2026-10-25T11:59:30Z" }, st, now);
  assert.strictEqual(r.due.length, 1, "newer one runs");
  r = lib.dueCommands({ reloadScreenAt: "2026-11-05T12:00:00Z" }, {}, now);
  assert.ok(/7 days/.test(r.errors[0]));
  assert.deepStrictEqual(lib.dueCommands(null, {}, now), { due: [], errors: [] });
});

t("error scrubbing", () => {
  const s = lib.scrub("update check failed: 404 for https://raw.githubusercontent.com/o/r/main/x.json?t=1761390000000&token=abc " +
                      "Bearer sk-FAKE-not-a-key-0000 https://hc-ping.com/00000000-1111-4222-8333-444444444444 bob@example.com card 4111111111111111");
  assert.ok(!/sk-FAKE|00000000-1111|bob@|4111111111111111|token=abc|1761390000000/.test(s), s);
  assert.ok(s.length <= 160);
  assert.strictEqual(lib.maskCloverPath("/orders/ABC123DEF456/line_items?x=1"), "/orders/:id/line_items");
  const ring = new lib.ErrorRing(3);
  for (const m of ["a", "a", "b", "c", "d"]) ring.push(m);
  const l = ring.list();
  assert.strictEqual(l.length, 3);
  assert.ok(l[0].startsWith("b"));
});

t("env file keys", () => {
  const fs = require("fs"), os = require("os");
  const f = path.join(os.tmpdir(), "tb-unit.env");
  fs.writeFileSync(f, "# c\r\nCLOVER_API_TOKEN=abc#def\r\n  PORT = 8137\r\nexport X=1\r\nnot a line\r\n");
  assert.deepStrictEqual(sup.envFileKeys(f), ["CLOVER_API_TOKEN", "PORT", "X"]);
  fs.rmSync(f);
});

t("S1: the public Control file can never turn tap-to-pay on or move the reader", () => {
  for (const v of [true, "true", 1, "1", "yes", "TRUE"]) {
    const r = lib.validateSettings({ PAY_ENABLED: v });
    assert.deepStrictEqual(r.settings, {}, "PAY_ENABLED " + JSON.stringify(v) + " must not become a setting");
    assert.ok(r.errors.some(e => /PAY_ENABLED is not allowed/.test(e)));
  }
  for (const k of ["FLEX_IP", "FLEX_PORT", "PAY_TIMEOUT_MS", "FLEX_WS_SCHEME"]) {
    const r = lib.validateSettings({ [k]: k === "FLEX_IP" ? "10.0.0.9" : 12345 });
    assert.deepStrictEqual(r.settings, {}, k);
    assert.ok(r.errors.some(e => new RegExp(k + " is not allowed").test(e)), k);
    assert.ok(!(k in lib.SETTINGS_SPEC), k + " is not in SETTINGS_SPEC");
  }
  // kill-only: only the literal boolean false is a kill; nothing the file says is ever an enable
  assert.strictEqual(lib.payKillFrom({ payEnabled: false }), true);
  for (const v of [true, "true", 1, "false", 0, null, undefined]) assert.strictEqual(lib.payKillFrom({ payEnabled: v }), false, String(v));
  assert.strictEqual(lib.payKillFrom(null), null, "no control data (failed fetch) = no answer, keep the last state");
  assert.strictEqual(lib.payKillFrom([]), null);
});

t("S4: only https://hc-ping.com/ may be pinged from the Control file", () => {
  assert.strictEqual(lib.safeHealthUrl("https://hc-ping.com/abc-123"), "https://hc-ping.com/abc-123");
  for (const bad of ["http://hc-ping.com/x", "https://hc-ping.com.evil.com/x", "https://evil.com/hc-ping.com/", "http://192.168.1.1/admin", "https://user:pw@hc-ping.com/x",
    "https://hc-ping.com:8443/x", "file:///etc/passwd", "", null, 42, "https://hc-ping.com/" + "a".repeat(300)])
    assert.strictEqual(lib.safeHealthUrl(bad), "", String(bad));
});

t("S7: request guard", () => {
  const req = (method, headers) => ({ method, headers });
  const P = 8137;
  assert.strictEqual(lib.requestProblem(req("GET", { host: "localhost:8137" }), P), null);
  assert.strictEqual(lib.requestProblem(req("GET", { host: "127.0.0.1:8137" }), P), null);
  assert.strictEqual(lib.requestProblem(req("GET", { host: "127.0.0.1:8137", "sec-fetch-site": "none" }), P), null);
  assert.ok(lib.requestProblem(req("GET", { host: "attacker.com:8137" }), P), "rebinding host");
  assert.ok(lib.requestProblem(req("GET", { host: "localhost" }), P), "missing port");
  assert.ok(lib.requestProblem(req("GET", {}), P), "no host");
  assert.ok(lib.requestProblem(req("GET", { host: "localhost:8137", "sec-fetch-site": "cross-site" }), P));
  assert.ok(lib.requestProblem(req("GET", { host: "localhost:8137", "sec-fetch-site": "same-site" }), P));
  const ok = { host: "localhost:8137", origin: "http://localhost:8137", "content-type": "application/json" };
  assert.strictEqual(lib.requestProblem(req("POST", ok), P), null);
  assert.strictEqual(lib.requestProblem(req("POST", { ...ok, "content-type": "application/json; charset=utf-8" }), P), null);
  assert.ok(lib.requestProblem(req("POST", { ...ok, origin: undefined }), P), "missing Origin");
  assert.ok(lib.requestProblem(req("POST", { ...ok, origin: "https://evil.com" }), P));
  assert.ok(lib.requestProblem(req("POST", { ...ok, origin: "http://localhost:9999" }), P));
  assert.ok(lib.requestProblem(req("POST", { ...ok, "content-type": "text/plain" }), P));
  assert.ok(lib.requestProblem(req("DELETE", { ...ok, "content-type": undefined }), P));
});

t("CR-006: a stale Control copy switches the greeter off", () => {
  const c = { greeter: { enabled: true, volume: 0.5 }, soldOut: ["x"] };
  assert.strictEqual(lib.controlPublic(c, 0).greeter.enabled, true);
  assert.strictEqual(lib.controlPublic(c, lib.CONTROL_STALE_MS).greeter.enabled, true, "exactly 15 minutes is still fresh");
  assert.strictEqual(lib.controlPublic(c, lib.CONTROL_STALE_MS + 1).greeter.enabled, false, "older than 15 minutes = off");
  assert.strictEqual(lib.controlPublic(c, null).greeter.enabled, true, "no age given (first fetch) keeps the fetched value");
  assert.deepStrictEqual(lib.controlPublic(null, null).greeter, { enabled: false }, "no Control data at all = off");
  assert.deepStrictEqual(lib.controlPublic(c, 20 * 60000).soldOut, ["x"], "sold-out lists still served from the last copy");
});

console.log(`unit: ${n} groups passed`);
