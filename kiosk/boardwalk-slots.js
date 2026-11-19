/* Thirsty Beaches — 1986 Boardwalk Arcade Slot Machine + Camera Presence/Dog Barker
   Zero video recording/storage. Configurable Staff Odds (81/6/5/4/3/1 default),
   3-tap top-right corner gesture + 'M' mute shortcut, opt-in "Scan My Vibe" -> /api/vibe. */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'tb_boardwalk_arcade_cfg_v1';
  const BARKER_COOLDOWN_MS = 45000;

  const DEFAULT_ODDS = [
    { id: 'standard', label: 'Standard Custom Drink', pct: 81, isPrize: false, trigger: 'drink_reveal' },
    { id: 'size_upgrade', label: 'Free Size Upgrade', pct: 6, isPrize: true, trigger: 'prize_win' },
    { id: 'soft_serve_topper', label: 'Free Dole Whip or Vanilla Soft Serve Topper', pct: 5, isPrize: true, trigger: 'prize_win' },
    { id: 'neon_charm', label: 'Free 3D-Printed Neon Straw Charm', pct: 4, isPrize: true, trigger: 'arcade_charm_win' },
    { id: 'topper_or_sticker', label: 'Free Freeze-Dried Topper or UV-DTF Sticker', pct: 3, isPrize: true, trigger: 'prize_win' },
    { id: 'free_drink_jackpot', label: 'FREE DRINK JACKPOT!', pct: 1, isPrize: true, trigger: 'mega_jackpot' },
  ];

  function rollWeightedPrize(odds, rng = Math.random) {
    const list = Array.isArray(odds) && odds.length ? odds : DEFAULT_ODDS;
    const total = list.reduce((s, o) => s + Math.max(0, Number(o.pct) || 0), 0);
    if (total <= 0) return list[0];
    let target = rng() * total;
    for (const item of list) {
      target -= Math.max(0, Number(item.pct) || 0);
      if (target <= 0) return item;
    }
    return list[list.length - 1];
  }

  function generate4DigitCode(rng = Math.random) {
    return String(Math.floor(1000 + rng() * 9000));
  }

  // Export pure helpers for unit testing
  const exportsObj = { DEFAULT_ODDS, BARKER_COOLDOWN_MS, rollWeightedPrize, generate4DigitCode };
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
    let cfg = {
      personaMode: 'auto',
      volume: 0.75,
      muted: false,
      pgMode: true,
      winterEnabled: true,
      odds: DEFAULT_ODDS.map((o) => ({ ...o })),
    };

    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        cfg = { ...cfg, ...saved, odds: Array.isArray(saved.odds) && saved.odds.length === DEFAULT_ODDS.length ? saved.odds : cfg.odds };
      }
    } catch {}

    // Also pull Kiosk PC server config if running locally on work/kiosk-pay
    try {
      const r = await fetch('/api/arcade-config');
      if (r.ok) {
        const remote = await r.json();
        if (remote && remote.config) {
          cfg = { ...cfg, ...remote.config };
        }
      }
    } catch {}

    audio.setPersonaMode(cfg.personaMode);
    audio.setVolume(cfg.volume);
    audio.setMuted(cfg.muted);
    audio.setPgMode(cfg.pgMode);

    // Load live menu inventory for Reels 1 & 2
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
      'Pineapple Dole Whip + Mango Purée',
      'Vanilla + Caramel + Sweet Cream',
      'Strawberry Purée + Fresh Lime',
      'Salted Caramel + White Chocolate',
      'Peppermint + Crushed Candy Cane',
    ];

    for (const url of ['/menu-schema.json', '/kiosk/arcade-menu.json']) {
      try {
        const r = await fetch(url);
        if (r.ok) {
          const schema = await r.json();
          if (schema.slotReels && Array.isArray(schema.slotReels.bases)) slotBases = schema.slotReels.bases;
          if (schema.slotReels && Array.isArray(schema.slotReels.flavors)) slotFlavors = schema.slotReels.flavors;
          break;
        }
      } catch {}
    }

    const r1 = document.getElementById('reel1'), r1Val = document.getElementById('reel1Val'), r1Sub = document.getElementById('reel1Sub');
    const r2 = document.getElementById('reel2'), r2Val = document.getElementById('reel2Val'), r2Sub = document.getElementById('reel2Sub');
    const r3 = document.getElementById('reel3'), r3Val = document.getElementById('reel3Val'), r3Sub = document.getElementById('reel3Sub');
    const resultBox = document.getElementById('resultBox');
    const resultTitle = document.getElementById('resultTitle');
    const resultDesc = document.getElementById('resultDesc');
    const claimPill = document.getElementById('claimPill');
    const claimCodeEl = document.getElementById('claimCode');
    const barkerMsg = document.getElementById('barkerMsg');
    const personaBadge = document.getElementById('personaBadge');

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

    document.querySelectorAll('[data-persona]').forEach((b) => {
      b.addEventListener('click', () => {
        audio.startSynthwaveIdle();
        cfg.personaMode = b.dataset.persona;
        audio.setPersonaMode(cfg.personaMode);
        saveLocalCfg();
        syncPersonaUI();
      });
    });

    function saveLocalCfg() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch {}
      fetch('/api/arcade-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cfg),
      }).catch(() => {});
    }

    /* ---------- 3-Reel Slot Spin ---------- */
    let spinning = false;
    spinBtn.addEventListener('click', async () => {
      if (spinning) return;
      spinning = true;
      spinBtn.disabled = true;
      audio.startSynthwaveIdle();
      audio.recordSpinForAutoRotate();
      syncPersonaUI();
      claimPill.hidden = true;
      resultBox.classList.remove('is-prize');
      [r1, r2, r3].forEach((el) => { el.classList.remove('is-win'); el.classList.add('is-spinning'); });

      audio.playTrigger('slot_spin');
      const availBases = slotBases.filter((b) => cfg.winterEnabled || !b.winterOnly);
      const finalBase = availBases[Math.floor(Math.random() * availBases.length)];
      const finalExample = (finalBase.examples || [finalBase.label])[Math.floor(Math.random() * (finalBase.examples || [finalBase.label]).length)];
      const finalFlavor = slotFlavors[Math.floor(Math.random() * slotFlavors.length)];
      const finalPrize = rollWeightedPrize(cfg.odds);

      // Animated staggered reel stops with mechanical clicks
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
        if (tick < 22) {
          r3Val.textContent = cfg.odds[tick % cfg.odds.length].label.toUpperCase();
        } else {
          clearInterval(ticker);
          r3.classList.remove('is-spinning');
          r3Val.textContent = finalPrize.label.toUpperCase();
          r3Sub.textContent = finalPrize.isPrize ? 'INSTANT BOARDWALK WIN!' : 'SHOW AT WINDOW TO ORDER';

          audio.playSodaFizz();
          if (finalPrize.isPrize) {
            const code = generate4DigitCode();
            r3.classList.add('is-win');
            resultBox.classList.add('is-prize');
            claimCodeEl.textContent = code;
            claimPill.hidden = false;
            const isMega = finalPrize.id === 'free_drink_jackpot';
            audio.playArcadeFanfare(isMega);
            document.body.classList.remove('is-flash');
            void document.body.offsetWidth;
            document.body.classList.add('is-flash');
            setTimeout(() => document.body.classList.remove('is-flash'), 2100);
            resultTitle.textContent = (isMega ? 'MEGA JACKPOT! ' : 'WINNER! ') + finalPrize.label;
            resultDesc.textContent = `Custom Build: ${finalExample} · ${finalFlavor}. Flash claim code ${code} at the trailer window!`;
            audio.playTrigger(finalPrize.trigger || 'prize_win');
          } else {
            resultTitle.textContent = `YOUR 1986 POUR: ${finalExample}`;
            resultDesc.textContent = `${finalBase.label} with ${finalFlavor}. Add a +$1.50 Freeze-Dried Topper or $4 3D-Printed Neon Charm at the window!`;
            audio.playTrigger('drink_reveal');
          }
          spinning = false;
          spinBtn.disabled = false;
          syncPersonaUI();
        }
      }, 85);
    });

    /* ---------- Local Camera Presence & Dog-Spotted Barker (Zero Storage, 45s Cooldown) ---------- */
    const camToggleBtn = document.getElementById('camToggleBtn');
    const camVideo = document.getElementById('camVideo');
    const scanVibeBtn = document.getElementById('scanVibeBtn');
    let camStream = null;
    let camTimer = null;
    let prevFrame = null;
    let lastBarkAt = 0;

    async function triggerBarker(kind, bypassCooldown = false) {
      const now = Date.now();
      if (!bypassCooldown && now - lastBarkAt < BARKER_COOLDOWN_MS) return;
      lastBarkAt = now;
      audio.startSynthwaveIdle();
      const trigger = kind === 'dog' ? 'barker_dog_spotted' : 'barker_approach';
      const out = await audio.playTrigger(trigger);
      if (barkerMsg) {
        barkerMsg.innerHTML = kind === 'dog'
          ? `<b>Dog Spotted!</b> Pitching The $1 Menace Cup + $1 Freeze-Dried Dog Treat — “${out.text || ''}”`
          : `<b>Walk-Up Detected!</b> “${out.text || ''}”`;
      }
      syncPersonaUI();
    }

    async function ensureCamera() {
      if (camStream) return true;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
      try {
        camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: 'user' }, audio: false });
        camVideo.srcObject = camStream;
        await camVideo.play();
        return true;
      } catch {
        return false;
      }
    }

    function stopCamera() {
      if (camTimer) { clearInterval(camTimer); camTimer = null; }
      if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
      prevFrame = null;
      if (camToggleBtn) camToggleBtn.textContent = 'Enable Presence Cam';
    }

    if (camToggleBtn) {
      camToggleBtn.addEventListener('click', async () => {
        if (camStream) { stopCamera(); return; }
        const ok = await ensureCamera();
        if (!ok) {
          if (barkerMsg) barkerMsg.innerHTML = '<b>Camera unavailable:</b> Use Staff Drawer demo buttons or tap Spin anytime.';
          return;
        }
        camToggleBtn.textContent = 'Presence Cam: ON';
        const c = document.createElement('canvas'); c.width = 96; c.height = 72;
        const g = c.getContext('2d', { willReadFrequently: true });
        camTimer = setInterval(() => {
          if (!camVideo || camVideo.readyState < 2) return;
          g.drawImage(camVideo, 0, 0, 96, 72);
          const data = g.getImageData(0, 0, 96, 72).data;
          if (prevFrame) {
            let upperDiff = 0, lowerDiff = 0;
            for (let y = 0; y < 72; y++) {
              for (let x = 0; x < 96; x++) {
                const idx = (y * 96 + x) * 4;
                const d = Math.abs(data[idx] - prevFrame[idx]) + Math.abs(data[idx + 1] - prevFrame[idx + 1]) + Math.abs(data[idx + 2] - prevFrame[idx + 2]);
                if (d > 75) {
                  if (y < 42) upperDiff++; else lowerDiff++;
                }
              }
            }
            // Lower-frame localized motion with minimal upper torso motion -> likely dog at window
            if (lowerDiff > 110 && upperDiff < 55) triggerBarker('dog');
            else if (upperDiff + lowerDiff > 190) triggerBarker('approach');
          }
          prevFrame = new Uint8ClampedArray(data);
        }, 1200);
      });
    }

    /* ---------- Opt-In "Scan My Vibe" (Single Frame -> /api/vibe gemini-3.1-flash-lite) ---------- */
    if (scanVibeBtn) {
      scanVibeBtn.addEventListener('click', async () => {
        audio.startSynthwaveIdle();
        scanVibeBtn.disabled = true;
        const oldTxt = scanVibeBtn.textContent;
        scanVibeBtn.textContent = 'SCANNING VIBE…';
        try {
          let imageBase64 = '';
          const hasCam = await ensureCamera();
          if (hasCam && camVideo.readyState >= 2) {
            const snap = document.createElement('canvas');
            snap.width = 320; snap.height = 240;
            snap.getContext('2d').drawImage(camVideo, 0, 0, 320, 240);
            imageBase64 = snap.toDataURL('image/jpeg', 0.72);
          }
          const res = await fetch('/api/vibe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode: 'scan-my-vibe',
              mood: '1986 boardwalk energy',
              imageBase64: imageBase64 || undefined,
            }),
          });
          const data = await res.json().catch(() => null);
          if (res.status === 429) {
            resultTitle.textContent = 'Vibe Scanner Cooling Down';
            resultDesc.textContent = (data && data.error) || 'Too many scans this hour — spin the 80s Drink Slot Machine instead!';
          } else if (data && (data.drink || data.name)) {
            const name = data.drink || data.name;
            const note = data.reason || data.blurb || data.vibe || 'Prescribed straight from our 1986 Neon Beach menu!';
            r1Val.textContent = 'VIBE PRESCRIPTION';
            r2Val.textContent = String(name).toUpperCase().slice(0, 28);
            r3Val.textContent = 'GEMINI VISION MATCH';
            resultTitle.textContent = `SCAN MY VIBE: ${name}`;
            resultDesc.textContent = note;
            audio.playSodaFizz();
            audio.playTrigger('drink_reveal', `Vibe locked in! We prescribe the ${name}. ${note}`);
          } else {
            resultTitle.textContent = 'Vibe Match: Neon Sunset Float';
            resultDesc.textContent = 'Dirty soda over chewable nugget ice crowned with pineapple Dole Whip!';
          }
        } catch {
          resultTitle.textContent = 'Vibe Match: Miami Vice Swirl';
          resultDesc.textContent = 'Pineapple Dole Whip twisted with rotating seasonal fruit whip — grab one at the window!';
        } finally {
          scanVibeBtn.disabled = false;
          scanVibeBtn.textContent = oldTxt;
        }
      });
    }

    /* ---------- Staff Audio & Prize Odds Drawer (3-Tap Top-Right Corner + 'M' Shortcut) ---------- */
    const staffCornerBtn = document.getElementById('staffCornerBtn');
    const staffDlg = document.getElementById('staffDlg');
    const staffCloseBtn = document.getElementById('staffCloseBtn');
    const staffVol = document.getElementById('staffVol');
    const staffVolLbl = document.getElementById('staffVolLbl');
    const staffMuteBtn = document.getElementById('staffMuteBtn');
    const staffPgMode = document.getElementById('staffPgMode');
    const staffWinterMode = document.getElementById('staffWinterMode');
    const oddsGrid = document.getElementById('oddsGrid');
    const oddsTotalLbl = document.getElementById('oddsTotalLbl');
    const staffSaveMsg = document.getElementById('staffSaveMsg');

    function renderStaffControls() {
      staffVol.value = String(Math.round(cfg.volume * 100));
      staffVolLbl.textContent = Math.round(cfg.volume * 100) + '%';
      staffMuteBtn.textContent = cfg.muted ? 'Unmute (M)' : 'Mute (M)';
      staffPgMode.checked = cfg.pgMode;
      staffWinterMode.checked = cfg.winterEnabled;
      oddsGrid.innerHTML = cfg.odds.map((o, idx) => `
        <label class="odds-item">
          <span>${o.label}</span>
          <span><input type="number" min="0" max="100" step="1" data-odd-idx="${idx}" value="${o.pct}"> %</span>
        </label>`).join('');
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
          renderStaffControls();
          if (typeof staffDlg.showModal === 'function') staffDlg.showModal();
          else staffDlg.setAttribute('open', '');
        }
      });
    }
    if (staffCloseBtn) staffCloseBtn.addEventListener('click', () => staffDlg.close());

    staffVol.addEventListener('input', () => {
      cfg.volume = Number(staffVol.value) / 100;
      staffVolLbl.textContent = staffVol.value + '%';
      audio.setVolume(cfg.volume);
    });
    staffMuteBtn.addEventListener('click', () => {
      cfg.muted = audio.toggleMute();
      staffMuteBtn.textContent = cfg.muted ? 'Unmute (M)' : 'Mute (M)';
      syncPersonaUI();
      saveLocalCfg();
    });
    staffPgMode.addEventListener('change', () => {
      cfg.pgMode = staffPgMode.checked;
      audio.setPgMode(cfg.pgMode);
      syncPersonaUI();
    });
    staffWinterMode.addEventListener('change', () => {
      cfg.winterEnabled = staffWinterMode.checked;
      try { localStorage.setItem('tb_winter_board_enabled', cfg.winterEnabled ? '1' : '0'); } catch {}
    });

    document.getElementById('demoApproachBtn').addEventListener('click', () => triggerBarker('approach', true));
    document.getElementById('demoDogBtn').addEventListener('click', () => triggerBarker('dog', true));
    document.getElementById('resetOddsBtn').addEventListener('click', () => {
      cfg.odds = DEFAULT_ODDS.map((o) => ({ ...o }));
      renderStaffControls();
      staffSaveMsg.textContent = 'Defaults restored (81/6/5/4/3/1). Click Save to apply.';
    });
    document.getElementById('saveOddsBtn').addEventListener('click', () => {
      const sum = updateOddsSum();
      if (sum !== 100) {
        staffSaveMsg.textContent = `Odds must sum to 100% (currently ${sum}%).`;
        staffSaveMsg.style.color = '#FF3CAC';
        return;
      }
      oddsGrid.querySelectorAll('[data-odd-idx]').forEach((el) => {
        cfg.odds[Number(el.dataset.oddIdx)].pct = Math.max(0, Math.min(100, Number(el.value) || 0));
      });
      saveLocalCfg();
      staffSaveMsg.textContent = 'Saved! Prize odds & audio settings active immediately.';
      staffSaveMsg.style.color = '#2AF5E4';
      syncPersonaUI();
    });

    // Global keyboard shortcut: 'M' toggles Mute (unless typing inside an input)
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
