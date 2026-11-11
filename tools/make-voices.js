#!/usr/bin/env node
/* Thirsty Beaches — make the kiosk greeter's character voice clips with ElevenLabs
 * (kiosk repo version: reads assets/greeter/greeter-lines.js, writes assets/greeter/audio/)
 *
 * Needs Node 18+ and an ElevenLabs API key (elevenlabs.io → profile → API Keys).
 *
 *   Mac/Linux:   export ELEVENLABS_API_KEY=sk_...
 *   PowerShell:  $env:ELEVENLABS_API_KEY="sk_..."
 *
 *   node tools/make-voices.js --list-voices      show the voices on your account + their IDs
 *   node tools/make-voices.js --dry-run          show what would be made and how many characters it costs
 *   node tools/make-voices.js                    make every missing clip
 *   node tools/make-voices.js --only pirate      just one character
 *   node tools/make-voices.js --force            remake clips that already exist
 *   node tools/make-voices.js --manifest         just rebuild audio/manifest.js from what's on disk
 *
 * Paste each character's voice ID into greeter-lines.js (eleven.voiceId). Characters with no
 * voice ID are skipped and keep using the computer voice.
 * Clips go in assets/greeter/audio/<character>/<id>.mp3 and are added to update-manifest.json.
 * Then: node tools/publish-manifest.js, commit, push — the kiosk downloads them like any update.
 */
const fs = require("fs");
const path = require("path");
const { SHARED, PERSONAS, hash } = require("../assets/greeter/greeter-lines.js");

const API = "https://api.elevenlabs.io/v1";
const KEY = process.env.ELEVENLABS_API_KEY;
const MODEL = "eleven_v3";
const OUT = path.join(__dirname, "..", "assets", "greeter", "audio");
const UPDATE_MANIFEST = path.join(__dirname, "..", "update-manifest.json");
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function needKey() {
  if (!KEY) { console.error("Set ELEVENLABS_API_KEY first (see the top of this file)."); process.exit(1); }
}

async function listVoices() {
  needKey();
  const r = await fetch(`${API}/voices`, { headers: { "xi-api-key": KEY } });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const { voices } = await r.json();
  console.log("Voices on your account (add more from the Voice Library → 'Add to my voices'):\n");
  for (const v of voices) console.log(`  ${v.voice_id}   ${v.name}${v.labels?.accent ? "  (" + v.labels.accent + ")" : ""}`);
  console.log("\nWhat to look for in the Voice Library for each character:");
  for (const [k, p] of Object.entries(PERSONAS)) console.log(`  ${k.padEnd(9)} ${p.name.padEnd(24)} search: ${p.eleven.find}`);
}

function jobs() {
  const out = [];
  for (const [key, p] of Object.entries(PERSONAS)) {
    if (only && key !== only) continue;
    const lines = new Set();
    for (const cat of Object.keys(SHARED)) {
      (SHARED[cat] || []).forEach(l => lines.add(l));
      (p.lines[cat] || []).forEach(l => lines.add(l));
    }
    for (const line of lines) {
      const id = hash(line);
      const text = (p.eleven.prefix ? p.eleven.prefix + " " : "") + line;
      out.push({ key, p, id, text, file: path.join(OUT, key, id + ".mp3") });
    }
  }
  return out;
}

function writeManifest() {
  const m = {};
  if (fs.existsSync(OUT)) for (const key of Object.keys(PERSONAS)) {
    const dir = path.join(OUT, key);
    if (fs.existsSync(dir)) m[key] = fs.readdirSync(dir).filter(f => f.endsWith(".mp3")).map(f => f.slice(0, -4));
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "manifest.js"),
    "// Made by make-voices.js — list of recorded clips the kiosk can play\nwindow.TBG_AUDIO = " + JSON.stringify(m) + ";\n");
  const n = Object.values(m).flat().length;
  console.log(`assets/greeter/audio/manifest.js updated (${n} clips).`);
  // list every clip (and the clip list) in the kiosk update manifest so the kiosk downloads them
  const um = JSON.parse(fs.readFileSync(UPDATE_MANIFEST, "utf8"));
  const have = new Set(um.files.map(f => f.path));
  const want = ["assets/greeter/audio/manifest.js"];
  for (const [key, ids] of Object.entries(m)) for (const id of ids) want.push(`assets/greeter/audio/${key}/${id}.mp3`);
  const added = want.filter(p => !have.has(p));
  if (added.length) {
    const tailAt = um.files.findIndex(f => f.path === "tb-bootstrap.json");
    um.files.splice(tailAt < 0 ? um.files.length : tailAt, 0, ...added.map(p => ({ path: p })));
    fs.writeFileSync(UPDATE_MANIFEST, JSON.stringify(um, null, 2) + "\n");
  }
  console.log(`${added.length} new files added to update-manifest.json. Next: node tools/publish-manifest.js, commit, push.`);
}

async function tts(job) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(`${API}/text-to-speech/${job.p.eleven.voiceId}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text: job.text,
        model_id: MODEL,
        voice_settings: { stability: job.p.eleven.stability ?? 0.5, similarity_boost: 0.75 },
      }),
    });
    if (r.ok) return Buffer.from(await r.arrayBuffer());
    const body = await r.text();
    if (r.status === 429 || r.status >= 500) { await sleep(2000 * attempt); continue; }
    throw new Error(`${r.status} ${body}`);
  }
  throw new Error("gave up after retries");
}

async function main() {
  if (flag("--list-voices")) return listVoices();
  if (flag("--manifest")) return writeManifest();

  const all = jobs();
  const noVoice = [...new Set(all.filter(j => !j.p.eleven.voiceId).map(j => j.key))];
  const todo = all.filter(j => j.p.eleven.voiceId && (flag("--force") || !fs.existsSync(j.file)));
  const chars = todo.reduce((n, j) => n + j.text.length, 0);

  if (noVoice.length) console.log(`No voice ID yet (skipped, will use computer voice): ${noVoice.join(", ")}`);
  console.log(`${todo.length} clips to make, about ${chars.toLocaleString()} characters of ElevenLabs credit.`);
  if (flag("--dry-run")) {
    const all8 = all.reduce((n, j) => n + j.text.length, 0);
    console.log(`(Every character, every line: ${all.length} clips, about ${all8.toLocaleString()} characters.)`);
    return;
  }
  needKey();

  let done = 0, failed = 0;
  for (const j of todo) {
    try {
      fs.mkdirSync(path.dirname(j.file), { recursive: true });
      fs.writeFileSync(j.file, await tts(j));
      done++;
      console.log(`✓ ${j.key}/${j.id}  ${j.text}`);
    } catch (e) {
      failed++;
      console.log(`✗ ${j.key}  ${j.text}\n    ${e.message.slice(0, 200)}`);
      if (/quota|credits|401|invalid_api_key/i.test(e.message)) { console.log("Stopping: check your API key or credits."); break; }
    }
    await sleep(300);
  }
  console.log(`\nMade ${done}, failed ${failed}.`);
  writeManifest();
}

main().catch(e => { console.error(e.message); process.exit(1); });
