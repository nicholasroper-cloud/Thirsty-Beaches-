# Station owner features (OPS)

The station Worker (`thirsty-beaches-station`, station.thirstybeaches.com) can also message you.
Everything here is **off until you add its settings**. With nothing set it makes no requests and
sends nothing, so deploying this code changes nothing by itself.

## Uses Salty Dog Tags' Clover key and alerts (RELAY_KEY)

**Uses Salty Dog Tags' Clover key and alerts automatically once `RELAY_KEY` is set (one-click workflow).**
Salty Dog Tags already has the Clover "Hosted Checkout" key (same Clover account, MQKMTFBRXFP21) and your
phone alerts (Pushover / Twilio). The station borrows both through saltydogtags.com, so there is nothing to
copy from Clover or Pushover:

- "Pay on my phone" and "Order ahead" checkouts are made with Salty Dog Tags' key. Customers still pay
  Thirsty Beaches' Clover account and come back to the station's tracker; nothing Salty Dog shows up.
- The daily report and site-down alerts below arrive on the same phone channels as Salty Dog orders.

How to switch it on (once):

1. GitHub → **thirsty-beaches-website** repo → **Actions** → **Set up relay key** → **Run workflow**.
   It makes a random key and saves it as `RELAY_KEY` on Salty Dog Tags and on this Worker (and tb-where).
   You never see or type it. Running it again makes a new key everywhere.
2. Deploy Salty Dog Tags (merge to main). Its key only goes live with that deploy.
3. Deploy the station (merge to main).

Your own settings always win: with `CLOVER_ECOMM_TOKEN` set here, checkouts go straight to Clover; with
any channel from section 1 set here, alerts go only there. Limits through the relay: at most 30 drinks
and $200 per phone checkout (bigger carts get "pay at the window"). If saltydogtags.com is down or the
key doesn't match, phone pay fails cleanly, the kiosk offers "Pay at the window", and an alert that
couldn't be sent is retried on the next run. A "Salty Dog Tags is down" alert can't get through while
Salty Dog Tags itself is down; set `NTFY_TOPIC` here too if you want that one covered.

Check it: `https://station.thirstybeaches.com/api/qr` says `{"enabled":true}`, and
`/api/report?k=YOUR_STATION_KEY&send=1` pushes yesterday's report to your phone.

## Where settings go

Cloudflare dashboard → **Workers & Pages** → `thirsty-beaches-station` → **Settings** →
**Variables and Secrets** → **Add**.

- Pick **Secret** for anything private (tokens, keys, phone numbers, the ntfy topic).
- Pick **Text** for plain options (hours, on/off switches).
- Click **Deploy** after adding. Deploys from GitHub keep these (`keep_vars = true`), and secrets
  are never touched by a deploy.

Never put any of these in the repo; it is public.

## 1. Where the messages go (set at least one)

Same channels as the Salty Dog Tags site. You can reuse the same values.

| Setting | Type | What it is |
| --- | --- | --- |
| `NTFY_TOPIC` | Secret | Free push via the ntfy app. Use a long random topic name and subscribe to it in the app. `topic`, `ntfy.sh/topic` and `https://ntfy.sh/topic` all work. |
| `PUSHOVER_TOKEN` + `PUSHOVER_USER` | Secret | Pushover app push (app token + your user key). |
| `TWILIO_SID` + `TWILIO_TOKEN` + `TWILIO_FROM` + `NOTIFY_TO` | Secret | Text messages via Twilio (optional; costs per text). |

As soon as one channel is complete, the daily report and the monitoring below switch on.
With none of these set, `RELAY_KEY` (see the top of this page) sends them through Salty Dog Tags' channels.

## 2. Daily sales report

Every morning at **7:30 am Denver time** you get one message about yesterday:
orders, drinks, gross sales, average ticket, tips (if any), top 3 items, busiest hour, how many
orders came from the kiosk, from "Pay on my phone" (QR), and from the register/other, and how
the day compares with the same weekday last week.

- Days with no sales send nothing.
- Counted: orders Clover marks paid. Refunded or exchanged lines are left out. Gross = item
  prices plus add-on prices, before tax, discounts and tips. Each line on the order is one item.
  "Drinks" = items that are not in the `GRAB_CATEGORIES` category (Treats).
- Check any day yourself: `https://station.thirstybeaches.com/api/report?day=2026-10-24&k=YOUR_STATION_KEY`
  (leave out `day=` for yesterday). Add `&send=1` to also push it to your phone, which is a quick
  way to test that notifications work.

Options (Text variables, all optional):

| Setting | Default | What it does |
| --- | --- | --- |
| `REPORT_ENABLED` | on | `0` turns the daily report off. |
| `REPORT_EMPTY` | off | `true` sends "No sales yesterday." on days with no orders. |
| `REPORT_HOUR` | `7` | Earliest local hour to send. The Worker runs at 13:30 and 14:30 UTC (7:30 am Denver in summer and in winter); the first run at or after this hour sends. |
| `OWNER_TZ` | `America/Denver` | Time zone for "yesterday", hours and times in messages. If you change it, the cron times in `wrangler.toml` may need to move too. |

Uses the existing `CLOVER_API_TOKEN` secret; nothing new is needed from Clover.

## 3. Review ask on the phone tracker

Customers who pay on their phone keep a tracker page open (`/r/<ref>`). With `REVIEW_URL` set:

- while the drink is being made, a quiet "Loved it? Leave us a review ⭐" link under the order;
- when it is ready, the same as a small button under the order.

One tap opens your review page in a new tab, then it says thanks and doesn't ask again for that
order, or on that phone for 120 days. Nothing pops up and nothing is shown before payment.

| Setting | Type | What it is |
| --- | --- | --- |
| `REVIEW_URL` | Text | Your Google review link (Google Business Profile → "Ask for reviews" → copy link). Must start with `https://`. Leave it unset to hide the ask completely. |

## 4. Site monitoring

Every 5 minutes the Worker checks:

| What | Counts as up |
| --- | --- |
| https://thirstybeaches.com/ | loads (200) and the page says "Thirsty" |
| https://saltydogtags.com/ | loads (200) and the page says "Salty" |
| https://saltydogtags.com/api/config | JSON with `pay: true` (card checkout is on) |
| https://tb-where.nicholasroper.workers.dev/where | loads (200) and is JSON |
| The station itself | its pages load from inside the Worker |
| Station → Clover | the `CLOVER_API_TOKEN` still works (only if that secret is set) |
| Drink kiosk heartbeat (`tb-where …/kiosk/status`) | `online` is true and `lastSeen` is under 15 min old. Until that endpoint exists (404) it is skipped and never alerts. |

You only hear about **changes**:

- **Down**: after 2 failed checks in a row (about 10 minutes), with the reason, e.g. `HTTP 503`,
  `timeout after 10s`, `"Thirsty" is missing`, `pay is not true`, `Clover /orders -> 401`.
- **Back up**: once it works again, with how long it was down.
- At most one message per site per 30 minutes. If a site flaps, the next message waits and then
  tells you how it ended up. Several changes at once come as one message.
- Kiosk: "down" when it has been offline more than 15 minutes **during open hours**. Outside the
  hours nothing is sent; at opening it gets 15 minutes to come online.

Options (Text variables, all optional):

| Setting | Default | What it does |
| --- | --- | --- |
| `KIOSK_HOURS` | always | Hours to watch the kiosk, local time, e.g. `08-21` (8 am to 9 pm) or `07:30-20:30`. |
| `MONITOR_ENABLED` | on | `0` turns monitoring off. |

See what the monitor currently thinks: `https://station.thirstybeaches.com/api/monitor?k=YOUR_STATION_KEY`
(add `&run=1` to check right now).

## Cost and limits

All of this fits the free Workers plan: 2 cron triggers (Cloudflare allows 5 per account on the
free plan), about 2,000 outbound checks a day, one KV read per check and a KV write only when
something changes. Cron runs show up under the Worker's **Logs** tab.

<!-- Merge note: feat/station-ops also adds cloud/OPS.md (daily report, review ask, monitoring).
     Keep both: this "Order ahead" section goes after that file's sections. -->

## Order ahead (customers order from their own phone)

Customers at an event, or nearby, open **https://station.thirstybeaches.com/order** on their
phone, build their drinks from the same menu as the kiosk (same prices, options, upsells, Secret
menu, specials and sold-out items), type their name, and pay with Apple Pay, Google Pay or a card
on Clover's secure checkout page. Clover sends them back to the same "we're making it / ready at the
window" tracker the kiosk's "Pay on my phone" uses, now with "Pick up at the window at <where you
are parked>".

On the make station the ticket shows a cyan **ONLINE** badge with their name, and "Online" as its
source. In Clover the first line's note reads `KQ-<ref> · Online · <name>`. The daily report counts
these with "Phone/QR".

The website (thirstybeaches.com, home page and menu) shows an **Order ahead** button only while
it is switched on **and** the trailer is live.

### It is ON, and follows the trailer

`ORDER_AHEAD = "true"` is set in `cloud/wrangler.toml` (Nick said yes), so every deploy turns it on. It still only
takes orders while the trailer is live (see "When it takes orders" below): open the trailer and ordering ahead
opens; close it and checkout closes by itself. Nothing to do day to day.

| Setting | Where | What it does |
| --- | --- | --- |
| `ORDER_AHEAD` | `cloud/wrangler.toml` `[vars]` | `true` = on (current). `false` or `0` = off. |

How it reaches the Worker: the **Deploy station** workflow (thirsty-beaches-website repo, Actions) runs
`wrangler deploy` with this repo's `cloud/wrangler.toml`; every value in its `[vars]` is sent on every deploy and
wins over a dashboard value of the same name (`keep_vars = true` only keeps dashboard variables that are *not* in
the file). The workflow adds just `PAGE_VERSION` on top.

- **Switch it off for good:** change it to `ORDER_AHEAD = "false"` in `cloud/wrangler.toml`, merge, run Deploy station.
- **Emergency off without a deploy:** dashboard → `thirsty-beaches-station` → Variables → set `ORDER_AHEAD` to
  `false` → Deploy. That lasts until the next Deploy station run puts `true` back. (Setting `QR_ENABLED` to `0`
  instead switches off all phone payments, kiosk QR included, and survives deploys because it is not in the file.)

Before the first busy day, check:

1. **`CLOVER_ECOMM_TOKEN` or `RELAY_KEY` secret is set** (the Hosted Checkout key, or Salty Dog Tags'
   one through the relay; the same one "Pay on my phone" uses). Without either, ordering ahead stays off
   even with `ORDER_AHEAD=true`.
2. **Clover dashboard redirect URLs are cleared.** Clover web dashboard → Hosted Checkout settings:
   leave the Success / Failure redirect URL fields empty, so Clover uses the tracker link each order
   sends. If they're filled in, customers land on that page instead of their tracker.
3. `QR_ENABLED` is not `0` (that switches all phone payments off, kiosk QR and order ahead alike).
4. Do one real order yourself for a dollar or two (a Treats bag), see it on the make station, tap
   Done, see the tracker go green, then refund it in Clover.

### When it takes orders

Only while the trailer is **live**: the same "we're open" signal that turns the website's "Open now"
pill green (tb-where `/where` says `open: true`, which goes stale after 90 minutes without a location
update). The station checks it at most once a minute. When you close, the page says "We're not
pouring right now" with a link to the text sign-up, the menu stays browsable, and checkout is closed.
If the station can't reach tb-where, it treats the trailer as closed (no orders) until it can.
If the customer's phone can't reach the station, the page says "Can't reach us right now, try again" (with a
Try again button) instead of "ordering ahead is off". While checkout is closed the cart says why in place of
"Next: add your name", so nobody types a name for an order that can't go through.

### Limits and safety (all optional Text variables)

| Setting | Default | What it does |
| --- | --- | --- |
| `ORDER_AHEAD_MAX_ITEMS` | `8` | Most drinks + treats in one online order. |
| `ORDER_AHEAD_MAX_TOTAL` | `100` | Most dollars in one online order. |
| `ORDER_AHEAD_RATE_PER_HOUR` | `12` | Online checkouts one phone/IP can start per hour (on top of `QR_RATE_PER_HOUR`). |

- Every line is re-priced by the Worker from the kiosk menu (same check as kiosk QR carts); the
  amount charged is always the Worker's price. A tampered or out-of-date cart is refused.
- Sold-out drinks and options (from the owner app's kiosk-control.json) are refused at checkout too,
  even if the customer's page is a few minutes old.
- Online carts are only accepted from the /order page itself, need a name, and need the trailer live.
- Kiosk carts ("Pay on my phone" on the kiosk, pay at the window, tap to pay) are not affected by
  any of this, including when ordering ahead is off or the trailer shows closed.
- No new secrets. The page reads the public parts of kiosk-control.json (sold-out lists and
  specials only, never the health-check link or kiosk settings) through `/api/control`.

### Quick checks

- `https://station.thirstybeaches.com/api/order-ahead` → `{"enabled":true,"open":true,"label":"…"}`
  when it is on and you're live.
- The page: `https://station.thirstybeaches.com/order`.

## Punch card from paid phone orders (PUNCH_KEY)

Orders paid on the customer's phone (kiosk "Pay on my phone" and Order ahead) can add their punches to the
customer's Thirsty Beaches punch card without staff:

- the phone tracker (`/r/<ref>`) shows **Add my punch** once the order is paid (and when it's ready);
- the kiosk's "You're in" screen shows a small **Scan for your punch** QR after a phone payment.

Both open `https://thirstybeaches.com/card?claim=<token>`. The token is made only here, only for a paid order:
`<ref>.<drinks>.<expiry ms>.<signature>`, signed with the `PUNCH_KEY` secret (HMAC-SHA256 of the first three parts,
key = the secret string as stored, first 32 hex characters), good for 7 days. tb-where checks it and allows one
claim per order. `drinks` counts drinks only (not Treats, the `GRAB_CATEGORIES` items), at most 5.
Pay-at-window orders are unchanged: staff punch those.

| Setting | Type | What it is |
| --- | --- | --- |
| `PUNCH_KEY` | Secret | Shared with tb-where. Set on both by the one-time **Set up punch key** workflow in the thirsty-beaches-website repo. Never type it anywhere. |

Without `PUNCH_KEY` it is off: `GET /api/qr/<ref>/punch` answers 503 `punch-off`, and neither the tracker nor the
kiosk shows anything. Check it: for a paid order, `https://station.thirstybeaches.com/api/qr/<ref>/punch` returns
`{"url":"https://thirstybeaches.com/card?claim=…","drinks":N}` (404 unknown order, 409 not paid yet / no drinks).

## Owner app: today's sales (CORS on /api/report)

The owner app (https://nicholasroper-cloud.github.io) reads `GET /api/report` from the browser. It sends the
`STATION_KEY` in the `X-Key` header; the Worker allows that origin (and only that one) for this route, with
`OPTIONS` preflight. `?k=` links keep working. Without the right key it still answers 401.
