#!/usr/bin/env node
/* Builds ./public for the Worker from the station files one level up (the repo root):
   make-station.html -> public/index.html, pickup-board.html -> public/board.html,
   recipes.json, addons.json, assets/logo.png, and src/kiosk-menu.js (phone-pay prices) from
   drink-kiosk.html, plus public/order.html ("Order ahead": the kiosk page in phone mode). Adds the access key plumbing: the page
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

// "Order ahead": public/order.html = the kiosk page itself in phone mode, so the menu, prices, options,
// upsells, Secret menu, specials and sold-out greying are exactly the kiosk's. phone/order-pre.js runs
// before the kiosk script (answers the trailer-PC-only endpoints), phone/order-post.js after it (name +
// Clover checkout + open/closed), phone/order.css on top of the kiosk styles. See src/order-ahead.js.
function orderPage() {
  let h = fs.readFileSync(path.join(root, "drink-kiosk.html"), "utf8");
  const read = f => fs.readFileSync(path.join(__dirname, "phone", f), "utf8");
  // the kiosk functions phone mode replaces or calls; if one is renamed, stop the build instead of shipping a broken page
  for (const fn of ["renderNamePad", "refreshName", "askName", "placeOrder", "startQr", "qrProbe", "qrShown", "qrFetch", "askPrize", "idleReset",
    "armIdle", "openCart", "closeSheet", "selectCat", "checkControl", "applyControl", "showToast", "cartTotals", "recordSales", "beachName", "escK"])
    if (!new RegExp("\\bfunction " + fn + "\\(").test(h)) throw new Error("order.html: kiosk function " + fn + "() not found");
  for (const v of ["let orderInFlight", "let _orderName", "let cart", "const QR_API = \"https://station.thirstybeaches.com/api/qr\""])
    if (!h.includes(v)) throw new Error("order.html: kiosk no longer has " + v);
  const vp = /<meta name="viewport"[^>]*>/;
  if (!vp.test(h)) throw new Error("order.html: viewport meta not found");
  h = h.replace(vp, '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="theme-color" content="#080B16">');
  h = h.replace(/<title>[^<]*<\/title>/, "<title>Order ahead · Thirsty Beaches</title>");
  h = h.replace("</head>", "<style>\n/* phone mode (cloud/phone/order.css) */\n" + read("order.css") + "\n</style>\n</head>");
  const i = h.lastIndexOf("<script>");                                              // the kiosk's main script
  h = h.slice(0, i) + "<script>\n" + read("order-pre.js") + "\n</script>\n" + h.slice(i);
  const j = h.lastIndexOf("</body>");
  h = h.slice(0, j) + "<script>\n" + read("order-post.js") + "\n</script>\n" + h.slice(j);
  if (!h.includes("window.TB_PHONE = true") || !h.includes("window.startOnline")) throw new Error("order.html: phone shims not inserted");
  fs.writeFileSync(path.join(pub, "order.html"), h);
}
orderPage();
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
