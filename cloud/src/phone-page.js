/* The customer's phone page for "Pay on my phone": /r/<ref>.
   Pending: order summary + Pay button (Clover Hosted Checkout). Paid: "we're making it" with
   rotating funny lines. Ready: big green "Ready at the window!" + buzz. Polls /api/qr/<ref>.
   Review ask: with the REVIEW_URL variable set (an https link, e.g. the Google review link), a
   quiet "Leave us a review" link on the paid screen and a button on the ready screen; one tap
   opens it in a new tab, then it's gone for that order (and for 120 days on that phone).
   Without REVIEW_URL nothing about reviews is on the page.
   No external scripts. The funny lines come from funny-lines.js (the one place to edit them). */
import { READY_LINES, MAKING_LINES, fillLine } from "./funny-lines.js";

const safeJson = v => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
  .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export function reviewLink(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    return u.protocol === "https:" && u.href.length <= 500 ? u.href : "";
  } catch { return ""; }
}

export function phonePage(view, opts = {}) {
  const reviewUrl = reviewLink(opts.reviewUrl);
  const punchOn = !!opts.punch;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#09010F">
<meta name="robots" content="noindex">
<title>Your order · Thirsty Beaches</title>
<link rel="icon" type="image/png" sizes="192x192" href="/assets/icon-192.png?v=logo20261018">
<link rel="apple-touch-icon" href="/assets/icon-512.png?v=logo20261018">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bungee&family=Archivo:wght@500;700&family=DM+Mono:wght@400;500&display=swap">
<style>
/* Brand: the website look (thirstybeaches.com): night-sky void, neon magenta/cyan, Bungee + Archivo + DM Mono.
   Phone first: body text >= 16px, small labels >= 15px, key text >= 7:1, taps >= 48px. */
:root{color-scheme:dark;--void:#09010F;--deep:#1B0538;--card:rgba(27,5,56,.88);--fg:#FFF4FA;--mute:#CBBEE6;--line:rgba(42,245,228,.22);--line-2:rgba(42,245,228,.45);
--cyan:#2AF5E4;--magenta:#FF3CAC;--purple:#8A3FFC;--amber:#FF7A45;--sun:#FFD166;--green:#3BE08A;
--grad:linear-gradient(110deg,#FF3CAC 0%,#FF7A45 100%);
--display:'Bungee',system-ui,sans-serif;--body:'Archivo',system-ui,-apple-system,sans-serif;--mono:'DM Mono',ui-monospace,monospace}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{background:radial-gradient(900px 520px at 50% -200px,#3a1261 0%,var(--deep) 45%,var(--void) 82%) fixed,var(--void);color:var(--fg);font-family:var(--body);font-size:17px;
 -webkit-text-size-adjust:100%;overflow-x:hidden;position:relative;min-height:100vh;min-height:100dvh;font-synthesis:none}
body::after{content:"";position:fixed;left:-10%;right:-10%;bottom:0;height:24%;pointer-events:none;opacity:.3;z-index:0;
 background:repeating-linear-gradient(90deg,rgba(255,60,172,.4) 0 2px,transparent 2px 90px),repeating-linear-gradient(0deg,rgba(42,245,228,.32) 0 2px,transparent 2px 45px);
 transform:perspective(500px) rotateX(58deg);transform-origin:50% 100%;-webkit-mask-image:linear-gradient(to top,#000 20%,transparent);mask-image:linear-gradient(to top,#000 20%,transparent)}
.app{position:relative;z-index:1;max-width:520px;margin:0 auto;padding:calc(14px + env(safe-area-inset-top)) 16px calc(40px + env(safe-area-inset-bottom));text-align:center}
.logo{width:min(210px,56vw);height:auto;display:block;margin:0 auto 4px;filter:drop-shadow(0 0 22px rgba(255,60,172,.45)) drop-shadow(0 0 10px rgba(42,245,228,.25))}
h1{font-family:var(--display);font-weight:400;font-size:1.85rem;line-height:1.12;letter-spacing:.01em;margin:12px 0 8px;text-shadow:0 0 16px rgba(42,245,228,.45);text-wrap:balance}
.sub{color:var(--mute);font-size:1.06rem;line-height:1.45;margin:0 0 16px}
.card{background:var(--card);border:1.5px solid var(--line);border-radius:20px;padding:12px 16px;text-align:left;margin:14px 0}
.item{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)}.item:last-child{border-bottom:0}
.item .q{font-family:var(--mono);font-weight:500;color:var(--sun);min-width:2.2em;font-size:1rem;padding-top:1px}
.item b{display:block;font-size:1.08rem;line-height:1.25}.item small{display:block;color:var(--mute);font-size:.95rem;line-height:1.4;margin-top:3px}
.item .aka{display:block;color:var(--sun);font-weight:700;font-size:1rem;line-height:1.3;margin-top:3px}
.total{display:flex;justify-content:space-between;align-items:baseline;margin-top:4px;padding-top:10px;border-top:1.5px dashed var(--line);font-family:var(--mono);color:var(--mute);font-size:1rem}
.total b{font-family:var(--display);font-weight:400;color:var(--sun);font-size:1.5rem}
.pay,.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:60px;padding:16px;border-radius:18px;border:0;text-decoration:none;cursor:pointer;
 color:var(--void);font-family:var(--display);font-weight:400;font-size:1.3rem;letter-spacing:.02em;background:var(--grad);box-shadow:0 12px 36px -12px rgba(255,60,172,.75);margin:14px 0 8px}
.pay{font-size:1.45rem;min-height:68px}
.btn.cool{background:var(--cyan);box-shadow:0 12px 36px -14px rgba(42,245,228,.7)}
.btn.ghost{background:rgba(9,1,15,.6);color:var(--cyan);border:2px solid var(--cyan);box-shadow:none;font-size:1.1rem;min-height:54px}
.pay:active,.btn:active{transform:scale(.98)}
.btn small{font-family:var(--mono);font-size:.95rem;letter-spacing:0}
.fine{font-family:var(--mono);font-size:.95rem;line-height:1.45;color:var(--mute);letter-spacing:0;margin:8px 0}
.pickup{margin:12px 0 4px;padding:12px 14px;border-radius:16px;border:1.5px solid var(--line-2);background:rgba(42,245,228,.07);font-weight:700;font-size:1.06rem;line-height:1.4}
.pickup small{display:block;font-family:var(--mono);font-weight:500;font-size:.95rem;letter-spacing:.08em;color:var(--cyan);margin-bottom:3px}
.ticket{display:inline-block;font-family:var(--display);font-size:3.4rem;line-height:1;letter-spacing:.06em;color:#fff;padding:14px 26px;border-radius:20px;border:2px solid var(--sun);
 background:rgba(9,1,15,.75);text-shadow:0 0 16px rgba(255,209,102,.7);margin:4px 0 6px}
.ticket small{display:block;font-family:var(--mono);font-size:.95rem;letter-spacing:.14em;color:var(--mute);text-shadow:none;margin-bottom:6px}
.nick{margin:8px 0 2px;padding:12px 14px;border-radius:16px;border:1.5px solid rgba(255,209,102,.6);background:rgba(255,209,102,.08);line-height:1.35}
.nick small{display:block;font-family:var(--mono);font-size:.95rem;color:var(--mute);margin-bottom:4px}
.nick b{display:block;font-family:var(--display);font-weight:400;font-size:1.35rem;color:var(--sun);text-shadow:0 0 14px rgba(255,209,102,.45)}
.funny{min-height:3.2em;font-size:1.15rem;line-height:1.4;margin:14px 6px;color:var(--fg);transition:opacity .35s}
.funny.fade{opacity:0}
.dots i{display:inline-block;width:10px;height:10px;margin:0 4px;border-radius:50%;background:var(--cyan);animation:b 1.2s infinite ease-in-out}
.dots i:nth-child(2){animation-delay:.15s;background:var(--magenta)}.dots i:nth-child(3){animation-delay:.3s;background:var(--sun)}
@keyframes b{0%,80%,100%{transform:scale(.5);opacity:.4}40%{transform:scale(1);opacity:1}}
.ready h1{color:var(--green);font-size:2.4rem;text-shadow:0 0 22px rgba(59,224,138,.85)}
.ready .ticket{border-color:var(--green);text-shadow:0 0 18px rgba(59,224,138,.9);animation:pop 1.4s ease-in-out infinite}
@keyframes pop{0%,100%{transform:scale(1);box-shadow:0 0 0 rgba(59,224,138,0)}50%{transform:scale(1.04);box-shadow:0 0 44px rgba(59,224,138,.55)}}
.bad h1{color:#FF7CC4;text-shadow:0 0 16px rgba(255,60,172,.6)}
.muted h1{color:var(--fg);text-shadow:none}
.check{width:74px;height:74px;border-radius:50%;margin:6px auto 0;display:flex;align-items:center;justify-content:center;font-size:42px;color:var(--void);background:var(--green);box-shadow:0 0 30px rgba(59,224,138,.6)}
.hide{display:none!important}
.extras{margin:6px 0 0}
.extras .thx{display:block;color:var(--mute);font-size:1rem;margin:6px 0 10px}
.rv{margin:14px 0 4px}
.rv a{display:inline-flex;align-items:center;min-height:48px;text-decoration:none;font-weight:700;font-size:1.05rem;color:var(--sun);padding:10px 22px;border-radius:999px;
 border:1.5px solid rgba(255,209,102,.7);background:rgba(255,209,102,.08)}
.rv.soft a{border:0;background:none;padding:6px 8px;font-weight:600;font-size:1rem;color:var(--mute);text-decoration:underline;text-underline-offset:3px}
.rv .thx{color:var(--mute);font-size:1rem}
.or{display:block;margin:4px 0;color:var(--mute);font-size:1rem}
@media (prefers-reduced-motion:reduce){.dots i,.ready .ticket{animation:none}}
</style>
</head>
<body>
<div class="app" id="app">
  <img class="logo" src="/assets/logo-480.webp?v=logo20261018" alt="Thirsty Beaches" width="210" height="140">
  <div id="view"></div>
</div>
<script>
/* Funny lines: edit them in cloud/src/funny-lines.js (this copy is injected from there). */
const READY_LINES = ${safeJson(READY_LINES)};
const MAKING_LINES = ${safeJson(MAKING_LINES)};
const fillLine = ${fillLine.toString()};
let S = ${safeJson(view)};
const REVIEW_URL = ${safeJson(reviewUrl)};
const PUNCH_ON = ${punchOn ? "true" : "false"};             // PUNCH_KEY set: paid orders get an "Add my punch" link
const SITE = "https://thirstybeaches.com";
const POLL_MS = 4000, READY_STOP_MS = 30 * 60000;
const q = new URLSearchParams(location.search);
const back = q.get("paid") === "1" ? "paid" : q.get("failed") === "1" ? "failed" : "";
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money = c => "$" + (c / 100).toFixed(2);
let lastPick = {}, funnyTimer = null, pollTimer = null, shownStatus = "", buzzed = false, started = Date.now();

function pick(list, key){
  if(!list.length) return "";
  let i = Math.floor(Math.random() * list.length);
  if(list.length > 1 && i === lastPick[key]) i = (i + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length;   // never the same line twice in a row
  lastPick[key] = i;
  return fillLine(list[i], S && S.name);
}
/* "Order ahead" orders (from /order): where to collect it. */
function pickupHtml(){
  if(!S || !S.online) return "";
  const at = S.pickup ? " at " + esc(S.pickup) : "";
  return '<div class="pickup" id="pickup"><small>ORDERED AHEAD</small>Pick up at the window' + at + '. We\u2019ll call your name.</div>';
}
/* Match My Vibe's funny name rides on a line as an "AKA <name>" mod: show it as the drink's nickname, never as a raw mod. */
const isAka = m => /^AKA /.test(String(m));
const akaOf = it => { const m = (it.mods || []).find(isAka); return m ? String(m).slice(4) : ""; };
function nickname(){ for(const it of (S && S.items) || []){ const a = akaOf(it); if(a) return a; } return ""; }
function nickHtml(){
  const n = nickname(); if(!n) return "";
  return '<div class="nick"><small>' + (S.name ? esc(S.name) + ', your drink goes by' : 'Your drink goes by') + '</small><b>\u201c' + esc(n) + '\u201d</b></div>';
}
function itemsHtml(){
  const rows = (S.items || []).map(it => { const mods = (it.mods || []).filter(m => !isAka(m)), aka = akaOf(it);
    return '<div class="item"><span class="q">' + esc(it.qty) + '&times;</span><div><b>' + esc(it.name) + '</b>' +
    (aka ? '<span class="aka">aka \u201c' + esc(aka) + '\u201d</span>' : '') +
    (mods.length ? '<small>' + esc(mods.join(" · ")) + '</small>' : '') + '</div></div>'; }).join("");
  return '<div class="card">' + rows + '<div class="total"><span>Total</span><b>' + money(S.total) + '</b></div></div>' + pickupHtml();
}
/* Review ask: once per order. Tapping it hides it for this order, and for 120 days on this phone. */
function store(k, v){ try{ if(v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); }catch(e){ return null; } }
function reviewSlot(soft){
  const el = $("#rv"); if(!el || !REVIEW_URL || !S) return;
  const recent = +store("tb-review-at") || 0;
  if(store("tb-review-" + S.ref) || (recent && Date.now() - recent < 120 * 864e5)) return;
  el.className = "rv" + (soft ? " soft" : "");
  el.innerHTML = '<a href="' + esc(REVIEW_URL) + '" target="_blank" rel="noopener noreferrer">' +
    'Loved it? Leave us a review \u2b50</a>';
  el.firstChild.addEventListener("click", () => {
    store("tb-review-" + S.ref, "1"); store("tb-review-at", String(Date.now()));
    setTimeout(() => { el.className = "rv"; el.innerHTML = '<span class="thx">Thank you! That really helps a small beach business. \ud83d\udc9b</span>'; }, 300);
  });
}
/* "Share my drink": the phone's share sheet when there is one, else copy to the clipboard. */
function shareText(){
  const n = nickname(), first = ((S && S.items) || [])[0];
  if(n) return "Meet \u201c" + n + "\u201d, my drink from Thirsty Beaches. Stay thirsty, beaches! \ud83c\udf34";
  return "Sipping " + (first ? "a " + first.name : "something cold") + " from Thirsty Beaches. Stay thirsty, beaches! \ud83c\udf34";
}
function copyText(t){
  if(navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
  return new Promise((ok, no) => { try{ const a = document.createElement("textarea"); a.value = t; a.setAttribute("readonly", ""); a.style.position = "fixed"; a.style.opacity = "0";
    document.body.appendChild(a); a.select(); const r = document.execCommand("copy"); a.remove(); r ? ok() : no(); }catch(e){ no(e); } });
}
async function shareDrink(btn){
  const text = shareText();
  if(navigator.share){
    try{ await navigator.share({ title: "Thirsty Beaches", text: text, url: SITE }); return; }
    catch(e){ if(e && e.name === "AbortError") return; }
  }
  try{ await copyText(text + " " + SITE); btn.textContent = "Copied! Paste it anywhere"; }
  catch(e){ btn.textContent = "Couldn\u2019t copy, sorry"; }
  setTimeout(() => { btn.textContent = "Share my drink"; }, 3000);
}
/* "Add my punch": the station signs a one-time punch-card link for this paid order (GET /api/qr/<ref>/punch). */
let punch = null, punchAsked = false;
async function loadPunch(){
  if(!PUNCH_ON || punchAsked || !S) return;
  punchAsked = true;
  try{
    const r = await fetch("/api/qr/" + encodeURIComponent(S.ref) + "/punch", { cache: "no-store" });
    if(r.ok){ const d = await r.json(); if(d && typeof d.url === "string" && d.url.indexOf(SITE + "/card?claim=") === 0) punch = d; }
  }catch(e){ punchAsked = false; }
  extrasSlot();
}
function extrasSlot(){
  const el = $("#extras"); if(!el || !S) return;
  let h = "";
  if(punch){
    const done = store("tb-punch-" + S.ref);
    h += '<a class="btn cool" id="punchBtn" href="' + esc(punch.url) + '" target="_blank" rel="noopener">' + (done ? "Open my punch card" : "Add my punch" + (punch.drinks > 1 ? "es" : "")) +
      ' <small>+' + esc(punch.drinks) + '</small></a>';
  }
  h += '<button class="btn ghost" id="shareBtn" type="button">Share my drink</button>';
  el.innerHTML = h;
  const pb = $("#punchBtn"); if(pb) pb.addEventListener("click", () => store("tb-punch-" + S.ref, "1"));
  const sb = $("#shareBtn"); sb.addEventListener("click", () => shareDrink(sb));
}
const againHtml = '<a class="btn" href="/order">Order on your phone</a><span class="or">or order at the window</span>';
function render(){
  const st = !S ? "missing" : S.status;
  const key = st + "|" + back + "|" + (S && S.ticket);
  if(key === shownStatus) return;
  shownStatus = key;
  clearInterval(funnyTimer); funnyTimer = null;
  const v = $("#view"); const app = $("#app");
  app.className = "app" + (st === "ready" ? " ready" : st === "expired" || st === "missing" ? " muted" : st === "pending" && back === "failed" ? " bad" : "");
  if(st === "missing"){
    document.title = "Order not found · Thirsty Beaches";
    v.innerHTML = '<h1>Hmm, no order here</h1><p class="sub">This link doesn\\u2019t match an order. Scan the code on the kiosk again, or start a new one.</p>' + againHtml;
  } else if(st === "pending"){
    const who = S.name ? esc(S.name) + ", here\\u2019s" : "Here\\u2019s";
    if(back === "paid"){
      document.title = "Confirming payment · Thirsty Beaches";
      v.innerHTML = '<h1>Confirming your payment</h1><p class="sub">Hang tight, this takes a few seconds.</p><div class="dots"><i></i><i></i><i></i></div>' + itemsHtml();
    } else {
      const failed = back === "failed";
      document.title = (failed ? "Payment didn\\u2019t go through" : "Pay " + money(S.total)) + " · Thirsty Beaches";
      v.innerHTML = (failed
          ? '<h1>Payment didn\\u2019t go through</h1><p class="sub">No worries, nothing was charged. Give it another try.</p>'
          : '<h1>Almost yours</h1><p class="sub">' + who + ' your order.</p>') + itemsHtml() +
        '<a class="pay" id="payBtn" href="' + esc(S.href) + '" rel="noreferrer">' + (failed ? "Try again \\u00b7 " : "Pay ") + money(S.total) + '</a>' +
        '<div class="fine">Apple Pay, Google Pay or card &middot; Secure checkout by Clover</div>' +
        '<p class="fine" id="left"></p>';
      tickLeft();
    }
  } else if(st === "paid"){
    document.title = "Paid! Order #" + S.ticket + " · Thirsty Beaches";
    v.innerHTML = '<div class="check">&#10003;</div><h1>Paid! We\\u2019re making it</h1>' +
      '<div class="ticket"><small>ORDER</small>#' + esc(S.ticket) + '</div>' +
      nickHtml() + '<p class="funny" id="funny"></p><div class="dots"><i></i><i></i><i></i></div>' + itemsHtml() +
      '<p class="fine">Keep this page open. It turns green when it\\u2019s ready.</p><div class="extras" id="extras"></div><div id="rv"></div>';
    reviewSlot(true); extrasSlot(); loadPunch();
    const f = $("#funny"); f.textContent = pick(MAKING_LINES, "m");
    funnyTimer = setInterval(() => { f.classList.add("fade"); setTimeout(() => { f.textContent = pick(MAKING_LINES, "m"); f.classList.remove("fade"); }, 350); }, 6000);
  } else if(st === "ready"){
    document.title = "\\u2705 READY! Order #" + S.ticket + " · Thirsty Beaches";
    v.innerHTML = '<h1>Ready at the window!</h1><p class="funny" id="funny"></p>' +
      '<div class="ticket"><small>SHOW THIS</small>#' + esc(S.ticket) + '</div>' + nickHtml() + itemsHtml() + '<div class="extras" id="extras"></div><div id="rv"></div>';
    reviewSlot(false); extrasSlot(); loadPunch();
    $("#funny").textContent = pick(READY_LINES, "r");
    if(!buzzed){ buzzed = true; try{ navigator.vibrate && navigator.vibrate([300, 120, 300, 120, 600]); }catch(e){} }
  } else if(st === "expired"){
    document.title = "Checkout expired · Thirsty Beaches";
    v.innerHTML = '<h1>This checkout expired</h1><p class="sub">Nothing was charged. Start a new order and it\\u2019s yours in a few taps.</p>' + againHtml;
  }
}
function tickLeft(){
  const el = $("#left"); if(!el || !S || S.status !== "pending") return;
  const ms = S.expires - Date.now();
  if(ms <= 0){ el.textContent = "This checkout link has timed out."; const b = $("#payBtn"); if(b) b.classList.add("hide"); return; }
  const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60;
  el.textContent = "Link good for " + m + ":" + String(s).padStart(2, "0");
}
setInterval(tickLeft, 1000);
async function poll(){
  if(!S) return;
  try{
    const r = await fetch("/api/qr/" + encodeURIComponent(S.ref), { cache: "no-store" });
    if(r.ok){ const d = await r.json(); if(d && d.status){ S = d; render(); } }
  }catch(e){}
  const stopReady = S.status === "ready" && S.readyAt && Date.now() - S.readyAt > READY_STOP_MS;
  if(S.status === "expired" || stopReady || Date.now() - started > 6 * 3600000) return;
  pollTimer = setTimeout(poll, POLL_MS);
}
render();
if(S) pollTimer = setTimeout(poll, S.status === "pending" && back === "paid" ? 1500 : POLL_MS);
</script>
</body>
</html>`;
}
