#!/usr/bin/env node
/* tools/pay-resolve.js: the owner's release for a card attempt the kiosk could not prove (CR-013).

   When the reader cannot say whether a card was charged (an attempt stuck as TIMEOUT_UNKNOWN or DISCONNECTED_UNKNOWN), the kiosk keeps the
   order locked (TBK:CHECK) and refuses every other card attempt on the single reader. Normally the reader answers by itself after it comes back.
   If it never does, look the payment up in the Clover Dashboard (Transactions, search the order total and time), decide, and record your decision:

     node tools/pay-resolve.js --list                         unresolved attempts and unacknowledged doubles
     node tools/pay-resolve.js <externalId> charged [payId]   the customer WAS charged: the order becomes PAID
     node tools/pay-resolve.js <externalId> not-charged       the customer was NOT charged (or you voided it): the order goes to COLLECT (pay at the window)
     node tools/pay-resolve.js <externalId> ack-double        you voided the second payment of a DOUBLE: clears the heartbeat alert

   <externalId> looks like TBKORD000000001-1 (it is in the kiosk log and in .tb/pay-journal.jsonl). Run it with the kiosk server STOPPED
   (Stop-Kiosk.bat), then start the kiosk again: the server reads the journal when it starts. The tool enforces this: it refuses (exit 3, "stop the kiosk
   first") while .tb/pay-journal.lock names a running process, or while something answers like the kiosk on its port. A lock left behind by a killed
   server is "stale": the tool then also refuses, unless you add --force (it never overrides a live lock). The decision is written to the journal as a
   source:"local" event; nothing is sent to Clover from here. "charged" is the owner vouching for the payment, so the PAID tag is written
   without asking the reader again. See PAY-RUNBOOK.txt.

   Options: --dir <path to the .tb folder> (default: ../.tb next to this tool), --port <kiosk port> (default: PORT from the environment, else 8137),
   --force (continue past a STALE lock), --allow-resolved (resolve an attempt that is not unresolved). Exit codes: 0 done, 1 refused, 2 usage, 3 kiosk running. */
"use strict";
const path = require("path");
const http = require("http");
const J = require("../pay-journal");

/** Does something on 127.0.0.1:<port> answer like the kiosk server (its /health carries X-TB-Pid)? Resolves true or false. */
function probeKiosk(port) {
  return new Promise(resolve => {
    const r = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 700, headers: { Host: `127.0.0.1:${port}` } }, res => { res.resume(); resolve(!!res.headers["x-tb-pid"]); });
    r.on("timeout", () => { r.destroy(); resolve(false); }); r.on("error", () => resolve(false));
  });
}

async function run(argv, out = console.log) {
  const args = argv.filter(a => !a.startsWith("--") || a === "--list");
  const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = path.resolve(opt("--dir") || path.join(__dirname, "..", ".tb"));
  const force = argv.includes("--force"), allowResolved = argv.includes("--allow-resolved");
  const dirArg = opt("--dir"), portArg = opt("--port");
  const clean = args.filter(a => a !== dirArg && a !== portArg);

  // NEW-1: never write the journal under a running server (its next reconcile would overwrite the decision)
  const lock = J.lockStatus(dir), listing = argv.includes("--list");        // --list only reads, so it may run beside a live kiosk
  if (!listing && lock.state === "live") { out(`stop the kiosk first: process ${lock.pid} holds the pay journal (${J.LOCK_NAME}). Run Stop-Kiosk.bat, then run this again.`); return 3; }
  const ports = [...new Set([portArg, process.env.PORT, "8137"].filter(Boolean).map(Number).filter(n => n > 0 && n < 65536))];
  if (!listing) for (const port of ports) if (await probeKiosk(port)) { out(`stop the kiosk first: a kiosk server answers on port ${port}. Run Stop-Kiosk.bat, then run this again.`); return 3; }
  if (!listing && lock.state === "stale") {
    if (!force) { out(`the journal lock is stale (process ${lock.pid} is not running: the kiosk was killed). If the kiosk is really stopped, run again with --force.`); return 3; }
    out(`stale lock from process ${lock.pid} ignored (--force)`);
    try { require("fs").unlinkSync(path.join(dir, J.LOCK_NAME)); } catch {}
  } else if (force && !listing) out("--force is only for a stale lock; there is none");
  const j = J.createJournal({ dir }); j.load();

  if (argv.includes("--list")) {
    const act = j.active(), dbl = j.doubles();
    if (!act.length && !dbl.length) out("nothing to resolve");
    for (const e of act) out(`UNRESOLVED ${e.externalId}  ${e.state}  ${(e.amountCents / 100).toFixed(2)}  order ${e.kioskOrderId}`);
    for (const e of dbl) out(`DOUBLE ${e.externalId}  ${(e.amountCents / 100).toFixed(2)}  order ${e.kioskOrderId}  (void one in the Dashboard, then: ack-double)`);
    return 0;
  }
  const [extId, verb, payId] = clean;
  const e = extId && j.get(extId);
  if (!e || !["charged", "not-charged", "ack-double"].includes(verb)) { out("usage: node tools/pay-resolve.js --list | <externalId> charged [paymentId] | not-charged | ack-double"); return 2; }
  const order = j.order(e.kioskOrderId);
  if (verb === "ack-double") {
    if (e.state !== "DOUBLE" && !allowResolved) { out(`${extId} is ${e.state}, not DOUBLE`); return 1; }
    j.append({ externalId: extId, kioskOrderId: e.kioskOrderId, ackedAt: j.tick() });
    out(`${extId}: double acknowledged`); return 0;
  }
  if (!J.isActive(e.state) && !allowResolved) { out(`${extId} is ${e.state}: nothing to resolve (use --allow-resolved only if you know why)`); return 1; }
  if (verb === "charged") {
    if (payId !== undefined && !/^[A-Za-z0-9]{6,32}$/.test(payId)) { out("the payment id must be 6 to 32 letters or digits"); return 2; }
    const other = order.attempts.some(a => a !== e && J.isCharged(a.state)) || order.collectAt;
    j.append({ externalId: extId, kioskOrderId: e.kioskOrderId, state: other ? "DOUBLE" : "APPROVED", paymentResult: "SUCCESS", ...(payId ? { paymentId: payId } : {}), source: "local" });
    out(`${extId}: recorded as ${other ? "DOUBLE (another charge or a window order exists: void one, then ack-double)" : "charged: the order will be tagged PAID when the kiosk starts"}`);
    return 0;
  }
  j.append({ externalId: extId, kioskOrderId: e.kioskOrderId, state: "CANCELLED", source: "local" });
  const o2 = j.order(e.kioskOrderId);
  if (!o2.attempts.some(a => J.isCharged(a.state)) && !o2.collectAt) j.markCollect(e.kioskOrderId, "local");
  out(`${extId}: recorded as not charged: the order will be released to COLLECT (pay at the window) when the kiosk starts`);
  return 0;
}

if (require.main === module) run(process.argv.slice(2)).then(c => process.exit(c));
module.exports = { run };
