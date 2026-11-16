/* =============================================================================
   catalog.js — Thirsty Beaches kiosk: the server-held Clover catalog table (ADR section 4, security review Q6).

   Purpose: the kiosk page no longer decides what a drink costs. This module copies the Clover price book
   (items with their tax rates, modifier groups with modifiers, tax rates) into .tb/catalog.json on boot and every
   15 minutes, and quote.js prices carts from it. The page gets display prices from GET /catalog only.

   Safety rules (Q6). The cross-check against Clover's own checkout cannot catch tampering (both read the same Clover data),
   so this module guards against drift and partial reads instead:
     - every list is paged until it is exhausted (a page cap that is hit is an error, not a short list)
     - every element is schema-validated; ONE bad element rejects the whole sync (nothing partial is ever written)
     - .tb/catalog.json is written temp-then-rename, only for an accepted sync
     - keep the last good copy when a mapped id is missing, or the item count drops more than 10%
     - a mapped price that moves more than 50% from last-good, or an item priced under the floor, HOLDS payment: the new copy is
       NOT promoted, payNow stays false and a heartbeat alert is raised until it goes away or the owner touches
       .tb/catalog-accept.flag (consumed by the next sync) to accept the new prices
     - the tax rates on mapped items must be in CATALOG_TAX_RATES (percent list). Empty list = payNow stays false (fail closed)
   Only keys listed in catalog-map.json (kiosk drink / size / add-on -> Clover item or modifier id) are ever priced.

   Dependencies: kiosk-lib.js (atomic JSON write). Node built-ins only. No customer data is ever read or kept.
   ============================================================================= */
"use strict";

const fs   = require("fs");
const path = require("path");
const lib  = require("./kiosk-lib");

const ID_RE = /^[A-Za-z0-9]{8,20}$/;
const PAGE_LIMIT = 500, MAX_PAGES = 20;
const RATE_PER_PERCENT = 100000;                 // Clover tax rate units: 8.25% = 825000 (ASSUMPTION: verify against the live account, real-Flex prerequisite)

/** Every mapped Clover id in catalog-map.json: { items:Set, mods:Set }. Unmapped (null) keys are ignored here. */
function mappedIds(map) {
  const items = new Set(), mods = new Set();
  for (const cat of Object.values((map && map.categories) || {})) {
    for (const it of Object.values(cat.items || {})) if (it && it.clover) items.add(it.clover);
    for (const o of cat.options || []) for (const ch of o.choices || []) if (ch && ch.clover) mods.add(ch.clover);
  }
  for (const f of (map && map.floats) || []) if (f && f.clover) mods.add(f.clover);
  return { items, mods };
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
function elementsOf(r) { return r && Array.isArray(r.elements) ? r.elements : null; }

/** Validate and shape the three Clover lists into one table. Throws on the first malformed element (Q6: nothing partial). */
function buildTable(itemsEls, groupsEls, taxEls, now) {
  const table = { version: 1, syncedAt: now, items: {}, modifiers: {}, taxRates: {} };
  for (const t of taxEls) {
    if (!t || typeof t.id !== "string" || !ID_RE.test(t.id) || typeof t.name !== "string" || !isInt(t.rate, 0, 5000000)) throw new Error("bad tax rate element");
    table.taxRates[t.id] = { name: t.name.slice(0, 60), rate: t.rate, isDefault: t.isDefault === true };
  }
  for (const g of groupsEls) {
    if (!g || typeof g.id !== "string" || !ID_RE.test(g.id)) throw new Error("bad modifier group element");
    const mods = g.modifiers && Array.isArray(g.modifiers.elements) ? g.modifiers.elements : [];
    for (const m of mods) {
      if (!m || typeof m.id !== "string" || !ID_RE.test(m.id) || typeof m.name !== "string" || !isInt(m.price, -100000, 100000)) throw new Error("bad modifier element");
      table.modifiers[m.id] = { name: m.name.slice(0, 80), price: m.price, groupId: g.id };
    }
  }
  for (const it of itemsEls) {
    if (!it || typeof it.id !== "string" || !ID_RE.test(it.id) || typeof it.name !== "string") throw new Error("bad item element");
    if (it.price !== undefined && !isInt(it.price, 0, 1000000)) throw new Error("bad item price");
    const trs = it.taxRates && Array.isArray(it.taxRates.elements) ? it.taxRates.elements : [];
    for (const t of trs) if (!t || typeof t.id !== "string" || !ID_RE.test(t.id)) throw new Error("bad item tax rate reference");
    const groups = it.modifierGroups && Array.isArray(it.modifierGroups.elements) ? it.modifierGroups.elements : [];
    for (const g of groups) {                                 // modifiers can arrive nested in the item expansion too: take them (same schema)
      const ms = g && g.modifiers && Array.isArray(g.modifiers.elements) ? g.modifiers.elements : [];
      for (const m of ms) {
        if (!m || typeof m.id !== "string" || !ID_RE.test(m.id) || typeof m.name !== "string" || !isInt(m.price, -100000, 100000)) throw new Error("bad nested modifier element");
        if (!table.modifiers[m.id]) table.modifiers[m.id] = { name: m.name.slice(0, 80), price: m.price, groupId: g.id };
      }
    }
    for (const t of trs) if (!table.taxRates[t.id]) table.taxRates[t.id] = { name: String(t.name || "Tax").slice(0, 60), rate: isInt(t.rate, 0, 5000000) ? t.rate : 0, isDefault: t.isDefault === true };
    table.items[it.id] = { name: it.name.slice(0, 80), price: it.price === undefined ? null : it.price, hidden: it.hidden === true,
      defaultTaxRates: it.defaultTaxRates !== false, taxRateIds: trs.map(t => t.id) };
  }
  return table;
}

function validTable(t) {
  try {
    if (!t || t.version !== 1 || typeof t.items !== "object" || typeof t.modifiers !== "object" || typeof t.taxRates !== "object" || !isInt(t.syncedAt, 1, 8.64e15)) return false;
    for (const [id, it] of Object.entries(t.items)) if (!ID_RE.test(id) || typeof it.name !== "string" || !(it.price === null || isInt(it.price, 0, 1000000)) || !Array.isArray(it.taxRateIds)) return false;
    for (const [id, m] of Object.entries(t.modifiers)) if (!ID_RE.test(id) || !isInt(m.price, -100000, 100000)) return false;
    for (const [id, r] of Object.entries(t.taxRates)) if (!ID_RE.test(id) || !isInt(r.rate, 0, 5000000)) return false;
    return true;
  } catch { return false; }
}

/**
 * @param {{ cloverGet: (p: string) => Promise<any>, dir: string, map: object, taxAllow?: number[], priceFloorCents?: number,
 *           now?: () => number, log?: object }} d
 */
function createCatalog(d) {
  const now = d.now || Date.now;
  const log = d.log || console;
  const file = path.join(d.dir, "catalog.json");
  const acceptFlag = path.join(d.dir, "catalog-accept.flag");
  const ids = mappedIds(d.map);
  const taxAllow = (d.taxAllow || []).filter(n => Number.isFinite(n));
  const floor = Number.isInteger(d.priceFloorCents) ? d.priceFloorCents : 25;
  const maxAgeMs = d.maxAgeMs || 6 * 3600000;
  const st = { table: null, hold: [], alerts: [], lastError: null, lastSyncAt: 0, lastOkAt: 0, source: "none" };
  let timer = null, syncing = false;

  const alert = msg => { const a = { at: new Date(now()).toISOString(), msg: String(msg).slice(0, 200) }; if (!st.alerts.length || st.alerts[st.alerts.length - 1].msg !== a.msg) st.alerts.push(a); if (st.alerts.length > 8) st.alerts.shift(); log.warn("catalog: " + a.msg); };

  // last good copy from disk (validated again: never trust the disk blindly)
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); if (validTable(j)) { st.table = j; st.source = "disk"; } else if (fs.existsSync(file)) alert("catalog.json on disk failed validation: ignored"); } catch (e) { if (e.code !== "ENOENT") alert("catalog.json unreadable: ignored"); }

  async function fetchAll(base, expand) {
    const out = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await d.cloverGet(`${base}?${expand ? expand + "&" : ""}limit=${PAGE_LIMIT}&offset=${page * PAGE_LIMIT}`);
      const els = elementsOf(r);
      if (!els) throw new Error(`${base}: unexpected response shape`);
      out.push(...els);
      if (els.length < PAGE_LIMIT) return out;
    }
    throw new Error(`${base}: still returning pages after ${MAX_PAGES} (not exhausted): refusing a partial list`);
  }

  /** Compare a candidate to the last good copy. Returns { reject: [reasons], hold: [reasons] }. */
  function judge(cand, last) {
    const reject = [], hold = [];
    for (const id of ids.items) if (!cand.items[id]) reject.push(`mapped item ${id} is missing from Clover`);
    for (const id of ids.mods)  if (!cand.modifiers[id]) reject.push(`mapped modifier ${id} is missing from Clover`);
    if (last) {
      const a = Object.keys(last.items).length, b = Object.keys(cand.items).length;
      if (a > 0 && b < a * 0.9) reject.push(`item count dropped from ${a} to ${b} (more than 10%)`);
      // CR-014: compare with the BASELINE (the last owner-accepted price, which only follows moves under 10%), not just the last sync,
      // so a price walking up 40% at a time is caught on the second step.
      const bi = (last.baseline && last.baseline.items) || {}, bm = (last.baseline && last.baseline.modifiers) || {};
      for (const id of ids.items) if (last.items[id] && cand.items[id] && last.items[id].price !== null) {
        const o = bi[id] !== undefined ? bi[id] : last.items[id].price, n = cand.items[id].price;
        if (o >= floor && (n === null || Math.abs(n - o) > o * 0.5)) hold.push(`item ${id} price moved ${o} -> ${n} (more than 50% from the accepted price)`);   // a baseline under the floor is not a baseline
      }
      for (const id of ids.mods) if (last.modifiers[id] && cand.modifiers[id]) {
        const o = bm[id] !== undefined ? bm[id] : last.modifiers[id].price, n = cand.modifiers[id].price;
        if (o !== 0 && Math.abs(n - o) > Math.abs(o) * 0.5) hold.push(`modifier ${id} price moved ${o} -> ${n} (more than 50%)`);
        if (o === 0 && Math.abs(n) > 50) hold.push(`modifier ${id} price moved 0 -> ${n}`);
      }
    }
    for (const id of ids.items) { const p = cand.items[id] && cand.items[id].price; if (cand.items[id] && (p === null || p < floor)) hold.push(`item ${id} is priced ${p} (under the ${floor} cent floor)`); }
    return { reject, hold };
  }

  /** The baseline follows a price only when the move is under 10% (or the owner accepted it): slow, deliberate changes pass, big or stepped ones do not. */
  function setBaseline(cand, last, accepted) {
    const pb = (last && last.baseline) || { items: {}, modifiers: {} };
    const follow = (o, n) => accepted || o === undefined || o === null || n === null || o === 0 || Math.abs(n - o) <= Math.abs(o) * 0.1;
    cand.baseline = { items: {}, modifiers: {} };
    for (const id of ids.items) { const n = cand.items[id].price, o = pb.items[id]; cand.baseline.items[id] = follow(o, n) ? n : o; }
    for (const id of ids.mods) { const n = cand.modifiers[id].price, o = pb.modifiers[id]; cand.baseline.modifiers[id] = follow(o, n) ? n : o; }
  }
  function promote(cand, how, accepted) {
    setBaseline(cand, st.table, accepted || !st.table);
    lib.writeJsonAtomic(file, cand);                           // temp, then rename
    st.table = cand; st.source = how; st.lastOkAt = now();
  }

  async function sync() {
    if (syncing) return st;
    syncing = true; st.lastSyncAt = now();
    try {
      const [itemsEls, groupsEls, taxEls] = [
        await fetchAll("/items", "expand=taxRates,modifierGroups.modifiers"),
        await fetchAll("/modifier_groups", "expand=modifiers"),
        await fetchAll("/tax_rates", ""),
      ];
      const cand = buildTable(itemsEls, groupsEls, taxEls, now());
      const { reject, hold } = judge(cand, st.table);
      const accept = fs.existsSync(acceptFlag);
      if (reject.length) { st.lastError = reject[0]; for (const r of reject.slice(0, 3)) alert(`keeping the last good catalog: ${r}`); st.hold = st.table ? [] : ["no usable catalog"]; return st; }
      if (hold.length && !accept && !st.table) {
        // nothing to compare with yet: take the table (a mapped id is present, the schema is good) but hold payment, and keep holding while the cause lasts
        promote(cand, "clover"); st.hold = hold.slice(0, 5); st.lastError = null;
        for (const h of hold.slice(0, 3)) alert(`PAYMENT HELD: ${h}`);
        return st;
      }
      if (hold.length && !accept && st.table) {
        st.hold = hold.slice(0, 5); st.lastError = null;
        for (const h of hold.slice(0, 3)) alert(`PAYMENT HELD: ${h}; touch .tb/catalog-accept.flag to accept the new prices`);
        return st;                                              // the new copy is NOT promoted
      }
      if (hold.length && accept) alert("owner accepted the new prices (catalog-accept.flag)");
      if (accept) { try { fs.unlinkSync(acceptFlag); } catch {} }
      promote(cand, "clover", accept); st.hold = []; st.lastError = null;
      log.log(`catalog: synced ${Object.keys(cand.items).length} items, ${Object.keys(cand.modifiers).length} modifiers, ${Object.keys(cand.taxRates).length} tax rates`);
    } catch (e) {
      st.lastError = e.message; alert(`sync failed (${e.message}); keeping the last good catalog`);
    } finally { syncing = false; }
    return st;
  }

  /** The tax rates that apply to one item: its own list, or the account defaults. */
  function ratesFor(t, itemId) {
    const it = t.items[itemId]; if (!it) return [];
    if (it.taxRateIds.length) return it.taxRateIds.map(id => t.taxRates[id]).filter(Boolean);
    return it.defaultTaxRates ? Object.values(t.taxRates).filter(r => r.isDefault) : [];
  }

  /** Why payNow must be false right now, or null. */
  function payBlock() {
    const t = st.table;
    if (!t) return "catalog not synced";
    if (now() - t.syncedAt > maxAgeMs) return "catalog is older than " + Math.round(maxAgeMs / 3600000) + " hours (Clover unreachable?)";
    if (st.hold.length) return "catalog held: " + st.hold[0];
    if (!ids.items.size) return "no catalog item is mapped yet (catalog-map.json)";
    if (!taxAllow.length) return "tax rate allow-list not configured (CATALOG_TAX_RATES)";
    for (const id of ids.items) {
      const rs = ratesFor(t, id);
      if (!rs.length) return `mapped item ${id} has no tax rate in Clover (CR-004: a vacuous allow-list check would charge no tax)`;   // every mapped item must resolve to at least one allowed rate
      for (const r of rs) {
        const pct = r.rate / RATE_PER_PERCENT;
        if (!taxAllow.some(a => Math.abs(a - pct) < 1e-6)) return `tax rate ${r.name} ${pct}% is not in the allow-list`;
      }
    }
    return null;
  }

  function start(everyMs) {
    clearInterval(timer);
    const run = () => sync().catch(e => log.warn("catalog sync error: " + e.message));
    run();
    timer = setInterval(run, everyMs || 15 * 60000);
    if (timer.unref) timer.unref();
  }
  function stop() { clearInterval(timer); timer = null; }

  /** Display prices for the page (GET /catalog): only mapped keys, in cents, plus the tax label. */
  function display() {
    const t = st.table;
    const out = { ok: !!t, payNow: !!t && !payBlock(), reason: payBlock(), syncedAt: t ? t.syncedAt : 0, items: {}, mods: {}, tax: null };
    if (!t) return out;
    for (const [catKey, cat] of Object.entries(d.map.categories || {})) {
      for (const [itemId, it] of Object.entries(cat.items || {})) if (it.clover && t.items[it.clover] && t.items[it.clover].price !== null) out.items[`${catKey}/${itemId}`] = t.items[it.clover].price;
      for (const o of cat.options || []) for (const ch of o.choices || []) if (ch.clover && t.modifiers[ch.clover]) out.mods[`${catKey}/${o.key}/${ch.name}`] = t.modifiers[ch.clover].price;
    }
    for (const f of d.map.floats || []) if (f.clover && t.modifiers[f.clover]) out.mods[`float/${f.mod}`] = t.modifiers[f.clover].price;
    const rs = [...ids.items].flatMap(id => ratesFor(t, id));
    if (rs.length) out.tax = { name: rs[0].name, pct: rs[0].rate / RATE_PER_PERCENT };
    return out;
  }

  /** Heartbeat block: counts and short alert strings only. */
  function heartbeat() {
    return { ok: !!st.table, source: st.source, syncedAt: st.table ? new Date(st.table.syncedAt).toISOString() : null,
      items: st.table ? Object.keys(st.table.items).length : 0, mapped: ids.items.size + ids.mods.size,
      payBlock: payBlock(), hold: st.hold.length, alerts: st.alerts.slice(-3).map(a => `${a.msg} @${a.at.slice(5, 16)}`), lastError: st.lastError };
  }

  return { sync, start, stop, display, heartbeat, payBlock, ratesFor, table: () => st.table, state: st, RATE_PER_PERCENT, _ids: ids };
}

module.exports = { createCatalog, buildTable, validTable, mappedIds, RATE_PER_PERCENT };
