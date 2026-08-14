# Suriani POS

A multi-tenant QR-ordering point-of-sale system for Malaysian restaurants.

Customers scan a QR code at their table and order from their own phone — no app install.
Orders appear live on the cashier till and print in the kitchen. Customers pay after eating,
by DuitNow QR or cash. It keeps working when the restaurant's internet dies.

Two branches of Restoran Suriani are customer zero.

## Status

**Phase 1 complete.** Two outlets exist with provably isolated data.

| Phase | | |
|---|---|---|
| 0 | Design system + clickable prototype | ✅ |
| 1 | Cloudflare scaffold, control plane, one Durable Object per outlet, auth | ✅ |
| 2 | Customer QR ordering PWA | next |

Full plan and roadmap: [`docs/PLAN.md`](docs/PLAN.md).

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

```bash
pnpm test        # 24 tests, inside the real Workers runtime
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
  test/              isolation · onboarding · migrations · money
design/              tokens.css and the Phase 0 clickable prototype
docs/PLAN.md         product plan, architecture, phasing
```

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

- **All money is integer sen.** Never a float — see [`src/lib/money.ts`](apps/api/src/lib/money.ts).
- **Order prices are snapshotted** onto the order line. Changing a menu price must never alter a
  bill already taken.
- **A table's QR carries a 160-bit secret**, not its table number.
- **Orders are append-only facts** keyed by a client-generated ULID, so a tablet can replay its op
  log after an outage without billing anyone twice.
