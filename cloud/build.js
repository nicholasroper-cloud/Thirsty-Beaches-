#!/usr/bin/env node
/* Builds ./public for the Worker from the station files one level up (the repo root):
   make-station.html -> public/index.html, pickup-board.html -> public/board.html,
   recipes.json, addons.json, assets/logo.png, and src/kiosk-menu.js (phone-pay prices) from
   drink-kiosk.html. Adds the access key plumbing: the page
   reads ?k=... from its own address once, remembers it, and sends it on every data call. */
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const pub = path.join(__dirname, "public");
fs.mkdirSync(path.join(pub, "assets"), { recursive: true });

// "Pay on my phone" price book: read straight from the kiosk page's menu (fails the build if it can't).
require("./menu-from-kiosk.js").writeMenu(root);

const keyShim = `<script>
(function(){try{var u=new URL(location.href);var k=u.searchParams.get('k');if(k){localStorage.setItem('tb-key',k);}
var K=localStorage.getItem('tb-key')||'';var of=window.fetch;window.fetch=function(i,o){try{if(typeof i==='string'&&/^\\/(queue|done|undo)\\b/.test(i)){i+=(i.indexOf('?')<0?'?':'&')+'k='+encodeURIComponent(K);}}catch(e){}return of.call(this,i,o);};
if(k){history.replaceState(null,'',u.pathname+u.hash);}}catch(e){}})();
</script>`;

function page(src, dst) {
  let h = fs.readFileSync(path.join(root, src), "utf8");
  const i = h.lastIndexOf("<script>");                                              // the page's main script is the last one
  h = h.slice(0, i) + keyShim + "\n" + h.slice(i);
  if (!h.includes("tb-key")) throw new Error("key shim not inserted into " + src);
  // The pages themselves show "Need the access key" only on a 401. A dropped connection keeps its own message;
  // in the cloud there is no kiosk PC, so reword that one for the station.
  h = h.replace("Make Station server not reachable. Is the kiosk PC on and on the same Wi-Fi?", "Can’t reach the station online. Check the Wi-Fi or mobile data.");
  fs.writeFileSync(path.join(pub, dst), h);
}
page("make-station.html", "index.html");
page("pickup-board.html", "board.html");
for (const f of ["recipes.json"]) fs.copyFileSync(path.join(root, f), path.join(pub, f));
const addons = [path.join(root, "addons.json"), path.join(root, "..", "addons.json")].find(f => fs.existsSync(f));
if (addons) fs.copyFileSync(addons, path.join(pub, "addons.json"));
for (const name of ["logo.png", "icon-192.png", "icon-512.png", "icon-maskable.png"]) {
  fs.copyFileSync(path.join(root, "assets", name), path.join(pub, "assets", name));
}

// bump PAGE_VERSION in wrangler.toml so open screens reload themselves after a deploy
const tomlPath = path.join(__dirname, "wrangler.toml");
let toml = fs.readFileSync(tomlPath, "utf8");
toml = toml.replace(/PAGE_VERSION = "(\d+)"/, (m, v) => `PAGE_VERSION = "${+v + 1}"`);
fs.writeFileSync(tomlPath, toml);
console.log("public/ built; PAGE_VERSION ->", (toml.match(/PAGE_VERSION = "(\d+)"/) || [])[1]);
