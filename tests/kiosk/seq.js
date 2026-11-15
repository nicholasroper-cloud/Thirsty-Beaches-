// tests/kiosk/seq.js — the daily order number rules live in three files (kiosk-server.js assigns the number, make-station-server.js
// and cloud/src/ticket.js show it). They must agree on every input, or the number the customer saw is not the one on the board.
// Run: node tests/kiosk/seq.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const ROOT = path.resolve(__dirname, "../..");

function grab(file) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const a = src.indexOf("const SEQ_START = 100;");
  const f = src.indexOf("function assignSeq(", a);
  const b = src.indexOf("\n}\n", f) + 3;
  assert.ok(a > 0 && f > a && b > f, file + ": order-number block moved; update tests/kiosk/seq.js");
  const ctx = vm.createContext({});
  vm.runInContext(src.slice(a, b) + "\n;this.api={assignSeq,noteSeq,dayKey,SEQ_START};", ctx);
  return ctx.api;
}
(async () => {
  const kiosk = grab("kiosk-server.js"), station = grab("make-station-server.js");
  const cloud = await import(path.join(ROOT, "cloud/src/ticket.js"));
  const t = Date.parse("2026-11-14T15:00:00");   // local noon-ish: never near midnight in any test zone
  const day = kiosk.dayKey;
  const J = x => JSON.stringify([...x].sort());
  const same = (m, arr, msg) => assert.strictEqual(J(m), JSON.stringify(arr.slice().sort()), msg);

  // fixed cases
  const plain = [1, 2, 3].map(i => ({ id: "O" + i, created: t + i * 1000, seq: null }));
  same(kiosk.assignSeq(plain), [["O1", 101], ["O2", 102], ["O3", 103]], "plain ranks");
  const noted = [{ id: "A", created: t, seq: null }, { id: "B", created: t + 1, seq: 102 }, { id: "C", created: t + 2, seq: null }];
  same(kiosk.assignSeq(noted), [["A", 101], ["B", 102], ["C", 103]], "a number the kiosk wrote is kept; unnumbered orders skip it");
  const dup = [{ id: "A", created: t, seq: 105 }, { id: "B", created: t + 1, seq: 105 }];
  const dm = new Map(kiosk.assignSeq(dup));
  assert.notStrictEqual(dm.get("A"), dm.get("B"), "two orders never share a number");
  assert.strictEqual(dm.get("A"), 105, "first claim wins");
  const days = [{ id: "Y", created: t - 86400000, seq: null }, { id: "T", created: t, seq: null }];
  same(kiosk.assignSeq(days), [["T", 101], ["Y", 101]], "each day restarts at 101");
  assert.strictEqual(kiosk.noteSeq("Sam — Kiosk order #104 · MAZE UPSIZE"), 104);
  assert.strictEqual(kiosk.noteSeq("Kiosk order #7 — Thirsty Beaches"), 7);
  assert.strictEqual(kiosk.noteSeq("Register 12"), null);

  // the three copies agree on random inputs
  let seed = 12345; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let run = 0; run < 300; run++) {
    const n = 1 + rnd(40);
    const orders = Array.from({ length: n }, (_, i) => ({ id: "O" + rnd(60), created: t + (rnd(3) - 1) * 86400000 + rnd(100000), seq: rnd(3) === 0 ? 100 + rnd(50) : null }));
    const ids = new Set(); const uniq = orders.filter(o => !ids.has(o.id) && ids.add(o.id));
    const k = JSON.stringify([...kiosk.assignSeq(uniq)].sort());
    assert.strictEqual(JSON.stringify([...station.assignSeq(uniq)].sort()), k, "station copy differs");
    assert.strictEqual(JSON.stringify([...cloud.assignSeq(uniq, day)].sort()), k, "cloud copy differs");
    const vals = [...kiosk.assignSeq(uniq)].reduce((a, [id, v]) => { const d = day(uniq.find(o => o.id === id).created); (a[d] = a[d] || []).push(v); return a; }, {});
    for (const list of Object.values(vals)) assert.strictEqual(new Set(list).size, list.length, "numbers unique within a day");
  }
  console.log("seq: kiosk, station and cloud agree (300 random days)");
})().catch(e => { console.error(e); process.exit(1); });
