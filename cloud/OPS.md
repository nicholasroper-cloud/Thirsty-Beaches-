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
