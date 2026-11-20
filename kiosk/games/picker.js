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
})();
