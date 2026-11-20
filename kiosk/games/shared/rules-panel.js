/* rules-panel.js: the Prize Game Rules panel. window.TBRules.open() / .close(). Styled in prize-panel.css (.kr-*), shared by the picker, the five games and the slots page.
   Built from GET /api/arcade/rules with textContent only. The facts the owner has not supplied (sponsor, address, promotion dates, web address) are shown as clearly
   marked placeholders and are NEVER invented. Odds are stated only as far as the server enforces them: the free-drink ceiling, and "most games do not win" only while
   the live odds table makes it true (the server computes that flag). If the rules cannot be fetched only the two safe lines are shown (no odds, no prize list). */
(function (root) {
  'use strict';
  const doc = root.document;

  /* ===== RULES WORDING (legal review pending, owner will send edits) ===== */
  const R = {
    title: 'Prize Game Rules',
    free: 'Free to play. No purchase needed to play or win.',
    unavailable: 'The full rules could not be loaded right now. Ask at the window.',
    check: function (most) { return 'Each game ends with a random prize check' + (most ? "; most games don't win." : '.'); },
    freeDrink: function (n) { return 'Free drink: no more than 1 in ' + n + ' games.'; },
    prizes: 'Prizes: ',
    sticker: 'Any prize can be swapped for a sticker, no purchase.',
    limited: "Limited prizes each day; when they're gone, games are just for fun.",
    onePer: 'One prize per person per day.',
    expire: function (life) { return 'Prizes expire ' + life + ' after winning. No cash value.'; },
    period: 'Promotion period: ',
    sponsor: 'Sponsor: ',
    full: 'Full rules and privacy: ',
    close: 'CLOSE'
  };
  /* ===== END RULES WORDING ===== */

  const PH = {
    promoStart: '[PROMOTION START: set in kiosk/arcade-rules.json]',
    promoEnd: '[PROMOTION END: set in kiosk/arcade-rules.json]',
    sponsorName: '[SPONSOR NAME: set in kiosk/arcade-rules.json]',
    sponsorAddress: '[SPONSOR ADDRESS: set in kiosk/arcade-rules.json]',
    urls: '[RULES AND PRIVACY WEB ADDRESS: set rulesUrl / privacyUrl in kiosk/arcade-rules.json]'
  };

  function mk(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  /* a paragraph from parts: strings are plain text, {ph:'...'} is a visible placeholder */
  function para(parts) {
    const p = mk('p', '');
    parts.forEach(function (x) { if (typeof x === 'string') p.appendChild(doc.createTextNode(x)); else p.appendChild(mk('span', 'kr-ph', x.ph)); });
    return p;
  }
  const clean = function (v, n) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n) : ''; };

  /* the rules as an array of paragraph part-lists; pure, so tests can call it with any answer */
  function build(d) {
    const rl = d && d.ok === true && d.rules && typeof d.rules === 'object' ? d.rules : null;
    const out = [[R.free]];
    if (!rl) { out.push([R.unavailable]); return out; }
    const miss = new Set(Array.isArray(rl.missing) ? rl.missing : []);
    const one = Number(rl.freeDrinkOneIn);
    out.push([R.check(rl.mostGamesDoNotWin === true) + (Number.isFinite(one) && one >= 1 ? ' ' + R.freeDrink(Math.round(one)) : '')]);
    const prizes = (Array.isArray(rl.prizes) ? rl.prizes : []).map(function (p) { const l = clean(p && p.label, 80), n = clean(p && p.note, 80); return l ? (n ? l + ' (' + n + ')' : l) : ''; }).filter(Boolean);
    if (prizes.length) out.push([R.prizes + prizes.join('; ') + '.']);
    const rules = [];
    if (rl.stickerSwap === true) rules.push(R.sticker);
    if (rl.limitedPrizesDaily === true) rules.push(R.limited);
    if (rl.onePerPersonPerDay === true) rules.push(R.onePer);
    rules.push(R.expire(clean(rl.prizeLifeText, 40) || '24 hours'));
    out.push([rules.join(' ')]);
    const s = clean(rl.promoStart, 40), e = clean(rl.promoEnd, 40);
    out.push([R.period, s && !miss.has('promoStart') ? s : { ph: PH.promoStart }, ' to ', e && !miss.has('promoEnd') ? e : { ph: PH.promoEnd }, '.']);
    const sn = clean(rl.sponsorName, 80), sa = clean(rl.sponsorAddress, 160);
    out.push([R.sponsor, sn && !miss.has('sponsorName') ? sn : { ph: PH.sponsorName }, ', ', sa && !miss.has('sponsorAddress') ? sa : { ph: PH.sponsorAddress }, ', St. George, UT.']);
    const ru = clean(rl.rulesUrl, 120), pu = clean(rl.privacyUrl, 120);
    out.push(ru || pu ? [R.full + [ru, pu].filter(Boolean).join(' and ')] : [R.full, { ph: PH.urls }]);
    return out;
  }

  let el = null;
  function close() { if (el && el.parentNode) el.parentNode.removeChild(el); el = null; }
  function open() {
    close();
    const modal = el = mk('div', 'kr-modal'); modal.id = 'krPanel'; modal.setAttribute('role', 'dialog');
    const card = mk('div', 'kr-card'); modal.appendChild(card);
    const body = mk('div', 'kr-body'); body.id = 'krBody'; card.appendChild(body);
    const x = mk('button', 'kp-btn kp-btn--go kr-close', R.close); x.type = 'button'; x.id = 'krClose'; x.addEventListener('click', close); card.appendChild(x);
    function paint(d) {
      body.textContent = '';
      body.appendChild(mk('h2', 'kr-title', R.title));
      build(d).forEach(function (parts) { body.appendChild(para(parts)); });
    }
    body.appendChild(mk('h2', 'kr-title', R.title)); body.appendChild(para([R.free]));      // the safe line shows at once; the full rules replace it when the server answers
    try {
      root.fetch('/api/arcade/rules', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }).then(function (d) { if (el === modal) paint(d); });
    } catch (e) { paint(null); }
    doc.body.appendChild(modal);
    return modal;
  }

  root.TBRules = { open: open, close: close, build: build, WORDING: R };
})(typeof window !== 'undefined' ? window : globalThis);
