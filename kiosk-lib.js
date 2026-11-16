/* kiosk-lib.js — Thirsty Beaches kiosk: small pure helpers used by kiosk-server.js
 * (update path checks, sha256, remote settings / commands validation, error scrubbing).
 * No side effects at require time. Node built-ins only.
 */
"use strict";

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");
function sha256File(fp) { try { return sha256(fs.readFileSync(fp)); } catch { return null; } }

/* ---------------- update paths ----------------
   A manifest path is a kiosk-relative path with forward slashes. Anything odd is refused:
   no "..", no absolute paths, no backslashes or drive letters, no ":" (NTFS streams), no
   "~" (8.3 short names), no dot-files/dot-dirs (.tb state, .git), no segment ending in "."
   (Windows silently strips it: "kiosk-config.env." would land on kiosk-config.env), no
   reserved device names (CON, NUL, COM1 ...). */
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\..*)?$/i;
function checkRelPath(rel) {
  if (typeof rel !== "string" || !rel || rel.length > 200) return null;
  if (!/^[A-Za-z0-9._\-\/]+$/.test(rel)) return null;
  const segs = rel.split("/");
  for (const s of segs) {
    if (!s || s === "." || s === ".." || s.startsWith(".") || s.endsWith(".")) return null;
    if (WIN_RESERVED.test(s)) return null;
  }
  return segs.join("/");
}

/* Never written by an update, whatever the manifest says: secrets, local state, the
   Node runtime and native binaries. */
const NEVER_BASENAMES = new Set(["update-state.json", "flex-pairing.json"]);
const NEVER_EXT = new Set([".env", ".exe", ".dll", ".node", ".sys", ".msi", ".scr", ".com"]);
function blockedReason(rel) {
  const lower = rel.toLowerCase();
  const base = path.posix.basename(lower);
  if (base.endsWith(".env") || base.includes(".env.")) return "secrets file";
  if (NEVER_BASENAMES.has(base)) return "local state file";
  if (NEVER_EXT.has(path.posix.extname(base))) return "binary";
  if (lower.split("/")[0] === "node_modules") return "node_modules";
  return null;
}

function safeUpdatePath(root, rel) {
  const r = checkRelPath(rel);
  if (!r || blockedReason(r)) return null;
  const fp = path.resolve(root, ...r.split("/"));
  const a = process.platform === "win32" ? fp.toLowerCase() : fp;
  const b = process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
  if (!a.startsWith(b + path.sep)) return null;
  return fp;
}

/* Files the running server has loaded into memory: a change to any of them is applied by the
   supervisor during an idle restart (with health check + automatic rollback). Everything else
   (pages, images, recipes, launchers, docs) is swapped in place like before. */
const CONTENT_JS = new Set(["make-station-server.js", "clover-menu-server.next.js"]);
function isRestartFile(rel) {
  const lower = String(rel).toLowerCase();
  if (lower.includes("/")) return false;
  if (lower === "addons.json") return true;
  return lower.endsWith(".js") && !CONTENT_JS.has(lower);
}

/* ---------------- remote settings (kiosk-control.json "settings") ----------------
   Allow-list only. Each value is validated; a bad value is rejected on its own and the
   rest still apply. A key that is absent means "use kiosk-config.env". */
const asBool = v => (v === true || v === false) ? v : (v === "true" ? true : v === "false" ? false : undefined);
function asInt(v, lo, hi) {
  const n = typeof v === "number" ? v : (typeof v === "string" && /^\d{1,9}$/.test(v.trim()) ? parseInt(v, 10) : NaN);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
}
const MODEL_RE = /^claude-[a-z0-9][a-z0-9.\-]{0,60}$/;
const IPV4_RE  = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const SETTINGS_SPEC = {
  /* PAY_ENABLED, FLEX_IP, FLEX_PORT and PAY_TIMEOUT_MS are NOT here on purpose (security review S1, 2026-11-15): the Control file
     lives in a public repo, so it must never be able to turn tap-to-pay ON or point the kiosk at another card reader. They come from
     kiosk-config.env only. The Control file can only switch pay OFF: see payKillFrom() below. */
  UPDATE_INTERVAL_MIN: { live: true,  parse: v => asInt(v, 5, 1440) },
  HIDE_CATEGORIES:     { live: true,  parse: v => {
    const arr = Array.isArray(v) ? v : (typeof v === "string" ? v.split(",") : null);
    if (!arr || arr.length > 50) return undefined;
    const out = [];
    for (const s of arr) {
      if (typeof s !== "string") return undefined;
      const t = s.trim();
      if (t.length > 60 || /[\u0000-\u001f]/.test(t)) return undefined;
      if (t) out.push(t);
    }
    return out;
  } },
  AI_DESIGN_ENABLED:   { live: true,  parse: asBool },
  VIBE_MODEL:          { live: true,  parse: v => (typeof v === "string" && MODEL_RE.test(v.trim())) ? v.trim() : undefined },
  DRINK_MODEL:         { live: true,  parse: v => (typeof v === "string" && MODEL_RE.test(v.trim())) ? v.trim() : undefined },
};
/* Remote kill switch for tap-to-pay. The Control file may say payEnabled:false (the owner's "stop taking cards" button) and nothing else:
   - the literal boolean false  -> kill
   - anything else (true, "true", 1, missing, junk) -> not a kill, and NEVER an enable (env PAY_ENABLED still has to be true)
   Returns true / false for a usable answer, or null when there is no control data to read (fetch failed), meaning "keep the last state". */
function payKillFrom(control) {
  if (!control || typeof control !== "object" || Array.isArray(control)) return null;
  return control.payEnabled === false;
}
/* ---------------- what the PAGE may see of the Control file ----------------
   The Control file lives in a public repo. The page used to get it raw (healthcheck URL, settings, commands included) and
   interpolated specials ids into onclick strings (stored XSS, security review S2). Now the server hands the page only these
   fields, each validated; anything that does not fit is dropped (one bad special never takes the others down). */
const SPECIAL_ID_RE   = /^[a-z0-9-]{1,32}$/;
const SPECIAL_TEXT_RE = /^[\p{L}\p{N} .,'’!?&+:;()\/-]*$/u;      // no < > " ` \ { } or control characters
const SPECIAL_ITEM_RE = /^[a-z0-9-]{1,40}$/;
const SPECIAL_CAT_RE  = /^[a-z]{2,20}$/;
const SPECIAL_MOD_RE  = /^[a-z]{2,20}:[\p{L}\p{N} .,'’&+()\/-]{1,60}$/u;
function cleanSpecial(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const text = (v, max, min = 0) => (typeof v === "string" && v.length >= min && v.length <= max && SPECIAL_TEXT_RE.test(v)) ? v : null;
  const id = typeof s.id === "string" && SPECIAL_ID_RE.test(s.id) ? s.id : null;
  const name = text(s.name, 40, 1), blurb = text(s.blurb == null ? "" : s.blurb, 160), label = text(s.label == null ? "" : s.label, 30);
  const catKey = typeof s.catKey === "string" && SPECIAL_CAT_RE.test(s.catKey) ? s.catKey : null;
  if (!id || name == null || blurb == null || label == null || !catKey) return null;
  const mods = [];
  for (const m of (Array.isArray(s.mods) ? s.mods.slice(0, 25) : [])) { if (typeof m !== "string" || !SPECIAL_MOD_RE.test(m)) return null; mods.push(m); }
  const base = s.base == null || s.base === "" ? "" : (typeof s.base === "string" && SPECIAL_MOD_RE.test(s.base) ? s.base : null);
  const baseItemId = s.baseItemId == null || s.baseItemId === "" ? "" : (typeof s.baseItemId === "string" && SPECIAL_ITEM_RE.test(s.baseItemId) ? s.baseItemId : null);
  if (base === null || baseItemId === null) return null;
  const updated = typeof s.updated === "string" && /^[0-9TZ:.+-]{0,40}$/.test(s.updated) ? s.updated : "";
  return { id, name, blurb, label, catKey, base, baseItemId, mods, updated };
}
const strList = (a, n) => Array.isArray(a) ? a.filter(x => typeof x === "string" && x.length <= 120 && !/[\u0000-\u001f]/.test(x)).slice(0, n) : [];
const num = (v, lo, hi) => (typeof v === "number" && isFinite(v) && v >= lo && v <= hi) ? v : undefined;
const CONTROL_STALE_MS = 15 * 60000;
function controlPublic(c, ageMs) {
  const src = (c && typeof c === "object" && !Array.isArray(c)) ? c : {};
  const out = { soldOut: strList(src.soldOut, 500), soldOutOptions: strList(src.soldOutOptions, 500),
    specials: (Array.isArray(src.specials) ? src.specials.slice(0, 20) : []).map(cleanSpecial).filter(Boolean),
    updated: typeof src.updated === "string" ? src.updated.slice(0, 40) : "" };
  // greeter: the camera is ON only for the literal boolean true (compliance gate 2026-11-15); the rest are tuning numbers
  const g = src.greeter && typeof src.greeter === "object" && !Array.isArray(src.greeter) ? src.greeter : null;
  // a Control copy older than 15 minutes (GitHub unreachable) switches the camera OFF: "cannot read Control" never means "keep going"
  const stale = typeof ageMs === "number" && ageMs > CONTROL_STALE_MS;
  out.greeter = { enabled: !stale && !!(g && g.enabled === true) };
  if (g) {
    for (const [k, lo, hi] of [["volume", 0, 1], ["motionThreshold", 0, 1], ["approachFaceSize", 0, 1], ["closeSize", 0, 1]]) { const v = num(g[k], lo, hi); if (v !== undefined) out.greeter[k] = v; }
    if (typeof g.debug === "boolean") out.greeter.debug = g.debug;
    if (Array.isArray(g.quietHours) && g.quietHours.length === 2 && g.quietHours.every(h => Number.isInteger(h) && h >= 0 && h <= 24)) out.greeter.quietHours = g.quietHours;
  }
  return out;
}
/* The health-check URL may come from the Control file only if it is a plain https://hc-ping.com/ address (security review S4:
   an arbitrary URL there made the kiosk fetch whatever a stranger typed into a public repo, inside the trailer LAN). */
function safeHealthUrl(u) {
  if (typeof u !== "string" || u.length > 200) return "";
  let url; try { url = new URL(u); } catch { return ""; }
  return (url.protocol === "https:" && url.hostname === "hc-ping.com" && !url.username && !url.password && !url.port) ? url.href : "";
}
/* Request guard for the kiosk's local HTTP server (security review S7): DNS-rebinding and cross-site POSTs.
   Host must be the loopback name with our port; every non-GET needs a same-origin Origin (missing = refused) and JSON. */
function requestProblem(req, port) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  if (String(port) === "80") { hosts.add("localhost"); hosts.add("127.0.0.1"); }
  const h = req.headers || {};
  if (!hosts.has(String(h.host || "").toLowerCase())) return "bad host";
  const sfs = h["sec-fetch-site"];
  if (sfs !== undefined && sfs !== "same-origin" && sfs !== "none") return "cross-site request";
  const m = String(req.method || "GET").toUpperCase();
  if (m !== "GET" && m !== "HEAD") {
    const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
    if (!origins.has(String(h.origin || "").toLowerCase())) return "bad origin";
    if (!/^application\/json\b/i.test(String(h["content-type"] || ""))) return "json only";
  }
  return null;
}
/* CSP for the kiosk page: no card-entry UI may ever exist here, nothing may post anywhere else, nothing may frame it.
   The page uses inline scripts and onclick handlers (hence 'unsafe-inline'); the hosts are the ones it really loads. */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "connect-src 'self' https://station.thirstybeaches.com https://tb-where.nicholasroper.workers.dev https://thirstybeaches.com https://cdn.jsdelivr.net https://storage.googleapis.com",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");

function validateSettings(raw) {
  const settings = {}, errors = [];
  if (raw == null) return { settings, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) return { settings, errors: ["settings must be an object"] };
  const keys = Object.keys(raw);
  if (keys.length > 30) return { settings, errors: ["settings has too many keys"] };
  for (const k of keys) {
    const spec = Object.prototype.hasOwnProperty.call(SETTINGS_SPEC, k) ? SETTINGS_SPEC[k] : null;
    if (!spec) { errors.push(`setting ${String(k).slice(0, 40)} is not allowed`); continue; }
    if (raw[k] === null) continue;                           // null = use kiosk-config.env
    const v = spec.parse(raw[k]);
    if (v === undefined) { errors.push(`setting ${k} has an invalid value`); continue; }
    settings[k] = v;
  }
  return { settings, errors };
}
function settingsHash(settings) {
  const keys = Object.keys(settings || {}).sort();
  return sha256(JSON.stringify(keys.map(k => [k, settings[k]]))).slice(0, 16);
}

/* ---------------- remote commands (kiosk-control.json "commands") ----------------
   { restartAt, reloadScreenAt, checkUpdateAt }: ISO times. Each runs once, when the time has
   come and it is newer than the last one this kiosk ran. Times more than 7 days ahead are
   refused (typo guard). */
const COMMANDS = ["restartAt", "reloadScreenAt", "checkUpdateAt"];
function parseCommandTime(v, now) {
  if (v == null || v === "") return { t: null };
  if (typeof v !== "string" || v.length > 40) return { error: "not an ISO time string" };
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return { error: "not an ISO time string" };
  if (t > now + 7 * 864e5) return { error: "more than 7 days in the future" };
  return { t };
}
/* Which commands are due. state = { restartAt: <ms last run>, ... } (mutated by caller). */
function dueCommands(raw, state, now) {
  const due = [], errors = [];
  if (raw == null) return { due, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) return { due, errors: ["commands must be an object"] };
  for (const k of Object.keys(raw)) if (!COMMANDS.includes(k)) errors.push(`command ${String(k).slice(0, 40)} is not allowed`);
  for (const k of COMMANDS) {
    const p = parseCommandTime(raw[k], now);
    if (p.error) { errors.push(`command ${k}: ${p.error}`); continue; }
    if (p.t == null || p.t > now) continue;                  // not set, or not time yet
    if (state[k] != null && p.t <= state[k]) continue;        // already ran this one (or a newer one)
    due.push({ name: k, t: p.t });
  }
  return { due, errors };
}

/* ---------------- error scrubbing for the heartbeat ----------------
   Heartbeat errors must never carry secrets or customer data: strip URLs down to host+path,
   ids/tokens/emails/long numbers are masked, and the result is short. */
function scrub(msg) {
  let s = String(msg == null ? "" : msg);
  s = s.replace(/\bhttps?:\/\/([^\s/?#]+)([^\s?#]*)[^\s]*/gi, (m, host, p) => host + p.replace(/\/[^/\s]{20,}/g, "/…"));
  s = s.replace(/hc-ping\.com\/\S+/gi, "hc-ping.com/…");
  s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>");
  s = s.replace(/\b(bearer|token|key|secret|authorization)\b[\s:=]+\S+/gi, "$1 <hidden>");
  s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "<key>");
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>");
  s = s.replace(/\b[A-Za-z0-9_-]{24,}\b/g, "<id>");
  s = s.replace(/\d{6,}/g, "<n>");
  s = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s.slice(0, 160);
}
/* Clover REST path with ids masked: /orders/ABC123/line_items -> /orders/:id/line_items */
function maskCloverPath(p) {
  return String(p || "").split("?")[0].replace(/\/[A-Z0-9]{8,}(?=\/|$)/g, "/:id").slice(0, 80);
}
class ErrorRing {
  constructor(max) { this.max = max || 10; this.items = []; }
  push(msg) {
    const m = scrub(msg);
    if (!m) return;
    const last = this.items[this.items.length - 1];
    if (last && last.msg === m) { last.n += 1; last.at = new Date().toISOString(); return; }
    this.items.push({ at: new Date().toISOString(), msg: m, n: 1 });
    if (this.items.length > this.max) this.items.shift();
  }
  list() { return this.items.map(e => (e.n > 1 ? `${e.msg} (x${e.n})` : e.msg) + " @" + e.at.slice(5, 16)); }
}

/* ---------------- small fs helpers ---------------- */
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} }
/* Windows can refuse a rename for a moment while antivirus or a reader has the file open. */
function renameRetry(from, to) {
  let last;
  for (let i = 0; i < 12; i++) {
    try { fs.renameSync(from, to); return; } catch (e) { last = e; if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e; sleepSync(100 + i * 100); }
  }
  throw last;
}
function writeJsonAtomic(fp, obj) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  renameRetry(tmp, fp);
}
function readJson(fp, fallback) {
  for (let i = 0; i < 3; i++) {
    try { return JSON.parse(fs.readFileSync(fp, "utf8")); }
    catch (e) { if (e.code === "ENOENT" || e instanceof SyntaxError) return fallback; sleepSync(50); }
  }
  return fallback;
}

module.exports = {
  sha256, sha256File, checkRelPath, blockedReason, safeUpdatePath, isRestartFile,
  SETTINGS_SPEC, payKillFrom, controlPublic, CONTROL_STALE_MS, cleanSpecial, safeHealthUrl, requestProblem, CSP, validateSettings, settingsHash, COMMANDS, parseCommandTime, dueCommands,
  scrub, maskCloverPath, ErrorRing, renameRetry, writeJsonAtomic, readJson, sleepSync,
};
