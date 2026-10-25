#!/usr/bin/env node
/* tools/publish-manifest.js — rebuild update-manifest.json (+ tb-bootstrap.json) for a kiosk push.

   Usage (from the repo root, after editing files, before committing):
     node tools/publish-manifest.js              bump "version" by 1, recompute every sha256/size/url
     node tools/publish-manifest.js --version 30 set an exact version
     node tools/publish-manifest.js --no-bump    recompute hashes only (e.g. after a merge)
     node tools/publish-manifest.js --check      exit 1 if the manifest does not match the files (CI / pre-push)
     node tools/publish-manifest.js --verify-remote   after pushing: download every URL and compare sha256
   Options: --base <raw url prefix>  (default: raw.githubusercontent.com/<owner>/Thirsty-Beaches-/main)

   What it guarantees for the kiosk:
     - every listed file exists, is >= 32 bytes (older kiosk servers abort the whole update on a
       smaller file), parses (.js: node --check, .json: JSON.parse), has no obvious secret in it
     - the kiosk server files are always listed, with tb-bootstrap.json and moderation.js LAST
       (an old server writes files in manifest order; the switch-over hook must arrive last)
     - each URL carries ?v=<sha prefix> so a CDN can never hand out a stale copy under a new hash
     - .bat files keep CRLF line endings
*/
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = path.join(ROOT, "update-manifest.json");
const BOOTSTRAP = path.join(ROOT, "tb-bootstrap.json");
const DEFAULT_BASE = "https://raw.githubusercontent.com/nicholasroper-cloud/Thirsty-Beaches-/main";

/* kiosk-relative path -> repo file it is published from (same path unless listed here) */
const SOURCE = { "clover-menu-server.next.js": "clover-menu-server.js" };
/* always shipped; in this order, after the existing entries */
const KIOSK_FILES = [
  "kiosk-server.js", "kiosk-lib.js", "kiosk-supervisor.js", "flex-pay.js", "addons.json", "package.json",
  "clover-menu-server.js", "clover-menu-server.next.js",
  "Run-Kiosk.bat", "Stop-Kiosk.bat", "Debug-Kiosk.bat", "Fix-And-Run.bat", "Install-AutoStart.bat", "Remove-AutoStart.bat",
  "assets/cup-80s-shell.webp", "assets/cup-80s-cream.png", "assets/logo-480.webp",
  "READ-ME-FIRST.txt", "remote-update-SETUP.txt",
  "kiosk-lockdown/Setup-Appliance.ps1", "kiosk-lockdown/Uninstall-Appliance.ps1", "kiosk-lockdown/READ-ME-APPLIANCE.txt",
];
const LAST = ["tb-bootstrap.json", "moderation.js"];
/* what the switch-over hook (moderation.js) verifies before it starts the new server */
const BOOTSTRAP_FILES = ["kiosk-server.js", "kiosk-lib.js", "kiosk-supervisor.js", "clover-menu-server.next.js"];

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const BASE = (opt("--base") || DEFAULT_BASE).replace(/\/+$/, "");
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");
const die = m => { console.error("ERROR: " + m); process.exit(1); };

function relOk(rel) {
  if (typeof rel !== "string" || !/^[A-Za-z0-9._\-\/]+$/.test(rel)) return false;
  for (const s of rel.split("/")) if (!s || s.startsWith(".") || s.endsWith(".")) return false;
  const base = path.posix.basename(rel.toLowerCase());
  return !(base.endsWith(".env") || base.includes(".env.") || ["update-state.json", "flex-pairing.json"].includes(base) ||
           [".exe", ".dll", ".node"].includes(path.posix.extname(base)) || rel.toLowerCase().startsWith("node_modules/"));
}
const SECRET_RES = [
  /sk-ant-[A-Za-z0-9_-]{10,}/, /hc-ping\.com\/[0-9a-f]{8}-[0-9a-f]{4}/i,
  /CLOVER_API_TOKEN\s*=\s*[A-Za-z0-9-]{12,}/, /ANTHROPIC_API_KEY\s*=\s*\S{12,}/, /STATION_CLOUD_KEY\s*=\s*\S{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bghp_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/,
];

function fileInfo(rel) {
  const src = SOURCE[rel] || rel;
  const fp = path.join(ROOT, ...src.split("/"));
  if (!fs.existsSync(fp)) die(`${rel}: source file ${src} not found`);
  const buf = fs.readFileSync(fp);
  if (buf.length < 32) die(`${rel} is only ${buf.length} bytes — older kiosk servers abort on files under 32 bytes`);
  const text = /\.(js|json|bat|ps1|txt|html|md|css|svg)$/i.test(rel) ? buf.toString("utf8") : null;
  if (text != null) for (const re of SECRET_RES) if (re.test(text)) die(`${rel} looks like it contains a secret (${re}) — never publish secrets`);
  if (/\.js$/i.test(rel)) {
    const r = cp.spawnSync(process.execPath, ["--check", fp], { encoding: "utf8" });
    if (r.status !== 0) die(`${rel} has a syntax error:\n${r.stderr}`);
  }
  if (/\.json$/i.test(rel)) { try { JSON.parse(text); } catch (e) { die(`${rel} is not valid JSON: ${e.message}`); } }
  if (/\.bat$/i.test(rel) && /(^|[^\r])\n/.test(text)) console.warn(`warning: ${rel} has LF-only line endings (cmd.exe wants CRLF)`);
  const hash = sha256(buf);
  return { path: rel, url: `${BASE}/${src}?v=${hash.slice(0, 12)}`, sha256: hash, size: buf.length };
}

function build(current) {
  const paths = [];
  const add = p => { if (!paths.includes(p)) paths.push(p); };
  for (const f of (current.files || [])) if (f && f.path && !LAST.includes(f.path)) add(f.path);
  for (const p of KIOSK_FILES) add(p);
  for (const p of paths) if (!relOk(p)) die(`${p}: this path can never be shipped to the kiosk (secrets/state/binary/odd name)`);

  // the hook verifies these before switching over; the shim must be the shim
  const shim = fs.readFileSync(path.join(ROOT, "clover-menu-server.js"), "utf8");
  if (!shim.includes("TB-KIOSK-SHIM")) die("clover-menu-server.js is not the launcher shim (TB-KIOSK-SHIM marker missing)");
  const st = cp.spawnSync(process.execPath, [path.join(ROOT, "kiosk-supervisor.js"), "--tb-selftest"], { encoding: "utf8" });
  if (st.status !== 0 || !st.stdout.includes("TB-SUPERVISOR-SELFTEST-OK")) die("kiosk-supervisor.js self-test failed");
  const mod = fs.readFileSync(path.join(ROOT, "moderation.js"), "utf8");
  if (!/module\.exports\s*=\s*\{\s*sanitizeDrinkText\s*\}/.test(mod)) die("moderation.js must keep `module.exports = { sanitizeDrinkText }`");

  const files = paths.map(fileInfo);
  const boot = { schema: 1, note: "Checked by moderation.js before the one-time switch-over from the pre-v24 server. Generated by tools/publish-manifest.js.", files: {} };
  for (const p of BOOTSTRAP_FILES) boot.files[p] = files.find(f => f.path === p).sha256;
  return { files, boot };
}

async function verifyRemote(manifest) {
  let bad = 0;
  for (const f of manifest.files) {
    try {
      const r = await fetch(f.url);
      const b = Buffer.from(await r.arrayBuffer());
      const ok = r.ok && sha256(b) === f.sha256;
      if (!ok) bad++;
      console.log(`${ok ? "ok  " : "BAD "} ${f.path}${ok ? "" : ` (http ${r.status}, ${b.length} bytes)`}`);
    } catch (e) { bad++; console.log(`BAD  ${f.path} (${e.message})`); }
  }
  if (bad) die(`${bad} file(s) do not match yet — wait a few minutes (GitHub caches) and retry, or check the push`);
  console.log("all published files match the manifest");
}

(async () => {
  let current = { version: 0, files: [] };
  try { current = JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch (e) { if (fs.existsSync(MANIFEST)) die("update-manifest.json is not valid JSON"); }
  if (flag("--verify-remote")) return verifyRemote(current);

  // tb-bootstrap.json is listed too, so write it first, then hash everything
  const first = build(current);
  const bootText = JSON.stringify(first.boot, null, 2) + "\n";
  if (flag("--check")) {
    const onDisk = fs.existsSync(BOOTSTRAP) ? fs.readFileSync(BOOTSTRAP, "utf8") : "";
    if (onDisk !== bootText) die("tb-bootstrap.json is stale — run node tools/publish-manifest.js");
  } else fs.writeFileSync(BOOTSTRAP, bootText);
  const tail = LAST.map(fileInfo);
  const files = first.files.concat(tail);

  const cur = parseInt(current.version, 10) || 0;
  const version = opt("--version") ? parseInt(opt("--version"), 10) : (flag("--no-bump") || flag("--check") ? cur : cur + 1);
  if (!Number.isInteger(version) || version < 1) die("bad --version");
  if (!flag("--check") && !flag("--no-bump") && version <= cur && opt("--version")) die(`--version must be higher than the current ${cur}`);
  const out = { version, files };

  if (flag("--check")) {
    const same = JSON.stringify(out) === JSON.stringify({ version: cur, files: current.files });
    if (!same) die("update-manifest.json does not match the files — run node tools/publish-manifest.js");
    console.log(`manifest v${cur} matches all ${files.length} files`);
    return;
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(out, null, 2) + "\n");
  const code = files.filter(f => !f.path.includes("/") && /\.js$/.test(f.path) && !["make-station-server.js", "clover-menu-server.next.js"].includes(f.path));
  console.log(`update-manifest.json -> v${version} (${files.length} files, ${code.length} server-code files). Commit + push; then:`);
  console.log("  node tools/publish-manifest.js --verify-remote");
})();
