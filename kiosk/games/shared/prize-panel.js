/* prize-panel.js: the result panel after a game or a winning slot spin. window.TBPrize.show({ result, mode, onAgain }).
   result is what the kiosk SERVER answered ({win:false,thanks:true} or {win:true,label,code,expiresAt,orderNow,saveable,...}); the page never decides a prize.
   Built with textContent only. The typed phone number lives in one variable until the save request returns, then it is cleared: never in
   storage, the DOM, a data attribute or the console. This is prize lookup only: no marketing consent, no list, no /subscribe. */
(function (root) {
  'use strict';
  const doc = root.document;

  /* ===== PRIZE PHONE WORDING (legal review pending, owner will send edits) =====
     The duration in savePrompt comes from /api/arcade/rules prizeLifeText (kiosk/arcade-rules.json, "24 hours" today = what the Worker really keeps a prize).
     The legal memo's "30 days" is NOT true in this build, so it is never hard-coded here. Never describe the stored number with any privacy label it does not earn.
     No message of any kind is ever sent to a prize number. Prize lookup only: no marketing consent, no list. */
  const WORDING = {
    thanksTitle: 'Thanks for playing!',
    winTitle: 'You won a prize!',
    codeHelp: 'Take a photo or write it down.',
    orderNowBtn: 'ORDER NOW AND USE IT',
    orderNowLine: 'It is already added to your next order here. Show nothing, we have it.',
    laterLine: 'Use it on your next order: type your phone number or this code at the order screen.',
    until: function (when) { return 'Good until ' + when + '.'; },
    savePrompt: function (life) { return 'Save this prize to a phone number? We use it only to find your prize next time. No calls, texts, or lists. Deleted when used or in ' + life + '.'; },
    saveBtn: 'Save to phone',
    skipBtn: 'Just give me a code',
    ageTitle: 'To save to a phone number, enter your birth month and year.',
    ageBad: 'Please check the year.',
    ageGo: 'CONTINUE',
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    typeHint: 'Type all 10 digits of your US phone number.',
    saveGo: 'SAVE',
    saveBack: 'BACK',
    saved: function (last2) { return 'Saved to the number ending in ' + last2 + '. We will not text it.'; },
    already: 'That number already has a saved prize. Use the code above.',
    failed: 'Could not save it right now. Take a photo of the code.',
    needDigits: 'Please type all 10 digits.',
    again: 'PLAY AGAIN',
    spinAgain: 'SPIN AGAIN',
    allGames: 'ALL GAMES',
    moreGames: 'MORE GAMES',
    order: 'ORDER DRINKS'
  };
  /* ===== END PRIZE PHONE WORDING ===== */

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  /* "today at 4:15 pm" / "Saturday at 4:15 pm" from the server's expiresAt; '' when it is missing or already past (then nothing is promised) */
  function whenText(ms) {
    const t = Number(ms);
    if (!Number.isFinite(t) || t <= Date.now()) return '';
    const d = new Date(t), n = new Date();
    let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0'); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12;
    const day = d.toDateString() === n.toDateString() ? 'today' : (t - Date.now() < 6 * 86400000 ? DAYS[d.getDay()] : (d.getMonth() + 1) + '/' + d.getDate());
    return day + ' at ' + h + ':' + m + ' ' + ap;
  }
  function fmtPhone(p) { const a = (p + '__________').slice(0, 10); return '(' + a.slice(0, 3) + ') ' + a.slice(3, 6) + '-' + a.slice(6, 10); }
  function mk(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(cls, text, fn) { const b = mk('button', 'kp-btn ' + cls, text); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function link(cls, text, href, fn) { const a = mk('a', 'kp-btn ' + cls, text); a.href = href; if (fn) a.addEventListener('click', fn); return a; }

  /* The phone path is closed for the rest of this visit after an under-13 answer. A bare flag, no age data (the order screen honours the same key). */
  const OFF_KEY = 'tbPhonePathOff';
  let memOff = false;
  function phoneOff() { if (memOff) return true; try { return root.sessionStorage.getItem(OFF_KEY) === '1'; } catch (e) { return false; } }
  function closePhonePath() { memOff = true; try { root.sessionStorage.setItem(OFF_KEY, '1'); } catch (e) { /* in-memory flag still holds for this page */ } }
  /* under 13 = 156 months or fewer from the birth month to this month (conservative inside the birth month); null = an impossible answer */
  function ageVerdict(month, year, now) {
    const n = now || new Date(), cy = n.getFullYear(), cm = n.getMonth() + 1;
    if (!(month >= 1 && month <= 12) || !(year >= 1900) || year > cy || (year === cy && month > cm)) return null;
    return (cy * 12 + cm) - (year * 12 + month) <= 156 ? 'under' : 'ok';
  }
  /* how long a prize is kept, from the rules the server enforces; until it answers (or if it fails) the conservative default is what the Worker really does */
  let lifeText = '24 hours', lifeAsked = false;
  function loadLife(done) {
    if (lifeAsked) return;
    lifeAsked = true;
    try {
      root.fetch('/api/arcade/rules', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        const t = j && j.rules && typeof j.rules.prizeLifeText === 'string' ? j.rules.prizeLifeText.replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 30) : '';
        if (t) { lifeText = t; if (typeof done === 'function') done(); }
      }, function () { /* default stays */ });
    } catch (e) { /* default stays */ }
  }

  let el = null;
  function hide() { if (el && el.parentNode) el.parentNode.removeChild(el); el = null; }

  function show(opts) {
    hide();
    const o = opts || {}, r = o.result || {}, slots = o.mode === 'slots';
    const win = r.win === true && /^[A-Z2-9]{4}$/.test(String(r.code));
    const code = win ? String(r.code) : '';
    const when = win ? whenText(r.expiresAt) : '';
    const orderNow = win && r.orderNow === true;
    const modal = el = mk('div', 'kp-modal' + (o.ended ? ' kp-over-ended' : '')); modal.id = 'kpPanel'; modal.setAttribute('role', 'dialog');
    const card = mk('div', 'kp-card'); modal.appendChild(card);
    const body = mk('div', 'kp-body'); card.appendChild(body);
    const nav = mk('div', 'kp-nav'); card.appendChild(nav);
    let phone = '', busy = false, offer = r.saveable === true && !phoneOff(), promptEl = null;
    if (win && offer) loadLife(function () { if (promptEl) promptEl.textContent = WORDING.savePrompt(lifeText); });

    function navRow() {
      nav.textContent = '';
      if (slots) {
        if (orderNow) nav.appendChild(link('kp-btn--go kp-order', WORDING.orderNowBtn, '/#menu'));
        nav.appendChild(btn('kp-again', WORDING.spinAgain, hide));
        nav.appendChild(link('kp-games', WORDING.moreGames, '/arcade/games'));
      } else if (o.ended) {      // the visit's time ran out while the game was finishing: the prize is still shown, but nothing starts another game
        nav.appendChild(link('kp-btn--go kp-order', WORDING.order, '/#menu', function () { if (root.TBK) root.TBK.clearVisit(); }));
      } else {
        nav.appendChild(btn('kp-btn--go kp-again', WORDING.again, function () { hide(); if (typeof o.onAgain === 'function') o.onAgain(); }));
        nav.appendChild(link('kp-games', WORDING.allGames, '/arcade/games'));
        nav.appendChild(link('kp-order', WORDING.order, '/#menu', function () { if (root.TBK) root.TBK.clearVisit(); }));
      }
    }

    function drawWin(extra) {
      body.textContent = '';
      body.appendChild(mk('h2', 'kp-title', WORDING.winTitle));
      body.appendChild(mk('p', 'kp-prize', String(r.label || 'Boardwalk Prize')));
      const c = mk('div', 'kp-code', code); c.id = 'kpCode'; body.appendChild(c);
      body.appendChild(mk('p', 'kp-help', WORDING.codeHelp));
      if (when) body.appendChild(mk('p', 'kp-until', WORDING.until(when)));
      body.appendChild(mk('p', 'kp-line', orderNow ? WORDING.orderNowLine : WORDING.laterLine));
      if (orderNow && !slots) body.appendChild(link('kp-btn--go kp-ordernow', WORDING.orderNowBtn, '/#menu', function () { if (root.TBK) root.TBK.clearVisit(); }));
      if (extra) { const m = mk('p', 'kp-msg kp-msg--result', extra); m.id = 'kpMsg'; body.appendChild(m); }
      if (offer && !phoneOff()) {
        promptEl = mk('p', 'kp-use kp-prompt', WORDING.savePrompt(lifeText)); promptEl.id = 'kpPrompt'; body.appendChild(promptEl);
        const row = mk('div', 'kp-choice');
        row.appendChild(btn('kp-btn--choice kp-btn--save', WORDING.saveBtn, drawAge));
        row.appendChild(btn('kp-btn--choice kp-btn--skip', WORDING.skipBtn, function () { offer = false; drawWin(''); }));
        body.appendChild(row);
      }
      navRow();
    }

    /* Neutral age check, phone path only. No defaults, nothing preselected, no age hint. Nothing is sent anywhere; the answers exist only inside this function and are
       dropped the moment the decision is made (under 13: the code stays, the phone path closes for the visit; otherwise the keypad). */
    function drawAge() {
      let m = 0, y = '';
      body.textContent = '';
      promptEl = null;
      body.appendChild(mk('h2', 'kp-title kp-title--small', WORDING.ageTitle));
      const grid = mk('div', 'kp-months'); grid.id = 'kpMonths';
      const mbtns = WORDING.months.map(function (name, i) {
        const b = btn('kp-month', name, function () { m = i + 1; paint(); }); b.setAttribute('aria-pressed', 'false'); grid.appendChild(b); return b;
      });
      body.appendChild(grid);
      const disp = mk('div', 'kp-year', '____'); disp.id = 'kpYear'; body.appendChild(disp);
      const msg = mk('p', 'kp-msg', ''); msg.id = 'kpMsg'; body.appendChild(msg);
      const pad = mk('div', 'kp-pad'); pad.id = 'kpPad';
      const go = btn('kp-btn--go kp-savego', WORDING.ageGo, decide); go.id = 'kpAgeGo';
      function paint() {
        mbtns.forEach(function (b, i) { b.setAttribute('aria-pressed', m === i + 1 ? 'true' : 'false'); });
        disp.textContent = (y + '____').slice(0, 4);
        go.disabled = !(m && y.length === 4);
      }
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'del'].forEach(function (key) {
        if (key === 'back') { pad.appendChild(btn('kp-key kp-key--fn', WORDING.saveBack, function () { m = 0; y = ''; drawWin(''); })); return; }
        if (key === 'del') { const d = btn('kp-key kp-key--fn', '⌫', function () { y = y.slice(0, -1); paint(); }); d.setAttribute('aria-label', 'Delete'); pad.appendChild(d); return; }
        pad.appendChild(btn('kp-key', key, function () { if (y.length < 4) { y += key; paint(); } }));
      });
      body.appendChild(pad);
      nav.textContent = '';
      nav.appendChild(go);
      paint();
      function decide() {
        const v = ageVerdict(m, parseInt(y, 10));
        m = 0; y = '';                                   // the answers are gone before anything else happens
        if (v === null) { paint(); msg.textContent = WORDING.ageBad; return; }
        if (v === 'under') { closePhonePath(); offer = false; drawWin(''); return; }
        drawSave();
      }
    }

    function drawSave() {
      phone = '';
      body.textContent = '';
      promptEl = null;
      body.appendChild(mk('h2', 'kp-title kp-title--small', WORDING.saveBtn));
      body.appendChild(mk('p', 'kp-use', WORDING.savePrompt(lifeText)));
      const disp = mk('div', 'kp-phone', fmtPhone('')); disp.id = 'kpPhone'; body.appendChild(disp);
      const msg = mk('p', 'kp-msg', WORDING.typeHint); msg.id = 'kpMsg'; body.appendChild(msg);
      const pad = mk('div', 'kp-pad'); pad.id = 'kpPad';
      const go = btn('kp-btn--go kp-savego', WORDING.saveGo, doSave); go.id = 'kpSave';
      function paint() { disp.textContent = fmtPhone(phone); go.disabled = phone.length !== 10; }
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'del'].forEach(function (key) {
        if (key === 'back') { pad.appendChild(btn('kp-key kp-key--fn', WORDING.saveBack, function () { phone = ''; drawWin(''); })); return; }
        if (key === 'del') { const d = btn('kp-key kp-key--fn', '⌫', function () { phone = phone.slice(0, -1); paint(); }); d.setAttribute('aria-label', 'Delete'); pad.appendChild(d); return; }
        pad.appendChild(btn('kp-key', key, function () { if (phone.length < 10) { phone += key; paint(); } }));
      });
      body.appendChild(pad);
      nav.textContent = '';
      nav.appendChild(go);
      const skip = btn('kp-skip2', WORDING.skipBtn, function () { phone = ''; offer = false; drawWin(''); }); skip.id = 'kpSkip2';
      nav.appendChild(skip);
      paint();
      function doSave() {
        if (busy) return;
        if (phone.length !== 10) { msg.textContent = WORDING.needDigits; return; }
        busy = true; go.disabled = true;
        const sendPhone = phone;
        root.fetch('/api/arcade/wallet/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: sendPhone, code: code }) })
          .then(function (res) { return res.json().catch(function () { return null; }); })
          .then(function (d) {
            phone = ''; busy = false;
            if (!el) return;
            if (d && d.ok === true && d.saved === true) { offer = false; drawWin(WORDING.saved(String(d.last2 || '').replace(/\D/g, '').slice(-2))); }
            else if (d && d.error === 'already-have') { offer = false; drawWin(WORDING.already); }
            else { offer = false; drawWin(WORDING.failed); }
          }, function () { phone = ''; busy = false; if (el) { offer = false; drawWin(WORDING.failed); } });
      }
    }

    if (win) drawWin('');
    else { body.appendChild(mk('h2', 'kp-title', WORDING.thanksTitle)); navRow(); }
    doc.body.appendChild(modal);
    return modal;
  }

  root.TBPrize = { show: show, hide: hide, WORDING: WORDING, whenText: whenText, ageVerdict: ageVerdict, phoneOff: phoneOff };
})(typeof window !== 'undefined' ? window : globalThis);
