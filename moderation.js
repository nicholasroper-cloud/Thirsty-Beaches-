/* moderation.js — Thirsty Beaches kiosk, server-side only.
 *
 * OWNERSHIP: the rule body is Lady Jaye's compliance policy.
 * Hi-Tech defines the signature and call sites. Do NOT move
 * moderation logic elsewhere; this is the single chokepoint.
 *
 * Contract:
 *   input  : a short AI-generated string (drink name or blurb)
 *   output : a safe string to display. May be the input
 *            unchanged, a cleaned version, or '' to signal
 *            "reject — caller should use the curated fallback."
 *
 * This function MUST be synchronous (called in the request path).
 * If a future policy needs an async classifier, change the
 * signature to async and await it at both call sites in
 * clover-menu-server.js; nothing else changes.
 *
 * GUARDRAILS (Lady Jaye verdict 2026-06-19 — MANDATORY before public):
 *   1. Denylist covers: profanity, sexual/adult terms, violence,
 *      slurs, brand/trademark names, health/allergen/wellness
 *      claims (FDA/FTC risk: no gut-health, immunity, sugar-free,
 *      keto, protein, gluten-free language in the AI copy).
 *   2. Haiku appropriateness check strongly recommended — catches
 *      innuendo a regex denylist misses. Lady Jaye to implement as
 *      an async upgrade once the seam is proven in preview.
 *   3. Default here is a passthrough with the denylist only.
 *      This is a PLACEHOLDER, not a launch state. Do not expose
 *      to the public until Lady Jaye fills the async classifier.
 */

"use strict";

/* ---------- one-time switch-over hook (NOT moderation; kiosk plumbing) ----------
 * The pre-v24 server (clover-menu-server.js as shipped on the USB drive) cannot
 * auto-update itself, but it does require() this file at startup, BEFORE it opens
 * port 8137 or connects to the Flex. So on that old server's next start (one PC
 * restart), this block runs the new supervised server instead:
 *   - only inside that legacy server (not in kiosk-server.js, the make-station, tests)
 *   - only if every bootstrap file matches the sha256 in tb-bootstrap.json
 *     (a missing / partial / stale download simply means "not yet")
 *   - only if the switch-over has not already failed with these exact files
 * It runs clover-menu-server.next.js (the new launcher) as a child and WAITS for it
 * (spawnSync), so the old code never reaches its own server.listen(). If the new
 * server cannot become healthy the child exits non-zero and the old server simply
 * carries on below, exactly as before. Exit 0 = new stack stopped on purpose or
 * already running elsewhere -> this old process exits too.
 */
(function tbSwitchOver() {
  try {
    const fs = require("fs"), path = require("path"), crypto = require("crypto");
    if (process.env.TB_SUPERVISED || process.env.TB_LEGACY_HOST || process.env.TB_NO_SWITCHOVER === "1") return;
    const main = require.main && require.main.filename;
    if (!main || path.basename(main).toLowerCase() !== "clover-menu-server.js" || path.dirname(main) !== __dirname) return;
    if (fs.readFileSync(main, "utf8").includes("TB-KIOSK-SHIM")) return;           // already the new launcher
    const boot = JSON.parse(fs.readFileSync(path.join(__dirname, "tb-bootstrap.json"), "utf8"));
    const files = boot && boot.files;
    if (!files || typeof files !== "object" || !files["clover-menu-server.next.js"]) return;
    const sha = fp => crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex");
    for (const rel of Object.keys(files)) {
      if (!/^[A-Za-z0-9._-]+$/.test(rel)) return;
      let got = null;
      try { got = sha(path.join(__dirname, rel)); } catch {}
      if (got !== files[rel]) { console.log(`[switch-over] not yet: ${rel} is not the published copy — staying on the current server`); return; }
    }
    const key = crypto.createHash("sha256").update(JSON.stringify(Object.keys(files).sort().map(k => [k, files[k]]))).digest("hex").slice(0, 16);
    let st = {};
    try { st = JSON.parse(fs.readFileSync(path.join(__dirname, ".tb", "supervisor-state.json"), "utf8")) || {}; } catch {}
    if (st.bootstrapFailed && st.bootstrapFailed.key === key) {
      console.log(`[switch-over] skipped: it failed before with these files (${st.bootstrapFailed.reason}) — staying on the current server`);
      return;
    }
    console.log("[switch-over] starting the new supervised kiosk server...");
    const r = require("child_process").spawnSync(process.execPath,
      [...process.execArgv, path.join(__dirname, "clover-menu-server.next.js")],
      { stdio: "inherit", cwd: process.cwd(), env: { ...process.env, TB_LEGACY_HOST: "1" }, windowsHide: true });
    if (r.status === 0) process.exit(0);
    console.log(`[switch-over] the new server handed back (exit ${r.status}${r.error ? ", " + r.error.message : ""}) — continuing with the current server`);
  } catch (e) {
    try { console.log("[switch-over] skipped:", e && e.message); } catch {}
  }
})();

/* ---------- denylist ----------
 * Patterns that force a fallback (return '').
 * Covers Lady Jaye's mandatory list:
 *   - profanity / slurs (abbreviated — real list is longer)
 *   - sexual / adult content
 *   - brand / trademark names (common soda brands in AI copy)
 *   - health / allergen claims (FDA/FTC)
 *   - violence / hate-adjacent language
 * Patterns are tested case-insensitively on the trimmed input.
 * Lady Jaye: extend this list; DO NOT reduce it before review.
 */
const DENY_PATTERNS = [
  // ---- profanity (abbreviated; Lady Jaye to expand) ----
  /\bf+u+c+k/i, /\bs+h+i+t/i, /\bb+i+t+c+h/i, /\ba+s+s+h+o+l+e/i,
  /\bc+u+n+t/i, /\bd+a+m+n/i, /\bh+e+l+l\b/i, /\bcr+a+p\b/i,
  // ---- sexual / adult ----
  /\bsex(y|ual)?\b/i, /\bnaked\b/i, /\bnude\b/i, /\bporn/i,
  /\berotic/i, /\bintimate\b/i, /\bhooker\b/i, /\bslut\b/i, /\bwhore\b/i,
  // ---- violence ----
  /\bkill(ing|ed)?\b/i, /\bblood(y)?\b/i, /\bdead\b/i, /\bmurder/i,
  /\bgun(s|shot)?\b/i, /\bweapon\b/i, /\bstab/i, /\bexplosion\b/i,
  // ---- slurs (sample; Lady Jaye to expand to full list) ----
  /\bn[i1]gg/i, /\bfag(got)?\b/i, /\bretard/i, /\bspic\b/i, /\bkike\b/i,
  // ---- brand / trademark names (in AI-generated copy) ----
  /\bcoca.?cola\b/i, /\bpepsi\b/i, /\bdr\.?\s*pepper\b/i, /\bsprite\b/i,
  /\bmonster\b/i, /\bred\s*bull\b/i, /\balani\b/i, /\bgatorade\b/i,
  /\bstarbucks\b/i, /\bchipotle\b/i, /\bmcdonald/i, /\bdunkin\b/i,
  // ---- health / allergen / wellness claims (FDA/FTC) ----
  /\bgluten.?free\b/i, /\bdairy.?free\b/i, /\bsugar.?free\b/i,
  /\bketo\b/i, /\bpaleo\b/i, /\bvegan\b/i, /\bimmun(ity|e)\b/i,
  /\bdetox/i, /\banti.?inflam/i, /\bcalorie.?free\b/i, /\blow.?cal\b/i,
  /\bweight\s*loss\b/i, /\bfat.?burn/i, /\benergy\s*boost\b/i,
  /\bprobiotic/i, /\bantioxidant/i, /\bsuperf[oa]od/i,
  // ---- allergen / "free from" claims ----
  /\bnut.?free\b/i, /\bpeanut.?free\b/i, /\btree.?nut.?free\b/i,
  /\bsoy.?free\b/i, /\begg.?free\b/i, /\bwheat.?free\b/i,
  /contains\s+(no|zero)\s+(allergen|nut|gluten|dairy)/i,
  // ---- emoji / non-printable (name/blurb must be plain text) ----
  // Emoji range: U+1F300-U+1FFFF and common symbols
  /[\u{1F300}-\u{1FFFF}]/u, /[\u{2600}-\u{27BF}]/u,
];

/* ---------- length limits ----------
 * Hard-clamp here as a last-resort safety net.
 * Primary clamping happens upstream in validateDrink().
 */
const NAME_MAX  = 28;
const BLURB_MAX = 120;

/**
 * sanitizeDrinkText(text)
 *
 * Returns the safe string to show, or '' to signal "reject".
 * Called for every name and blurb returned by Claude before
 * any of that text can reach the screen or printer.
 *
 * @param {string} text
 * @param {"name"|"blurb"} [field] - hint for future per-field policy
 * @returns {string}
 */
function sanitizeDrinkText(text, field) {
  if (typeof text !== "string") return "";

  // Strip leading/trailing whitespace; collapse internal runs of whitespace.
  let t = text.trim().replace(/\s+/g, " ");

  // Hard length clamp (belt-and-suspenders after validateDrink's clamp).
  if (field === "name" || (!field && t.length <= NAME_MAX)) {
    t = t.slice(0, NAME_MAX);
  } else {
    t = t.slice(0, BLURB_MAX);
  }

  // Run the denylist. Any match forces a fallback.
  for (const pat of DENY_PATTERNS) {
    if (pat.test(t)) {
      // Never log the offending text (could be inappropriate content).
      // The server logs 'moderation: rejected [name|blurb]' without the value.
      return "";
    }
  }

  return t;
}

/* ---------- TODO (Lady Jaye + Scarlett, before public launch) ----------
 *
 * 1. Expand DENY_PATTERNS to the full brand/profanity/slur list
 *    maintained by Lady Jaye in the compliance policy doc.
 *
 * 2. Add an async Haiku appropriateness check:
 *      - Change sanitizeDrinkText to async
 *      - Call POST /messages with a tiny prompt:
 *          "Is this drink name/blurb appropriate for a public kiosk
 *           children use? Output JSON { approved: true/false }."
 *      - If approved:false → return ''
 *      - Cost: ~$0.001 per order (claude-haiku-4-5); negligible.
 *    Await it at both call sites in validateDrink(). Nothing else changes.
 *
 * 3. Consider a remotely-updatable denylist fetched from
 *    kiosk-control.json (via the existing CONTROL_URL path) so the
 *    owner can update blocklist words without a USB deploy.
 *
 * 4. Scarlett review: confirm that AI-output containing a palette id
 *    in the name/blurb (e.g. "coconut-lime soda") is acceptable brand
 *    copy, or add a palette-ingredient passthrough allowlist.
 * ----------------------------------------------------------------------- */

module.exports = { sanitizeDrinkText };
