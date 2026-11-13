# All Fired Up — firewood ordering & delivery test app

A working prototype for the full customer journey: choose firewood, enter delivery
details, pick a date from your area's weekday round, pay with **Stripe test
mode**, and have the confirmed booking appear in the **All Fired Up Deliveries**
Google Calendar.

This is original demonstration content. It does not copy the existing All Fired Up
site's text, images or branding. Product artwork is original placeholder SVG.
Prices are clearly marked test prices.

---

## What is included

**Customer site**
- Warm, responsive ordering flow (mobile-first) with placeholder product imagery.
- Products modelled on the real range: large dumpy bag, 2m³ and 3m³ loose loads,
  20 nets, kindling, natural firelighters and smokeless coal.
- Postcode-based delivery rounds: Monday Dereham & Swaffham (NR17, NR19–20),
  Tuesday Norwich (NR1–8), Wednesday Ipswich (IP1–7), Thursday King's Lynn
  (PE30–38), Friday Cambridge (CB1–5). The date picker only shows the customer's
  own round days. The area is described in road miles from the yard (up to about
  60), not a straight-line radius.
- Five truck spaces per day, weighted by product volume, booked by date only
  with 24-hour notice. The arrival time is narrowed by text on the day.
- 15-minute truck-space hold while the customer pays.
- Stripe Checkout in test mode (or a clearly labelled demo checkout if Stripe is
  not configured yet).
- Confirmation page with order reference, payment state and calendar sync state.

**Owner dashboard** (`/admin`)
- Password-protected orders list with search (name, postcode, order ID, date),
  status filter, detail drawer and status changes.
- Calendar-style month view plus a per-day delivery schedule.
- Availability manager: close whole delivery days, see truck space used per
  day, add an internal note, remove blocks.
- Warning when closing a day that already has paid orders:
  “This day has X paid orders. Please contact customers to rearrange.”
  Paid orders are never deleted or cancelled automatically.
- Google Calendar connection, calendar selection and write test.
- Stripe test-key and webhook-secret setup.

**Booking integrity**
- 15-minute reservations with automatic expiry.
- Capacity is enforced in tenths of a truck space with database locks, so
  parallel checkouts cannot oversell a day.
- Unavailable when the truck is full, the round is closed, the postcode does not
  match that weekday, the date is inside the 24-hour notice period, reserved by
  someone else, or busy in the connected Google Calendar.
- Calendar events are created only after Stripe confirms payment — via webhook,
  or by server-side Stripe session verification on the confirmation page if the
  webhook is delayed or unavailable locally.

---

## Run locally

```bash
npm install
npm run build
npm run dev
```

The app runs at `http://localhost:3000` using a local D1 database. The database
schema and sample orders are created automatically on first load.

Demo owner password: **firewood2026** (change it in Setup → Admin password).

---

## Setup for live testing

### 1. Stripe (test mode only)

1. In the Stripe dashboard, switch to **Test mode**.
2. Developers → API keys → copy the **test secret key** (`sk_test_…`).
3. In the app: **Setup → Stripe payments**, paste the key and save.
4. Add a webhook endpoint in Stripe (test mode) pointing at the URL shown in the
   app (`https://your-domain/api/stripe/webhook`), subscribing to:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.expired`
5. Copy the endpoint's signing secret (`whsec_…`) into the app.

The server refuses live keys. Test card: `4242 4242 4242 4242`, any future expiry,
any CVC, any postcode. No real money is taken.

> Without a Stripe key the app uses a clearly labelled demo checkout page. It is
> not a Stripe page, takes no card details, and exists only so the booking flow
> can be exercised immediately. Add a test key to use real Stripe Checkout.

### 2. Google Calendar

The dedicated calendar **All Fired Up Deliveries** has been created in the
connected Google account. To let this app read and write it, connect it through
the app:

1. In Google Cloud Console, enable the **Google Calendar API**.
2. Create an **OAuth client ID** of type **Web application**.
3. Add the redirect URI shown in **Setup → Google Calendar**, for example:
   `https://your-domain/admin/google/callback`
   (locally: `http://localhost:3000/admin/google/callback`).
4. Paste the client ID and client secret into Setup and save.
5. Click **Connect Google Calendar** and approve access.
6. The app finds the calendar named **All Fired Up Deliveries** — or creates it —
   and uses it for availability and events. It never defaults to the personal
   primary calendar.
7. Use **Send a test event** to verify write access.

Events created for orders:
- Title: `Delivery: [Customer Name] — [Order Summary]`
- All-day entry on the delivery date
- Transparency: **Busy** (blocks the window)
- Description includes customer name, phone, email, address, postcode, contents,
  delivery notes, total, payment status and order ID
- The event ID is stored on the order

Blocks create a corresponding **“Blocked — no deliveries”** calendar event.

---

## Delivery rules implemented

| Rule | Value |
| --- | --- |
| Delivery days | Monday–Friday, one area round per weekday |
| Rounds | Dereham & Swaffham Mon · Norwich Tue · Ipswich Wed · King's Lynn Thu · Cambridge Fri |
| Delivery area | Up to about 60 road miles from the yard (Dereham 5 · Norwich 20 · King's Lynn 25 · Ipswich 56 · Cambridge 57) |
| Booking | Delivery date only; arrival time texted on the day |
| Truck capacity | 5 dumpy-bag equivalents per day |
| Product space | Dumpy bag 1 · 20 nets 1 · 2m³ loose 3 · 3m³ loose 4.5 · kindling 0.1 · firelighters 0.05 · coal 0.25 |
| Minimum notice | 24 hours |
| Reservation hold | 15 minutes |
| Delivery charge | £12, free over £250 (test prices) |

Availability also treats the connected Google Calendar's busy events as
unavailable. The app's own delivery events are ignored in that check (they are
counted as bookings in the database instead), so a window with one of its two
spaces used correctly remains bookable. After the second booking it shows
“Fully booked”.

---

## Suggested end-to-end test

1. Open the site and add a dumpy bag and kindling.
2. Enter a name, email, phone and an NR postcode.
3. Choose one of your area's round dates (at least 24 hours ahead).
4. Review the order — the truck space is held for 15 minutes.
5. Pay with `4242 4242 4242 4242` in Stripe test mode (or the demo checkout if
   Stripe is not configured).
6. On the confirmation page, note the order reference.
7. Open Google Calendar → **All Fired Up Deliveries** and confirm the event is
   there at the correct time, marked Busy.
8. In a second tab, refresh the date picker: that day's remaining truck space has
   dropped (or it shows fully booked once 5 spaces are used).
9. Open `/admin` and find the order; change its status, add a block, or use the
   calendar view.

---

## Data & security notes

- Test data lives in a separate D1 database for this app. Do not point a
  production Stripe key at it.
- Google OAuth refresh tokens and Stripe test secrets are stored server-side in
  D1 and are never returned to the browser. The settings screen only shows
  whether a key is configured and its last four characters.
- Admin sessions are signed, HttpOnly, SameSite=Lax cookies.
- Admin passwords are stored as salted PBKDF2-SHA256 hashes.
- Customer order lookups require the random order token.
- Customer names/addresses are escaped before rendering in the dashboard.
- Customer emails and delivery-day reminders are sent through the connected
  Google account's Gmail API; nothing is sent until Google is connected.

---

## Architecture

- Cloudflare Worker (Hono) + D1 + static assets.
- Stripe REST API via `fetch`; webhook signatures verified with Web Crypto.
- Google Calendar REST API via `fetch`; OAuth 2.0 with offline refresh tokens.
- No Stripe or Google SDK bundles; small Worker footprint.
- CSS and vanilla JS front end with no runtime framework.

Key files:
- `src/index.ts` — routes
- `src/orders.ts` — validation, reservations, payment finalisation, status changes
- `src/zones.ts` — postcode districts and weekday rounds
- `src/availability.ts` — truck-space capacity, notice period, blocks, calendar busy merging
- `src/reminders.ts` — delivery-day reminder emails
- `src/google.ts` — OAuth, calendar discovery, busy lookup, events
- `src/stripe.ts` — Checkout sessions and webhook verification
- `public/app.js` — customer flow
- `public/admin.js` — owner dashboard
