# Suriani POS

A multi-tenant QR-ordering point-of-sale system for Malaysian restaurants.

Customers scan a QR code at their table and order from their own phone — no app install.
Orders appear live on the cashier till and print in the kitchen. Customers pay after eating,
by DuitNow QR or cash.

Two branches of Restoran Suriani are customer zero.

## Status

**Phase 0 — design.** No product code yet. The design system and a clickable prototype of all
three surfaces are done and awaiting sign-off.

| | |
|---|---|
| Plan | [`docs/PLAN.md`](docs/PLAN.md) |
| Design tokens | [`design/tokens.css`](design/tokens.css) |
| Clickable prototype | [`design/prototype.html`](design/prototype.html) |

Open `design/prototype.html` in any browser. Add something to the cart on the **Pelanggan**
screen, then switch to **Kaunter** — the order appears on the floor map and a kitchen ticket
prints. The `BM / EN` toggle switches every string on every surface.

## What it will be built on

Everything runs on free tiers that permit commercial use.

| Layer | Choice |
|---|---|
| API + rendering | Cloudflare Workers |
| Control plane | Cloudflare D1 (SQLite) — orgs, outlets, devices, billing |
| Per-outlet data + realtime | One Durable Object per outlet, each with its own SQLite |
| Menu photos | Cloudflare R2 |
| Cashier app | React POS in a Capacitor Android shell — local SQLite, LAN printing |
| Customer menu | Plain web. No install, ever. |
| Kitchen | 80mm ESC/POS thermal printer over TCP |

A Durable Object per outlet means tenant isolation is structural rather than a `WHERE` clause,
and the cashier keeps trading when the restaurant's internet drops.

## Design direction

Kopitiam enamelware — a palette drawn from Malaysian enamel tableware and old kedai signage,
rather than a generic food-app look. Monospace carries every price, table code, order ID and
printed ticket, because thermal receipts are monospace.

Bahasa Malaysia and English from the first screen, with every string behind a translation layer
so a third language is data entry rather than rework.
