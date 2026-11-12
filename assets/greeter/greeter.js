/* Thirsty Beaches — Kiosk Greeter
 * Webcam notices people, speakers roast them (nicely).
 * Drop into the kiosk:
 *   <script src="greeter-lines.js"></script>
 *   <script src="greeter.js"></script>
 * Recorded character voices: see make-voices.js
 * Everything runs on the PC. No video or audio is recorded or sent anywhere.
 *
 * Hotkeys:  D = debug panel   M = mute/unmute   T = test line   V = next character voice
 * API:      TBGreeter.pause(ms)  TBGreeter.say(text)  TBGreeter.mute(bool)
 */
(() => {
  // ───────── HOST OPTIONS ─────────
  // A page can set window.TB_GREETER = {...} before loading this file:
  //   tapToStart: false        start talking without the "Tap to open" screen (kiosk)
  //   activeWhen: () => bool   only watch/talk while this is true (kiosk: logo screen showing)
  //   controlUrl: "/control"   poll for { greeter: { enabled, volume } } to switch it remotely
  const OPT = Object.assign({ tapToStart: true, activeWhen: null, controlUrl: null }, window.TB_GREETER || {});

  // ───────── SETTINGS ─────────
  const CFG = {
    minGapMs: 18000,          // never talk more often than this
    approachGapMs: 9000,      // a new face walking up can interrupt sooner
    motionThreshold: 0.035,   // fraction of pixels changed = "someone walked by"
    approachFaceSize: 0.16,   // face width / frame width = "they're at the kiosk"
    lonelyAfterMs: 6 * 60000, // nobody around this long → occasional lonely line
    quietHours: null,         // e.g. [21, 9] = no talking 9pm–9am (PC clock). null = always on
    volume: 1.0,
    pauseAfterTouchMs: 45000, // shut up while someone is ordering
  };

  // ───────── CHARACTERS ─────────
  // Each character has its own voice settings + lines. Missing categories fall back to SHARED.
  // pitch: 0 (deep) – 2 (squeaky)   rate: 0.5 (slow) – 2 (fast)
  // personaMode: "rotate" = new character every rotateMinutes, "random" = new one every line,
  //              or a character key like "pirate" to lock one in.
  CFG.personaMode = "random";
  CFG.rotateMinutes = 15;

  const { SHARED, PERSONAS, hash } = window.TB_LINES;
  const PERSONA_KEYS = Object.keys(PERSONAS);
  let personaIdx = 0, personaSince = Date.now(), lastPersona = null;

  function currentPersonaKey() {
    const m = CFG.personaMode;
    if (PERSONAS[m]) return m;
    if (m === "random") {
      let k; do { k = PERSONA_KEYS[Math.floor(Math.random() * PERSONA_KEYS.length)]; } while (k === lastPersona && PERSONA_KEYS.length > 1);
      return (lastPersona = k);
    }
    if (Date.now() - personaSince > CFG.rotateMinutes * 60000) {
      personaIdx = (personaIdx + 1) % PERSONA_KEYS.length; personaSince = Date.now();
    }
    return PERSONA_KEYS[personaIdx];
  }

  // ───────── RECORDED CLIPS ─────────
  // make-voices.js writes audio/<character>/<id>.mp3 and audio/manifest.js (list of clips that exist).
  const BASE = (document.currentScript && document.currentScript.src || location.href).replace(/[^/]*$/, "");
  const clipScript = document.createElement("script");
  clipScript.src = BASE + "audio/manifest.js?" + Date.now();
  clipScript.onerror = () => console.info("[greeter] no recorded clips yet, using computer voices");
  document.head.appendChild(clipScript);
  const hasClip = (key, id) => !!(window.TBG_AUDIO && window.TBG_AUDIO[key] && window.TBG_AUDIO[key].includes(id));
  let player = null;
  const stopAll = () => { speechSynthesis.cancel(); if (player) { player.pause(); player = null; } };
  const busy = () => {
    if (player && !player.paused && !player.ended) return true;
    if (!speechSynthesis.speaking) return false;
    if (Date.now() - S.lastSpoke > 12000) { speechSynthesis.cancel(); return false; }  // stuck/blocked utterance
    return true;
  };
  const clean = t => t.replace(/\[[^\]]*\]\s*/g, "").trim();

  // ───────── STATE ─────────
  const S = {
    lastSpoke: 0, lastFaceSeen: 0, lastMotion: Date.now(), pausedUntil: 0,
    muted: false, armed: false, recent: [], motion: 0, faceSize: 0, faces: 0,
    hadFace: false, detector: null, debug: false, voice: null,
    enabled: true, stream: null, camStarting: false, speech: "not tried yet", lastLine: "", camError: "",
  };

  // ───────── UI ─────────
  const css = `
  #tbg-bubble{position:fixed;left:50%;bottom:6vh;transform:translateX(-50%) scale(.9);opacity:0;
    max-width:80vw;padding:18px 28px;border-radius:24px;font:700 clamp(20px,3vw,40px)/1.2 system-ui,sans-serif;
    color:#fff;background:linear-gradient(135deg,#ff2bd6,#00e5ff);box-shadow:0 0 30px #ff2bd6aa;
    text-align:center;z-index:99999;pointer-events:none;transition:all .35s cubic-bezier(.2,1.4,.4,1)}
  #tbg-bubble.show{opacity:1;transform:translateX(-50%) scale(1)}
  #tbg-debug{position:fixed;top:50%;left:8px;z-index:99999;background:#000c;color:#0f0;
    font:18px/1.35 monospace;padding:10px;border-radius:8px;display:none;width:420px;white-space:pre-wrap;pointer-events:none;opacity:.85}
  #tbg-debug pre{white-space:pre-wrap;margin:6px 0 0}
  #tbg-debug video{width:100%;transform:scaleX(-1);border-radius:4px}
  #tbg-arm{position:fixed;inset:0;z-index:100000;background:#000d;color:#fff;display:flex;
    align-items:center;justify-content:center;font:700 32px system-ui;cursor:pointer}`;
  const style = document.createElement("style"); style.textContent = css;
  document.head.appendChild(style);
  const bubble = Object.assign(document.createElement("div"), { id: "tbg-bubble" });
  const dbg = Object.assign(document.createElement("div"), { id: "tbg-debug" });
  const video = Object.assign(document.createElement("video"), { muted: true, playsInline: true, autoplay: true });
  const dbgText = document.createElement("pre");
  dbg.append(video, dbgText);
  document.body.append(bubble, dbg);

  // ───────── SPEECH ─────────
  let voices = [];
  const loadVoices = () => (voices = speechSynthesis.getVoices().filter(v => v.lang.startsWith("en")));
  speechSynthesis.onvoiceschanged = loadVoices; loadVoices();
  const voiceFor = p => {
    for (const re of [].concat(p.voice)) { const v = voices.find(v => re.test(v.name)); if (v) return v; }
    return voices[0] || null;
  };

  let bubbleTimer;
  function say(raw, persona = PERSONAS.normal, clipUrl = null) {
    const text = clean(raw);
    S.lastSpoke = Date.now();
    bubble.textContent = `${persona.emoji} ${text}`; bubble.classList.add("show");
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove("show"), 4500 + text.length * 40);
    if (S.muted) return;
    stopAll();
    if (clipUrl) {
      player = new Audio(clipUrl); player.volume = CFG.volume;
      player.play().catch(() => { player = null; speakTTS(text, persona); });
      return;
    }
    speakTTS(text, persona);
  }

  function speakTTS(text, persona) {
    const u = new SpeechSynthesisUtterance(text);
    Object.assign(u, { volume: CFG.volume, rate: persona.rate, pitch: persona.pitch });
    const v = voiceFor(persona); if (v) u.voice = v;
    u.onstart = () => { S.speech = "ok"; };
    u.onerror = e => { S.speech = e.error === "not-allowed" ? "BLOCKED - tap screen once" : "error: " + e.error; };
    S.lastLine = text;
    speechSynthesis.speak(u);
  }

  // Pick a line for a category: 70% the character's own lines, 30% shared lines
  function speak(cat) {
    const key = currentPersonaKey(), p = PERSONAS[key];
    const own = p.lines[cat] || [];
    const pool0 = own.length && Math.random() < 0.7 ? own : SHARED[cat];
    const pool = pool0.filter(l => !S.recent.includes(l));
    const list = pool.length ? pool : pool0;
    const line = list[Math.floor(Math.random() * list.length)];
    S.recent.push(line); if (S.recent.length > 25) S.recent.shift();
    const id = hash(line);
    say(line, p, hasClip(key, id) ? `${BASE}audio/${key}/${id}.mp3` : null);
  }

  function timeLine() {
    const h = new Date().getHours();
    return h < 11 ? "morning" : h < 17 ? "afternoon" : "evening";
  }

  function quiet() {
    if (!CFG.quietHours) return false;
    const h = new Date().getHours(), [a, b] = CFG.quietHours;
    return a > b ? (h >= a || h < b) : (h >= a && h < b);
  }

  function hostActive() {
    try { return !OPT.activeWhen || !!OPT.activeWhen(); } catch { return true; }
  }
  // Camera on only while there's a reason to look (frees it for other camera features on the page)
  const wantCam = () => S.enabled && !quiet() && hostActive() && Date.now() >= S.pausedUntil;

  // ───────── DECIDE WHAT TO SAY ─────────
  function maybeTalk() {
    const now = Date.now();
    if (!S.armed || !S.enabled || quiet() || !hostActive() || now < S.pausedUntil || busy()) return;
    const since = now - S.lastSpoke;
    const close = S.faceSize >= CFG.approachFaceSize;

    if (close && !S.hadFace && since > CFG.approachGapMs) {          // someone just walked up
      S.hadFace = true;
      return speak(S.faces > 1 ? "group" : Math.random() < 0.2 ? timeLine() : "approach");
    }
    if (!close && now - S.lastFaceSeen > 4000) S.hadFace = false;     // they left; re-arm

    if (!close && S.motion > CFG.motionThreshold && since > CFG.minGapMs) // walk-by
      return speak("passerby");

    if (now - S.lastMotion > CFG.lonelyAfterMs && since > CFG.lonelyAfterMs)
      return speak("lonely");
  }

  // ───────── CAMERA ─────────
  const small = document.createElement("canvas"); small.width = 80; small.height = 60;
  const sctx = small.getContext("2d", { willReadFrequently: true });
  let prev = null;

  function motionLevel() {
    sctx.drawImage(video, 0, 0, 80, 60);
    const d = sctx.getImageData(0, 0, 80, 60).data;
    let changed = 0;
    const cur = new Uint8Array(80 * 60);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      cur[p] = (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (prev && Math.abs(cur[p] - prev[p]) > 28) changed++;
    }
    prev = cur;
    return changed / cur.length;
  }

  let loadFaces = async function () {
    try {
      const V = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
      const { FilesetResolver, FaceDetector } = await import(V + "/vision_bundle.mjs");
      const fs = await FilesetResolver.forVisionTasks(V + "/wasm");
      S.detector = await FaceDetector.createFromOptions(fs, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
          delegate: "GPU",
        },
        runningMode: "VIDEO", minDetectionConfidence: 0.6,
      });
    } catch (e) { console.warn("[greeter] face model failed, motion-only mode", e); }
  };

  let camFailUntil = 0;
  async function startCam() {
    if (S.stream || S.camStarting) return;
    S.camStarting = true;
    try {
      S.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
      if (!wantCam()) { stopCam(); return; }
      video.srcObject = S.stream; S.camError = "";
      if (!S.detector) loadFaces();
    } catch (e) { camFailUntil = Date.now() + 15000; S.camError = (e && (e.name || e.message)) || "failed"; console.warn("[greeter] camera unavailable", e); }
    finally { S.camStarting = false; }
  }
  function stopCam() {
    if (S.stream) S.stream.getTracks().forEach(t => t.stop());
    S.stream = null; video.srcObject = null; prev = null;
    S.motion = 0; S.faces = 0; S.faceSize = 0;
  }

  function loop() {
    if (wantCam()) { if (!S.stream && Date.now() > camFailUntil) startCam(); }
    else if (S.stream) stopCam();
    if (S.stream && video.readyState >= 2) {
      S.motion = motionLevel();
      if (S.motion > CFG.motionThreshold) S.lastMotion = Date.now();
      if (S.detector) {
        const r = S.detector.detectForVideo(video, performance.now()).detections;
        S.faces = r.length;
        S.faceSize = r.reduce((m, f) => Math.max(m, f.boundingBox.width / video.videoWidth), 0);
        if (S.faces) S.lastFaceSeen = Date.now();
      }
      maybeTalk();

    }
    if (S.debug) dbgText.textContent = `GREETER v2  ${new Date().toLocaleTimeString()}\ncam ${S.stream ? "ON" : "off"}${S.camError ? " (" + S.camError + ")" : ""}  speech ${S.speech}\nlast: ${S.lastLine.slice(0, 60)}\n` +
        `motion ${(S.motion * 100).toFixed(1)}%\nfaces  ${S.faces}  size ${(S.faceSize * 100).toFixed(0)}%\n` +
        `on ${S.enabled}  active ${hostActive()}  cam ${!!S.stream}\nmuted ${S.muted}  quiet ${quiet()}\npaused ${Math.max(0, S.pausedUntil - Date.now()) / 1000 | 0}s\n` +
        `model ${S.detector ? "faces+motion" : "motion only"}\nvoice ${PERSONAS[PERSONA_KEYS[personaIdx]].name}\nclips ${window.TBG_AUDIO ? Object.values(window.TBG_AUDIO).flat().length : 0}`;
    setTimeout(loop, 200); // 5 fps is plenty and keeps the PC cool
  }

  let facesLoading = false;
  const _loadFaces = loadFaces;
  loadFaces = () => { if (facesLoading) return; facesLoading = true; _loadFaces(); };

  async function pollControl() {
    if (!OPT.controlUrl) return;
    try {
      const c = await (await fetch(OPT.controlUrl, { cache: "no-store" })).json();
      const gr = c && c.greeter;
      S.enabled = !(gr && gr.enabled === false);
      if (gr && typeof gr.volume === "number") CFG.volume = Math.max(0, Math.min(1, gr.volume));
      if (gr && "quietHours" in gr) CFG.quietHours = Array.isArray(gr.quietHours) ? gr.quietHours : null;
      if (gr && typeof gr.motionThreshold === "number") CFG.motionThreshold = gr.motionThreshold;
      if (gr && typeof gr.approachFaceSize === "number") CFG.approachFaceSize = gr.approachFaceSize;
      if (gr && typeof gr.debug === "boolean" && gr.debug !== S.debug) { S.debug = gr.debug; dbg.style.display = S.debug ? "block" : "none"; }
      if (!S.enabled) stopAll();
    } catch {}
  }

  function start() {
    pollControl(); if (OPT.controlUrl) setInterval(pollControl, 120000);
    loop();
  }

  // Chrome won't speak until someone taps once. One staff tap at opening arms it.
  // (Or launch Chrome with --autoplay-policy=no-user-gesture-required to skip this.)
  function arm() {
    S.armed = true;
    speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(" "), { volume: 0 }));
    document.getElementById("tbg-arm")?.remove();
  }
  if (OPT.tapToStart) {
    const armScreen = Object.assign(document.createElement("div"), { id: "tbg-arm", textContent: "🌴 Tap to open the stand 🌴" });
    armScreen.onclick = arm;
    document.body.appendChild(armScreen);
  } else {
    S.armed = true;   // the browser must allow sound without a tap (kiosk launch flag); a first touch also unlocks it
  }

  // Customer is using the menu → stop talking at them
  addEventListener("pointerdown", () => {
    if (!S.armed) return;
    if (!OPT.tapToStart && !S.unlocked) { S.unlocked = true; speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(" "), { volume: 0 })); }
    S.pausedUntil = Date.now() + CFG.pauseAfterTouchMs;
    stopAll(); bubble.classList.remove("show");
  }, true);

  addEventListener("keydown", e => {
    const el = e.target;
    if (e.ctrlKey || e.metaKey || e.altKey || (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))) return;
    const k = (e.key || "").toLowerCase();
    if (k === "d") dbg.style.display = (S.debug = !S.debug) ? "block" : "none";
    if (k === "m") { S.muted = !S.muted; if (S.muted) stopAll(); }
    if (k === "t") speak("passerby");
    if (k === "v") { CFG.personaMode = "random"; personaIdx = (personaIdx + 1) % PERSONA_KEYS.length; personaSince = Date.now(); speak("approach"); }
  });

  window.TBGreeter = {
    say, speak, CFG, SHARED, PERSONAS,
    pause: ms => (S.pausedUntil = Date.now() + (ms ?? CFG.pauseAfterTouchMs)),
    mute: (m = true) => { S.muted = m; if (m) stopAll(); },
  };
  start();
})();
