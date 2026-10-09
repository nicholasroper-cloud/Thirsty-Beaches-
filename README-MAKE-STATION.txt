THIRSTY BEACHES — MAKE STATION (drink-making screen)
=====================================================

WHAT IT IS
----------
A screen for whoever is MAKING the drinks. It is not a kiosk and takes no
customer input. Every order that lands in Clover (kiosk, Register, Flex)
shows up as a ticket, oldest first. Tap a ticket and you see:

  - each DRINK with its build steps (syrup pumps, ice, soda, cream, garnish),
    already adjusted for what the customer picked (size, soda swap, extra
    syrups, cream choice, blended)
  - each NON-DRINK item (Treats, candy bags) as a pink GRAB card with a count
  - a big "Done, next ticket" button

Done tickets drop off this screen only. Clover is never changed.
"Undo" under "Just made" brings a ticket back for 30 minutes.

TWO MODES, one address:
  TICKETS  - driven by incoming orders (above). A new ticket chimes and
             switches the screen back to Tickets if you were in Lookup.
  LOOKUP   - the Build Cards: search / category / cup size picker for
             walk-ups, training, or a drink rung up somewhere else.
             Bookmark  http://<pc-address>:8140/#lookup  to open straight to it.

Drink cards are color-coded by Clover category (same colors as the kiosk),
show the cup size as a big badge, and tick off step by step. When every card
on a ticket is ticked, the Done button pulses. Tickets older than 6 minutes
turn red; the top bar shows the longest wait and how many were made today.

FILES
-----
  Run-MakeStation.bat             <- double-click to START (on the kiosk PC)
  Allow-MakeStation-Firewall.bat  <- run ONCE as administrator so the Show can connect
  make-station-server.js          <- the server (reads Clover, serves the page on port 8140)
  make-station.html               <- the screen
  pickup-board.html               <- customer pickup board (/board)
  recipes.json                    <- the build recipes (from the Build Cards)
  addons.json                     <- add-on names used to understand modifiers (shared with kiosk)
  make-state.json                 <- created on first use: which tickets were marked done

SETUP (one time)
----------------
  1. Run  Allow-MakeStation-Firewall.bat  as administrator.
  2. Double-click  Run-MakeStation.bat . It prints the address, e.g.
        http://192.168.1.50:8140/
  3. On the Echo Show 21: say "Alexa, open Silk" (or Settings > Apps > Silk),
     type that address, then in Silk's menu set the inactivity timeout to 0.
     Bookmark it. Silk may still return to the Alexa home screen after idle;
     reopen the bookmark. The page keeps the screen awake while it is open.
  4. Optional: Stop-Kiosk.bat stops BOTH the kiosk and the Make Station
     (it closes every node.exe).

VOICE
-----
  Tap "Voice off" in the top bar to turn it on. New tickets are then read
  out loud ("New order for Nick. Thirst Trap, medium."). Needs one tap on
  the screen after it loads (browsers only allow sound after a touch).

COMING UP + STATS
-----------------
  Under the ticket header, "Coming up" totals the bases waiting behind the
  current ticket (2x Dr Pepper, 1x Sprite...) and flags the same drink on
  other tickets so they can be made together. When nothing is waiting, the
  screen shows today's count, average ticket time, busiest hour, top drinks.

PICKUP BOARD (customer-facing)
------------------------------
  Any TV, tablet or phone on the trailer Wi-Fi can open
        http://<pc-address>:8140/board
  It shows "Ready, come grab it" (tickets marked Done in the last 30 min,
  with the customer's name) and "In the works". It calls out "Order up for
  Nick, ticket V J 9 R" when a ticket flips to ready. Same server, no setup.

CONFIG (kiosk-config.env, all optional)
---------------------------------------
  MAKE_PORT=8140              port the Show connects to
  MAKE_BIND=0.0.0.0           reachable on the Wi-Fi (default); 127.0.0.1 = this PC only
  MAKE_LOOKBACK_HOURS=16      how far back to show tickets not yet marked done (and count today's stats)
  MAKE_POLL_SEC=6             how often to ask Clover for new orders
  GRAB_CATEGORIES=Treats      Clover categories shown as GRAB cards instead of drinks

RECIPES
-------
  recipes.json holds the ingredient list per drink name. Edit the "i" list to
  change a build. Drinks with no pump recipe (floats, soft serve, coffee,
  Beach Buzz, Low Tide, Sandcastle Shake, Lil' Root Beer Float) have a "how"
  list instead: written step-by-step methods. THESE ARE STARTING POINTS
  written from the menu descriptions. Please read them once and correct
  anything that is not how you make it. Still no build on file:
  Peach Please, Sharky, Pour Decisions (build-your-own).
  Syrup pumps: 2 / 3 / 4 total per small / medium / large cup, shared across
  the drink's syrups. Modifiers from the order add to or replace the recipe:
    size            -> cup size
    a soda/energy   -> replaces the base
    a flavor syrup  -> added syrup
    a puree         -> added puree
    cream choice    -> replaces the recipe's cream ("None" removes it)
    Blended/frozen  -> blend steps
    anything else   -> shown as an "As ordered" step and a highlighted chip

SECURITY NOTES
--------------
  - The Clover token stays inside the server process on the kiosk PC.
  - The server only READS Clover. It exposes ticket names/modifiers, not
    card or payment details, to devices on the same private Wi-Fi.
  - The kiosk server (clover-menu-server.js) is unchanged and still
    answers only on localhost.
