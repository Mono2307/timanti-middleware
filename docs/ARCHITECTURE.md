# Architecture

## What this service is for

Shopify treats a product as a thing with a price. Jewellery is not that: the price is computed
from a daily gold rate times a weight, plus a diamond component, plus making charges, and then
adjusted by discounts, part-exchanged old gold, vouchers and credit notes — with GST applied on a
tax-inclusive convention. On top of that, customers pay in up to four installments, sometimes
across weeks, sometimes partly on a card terminal in-store and partly by link.

None of that fits Shopify's data model, so this middleware does the arithmetic and writes the
answers back onto the draft order as `custom.*` metafields, where Order Printer templates and
staff can see them. **The metafields are the interface.** Almost everything here exists to keep
them correct.

## The systems it talks to

| System | Direction | What for |
|---|---|---|
| **Shopify Admin API** | both | Draft orders, orders, metafields, tags, discount codes |
| **Supabase** | both | Live Shopify token, serial counters + ledger, credit-instrument ledger, terminal transactions |
| **Pine Labs** | both | In-store card terminals: push amount, poll status, receive postback |
| **Gokwik** | both | Payment links for remote collection |
| **Resend** | out | Customer and staff email |
| **Google Apps Script** | both | Sheet-driven workflows: PO Ops, exchange calculator, recon uploads |
| **Fast2SMS** | out | SMS notifications |

## How work arrives

Three entry paths, and it is worth knowing which is which:

1. **Shopify webhooks** — `POST /api/shopify-draft-updated` is the busiest path in the system and
   the one most business logic hangs off.
2. **Tags as commands.** Staff add a tag to a draft in Shopify Admin (`recalculate-price`,
   `apply-voucher:VCH-2026-0042`, `cash-payment`), the webhook fires, the matching handler runs
   and removes its own tag. This is the primary staff interface — there is no admin UI for most
   of it. Tags are capped at 40 characters, which constrains code formats.
3. **Direct HTTP** — Apps Scripts, the admin extension, and manual browser-clickable endpoints
   for backfills and diagnostics.

## The draft-update pipeline — read this before changing it

`server.js` runs fifteen handlers in sequence when a draft is updated. Each is wrapped in
`step()` so one failure cannot silently skip the rest. **The order is load-bearing:**

```
send-link          →  cash-payment      →  recalc-price   →  recalc-price+force
weighted-reprice   →  advance-capture   →  advance-redeem
apply-voucher      →  apply-exc         →  apply-discount
repairs            →  document-serial
sync-net           →  payment-sync                              ← these two MUST be last
```

The rule the order encodes: **net-to-collect must be recomputed after every adjustment**
(voucher, advance, exchange note, old gold), and `amount_pending` is derived from that fresh net
— so `payment-sync` runs last. This was a real bug once: the payment sync used to run before the
adjustments and left `amount_pending` stale, meaning a customer who had redeemed a voucher was
still shown as owing the pre-voucher balance.

Reordering these silently produces wrong customer balances. There is no test that catches it.

## Module map

```
   Shopify webhooks ──┐
   Apps Scripts     ──┼──▶┌────────────────────────────────────────┐
   Admin extension  ──┘   │              server.js                 │
                          │  bootstrap + ctx + module registration │
                          │                                        │
                          │  STILL HERE (one interwoven unit):     │
                          │    payments/Pine · adjustments ·       │
                          │    pricing · draft lifecycle           │
                          └───────────────┬────────────────────────┘
                                          │ register(app, ctx)
        ┌───────────┬────────────┬────────┴────┬──────────────┐
        ▼           ▼            ▼             ▼              ▼
    reporting  serialization  procurement    admin      after-sales
        │           │            │             │              │
        └───────────┴────────────┴──────┬──────┴──────────────┘
                                        ▼
                          ┌───────────────────────────┐
                          │         src/core          │
                          │  config · supabase        │
                          │  shopify · metafields     │
                          │  logger                   │
                          └─────────────┬─────────────┘
                                        ▼
                     Shopify · Supabase · Pine · Gokwik · Resend
```

Modules registered via `register(app, ctx)` never import `server.js`. Where an extracted module
still needs something that has not moved yet, it is **injected through `ctx`** rather than
required — so the dependency arrow keeps pointing inward. Three such injections exist today
(`handleRecalculatePriceTag`, `applyPaymentTagsToOrder`, `applyPaymentTagsToDraftOrder`) and each
is marked TEMPORARY in the module that receives it.

Dependencies point **inward and downward only**: modules may use `core` and `integrations`;
`core` never imports a module. Where a module needs another module's data it goes through an
exported function, not by reaching into its files.

## Data ownership

Knowing who writes what prevents most double-write bugs:

| Data | Owner | Notes |
|---|---|---|
| `custom.*` on drafts/orders | whichever module computes it | The public interface — templates read these |
| Serial numbers + ledger | `modules/serialization` | FY-scoped, per store, per document type |
| Credit instruments | `modules/adjustments` | Vouchers and exchange notes: issued → applied → redeemed → void |
| Installment legs | `modules/payments` | Up to 4; the only module with unit tests |
| Terminal transactions | `server.js` (Pine) | Polled every 30s while active |
| Live Shopify token | `core/shopify` | Cached 23h, mirrored to Supabase |

## Extraction status

`server.js` went from 6,060 lines to ~4,440 across this work.

| Domain | Where it lives |
|---|---|
| config, supabase, shopify token, metafields, logging | `src/core/` |
| reporting (6 endpoints) | `src/modules/reporting/routes.js` |
| serialization (10 endpoints) | `src/modules/serialization/routes.js` |
| procurement / PO Ops (5 endpoints) | `src/modules/procurement/routes.js` |
| admin: backfills, price-update, metafield defs (7) | `src/modules/admin/routes.js` |
| repairs | `src/modules/after-sales/` (predates this work) |
| installment arithmetic | `src/modules/payments/installments.js` (predates this work) |
| **payments / Pine terminal** | still in `server.js` |
| **adjustments** (voucher, exchange note, advance) | still in `server.js` |
| **pricing / reprice** | still in `server.js` |
| **draft lifecycle + tag pipeline** | still in `server.js` |

The remaining four are one unit, not four. They share the draft-mutation primitives —
syncAmountToCollect, stripInstrumentFromDraft, gqlSetDraftLineItems, handleRecalculatePriceTag —
and the tag pipeline calls across all of them. Extracting one alone means injecting four or five
functions through ctx, which reads worse than leaving it whole. They should move in a single pass,
in a session where nothing else is committing to server.js.

## The Shopify admin extension — do not consolidate it

`apps/metafield-manager/` ships four extensions whose `MetafieldManager.jsx` files are currently
byte-identical. **This is deliberate and they must stay four separate files.** They are four
distinct admin action apps with their own extension identities, targets and registrations; the
fact that their source happens to match today is a coincidence of history, not a sign of
accidental duplication.

There is also a practical reason not to touch this lightly: **a Shopify store can only run one
version of an app at a time.** You cannot deploy a second copy alongside the live one and compare
them, the way you can with two branches of the middleware. Any change here goes straight to the
only environment that exists, in front of staff. So changes to this app are made deliberately,
one at a time, and never as part of a refactor.

This was tried during the 2026-08 restructure and reverted.

## The regression gate

There is no integration test suite. `tools/route-inventory.js` substitutes for one during
refactoring: it loads the app with `listen()` stubbed — every startup side-effect lives inside
that callback, so nothing touches the network — and prints all 79 routes sorted. A pure move must
leave that output byte-identical. Every refactor commit in this repo was gated on it.
