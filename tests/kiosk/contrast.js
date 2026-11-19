// tests/kiosk/contrast.js — WCAG contrast for the colors the kiosk's final CSS layer really uses (computed, not eyeballed).
// The review that asked for #163a5f text and a pink price was written against the old light sand theme; main ships the dark neon theme,
// where dark ink on the bright gradient and a gold price are what reach 4.5:1. This pins those pairs so a palette change cannot slip under.
// Run: node tests/kiosk/contrast.js
"use strict";
const assert = require("assert");
const lum = hex => { const c = hex.replace("#", "").match(/../g).map(h => parseInt(h, 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (fg, bg, a) => "#" + [0, 2, 4].map(i => Math.round(parseInt(fg.slice(1 + i, 3 + i), 16) * a + parseInt(bg.slice(1 + i, 3 + i), 16) * (1 - a)).toString(16).padStart(2, "0")).join("");
const PAIRS = [
  ["primary button text on the gradient (orange end)", "#08011c", "#FFB13D", 4.5],
  ["primary button text on the gradient (middle)", "#08011c", "#FF8A3D", 4.5],
  ["primary button text on the gradient (pink end)", "#08011c", "#FF3CAC", 4.5],
  ["Required pill: white on solid #C2185B", "#ffffff", "#C2185B", 4.5],
  ["disabled Add button: dark text on neutral fill", "#08011c", "#CBBEE6", 7],
  ["price (gold) on the card panel", "#FFD166", "#150b31", 7],
  ["price (gold) on the sheet", "#FFD166", "#0d0526", 7],
  ["pay screen amount: #163a5f on white", "#163a5f", "#ffffff", 7],
  ["pay screen label on the dark page", "#FFF4FA", "#08011c", 7],
  ["Caffeine-free badge: white on green", "#ffffff", "#0a5c3a", 4.5],
  ["price chip on the brightest card art (white on 84% navy over white)", "#ffffff", mix("#08011c", "#ffffff", 0.84), 4.5],
  ["station: ink on the PAID badge", "#08011c", "#3be08a", 7],
  ["station: ink on the COLLECT badge", "#08011c", "#ffd166", 7],
  ["station: ink on a SUB chip", "#08011c", "#ffd166", 7],
  ["station: ink on a NO chip", "#08011c", "#ff6b6b", 4.5],
  ["station: white on the lavender chip", "#ffffff", "#4a3480", 4.5],
  ["station: ink on the ARCADE WIN badge", "#08011c", "#7cf2ff", 7],
  ["station: ink on the ARCADE WIN badge while the redeem retries", "#08011c", "#ffd166", 7],
  ["station: cyan on the redeemed ARCADE WIN badge", "#7cf2ff", "#2a1a55", 7],
  ["order screen: ink on the arcade win banner", "#08011c", "#FFD166", 7],
  ["order screen: gold code on its ink chip", "#FFD166", "#08011c", 7],
  ["arcade page: ink on the Order now button (orange end)", "#08011c", "#FF8A3D", 7],
];
for (const [name, fg, bg, min] of PAIRS) { const r = ratio(fg, bg); assert.ok(r >= min, `${name}: ${r.toFixed(2)}:1 < ${min}:1`); }
// documented, deliberately NOT adopted: the literal asks from the review would FAIL on the dark theme
const lit = [["pink price #C2185B on the dark card", "#C2185B", "#150b31"], ["#163a5f text directly on the dark page", "#163a5f", "#08011c"]];
for (const [name, fg, bg] of lit) assert.ok(ratio(fg, bg) < 4.5, name + " would be " + ratio(fg, bg).toFixed(2) + ":1");
console.log("contrast: " + PAIRS.length + " pairs pass; the two literal review colors fail on the dark theme (" + lit.map(([n, f, b]) => ratio(f, b).toFixed(2)).join(" and ") + ":1)");
