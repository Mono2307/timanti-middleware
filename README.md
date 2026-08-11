# timanti-middleware

The service that sits between Shopify and everything else Timanti runs on — card terminals,
payment links, Supabase ledgers, Google Sheets, and email.

Shopify can hold a jewellery order, but it cannot price one. Gold is priced by weight against a
rate that moves daily; a piece has separate gold, diamond and making components; customers pay
across up to four installments, part-exchange old gold, and redeem vouchers and credit notes.
This service does that arithmetic, writes the results back onto the draft or order as `custom.*`
metafields, and keeps the ledgers that reconcile against the bank.

**Live:** `https://timanti-middleware.fly.dev` · **Deploys from:** `main`

---

## Quick start

```bash
npm install
cp .env.example .env      # then fill in — see docs/ENVIRONMENT.md
npm start                 # http://localhost:8080
npm run verify            # syntax + tests + route parity + Dockerfile paths
```

`npm run verify` is the gate. It must pass before any commit.

---

## Layout

```
server.js               HTTP bootstrap + the handlers not yet extracted (see below)
src/
  core/                 shared primitives — no business logic
    config.js           every environment variable, parsed once
    supabase.js         the single Supabase client
    shopify.js          access token (23h cache) + REST/GraphQL helpers
    metafields.js       custom.* read/write, and the type map Shopify insists on
    logger.js           module-prefixed logging
  integrations/         third-party edges, no domain rules
    email/  gokwik/  sms/  typeform/
  modules/              business domains
    adjustments/        vouchers, exchange notes, CAD advances, credit ledger
    after-sales/        repairs: intake, estimate, approval, refunds
    payments/           installment legs and the money arithmetic (has tests)
    procurement/        PO Ops — purchase orders via Google Sheets
    reporting/          recon, sales, ledger and adjustment reports
    serialization/      document numbering (orders, repairs, memos, vouchers)
  jobs/price-update/    Python: daily gold-rate repricing, spawned by the server
  data/recon/           reconciliation inputs + the durable _recon_store ledger
apps/
  metafield-manager/    Shopify admin extension (SEPARATE deploy — not on Fly)
tools/
  route-inventory.js    prints all 79 routes; the refactor regression gate
  verify.js             the four-step gate behind npm run verify
```

**Module contract.** Each domain under `src/modules/` exposes `register(app, ctx)` and nothing
else that other modules should call directly. `ctx` carries the shared primitives, so a module
never reaches for `process.env` itself. Each module's header comment states its entry point, its
endpoints, and its exit points — what it calls outward.

**`src/data/recon/` is not test data** despite its former name ("Recon Test"). `GET /api/recon`
reads those CSVs from disk inside the container, and `_recon_store/` is the durable
reconciliation ledger. Do not delete it.

---

## Deploying

Two independent targets. Confusing them is the most common mistake here.

| What | How | Notes |
|---|---|---|
| The middleware | GitHub → Actions → **Deploy to Fly.io** | Builds whatever `main` is |
| A specific commit | GitHub → Actions → **Deploy Specific Commit** | Takes a SHA; use to roll back fast |
| The Shopify extension | `cd apps/metafield-manager && npx @shopify/cli app deploy -c timanti-metafield-manager-new` | Nothing to do with Fly |

`flyctl` and `gh` are not installed on the primary dev machine, so deploys are triggered from the
GitHub Actions UI. Full detail in `docs/DEPLOY.md`.

---

## Where things are still messy

Honest notes, so nobody rediscovers these the hard way:

- **`server.js` is still ~4,400 lines**, down from 6,060. Core, reporting, serialization,
  procurement and admin are out. Payments, adjustments, pricing and the draft-order lifecycle are
  not — they share the draft-mutation primitives and the tag pipeline calls across all four, so
  they should move together in one pass rather than one at a time.
- **The draft-update tag pipeline order is load-bearing.** Fifteen handlers run in sequence and
  the order encodes real rules: net-to-collect must be recomputed *after* every adjustment, and
  the payment sync must run *last* because `amount_pending` is derived from the fresh net.
  Reordering it silently corrupts customer balances. See the comment above the `step()` calls.
- **Two GST implementations disagree by 1 paisa.** `modules/reporting/recon.js` and
  `modules/reporting/reports.js` each define `gstSplit`; they round differently
  (`toFixed(2)` vs `Math.round(x*100)/100`). Measured: 4,476 of 1.5M amount/state combinations
  differ. That is enough to stop a reconciliation tying out. Neither has been declared canonical.
- **`emailService` and `emailTemplates` look like a half-finished migration** — several builders
  exist in both a v1 and a `…V2Html` form. Which reaches customers has not been established.
- **`server.js` still hand-rolls ~80 Shopify REST calls** with inline auth headers.
  `core/shopify.js` now has `getJson`/`postJson`/`putJson`/`graphql` to collapse them.

## Documentation

`docs/ARCHITECTURE.md` · `docs/ENVIRONMENT.md` · `docs/DEPLOY.md` · `docs/OPERATIONS.md`

Templates, Apps Scripts, SQL migrations and PRDs are **not** in this repo — they are pasted into
panels by hand and live in `../timanti-ops-assets/`.
