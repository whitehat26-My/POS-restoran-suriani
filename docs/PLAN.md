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
| Offline strategy | **Android POS app** with local database + direct LAN printing |
| Hardware | **Bring your own**, against a compatibility list we test and publish |
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
        │  order.suriani.my/t/<token>                  │  local SQLite + op log
        │                                              │        │
        ▼                                              ▼        │ TCP :9100
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
Capacitor for the Android POS shell · raw ESC/POS over TCP for printing.

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

**Customer phones stay pure web** — no install, ever. During an outage, customers on the shop WiFi
can still reach the ordering page; customers on mobile data can't, and the cashier takes their order
manually. That's an honest, acceptable degradation.

### Distribution: Play Store, App Store, or direct APK?

Different answer for each of the three surfaces.

**Customer ordering — web only, never an app store.** This is not a close call. Nobody installs an
app to order nasi lemak. Requiring an install would destroy the single best thing about the product
(scan → ordering in 10 seconds) and every percent of install friction is a customer who walks. The
QR opens a web page. Forever.

**Cashier POS — Google Play, yes, but staged:**

| Stage | Distribution | Why |
|---|---|---|
| Phases 5–7 (build) | Direct APK to your 2 branches | The app changes daily; store review would strangle iteration |
| Phase 8–9 (pilot) | **Play Console closed testing track** | Auto-updates without a public listing — the sweet spot |
| Phase 10 (selling) | **Play Store production** | Credibility and auto-updates for restaurants you'll never visit |

Auto-update is the real reason, not discoverability. You cannot drive to 50 restaurants to
sideload an APK. Restaurant owners also judge legitimacy by whether you exist in the Play Store.

**Two things to act on now, because they have long lead times:**

1. **Register the Play developer account as an *organization*, not personal.** Personal accounts
   created after 13 Nov 2023 cannot ship to production until **12 testers stay opted into closed
   testing for 14 consecutive days** — and the streak resets if anyone drops out. **Organization
   accounts are exempt.** You need a registered business and a **D-U-N-S number, which takes
   ~30 days to obtain**, so start that application in parallel with Phase 0. You need SSM
   registration for the business anyway.
2. **Direct APK distribution has a shelf life.** Google now requires developer verification to
   install Android apps *including sideloading*. It takes effect **September 2026 in Brazil,
   Indonesia, Singapore and Thailand, going global in 2027**. Malaysia isn't in the first wave, but
   unverified sideloads will eventually mean a 24-hour wait or ADB — unusable for restaurant staff.
   Get verified early; it's free and removes the deadline entirely.

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
| Cashier tablet | Android 11+, 10–11", 4 GB RAM | Galaxy Tab A9+, Lenovo Tab M11, Redmi Pad SE |
| Kitchen printer | 80 mm, **Ethernet**, ESC/POS, port 9100, auto-cutter | Epson TM-T82X, Epson TM-m30III, Xprinter XP-N160II, Rongta RP80 |
| Counter printer | Same + RJ11 drawer kick | as above |
| Cash drawer | RJ11, printer-kicked | any |
| Router | Must support DHCP reservation; two SSIDs | TP-Link Archer AX23, Deco |
| UPS | 650 VA+ | any |
| QR stands | A6/A7 acrylic, one per table | any |

**A typical restaurant spends roughly RM2,000–3,000** — and you never touch a purchase order.

Setup notes that go in the customer runbook: **static IPs (DHCP reservations) for both printers**
— printers that move IP are the classic "why did printing stop" call — and printers on **Ethernet,
never Bluetooth**.

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
| 5 | **Android POS shell** — local SQLite, op-log sync, LAN printing; direct APK | **Internet unplugged: orders taken, tickets printed, clean resync** |
| 6 | Payments — DuitNow QR, cash, receipts, drawer, shift close | A full bill settles and closes |
| 7 | Owner console — multi-branch reporting, master menu, Telegram report | Owner reads both branches on her phone |
| 8 | **Pilot: both Suriani branches, real service, real money** | Two weeks of live service without a manual workaround |
| 9 | Productisation — setup wizard, compatibility list, runbook in BM, metering, PDPA docs; **Play Store closed testing** | A stranger can self-onboard without you |
| 10 | First external restaurants; **Play Store production** | Three paying outlets you don't own |

**Start immediately, in parallel — these have ~30-day lead times and will otherwise block Phase 9:**
SSM business registration → **D-U-N-S number** → **Play Console organization account** → Android
developer verification. None of it depends on any code being written.

**Ship discipline:** soft-launch each restaurant on 2–3 tables during a quiet afternoon with paper
as backup, before rolling out the full floor.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| **Cross-tenant data leak** — fatal to trust | Structural isolation via DO-per-outlet + automated isolation tests in CI |
| **One bad deploy breaks every restaurant at once** | Staged rollout, feature flags, and the offline app means a cloud outage *degrades* rather than kills service |
| Restaurant's internet dies | Android POS keeps trading and printing; syncs on return |
| Supporting shops you can't visit | Device health telemetry, remote diagnostics, in-app support, plain-BM runbook with photos |
| Every restaurant's WiFi is different | Idiot-proof setup wizard: scan for printer → test print → save |
| Free-tier ceiling hit mid-service | Usage alerts at 70%; $5/mo upgrade is instant and pre-authorised |
| Printer jams / out of paper | Retry with backoff, visible POS alert, one-tap reprint |
| Prank orders to another table | Unguessable per-table token + rate limiting + void with reason |
| Elderly customers won't use phones | Cashier can enter any order manually — QR is an option, never the only path |
| **Play Store production blocked at launch** | Register as an **organization** account (exempt from the 12-tester/14-day rule); start SSM + D-U-N-S on day one |
| Android sideload verification tightening (global 2027) | Complete developer verification early — free, and removes the deadline |
| Solo maintainer (bus factor) | Runbook, infrastructure as code, boring well-documented choices |

---

## 11. Verification

Every phase demonstrated end-to-end, not just unit-tested:

1. **Tenant isolation** *(automated, blocking, runs on every CI build)* — outlet A's credentials must
   fail to read outlet B's orders, menu, and totals. This test never gets skipped.
2. **Ordering** — real QR, real phone → correct outlet, correct table, correct price snapshot.
3. **Realtime** — order placed on a phone appears on the till in under 1s, no refresh.
4. **Printing** — physically correct kitchen docket: table, items, quantities, notes, time, clean cut.
5. **Offline drill** *(mandatory before any restaurant goes live)* — unplug the internet mid-service.
   Orders must be taken, kitchen tickets must print, bills must close. Reconnect: everything
   reconciles with **no duplicates and no losses**.
6. **Payment** — settle by cash → drawer kicks, receipt prints, session closes, totals match.
7. **86-ing** — mark an item unavailable → it disappears from a phone already on the menu page.
8. **Load** — 25 tables ordering within 2 minutes: no dropped orders, no duplicate prints.
9. **Multi-outlet** — both branches trading simultaneously; consolidated report matches the sum.
10. **Automated** — Playwright for order → POS → print; Vitest for pricing, split-bill, sync
    convergence (including deliberately replayed and out-of-order ops).

---

## Immediate next step

**Phase 0** — the design system and a fully clickable prototype of all three surfaces (customer menu,
cashier POS, owner console) in BM and English, openable on your phone. Nothing gets built for real
until you look at it and say yes.

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
