// Tests for the kiosk's Boardwalk Slots arcade (kiosk/*, arcade-routes.js and its routes in kiosk-server.js).
//   - packaging: every arcade file is in the update manifest, the page and menu carry no camera, no "Dole Whip", no client-side codes
//   - prizes (C): no code without a Worker-issued claim; the daily cap is respected; KIOSK_KEY unset or Worker down = "thanks for playing"
//   - config (D): an unauthenticated POST is refused, bad odds are refused, labels are escaped, audio saves never carry the odds
//   - the REAL kiosk-server.js in a child process against a fake Worker and a fake Clover (E: a locked file cannot crash it)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const audioBank = require(path.join(ROOT, 'kiosk', 'audio-bank.js'));
const slots = require(path.join(ROOT, 'kiosk', 'boardwalk-slots.js'));
const arc = require(path.join(ROOT, 'arcade-routes.js'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ARCADE_FILES = [
  'kiosk/boardwalk-slots.html', 'kiosk/boardwalk-slots.css', 'kiosk/boardwalk-slots.js', 'kiosk/audio-bank.js', 'kiosk/arcade-menu.json', 'kiosk/audio/README.txt', 'arcade-routes.js',
];

/* ---------------- packaging ---------------- */
test('arcade files exist and every one is published in the update manifest', () => {
  const manifest = JSON.parse(read('update-manifest.json'));
  const listed = new Set(manifest.files.map((f) => f.path));
  for (const rel of ARCADE_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing ${rel}`);
    assert.ok(listed.has(rel), `${rel} is not in update-manifest.json, so the kiosk would never download it`);
  }
  const serverSrc = read('kiosk-server.js');
  assert.match(serverSrc, /pathname === "\/arcade"/);
  assert.match(serverSrc, /pathname\.startsWith\("\/kiosk\/"\)/);
  assert.match(serverSrc, /pathname === "\/api\/arcade-config"/);
  assert.match(serverSrc, /pathname === "\/api\/arcade\/spin"/);
  assert.doesNotMatch(serverSrc, /\bserveFile\(/, 'serveFile is not defined in kiosk-server.js: /arcade would hang');
});

test('arcade menu comes from the website schema and says pineapple soft serve, never Dole Whip', () => {
  const site = path.resolve(ROOT, '..', 'website-v2', 'site', 'menu-schema.json');
  if (fs.existsSync(site)) assert.equal(read('kiosk/arcade-menu.json'), fs.readFileSync(site, 'utf8'), 'kiosk/arcade-menu.json is stale against the website schema');
  const menu = JSON.parse(read('kiosk/arcade-menu.json'));
  assert.ok(menu.slotReels && menu.slotReels.bases.length && menu.slotReels.flavors.length);
  for (const f of fs.readdirSync(path.join(ROOT, 'kiosk')).filter((n) => /\.(js|json|html|css|txt)$/.test(n))) {
    assert.doesNotMatch(read('kiosk/' + f), /dole\s*whip/i, `Dole Whip appears in kiosk/${f}`);
  }
});

test('the arcade page has no camera, no vibe scan, no client-side prize or code generation', () => {
  const all = ['kiosk/boardwalk-slots.html', 'kiosk/boardwalk-slots.js', 'kiosk/boardwalk-slots.css', 'kiosk/audio-bank.js'].map(read).join('\n');
  for (const bad of [/getUserMedia/i, /mediaDevices/i, /Presence Cam/i, /GEMINI/i, /VISION/i, /Scan My Vibe/i, /scanVibe/i, /\/api\/vibe/, /camVideo/, /<video/i, /generate4DigitCode/, /rollWeightedPrize/]) {
    assert.doesNotMatch(all, bad, String(bad));
  }
  assert.equal(slots.generate4DigitCode, undefined);
  assert.equal(slots.rollWeightedPrize, undefined);
});

/* ---------------- the existing bundle checks ---------------- */
test('dual-persona audio bank & prize odds invariants hold', () => {
  assert.deepEqual(Object.keys(audioBank.PERSONAS).sort(), ['neon86', 'shredder']);
  assert.equal(audioBank.createAudioBank().getState().pgMode, true);
  assert.equal(slots.DEFAULT_ODDS.reduce((s, o) => s + o.pct, 0), 100);
  assert.deepEqual(slots.DEFAULT_ODDS.map((o) => o.pct), [81, 6, 5, 4, 3, 1]);
  assert.equal(slots.BARKER_COOLDOWN_MS, 45000);
});

test('the page fallback odds are identical to the server prize table', () => {
  assert.deepEqual(slots.DEFAULT_ODDS, arc.defaultOdds());
  assert.equal(slots.MAX_FREE_DRINK_PCT, arc.MAX_FREE_DRINK_PCT);
  assert.equal(arc.validateOdds(arc.defaultOdds()).ok, true);
});

/* ---------------- D: odds validation, config auth, escaping ---------------- */
const odds = (over = {}) => arc.PRIZES.map((p) => ({ id: p.id, pct: over[p.id] !== undefined ? over[p.id] : p.pct }));

test('odds validation: known ids only, numbers 0..100, sum 100, free drink capped', () => {
  assert.equal(arc.validateOdds(odds()).ok, true);
  assert.equal(arc.validateOdds(odds({ free_drink_jackpot: 2, standard: 80 })).ok, true);
  const bad = [
    ['unknown id', odds().map((o, i) => (i === 1 ? { ...o, id: 'free_everything' } : o))],
    ['duplicate id', odds().map((o, i) => (i === 2 ? { ...o, id: 'size_upgrade' } : o))],
    ['missing prize', odds().slice(0, 5)],
    ['extra prize', [...odds(), { id: 'standard', pct: 0 }]],
    ['string pct', odds().map((o, i) => (i === 0 ? { ...o, pct: '81' } : o))],
    ['NaN', odds({ standard: NaN })],
    ['Infinity', odds({ standard: Infinity })],
    ['negative', odds({ standard: 91, size_upgrade: -4 })],
    ['over 100', odds({ standard: 101, size_upgrade: 0, soft_serve_topper: 0, neon_charm: 0, topper_or_sticker: 0, free_drink_jackpot: -1 })],
    ['sum 99', odds({ standard: 80 })],
    ['sum 101', odds({ standard: 82 })],
    ['free drink 3', odds({ free_drink_jackpot: 3, standard: 79 })],
    ['free drink 50', odds({ free_drink_jackpot: 50, standard: 32 })],
    ['not a list', { standard: 100 }],
    ['null entry', [null, ...odds().slice(1)]],
  ];
  for (const [why, list] of bad) assert.equal(arc.validateOdds(list).ok, false, why);
  // labels come from the server table, never from the caller
  const v = arc.validateOdds(odds().map((o) => ({ ...o, label: '<img src=x onerror=alert(1)>' })));
  assert.equal(v.ok, true);
  assert.ok(v.odds.every((o) => !/[<>]/.test(o.label)));
});

function tmpArcade(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-arc-'));
  return { dir, a: arc.createArcade({ tbDir: dir, apiBase: 'http://worker.invalid', kioskKey: '', stationKey: 'staff-secret-key', fetchImpl: async () => { throw new Error('no network'); }, ...extra }) };
}

test('POST /api/arcade-config logic: unauthenticated refused, wrong key refused and counted, fails closed with no STATION_KEY', () => {
  const { dir, a } = tmpArcade();
  const file = path.join(dir, 'arcade-config.json');
  for (const key of [undefined, '', 'nope', 'staff-secret-key '.trim() + 'x']) assert.equal(a.saveConfig(key, { odds: odds() }).status, 401);
  assert.equal(fs.existsSync(file), false, 'nothing written without the key');
  assert.equal(a.saveConfig('staff-secret-key', { odds: odds() }).status, 200);
  assert.equal(fs.existsSync(file), true);
  // fail closed
  const closed = tmpArcade({ stationKey: '' });
  assert.equal(closed.a.saveConfig('', { odds: odds() }).status, 403);
  assert.equal(closed.a.saveConfig('anything', { odds: odds() }).status, 403);
  assert.equal(fs.existsSync(path.join(closed.dir, 'arcade-config.json')), false);
  // lockout after 8 wrong tries (even a right key waits)
  const lock = tmpArcade({ now: () => 1000 });
  for (let i = 0; i < 8; i++) assert.equal(lock.a.saveConfig('wrong', {}).status, 401);
  assert.equal(lock.a.saveConfig('wrong', {}).status, 429);
  assert.equal(lock.a.saveConfig('staff-secret-key', {}).status, 429);
});

test('config: bad odds refused with the key, partial saves keep the odds, free-drink cap, a corrupt file falls back to defaults', () => {
  const { dir, a } = tmpArcade();
  const K = 'staff-secret-key';
  assert.equal(a.saveConfig(K, { odds: odds({ free_drink_jackpot: 5, standard: 77 }) }).status, 400);
  assert.equal(a.saveConfig(K, { odds: odds({ standard: 90 }) }).status, 400);
  assert.equal(a.saveConfig(K, { odds: [{ id: 'standard', pct: 100 }] }).status, 400);
  assert.equal(a.saveConfig(K, { volume: 7 }).status, 400);
  assert.equal(a.saveConfig(K, { personaMode: 'free-prizes' }).status, 400);
  assert.equal(a.saveConfig(K, { muted: 'yes' }).status, 400);
  assert.deepEqual(a.getConfig().odds, arc.defaultOdds(), 'refused saves changed nothing');
  const mine = odds({ standard: 70, size_upgrade: 12, soft_serve_topper: 8, neon_charm: 5, topper_or_sticker: 3, free_drink_jackpot: 2 });
  assert.equal(a.saveConfig(K, { odds: mine }).status, 200);
  assert.equal(a.getConfig().odds.find((o) => o.id === 'size_upgrade').pct, 12);
  // an audio-only save (what volume / persona changes do) must not touch the odds
  assert.equal(a.saveConfig(K, { volume: 0.4, personaMode: 'neon86', muted: true }).status, 200);
  const c = a.getConfig();
  assert.equal(c.volume, 0.4); assert.equal(c.personaMode, 'neon86'); assert.equal(c.muted, true);
  assert.equal(c.odds.find((o) => o.id === 'size_upgrade').pct, 12, 'odds survive an audio-only save');
  // the key probe writes nothing
  const before = fs.readFileSync(path.join(dir, 'arcade-config.json'), 'utf8');
  assert.equal(a.saveConfig(K, { check: true }).status, 200);
  assert.equal(fs.readFileSync(path.join(dir, 'arcade-config.json'), 'utf8'), before);
  // a hand-edited file with a 60% jackpot is ignored
  const evil = JSON.parse(before); evil.odds = odds({ free_drink_jackpot: 60, standard: 22 });
  fs.writeFileSync(path.join(dir, 'arcade-config.json'), JSON.stringify(evil));
  assert.deepEqual(a.getConfig().odds, arc.defaultOdds());
});

test('labels are escaped wherever they are rendered; audio saves in the page never send the odds', () => {
  const html = slots.oddsGridHTML([{ id: 'standard', label: '<img src=x onerror=alert(1)>"\'&', pct: 81 }, { id: 'free_drink_jackpot', label: '<script>x</script>', pct: '1;alert(1)' }]);
  assert.doesNotMatch(html, /<img|<script/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
  assert.match(html, /value="0"/, 'a non-number becomes 0, it is never put in the markup');
  assert.equal(slots.esc('<b>"x"</b>'), '&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
  const js = read('kiosk/boardwalk-slots.js');
  // every innerHTML in the page goes through oddsGridHTML (which escapes)
  const inner = js.match(/innerHTML\s*=\s*[^;]+;/g) || [];
  assert.deepEqual(inner, ['innerHTML = oddsGridHTML(cfg.odds);']);
  // the only POSTs to the server: the staff drawer (with X-Key) and the spin
  assert.equal((js.match(/fetch\('\/api\/arcade-config', \{ method: 'POST'/g) || []).length, 1);
  assert.match(js, /'X-Key': staffKey/);
  const saveLocal = js.slice(js.indexOf('function saveLocalCfg'), js.indexOf('document.querySelectorAll(\'[data-persona]\').forEach((b) => {\n      b.addEventListener'));
  assert.ok(saveLocal.length > 20 && !/fetch\(|odds/.test(saveLocal), 'volume/persona/mute are local only');
  const audioBtn = js.slice(js.indexOf("$('saveAudioBtn')"), js.indexOf("// Odds only"));
  assert.ok(audioBtn.length > 20 && !/odds/.test(audioBtn), 'Save Audio Defaults never carries the odds');
});

/* ---------------- C: prizes through the Worker (in-process fake) ---------------- */
function fakeWorker({ cap = 100, minMs = 45000, kioskKey = 'k'.repeat(30), clock, down = false, playSecret = true } = {}) {
  const w = { tokens: new Map(), used: new Set(), minted: [], calls: [], cap, down };
  w.fetch = async (url, init = {}) => {
    const u = new URL(url); const method = (init.method || 'GET').toUpperCase();
    w.calls.push(method + ' ' + u.pathname);
    if (w.down) throw new Error('worker unreachable');
    const J = (status, obj) => ({ status, ok: status < 400, json: async () => obj });
    if (u.pathname === '/scores/token' && method === 'GET') {
      if (!playSecret) return J(503, { error: 'play-off' });
      const t = 'tok' + (w.tokens.size + 1); w.tokens.set(t, clock()); return J(200, { token: t, minMs });
    }
    if (u.pathname === '/kitchen/claim' && method === 'POST') {
      const body = JSON.parse(init.body || '{}');
      const isKiosk = (init.headers || {})['X-Kiosk-Key'] === kioskKey;
      if (!(body.score >= 600)) return J(400, { error: 'score-too-low' });
      const at = w.tokens.get(body.token);
      if (at === undefined || clock() - at < minMs) return J(403, { error: 'no-token' });
      if (w.used.has(body.token)) return J(409, { error: 'token-used' });
      if (w.minted.length >= w.cap) return J(429, { error: 'sold-out' });
      if (!isKiosk) return J(429, { error: 'daily-limit' });
      w.used.add(body.token);
      const code = ['K7QD', 'M2XR', 'P9WA', 'T4HN', 'V6BC', 'Y3EF'][w.minted.length % 6];
      w.minted.push({ code, score: body.score });
      return J(200, { ok: true, code, ticket: { code, reward: body.score >= 2000 ? 'Arcade Champ Free Upgrade + Secret Build' : 'Secret Menu Unlock', drinkName: 'Neon Rip Curl', build: 'Sprite · 2p Blue Raz', who: 'TB', expiresAt: clock() + 86400000 } });
    }
    return J(404, {});
  };
  return w;
}
const winRng = () => 0.95;   // lands on a prize row of the default table (cumulative 81 + 6 + 5 + ... )
const KEY = 'k'.repeat(30);

function prizeArcade({ now, worker, kioskKey = KEY, rng = winRng }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-arc-'));
  const logs = [];
  const a = arc.createArcade({ tbDir: dir, apiBase: 'http://worker.test', kioskKey, stationKey: 's', fetchImpl: worker.fetch, now, rng, log: (m) => logs.push(m) });
  return { a, logs };
}

test('prizes: a win shows only the code the Worker issued, with the kiosk key, from an old-enough single-use token', async () => {
  let t = 1_000_000; const clock = () => t;
  const worker = fakeWorker({ clock });
  const { a } = prizeArcade({ now: clock, worker });
  await a.refill();
  assert.equal(worker.tokens.size, 3);
  // too young: the roll is a prize but there is nothing to hand out
  let r = await a.spin();
  assert.equal(r.win, false); assert.equal(r.thanks, true); assert.equal(r.code, undefined);
  assert.equal(worker.minted.length, 0);
  t += 50_000;
  r = await a.spin();
  assert.equal(r.win, true);
  assert.equal(r.code, worker.minted[0].code, 'the page gets exactly the Worker code');
  assert.match(r.code, /^[A-Z2-9]{4}$/);
  assert.equal(r.ticket.reward, 'Secret Menu Unlock');
  assert.equal(worker.used.size, 1);
  // second win consumes a different token
  r = await a.spin();
  assert.equal(r.win, true); assert.notEqual(r.code, worker.minted[0].code); assert.equal(worker.used.size, 2);
});

test('prizes: the free-drink jackpot asks the Worker for the Arcade Champ tier', async () => {
  let t = 5_000_000; const clock = () => t; const worker = fakeWorker({ clock });
  const { a } = prizeArcade({ now: clock, worker, rng: () => 0.999 });
  await a.refill(); t += 50_000;
  const r = await a.spin();
  assert.equal(r.prizeId, 'free_drink_jackpot'); assert.equal(r.mega, true);
  assert.equal(worker.minted[0].score, 2000);
});

test('prizes: no KIOSK_KEY means no code and no Worker call at all', async () => {
  let t = 1; const clock = () => t; const worker = fakeWorker({ clock });
  const { a } = prizeArcade({ now: clock, worker, kioskKey: '' });
  t += 100_000;
  for (let i = 0; i < 5; i++) { const r = await a.spin(); assert.equal(r.win, false); assert.equal(r.thanks, true); assert.equal(r.code, undefined); }
  await a.refill();
  assert.deepEqual(worker.calls, []);
});

test('prizes: Worker unreachable, play-off or erroring means thanks-for-playing with no invented code', async () => {
  let t = 1; const clock = () => t;
  for (const mode of ['down', 'play-off']) {
    const worker = fakeWorker({ clock, down: mode === 'down', playSecret: mode !== 'play-off' });
    const { a } = prizeArcade({ now: clock, worker });
    await a.refill(); t += 100_000;
    for (let i = 0; i < 4; i++) { const r = await a.spin(); assert.equal(r.win, false, mode); assert.equal(r.thanks, true, mode); assert.equal(r.code, undefined, mode); }
    assert.equal(worker.minted.length, 0);
  }
  // a Worker that answers 200 with a malformed or missing code is not believed
  for (const bad of [{ ok: true }, { ok: true, code: '1234' }, { ok: true, code: 'ABCDE' }, { ok: false, code: 'K7QD' }, { ok: true, code: '<b>x' }]) {
    const worker = fakeWorker({ clock }); const orig = worker.fetch;
    worker.fetch = async (url, init) => (/kitchen\/claim/.test(url) ? { status: 200, ok: true, json: async () => bad } : orig(url, init));
    const { a } = prizeArcade({ now: clock, worker });
    await a.refill(); t += 100_000;
    const r = await a.spin(); assert.equal(r.win, false); assert.equal(r.code, undefined, JSON.stringify(bad));
  }
});

test('prizes: the daily cap is respected and a refused claim backs off instead of hammering the Worker', async () => {
  let t = 10_000_000; const clock = () => t;
  const worker = fakeWorker({ clock, cap: 2 });
  const { a } = prizeArcade({ now: clock, worker });
  await a.refill(); t += 50_000;
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await a.spin());
  assert.equal(results.filter((r) => r.win).length, 2, 'exactly the cap');
  assert.equal(worker.minted.length, 2);
  assert.ok(results.slice(2).every((r) => r.win === false && r.thanks === true && r.code === undefined));
  const claimCalls = worker.calls.filter((c) => c === 'POST /kitchen/claim').length;
  assert.equal(claimCalls, 3, 'two wins + one refused; then it stops asking');
  t += 11 * 60_000;   // backoff over: asks again (and is refused again)
  await a.refill();
  await a.spin();
  assert.equal(worker.calls.filter((c) => c === 'POST /kitchen/claim').length, 4, 'asks once more after the backoff, is refused again');
  assert.equal(worker.minted.length, 2);
});

test('prizes: token mints are capped per hour and only happen while the arcade is in use', async () => {
  let t = 1; const clock = () => t; const worker = fakeWorker({ clock });
  const { a } = prizeArcade({ now: clock, worker });
  await a.refillIfActive();
  assert.deepEqual(worker.calls, [], 'nobody opened the arcade: no mints');
  await a.touch();
  assert.equal(worker.tokens.size, 3);
  for (let i = 0; i < 40; i++) { t += 50_000; await a.spin(); }
  assert.ok(worker.calls.filter((c) => c === 'GET /scores/token').length <= 12, 'at most 12 mints an hour');
});

/* ---------------- the real kiosk-server.js, fake Worker + fake Clover ---------------- */
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
function request(port, method, p, obj, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = obj === undefined ? null : (typeof obj === 'string' ? obj : JSON.stringify(obj));
    const h = { Host: `127.0.0.1:${port}`, ...headers };
    if (method !== 'GET') Object.assign(h, { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, ...headers });
    if (data !== null) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, headers: res.headers, body: b, json }); });
    });
    r.on('error', reject); if (data !== null) r.write(data); r.end();
  });
}

test('REAL kiosk server: /arcade is served without a camera, the config is staff-only, spins use the Worker, a locked file cannot crash it', async (t) => {
  // fake Worker over HTTP (single-use tokens, minMs 100, cap 2) and a fake Clover that knows nothing
  const claimLog = []; const tokens = new Map(); const used = new Set(); let minted = 0;
  const workerPort = await freePort();
  const worker = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', (c) => (b += c)); rq.on('end', () => {
      const j = (s, o) => { rs.writeHead(s, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(o)); };
      if (rq.method === 'GET' && rq.url === '/scores/token') { const tk = 'tk' + tokens.size; tokens.set(tk, Date.now()); return j(200, { token: tk, minMs: 100 }); }
      if (rq.method === 'POST' && rq.url === '/kitchen/claim') {
        const body = JSON.parse(b || '{}'); claimLog.push({ key: rq.headers['x-kiosk-key'], body });
        if (rq.headers['x-kiosk-key'] !== KEY) return j(429, { error: 'daily-limit' });
        const at = tokens.get(body.token); if (at === undefined || Date.now() - at < 100) return j(403, { error: 'no-token' });
        if (used.has(body.token)) return j(409, { error: 'token-used' });
        if (minted >= 2) return j(429, { error: 'sold-out' });
        used.add(body.token); minted++;
        return j(200, { ok: true, code: 'K7QD'.slice(0, 3) + 'ABC'[minted], ticket: { reward: 'Secret Menu Unlock', drinkName: 'Neon Rip Curl', build: 'x', expiresAt: Date.now() + 1e6 } });
      }
      j(404, {});
    });
  });
  await new Promise((r) => worker.listen(workerPort, '127.0.0.1', r));
  const clover = http.createServer((rq, rs) => { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end('{"elements":[]}'); });
  const cloverPort = await freePort();
  await new Promise((r) => clover.listen(cloverPort, '127.0.0.1', r));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-arcsrv-'));
  for (const f of ['kiosk-server.js', 'kiosk-lib.js', 'flex-pay.js', 'pay-journal.js', 'pay-routes.js', 'catalog.js', 'quote.js', 'moderation.js', 'arcade-routes.js', 'addons.json', 'drink-kiosk.html', 'drink-kiosk-light.html']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'catalog-map.json'), JSON.stringify({ version: 1, floats: [], categories: {} }));
  fs.cpSync(path.join(ROOT, 'kiosk'), path.join(dir, 'kiosk'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'kiosk', 'locked.txt'), 'locked file, long enough to be real');
  fs.chmodSync(path.join(dir, 'kiosk', 'locked.txt'), 0o000);

  const port = await freePort();
  const child = cp.spawn(process.execPath, ['kiosk-server.js'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, CLOVER_API_TOKEN: 't', CLOVER_MERCHANT_ID: 'M', CLOVER_BASE_URL: 'http://127.0.0.1:' + cloverPort, PORT: String(port), KIOSK_HEARTBEAT_URL: 'off',
    PRIZE_API: 'http://127.0.0.1:' + workerPort, KIOSK_KEY: KEY, STATION_KEY: 'staff-secret-key-1234', TB_CATALOG_MS: '60000' } });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  t.after(async () => { child.kill(); worker.close(); clover.close(); try { fs.chmodSync(path.join(dir, 'kiosk', 'locked.txt'), 0o600); } catch {} });
  for (let i = 0; i < 80; i++) { try { if ((await request(port, 'GET', '/health')).status) break; } catch {} await sleep(100); }

  // the page: served, camera and microphone denied by header, nothing links to it from the ordering screen
  const page = await request(port, 'GET', '/arcade');
  assert.equal(page.status, 200); assert.match(page.body, /1986 BOARDWALK DRINK SLOTS/);
  assert.match(String(page.headers['permissions-policy']), /camera=\(\)/);
  assert.doesNotMatch(page.body, /getUserMedia|Scan My Vibe|Presence Cam|Dole/i);
  assert.equal((await request(port, 'GET', '/kiosk/boardwalk-slots.js')).status, 200);
  assert.notEqual((await request(port, 'GET', '/kiosk/..%2fkiosk-server.js')).status, 200);
  assert.ok([403, 404].includes((await request(port, 'GET', '/kiosk/')).status));
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'drink-kiosk.html'), 'utf8'), /\/arcade/, 'no link from the ordering screen in this release');

  // E: a locked file answers an error and the server keeps running
  const locked = await request(port, 'GET', '/kiosk/locked.txt');
  assert.ok(locked.status === 503 || locked.status === 200, 'locked file: ' + locked.status);
  assert.equal((await request(port, 'GET', '/health')).status, 200, 'still alive after the locked file');
  assert.equal(child.exitCode, null);

  // D: the config is staff-only
  const good = arc.PRIZES.map((p) => ({ id: p.id, pct: p.pct }));
  assert.equal((await request(port, 'POST', '/api/arcade-config', { odds: good })).status, 401);
  assert.equal((await request(port, 'POST', '/api/arcade-config', { odds: good }, { 'X-Key': 'wrong' })).status, 401);
  assert.equal((await request(port, 'POST', '/api/arcade-config', { odds: good.map((o) => (o.id === 'free_drink_jackpot' ? { ...o, pct: 30 } : o.id === 'standard' ? { ...o, pct: 52 } : o)) }, { 'X-Key': 'staff-secret-key-1234' })).status, 400);
  assert.deepEqual((await request(port, 'GET', '/api/arcade-config')).json.config.odds, arc.defaultOdds(), 'nothing a customer sent changed the odds');
  // staff: every spin a prize (standard 0, jackpot 2 = the legal maximum)
  const allWin = good.map((o) => (o.id === 'standard' ? { ...o, pct: 0 } : o.id === 'size_upgrade' ? { ...o, pct: 89 } : o.id === 'free_drink_jackpot' ? { ...o, pct: 2 } : { ...o, pct: o.id === 'soft_serve_topper' ? 4 : o.id === 'neon_charm' ? 3 : 2 }));
  assert.equal(allWin.reduce((s, o) => s + o.pct, 0), 100);
  const saved = await request(port, 'POST', '/api/arcade-config', { odds: allWin }, { 'X-Key': 'staff-secret-key-1234' });
  assert.equal(saved.status, 200, saved.body);

  // C: a spin right after the page loaded has no old-enough token yet: thanks, no code; later spins carry real Worker codes up to the cap
  const first = await request(port, 'POST', '/api/arcade/spin', {});
  assert.equal(first.status, 200); assert.equal(first.json.win, false); assert.equal(first.json.code, undefined);
  await sleep(2600);
  const wins = [];
  for (let i = 0; i < 4; i++) wins.push((await request(port, 'POST', '/api/arcade/spin', {})).json);
  const got = wins.filter((w) => w.win);
  assert.equal(got.length, 2, 'the Worker cap of 2 is respected: ' + JSON.stringify(wins));
  assert.ok(got.every((w) => /^[A-Z2-9]{4}$/.test(w.code) && w.ticket.reward === 'Secret Menu Unlock'));
  assert.ok(wins.filter((w) => !w.win).every((w) => w.thanks === true && w.code === undefined));
  assert.ok(claimLog.length >= 2 && claimLog.every((c) => c.key === KEY), 'claims carry the kiosk key from the server');
  // the browser never sees a key
  assert.doesNotMatch(JSON.stringify(wins) + (await request(port, 'GET', '/api/arcade-config')).body + page.body, new RegExp(KEY + '|staff-secret-key'));
  assert.equal(child.exitCode, null, out);
});
