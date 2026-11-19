/* Thirsty Beaches — 1986 Boardwalk Arcade Slot Machine (voice barker clips are staff-triggered; this page never uses the camera or microphone)
   Prizes are decided and issued by the kiosk SERVER (POST /api/arcade/spin -> the tb-where Worker): a claim code is shown only when the
   Worker issued one. The odds below are only the fallback labels for the reel animation; the real table lives in arcade-routes.js
   (tests/boardwalk-arcade.test.mjs pins them together). The 3-tap corner drawer needs the staff key (STATION_KEY) to change anything.
   'M' mutes locally. */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'tb_boardwalk_arcade_cfg_v1';
  const BARKER_COOLDOWN_MS = 45000;
  const MAX_FREE_DRINK_PCT = 2;   // mirrors arcade-routes.js; the server is the one that enforces it

  const DEFAULT_ODDS = [
    { id: 'standard', label: 'Standard Custom Drink', pct: 81, isPrize: false, trigger: 'drink_reveal' },
    { id: 'size_upgrade', label: 'Free Size Upgrade', pct: 6, isPrize: true, trigger: 'prize_win' },
    { id: 'soft_serve_topper', label: 'Free Pineapple Soft Serve or Vanilla Soft Serve Topper', pct: 5, isPrize: true, trigger: 'prize_win' },
    { id: 'neon_charm', label: 'Free 3D-Printed Neon Straw Charm', pct: 4, isPrize: true, trigger: 'arcade_charm_win' },
    { id: 'topper_or_sticker', label: 'Free Freeze-Dried Topper or UV-DTF Sticker', pct: 3, isPrize: true, trigger: 'prize_win' },
    { id: 'free_drink_jackpot', label: 'FREE DRINK JACKPOT!', pct: 1, isPrize: true, trigger: 'mega_jackpot' },
  ];

  /* Every string that reaches innerHTML goes through this first. */
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
  }

  /* The staff odds editor rows. Labels are escaped; numbers are forced to numbers. */
  function oddsGridHTML(odds) {
    return (Array.isArray(odds) ? odds : []).map((o, idx) => {
      const pct = Number.isFinite(Number(o && o.pct)) ? Number(o.pct) : 0;
      return '<label class="odds-item"><span>' + esc(o && o.label) + '</span><span><input type="number" min="0" max="' +
        (o && o.id === 'free_drink_jackpot' ? MAX_FREE_DRINK_PCT : 100) + '" step="1" data-odd-idx="' + idx + '" value="' + pct + '"> %</span></label>';
    }).join('');
  }

  // Export pure helpers for unit testing
  const exportsObj = { DEFAULT_ODDS, BARKER_COOLDOWN_MS, MAX_FREE_DRINK_PCT, esc, oddsGridHTML };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportsObj;
    return;
  }
  root.TBBoardwalkSlots = exportsObj;

  if (typeof document === 'undefined') return;

  async function init() {
    const spinBtn = document.getElementById('spinBtn');
    if (!spinBtn || !window.TBAudioBank) return;

    const audio = window.TBAudioBank.createAudioBank({ basePath: '/kiosk/audio/', pgMode: true });
    const $ = (id) => document.getElementById(id);

    /* Local (this screen only): persona, volume, mute. From the server (staff-set, needs the staff key to change): PG mode, winter board, odds. */
    let cfg = {
      personaMode: 'auto',
      volume: 0.75,
      muted: false,
      pgMode: true,
      winterEnabled: true,
      odds: DEFAULT_ODDS.map((o) => ({ ...o })),
    };
    let localSaved = null;
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && typeof saved === 'object') localSaved = saved;
    } catch {}
    const okPersona = (v) => v === 'shredder' || v === 'neon86' || v === 'auto';
    const okVolume = (v) => typeof v === 'number' && v >= 0 && v <= 1;
    function applyAudioFields(src) {
      if (okPersona(src.personaMode)) cfg.personaMode = src.personaMode;
      if (okVolume(src.volume)) cfg.volume = src.volume;
      if (typeof src.muted === 'boolean') cfg.muted = src.muted;
    }

    try {
      const r = await fetch('/api/arcade-config');
      if (r.ok) {
        const remote = await r.json();
        const c = remote && remote.config;
        if (c && typeof c === 'object') {
          if (!localSaved) applyAudioFields(c);
          if (typeof c.pgMode === 'boolean') cfg.pgMode = c.pgMode;
          if (typeof c.winterEnabled === 'boolean') cfg.winterEnabled = c.winterEnabled;
          if (Array.isArray(c.odds) && c.odds.length === DEFAULT_ODDS.length) cfg.odds = c.odds;
        }
      }
    } catch {}
    if (localSaved) applyAudioFields(localSaved);

    audio.setPersonaMode(cfg.personaMode);
    audio.setVolume(cfg.volume);
    audio.setMuted(cfg.muted);
    audio.setPgMode(cfg.pgMode);

    // Live menu inventory for Reels 1 & 2 (the page cannot reach the website, so the schema copy shipped with the kiosk is used)
    let slotBases = [
      { id: 'dirty-soda', label: 'Dirty Soda', examples: ['Dr Pepper', 'Diet Coke', 'Sprite', 'Orange Soda'] },
      { id: 'energy-mixer', label: 'Energy Mixer', examples: ['Neon Tide Clean Energy'] },
      { id: 'coffee-espresso', label: 'Fresh-Ground Coffee / Espresso', examples: ['High Tide Iced Coffee', 'Electric Beach Latte', 'Boardwalk Affogato'] },
      { id: 'hot-seasonal', label: 'Hot Seasonal', winterOnly: true, examples: ['Peppermint Mocha', 'Toasted Marshmallow Cocoa Float', 'Caramel Apple Cider'] },
      { id: 'blended-freeze', label: 'Blended Freeze', examples: ['Sand Hollow Freeze', 'Vegas Vice Frappe'] },
    ];
    let slotFlavors = [
      'Coconut Cream + Cherry Lime',
      'Raspberry + Vanilla Cream + Berry Dust',
      'Pineapple soft serve + Mango Purée',
      'Vanilla + Caramel + Sweet Cream',
      'Strawberry Purée + Fresh Lime',
      'Salted Caramel + White Chocolate',
      'Peppermint + Crushed Candy Cane',
    ];
    try {
      const r = await fetch('/kiosk/arcade-menu.json');
      if (r.ok) {
        const schema = await r.json();
        if (schema.slotReels && Array.isArray(schema.slotReels.bases) && schema.slotReels.bases.length) slotBases = schema.slotReels.bases;
        if (schema.slotReels && Array.isArray(schema.slotReels.flavors) && schema.slotReels.flavors.length) slotFlavors = schema.slotReels.flavors;
      }
    } catch {}

    const r1 = $('reel1'), r1Val = $('reel1Val'), r1Sub = $('reel1Sub');
    const r2 = $('reel2'), r2Val = $('reel2Val'), r2Sub = $('reel2Sub');
    const r3 = $('reel3'), r3Val = $('reel3Val'), r3Sub = $('reel3Sub');
    const resultBox = $('resultBox');
    const resultTitle = $('resultTitle');
    const resultDesc = $('resultDesc');
    const claimPill = $('claimPill');
    const claimCodeEl = $('claimCode');
    const winActions = $('winActions');
    const winTwo = $('winTwo');
    const barkerMsg = $('barkerMsg');
    const personaBadge = $('personaBadge');

    function syncPersonaUI() {
      document.querySelectorAll('[data-persona]').forEach((b) => {
        b.classList.toggle('is-on', b.dataset.persona === cfg.personaMode);
      });
      const st = audio.getState();
      if (personaBadge) {
        const who = st.activePersona === 'neon86' ? 'NEON 86 DJ' : 'SHREDDER SURFER';
        personaBadge.textContent = (st.muted ? 'MUTED · ' : '') + who + (st.pgMode ? ' · PG' : '');
      }
    }
    syncPersonaUI();

    /* Persona, volume and mute live on this screen only. Nothing here talks to the server, so it can never carry the odds. */
    function saveLocalCfg() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ personaMode: cfg.personaMode, volume: cfg.volume, muted: cfg.muted })); } catch {}
    }

    document.querySelectorAll('[data-persona]').forEach((b) => {
      b.addEventListener('click', () => {
        audio.startSynthwaveIdle();
        cfg.personaMode = b.dataset.persona;
        audio.setPersonaMode(cfg.personaMode);
        saveLocalCfg();
        syncPersonaUI();
      });
    });

    /* ---------- 3-Reel Slot Spin (the prize comes from the server) ---------- */
    async function askServerForSpin() {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        const r = await fetch('/api/arcade/spin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: ctl.signal });
        const d = await r.json().catch(() => null);
        if (r.ok && d && d.ok === true) return d;
      } catch {}
      finally { clearTimeout(timer); }
      return { ok: true, win: false, thanks: true, prizeId: 'standard' };   // offline or refused: it still plays, with no code
    }

    let spinning = false;
    spinBtn.addEventListener('click', async () => {
      if (spinning) return;
      spinning = true;
      spinBtn.disabled = true;
      audio.startSynthwaveIdle();
      audio.recordSpinForAutoRotate();
      syncPersonaUI();
      claimPill.hidden = true;
      if (winActions) winActions.hidden = true;
      resultBox.classList.remove('is-prize');
      [r1, r2, r3].forEach((el) => { el.classList.remove('is-win'); el.classList.add('is-spinning'); });

      audio.playTrigger('slot_spin');
      const availBases = slotBases.filter((b) => cfg.winterEnabled || !b.winterOnly);
      const finalBase = availBases[Math.floor(Math.random() * availBases.length)];
      const examples = finalBase.examples && finalBase.examples.length ? finalBase.examples : [finalBase.label];
      const finalExample = examples[Math.floor(Math.random() * examples.length)];
      const finalFlavor = slotFlavors[Math.floor(Math.random() * slotFlavors.length)];
      let outcome = null;
      askServerForSpin().then((d) => { outcome = d; });

      // Animated staggered reel stops with mechanical clicks; reel 3 keeps turning until the server has answered
      let tick = 0;
      const ticker = setInterval(() => {
        tick++;
        audio.playReelClick();
        if (tick < 10) {
          const b = availBases[tick % availBases.length];
          r1Val.textContent = b.label.toUpperCase();
        } else if (tick === 10) {
          r1.classList.remove('is-spinning');
          r1Val.textContent = finalBase.label.toUpperCase();
          r1Sub.textContent = finalExample;
        }
        if (tick < 16) {
          r2Val.textContent = slotFlavors[tick % slotFlavors.length].toUpperCase();
        } else if (tick === 16) {
          r2.classList.remove('is-spinning');
          r2Val.textContent = finalFlavor.toUpperCase();
          r2Sub.textContent = '+$1.50 Freeze-Dried Topper Ready';
        }
        if (tick < 22 || !outcome) {
          r3Val.textContent = String(cfg.odds[tick % cfg.odds.length].label || '').toUpperCase();
          return;
        }
        clearInterval(ticker);
        r3.classList.remove('is-spinning');
        audio.playSodaFizz();
        if (outcome.win === true && /^[A-Z2-9]{4}$/.test(String(outcome.code))) {
          const t = outcome.ticket || {};
          const reward = String(outcome.label || t.reward || 'Boardwalk Prize');     // the prize itself (the server's fixed label)
          r3Val.textContent = reward.toUpperCase();
          r3Sub.textContent = 'CODE ' + outcome.code;
          r3.classList.add('is-win');
          resultBox.classList.add('is-prize');
          claimCodeEl.textContent = outcome.code;
          claimPill.hidden = false;
          audio.playArcadeFanfare(outcome.mega === true);
          document.body.classList.remove('is-flash');
          void document.body.offsetWidth;
          document.body.classList.add('is-flash');
          setTimeout(() => document.body.classList.remove('is-flash'), 2100);
          resultTitle.textContent = (outcome.mega === true ? 'MEGA JACKPOT! ' : 'WINNER! ') + reward;
          resultDesc.textContent = (t.drinkName ? t.drinkName + '. ' : '') + `Custom Build: ${finalExample} · ${finalFlavor}. Use it on your order, or show claim code ${outcome.code} at the trailer window!`;
          if (winActions) { winTwo.textContent = 'Using the other screen? Your prize is waiting on the order screen.'; winActions.hidden = false; watchPending(outcome.code); }
          audio.playTrigger(typeof outcome.trigger === 'string' ? outcome.trigger : 'prize_win');
        } else if (outcome.thanks === true) {
          r3Val.textContent = 'THANKS FOR PLAYING';
          r3Sub.textContent = 'ORDER AT THE WINDOW';
          resultTitle.textContent = `YOUR 1986 POUR: ${finalExample}`;
          resultDesc.textContent = `Thanks for playing! ${finalBase.label} with ${finalFlavor}. Add a +$1.50 Freeze-Dried Topper or $4 3D-Printed Neon Charm at the window!`;
          audio.playTrigger('drink_reveal');
        } else {
          r3Val.textContent = 'STANDARD CUSTOM DRINK';
          r3Sub.textContent = 'SHOW AT WINDOW TO ORDER';
          resultTitle.textContent = `YOUR 1986 POUR: ${finalExample}`;
          resultDesc.textContent = `${finalBase.label} with ${finalFlavor}. Add a +$1.50 Freeze-Dried Topper or $4 3D-Printed Neon Charm at the window!`;
          audio.playTrigger('drink_reveal');
        }
        spinning = false;
        spinBtn.disabled = false;
        syncPersonaUI();
      }, 85);
    });

    /* While a win is on screen, follow the kiosk's pending prize: once it is on an order, declined or past its 15 minutes, say so
       (the code itself still works at the window). Read-only: this page never sends a prize anywhere. */
    let pendingTimer = null;
    function watchPending(code) {
      clearInterval(pendingTimer);
      pendingTimer = setInterval(async () => {
        if (!winActions || winActions.hidden) { clearInterval(pendingTimer); return; }
        try {
          const r = await fetch('/api/arcade/pending', { cache: 'no-store' });
          const d = await r.json();
          if (!d || d.pending) return;
          clearInterval(pendingTimer);
          const btn = $('orderNowBtn');
          if (btn) btn.hidden = true;
          winTwo.textContent = 'Your prize is on an order, or the 15 minutes ran out. If you still need it, show code ' + code + ' at the window.';
        } catch (e) { /* offline: leave the button */ }
      }, 8000);
    }

    /* ---------- Voice barker clips (staff demo buttons only; there is no camera and no automatic trigger) ---------- */
    let lastBarkAt = 0;
    async function triggerBarker(kind, bypassCooldown = false) {
      const now = Date.now();
      if (!bypassCooldown && now - lastBarkAt < BARKER_COOLDOWN_MS) return;
      lastBarkAt = now;
      audio.startSynthwaveIdle();
      const trigger = kind === 'dog' ? 'barker_dog_spotted' : 'barker_approach';
      const out = await audio.playTrigger(trigger);
      if (barkerMsg) {
        barkerMsg.textContent = '';
        const b = document.createElement('b');
        b.textContent = kind === 'dog' ? 'Dog Spotted! ' : 'Walk-Up! ';
        barkerMsg.appendChild(b);
        barkerMsg.appendChild(document.createTextNode(kind === 'dog' ? 'Pitching The $1 Menace Cup + $1 Freeze-Dried Dog Treat — “' + ((out && out.text) || '') + '”' : '“' + ((out && out.text) || '') + '”'));
      }
      syncPersonaUI();
    }

    /* ---------- Staff drawer (3-tap top-right corner). Locked until the staff key (STATION_KEY) is typed; every change is sent with it. ---------- */
    const staffCornerBtn = $('staffCornerBtn');
    const staffDlg = $('staffDlg');
    const staffCloseBtn = $('staffCloseBtn');
    const staffLock = $('staffLock');
    const staffKeyInput = $('staffKeyInput');
    const staffUnlockBtn = $('staffUnlockBtn');
    const staffLockMsg = $('staffLockMsg');
    const staffControls = $('staffControls');
    const staffVol = $('staffVol');
    const staffVolLbl = $('staffVolLbl');
    const staffMuteBtn = $('staffMuteBtn');
    const staffPgMode = $('staffPgMode');
    const staffWinterMode = $('staffWinterMode');
    const oddsGrid = $('oddsGrid');
    const oddsTotalLbl = $('oddsTotalLbl');
    const staffSaveMsg = $('staffSaveMsg');
    let staffKey = '';   // in memory only: never stored, cleared whenever the drawer closes

    function lockStaff() {
      staffKey = '';
      if (staffKeyInput) staffKeyInput.value = '';
      if (staffControls) staffControls.hidden = true;
      if (staffLock) staffLock.hidden = false;
      if (staffLockMsg) staffLockMsg.textContent = '';
    }

    async function postStaff(body) {
      try {
        const r = await fetch('/api/arcade-config', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Key': staffKey }, body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        return { status: r.status, ok: r.ok && d && d.ok === true, data: d || {} };
      } catch { return { status: 0, ok: false, data: { error: 'kiosk server not reachable' } }; }
    }

    function renderStaffControls() {
      staffVol.value = String(Math.round(cfg.volume * 100));
      staffVolLbl.textContent = Math.round(cfg.volume * 100) + '%';
      staffMuteBtn.textContent = cfg.muted ? 'Unmute (M)' : 'Mute (M)';
      staffPgMode.checked = cfg.pgMode;
      staffWinterMode.checked = cfg.winterEnabled;
      oddsGrid.innerHTML = oddsGridHTML(cfg.odds);
      updateOddsSum();
    }

    function updateOddsSum() {
      const inputs = [...oddsGrid.querySelectorAll('[data-odd-idx]')];
      const sum = inputs.reduce((s, el) => s + (Number(el.value) || 0), 0);
      oddsTotalLbl.textContent = `Total: ${sum}%`;
      oddsTotalLbl.style.color = sum === 100 ? '#2AF5E4' : '#FF3CAC';
      return sum;
    }
    oddsGrid.addEventListener('input', updateOddsSum);

    let cornerTaps = [];
    if (staffCornerBtn) {
      staffCornerBtn.addEventListener('click', () => {
        const now = Date.now();
        cornerTaps = cornerTaps.filter((t) => now - t < 1200);
        cornerTaps.push(now);
        if (cornerTaps.length >= 3) {
          cornerTaps = [];
          lockStaff();
          if (typeof staffDlg.showModal === 'function') staffDlg.showModal();
          else staffDlg.setAttribute('open', '');
          staffKeyInput.focus();
        }
      });
    }
    function closeStaff() { lockStaff(); if (staffDlg.open) staffDlg.close(); }
    if (staffCloseBtn) staffCloseBtn.addEventListener('click', closeStaff);
    staffDlg.addEventListener('close', lockStaff);

    async function unlockStaff() {
      const typed = staffKeyInput.value.trim();
      if (!typed) { staffLockMsg.textContent = 'Type the staff key.'; return; }
      staffKey = typed;
      staffUnlockBtn.disabled = true;
      const r = await postStaff({ check: true });
      staffUnlockBtn.disabled = false;
      if (r.ok) {
        staffLock.hidden = true;
        staffControls.hidden = false;
        staffKeyInput.value = '';
        staffSaveMsg.textContent = '';
        renderStaffControls();
        return;
      }
      staffKey = '';
      staffLockMsg.textContent = r.status === 401 ? 'Wrong staff key.' : r.status === 429 ? 'Too many tries. Wait a few minutes.' : r.status === 403 ? 'No staff key is set on this kiosk (STATION_KEY in kiosk-config.env).' : 'Could not check the key.';
    }
    staffUnlockBtn.addEventListener('click', unlockStaff);
    staffKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlockStaff(); });

    staffVol.addEventListener('input', () => {
      cfg.volume = Number(staffVol.value) / 100;
      staffVolLbl.textContent = staffVol.value + '%';
      audio.setVolume(cfg.volume);
      saveLocalCfg();
    });
    staffMuteBtn.addEventListener('click', () => {
      cfg.muted = audio.toggleMute();
      staffMuteBtn.textContent = cfg.muted ? 'Unmute (M)' : 'Mute (M)';
      syncPersonaUI();
      saveLocalCfg();
    });

    // PG mode and the winter board are staff-set on the server; they change on this screen only once the server has accepted them.
    async function saveFlag(key, value, el, label) {
      const r = await postStaff({ [key]: value });
      if (r.ok) {
        cfg[key] = value;
        if (key === 'pgMode') audio.setPgMode(value);
        syncPersonaUI();
        staffSaveMsg.textContent = `${label} saved.`;
        staffSaveMsg.style.color = '#2AF5E4';
      } else {
        el.checked = cfg[key];
        staffSaveMsg.textContent = (r.data && r.data.error) || 'Not saved.';
        staffSaveMsg.style.color = '#FF3CAC';
        if (r.status === 401) lockStaff();
      }
    }
    staffPgMode.addEventListener('change', () => saveFlag('pgMode', staffPgMode.checked, staffPgMode, 'PG mode'));
    staffWinterMode.addEventListener('change', () => saveFlag('winterEnabled', staffWinterMode.checked, staffWinterMode, 'Winter board'));

    $('demoApproachBtn').addEventListener('click', () => triggerBarker('approach', true));
    $('demoDogBtn').addEventListener('click', () => triggerBarker('dog', true));
    $('resetOddsBtn').addEventListener('click', () => {
      cfg.odds = DEFAULT_ODDS.map((o) => ({ ...o }));
      renderStaffControls();
      staffSaveMsg.textContent = 'Defaults restored (81/6/5/4/3/1). Click Save Odds to apply.';
      staffSaveMsg.style.color = '#2AF5E4';
    });
    // Audio defaults only: persona, volume, mute. This button never sends the odds.
    $('saveAudioBtn').addEventListener('click', async () => {
      const r = await postStaff({ personaMode: cfg.personaMode, volume: cfg.volume, muted: cfg.muted });
      staffSaveMsg.textContent = r.ok ? 'Audio defaults saved.' : ((r.data && r.data.error) || 'Not saved.');
      staffSaveMsg.style.color = r.ok ? '#2AF5E4' : '#FF3CAC';
      if (r.status === 401) lockStaff();
    });
    // Odds only: the one place the odds are sent.
    $('saveOddsBtn').addEventListener('click', async () => {
      const inputs = [...oddsGrid.querySelectorAll('[data-odd-idx]')];
      const odds = inputs.map((el) => ({ id: cfg.odds[Number(el.dataset.oddIdx)].id, pct: Number(el.value) }));
      const sum = odds.reduce((a, o) => a + (Number.isFinite(o.pct) ? o.pct : 0), 0);
      const bad = odds.some((o) => !Number.isFinite(o.pct) || o.pct < 0 || o.pct > 100);
      const jackpot = odds.find((o) => o.id === 'free_drink_jackpot');
      let msg = '';
      if (bad) msg = 'Each number must be 0 to 100.';
      else if (sum !== 100) msg = `Odds must sum to 100% (currently ${sum}%).`;
      else if (jackpot && jackpot.pct > MAX_FREE_DRINK_PCT) msg = `Free drink odds cannot be more than ${MAX_FREE_DRINK_PCT}%.`;
      if (msg) { staffSaveMsg.textContent = msg; staffSaveMsg.style.color = '#FF3CAC'; return; }
      const r = await postStaff({ odds });
      if (r.ok && r.data.config && Array.isArray(r.data.config.odds)) {
        cfg.odds = r.data.config.odds;
        renderStaffControls();
        staffSaveMsg.textContent = 'Saved! New prize odds are active for the next spin.';
        staffSaveMsg.style.color = '#2AF5E4';
      } else {
        staffSaveMsg.textContent = (r.data && r.data.error) || 'Not saved.';
        staffSaveMsg.style.color = '#FF3CAC';
        if (r.status === 401) lockStaff();
      }
    });

    // Global keyboard shortcut: 'M' toggles Mute on this screen (unless typing inside an input)
    document.addEventListener('keydown', (e) => {
      if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.key === 'm' || e.key === 'M') {
        cfg.muted = audio.toggleMute();
        syncPersonaUI();
        saveLocalCfg();
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
