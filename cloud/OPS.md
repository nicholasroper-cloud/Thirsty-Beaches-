# Station owner features (OPS)

The station Worker (`thirsty-beaches-station`, station.thirstybeaches.com) can also message you.
Everything here is **off until you add its settings**. With nothing set it makes no requests and
sends nothing, so deploying this code changes nothing by itself.

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

# Station owner features (OPS)

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

### It is OFF until you turn it on

| Setting | Type | What it does |
| --- | --- | --- |
| `ORDER_AHEAD` | Text | `true` turns ordering ahead on. Unset (the default), `false` or `0` = off. |

Cloudflare dashboard → **Workers & Pages** → `thirsty-beaches-station` → **Settings** →
**Variables and Secrets** → **Add** → Type **Text**, name `ORDER_AHEAD`, value `true` → **Deploy**.
To turn it off again, set it to `false` (or delete it) and Deploy. Don't put it in `wrangler.toml`:
a value there would overwrite the dashboard on every deploy.

Before you turn it on, check:

1. **`CLOVER_ECOMM_TOKEN` secret is set** (the Hosted Checkout private key; the same one "Pay on my
   phone" uses). Without it ordering ahead stays off even with `ORDER_AHEAD=true`.
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
