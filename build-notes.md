# Thirsty Beaches kiosk — published build
This repo is the live source the kiosks auto-pull.
- drink-kiosk.html / drink-kiosk-light.html = the kiosk screen
- update-manifest.json = version pointer (bump "version" to push a change)
Published via publish-menu.command.

## Release v39 notes (2026-11-19)

### The arcade (`/arcade`): a separate URL, not linked from the ordering screen
- Where it is: `http://localhost:8137/arcade` on the kiosk PC (the server listens on 127.0.0.1 only, so it can be opened by a browser on that PC, for example on a second screen). Nothing on the ordering screen links to it and none is added in this release. The arcade page has an "Order Drinks" link back to `/`.
- Files: `kiosk/*` (page, css, js, audio bank, menu) arrive through the manifest and are swapped in place; `arcade-routes.js` is server code (staged, idle restart, 60 s trial, automatic rollback like the other engine files).
- No camera, no microphone, no AI scan: the page never calls `getUserMedia` and is served with `Permissions-Policy: camera=(), microphone=()`. Scan My Vibe and the Presence Cam were removed.
- Prizes are real or absent. The kiosk server rolls the prize and asks the tb-where Worker for a claim code (play token + `/kitchen/claim` with `X-Kiosk-Key`). The page shows the Worker's code and nothing else; if the Worker is unreachable, `KIOSK_KEY` is unset, the daily cap (`PRIZE_DAILY_CAP`, shared with the website) is hit, or no play token is 45 s old yet, the result is "thanks for playing". The Worker needs its `PLAY_SECRET` and `KIOSK_KEY` secrets set. The code is a 4-character Kitchen Board claim: the make station's Claims drawer lists and redeems it. The staff screen shows the Worker's reward text ("Secret Menu Unlock", or "Arcade Champ Free Upgrade + Secret Build" for the jackpot tier), and the page shows that same text, so crew and customer see the same prize.
- Staff drawer (tap the top-right corner three times): locked until the staff key is typed. The staff key is `STATION_KEY` from `kiosk-config.env`, the same key the make station uses; with it blank nobody can change anything (fails closed). Odds must list every prize once, be numbers 0 to 100, sum to 100, and free drink odds are capped at 2%. Persona, volume and mute are per screen and never touch the server.

### Make Station server: how it reaches the PC (it is NOT in the manifest)
`make-station-server.js` is a separate process (`Run-MakeStation.bat`, port 8140). The supervisor only manages `kiosk-server.js`, it cannot restart or roll back the station server, and the manifest has never carried it (`kiosk-lib.js` lists it as content, not engine). `make-station.html` IS in the manifest, so the page can arrive before the server. Decision: the new page degrades instead. Against a server without `/api/kitchen/extras` (404) the Claims and 86 Stock buttons are hidden and the ticket screen works as before.
Manual step to get the new station features on a PC that runs the local station (the cloud station at station.thirstybeaches.com is deployed separately):
1. Copy the new `make-station-server.js` from the repo (or the USB package) over the one in the Drive folder.
2. Stop the station (Stop-Kiosk.bat closes every node.exe, so do this at the end of the day, or close only the "Thirsty Beaches Make Station" window), then double-click `Run-MakeStation.bat`.
3. Open the station: Claims and 86 Stock appear within 20 seconds. For VIP passes the PC also needs `CROSS_BRAND_SECRET` in `kiosk-config.env`; without it a VIP pass answers "verify at the Salty Dog Tags order".

### Catalog map (`catalog-map.json`)
113 of 118 items and 237 of 304 modifier choices now carry their Clover id (each verified live, price equal). It is only read when `KIOSK_ORDER_TYPE_ID` is set, so with the kiosk's current config (blank order type, blank `CATALOG_TAX_RATES`, `PAY_ENABLED=false`) nothing changes: legacy window-pay orders. `tests/kiosk/map-inert.js` proves it. Turning on server-side pricing later needs the Clover "Kiosk" order type, a tax decision and `CATALOG_TAX_RATES` (see `catalog-gap-report.md`).

### Known leftovers
- The main ordering page, `recipes.json`, `addons.json`, `catalog-map.json` keys and `make-station.html` still say "Dole Whip" (it is the name of a Clover float modifier and of recipe keys); only the arcade files were cleaned.
