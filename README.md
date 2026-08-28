# Suriani POS

A multi-tenant QR-ordering point-of-sale system for Malaysian restaurants.

Customers scan a QR code at their table and order from their own phone — no app install.
Orders appear live on the cashier till and print in the kitchen. Customers pay after eating,
by DuitNow QR or cash. It keeps working when the restaurant's internet dies.

Two branches of Restoran Suriani are customer zero.

## Status

**Phase 4c complete.** The restaurant's real printed menu — 13 sections, 147 dishes, and the
card's RM 0.50 rule — behind a request box on every dish, a printable bill, and a daily record.

| Phase | | |
|---|---|---|
| 0 | Design system + clickable prototype | ✅ |
| 1 | Cloudflare scaffold, control plane, one Durable Object per outlet, auth | ✅ |
| 2a | Configurable tables, zones, QR rotation, printable cards | ✅ |
| 2b | Customer ordering app — menu, modifiers, cart, offline shell | ✅ |
| 3 | Cashier POS — live floor map, tickets, bills, 86-ing, Minta Bil / Panggil Pelayan | ✅ |
| 4 | Print pipeline — ESC/POS, station routing, retry, reprint | ✅ |
| 4b | Per-dish requests, printable bill, daily record history | ✅ |
| 4c | The real printed menu — 13 sections, 147 dishes, the RM 0.50 rule | ✅ |
| 5 | Android POS shell — offline, dual-transport printing | next |

Full plan and roadmap: [`docs/PLAN.md`](docs/PLAN.md).

## Managing the floor plan

Tables belong to the restaurant, not to a seed script.

```
POST   /api/outlets/:id/tables            one, or {"labels": ["Meja 01", …]}
PATCH  /api/outlets/:id/tables/:tableId   label, zone, capacity, order
POST   /api/outlets/:id/tables/:id/rotate new QR secret — needs {"confirm": true}
DELETE /api/outlets/:id/tables/:tableId   archive (never a real delete)
GET    /api/outlets/:id/tables/cards      print-ready A6 cards
```

Four rules that exist because the alternative loses data or breaks service:

- **Archive, never delete.** `table_sessions` points at these rows, so a real delete would turn
  "Meja 05" into "?" in every historical bill.
- **Archiving refuses while a bill is open** (409), so tidying the floor plan mid-service cannot
  strand a table that is still eating.
- **Rotating a QR needs explicit confirmation** and is audited — it instantly kills the printed card.
- **Duplicate labels are rejected**, and a colliding bulk create writes nothing rather than
  partially succeeding.

Cashiers get **403** on all of these; another organisation gets **404**. Those are different
answers on purpose — 404 everywhere would hide permission bugs, 403 everywhere would leak the
customer list.

## Getting started

```bash
pnpm install
pnpm --filter @suriani/api db:migrate:local   # apply the control-plane schema
pnpm dev                                      # wrangler dev on :8787
```

Onboard Restoran Suriani and both branches:

```bash
echo 'ADMIN_SEED_TOKEN=any-local-value' > apps/api/.dev.vars   # then restart dev
ADMIN_SEED_TOKEN=any-local-value pnpm seed
```

The seed prints a working table QR URL for each branch.

## The menu

[`apps/api/src/seed-data.ts`](apps/api/src/seed-data.ts) is a transcription of the restaurant's
printed card: **13 sections and 147 dishes**, in the card's own order, plus an empty Burger section
the owner is keeping for later. It stays there until Phase 7 gives her an editor.

Two rules the card states that the code has to enforce:

- **"Minuman sejuk & bungkus dikenakan caj tambahan RM 0.50"** — and it is charged **once**, not
  twice. An iced takeaway teh tarik is RM 3.00, not RM 3.50. Modelled as *one* single-select group
  per drink (*panas · ais · bungkus panas · bungkus ais*) rather than two independent `+50` options,
  which makes the cap structural: you cannot choose twice, so you cannot be charged twice.
- **"MEE • KUETIAU • BIHUN • MAGGI" over "GORENG / SUP"** are choices, not decoration. Nine dishes
  with two free required options each, instead of seventy-two rows.

**Dish names are stored in full** — "Nasi Goreng Kampung", "Roti Susu" — because *Susu*, *Milo*,
*Telur Mata* and *Ayam Goreng* each appear in two sections at two prices, and a docket reading
"1x Susu" for a Roti Susu is a real mis-serve. The phone shortens them against the heading, exactly
as the printed card does, via `shortLabel()` in [`packages/core`](packages/core/src/menu.ts).

`test/menu-data.test.ts` asserts the section sizes and a spread of prices straight off the card, so
a typo in one of 147 rows fails CI instead of reaching a customer.

To push a changed menu to branches that are already seeded:

```bash
ADMIN_SEED_TOKEN=any-local-value pnpm seed --sync-menu
```

That upserts every category, dish, option and print route, **and removes what the file no longer
lists**. It is opt-in for exactly that reason. Two things it deliberately leaves alone: a dish the
kitchen has 86'd stays 86'd, and table QR codes are never touched. Deleting a dish is safe because
`order_items` snapshots the name and price — last month's bill still reads correctly without it.

```bash
pnpm test        # 119 tests (17 ESC/POS golden bytes + 102 in the Workers runtime)
pnpm typecheck
pnpm lint
```

## How isolation works

Each restaurant branch gets **its own Durable Object with its own SQLite database**. There is no
`org_id` column anywhere in the outlet schema, because isolation is the storage boundary rather
than a `WHERE` clause someone can forget.

Every path to an outlet's data goes through one function, `getOutletForSession()` in
[`src/lib/tenant.ts`](apps/api/src/lib/tenant.ts). Three details make it hold:

- It answers **404, not 403**, across tenants. A 403 confirms the outlet exists, which would let
  someone enumerate every restaurant on the platform one id at a time.
- The Durable Object is addressed by a **random `do_id`** held in D1, never derived from the outlet
  id, so guessing outlet ids leads nowhere.
- **`env.OUTLET.get` may appear in exactly one file.** Enforced by an ESLint rule *and* by
  `scripts/check-tenant-door.mjs`, which greps the tree and cannot be silenced with an inline
  comment. Both are verified to fire.

`test/isolation.test.ts` is a blocking CI gate and must never be skipped.

## Layout

```
apps/api/            Cloudflare Worker — API, control plane, outlet Durable Object
  src/lib/tenant.ts  the single door to outlet data
  src/outlet/        per-outlet schema, migrations, Durable Object
  src/control/       D1 schema: orgs, users, outlets, devices, usage
  test/              isolation · onboarding · tables · modifiers · pricing ·
                     realtime · printing · money · menu-sync · reports · menu-data
apps/menu/           customer ordering app (Vite + React), served at /
apps/pos/            the till and the owner's daily record (Vite + React, dark), at /pos/
                     — both assembled into apps/api/.assets by `pnpm build:web`;
                     each app's e2e/ holds its browser test
packages/core/       shared money arithmetic, ids and menu labelling — one
                     implementation for the API, the customer app, and later
                     the tablet
packages/escpos/     ESC/POS encoder + ticket templates, golden-byte tested
tools/printer-sim/   a thermal printer that isn't there (TCP :9100)
tools/print-agent/   claims jobs, prints, acks; reference for Phase 5 Android
design/              tokens.css and the Phase 0 clickable prototype
docs/PLAN.md         product plan, architecture, phasing
```

## The till

`/pos/` on the same Worker. PIN login, then one dark screen (less glare over a ten-hour
shift): the floor map grouped by the outlet's real zones, a live ticket feed, and the menu
column for counter orders and 86-ing.

- **Realtime is the Durable Object itself.** The object that stores an order broadcasts it
  over hibernatable WebSockets in the same call — no separate pub/sub to drift. Every
  connection starts with a full floor snapshot, so a reconnecting till never renders stale
  state. Outgoing WS messages are free and idle sockets hibernate, so a quiet till costs
  nothing.
- **Customer phones poll instead** (~12s while an order is open): the status endpoint walks
  the Diterima → Dimasak → Dihidang track and carries a `menuVersion` — when the cashier taps
  "86", phones already on the menu quietly refetch.
- *Minta Bil* turns the table amber on the floor map; *Panggil Pelayan* rings once per minute
  per table, coalescing impatient taps.
- **Tapping a table answers the counter's first question** — a strip across the top of the bill
  reads *"7 hidangan · RM 84.20"* before any scrolling, then every order and line beneath it.
- **The menu column has a search box**, because 147 dishes in one scroll is not something anyone
  can work during service.
- **"Cetak resit" prints the bill** at the counter station. Nothing has been paid yet, so the slip
  says `BIL`, names no payment method, and does not kick the drawer. Phase 6 calls the same
  renderer with a method and gets a paid receipt with the pulse.
- Closing a bill is the primitive Phase 6's payments will front — explicit and audit-logged,
  never silent.

## The daily record

A **Rekod** tab beside the outlet switcher, for owners and managers only — a cashier gets 403,
another organisation gets 404. Laid out to work at phone width, because the owner reads yesterday's
takings on her phone rather than walking to the counter.

```
GET /api/outlets/:id/reports/daily?days=30   date, sales, bills, dishes — newest first
GET /api/outlets/:id/reports/daily/:date     that day by hour, by dish, by category
```

- **A day is derived from the orders, not from a rollup table.** That costs a range scan and buys
  three things worth more: the number is right retroactively, it cannot drift from the orders it
  claims to summarise, and there is no nightly job whose silent failure leaves a hole in the books.
- **Days are bucketed in the outlet's own timezone**, taken from D1 and never from the request.
  An 8pm order in Kuala Lumpur is 12:00 UTC the next day — bucket by UTC and every evening's
  takings quietly land on tomorrow. There is a test that fails if that regresses.
- It says **Jualan**, not *untung*. The system knows what the restaurant took, not what the
  ingredients cost. Profit needs cost prices per dish; that is Phase 7, and until it exists a
  number labelled profit would be a number that gets believed.

## Printing

Orders fan out to print stations by menu category — nasi to the kitchen, teh tarik to
the drinks counter — one docket per station per order.

```
POST /api/outlets/:id/agents          register a print agent (token shown once)
GET  /api/agent/jobs                  claim leased jobs -> base64 ESC/POS
POST /api/agent/jobs/:id/ack          {ok:true,transport} | {ok:false,error}
GET  /api/outlets/:id/print/health    queued / failed / stalled, for the till
```

- **The Worker renders, the agent just moves bytes.** Layout lives in `packages/escpos`
  under golden byte tests, so fixing a docket is a deploy — never a visit to a restaurant.
- **Jobs are leased, not deleted, on claim.** An agent that dies mid-print releases its
  job by expiry and another attempt happens. Deleting on claim loses the docket silently.
- **Failures retry with backoff, then alarm loudly** — a red banner naming the table with
  one-tap reprint. A `stalled` flag catches the worse case where nothing is failing
  because the agent is simply gone.
- **A reprint renders from the stored snapshot**, so last week's docket is identical even
  after prices changed, and is stamped `CETAK SEMULA` so nobody cooks it twice.
- Agent tokens are PBKDF2-hashed and scoped to one outlet: a stolen token reaches one
  restaurant's print queue and cannot read sales or touch a bill.

No printer yet? `tools/printer-sim` listens on :9100 like a real one and renders the slip
to your terminal; `tools/print-agent` drives it, and drives real hardware unchanged.

## The customer surface

`/t/<outletId>/<qrToken>` — the URL on every printed card — serves the ordering app;
its data lives under `/api/t/...`. One Worker serves both, so they cannot drift.

- **The whole printed menu, 4.8 KB gzipped** — 14 sections and 147 dishes, listed short under
  their heading the way the card does. A section with nothing in it yet says so rather than
  rendering blank.
- **Every dish takes a request.** Tapping any item opens a sheet with its options, a quantity
  stepper, and an *"Ada permintaan?"* box with one-tap chips (kurang manis, tanpa cili, bungkus).
  It is on every dish, not only the ones with options: half the menu has no options at all, and a
  customer should not have to guess which dishes will listen. The note reaches the kitchen docket
  and the counter bill.
- **Prices never come from the phone.** Menu prices are snapshotted server-side, and
  modifier options ("tambah telur", "panas/ais") are sent as ids that the server
  resolves against its own tables. A forged `priceDeltaSen` in the request body is
  rejected — there is a regression test that proves the exploit died.
- **The cart lives in localStorage** keyed by the table token, and a service worker
  keeps the menu readable offline. Losing signal mid-meal loses nothing.
- **Orders are idempotent.** The client mints a ULID before its first attempt and
  reuses it on retries, so a double tap or flaky connection cannot double-order.
- 66 KB gzipped: fast on a stranger's phone in a shop with bad signal.

## Stack

Everything runs on free tiers that permit commercial use.

| Layer | Choice |
|---|---|
| API | Cloudflare Workers + Hono |
| Control plane | Cloudflare D1 (SQLite) |
| Per-outlet data | One Durable Object per outlet, SQLite storage backend |
| ORM | Drizzle — one schema language across D1, the Durable Object, and the tablet |
| Cashier app | React POS in a Capacitor Android shell (Phase 5) |
| Customer menu | Plain web. No install, ever. |
| Kitchen | 80mm ESC/POS over TCP, falling back to Bluetooth |

Free tier covers both branches plus a few pilot restaurants; the step up is **$5/month**.

## Conventions

- **All money is integer sen.** Never a float — see [`packages/core/src/money.ts`](packages/core/src/money.ts).
- **Order prices are snapshotted** onto the order line. Changing a menu price must never alter a
  bill already taken.
- **A table's QR carries a 160-bit secret**, not its table number.
- **Orders are append-only facts** keyed by a client-generated ULID, so a tablet can replay its op
  log after an outage without billing anyone twice.
