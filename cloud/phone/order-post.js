/* "Order ahead" phone mode, part 2 of 2: runs AFTER the kiosk page's own script (see build.js).
   The menu, prices, options, upsells, Secret menu, specials and sold-out greying are the kiosk's own
   code, untouched. This only swaps the parts that make no sense on a customer's phone:
   - no attract screen and no idle reset (it's their phone, not a shared screen);
   - no camera / AI helpers (they need the trailer PC) and no prize-code keypad (use it at the window);
   - the name is typed with the phone's own keyboard and is required ("we'll call it out");
   - the only way to pay is Clover Hosted Checkout: the cart goes to POST /api/qr with
     source:"online", the Worker re-prices every line, and the phone goes straight to Clover, which
     sends it back to the tracker (/r/<ref>) after paying;
   - orders are only taken while the trailer is live and Order ahead is switched on (GET /api/order-ahead);
     otherwise the menu stays browsable and checkout explains why.                                 */
(function(){
  "use strict";
  var OA_API = "/api/order-ahead";
  var SIGNUP_URL = "https://thirstybeaches.com/#stops";
  var LAST_KEY = "tb-oa-last";
  var OA = { known: false, enabled: false, open: false, label: "", maxItems: 8, failed: false };
  var esc = typeof escK === "function" ? escK : function(s){ return String(s == null ? "" : s); };
  function store(k, v){ try{ if(v === undefined) return localStorage.getItem(k); if(v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }catch(e){ return null; } }
  function canOrder(){ return OA.known && OA.enabled && OA.open; }

  document.documentElement.classList.add("phone");
  document.title = "Order ahead · Thirsty Beaches";

  /* ---- shared-screen behaviour off ---- */
  window.armIdle = function(){};
  window.idleReset = function(){};
  clearTimeout(window.idleTimer);
  window.vibeStart = window.snapStart = window.openDesignDrink = function(){};
  window.askPrize = function(){ showToast("Got a Thirsty Maze code? Show it at the window when you pick up."); };

  /* The page scrolls instead of the kiosk's menu panel: a new category starts at its title. */
  var kioskSelectCat = window.selectCat;
  window.selectCat = function(k){
    kioskSelectCat(k);
    var m = document.getElementById("specials-section"), menu = document.getElementById("menu");
    var top = (m && m.style.display !== "none" ? m : menu).getBoundingClientRect().top + window.scrollY - 124;
    if(window.scrollY > top) window.scrollTo(0, Math.max(0, top));
  };

  /* ---- status banner under the header ---- */
  var banner = document.createElement("div");
  banner.id = "oaBanner"; banner.className = "oa-banner"; banner.setAttribute("role", "status"); banner.hidden = true;
  var hdr = document.querySelector(".app header");
  if(hdr) hdr.insertAdjacentElement("afterend", banner);

  function lastOrder(){
    try{ var d = JSON.parse(store(LAST_KEY) || "null"); if(d && /^[A-Z0-9]{8}$/.test(d.ref) && Date.now() - d.at < 4 * 3600000) return d; }catch(e){}
    return null;
  }
  function renderBanner(){
    var last = lastOrder(), html = "", cls = "oa-banner";
    if(last) html += '<a class="oa-track" href="/r/' + last.ref + '">Track your last order &rarr;</a>';
    if(!OA.known){ /* first check still running */ }
    else if(!OA.enabled){ cls += " off"; html += '<p><b>Ordering ahead is off right now.</b> Have a look at the menu and order at the window.</p>'; }
    else if(!OA.open){ cls += " off"; html += '<p><b>We’re not pouring right now.</b> Browse the menu, and <a href="' + SIGNUP_URL + '">get a text when we roll up</a>.</p>'; }
    else html += '<p class="oa-open"><span class="oa-dot"></span>Open' + (OA.label ? ' at ' + esc(OA.label) : ' now') + ' &middot; order here, pick up at the window</p>';
    banner.className = cls;
    banner.innerHTML = html;
    banner.hidden = !html;
  }

  /* ---- is Order ahead on and the trailer live? (replaces the kiosk's "is phone pay on?" probe) ---- */
  var probing = null;
  async function oaProbe(){
    if(probing) return probing;
    probing = (async function(){
      var before = canOrder() + "|" + OA.label + "|" + OA.enabled + "|" + OA.known;
      try{
        var r = await qrFetch(OA_API, {}, 8000);
        var d = await r.json();
        if(!r.ok) throw new Error("HTTP " + r.status);
        OA.enabled = !!d.enabled; OA.open = !!d.open; OA.label = typeof d.label === "string" ? d.label : "";
        if(d.maxItems > 0) OA.maxItems = d.maxItems;
        OA.failed = false;
      }catch(e){ OA.enabled = OA.enabled && OA.known; OA.open = false; OA.failed = true; }
      OA.known = true;
      renderBanner();
      var after = canOrder() + "|" + OA.label + "|" + OA.enabled + "|" + OA.known;
      if(before !== after && isNamePadOpen()) renderNamePad();
    })();
    try{ await probing; } finally { probing = null; }
  }
  window.qrProbe = oaProbe;
  window.qrShown = function(){ return false; };

  /* ---- name + pay step ---- */
  function isNamePadOpen(){ return !!document.getElementById("phName") && document.getElementById("overlay").classList.contains("show"); }
  function cleanName(s){ return String(s || "").replace(/[^\p{L}\p{N} .'\-]/gu, "").replace(/\s{2,}/g, " ").replace(/^\s+/, "").slice(0, 22); }
  function itemCount(){ return cart.reduce(function(a, c){ return a + c.qty; }, 0); }

  window.renderNamePad = function(){
    var sub = cartTotals().sub, n = itemCount();
    var foot;
    if(!OA.known){
      foot = '<div class="sheet-ft"><button class="linkbtn" onclick="openCart()">Back</button><button class="btn-primary disabled" id="placeBtn">Checking if we’re open…</button></div>';
    } else if(!canOrder()){
      var why = !OA.enabled
        ? '<b>Ordering ahead is off right now.</b> Order at the window and we’ll make it just the same.'
        : '<b>We’re not pouring right now.</b> Checkout opens the moment the trailer is live. <a href="' + SIGNUP_URL + '">Get a text when we roll up</a>.';
      foot = '<div class="oa-closed" id="oaClosed"><p>' + why + '</p></div><div class="sheet-ft"><button class="linkbtn" onclick="openCart()">Back</button>' +
        '<button class="btn-primary disabled" id="placeBtn" aria-disabled="true">Checkout is closed</button></div>';
    } else if(n > OA.maxItems){
      foot = '<div class="oa-closed"><p><b>Online orders are up to ' + OA.maxItems + ' items.</b> Take a few out, and order the rest at the window.</p></div>' +
        '<div class="sheet-ft"><button class="linkbtn" onclick="openCart()">Back</button><button class="btn-primary disabled" id="placeBtn" aria-disabled="true">Too many items</button></div>';
    } else {
      foot = '<div class="sheet-ft payfork"><button class="linkbtn" onclick="openCart()">Back</button><div class="payfork-btns">' +
        '<button class="btn-primary" id="placeBtn" onclick="startOnline()"><span class="pf-t">Pay $' + sub.toFixed(2) + '</span><span class="pf-s">Apple Pay &middot; Google Pay &middot; card</span></button>' +
        '</div></div>';
    }
    $("#sheet").innerHTML =
      '<div class="sheet-hd"><div><h3>Whose order is this?</h3><p>We’ll call it out at the window when it’s ready.</p></div>' +
      '<button class="close" onclick="closeSheet()" aria-label="Close">✕</button></div>' +
      '<div class="ph-namewrap"><label class="ph-lbl" for="phName">Your name</label>' +
      '<input id="phName" class="ph-name" type="text" maxlength="22" autocomplete="given-name" autocapitalize="words" autocorrect="off" spellcheck="false" enterkeyhint="done" placeholder="First name" required aria-describedby="phNameHint">' +
      '<p class="ph-hint" id="phNameHint"></p>' +
      '<button class="beachname" type="button" onclick="beachName()">Surprise me with a beach name</button>' +
      (canOrder() ? '<p class="ph-pickup">Pick up at the window' + (OA.label ? ' at <b>' + esc(OA.label) + '</b>' : '') + '. Pay now, skip the line.</p>' : '') +
      '</div>' + foot;
    var inp = $("#phName");
    inp.value = _orderName;
    inp.addEventListener("input", function(){
      var v = cleanName(inp.value);
      if(v !== inp.value) inp.value = v;
      _orderName = v; window.refreshName();
      if(v.trim()){ inp.classList.remove("bad"); var h = $("#phNameHint"); if(h) h.textContent = ""; }
    });
    inp.addEventListener("keydown", function(e){ if(e.key === "Enter"){ e.preventDefault(); inp.blur(); } });
    window.refreshName();
  };
  window.askName = function(){ renderNamePad(); $("#overlay").classList.add("show"); };
  window.refreshName = function(){
    var inp = $("#phName");
    if(inp && inp.value !== _orderName && document.activeElement !== inp) inp.value = _orderName;
    var pb = $("#placeBtn");
    if(pb && pb.getAttribute("onclick")) pb.classList.toggle("needname", !_orderName.trim());   // still tappable: says what's missing
  };

  function payBtnBusy(text){
    var pb = $("#placeBtn"); if(!pb) return;
    pb.classList.add("disabled");
    var t = pb.querySelector(".pf-t"); if(t) t.textContent = text;
  }
  function needName(){
    var inp = $("#phName"), h = $("#phNameHint");
    if(h) h.textContent = "Add your name so we can call it out.";
    if(inp){ inp.classList.add("bad"); inp.focus(); }
  }

  window.startOnline = async function(){
    if(orderInFlight || !cart.length) return;
    var name = _orderName.trim();
    if(!name){ needName(); return; }
    if(!canOrder()){ renderNamePad(); return; }
    orderInFlight = true;
    payBtnBusy("Opening secure checkout…");
    var st = 0, d = null;
    try{
      var r = await qrFetch("/api/qr", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "online", name: name,
          lines: cart.map(function(c){ return { name: c.name, unit: c.unit, qty: c.qty, mods: c.mods, catKey: c.catKey }; }) }) }, 20000);
      st = r.status; d = await r.json();
    }catch(e){}
    var href = d && d.checkoutUrl, okHost = false;
    try{ var u = new URL(href); okHost = u.protocol === "https:" && (u.hostname === "clover.com" || /\.clover\.com$/.test(u.hostname)); }catch(e){}
    if(st === 200 && d && d.ref && okHost){
      store(LAST_KEY, JSON.stringify({ ref: d.ref, at: Date.now() }));
      recordSales(cart);
      location.assign(href);                        // Clover brings them back to /r/<ref>, the tracker
      return;                                       // (orderInFlight stays set until the page goes)
    }
    orderInFlight = false;
    var err = (d && d.error) || "";
    console.warn("Order ahead refused:", st, err);
    if(err === "closed"){ OA.open = false; renderBanner(); renderNamePad(); showToast("We just stopped pouring. Nothing was charged."); return; }
    if(err === "order-ahead-off" || err === "qr-off"){ OA.enabled = false; renderBanner(); renderNamePad(); showToast("Ordering ahead just switched off. Nothing was charged."); return; }
    if(err === "name-required"){ renderNamePad(); needName(); return; }
    if(err === "sold-out"){
      try{ await checkControl(); }catch(e){}
      openCart();
      showToast((d.item ? d.item : "Something in your order") + " just sold out. Swap it for something else.");
      return;
    }
    if(err === "too-big"){ renderNamePad(); showToast(d.max ? "Online orders are up to " + d.max + " items." : "That order is too big for online. Order the rest at the window."); return; }
    if(err === "rate-limited"){ renderNamePad(); showToast("That’s a lot of orders from this phone. Try again in a bit, or order at the window."); return; }
    if(err === "price-mismatch" || err === "unknown-item" || err === "unknown-modifier"){
      openCart(); showToast("The menu just changed. Reload the page and add that drink again."); return;
    }
    renderNamePad();
    showToast("Couldn’t open checkout. Try again, or order at the window.");
  };
  window.placeOrder = window.startOnline;          // nothing on the phone may reach the kiosk's /order
  window.startQr = window.startOnline;

  /* Back from the Clover page with the browser's back button: the page may come back frozen mid-"opening". */
  window.addEventListener("pageshow", function(e){
    if(e.persisted){ orderInFlight = false; renderBanner(); if(isNamePadOpen()) renderNamePad(); oaProbe(); }
  });
  document.addEventListener("visibilitychange", function(){ if(document.visibilityState === "visible") oaProbe(); });

  renderBanner();
  oaProbe();
  setInterval(oaProbe, 60000);
})();
