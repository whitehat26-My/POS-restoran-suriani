# Suriani POS

A multi-tenant QR-ordering point-of-sale system for Malaysian restaurants.

Customers scan a QR code at their table and order from their own phone — no app install.
Orders appear live on the cashier till and print in the kitchen. Customers pay after eating,
by DuitNow QR or cash. It keeps working when the restaurant's internet dies.

Two branches of Restoran Suriani are customer zero.

## Status

**The counter is the primary way an order is taken**, with the QR as an option
rather than the only path — customers order to a person and the cashier records
it. See [Taking the order](#taking-the-order).

**Phase 6 (payments) complete.** A bill settles and closes: cash or DuitNow QR, the change worked
out before the drawer opens, a real receipt with a receipt number, and the drawer pulse on the wire.
At closing time the counted cash is checked against what the till says should be there, and a short
drawer says it is short.

**Phase 5b is built and awaiting hardware.** Cut the till's line and it keeps taking orders — and
now keeps taking money too; restore it and everything lands exactly once. The tablet also serves the
customer menu itself, so a phone on the shop's WiFi can order with the internet unplugged. The three
outage drills on real hardware are what close 5b out.

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
| 5 | Offline engine — op log, outbox, replay-safe sync | ✅ |
| 5b | Android shell — native printing, tablet setup, the tablet's own web server, APK in CI | 🚧 |
| 6 | Payments — cash and DuitNow QR, split bills, discounts, receipts, drawer, day close | ✅ |

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
pnpm test        # 153 tests (17 ESC/POS + 11 offline + 10 printer + 115 in the Workers runtime)
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
                     realtime · printing · money · menu-sync · reports ·
                     menu-data · sync
apps/menu/           customer ordering app (Vite + React), served at /
apps/pos/            the till and the owner's daily record (Vite + React, dark), at /pos/
                     — both assembled into apps/api/.assets by `pnpm build:web`;
                     each app's e2e/ holds its browser test
packages/core/       shared money arithmetic, ids, menu labelling and the
                     category→station rule — one implementation for the API,
                     the customer app and the tablet
packages/offline/    the till's offline spine: op log, outbox, drain loop
packages/printer/    LAN→Bluetooth transport choice and the claim/print/ack loop
packages/localserver/ the tablet's own public route table — menu read and order
                     create, and deliberately nothing else
apps/pos-android/    the till in a Capacitor shell, the native printer plugin,
                     and the HTTP socket the local server listens on
packages/escpos/     ESC/POS encoder + ticket templates, golden-byte tested
tools/printer-sim/   a thermal printer that isn't there (TCP :9100)
tools/print-agent/   claims jobs, prints, acks; reference for the Android agent
tools/local-server-harness/
                     the tablet's web server without the tablet, so a browser
                     can drive the outage path in CI
design/              tokens.css, and the Phase 0 prototype kept frozen as the
                     record of the approved look — it is NOT the app
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
  says `BIL`, names no payment method, and does not kick the drawer. Taking a payment calls the same
  renderer with a method and gets a paid receipt with the pulse.
- Closing a bill without taking money is the primitive payments front — explicit and audit-logged,
  never silent.

## Trading through an outage

Most Malaysian POS SaaS dies when the shop's internet dies. This one does not, and the mechanism is
small enough to describe in a paragraph.

**Every action a cashier takes is written to a durable outbox before it is sent.** A counter order,
a *sudah dihidang*, a closed bill, an 86 — each becomes an op with a ULID minted on the device, kept
in IndexedDB, and drained to `POST /api/outlets/:id/sync` when the line allows. With the line up
that is a few milliseconds nobody notices. With it down the restaurant carries on trading and the
evening reconciles itself on reconnect.

```
packages/offline/     the op log, the outbox and the drain loop
apps/pos/src/offline.ts   wired to the till
POST /api/outlets/:id/sync   applied in order, inside the outlet's own object
```

Five properties, each one a specific failure it prevents:

- **The op is on disk before the request leaves.** Pulling the power between the tap and the send
  loses nothing.
- **Idempotent by ULID.** `op_log.client_ulid` is UNIQUE, so a tablet that sends a batch, loses the
  reply and retries bills nobody twice. There is a browser drill that reloads mid-recovery to prove it.
- **Ordered.** Ops are keyed by a zero-padded sequence, so "serve order X" can never overtake
  "place order X" and 404. (`op/9` sorting after `op/10` is exactly how that would have happened.)
- **One bad op cannot block the queue.** Something that can never succeed — an archived table, a
  deleted dish — is answered `rejected`, dropped, and shown to the cashier. Retrying it forever
  would wedge every order behind it, which is how an outage becomes a lost evening.
- **A replayed order keeps the time it was taken**, so last night's takings land on last night.
  It also bypasses the 86 check, because the food was ordered hours ago and probably eaten —
  refusing to record it means serving a plate nobody is billed for. **The server decides what counts
  as a replay, from the op's age**, never a flag the client sets: a rule a client can switch off is
  not a rule.

Menu edits and stock counts stay server-authoritative — that is the entire conflict model, and it
is small enough to actually get right.

## The tablet

`apps/pos-android/` wraps the same till in Capacitor, for the two things a browser can never do:
open a raw socket to a printer on the shop LAN, and speak Bluetooth when the router dies.

**The `Android APK` workflow builds a debug APK** and attaches it to the run — Actions → Android
APK → newest run → Artifacts. Nobody has to install a toolchain, and it is what compiles the native
code, since the rest of the project is TypeScript.

- **LAN first, Bluetooth if the LAN does not answer within 1.5 seconds.** That deadline is the
  mechanism, not a nicety: a printer that has quietly gone away does not refuse the connection, it
  accepts nothing, and the socket sits there until the OS gives up a minute later — with the
  kitchen idle through exactly the emergency the fallback exists for. The choice logic lives in
  [`packages/printer`](packages/printer) under test; the sockets live in about two hundred lines of
  Java that moves bytes and reports what happened.
- **`BLUETOOTH_SCAN` is declared `neverForLocation`** — the app pairs with a printer on the counter
  and has no interest in where anyone is. Without that flag Android demands the location permission
  too, which a restaurant owner would rightly refuse.

### Install day — the **Peranti** tab

Everything the tablet needs is per-device, so none of it is in the build: the same APK runs at Jalan
Imbi, at Hotel Leo and at every restaurant onboarded later. An APK per customer is a release process
nobody keeps up with.

1. **Where is the server.** Asked once, on first start, and the address is proved by a call to
   `/health` before it is stored — a typo saved now is a tablet that fails to log in for a reason
   nobody can see.
2. **Register this tablet** as a print agent. The credential is scoped to one branch, so a stolen
   tablet reaches one restaurant's print queue and cannot read a sale or open a bill. It is shown
   once, because only its hash is kept; the screen names the branch it belongs to, so a tablet
   pointed at the wrong outlet says so rather than surprising someone at the printer.
3. **Each station's printer** — a LAN `host:port`, and a paired Bluetooth device chosen from the
   list. Fill in both: that pair is what keeps the kitchen printing when the router dies.
4. **Uji cetak.** Paper comes out, naming the station it came from. Swapped printers are the
   commonest install mistake and the only way to catch them is to look at the slip.

While the till is open the tablet drains its own print queue every three seconds and heartbeats
about once a minute, so the control plane can tell an unplugged printer from a tablet that has been
off since Tuesday.

5. **Pesanan tempatan.** Save the tablet's own address so the printed cards can carry the outage QR,
   and set the guest WiFi name so the card can carry a join code too. See
   [When the internet dies](#when-the-internet-dies).

**Still to prove on hardware.** The three outage drills in [`docs/PLAN.md`](docs/PLAN.md) — internet,
router, power — need real printers and are the gate before any branch goes live. Until then the till
also runs in a browser, where it already trades offline; a browser cannot open a socket to a printer
or listen on one, and the Peranti screen says so rather than offering buttons that fail silently.

## Taking the order

**Customers here order to a person.** That is how Restoran Suriani runs and it
is not a limitation to design around — a waiter takes the order and the cashier
records it on the till, which is where the day's numbers come from. The QR on
the table is still there and still works; it is an option rather than the only
path, which is what the plan always said it should be.

So the order pad is the **widest column on the till**, not a side panel:

- **Aimed first, filled second.** Tap a table, then add dishes. That is the
  order a cashier hears it in — *"Meja 5, dua nasi lemak, satu teh ais"* — and
  being asked which table only after building a cart puts the question in the
  wrong place. Tapping a table's bill has a **Tambah pesanan** button that aims
  the pad at it, because adding to an occupied table is the commonest thing a
  counter does.
- **The pad reads the order back** — dish, choices, note and price on every
  line, with a × to drop one. A cashier keying in something they were told
  needs to see the words, not a count on a button: mishearing *kurang pedas* is
  how the wrong plate leaves the pass.
- **An unaimed pad cannot be sent.** The button says *Pilih meja dahulu* rather
  than sending food somewhere nobody chose.
- **Bungkus** is a destination beside the tables. A takeaway customer has no
  table, so an outlet gets one row that is not a table anybody sits at — that
  way the whole bill, docket, receipt and payment machinery is reused unchanged
  rather than needing a second way to sell food. It is kept off the floor plan
  and off the printed QR cards, for the obvious reasons.
- **Bungkus is paid before it is cooked.** Sending one opens its bill with the
  amount on the button, so the cashier sees what they are about to charge for
  before they charge for it. This is the one place the till waits for the
  server — the bill hangs off a session the server mints — and with the line
  down it says so rather than leaving an empty sheet.

The counter order lands in the **same op log** as a phone order and prints the
same docket. There is one way to sell food, taken two ways.

## Taking money

A bill is settled by **payments against it**, not by a flag on it. That one choice is why splitting
a bill needed no separate feature: RM 20 in cash from one person and RM 12 by DuitNow from another
is two rows, and the bill closes the moment they add up. It is also why there is no `paid` session
status — five separate queries look for a table's live bill by matching `open` or `bill_requested`,
and a sixth state would mean finding all five or watching a paid-but-unclosed table disappear off
the floor map. Paid is arithmetic: orders − discounts − payments.

**The till never states the total.** Leave the amount off and the server settles whatever is
outstanding, worked out from its own orders. Type one and it is an instruction — *this customer is
putting in RM 20* — which is a different thing from choosing a price. What the till showed rides
along and a disagreement is audited, the same rule that has governed order pricing since Phase 2b.

### The 5 sen rounding

Malaysia withdrew the 1 sen coin, so a bill paid **over the counter in cash** rounds to the nearest
5 sen: 1, 2, 6 and 7 down, 3, 4, 8 and 9 up, on the total and never per item. An **electronic
payment is taken to the sen** — rounding a QR payment up is the thing customers complain about
publicly, and it is not what the rule says. Rounding also only applies when cash is *clearing* the
bill; a cashier typing RM 20 towards a split has already chosen a round number.

The adjustment is printed and stored rather than absorbed, because two sen that is invisible on
paper is two sen nobody can account for later. Every price on the current menu is a multiple of 5
sen so this is nearly always a no-op — it stops being one the day a service charge appears.

### Discounts and voids

A discount is **not** a negative payment. Folding it into the cash column would balance the drawer
while the books quietly claimed less was sold than left the kitchen, so it has its own table, a
compulsory reason, and a name against it. That is the only thing separating a discount from money
going missing.

A payment is **voided, never deleted** — a cashier who keys RM 100 instead of RM 10 needs the table
back, and a deleted row would hide that it happened. The bill reopens, the day's expected cash drops
back, and both events stay in the audit log. Owner and manager only: every other money route is open
to any staff, because a cashier who cannot take money cannot run a counter, but this is the one that
makes money disappear rather than move.

### Closing the day

**Kutipan, not just Jualan.** Sales are what left the kitchen; collections are what reached the
drawer. They differ by discounts and by bills still open, and Rekod shows both with a line saying
why — a screen that shows only one of them will eventually be used to answer the question it cannot
answer.

The **Laci** tab takes the opening float in the morning and the counted cash at night, and prints a
slip naming the variance whether or not the variance is comfortable. Expected cash is the float plus
the cash payments; a DuitNow payment never touched the drawer and is not expected to be in it. The
float cannot be changed after the count, or the variance becomes whatever anybody wants it to be.

### What is deliberately not here

- **A payment gateway, or a dynamic DuitNow QR with the amount baked in.** A static merchant QR
  carries no amount: the customer types it, shows the confirmation, and the cashier confirms. A
  dynamic QR needs an acquirer, and it belongs behind the interface this phase established.
- **Splitting by item.** Payments are a list against the bill, so ticking whose dishes are whose is
  a screen on top of what exists rather than a rework of it.
- **LHDN e-Invoice.** The exemption threshold rose to RM1m annual turnover on 1 January 2026, so
  both branches are exempt and speculative tax columns would be dead weight. `docs/PLAN.md` used to
  claim those fields were stored from the start; they never were, and that line has been corrected
  rather than left standing. The receipt number *is* here, because a sequence that has to be gapless
  cannot be backfilled onto sales that already happened.

## When the internet dies

Three different things break in a restaurant and they need three different answers. Lumping them
together as "offline" is how a POS ends up half-solving all three.

| What actually breaks | What stops working | The answer |
|---|---|---|
| **Internet down**, WiFi fine | Cloud sync; phones cannot reach the menu | The tablet serves the menu itself |
| **Router down**, internet fine | LAN printing | Bluetooth, automatically |
| **Power cut** | Everything | A UPS on the router, tablet and printers |

The till itself is unaffected by all three — it holds its own outbox and keeps trading.

### The tablet is also a web server

`packages/localserver` is the route table the tablet listens on, and it is **a separate router from
the POS API, not the same one with a flag**. Four things exist in it: the app shell, the app's own
files, this table's menu, and place-an-order. There is no staff route to leave switched on by
mistake, no sales figure to return, no login — not because they are guarded but because they are not
written. One file is the whole audit, which is the only kind of audit that stays true.

**It is always on, never outage-triggered.** No mode to detect and no switchover to fail at the
worst possible moment: there are two doors into the menu and both are open all day. That also means
the local one is exercised on an ordinary Tuesday rather than first thing in a crisis.

An order taken this way is not a special case either. It goes into the **same outbox as a counter
order**, with the same client ULID, and syncs down the same path — so there is one ordering
implementation to keep correct, not two.

**What it costs, said plainly.** A tablet cannot hold a TLS certificate that phones will trust for a
private address, so the local path is plain `http://` and phones show "Not secure". It therefore
needs its own QR, which is why the table cards grow a *"Tiada internet?"* panel — a WiFi join code
and a "Pesan di sini" code — once you save the tablet's address on the **Peranti** tab. Give that
address a **DHCP reservation** on the router: if it moves, every card already printed points
somewhere wrong.

Bill requests and waiter calls are deliberately not on it. A bell that rings on the till is not
something to leave reachable from a network customers share, so during an outage the customer is
told to ask at the counter — which is what they would do anyway.

### The tablet prints its own dockets

Not only during an outage: for any order the tablet takes, counter or phone. It is the print agent
for its own restaurant, so sending the job to Cloudflare and back only hands it to this same device
— and doing it directly means the outage path and the everyday path are one path.

The op then tells the server the paper already came out, and the server skips the queue. The flag is
set **only after the print actually succeeded**: a dead printer leaves it off and the ordinary queue
takes over with its retries and its red banner, because the fallback of a broken printer must never
be silence.

### Proving it without a restaurant

`tools/local-server-harness` runs the real router on a real socket, backed by the real seeded menu,
rendering real ESC/POS to `tools/printer-sim`. `apps/pos/e2e/local-server.mjs` drives a real browser
against it: no staff route answers, an unknown token and an unknown outlet answer identically, a
drink cannot be ordered without answering panas-or-ais, an iced takeaway teh tarik is RM 3.00, and
the docket comes out with the option and the note on it.

What that does **not** prove is the Java that owns the socket and the Capacitor bridge that carries
a request into the WebView. Both are deliberately thin for that reason, and the three outage drills
in [`docs/PLAN.md`](docs/PLAN.md) are what actually close the gap.

**One honest limitation:** the router runs in the WebView, so the till app has to be running. The
foreground service keeps the process and the socket alive across a whole shift — `specialUse`
rather than `dataSync`, because Android 15 caps `dataSync` at six hours in twenty-four and that cap
would shut ordering off at the busiest hour of the evening with no error anywhere. But a tablet
whose app has been swiped away answers 503, and the notification is there so staff can see the door
is open.

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
