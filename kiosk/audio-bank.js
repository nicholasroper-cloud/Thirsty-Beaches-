/* Thirsty Beaches — Dual-Persona 80s Audio Engine (kiosk/audio-bank.js)
   Personas: "shredder" (Fun 80s Surfer) & "neon86" (80s Arcade / Radio DJ).
   Loads local MP3 voice clips by persona & trigger, auto-ducks 80s synthwave BGM to 20%
   whenever a voice line plays, falls back to Web Speech API if an MP3 is missing,
   layers mechanical reel clicks / soda-can fizz / 80s arcade fanfare via Web Audio,
   and enforces PG Audio Mode (ON by default) to censor 18+ words in spoken audio. */
(function (root) {
  'use strict';

  const PERSONAS = {
    shredder: { id: 'shredder', label: 'Shredder (Surfer)', pitch: 1.05, rate: 1.02 },
    neon86: { id: 'neon86', label: 'Neon 86 (80s DJ)', pitch: 0.92, rate: 1.12 },
  };

  const TRIGGERS = [
    'barker_approach',
    'barker_dog_spotted',
    'slot_spin',
    'drink_reveal',
    'prize_win',
    'arcade_charm_win',
    'mega_jackpot',
  ];

  // Local MP3 file pool per persona & trigger + scripted TTS fallback lines
  const CLIPS = {
    shredder: {
      barker_approach: [
        { file: 'shredder/barker_approach_1.mp3', text: 'Whoa, righteous timing dude! Step up to the 1986 Drink Slots and catch a gnarly dirty soda wave!' },
        { file: 'shredder/barker_approach_2.mp3', text: 'Hey beach cruiser! Tap spin for chewable nugget ice, pineapple soft serve floats, or a rad arcade prize!' },
        { file: 'shredder/barker_approach_3.mp3', text: 'Aloha from 1986! Spin the neon reels for a totally tubular drink!' },
      ],
      barker_dog_spotted: [
        { file: 'shredder/barker_dog_spotted_1.mp3', text: 'Whoa, rad pup alert! Grab your furry beach buddy The One Dollar Menace Cup with a freeze-dried dog treat topper!' },
        { file: 'shredder/barker_dog_spotted_2.mp3', text: 'Hang ten, good boy! Tell your human to grab The One Dollar Menace Cup and a freeze-dried dog treat at the window!' },
      ],
      slot_spin: [
        { file: 'shredder/slot_spin_1.mp3', text: 'Dropping in! Reels are spinning, dude!' },
        { file: 'shredder/slot_spin_2.mp3', text: 'Paddle out and let the 80s neon reels roll!' },
      ],
      drink_reveal: [
        { file: 'shredder/drink_reveal_1.mp3', text: 'Totally tubular combo! Order that custom pour right at the window!' },
        { file: 'shredder/drink_reveal_2.mp3', text: 'Stoked on that mix! Show your screen at the window and we will pour it fresh!' },
      ],
      prize_win: [
        { file: 'shredder/prize_win_1.mp3', text: 'Cowabunga! You scored a gnarly boardwalk bonus prize! Show your 4-digit code at the window!' },
        { file: 'shredder/prize_win_2.mp3', text: 'Righteous spin, dude! Flash that 4-digit claim code at the window to cash in!' },
      ],
      arcade_charm_win: [
        { file: 'shredder/arcade_charm_win_1.mp3', text: 'No way! You just won a free 3D-printed 80s neon straw charm! Pick your palm tree, cassette, or surfboard at the window!' },
      ],
      mega_jackpot: [
        { file: 'shredder/mega_jackpot_1.mp3', text: 'MEGA WAVE JACKPOT! Free drink on the house, dude! Flash that 4-digit code at the window right now!' },
      ],
    },
    neon86: {
      barker_approach: [
        { file: 'neon86/barker_approach_1.mp3', text: 'Live from the 1986 Neon Boardwalk! Step right up and spin the Thirsty Beaches Drink Machine!' },
        { file: 'neon86/barker_approach_2.mp3', text: 'Caller number 86, you are on the air! Pull the lever for dirty sodas, pineapple soft serve floats, and instant prizes!' },
        { file: 'neon86/barker_approach_3.mp3', text: 'Welcome back to Neon 86 FM! Spin three neon reels for your custom beach prescription!' },
      ],
      barker_dog_spotted: [
        { file: 'neon86/barker_dog_spotted_1.mp3', text: 'VIP canine spotted on the boardwalk! Treat that legend to The One Dollar Menace Cup plus a freeze-dried dog treat!' },
        { file: 'neon86/barker_dog_spotted_2.mp3', text: 'Breaking news on Neon 86: A certified good boy just rolled up! Grab The One Dollar Menace Cup and a freeze-dried treat at the window!' },
      ],
      slot_spin: [
        { file: 'neon86/slot_spin_1.mp3', text: 'Insert zero quarters! Reels are locked and spinning!' },
        { file: 'neon86/slot_spin_2.mp3', text: 'Crank the synth! Spinning up your custom 1986 pour!' },
      ],
      drink_reveal: [
        { file: 'neon86/drink_reveal_1.mp3', text: 'Chart-topping flavor hit! Bring this custom build to the window!' },
        { file: 'neon86/drink_reveal_2.mp3', text: 'Pure electric refreshment! Show the crew and sip like it is 1986!' },
      ],
      prize_win: [
        { file: 'neon86/prize_win_1.mp3', text: 'Winner winner on the boardwalk! Flash your 4-digit claim code at the window to collect!' },
        { file: 'neon86/prize_win_2.mp3', text: 'High score bonus unlocked! Show your 4-digit code to the crew!' },
      ],
      arcade_charm_win: [
        { file: 'neon86/arcade_charm_win_1.mp3', text: 'Bonus stage cleared! You scored a FREE 3D-printed 80s neon straw charm! Claim it at the window with your 4-digit code!' },
      ],
      mega_jackpot: [
        { file: 'neon86/mega_jackpot_1.mp3', text: 'ALARM BELLS RINGING! ONE PERCENT FREE DRINK JACKPOT! Show your 4-digit claim code at the window!' },
      ],
    },
  };

  // PG Audio Mode censor filter (ON by default): scrubs 18+ words in spoken audio while leaving screen text untouched.
  const PROFANITY_RE = /\b(f+u+c+k\w*|sh[i1]+t\w*|bitch\w*|asshole\w*|dick(?:s|head\w*)?|cock(?:s|blocker\w*)?|piss\w*|bastard\w*|slut\w*|dumbass\w*|damn|hell)\b/gi;
  function sanitizeSpokenText(text, pgMode = true) {
    const clean = String(text || '');
    if (!pgMode) return clean;
    return clean.replace(PROFANITY_RE, 'bleep');
  }

  function createAudioBank(opts = {}) {
    const basePath = (opts.basePath || '/kiosk/audio/').replace(/\/?$/, '/');
    const state = {
      personaMode: opts.personaMode || 'auto', // 'shredder' | 'neon86' | 'auto'
      activePersona: 'shredder',
      spinCounter: 0,
      volume: typeof opts.volume === 'number' ? opts.volume : 0.75,
      muted: Boolean(opts.muted),
      pgMode: opts.pgMode !== false, // ON by default
      ducking: false,
      bgmRunning: false,
    };

    let ctx = null;
    let stopped = false;               // stopAll() was called (the page is being left): nothing may start again
    const missing = new Set();         // clip files that failed to load once: never requested again (no repeated 404s), the Web Speech / synth fallback is used
    let masterGain = null;
    let bgmGain = null;
    let bgmAudio = null;
    let bgmTimer = null;
    let activeVoiceAudio = null;

    function ensureCtx() {
      if (stopped || typeof window === 'undefined') return null;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!ctx) {
        ctx = new AC();
        masterGain = ctx.createGain();
        bgmGain = ctx.createGain();
        bgmGain.connect(masterGain);
        masterGain.connect(ctx.destination);
        applyGains();
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }

    function applyGains() {
      const vol = state.muted ? 0 : Math.max(0, Math.min(1, state.volume));
      const bgmLevel = state.ducking ? 0.20 : 1.0;
      if (masterGain && ctx) {
        masterGain.gain.setTargetAtTime(vol, ctx.currentTime, 0.03);
      }
      if (bgmGain && ctx) {
        // Subtle idle synthwave level (0.12 base, ducks cleanly to 20% = 0.024 during voice clips)
        bgmGain.gain.setTargetAtTime(0.12 * bgmLevel, ctx.currentTime, 0.06);
      }
      if (bgmAudio) {
        bgmAudio.volume = Math.max(0, Math.min(1, vol * 0.22 * bgmLevel));
      }
      if (activeVoiceAudio) {
        activeVoiceAudio.volume = vol;
      }
    }

    function setDucking(on) {
      state.ducking = Boolean(on);
      applyGains();
    }

    function startSynthwaveIdle() {
      if (stopped || state.bgmRunning) return;
      state.bgmRunning = true;
      const a = ensureCtx();
      // Try loading local synthwave-idle.mp3 first; if unavailable (it ships without sound files), run procedural 1986 Web Audio arpeggio pad
      if (typeof Audio !== 'undefined' && !missing.has('bgm/synthwave-idle.mp3')) {
        let el = null;
        try {
          el = new Audio(basePath + 'bgm/synthwave-idle.mp3');
          el.loop = true;
          el.volume = state.muted ? 0 : state.volume * 0.22;
          el.addEventListener('error', () => missing.add('bgm/synthwave-idle.mp3'));
          const p = el.play();
          if (p && typeof p.then === 'function') {
            p.then(() => {
              if (stopped) { try { el.pause(); } catch {} return; }
              bgmAudio = el;
              applyGains();
            }).catch(() => {
              missing.add('bgm/synthwave-idle.mp3');
              if (!stopped) startProceduralSynthwave(a);
            });
          } else if (!stopped) startProceduralSynthwave(a);
        } catch {
          missing.add('bgm/synthwave-idle.mp3');
          startProceduralSynthwave(a);
        }
      } else {
        startProceduralSynthwave(a);
      }
    }

    function startProceduralSynthwave(a) {
      if (!a || bgmTimer) return;
      // Classic 1986 Am - F - C - G synthwave arpeggio @ 108 BPM
      const notes = [220, 261.63, 329.63, 440, 174.61, 220, 261.63, 349.23, 261.63, 329.63, 392, 523.25, 196, 246.94, 293.66, 392];
      let step = 0;
      bgmTimer = setInterval(() => {
        if (state.muted || !ctx || ctx.state !== 'running') return;
        const f = notes[step % notes.length];
        step++;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const filt = ctx.createBiquadFilter();
        const env = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(f * 0.5, now);
        filt.type = 'lowpass';
        filt.frequency.setValueAtTime(680, now);
        env.gain.setValueAtTime(0.001, now);
        env.gain.linearRampToValueAtTime(0.28, now + 0.03);
        env.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
        osc.connect(filt);
        filt.connect(env);
        env.connect(bgmGain);
        osc.start(now);
        osc.stop(now + 0.26);
      }, 275);
    }

    function stopSynthwaveIdle() {
      state.bgmRunning = false;
      if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; }
      if (bgmAudio) { try { bgmAudio.pause(); } catch {} bgmAudio = null; }
    }

    /* ---------- Layered Arcade SFX ---------- */
    function playReelClick() {
      const a = ensureCtx();
      if (!a || state.muted) return;
      const now = a.currentTime;
      const osc = a.createOscillator();
      const g = a.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(920, now);
      osc.frequency.exponentialRampToValueAtTime(220, now + 0.035);
      g.gain.setValueAtTime(0.18, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      osc.connect(g);
      g.connect(masterGain);
      osc.start(now);
      osc.stop(now + 0.045);
    }

    function playSodaFizz() {
      const a = ensureCtx();
      if (!a || state.muted) return;
      const dur = 0.55;
      const buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (a.sampleRate * 0.22));
      const src = a.createBufferSource();
      src.buffer = buf;
      const hp = a.createBiquadFilter();
      hp.type = 'bandpass';
      hp.frequency.setValueAtTime(4200, a.currentTime);
      hp.Q.setValueAtTime(0.9, a.currentTime);
      const g = a.createGain();
      g.gain.setValueAtTime(0.28, a.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
      src.connect(hp);
      hp.connect(g);
      g.connect(masterGain);
      src.start();
    }

    function playArcadeFanfare(mega = false) {
      const a = ensureCtx();
      if (!a || state.muted) return;
      const seq = mega
        ? [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5, 1567.98]
        : [523.25, 659.25, 783.99, 1046.5, 1318.5];
      seq.forEach((f, i) => {
        const t = a.currentTime + i * 0.085;
        const osc = a.createOscillator();
        const g = a.createGain();
        osc.type = i % 2 === 0 ? 'square' : 'sawtooth';
        osc.frequency.setValueAtTime(f, t);
        g.gain.setValueAtTime(mega ? 0.26 : 0.2, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
        osc.connect(g);
        g.connect(masterGain);
        osc.start(t);
        osc.stop(t + 0.25);
      });
    }

    /* ---------- Dual-Persona Voice Playback (MP3 -> Web Speech API fallback) ---------- */
    function resolvePersona() {
      if (state.personaMode === 'shredder' || state.personaMode === 'neon86') {
        state.activePersona = state.personaMode;
      }
      return state.activePersona;
    }

    function recordSpinForAutoRotate() {
      state.spinCounter++;
      if (state.personaMode === 'auto' && state.spinCounter % 3 === 0) {
        state.activePersona = state.activePersona === 'shredder' ? 'neon86' : 'shredder';
      }
      return state.activePersona;
    }

    function speakFallback(rawText, personaId) {
      return new Promise((resolve) => {
        const spoken = sanitizeSpokenText(rawText, state.pgMode);
        if (stopped || state.muted || typeof window === 'undefined' || !window.speechSynthesis) {
          resolve({ source: 'silent', text: spoken });
          return;
        }
        try {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(spoken);
          const p = PERSONAS[personaId] || PERSONAS.shredder;
          u.pitch = p.pitch;
          u.rate = p.rate;
          u.volume = Math.max(0, Math.min(1, state.volume));
          setDucking(true);
          u.onend = () => { setDucking(false); resolve({ source: 'speech', text: spoken }); };
          u.onerror = () => { setDucking(false); resolve({ source: 'speech-error', text: spoken }); };
          window.speechSynthesis.speak(u);
        } catch {
          setDucking(false);
          resolve({ source: 'speech-unavailable', text: spoken });
        }
      });
    }

    async function playTrigger(trigger, customOverrideText) {
      const personaId = resolvePersona();
      if (stopped) return { persona: personaId, trigger, source: 'stopped', text: '' };
      const pool = (CLIPS[personaId] && CLIPS[personaId][trigger]) || [];
      const clip = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
      const fallbackText = customOverrideText || (clip ? clip.text : '');
      if (state.muted) return { persona: personaId, trigger, source: 'muted', text: sanitizeSpokenText(fallbackText, state.pgMode) };

      // If custom text override was explicitly requested (e.g. reading out a custom line), go straight to TTS
      if (customOverrideText || !clip || typeof Audio === 'undefined' || missing.has(clip.file)) {
        const r = await speakFallback(fallbackText, personaId);
        return { persona: personaId, trigger, ...r };
      }

      // Attempt local MP3 voice clip first; automatically fall back to Web Speech API if MP3 is missing
      return new Promise((resolve) => {
        if (activeVoiceAudio) { try { activeVoiceAudio.pause(); } catch {} activeVoiceAudio = null; }
        const el = new Audio(basePath + clip.file);
        el.volume = Math.max(0, Math.min(1, state.volume));
        let settled = false;
        const finishFallback = () => {
          if (settled) return;
          settled = true;
          missing.add(clip.file);       // not there (the kiosk ships without sound files): do not ask for it again
          activeVoiceAudio = null;
          if (stopped) { resolve({ persona: personaId, trigger, source: 'stopped', text: '' }); return; }
          speakFallback(fallbackText, personaId).then((r) => resolve({ persona: personaId, trigger, ...r }));
        };
        el.onended = () => {
          if (settled) return;
          settled = true;
          activeVoiceAudio = null;
          setDucking(false);
          resolve({ persona: personaId, trigger, source: 'mp3', file: clip.file, text: sanitizeSpokenText(fallbackText, state.pgMode) });
        };
        el.onerror = finishFallback;
        setDucking(true);
        activeVoiceAudio = el;
        let p;
        try { p = el.play(); } catch { finishFallback(); return; }
        if (p && typeof p.catch === 'function') p.catch(finishFallback);
      });
    }

    /* Leaving the arcade (page hide, end of the session, back to the ordering screen): every sound stops and nothing can start again.
       The pages navigate away so the browser would drop all of this anyway; this makes it explicit and covers a screen that stays open. */
    function stopAll() {
      stopped = true;
      stopSynthwaveIdle();
      if (activeVoiceAudio) { try { activeVoiceAudio.pause(); } catch {} activeVoiceAudio = null; }
      try { if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel(); } catch {}
      state.ducking = false;
      if (ctx) { const c = ctx; ctx = null; masterGain = null; bgmGain = null; try { c.close().catch(() => {}); } catch {} }
    }

    return {
      PERSONAS,
      TRIGGERS,
      CLIPS,
      getState: () => ({ ...state }),
      setPersonaMode: (mode) => {
        if (['shredder', 'neon86', 'auto'].includes(mode)) {
          state.personaMode = mode;
          if (mode !== 'auto') state.activePersona = mode;
        }
        return state.personaMode;
      },
      setVolume: (v) => { state.volume = Math.max(0, Math.min(1, Number(v) || 0)); applyGains(); },
      setMuted: (m) => { state.muted = Boolean(m); applyGains(); if (state.muted && typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel(); },
      toggleMute: () => { state.muted = !state.muted; applyGains(); if (state.muted && typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel(); return state.muted; },
      setPgMode: (on) => { state.pgMode = Boolean(on); },
      startSynthwaveIdle,
      stopSynthwaveIdle,
      stopAll,
      playReelClick,
      playSodaFizz,
      playArcadeFanfare,
      recordSpinForAutoRotate,
      playTrigger,
      sanitizeSpokenText,
    };
  }

  const exported = { PERSONAS, TRIGGERS, CLIPS, sanitizeSpokenText, createAudioBank };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else root.TBAudioBank = exported;
})(typeof window !== 'undefined' ? window : globalThis);
