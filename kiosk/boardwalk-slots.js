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

  /* One arcade visit on the kiosk's own screen (kiosk/arcade-session.json). Anything missing, wrong or out of range falls back to a sane default,
     so a bad edit can never leave the arcade without a way back or without a limit. */
  const SESSION_DEFAULTS = { enabled: true, maxSpins: 3, maxSeconds: 90, idleSeconds: 60, idleWarnSeconds: 20, endedReturnSeconds: 30 };
  function sessionLimits(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : d; };
    const idleSeconds = num(src.idleSeconds, 15, 300, SESSION_DEFAULTS.idleSeconds);
    return {
      enabled: src.enabled !== false,
      maxSpins: num(src.maxSpins, 1, 20, SESSION_DEFAULTS.maxSpins),
      maxSeconds: num(src.maxSeconds, 20, 900, SESSION_DEFAULTS.maxSeconds),
      idleSeconds,
      idleWarnSeconds: Math.min(num(src.idleWarnSeconds, 5, 120, SESSION_DEFAULTS.idleWarnSeconds), idleSeconds - 5),
      endedReturnSeconds: num(src.endedReturnSeconds, 10, 180, SESSION_DEFAULTS.endedReturnSeconds),
    };
  }

  // Export pure helpers for unit testing
  const exportsObj = { DEFAULT_ODDS, BARKER_COOLDOWN_MS, MAX_FREE_DRINK_PCT, SESSION_DEFAULTS, sessionLimits, esc, oddsGridHTML };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportsObj;
    return;
  }
  root.TBBoardwalkSlots = exportsObj;

  if (typeof document === 'undefined') return;

  async function init() {
    const spinBtn = document.getElementById('spinBtn');
    if (!spinBtn) return;

    /* The audio bank is optional: if it did not load (or throws), the arcade plays silently and the session limit and the way back still work. */
    const SILENT = { getState: () => ({ muted: true, pgMode: true, activePersona: 'shredder' }), toggleMute: () => true, playTrigger: () => Promise.resolve({ text: '' }) };
    let audio = SILENT;
    try { if (window.TBAudioBank) audio = window.TBAudioBank.createAudioBank({ basePath: '/kiosk/audio/', pgMode: true }); } catch {}
    ['setPersonaMode', 'setVolume', 'setMuted', 'setPgMode', 'startSynthwaveIdle', 'stopSynthwaveIdle', 'stopAll', 'playReelClick', 'playSodaFizz', 'playArcadeFanfare', 'recordSpinForAutoRotate'].forEach((m) => { if (typeof audio[m] !== 'function') audio[m] = () => {}; });
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

    /* This visit's limits (kiosk/arcade-session.json); defaults when the file is missing or unreadable */
    let limits = sessionLimits(null);
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 3000);
      try {
        const r = await fetch('/kiosk/arcade-session.json', { cache: 'no-store', signal: ctl.signal });
        if (r.ok) limits = sessionLimits(await r.json());
      } finally { clearTimeout(timer); }
    } catch {}

    const r1 = $('reel1'), r1Val = $('reel1Val'), r1Sub = $('reel1Sub');
    const r2 = $('reel2'), r2Val = $('reel2Val'), r2Sub = $('reel2Sub');
    const r3 = $('reel3'), r3Val = $('reel3Val'), r3Sub = $('reel3Sub');
    const r1Prev = $('reel1Prev'), r1Next = $('reel1Next'), r1Icon = $('reel1Icon');
    const r2Prev = $('reel2Prev'), r2Next = $('reel2Next'), r2Icon = $('reel2Icon');
    const r3Prev = $('reel3Prev'), r3Next = $('reel3Next'), r3Icon = $('reel3Icon');
    const leverBtn = $('leverBtn');
    const fxCanvas = $('fxCanvas');

    /* ---------- Celebration Particle Burst Engine (Neon Coins, Stars & Soda Fizz) ---------- */
    let fxParticles = [];
    let fxRaf = 0;
    function runFxLoop() {
      if (!fxCanvas) return;
      const ctx = fxCanvas.getContext('2d');
      if (!ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth, h = window.innerHeight;
      if (fxCanvas.width !== Math.round(w * dpr) || fxCanvas.height !== Math.round(h * dpr)) {
        fxCanvas.width = Math.round(w * dpr);
        fxCanvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const alive = [];
      for (const p of fxParticles) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += p.g;
        p.vx *= 0.99;
        p.rot += p.vr;
        p.life -= p.decay;
        if (p.life <= 0 || p.y > h + 40) continue;
        alive.push(p);
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        if (p.kind === 'coin') {
          const sx = Math.cos(p.rot * 2.2);
          ctx.scale(Math.max(0.22, Math.abs(sx)), 1);
          ctx.beginPath();
          ctx.arc(0, 0, p.r, 0, Math.PI * 2);
          ctx.fillStyle = '#FFD166';
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#FF7A45';
          ctx.stroke();
        } else if (p.kind === 'star') {
          ctx.beginPath();
          for (let i = 0; i < 5; i++) {
            const a = (i * 4 * Math.PI) / 5 - Math.PI / 2;
            const x = Math.cos(a) * p.r, y = Math.sin(a) * p.r;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.closePath();
          ctx.fillStyle = p.color;
          ctx.fill();
        } else {
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.r, -p.r * 0.55, p.r * 2, p.r * 1.1);
        }
        ctx.restore();
      }
      fxParticles = alive;
      if (fxParticles.length) fxRaf = requestAnimationFrame(runFxLoop);
      else {
        ctx.clearRect(0, 0, w, h);
        fxRaf = 0;
        // Free the full-screen bitmap while idle (the kiosk runs for hours); the next loop run re-sizes it before drawing.
        fxCanvas.width = 0;
        fxCanvas.height = 0;
      }
    }

    function launchBurst(mode) {
      if (!fxCanvas || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
      const w = window.innerWidth, h = window.innerHeight;
      const cx = w * 0.5, cy = h * 0.42;
      const count = mode === 'mega' ? 130 : mode === 'win' ? 68 : 22;
      const colors = ['#FF3CAC', '#2AF5E4', '#FFD166', '#FF7A45', '#FFF4FA'];
      for (let i = 0; i < count; i++) {
        const ang = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
        const spd = (mode === 'fizz' ? 2.5 : 4.5) + Math.random() * (mode === 'mega' ? 11 : mode === 'win' ? 8 : 4);
        const kind = mode === 'fizz' ? 'star' : (i % 3 === 0 ? 'coin' : i % 3 === 1 ? 'star' : 'confetti');
        fxParticles.push({
          x: cx + (Math.random() - 0.5) * (mode === 'fizz' ? 260 : 120),
          y: cy + (Math.random() - 0.5) * 40,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - (mode === 'fizz' ? 3 : 5.5),
          g: mode === 'fizz' ? 0.14 : 0.24,
          r: kind === 'coin' ? 7 + Math.random() * 4 : 5 + Math.random() * 5,
          rot: Math.random() * Math.PI * 2,
          vr: (Math.random() - 0.5) * 0.24,
          life: 1,
          decay: mode === 'mega' ? 0.011 : mode === 'win' ? 0.014 : 0.025,
          color: colors[i % colors.length],
          kind,
        });
      }
      if (!fxRaf) fxRaf = requestAnimationFrame(runFxLoop);
    }

    // Retro 1980s Neon Beach Slot Machine SVG Sprite icon switcher (zero innerHTML)
    const setIcon = (useEl, key) => { if (useEl) useEl.setAttribute('href', '#ico-' + key); };
    const iconForBase = (id) => ({ 'dirty-soda': 'soda', 'energy-mixer': 'energy', 'coffee-espresso': 'coffee', 'hot-seasonal': 'hot', 'blended-freeze': 'freeze' }[id] || 'soda');
    const iconForFlavor = (txt) => (/pineapple|mango|swirl/i.test(txt) ? 'pineapple' : /peppermint|cocoa|caramel/i.test(txt) ? 'hot' : 'palm');
    const iconForPrize = (p) => (!p || !p.isPrize ? 'soda' : p.id === 'free_drink_jackpot' ? 'jackpot' : p.id === 'neon_charm' ? 'charm' : 'prize');
    setIcon(r1Icon, 'soda');
    setIcon(r2Icon, 'palm');
    setIcon(r3Icon, 'jackpot');
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

    /* ---------- One visit: spin and time limits, the way back, and the idle return ----------
       The arcade now lives on the kiosk's own screen, so one person must not hold it while others wait. After maxSpins spins or maxSeconds
       (whichever comes first, a spin in progress always finishes) the reels stop and the page says thanks and points at "Order drinks".
       A hands-off page returns to the ordering screen by itself, so an abandoned arcade can never sit there. The pending prize lives on the
       kiosk server for 15 minutes, so none of this loses a win: it shows on the order screen. The prize caps are the Worker's, not here. */
    const session = { startedAt: Date.now(), spins: 0, ended: false, endAfterSpin: false };
    let lastTouch = Date.now(), leaving = false;
    const spinsLeftEl = $('spinsLeft'), hudEl = $('sessionHud'), endEl = $('sessionEnd'), idleWarnEl = $('idleWarn');

    function renderSession() {
      document.body.dataset.session = session.ended ? 'ended' : 'playing';
      document.body.dataset.spins = String(session.spins);
      if (spinsLeftEl) spinsLeftEl.textContent = String(Math.max(0, limits.maxSpins - session.spins));
      if (hudEl) hudEl.hidden = !limits.enabled || session.ended;
    }
    function leaveArcade(url) {
      if (leaving) return;
      leaving = true;
      try { audio.stopAll(); } catch {}
      location.replace(url);
    }
    function endSession() {
      if (session.ended || !limits.enabled) return;
      session.ended = true;
      lastTouch = Date.now();                // the thanks screen always gets its full hands-off window (endedReturnSeconds) to be read
      spinBtn.hidden = true;
      if (leverBtn) {
        leverBtn.disabled = true;
        const mount = $('leverMount');
        if (mount) mount.hidden = true;     // no dead lever beside "Thanks for playing"
      }
      if (endEl) endEl.hidden = false;
      if (idleWarnEl) idleWarnEl.hidden = true;
      try { audio.stopAll(); } catch {}      // the music and any voice line stop with the game
      renderSession();
      if (endEl && endEl.scrollIntoView) { try { endEl.scrollIntoView({ block: 'nearest' }); } catch {} }
    }
    function touched() {
      lastTouch = Date.now();
      if (idleWarnEl) idleWarnEl.hidden = true;
    }
    ['pointerdown', 'touchstart', 'keydown'].forEach((ev) => document.addEventListener(ev, touched, { passive: true, capture: true }));
    renderSession();

    // Kiosk idle restarts wait for customer activity; an arcade page that is open is customer activity, for as long as it stays open (it is bounded by the idle return).
    const ping = () => { try { fetch('/api/arcade/ping', { cache: 'no-store' }).catch(() => {}); } catch {} };
    ping();
    setInterval(ping, 20000);

    if (limits.enabled) {
      setInterval(() => {
        if (leaving) return;
        const now = Date.now();
        if (!session.ended && now - session.startedAt >= limits.maxSeconds * 1000) {
          if (spinning) session.endAfterSpin = true; else endSession();
        }
        if (spinning) return;                                       // never walk away mid-spin
        const idleLimit = (session.ended ? Math.min(limits.idleSeconds, limits.endedReturnSeconds) : limits.idleSeconds) * 1000;
        const idleFor = now - lastTouch;
        if (idleFor >= idleLimit) { leaveArcade('/'); return; }     // nobody here: the attract screen
        if (idleWarnEl && !session.ended) idleWarnEl.hidden = idleFor < idleLimit - limits.idleWarnSeconds * 1000;
      }, 1000);
    }
    window.addEventListener('pagehide', () => { try { audio.stopAll(); } catch {} });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { try { audio.stopAll(); } catch {} } });

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
    async function triggerSpin() {
      if (spinning || session.ended) return;
      spinning = true;
      session.spins++;
      renderSession();
      spinBtn.disabled = true;
      if (leverBtn) {
        leverBtn.classList.add('is-pulled');
        setTimeout(() => leverBtn.classList.remove('is-pulled'), 340);
      }
      audio.startSynthwaveIdle();
      audio.recordSpinForAutoRotate();
      syncPersonaUI();
      claimPill.hidden = true;
      if (winActions) winActions.hidden = true;
      resultBox.classList.remove('is-prize');
      [r1, r2, r3].forEach((el) => { el.classList.remove('is-win', 'is-locked'); el.classList.add('is-spinning'); });

      audio.playTrigger('slot_spin');
      const availBases = slotBases.filter((b) => cfg.winterEnabled || !b.winterOnly);
      const finalBaseIdx = Math.floor(Math.random() * availBases.length);
      const finalBase = availBases[finalBaseIdx];
      const examples = finalBase.examples && finalBase.examples.length ? finalBase.examples : [finalBase.label];
      const finalExample = examples[Math.floor(Math.random() * examples.length)];
      const finalFlavorIdx = Math.floor(Math.random() * slotFlavors.length);
      const finalFlavor = slotFlavors[finalFlavorIdx];
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
          setIcon(r1Icon, iconForBase(b.id));
          if (r1Prev) r1Prev.textContent = availBases[(tick + availBases.length - 1) % availBases.length].label.toUpperCase();
          if (r1Next) r1Next.textContent = availBases[(tick + 1) % availBases.length].label.toUpperCase();
        } else if (tick === 10) {
          r1.classList.remove('is-spinning'); r1.classList.add('is-locked');
          r1Val.textContent = finalBase.label.toUpperCase();
          setIcon(r1Icon, iconForBase(finalBase.id));
          if (r1Prev) r1Prev.textContent = availBases[(finalBaseIdx + availBases.length - 1) % availBases.length].label.toUpperCase();
          if (r1Next) r1Next.textContent = availBases[(finalBaseIdx + 1) % availBases.length].label.toUpperCase();
          r1Sub.textContent = finalExample;
        }
        if (tick < 16) {
          const fl = slotFlavors[tick % slotFlavors.length];
          r2Val.textContent = fl.toUpperCase();
          setIcon(r2Icon, iconForFlavor(fl));
          if (r2Prev) r2Prev.textContent = slotFlavors[(tick + slotFlavors.length - 1) % slotFlavors.length].toUpperCase();
          if (r2Next) r2Next.textContent = slotFlavors[(tick + 1) % slotFlavors.length].toUpperCase();
        } else if (tick === 16) {
          r2.classList.remove('is-spinning'); r2.classList.add('is-locked');
          r2Val.textContent = finalFlavor.toUpperCase();
          setIcon(r2Icon, iconForFlavor(finalFlavor));
          if (r2Prev) r2Prev.textContent = slotFlavors[(finalFlavorIdx + slotFlavors.length - 1) % slotFlavors.length].toUpperCase();
          if (r2Next) r2Next.textContent = slotFlavors[(finalFlavorIdx + 1) % slotFlavors.length].toUpperCase();
          r2Sub.textContent = '+$1.50 Freeze-Dried Topper Ready';
        }
        if (tick < 22 || !outcome) {
          const pr = cfg.odds[tick % cfg.odds.length];
          r3Val.textContent = String(pr.label || '').toUpperCase();
          setIcon(r3Icon, iconForPrize(pr));
          if (r3Prev) r3Prev.textContent = String(cfg.odds[(tick + cfg.odds.length - 1) % cfg.odds.length].label || '').toUpperCase();
          if (r3Next) r3Next.textContent = String(cfg.odds[(tick + 1) % cfg.odds.length].label || '').toUpperCase();
          return;
        }
        clearInterval(ticker);
        r3.classList.remove('is-spinning'); r3.classList.add('is-locked');
        audio.playSodaFizz();
        if (outcome.win === true && /^[A-Z2-9]{4}$/.test(String(outcome.code))) {
          const t = outcome.ticket || {};
          const reward = String(outcome.label || t.reward || 'Boardwalk Prize');     // the prize itself (the server's fixed label)
          r3Val.textContent = reward.toUpperCase();
          setIcon(r3Icon, outcome.mega === true ? 'jackpot' : 'prize');
          r3Sub.textContent = 'CODE ' + outcome.code;
          r3.classList.add('is-win');
          resultBox.classList.add('is-prize');
          claimCodeEl.textContent = outcome.code;
          claimPill.hidden = false;
          audio.playArcadeFanfare(outcome.mega === true);
          launchBurst(outcome.mega === true ? 'mega' : 'win');
          document.body.classList.remove('is-flash');
          void document.body.offsetWidth;
          document.body.classList.add('is-flash');
          setTimeout(() => document.body.classList.remove('is-flash'), 2100);
          resultTitle.textContent = (outcome.mega === true ? 'MEGA JACKPOT! ' : 'WINNER! ') + reward;
          resultDesc.textContent = (t.drinkName ? t.drinkName + '. ' : '') + `Custom Build: ${finalExample} · ${finalFlavor}. Use it on your order, or show claim code ${outcome.code} at the trailer window!`;
          if (winActions) { winTwo.textContent = 'Using the other screen? Your prize is waiting on the order screen.'; winActions.hidden = false; watchPending(outcome.code); }
          audio.playTrigger(typeof outcome.trigger === 'string' ? outcome.trigger : 'prize_win');
        } else if (outcome.thanks === true) {
          launchBurst('fizz');
          r3Val.textContent = 'THANKS FOR PLAYING';
          setIcon(r3Icon, 'soda');
          r3Sub.textContent = 'ORDER AT THE WINDOW';
          resultTitle.textContent = `YOUR 1986 POUR: ${finalExample}`;
          resultDesc.textContent = `Thanks for playing! ${finalBase.label} with ${finalFlavor}. Add a +$1.50 Freeze-Dried Topper or $4 3D-Printed Neon Charm at the window!`;
          audio.playTrigger('drink_reveal');
        } else {
          launchBurst('fizz');
          r3Val.textContent = 'STANDARD CUSTOM DRINK';
          setIcon(r3Icon, 'soda');
          r3Sub.textContent = 'SHOW AT WINDOW TO ORDER';
          resultTitle.textContent = `YOUR 1986 POUR: ${finalExample}`;
          resultDesc.textContent = `${finalBase.label} with ${finalFlavor}. Add a +$1.50 Freeze-Dried Topper or $4 3D-Printed Neon Charm at the window!`;
          audio.playTrigger('drink_reveal');
        }
        spinning = false;
        spinBtn.disabled = false;
        syncPersonaUI();
        lastTouch = Date.now();
        if (limits.enabled && (session.spins >= limits.maxSpins || session.endAfterSpin || Date.now() - session.startedAt >= limits.maxSeconds * 1000)) endSession();
      }, 85);
    }
    spinBtn.addEventListener('click', triggerSpin);
    if (leverBtn) {
      let dragStartY = null, dragTriggered = false;
      leverBtn.addEventListener('pointerdown', (e) => {
        if (spinning || session.ended) return;
        dragStartY = e.clientY;
        dragTriggered = false;
        leverBtn.classList.add('is-dragging');
        if (leverBtn.setPointerCapture) { try { leverBtn.setPointerCapture(e.pointerId); } catch {} }
      });
      leverBtn.addEventListener('pointermove', (e) => {
        if (dragStartY === null) return;
        const dy = Math.max(0, Math.min(72, e.clientY - dragStartY));
        leverBtn.style.transform = `rotate(${(dy / 72) * 54}deg) translateY(${(dy / 72) * 18}px)`;
        if (dy >= 28 && !dragTriggered) {
          dragTriggered = true;
          dragStartY = null;
          leverBtn.classList.remove('is-dragging');
          leverBtn.style.transform = '';
          triggerSpin();
        }
      });
      const endDrag = () => {
        if (dragStartY === null) return;
        dragStartY = null;
        leverBtn.classList.remove('is-dragging');
        leverBtn.style.transform = '';
      };
      leverBtn.addEventListener('pointerup', endDrag);
      leverBtn.addEventListener('pointercancel', endDrag);
      leverBtn.addEventListener('click', () => {
        if (dragTriggered) { dragTriggered = false; return; }
        triggerSpin();
      });
    }

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
