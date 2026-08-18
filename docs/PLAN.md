# Suriani POS — a multi-tenant QR-ordering POS for Malaysian restaurants

## Context

`whitehat26-My/POS-restoran-suriani` is an empty repo (one `README.md`, one commit).

The goal has grown past one shop. We are building a **multi-tenant SaaS point-of-sale product for
restaurants across Malaysia**. The owner's two branches are **customer zero** — the pilot that proves
it in real service before anyone else depends on it.

The product: customers scan a QR at their table and order from their own phone with no app install;
orders appear live on the cashier POS and print in the kitchen; customers pay after eating by DuitNow
QR or cash. It must **keep working when the restaurant's internet dies**, run at **near-zero cost**
while it has no revenue, and look good enough that customers notice.

### Decisions locked with the user

| Decision | Choice |
|---|---|
| Scope | **Multi-tenant from line one**; onboard manually at first, pilot on the 2 branches |
| Offline strategy | **Android POS app** with local database, **dual-transport printing (LAN → Bluetooth)**, and an **embedded web server** so phones can order with no internet at all |
| Distribution | **Direct APK to your own two branches.** Play Store deferred until you onboard restaurants you can't visit |
| Hardware | **Bring your own**, against a compatibility list we test and publish. Printers must have **both Ethernet and Bluetooth** |
| Money | **Free during pilot**, then ~RM49–99 per outlet/month; metering built in early |
| Order/pay flow | Order first, **pay after eating** (open bill per table) |
| Payment at launch | Static **DuitNow QR + cash**, cashier confirms; gateway later behind an interface |
| Kitchen output | Thermal printer tickets; KDS is a drop-in later |
| First deliverable | **Clickable UI/UX prototype**, approved before product code |
| Language | **Bahasa Malaysia + English**, designed for more later |
| No Raspberry Pi / no on-site server | Correct — the tablet does the offline work |

---

## 1. "Powerful but free" — the answer is Cloudflare, and it's not close

Everything below has a free tier that **permits commercial use** (unlike Vercel Hobby). Limits are
from the live docs, checked today.

| Need | Free service | Free limit | What happens next |
|---|---|---|---|
| API + server rendering | **Cloudflare Workers** | 100,000 req/day | Workers Paid **$5/mo** → 10M req/mo |
| Control-plane database | **Cloudflare D1** (this is SQLite) | 5 GB, 5M row reads/day, 100k row writes/day | Included in the same $5 → 25 **billion** reads/mo |
| Per-restaurant data + realtime | **Durable Objects** (SQLite backend) | 100k req/day, 13,000 GB-s/day, 10 GB each | $0.15 per million requests |
| Menu photos | **Cloudflare R2** | 10 GB, **zero egress fees** | $0.015/GB-mo |
| Frontend hosting, CDN, DNS, DDoS, WAF | **Cloudflare** | Free | — |
| Scheduled jobs (daily reports, closings) | **Cron Triggers** | 5 free | 250 on paid |
| Auth | **Better Auth / Lucia** (open source, self-hosted) | Free forever | Never pay per-user — avoid Clerk/Auth0 MAU pricing |
| Owner notifications | **Telegram Bot API** | Free, unlimited, forever | WhatsApp Cloud API later if wanted |
| Transactional email | **Resend** (3k/mo) or **Brevo** (300/day) | Free | ~$20/mo much later |
| Push to phones | **Web Push (VAPID)** / FCM | Free | — |
| Error tracking | **Sentry** free tier / self-hosted GlitchTip | 5k events/mo | — |
| Product + web analytics | **PostHog** (1M events/mo), **Cloudflare Web Analytics** | Free | — |
| Uptime monitoring | **UptimeRobot** / Better Stack | Free | — |
| CI/CD + source control | **GitHub Actions** | 2,000 min/mo private | — |
| Android distribution | Direct APK now; Play Store later | **$25 once** | — |
| Fonts / design assets | Self-hosted open fonts (Inter, Plus Jakarta Sans) | Free | — |

**Domain (~RM50–90/year) is the only guaranteed cost. The pilot runs for roughly RM6/month.**

### Where "free" actually runs out — the honest numbers

One busy outlet ≈ 300 orders/day ≈ 4–5k database writes and 15k API requests per day.

- **Free tier comfortably covers your 2 branches plus ~4 pilot restaurants.**
- Around 5–6 outlets you hit the 100k requests/day Workers ceiling → **$5/month**.
- That $5 tier then carries you to roughly **50–100 outlets**, with Durable Object overage measured
  in cents. At 100 outlets you'd be paying maybe $10–20/month total.

At RM49/outlet/month, 20 outlets is ~RM980/month revenue against roughly RM25/month of
infrastructure. **The unit economics are absurd in your favour** — which is exactly what you want
while you have no funding.

### Deliberately rejected

- **Vercel** — Hobby tier forbids commercial use; Pro is $20/seat/month from day one.
- **Supabase free tier** — pauses projects after inactivity, and 500 MB won't hold many tenants.
- **Firebase** — pricing gets ugly fast at read volume, and vendor lock-in is total.
- **Turso** — genuinely good, and its database-per-tenant model is the right idea. Cloudflare wins
  only because Workers + Durable Objects give us compute, realtime and per-tenant storage from **one
  vendor on one free tier**. Worth keeping in mind as a fallback.

---

## 2. Architecture

```
Customer phone (PWA, no install)      Cashier tablet (Android app, offline-capable)
        │                                              │
        │  ONLINE:  order.suriani.my/t/<token>         │  local SQLite + op log
        │  OUTAGE:  http://<tablet-ip>:8080/t/<token> ─┤  embedded HTTP server
        │           (shop WiFi, plain HTTP, own QR)    │        │
        ▼                                              ▼        │ TCP :9100, else Bluetooth
┌──────────────────────────────────────────────────────┐        ▼
│  CLOUDFLARE WORKERS  — API + SSR, global edge        │   kitchen printer
│                                                       │   counter printer + drawer
│   D1  ── control plane ──────────────────────────┐   │
│        orgs · users · outlets · devices ·         │   │
│        subscriptions · usage metering             │   │
│                                                    │   │
│   DURABLE OBJECT PER OUTLET ── data plane ───────┤   │
│        own 10GB SQLite: menu, tables, sessions,   │   │
│        orders, payments, print jobs               │   │
│        + WebSocket fan-out (hibernating)          │   │
│                                                    │   │
│   R2 ── menu photos (zero egress)                 │   │
│   Cron ── nightly closings, daily owner reports   │   │
└──────────────────────────────────────────────────────┘
```

**Stack:** TypeScript everywhere · React + Vite + Tailwind + in-house component library ·
Hono on Workers · Drizzle ORM over SQLite (D1 *and* Durable Objects *and* the phone) ·
Capacitor for the Android POS shell · NanoHTTPD for the tablet's embedded server ·
raw ESC/POS over TCP with a Bluetooth SPP fallback for printing.

### The one big technical decision: a Durable Object per outlet

Each restaurant branch gets its **own Durable Object with its own SQLite database**. This is the
call I'm making, and here's why it's worth the extra sophistication:

- **Tenant isolation is structural, not a `WHERE` clause.** The catastrophic failure mode for a POS
  SaaS is one restaurant seeing another's sales. With a shared table and a forgotten `tenant_id`
  filter, that's one bad query away. With a DO per outlet, there is no query that *can* reach another
  tenant's data. This is the difference between "we're careful" and "it's impossible".
- **Writes are single-threaded, so POS race conditions vanish.** Two phones at one table ordering at
  the same moment, or a cashier closing a bill while a customer adds a drink — with a DO these
  serialise naturally. On a shared database you'd be hand-writing transactions to prevent
  double-charges and lost orders.
- **The order write and the live broadcast are the same operation.** No separate pub/sub to drift out
  of sync with the database.
- **One restaurant can never slow down another.** No noisy-neighbour problem, ever.
- **Per-restaurant export, backup and deletion are trivial** — which PDPA compliance will want.
- **It scales to thousands of outlets with no sharding work**, because it's already sharded.

The honest costs: schema migrations must run per-outlet (handled by a version check when the DO
wakes), and cross-tenant analytics needs a nightly rollup into D1 (a scheduled job, ~50 lines).
Both are known, bounded problems. Retrofitting isolation into a live multi-tenant POS is not.

### Tenancy model

```
Organization        "Restoran Suriani"  — the business, the billing entity
  └── Outlet        "Kampung Baru", "Bangi"  — a branch = one Durable Object
        ├── Tables          each with an unguessable qr_token
        ├── Menu            inherits the org master menu, per-outlet overrides
        ├── Staff           role: owner | manager | cashier
        └── Sessions · Orders · Payments · Print jobs
```

An **org-level master menu with per-outlet price and availability overrides** is exactly what your
two branches need on day one — and it's a feature the incumbents charge extra for. Same for
**consolidated reporting across outlets**.

---

## 3. Offline: the Android POS app

This is the differentiator. Most Malaysian POS SaaS dies when the shop's internet dies.

**How it works.** The cashier tablet runs the same React POS UI, wrapped in Capacitor, plus two
native capabilities a browser can never have:

1. **A local SQLite database** holding the outlet's menu, open tables and today's orders.
2. **Raw TCP sockets** to talk ESC/POS directly to the kitchen and counter printers on the shop WiFi
   (a small Kotlin plugin, roughly 200 lines). *This is precisely why the web-only approach can't
   work — browsers cannot open a LAN connection to a printer.*

Internet drops → the POS keeps taking orders, keeps printing kitchen tickets, keeps closing bills.
It syncs when the line returns. **No box in the restaurant, no Raspberry Pi, no server to maintain.**

**Why sync is tractable here.** Orders are an **append-only event stream** — an order placed is a
fact, not mutable state, so two devices can never disagree about it. The device keeps an append-only
op log with client-generated ULIDs; on reconnect it pushes ops to the outlet's Durable Object, which
applies them in order (it's single-threaded — ideal) and returns a sequence number. Voids and
discounts are appended ops too, never edits.

The only genuine conflict surface is **menu edits and stock counts**, which are server-authoritative:
server wins, device is notified. That is the entire conflict model. Small enough to actually get
right.

**Customer phones stay pure web** — no install, ever.

### Three different things can break, and they need three different answers

Lumping these together as "offline" is how POS systems end up half-solving it. They are independent:

| What actually breaks | What stops working | The answer |
|---|---|---|
| **Internet down**, WiFi fine (fibre cut, ISP outage) | Cloud sync; customer phones on mobile data can't reach the menu | **Tablet serves the menu itself** over the shop WiFi |
| **Router/WiFi down**, internet fine (usually a power blip) | LAN printing; phone ↔ tablet | **Bluetooth printing fallback** |
| **Power cut** | Everything | **UPS** on router, tablet charger and printers |

The POS itself is unaffected by all three — it already holds its own SQLite and keeps trading.

### Answer 1 — the tablet is also a web server

The cashier tablet runs a small embedded HTTP server (NanoHTTPD, foreground service) that serves the
customer ordering app straight from the APK, backed by the same local database the POS uses. A
customer on the shop WiFi orders, the order lands in the **same op log** as a counter order, the
kitchen ticket prints immediately, and it syncs to the cloud whenever the line returns. One store,
one sync path — the offline ordering path is not a special case.

**It is always on, never outage-triggered.** No mode detection to get wrong, no switchover to fail
at the worst moment. There are simply two doors and both are always open.

**The constraint you need to accept.** A tablet cannot hold a TLS certificate that phones will trust
for a local address: Let's Encrypt does not issue for private IPs, and pointing the real domain at
the tablet produces a certificate error that HSTS makes un-bypassable. So:

- The local path is **plain `http://` to a fixed LAN address** (e.g. `http://192.168.1.50:8080`).
  Functionally complete — the ordering page needs no camera, geolocation or service worker — but
  phones show "Not secure" in the address bar.
- It therefore **needs its own QR**. It cannot reuse the HTTPS one.

**So the table card carries a small outage panel** under the main QR:

```
   ┌────────────────────────────────┐
   │        [ QR ]  Scan & pesan     │   ← normal, HTTPS, cloud
   │                                 │
   │  Tiada internet? / No internet? │
   │   [qr] Sambung WiFi             │   ← standard WIFI: join code
   │   [qr] Pesan di sini            │   ← http:// to the tablet
   └────────────────────────────────┘
```

If the shop's guest WiFi is left open (no password), the join step collapses to one tap and the
panel needs only one small QR.

**Locking it down matters.** The local server sits on a network customers share, so it exposes
*only* menu-read and order-create against a valid table token — no POS routes, no sales figures, no
staff auth surface at all, bound to the WLAN interface and rate-limited per IP. It is a separate
router from the POS API, not the same one with a flag.

**Android specifics:** foreground service with a persistent notification (Android 14 requires a
declared `foregroundServiceType`), `WifiLock` so the radio doesn't sleep, port 8080 since Android
can't bind below 1024, and a **DHCP reservation** so the tablet's IP never moves — a step in the
setup wizard, alongside the printers.

### Answer 2 — Bluetooth printing fallback

The print worker is transport-agnostic. Each job tries **TCP `:9100` with a ~1.5s timeout, then
falls back to Bluetooth SPP**, and only then queues with a visible POS alert. When the router dies,
the tablet talks straight to the printer with no network in between.

**This changes the hardware list: certified printers must have both Ethernet and Bluetooth.**
Android 12+ also needs the `BLUETOOTH_CONNECT` runtime permission.

### Distribution

**Customer ordering — web only, never an app store.** Not a close call. Nobody installs an app to
order nasi lemak, and every percent of install friction is a customer who walks.

**Cashier POS — direct APK to your own two branches.** No Google account, no review queue, no
waiting, and you can iterate daily. You physically control both tablets, which is exactly the
situation where sideloading is the right answer.

Revisit distribution only when onboarding restaurants you *can't* visit — at that point the driver
is automatic updates, not discoverability, and the Play Console closed-testing track is the next
step rather than a public listing. Two things will matter then, neither urgent now: a Play developer
account registered as an **organization** skips the 12-testers-for-14-days rule that personal
accounts face (needs SSM + a D-U-N-S number, ~30 days), and Google's **developer verification for
sideloaded apps** reaches Malaysia in the 2027 global rollout. Worth knowing, not worth doing yet.

**Apple App Store — skip it, at least until a customer pays you to care.**

- **$99/year recurring**, versus Google's $25 once.
- Malaysian restaurant hardware is overwhelmingly Android. A warung choosing between a RM800 Galaxy
  Tab and a RM2,000+ iPad is not choosing the iPad. iOS is a rounding error in your market.
- iOS also adds a local-network permission prompt in front of LAN printing — more setup friction on
  the exact flow that must never be fragile.
- Building it doubles your maintenance surface for a few percent of the market. Revisit only when a
  chain with existing iPads asks and will pay for it.

**Never sell subscriptions inside the app.** Restaurants sign up and pay **on your website**; the app
is login-only. Selling digital subscriptions in-app triggers Google Play Billing and a 15–30% cut of
your revenue. This is the standard B2B pattern (Shopify POS, Slack, Salesforce all do it) and it is
entirely legitimate — but only if you keep purchasing out of the app from day one.

---

## 4. Hardware — the compatibility list you publish

Restaurants buy their own. You certify and publish what works. No inventory, no logistics, no capital.

| Part | Requirement | Certify these |
|---|---|---|
| Cashier tablet | Android 12+, 10–11", 4 GB RAM, kept on mains | Galaxy Tab A9+, Lenovo Tab M11, Redmi Pad SE |
| Kitchen printer | 80 mm, **Ethernet _and_ Bluetooth**, ESC/POS, port 9100, auto-cutter | Epson TM-m30III, Xprinter XP-N160II BT, Rongta RP80 (BT variant) |
| Counter printer | Same + RJ11 drawer kick | as above |
| Cash drawer | RJ11, printer-kicked | any |
| Router | **DHCP reservation** support; two SSIDs | TP-Link Archer AX23, Deco |
| UPS | 650 VA+ | any |
| QR stands | A6/A7 acrylic, one per table | any |
| *Recommended* | 4G failover router / USB modem + prepaid SIM (~RM200) | keeps **cloud** sync alive through a fibre cut |

**A typical restaurant spends roughly RM2,000–3,000** — and you never touch a purchase order.

**Dual-transport printers are now a hard requirement**, not a preference: Ethernet is the fast path,
Bluetooth is what keeps the kitchen printing when the router dies. A LAN-only printer fails the
second failure mode entirely.

4G failover is listed as recommended rather than required because the tablet already keeps the shop
trading without it. What it buys is *cloud* continuity — the owner dashboard and multi-branch
reporting stay live during a fibre cut instead of going stale until the line returns. RM200 for that
is cheap.

Setup steps that go in the runbook, because each one prevents a specific support call: **DHCP
reservations for both printers and the tablet** (anything that moves IP breaks silently), printers
**pre-paired over Bluetooth during install** rather than in a panic later, and the guest SSID kept
separate from the POS SSID.

---

## 5. Data model

```
── D1 (control plane) ────────────────────────────────
organizations      name, ssm_no, owner_user_id, plan, created_at
users              email/phone, password_hash, role
outlets            org_id, name, address, timezone, do_id, status
devices            outlet_id, name, last_seen_at, app_version, printer_config
subscriptions      org_id, plan, outlet_count, status, trial_ends_at
usage_daily        outlet_id, date, orders, revenue_cents   ← nightly rollup
platform_audit     platform-level actions

── Durable Object per outlet (data plane) ────────────
menu_categories    name_ms, name_en, sort_order
menu_items         name_ms/en, desc_ms/en, price_cents, photo_key, tags,
                   is_available, stock_count, prep_minutes
modifier_groups    "Pedas?", "Tambah telur" — min/max select
modifiers          label_ms/en, price_delta_cents
tables             label ("Meja 5"), qr_token (random secret), status
table_sessions     THE OPEN BILL — open → bill_requested → paid → closed
orders             session_id, placed_at, source (qr|counter), client_ulid,
                   status: placed → printed → served | voided
order_items        qty, notes, unit_price_cents (SNAPSHOT), modifiers json
payments           method (cash|duitnow_qr|gateway), amount_cents, confirmed_by
print_jobs         target, payload, status, attempts, last_error
op_log             append-only; the sync spine
audit_log          every void, discount, price edit — who and when
daily_closings     opening float, cash counted, variance
```

**Three details that matter more than they look:**

- `order_items.unit_price_cents` is a **snapshot**. Raise the nasi lemak price at 3pm and this
  morning's bills must not silently change. Skipping this produces unauditable accounts.
- `tables.qr_token` is a **random secret, not the table number**. If the QR encodes `?table=5`,
  anyone can type `?table=6` and send 20 plates of chicken to a stranger's table. Prank orders are
  the most common way QR ordering fails in the real world.
- **All money in integer cents.** Never floats — SQLite has no decimal type, and float money is how
  totals end up off by a sen.

### Order lifecycle

```
Scan QR → session opened (or joined — two phones at one table share one bill)
        → cart on the phone (survives signal loss)
        → "Hantar Pesanan" → order placed → print_job → kitchen ticket
        → order more any time, same bill
        → "Minta Bil" → POS lights up
        → cash, or DuitNow QR + "Sudah Bayar" → cashier confirms
        → receipt prints, drawer kicks, session closed
```

---

## 6. UI/UX direction

Delivered first as a clickable prototype, before any product code.

**Principles**

1. **Appetite over corporate.** Warm palette, big food photography, generous spacing. Not a
   blue-grey enterprise dashboard.
2. **Thumb-first.** One-handed while holding a drink. 44 px minimum targets.
3. **Speed is the feature.** Scan → first item in cart in under 10 seconds. No login, no signup.
4. **Readable in sunlight and by 60-year-old eyes.** WCAG AA minimum, generous type scale.
5. **Motion with meaning.** 150–250 ms springs; full `prefers-reduced-motion` support.
6. **Themeable per restaurant** — design tokens as CSS custom properties, so onboarding a new
   restaurant with its own colour and logo is configuration, not a redesign. This matters enormously
   once you have 50 customers.

**Customer menu** — full-bleed photos, sticky category rail, `[BM | EN]` toggle, live-morphing cart
bar, halal/spicy/allergen chips, "Paling Laris" badges, and a **live status card** so they watch food
move *Diterima → Sedang Dimasak → Dihidang* instead of craning at the kitchen.

**Cashier POS** — dark UI (less glare over a 10-hour shift), a **floor map colour-coded by table
state**, huge tap targets, no keyboard dependency, and a permanent **offline / printer-health
indicator** so staff always know the system is fine.

**Owner console** — phone-sized: today's sales **across both branches**, top items, busiest hour,
menu editing with photo upload from the camera roll.

---

## 7. Features that will make people talk

**Customer** — add to your order any time without rescanning · live cook status with honest ETA ·
split bill by person or item · *Panggil Pelayan* button · *pesan lagi yang sama* · **instant 86-ing**
(grandma taps "ayam habis", it vanishes from every table's phone in under a second) · cart survives
signal loss.

**Cashier** — manual entry for walk-ins (QR is never the only path) · void/discount **with a reason**
into the audit log · shift open/close with cash counted vs expected · one-tap reprint · works with
the internet unplugged.

**Owner** — daily summary pushed to **Telegram** at closing time (free forever) · sales by hour ·
**consolidated multi-branch reporting** · per-item stock that auto-86s at zero.

**Built in from day 1 because retrofitting is painful** — org/outlet on everything · usage metering
for billing later · payment provider behind an interface (drop in HitPay/Fiuu dynamic DuitNow QR with
no change to ordering) · printer driver behind an interface (KDS later) · **LHDN e-Invoice fields**
(SST, item classification, optional buyer TIN) stored from the start.

---

## 8. Malaysian compliance — real obligations, not theatre

- **PDPA 2010.** You'll collect customer phone numbers for loyalty and takeaway alerts. Your
  restaurant customers are the data *controller*; you are the *processor*. You need a privacy notice
  in BM and English, explicit consent, a retention policy, a working deletion path, and a Data
  Processing Agreement in your terms of service. Per-outlet Durable Objects make "delete everything
  for this restaurant" a one-line operation.
- **LHDN e-Invoice.** The exemption threshold was raised to **RM1m annual turnover in December 2025**,
  so most small restaurants are exempt today. Two implications: it's a **sales feature** for
  customers as they grow, and **your own SaaS revenue** crossing RM1m triggers it for you.
- **SSM registration** for the entity selling the software, and **SST on digital services** to watch
  as revenue grows.

---

## 9. Delivery phases

| Phase | Deliverable | Gate |
|---|---|---|
| **0** | **Design system + clickable prototype** — customer menu, POS, owner console, BM & EN, on your phone | **You approve the look before any product code** |
| 1 | Monorepo, Cloudflare scaffold, D1 control plane, DO-per-outlet skeleton, auth, migration runner | Two outlets exist with provably isolated data |
| 2 | Customer QR ordering PWA, multi-tenant routed | Order from a phone lands in the right outlet's DO |
| 3 | Web POS — floor map, live orders over DO WebSockets | Phone order on the till in under 1s |
| 4 | Print pipeline — job queue, ESC/POS templates, retry | Real ticket prints in a real kitchen |
| 5 | **Android POS shell** — local SQLite, op-log sync, **dual-transport printing (LAN → Bluetooth)**; direct APK | **Router unplugged: kitchen still prints over Bluetooth** |
| 5b | **Tablet local web server** — embedded HTTP, customer menu served from the APK, hardened public-only routes, outage QR panel on table cards | **Internet unplugged: a phone on shop WiFi orders and the ticket prints** |
| 6 | Payments — DuitNow QR, cash, receipts, drawer, shift close | A full bill settles and closes |
| 7 | Owner console — multi-branch reporting, master menu, Telegram report | Owner reads both branches on her phone |
| 8 | **Pilot: both Suriani branches, real service, real money** | Two weeks of live service without a manual workaround |
| 9 | Productisation — setup wizard, compatibility list, runbook in BM, metering, PDPA docs | A stranger can self-onboard without you |
| 10 | First external restaurants | Three paying outlets you don't own |

**Not urgent, but has a ~30-day lead time when you do want it:** SSM registration → D-U-N-S number
→ Play Console *organization* account. Only needed once you distribute to restaurants you can't
physically visit; the pilot runs on direct APK. Worth starting SSM early anyway, since the business
entity is needed for payment gateways and PDPA terms regardless.

**Ship discipline:** soft-launch each restaurant on 2–3 tables during a quiet afternoon with paper
as backup, before rolling out the full floor.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| **Cross-tenant data leak** — fatal to trust | Structural isolation via DO-per-outlet + automated isolation tests in CI |
| **One bad deploy breaks every restaurant at once** | Staged rollout, feature flags, and the offline app means a cloud outage *degrades* rather than kills service |
| Restaurant's internet dies | POS keeps trading; tablet serves the menu to phones on shop WiFi; syncs on return |
| Router/WiFi dies | Print jobs fall back to Bluetooth automatically; POS unaffected |
| **Local server sits on a network customers share** | Separate public-only route table — menu read and order create against a valid table token, nothing else. No POS route, no sales figure, no staff auth exists on that server. Bound to the WLAN interface, rate-limited per IP |
| Android kills the local server in the background | Foreground service + persistent notification + `WifiLock`; tablet stays on mains power |
| Customers unsettled by the "Not secure" warning on the outage QR | Panel is explicitly labelled as the no-internet path and only used during an outage; wording tested during the pilot |
| Tablet or printer IP moves and printing dies silently | DHCP reservations for all three, verified by the setup wizard's test print |
| Supporting shops you can't visit | Device health telemetry, remote diagnostics, in-app support, plain-BM runbook with photos |
| Every restaurant's WiFi is different | Idiot-proof setup wizard: scan for printer → test print → save |
| Free-tier ceiling hit mid-service | Usage alerts at 70%; $5/mo upgrade is instant and pre-authorised |
| Printer jams / out of paper | Retry with backoff, visible POS alert, one-tap reprint |
| Prank orders to another table | Unguessable per-table token + rate limiting + void with reason |
| Elderly customers won't use phones | Cashier can enter any order manually — QR is an option, never the only path |
| Play Store needed later than expected | Not on the critical path — pilot ships as direct APK. SSM → D-U-N-S → organization account has a ~30-day lead time; start it before onboarding restaurants you can't visit |
| Solo maintainer (bus factor) | Runbook, infrastructure as code, boring well-documented choices |

---

## 11. Verification

Every phase demonstrated end-to-end, not just unit-tested:

1. **Tenant isolation** *(automated, blocking, runs on every CI build)* — outlet A's credentials must
   fail to read outlet B's orders, menu, and totals. This test never gets skipped.
2. **Ordering** — real QR, real phone → correct outlet, correct table, correct price snapshot.
3. **Realtime** — order placed on a phone appears on the till in under 1s, no refresh.
4. **Printing** — physically correct kitchen docket: table, items, quantities, notes, time, clean cut.
5. **Three outage drills, all mandatory before any restaurant goes live.** Each breaks a different
   thing, so passing one proves nothing about the others:
   - **Internet drill** — unplug the fibre mid-service. The POS keeps taking orders and closing
     bills, and a customer phone on the shop WiFi must still order via the outage QR and get a
     printed ticket. Reconnect: everything reconciles with **no duplicates and no losses**,
     including the orders placed through the tablet's own server.
   - **Router drill** — kill the router with the internet up. Kitchen tickets must still print,
     automatically, over Bluetooth, with no one touching a setting.
   - **Power drill** — pull the plug. On restore the tablet boots, the foreground service restarts,
     the local server comes back, and the database passes an integrity check with no lost orders.
6. **Payment** — settle by cash → drawer kicks, receipt prints, session closes, totals match.
7. **86-ing** — mark an item unavailable → it disappears from a phone already on the menu page.
8. **Load** — 25 tables ordering within 2 minutes: no dropped orders, no duplicate prints.
9. **Multi-outlet** — both branches trading simultaneously; consolidated report matches the sum.
10. **Automated** — Playwright for order → POS → print; Vitest for pricing, split-bill, sync
    convergence (including deliberately replayed and out-of-order ops).

---

## 12. Phase 0 — delivered

Shipped on `claude/restaurant-pos-system-ng3obi`, open as **PR #1**.

- `design/tokens.css` — the token system (kopitiam enamelware), light and dark.
- `design/prototype.html` — clickable prototype of all three surfaces, linked by shared state:
  ordering on the customer phone updates the POS floor map and prints a kitchen ticket. BM/EN
  toggle swaps every string through a translation layer.
- `docs/PLAN.md`, `README.md`.

Verified with Playwright: order loop end to end, language swap, both themes, no console errors.
Design feedback can land at any time — it does not conflict with Phase 1, which is backend only.

---

## 13. Phase 1 — delivered ✅

Pushed to PR #1. **CI green on its first run**: tenant guard, typecheck, lint, and **24 tests**
inside the real workerd runtime with real D1 and real Durable Objects.

The gate is met — two outlets exist and their data is provably separate, proven through the real
onboarding path rather than a test-only shortcut.

What shipped beyond the plan below, and why:

- **Ordering failures return values instead of throwing.** An unknown table token is the most common
  request this system will ever reject (stale printed QRs, bots probing). Throwing across the
  Durable Object RPC boundary logged every one as an uncaught exception, which would bury real
  faults in noise.
- **Both tenant-door guards were verified to actually fire** by planting a violation. A guard nobody
  has seen fail is not a guard.
- **The onboarding endpoint fails closed** — without `ADMIN_SEED_TOKEN` it answers 404, so it cannot
  sit unguarded in a deployment where nobody set the secret.
- **Login is indistinguishable between an unknown phone and a wrong PIN**, asserted by a test
  comparing the two response bodies.
- **TypeScript pinned to 6.x** — typescript-eslint 8 does not support the TS 7 (Go port) API yet.

Original plan follows.

---

## 13b. Phase 1 — build plan (as executed)

**Goal:** two outlets exist, each with its own data, and *provably* cannot see each other.
No UI, no WebSockets, no printing, no payments — those are Phases 2–6. Ends deployed to a free
`*.workers.dev` URL (Cloudflare account exists; custom domain comes later without code changes).

### Repository layout

pnpm workspaces from the start — `apps/pos` and `apps/menu` arrive in Phases 2–3 and moving a
single-package repo later is needless churn.

```
apps/api/
  src/
    index.ts              Worker entry, Hono app, route mounting
    lib/tenant.ts         THE ONLY DOOR to an outlet's data  ← see below
    lib/money.ts          integer-sen helpers, no floats anywhere
    lib/ids.ts            ULIDs, and unguessable qr_token generation
    auth/session.ts       signed cookie sessions (WebCrypto HMAC)
    auth/pin.ts           staff PIN hashing (PBKDF2 via WebCrypto)
    control/schema.ts     Drizzle schema for D1 (orgs, users, outlets, devices…)
    outlet/OutletDO.ts    the Durable Object — one per outlet
    outlet/schema.ts      Drizzle schema for the DO's own SQLite
    outlet/migrations.ts  versioned migration runner
  migrations/             D1 SQL migrations (wrangler d1 migrations)
  test/                   isolation · migrations · money · auth
  wrangler.toml
.github/workflows/ci.yml  typecheck · lint · test  (blocking)
```

`design/` and `docs/` stay where they are.

### The tenant door

Every path to outlet data goes through one function in `src/lib/tenant.ts`:

```
getOutletStub(env, session, outletId)
  1. look the outlet up in D1
  2. assert outlet.org_id === session.org_id   → otherwise 404, never 403
  3. return env.OUTLET.get(env.OUTLET.idFromName(outlet.do_id))
```

Three details that make this hold:

- **404, not 403.** A 403 confirms the outlet exists. Never leak the existence of another
  tenant's data.
- **`do_id` is a random string stored in D1**, not the outlet id. Guessing an outlet id gets you
  nowhere near the Durable Object.
- **No other file may call `env.OUTLET.get`.** Enforced by an ESLint `no-restricted-syntax` rule
  *and* by a source-level test that greps the tree — the cheap check that actually catches the
  regression a year from now.

### Durable Object per outlet

- Declared with `new_sqlite_classes` in `wrangler.toml`. **Required** — the Workers Free plan only
  supports Durable Objects with the SQLite storage backend.
- Drizzle via `drizzle-orm/durable-sqlite`; D1 via `drizzle-orm/d1`. One ORM, one schema language,
  three SQLite targets (D1, the DO, and the phone in Phase 5).
- Migrations run in the constructor inside `blockConcurrencyWhile`, keyed on `user_version`, so a
  sleeping outlet migrates itself the moment it next wakes. No fleet-wide migration job.
- Full schema lands now — including `payments`, `print_jobs`, `op_log` — even though Phases 4–6
  fill them. Adding empty tables is free; churning migrations across live outlets is not.

### Auth

Staff PIN on a trusted device: PBKDF2 hashing and HMAC-signed session cookies, both via WebCrypto
(Workers has no bcrypt). Roughly 100 lines, fully auditable.

Deliberately **not** pulling in Better Auth yet — Phase 1 has no self-serve signup, only seeded
staff. Adopt it at Phase 9 when onboarding strangers defines the real requirements.

### Seed

`pnpm seed` creates Restoran Suriani with **Kampung Baru and Bangi**, the nine menu items from the
prototype, and 16 tables per outlet with random `qr_token`s. Two real branches from day one, and
Phase 2 has something to render.

### Files to create

`apps/api/src/lib/tenant.ts` · `apps/api/src/outlet/OutletDO.ts` · `apps/api/src/outlet/migrations.ts`
· `apps/api/src/control/schema.ts` · `apps/api/src/auth/session.ts` · `apps/api/wrangler.toml` ·
`apps/api/test/isolation.test.ts` · `.github/workflows/ci.yml` · `pnpm-workspace.yaml`

### Verification

Tests run in **`@cloudflare/vitest-pool-workers`** — inside the real workerd runtime with real D1
and real Durable Objects. Mocked tenant isolation would prove nothing.

1. **`isolation.test.ts` — the blocking gate.** Seed org A/outlet A1 and org B/outlet B1, place an
   order in each, then assert: A's session reading B1 returns **404**; a cookie with a swapped
   `org_id` fails signature; a guessed outlet id never resolves to a DO; and no file outside
   `lib/tenant.ts` calls `env.OUTLET.get`.
2. **`migrations.test.ts`** — migrations advance `user_version`, and re-running is idempotent.
3. **`money.test.ts`** — totals, modifiers and rounding in integer sen; a property test asserting
   no float ever enters a total.
4. **Manual** — `pnpm dev`, create an order in each outlet over HTTP, confirm separation by
   inspecting each DO.
5. **Deploy** — `wrangler deploy`, hit the `*.workers.dev` URL, then
   `wrangler d1 execute --remote` to confirm the control-plane rows landed.

### Your setup checklist (needed only at the deploy step)

1. Create a Cloudflare API token (Workers Scripts: Edit, D1: Edit) → save as `CLOUDFLARE_API_TOKEN`.
2. Confirm the account has **no key-value-backed Durable Object namespace** — its presence blocks
   the free SQLite-backed tier.
3. Buy the domain whenever you like. Not needed for Phase 1.

Everything before the deploy step runs locally with no account.

---

## 14. Phase 2a — configurable tables

**Goal:** a restaurant's tables are its own, not whatever the seed script invented. Add, rename,
group, archive; regenerate a compromised QR; print the cards.

This comes before the customer app because tables are what QR codes point at. Everything downstream
— the printed cards, the POS floor map, the pilot itself — depends on them being real.

### Schema (outlet DO, migration v2)

```
zones          id, name_ms, name_en, sort_order
tables         + zone_id, capacity, sort_order,
               + archived_at        ← soft delete, never DELETE
               + token_rotated_at
settings       single-row outlet config: guest WiFi SSID/password,
               local ordering URL (used by the printed outage panel)
```

**Archive, never delete.** `table_sessions.table_id` points at these rows, so a real `DELETE` would
orphan every historical bill that table ever had — "Meja 05" becomes "?" in last month's reports.
Archived tables stay queryable for history and disappear only from active listings.

This is also the **first real exercise of the per-outlet migration runner** — until now it has only
ever built a schema from scratch. A test must confirm v2 applies to an outlet that already holds v1
data *and that the data survives*.

### API — role-gated to owner and manager

```
GET    /api/outlets/:id/tables                    list (active, or ?includeArchived)
POST   /api/outlets/:id/tables                    create one
POST   /api/outlets/:id/tables/bulk               "Meja 01–12" in one call
PATCH  /api/outlets/:id/tables/:tableId           label, zone, capacity, order
POST   /api/outlets/:id/tables/:tableId/rotate    new QR secret  (requires confirm: true)
DELETE /api/outlets/:id/tables/:tableId           soft archive
GET    /api/outlets/:id/zones  + POST/PATCH/DELETE
GET    /api/outlets/:id/tables/cards              printable QR cards (HTML)
```

**Two different kinds of "no", and they must not be merged:**

| Situation | Answer | Why |
|---|---|---|
| Another org's outlet | **404** | You may not know it exists |
| Cashier editing tables in *their own* outlet | **403** | Legitimately here, just not permitted |

Using 404 for both would hide permission bugs behind a plausible-looking response; using 403 for
both would leak the customer list. Add a `requireRole()` helper alongside the existing session
middleware in `apps/api/src/index.ts`.

### Rules that prevent real damage

1. **Cannot archive a table with an open bill** → 409 with a message naming the open session.
2. **Rotating a QR instantly kills the printed card.** Requires an explicit `confirm: true`, and is
   written to `audit_log` with who did it. The old token must 404 immediately.
3. **Labels are unique among active tables** in an outlet. Two "Meja 05" is a service disaster, and
   bulk-create must refuse to collide with existing labels rather than silently skipping.
4. Archiving is reversible; restoring re-checks the label collision rule.

### Printable QR cards

`GET /api/outlets/:id/tables/cards` renders a print-ready HTML page — one card per table, styled
with `design/tokens.css`, `@page` sized for the acrylic stands, `page-break-after` between cards.
The owner opens it and presses Print.

Each card carries the restaurant name, the table label, and the ordering QR. The **"Tiada internet?"
outage panel is rendered only when the outlet has a local ordering URL configured** — which it will
not until Phase 5b. Until then the card is still complete and correct; the panel appears
automatically once offline mode exists, with no redesign.

QR encoding needs a pure-JS library that runs in Workers (no canvas, no native deps) emitting SVG.

### Verification

1. **Migration upgrade** — an outlet with v1 data and real orders migrates to v2 with every row
   intact. This is the test that matters most; it is the first upgrade the runner has ever done.
2. **Role gate** — a cashier session gets **403** on every table mutation, while owner and manager
   succeed. A different-org session gets **404** on the same routes.
3. **Open bill** — archiving a table mid-service is refused with 409.
4. **Rotation** — after rotating, the old token 404s and the new one serves the menu, in the same test.
5. **Collisions** — duplicate labels rejected on both single and bulk create.
6. **History survives archiving** — archive a table that has orders, then confirm past orders still
   report "Meja 05" rather than "?".
7. **Cards** — the printed page contains one card per active table and none for archived ones, and
   the encoded QR payload string matches that table's real ordering URL.

---

## 15. Phase 2b — customer QR ordering app

**Goal:** the customer surface becomes real. Someone scans the QR on a table, orders from their own
phone, and it lands in that outlet's Durable Object and nowhere else.

Phase 0 designed this screen, Phase 1 built the API, Phase 2a made the tables real. This joins them.

### 🔴 First: close a price-trust hole already in shipped code

`OutletDO.placeOrder` computes a line total as
`lineTotalSen(item.priceSen, line.qty, line.modifiers)` — where `line.modifiers` comes **straight
from the request body**, carrying its own `priceDeltaSen`. The customer ordering endpoint is public,
so today this works:

```json
{ "lines": [{ "menuItemId": "itm_nasilemak", "qty": 1,
              "modifiers": [{ "label": "Diskaun", "priceDeltaSen": -1000 }] }] }
```

The customer sets their own price. Nothing sends modifiers yet, so it is unexploited — but it is
live, and it is exactly the mistake that snapshotting `unit_price_sen` from the menu exists to
prevent. Half the rule was applied and half was not.

**The fix, which is also the feature:** modifier options are defined server-side per menu item, and
the client sends only **option ids**. The server looks up each label and price delta from its own
database. A price never arrives from a phone.

This is why "add modifiers" is not a nice-to-have here — the safe design and the useful feature are
the same piece of work.

### Migration v3 — modifier definitions

```
modifier_groups   id, menu_item_id, name_ms, name_en,
                  min_select, max_select, sort_order
modifier_options  id, group_id, label_ms, label_en, price_delta_sen, sort_order
```

Server-side validation on every order line: each referenced option must belong to a group belonging
to that menu item, and each group's `min_select`/`max_select` must be satisfied. `order_items.modifiers`
keeps storing the **resolved snapshot** (label + price at time of order), so a reprinted ticket or a
month-old bill still reads correctly even after the options change.

Seed data gains the obvious Malaysian cases: Teh Tarik *panas / ais*, Nasi Lemak *tambah telur,
tambah ayam*, Mee Goreng *kurang pedas*.

### Decisions taken

1. **One Worker serves both the app and the API**, via Workers static assets. Same origin, no CORS,
   one deployment, no chance of the two drifting apart in production.
2. **The route split changes now, while it is cheap.** `/t/:outletId/:qrToken` currently returns
   JSON, but it is the URL printed on the table cards Phase 2a generates — it must serve HTML to a
   human. Data moves to `/api/t/:outletId/:qrToken`. This touches **four** test files
   (`isolation`, `onboarding`, `tables`, `orders`), not two.
3. **Cart lives on the phone** in `localStorage`, keyed by the table token, and a service worker
   caches the menu — so losing signal mid-meal neither blanks the page nor loses the cart. This is
   the customer-side half of the offline promise the whole product is built on.
4. **The client mints the order ULID before its first attempt** and reuses it on retry. The server
   already deduplicates, so a flaky tap cannot double-order — the same property Phase 5's offline
   replay depends on, exercised early.
5. **Ordering only.** *Minta Bil* and *Panggil Pelayan* need a cashier screen to ring on; they land
   in Phase 3 with the POS.
6. **Static confirmation**, showing the order, the total, and an ETA derived from `prep_minutes`.
   It does not animate on its own until Phase 3 has something real to report.

### New package: `apps/menu`

Vite + React + TypeScript, consuming `design/tokens.css` unchanged.

Reused directly from the Phase 0 prototype, which was the specification: the enamel-plate dish SVGs,
the translation-layer shape, the category rail, the morphing cart bar, every token. The look is not
redesigned here — it is the approved design, made real.

```
apps/menu/src/
  App.tsx        route: /t/:outletId/:qrToken
  api.ts         typed client for the customer endpoints
  cart.ts        cart state, localStorage persistence, sen arithmetic
  i18n.ts        BM/EN dictionary — same shape as the prototype
  art.tsx        the enamel-plate dish illustrations
  screens/       Menu · ItemSheet (modifiers) · Cart · OrderPlaced · TableNotFound
```

### Files to change

`apps/api/src/outlet/migrations.ts` (v3) · `apps/api/src/outlet/schema.ts` ·
`apps/api/src/outlet/OutletDO.ts` (server-side modifier resolution — the security fix) ·
`apps/api/src/index.ts` (route move, SPA fallback) · `apps/api/wrangler.jsonc` (assets binding) ·
`apps/api/src/seed-data.ts` (modifier groups) · the four test files above.

Reuse rather than rewrite: `lineTotalSen`/`formatMYR` from `apps/api/src/lib/money.ts`, `ulid` from
`apps/api/src/lib/ids.ts`, and `batchForSql` from `apps/api/src/lib/chunk.ts` — extract the shared
ones into `packages/core` rather than copying, because a second implementation of money arithmetic
is precisely how the two drift apart.

### Explicitly not in Phase 2b

Live status over WebSockets (Phase 3), printing (Phase 4), bill requests and waiter calls (Phase 3),
payments and split bills (Phase 6).

### Verification

1. **The price-trust regression test, and it must fail without the fix.** Post an order with a
   forged `priceDeltaSen: -1000` and with an option id belonging to a *different* menu item; both
   must be rejected, and the recorded total must match the server's own prices.
2. **Modifier rules** — a group with `min_select: 1` rejects an order that omits it; `max_select`
   rejects too many; a valid selection prices correctly and the snapshot survives a later price edit.
3. **Playwright against `wrangler dev`**, the path a customer actually takes: seed → open a real
   table QR URL → toggle to English → pick a dish with options → add two items → order → assert 201,
   cart cleared, confirmation shown.
4. **Cross-outlet** — order at Kampung Baru, assert via the staff API that Bangi still has zero.
   The Phase 1 guarantee, re-proven from the customer surface.
5. **Cart survival** — add items, reload, cart intact. Then go offline and confirm the menu still
   renders from cache rather than blanking.
6. **Double submit** — same ULID twice; exactly one order.
7. **Unknown, stale or rotated token** — a clear "meja tidak dijumpai" screen in both languages,
   never a stack trace or a blank page.
8. **All 37 existing tests stay green** after the route move.
9. **Weight budget** on a throttled 3G profile — this is opened on a stranger's phone in a shop with
   bad signal, and a slow first paint is the whole product's first impression.

---

_Verified against live sources: [Workers pricing & limits](https://developers.cloudflare.com/workers/platform/pricing/) ·
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) ·
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) ·
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) ·
[Turso database-per-tenant](https://turso.tech/multi-tenancy) ·
[Android developer verification](https://support.google.com/android-developer-console/answer/16561738?hl=en) ·
[Play 12-tester rule: personal vs organization](https://ontest.app/blog/personal-vs-organization-google-play-account-12-testers) ·
[DuitNow QR developer docs](https://docs.developer.paynet.my/docs/duitNow-QR/introduction/overview) ·
[LHDN e-Invoice RM1m threshold](https://rtcsuite.com/malaysias-new-rm1-million-e-invoicing-threshold-a-focused-update/)_
