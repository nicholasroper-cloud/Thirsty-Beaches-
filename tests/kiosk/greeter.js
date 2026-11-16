// tests/kiosk/greeter.js — the attract-screen camera (assets/greeter/greeter.js) fails CLOSED and never records audio.
// Compliance gate 2026-11-15: on only when /control says greeter.enabled === true; an unreachable Control file, a missing key or any
// other value means OFF. Run: node tests/kiosk/greeter.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const ROOT = path.resolve(__dirname, "../..");
const src = fs.readFileSync(path.join(ROOT, "assets/greeter/greeter.js"), "utf8");
const lines = fs.readFileSync(path.join(ROOT, "assets/greeter/greeter-lines.js"), "utf8");

/* a stand-in that answers to anything (the greeter builds DOM it never shows in this test) */
function stub() {
  const f = function () {};
  return new Proxy(f, {
    get: (t, k) => k === Symbol.toPrimitive ? () => "" : k === "style" ? {} : k === "classList" ? { add() {}, remove() {}, toggle() {}, contains: () => false } : stub(),
    set: () => true, apply: () => stub(), construct: () => stub(),
  });
}
function load(controlAnswer) {
  const media = { calls: [] };
  const g = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    document: { createElement: () => stub(), head: stub(), body: stub(), currentScript: { src: "http://localhost/assets/greeter/greeter.js" }, getElementById: () => null, addEventListener() {} },
    location: { href: "http://localhost:8137/" },
    navigator: { mediaDevices: { getUserMedia: async opts => { media.calls.push(opts); return { getTracks: () => [] }; } } },
    speechSynthesis: { cancel() {}, speak() {}, speaking: false, getVoices: () => [], onvoiceschanged: null },
    SpeechSynthesisUtterance: class {},
    addEventListener() {}, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0,
    Date, Math, JSON, Promise, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set,
    fetch: async () => { if (controlAnswer === "unreachable") throw new Error("offline"); return { json: async () => controlAnswer }; },
    TB_GREETER: { tapToStart: false, controlUrl: "/control", activeWhen: () => true },
  };
  g.window = g;
  const ctx = vm.createContext(g);
  vm.runInContext(lines, ctx);
  vm.runInContext(src, ctx);
  return { g, media };
}
(async () => {
  let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

  // fail-closed default: nothing has said "on" yet
  let { g, media } = load("unreachable");
  const G = g.TBGreeter;
  ok(G && G._state, "greeter loaded");
  assert.strictEqual(G._state.enabled, false, "default is OFF before the first /control answer"); n++;
  ok(media.calls.length === 0, "the camera was never requested at boot");
  await G._pollControl();
  assert.strictEqual(G._state.enabled, false, "Control unreachable = OFF"); n++;

  // only the literal boolean true turns it on
  for (const [label, answer, want] of [
    ["no greeter key (what /control serves before its first fetch)", { soldOut: [] }, false],
    ["empty object", {}, false],
    ["enabled:false", { greeter: { enabled: false } }, false],
    ['enabled:"true"', { greeter: { enabled: "true" } }, false],
    ["enabled:1", { greeter: { enabled: 1 } }, false],
    ["greeter:null", { greeter: null }, false],
    ["not an object", "yes", false],
    ["enabled:true", { greeter: { enabled: true } }, true],
  ]) {
    ({ g } = load(answer));
    await g.TBGreeter._pollControl();
    assert.strictEqual(g.TBGreeter._state.enabled, want, label); n++;
    assert.strictEqual(g.TBGreeter._enabledFrom(answer), want, "enabledFrom: " + label); n++;
  }

  // on, then the Control file becomes unreachable: back to OFF (never "keep the last answer")
  let flip = { greeter: { enabled: true } };
  ({ g } = load(flip));
  await g.TBGreeter._pollControl();
  assert.strictEqual(g.TBGreeter._state.enabled, true); n++;
  g.fetch = async () => { throw new Error("github is down"); };
  await g.TBGreeter._pollControl();
  assert.strictEqual(g.TBGreeter._state.enabled, false, "enabled, then Control goes away -> OFF"); n++;

  // audio is never captured: every getUserMedia in the file says audio:false
  const calls = src.match(/getUserMedia\(\{[^)]*\)/g) || [];
  ok(calls.length >= 1, "found the camera request");
  for (const c of calls) ok(/audio:\s*false/.test(c), "getUserMedia must pass audio:false: " + c);
  ok(!/audio:\s*true/.test(src), "no audio:true anywhere");
  console.log("greeter: " + n + " checks passed");
})().catch(e => { console.error(e); process.exit(1); });
