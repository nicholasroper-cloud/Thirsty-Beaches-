// tests/kiosk/music-file.js — the shipped music loop is what the code expects (no browser): kiosk/audio/bgm/miami-beach-80s.wav
//   16-bit stereo 44.1 kHz PCM, exactly 8 bars at 112 BPM (756000 frames) so a buffer loop wraps sample-exact; normalised (peak <= -3 dBFS, no clipping);
//   no click at the seam (the step from the last frame to the first is no bigger than an ordinary step inside the track); it is in the update manifest.
// Run: node tests/kiosk/music-file.js
"use strict";
const assert = require("assert"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.resolve(__dirname, "../..");
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };

const buf = fs.readFileSync(path.join(ROOT, "kiosk/audio/bgm/miami-beach-80s.wav"));
eq(buf.toString("latin1", 0, 4) + buf.toString("latin1", 8, 12), "RIFFWAVE", "a RIFF WAVE file");
eq([buf.readUInt16LE(20), buf.readUInt16LE(22), buf.readUInt32LE(24), buf.readUInt16LE(34)], [1, 2, 44100, 16], "PCM, stereo, 44100 Hz, 16 bit");
eq(buf.toString("latin1", 36, 40), "data", "the data chunk follows the format chunk directly");
const n = buf.readUInt32LE(40) / 4;
eq(n, 756000, "exactly 756000 frames = 8 bars x 4 beats at 112 BPM = 17.142857 s");
eq(buf.length, 44 + n * 4, "no trailing chunks");
const s = (i, c) => buf.readInt16LE(44 + (i * 2 + c) * 2) / 32768;
let peak = 0, sq = 0, step = 0;
for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) { const v = s(i, c); peak = Math.max(peak, Math.abs(v)); sq += v * v; if (i) { const d = v - s(i - 1, c); step += d * d; } }
const rmsDb = 10 * Math.log10(sq / (2 * n)), peakDb = 20 * Math.log10(peak);
ok(peakDb <= -3 && peakDb >= -9, "normalised, not clipping: peak " + peakDb.toFixed(2) + " dBFS");
ok(rmsDb > -20.5 && rmsDb < -17, "normalised to -16 LUFS (RMS " + rmsDb.toFixed(2) + " dBFS)");
const typical = Math.sqrt(step / (2 * (n - 1)));
for (let c = 0; c < 2; c++) ok(Math.abs(s(0, c) - s(n - 1, c)) < 3 * typical, "channel " + c + ": the seam step " + Math.abs(s(0, c) - s(n - 1, c)).toFixed(4) + " is no click (typical step " + typical.toFixed(4) + ")");
const man = JSON.parse(fs.readFileSync(path.join(ROOT, "update-manifest.json"), "utf8"));
const f = (man.files || []).find(x => x.path === "kiosk/audio/bgm/miami-beach-80s.wav");
ok(f && f.sha256 === crypto.createHash("sha256").update(buf).digest("hex"), "it is in the update manifest with its sha256");
ok(!(man.files || []).some(x => /\.m4a$/.test(x.path)), "no .m4a ships (the kiosk server does not serve that type)");
const srv = fs.readFileSync(path.join(ROOT, "kiosk-server.js"), "utf8");
ok(/"\.wav": "audio\/wav"/.test(srv), "the kiosk server already serves .wav as audio/wav (no engine change)");
console.log(`music-file: ${passed} checks passed`);
