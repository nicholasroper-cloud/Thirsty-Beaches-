/* Server-side price check for "Pay on my phone" carts.
   A cart line is {name, unit (dollars), qty, mods:[names], catKey?}, exactly what the kiosk page
   keeps in its cart. A line is accepted only when its name + mods describe something the kiosk
   (or the Clover catalog) actually sells AND its unit price is within 1 cent of what that
   combination costs. The amount charged is always the price computed here, never the client's.

   Two price sources, each checked on its own (an item from one is never combined with
   modifiers from the other):
   1. KIOSK_MENU: generated at build time from drink-kiosk.html, the menu the kiosk screen
      currently sells from (its loadMenu() from Clover is switched off).
   2. The live Clover inventory (items + modifier groups), for when the kiosk is switched back
      to the Clover-driven menu.                                                                */

export const norm = s => String(s || "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
const MAX_STEPS = 50000;

/* All prices (cents, excluding the base) that `mods` can add up to under the kiosk's rules:
   mods come in option-group order (single groups: at most one, multi groups: any number,
   no repeats, in tap order), then $0 free-text notes (Snap-a-pic lines only), then at most
   one upsell add-on as the very last mod (commitUpsell()). */
function kioskModTotals(mods, options, upsells, noteOk) {
  const out = new Set();
  let steps = 0;
  const tail = (i, sum) => {
    const rest = mods.slice(i);
    if (rest.every(noteOk)) out.add(sum);
    if (rest.length) {
      const last = rest[rest.length - 1];
      if (rest.slice(0, -1).every(noteOk)) for (const u of upsells) if (u.mod === last) out.add(sum + u.price);
    }
  };
  const go = (i, g, used, sum) => {
    if (++steps > MAX_STEPS) throw new Error("too-complex");
    if (g === options.length) { tail(i, sum); return; }
    const o = options[g];
    go(i, g + 1, [], sum);                                         // this group is finished
    if (i < mods.length && !used.includes(mods[i])) {
      const ch = o.choices.find(c => c.name === mods[i]);
      if (ch) {
        if (o.multi) go(i + 1, g, used.concat(mods[i]), sum + ch.d);
        else go(i + 1, g + 1, [], sum + ch.d);
      }
    }
  };
  go(0, 0, [], 0);
  return out;
}

function aiBasePrice(cat) {                     // openAIDrink(): BYO / Pour Decisions item, else the cheapest
  const byo = cat.items.find(i => /build your own|pour decisions|byo/i.test(i.name + i.id));
  if (byo) return byo.price;
  return cat.items.reduce((a, b) => (b.price < a.price ? b : a), cat.items[0]).price;
}

/* -> {found:bool, totals:Set<cents>} */
export function kioskCandidates(line, menu) {
  const n = norm(line.name);
  const totals = new Set();
  let found = false;
  const allChoiceNames = new Set();
  for (const c of Object.values(menu.cats)) for (const o of c.options) for (const ch of o.choices) allChoiceNames.add(norm(ch.name));
  for (const u of menu.upsells) allChoiceNames.add(norm(u.mod));
  const noNotes = () => false;

  // 1) a real menu item, matched by name (in the line's category when it names one we know)
  const keys = Object.keys(menu.cats);
  for (const k of keys) {
    const cat = menu.cats[k];
    for (const it of cat.items) {
      if (norm(it.name) !== n) continue;
      found = true;
      if (line.catKey && menu.cats[line.catKey] && line.catKey !== k) continue;
      for (const t of kioskModTotals(line.mods, cat.options, menu.upsells, noNotes)) totals.add(it.price + t);
    }
  }
  if (found) return { found, totals };

  // 2) a custom-named drink: Snap-a-pic, Design-your-own (AI) or an owner special. These carry
  //    the category they were built in, are priced from that category's base item, and their
  //    contents are exactly their mods. The name is cosmetic (it matches no real menu item).
  const cat = line.catKey && Object.prototype.hasOwnProperty.call(menu.cats, line.catKey) ? menu.cats[line.catKey] : null;
  if (!cat || !cat.items.length) return { found: false, totals };
  if (String(line.name).trim().length > 28) return { found: false, totals };   // kiosk slices these names to 28
  found = true;
  // Snap-a-pic only: anything the kiosk can't price rides along as a $0 note ("<x> syrup" etc.).
  // A note may never be the name of something the kiosk charges for.
  const snapCat = menu.snap.cats.includes(line.catKey);
  const noteOk = m => snapCat && typeof m === "string" && m.length >= 1 && m.length <= 40 && !/[<>,·]/.test(m) && !allChoiceNames.has(norm(m));
  const bases = new Set([aiBasePrice(cat)]);
  if (snapCat) {
    const pd = (menu.cats.dirtysodas && menu.cats.dirtysodas.items.find(i => i.id === menu.snap.itemId));
    bases.add(pd ? pd.price : 349);
  }
  for (const b of bases) for (const t of kioskModTotals(line.mods, cat.options, menu.upsells, noteOk)) totals.add(b + t);
  return { found, totals };
}

/* Clover inventory in the shape cloverCandidates() reads:
   {items: {normName: [{price, groups:[groupId]}]}, groups: {groupId: [{name, price}]}} */
export function buildCloverBook(items, groups) {
  const book = { items: {}, groups: {} };
  for (const g of groups) {
    book.groups[g.id] = (((g.modifiers || {}).elements) || []).filter(m => m && m.available !== false)
      .map(m => ({ name: norm(m.name), price: Math.round(+m.price || 0) }));
  }
  for (const it of items) {
    if (!it || !it.name || it.hidden === true || it.available === false) continue;
    if (it.priceType && it.priceType !== "FIXED") continue;           // VARIABLE / PER_UNIT can't be checked
    if (typeof it.price !== "number") continue;
    const gids = (((it.modifierGroups || {}).elements) || []).map(g => g.id).filter(Boolean);
    (book.items[norm(it.name)] = book.items[norm(it.name)] || []).push({ price: it.price, groups: gids });
  }
  return book;
}

export function cloverCandidates(line, book) {
  const list = book.items[norm(line.name)] || [];
  const totals = new Set();
  let steps = 0;
  for (const it of list) {
    const opts = it.groups.flatMap(gid => (book.groups[gid] || []).map(m => ({ key: gid + "/" + m.name, ...m })));
    const go = (i, used, sum) => {
      if (++steps > MAX_STEPS) throw new Error("too-complex");
      if (i === line.mods.length) { totals.add(it.price + sum); return; }
      const want = norm(line.mods[i]);
      for (const m of opts) if (m.name === want && !used.includes(m.key)) go(i + 1, used.concat(m.key), sum + m.price);
    };
    go(0, [], 0);
  }
  return { found: list.length > 0, totals };
}

/* Pick the price to charge: the candidate closest to what the kiosk showed, if within 1 cent. */
export function pickPrice(clientCents, totalsSets) {
  let best = null;
  for (const s of totalsSets) for (const t of s) {
    const d = Math.abs(t - clientCents);
    if (d <= 1 && (best === null || d < Math.abs(best - clientCents))) best = t;
  }
  return best;
}
