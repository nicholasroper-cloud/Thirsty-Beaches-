// tests/kiosk/consent.js — the Tide List's exact SMS consent line is a file, and the page sends its hash with every sign-up.
// Compliance gate 2026-11-15 section 3: the consent record must say WHICH text the person agreed to. The text is in
// consent/sms-consent-kiosk-v1.txt; consentVersion = sha256 of those exact bytes. Changing a word means a NEW file (v2) and a new version.
// Run: node tests/kiosk/consent.js
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const assert = require("assert");
const ROOT = path.resolve(__dirname, "../..");
const TEXT = "Yes, Thirsty Beaches may send automated marketing texts to this number about stops and specials. Not required to buy anything. A few msgs/month; msg & data rates may apply. Reply STOP to cancel, HELP for help. I'm 13+ and this is my number. Terms: thirstybeaches.com/sms-terms";
const PINNED = "d9b90e126c66e0ec5ced45c01f86cb0a91fc018b735af78df03116b146e99c8c";   // sha256 of TEXT; if you meant to change the wording, add consent/sms-consent-kiosk-v2.txt instead

const file = fs.readFileSync(path.join(ROOT, "consent/sms-consent-kiosk-v1.txt"));
assert.strictEqual(file.toString("utf8"), TEXT, "the v1 file holds exactly the compliance-gate consent line (no edits, no trailing newline)");
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
assert.strictEqual(sha(file), PINNED, "v1 file hash is pinned");
assert.strictEqual(sha(Buffer.from(TEXT, "utf8")), PINNED);
for (const f of ["drink-kiosk.html", "drink-kiosk-light.html"]) {
  const html = fs.readFileSync(path.join(ROOT, f), "utf8");
  const t = html.match(/const TL_CONSENT_TEXT = "((?:[^"\\]|\\.)*)";/);
  const v = html.match(/const TL_CONSENT_VERSION = "([0-9a-f]{64})";/);
  assert.ok(t && v, f + ": consent constants present");
  assert.strictEqual(JSON.parse('"' + t[1] + '"'), TEXT, f + ": the page shows exactly the filed text");
  assert.strictEqual(v[1], PINNED, f + ": the page's consentVersion is the hash of the filed text");
  assert.ok(/source:"kiosk", consentVersion:TL_CONSENT_VERSION/.test(html), f + ": the POST carries source and consentVersion");
  assert.ok(/<span id="tlConsentText"><\/span>/.test(html), f + ": the checkbox label is filled from the constant");
  assert.ok(!/Text me the day's spot/.test(html) && !/Every 5th/.test(html), f + ": the old consent copy is gone");
  assert.ok(/<div class="tidelist" id="tidelist" hidden>/.test(html), f + ": still hidden");
}
console.log("consent: v1 text, hash " + PINNED.slice(0, 12) + "... pinned and sent with source=kiosk");
