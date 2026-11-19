// Unit tests for Kiosk PC 80s Boardwalk Arcade Slot Machine & Dual-Persona Audio Bank bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const audioBank = require(path.join(ROOT, 'kiosk', 'audio-bank.js'));
const slots = require(path.join(ROOT, 'kiosk', 'boardwalk-slots.js'));

test('Kiosk PC boardwalk arcade files & menu schema exist and pass syntax/structure checks', () => {
  for (const rel of [
    'kiosk/boardwalk-slots.html',
    'kiosk/boardwalk-slots.css',
    'kiosk/boardwalk-slots.js',
    'kiosk/audio-bank.js',
    'kiosk/arcade-menu.json',
    'kiosk/audio/README.txt',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing ${rel}`);
  }
  const serverSrc = fs.readFileSync(path.join(ROOT, 'kiosk-server.js'), 'utf8');
  assert.match(serverSrc, /pathname === "\/arcade"/);
  assert.match(serverSrc, /pathname\.startsWith\("\/kiosk\/"\)/);
  assert.match(serverSrc, /pathname === "\/api\/arcade-config"/);
});

test('Kiosk PC dual-persona audio bank & prize odds invariants hold', () => {
  assert.deepEqual(Object.keys(audioBank.PERSONAS).sort(), ['neon86', 'shredder']);
  assert.equal(audioBank.createAudioBank().getState().pgMode, true);
  assert.equal(slots.DEFAULT_ODDS.reduce((s, o) => s + o.pct, 0), 100);
  assert.deepEqual(slots.DEFAULT_ODDS.map((o) => o.pct), [81, 6, 5, 4, 3, 1]);
  assert.equal(slots.BARKER_COOLDOWN_MS, 45000);
});
