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
