/* "Order ahead" phone mode, part 1 of 2: runs BEFORE the kiosk page's own script.
   build.js puts this into public/order.html (= drink-kiosk.html + this + order-post.js + order.css).
   The kiosk script talks to the trailer PC's local server (/control, /version, /payconfig, /order,
   /mix, /vibe, /aiconfig, /prize...). On the phone there is no local server: answer those here so
   the kiosk code takes its built-in "feature off" paths, and send the sold-out list and phone pay
   to the station Worker this page is served from. */
(function(){
  window.TB_PHONE = true;
  var STATION = "https://station.thirstybeaches.com";
  var of = window.fetch;
  function reply(obj, status){
    return Promise.resolve(new Response(JSON.stringify(obj), { status: status || 200, headers: { "content-type": "application/json" } }));
  }
  window.fetch = function(input, opts){
    try{
      if(typeof input === "string"){
        if(input.indexOf(STATION + "/") === 0) input = input.slice(STATION.length);          // same Worker; also works on test hosts
        var path = input.split("?")[0];
        if(path.charAt(0) === "/" && path.indexOf("/api/") !== 0){
          if(path === "/control") return of.call(this, "/api/control", { cache: "no-store" });   // sold out + specials
          if(path === "/version") return reply({ v: "phone" });                            // never auto-reload a customer's page
          if(path === "/payconfig" || path === "/aiconfig") return reply({ enabled: false }); // no card reader, no AI helpers
          return reply({ error: "not-on-phone", ai: false, ok: false }, 404);              // /order, /pay, /prize, /mix, /vibe, /menu...
        }
      }
    }catch(e){}
    return opts === undefined ? of.call(this, input) : of.call(this, input, opts);
  };
})();
