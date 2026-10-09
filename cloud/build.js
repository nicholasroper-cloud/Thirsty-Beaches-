#!/usr/bin/env node
/* Builds ./public for the Worker from the station files one level up (the repo root):
   make-station.html -> public/index.html, pickup-board.html -> public/board.html,
   recipes.json, addons.json, assets/logo.png. Adds the access key plumbing: the page
   reads ?k=... from its own address once, remembers it, and sends it on every data call. */
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const pub = path.join(__dirname, "public");
fs.mkdirSync(path.join(pub, "assets"), { recursive: true });

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
  // 401 (missing key) -> clear message instead of "server not reachable"
  h = h.replace("Make Station server not reachable. Is the kiosk PC on and on the same Wi-Fi?", "Need the access key. Open the station from the link with ?k= on the end.");
  h = h.replace("Board can’t reach the station. Check the Wi-Fi.", "Need the access key. Open the board from the link with ?k= on the end.");
  fs.writeFileSync(path.join(pub, dst), h);
}
page("make-station.html", "index.html");
page("pickup-board.html", "board.html");
for (const f of ["recipes.json"]) fs.copyFileSync(path.join(root, f), path.join(pub, f));
const addons = [path.join(root, "addons.json"), path.join(root, "..", "addons.json")].find(f => fs.existsSync(f));
if (addons) fs.copyFileSync(addons, path.join(pub, "addons.json"));
fs.copyFileSync(path.join(root, "assets", "logo.png"), path.join(pub, "assets", "logo.png"));

// bump PAGE_VERSION in wrangler.toml so open screens reload themselves after a deploy
const tomlPath = path.join(__dirname, "wrangler.toml");
let toml = fs.readFileSync(tomlPath, "utf8");
toml = toml.replace(/PAGE_VERSION = "(\d+)"/, (m, v) => `PAGE_VERSION = "${+v + 1}"`);
fs.writeFileSync(tomlPath, toml);
console.log("public/ built; PAGE_VERSION ->", (toml.match(/PAGE_VERSION = "(\d+)"/) || [])[1]);
