/* Thirsty Beaches — 1986 Miami Beach music for the five arcade games (kiosk/games/shared/beach-music.js).

   WHEN IT PLAYS: only while a game run is in progress. It is silent on the picker, on every start card, on the game-over card, while a game is paused,
   behind the rules / win / phone / age panel, while "Still playing?" is up, and after the visit ends ("Time's up!"). It resumes only when play resumes.

   WHO CALLS IT (nothing here guesses from button text): TBK.runStart / TBK.runEnd (kgame.js), each game's own pause / resume and Sound button,
   the prize panel and the rules panel (show / hide), the idle warning, TBK.stopAudio (visit end, page hide) which calls stopAll().
   After stopAll() nothing can start again on this page (the audio guard in kgame.js also refuses any new AudioContext).

   HOW IT LOOPS: the track is a 16-bit WAV of exactly 8 bars (756000 frames at 44.1 kHz, 112 BPM), decoded once into an AudioBuffer and played with
   AudioBufferSourceNode.loop = true over the whole buffer: sample-exact, no encoder padding, no gap. It is fetched from this kiosk only (connect-src 'self'),
   once, at the first run start. A missing or undecodable file is silent: no exception reaches a game, and a run never waits for it.

   LEVEL: the file is normalised to -16 LUFS (it arrived at -12.2 LUFS, -1.5 dBTP). The master gain is FILE_GAIN (0.15) times the staff volume from the arcade config
   (-32.5 LUFS at volume 1, -35.0 at the default 0.75; the slot machine uses the same number, so the music is equally loud everywhere). The games' own effects are
   quiet synth blips (peaks -25 to -36 dBFS), so the music is set to sit 4 to 10 dB under them, and 15 to 20 dB under the slot machine's louder effects.
   The staff volume
   (0..1; muted = true means no music) scales it, read the same way as the slot machine: this screen's saved settings first, else /api/arcade-config.
   MUTE: the game's Sound button decides (setMuted). It is remembered for this visit only (sessionStorage), so the next game page starts muted too,
   and it is cleared when the visit ends (TBK.clearVisit). */
(function (root) {
  'use strict';
  if (typeof document === 'undefined') return;

  const TRACK_URL = '/kiosk/audio/bgm/miami-beach-80s.wav';
  const FILE_GAIN = 0.15;
  const MUTE_KEY = 'tbGamesMute';
  const CFG_KEY = 'tb_boardwalk_arcade_cfg_v1';      // the slot machine's saved screen settings (volume, muted); same origin
  const FADE = 0.08;                                  // seconds, gain time constant
  const SUSPEND_AFTER_MS = 400;

  let running = false, paused = false, muted = false, staffMuted = false, stopped = false, gestured = false;
  let staffVolume = 0.75;
  const panels = new Set();
  let ac = null, master = null, src = null, buf = null;
  let loading = false, failed = false, requested = 0, cfgRead = false, suspendTimer = null, plays = 0;

  try { muted = root.sessionStorage.getItem(MUTE_KEY) === '1'; } catch (e) { /* storage blocked: unmuted for this page */ }

  const okVolume = (v) => typeof v === 'number' && v >= 0 && v <= 1;
  function audible() { return running && !paused && panels.size === 0 && !muted && !staffMuted && !stopped && gestured; }
  function targetGain() { return audible() ? FILE_GAIN * staffVolume : 0; }

  function applyStaff(c) {
    if (!c || typeof c !== 'object') return;
    if (okVolume(c.volume)) staffVolume = c.volume;
    if (typeof c.muted === 'boolean') staffMuted = c.muted;
  }
  function readConfig() {
    if (cfgRead) return; cfgRead = true;
    let local = null;
    try { const s = JSON.parse(root.localStorage.getItem(CFG_KEY) || 'null'); if (s && typeof s === 'object') local = s; } catch (e) { /* none */ }
    if (local) { applyStaff(local); return; }
    try {
      root.fetch('/api/arcade-config', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j && j.config) { applyStaff(j.config); sync(); } }).catch(() => {});
    } catch (e) { /* the default volume stands */ }
  }

  function ensureCtx() {
    if (ac || stopped || failed) return ac;
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) { failed = true; return null; }
    // 44100 Hz = the file's own rate: the decoded buffer is exactly 756000 frames (no resampling at the loop edges); the browser resamples to the speakers
    try { try { ac = new AC({ sampleRate: 44100 }); } catch (e) { if (stopped) throw e; ac = new AC(); } master = ac.createGain(); master.gain.value = 0; master.connect(ac.destination); }
    catch (e) { ac = null; master = null; failed = true; }      // the audio guard refuses new contexts once the page is leaving: silent
    return ac;
  }

  function load() {
    if (buf || loading || failed || stopped) return;
    loading = true; requested++;
    let p;
    try { p = root.fetch(TRACK_URL, { cache: 'force-cache' }); } catch (e) { loading = false; failed = true; return; }
    p.then((r) => { if (!r.ok) throw new Error('no track'); return r.arrayBuffer(); })
      .then((ab) => new Promise((ok, no) => { const q = ac.decodeAudioData(ab, ok, no); if (q && q.catch) q.catch(no); }))
      .then((b) => { buf = b; loading = false; sync(); })
      .catch(() => { loading = false; failed = true; });
  }

  function startSource() {
    if (src || !buf || !ac || stopped) return;
    try {
      src = ac.createBufferSource();
      src.buffer = buf; src.loop = true; src.loopStart = 0; src.loopEnd = buf.duration;
      src.connect(master); src.start(); plays++;
    } catch (e) { src = null; failed = true; }
  }
  function stopSource() { if (src) { try { src.stop(); } catch (e) { /* already stopped */ } try { src.disconnect(); } catch (e) { /* ok */ } src = null; } }

  function sync() {
    if (stopped) return;
    if (suspendTimer) { clearTimeout(suspendTimer); suspendTimer = null; }
    if (audible()) {
      readConfig();
      if (!ensureCtx()) return;
      if (ac.state === 'suspended') ac.resume().catch(() => {});
      if (!buf) { load(); return; }
      startSource();
      if (master) master.gain.setTargetAtTime(targetGain(), ac.currentTime, FADE);
    } else if (ac) {
      if (master) master.gain.setTargetAtTime(0, ac.currentTime, FADE);
      if (!running) stopSource();                                  // a finished run restarts from the top next time; a pause keeps its place
      const c = ac;
      suspendTimer = setTimeout(() => { suspendTimer = null; if (!stopped && c === ac && !audible()) { try { c.suspend().catch(() => {}); } catch (e) { /* ok */ } } }, SUSPEND_AFTER_MS);
    }
  }

  function stopAll() {
    stopped = true; running = false;
    if (suspendTimer) { clearTimeout(suspendTimer); suspendTimer = null; }
    stopSource();
    if (ac) { const c = ac; ac = null; master = null; try { c.close().catch(() => {}); } catch (e) { /* ok */ } }
  }

  function gesture() { if (gestured || stopped) return; gestured = true; sync(); }
  ['pointerdown', 'touchstart', 'mousedown', 'keydown'].forEach((ev) => document.addEventListener(ev, gesture, { passive: true, capture: true }));

  root.TBMusic = {
    runStart: function () { if (stopped) return; running = true; paused = false; sync(); },
    runEnd: function () { running = false; paused = false; sync(); },
    setPaused: function (on) { paused = !!on; sync(); },
    setPanel: function (name, on) { if (on) panels.add(String(name)); else panels.delete(String(name)); sync(); },
    setMuted: function (m) { muted = !!m; try { if (muted) root.sessionStorage.setItem(MUTE_KEY, '1'); else root.sessionStorage.removeItem(MUTE_KEY); } catch (e) { /* in-memory only */ }/* nothing is stored while the music is simply on */ sync(); },
    isMuted: function () { return muted; },
    clearMute: function () { try { root.sessionStorage.removeItem(MUTE_KEY); } catch (e) { /* ok */ } muted = false; },
    stopAll: stopAll,
    getState: function () {
      return { running: running, paused: paused, panels: Array.from(panels), muted: muted, staffMuted: staffMuted, staffVolume: staffVolume, stopped: stopped, gestured: gestured,
        audible: audible(), playing: !!src, ctx: ac ? ac.state : 'none', gain: master ? master.gain.value : 0, target: targetGain(), loaded: !!buf, failed: failed, requested: requested, plays: plays,
        loopFrames: buf ? buf.length : 0, loop: src ? src.loop : false };
    },
    FILE_GAIN: FILE_GAIN, TRACK_URL: TRACK_URL,
  };
})(typeof window !== 'undefined' ? window : globalThis);
