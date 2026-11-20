/* Picker page: shows each game's own best score (device-only, read from localStorage; nothing is sent anywhere). Plain script, no inline code. */
(function () {
  'use strict';
  var tiles = document.querySelectorAll('.pk-tile[data-best]');
  Array.prototype.forEach.call(tiles, function (t) {
    var key = t.getAttribute('data-best'), out = t.querySelector('.pk-best');
    if (!key || !out) return;
    try {
      var v = parseInt(window.localStorage.getItem(key), 10);
      if (v > 0) out.textContent = 'Best ' + v;
    } catch (e) { /* storage blocked: no best shown */ }
  });

  /* /arcade/games?touchdebug=1 : a small overlay that prints every touch contact's size (CSS px), so the palm threshold (TBK.isStray, 220) can be tuned on the real panel without a debugger.
     Display only: nothing is stored or sent. */
  if (/[?&]touchdebug=1(?:&|$)/.test(window.location.search)) {
    var box = document.createElement('div'), big = 0, n = 0;
    box.style.cssText = 'position:fixed;left:8px;top:8px;z-index:9999;background:rgba(0,0,0,.85);color:#7dffb0;font:20px/1.3 monospace;padding:8px 12px;border-radius:8px;pointer-events:none;white-space:pre';
    box.textContent = 'touchdebug: touch the panel';
    document.body.appendChild(box);
    var seen = function (e) {
      if (e.pointerType !== 'touch') return;
      var w = Math.round(e.width), h = Math.round(e.height); big = Math.max(big, w, h); n++;
      box.textContent = 'touchdebug  contact ' + w + ' x ' + h + ' px (id ' + e.pointerId + ')\nlargest so far ' + big + ' px   events ' + n + '   palm limit 220';
    };
    document.addEventListener('pointerdown', seen, true); document.addEventListener('pointermove', seen, true);
  }
})();
