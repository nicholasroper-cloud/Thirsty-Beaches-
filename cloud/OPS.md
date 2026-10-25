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
