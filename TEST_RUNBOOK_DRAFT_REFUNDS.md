# Draft refunds — go-live runbook

Everything that must happen for draft-order refunds to work end to end, in order, plus how to prove
it works. Code is written and `npm run verify` is green; nothing below is optional.

---

## Part 1 — Go-live steps, in strict order

The order matters. Steps 1→2 are the one place a mistake causes silent data loss.

### 1. Supabase migration — BEFORE the deploy

Supabase Dashboard → SQL Editor → run `src/modules/payments/refunds_migration.sql`.

Adds `'refund'` to the instrument-type CHECK, `'refunded'` to the status CHECK, four columns on
`credit_instruments` (`refunded_at`, `refund_mode`, `gateway_ref`, `email_sent_at`), and
`store_deposits.amount_refunded`. Idempotent — safe to re-run.

**Why before:** ledger writes are wrapped in try/catch and only logged. Deploy first and every refund
422s on the CHECK constraint, the middleware carries on, and the refunds are silently lost.

Confirm:
```sql
select constraint_name, check_clause from information_schema.check_constraints
where constraint_name in ('credit_instruments_instrument_type_check','credit_instruments_status_check');
select column_name from information_schema.columns
where table_name='credit_instruments' and column_name in ('refunded_at','refund_mode','gateway_ref','email_sent_at');
select column_name from information_schema.columns
where table_name='store_deposits' and column_name='amount_refunded';
```
Expect `refund` and `refunded` in the clauses, four columns, one column.

> No views, no RPCs and no RLS policies touch these tables — checked repo-wide — so nothing else on
> the Supabase side needs updating. Note `credit_instruments_setup.sql` still declares the type check
> as `('exchange_note','voucher')` and is **stale versus production** (`cad_advance` writes fine live).
> The migration restates the whole list rather than adding to it, so it converges either way.

### 2. Deploy the server

Merge to `main` → GitHub Actions → Fly. Confirm the build actually shipped:
```
GET /api/version          → GIT_SHA matches your merge commit
GET /api/health           → no missing env
```
No new env vars. No new webhooks — `draft_orders/update` → `/api/shopify-draft-updated` and
`draft_orders/delete` → `/api/po-webhook` are already registered and already firing.

### 3. Create the metafield definitions

```
GET  /api/metafield-definitions/ensure?group=refunds            # dry run, read the diff
POST /api/metafield-definitions/ensure?group=refunds&apply=true
```
Expect 18 planned entries: `refund_1..2_{value,mode,date,ref}` + `amount_refunded`, **× both
`DRAFTORDER` and `ORDER`**.

**Both owner types is not optional.** A key defined on one but not the other makes the admin
extension abort the *entire* save with "no definition found" — a verified failure mode, and it would
break saving any field, not just refunds.

### 4. Check the `payment_status` choice list by hand

Shopify Admin → Settings → Custom data → Draft orders → `custom.payment_status`. **Confirm `None` is
in the choices, on both Draft orders and Orders.** Add it if missing.

A full refund writes `payment_status: 'None'`. Choices are enforced on write, and `updateMetafields`
loops the patch inside one try/catch — a 422 abandons every field after it, silently. The code now
writes `payment_status` **last** so `amount_pending` and `is_finalized` can't be lost behind it, but
without `None` the status label itself just won't stick.

### 5. Deploy the Shopify extension

```
cd apps/metafield-manager
npx @shopify/cli app deploy -c timanti-metafield-manager-new
```
(bare `shopify` is not on PATH; no `--force`, no `CI=1`.)

All four `MetafieldManager.jsx` copies are byte-identical — verify with `md5sum` before deploying if
you have edited them since.

### 6. Paste the Exchange Calculator Apps Script

Source: `services/exchange-cn/EXCHANGE-CALCULATOR-FULL.gs.txt` (3,309 lines, `doPost` intact).
Extensions → Apps Script → replace → Save → **redeploy the web app** → reload the sheet.

Then: menu → Setup → **⏰ Install hourly refund sync** (re-run it; it now installs two triggers, one
per pull, so a failure in one can't stop the other).

**Check first whether `apps-script-issue-voucher.gs.txt` is already live** — it was flagged as
outstanding. Paste smoke test: POST any body to the web-app URL; `{"ok":false,"error":"unknown action"}`
means the router is live.

### 7. Paste the Reports Apps Script

Source: `services/reporting/apps-script.js`. Extensions → Apps Script → replace → Save → reload.

**This one is easy to miss and fails silently.** It hard-codes the column list for each tab and drops
any column not listed — without this paste, `amount_refunded` and `net_collected` are computed by the
server, sent over the wire, and thrown away before they reach the Sales tab.

### 8. Invoice templates — still awaiting your approval

Not applied. The `r1:`/`r2:` tags are already being written, so the templates are the only thing left.
Five candidates render the payment table: `tax-invoice`, `TEST-tax-invoice-installments`,
`order-confirmation-receipt`, `TEST-order-confirmation-installments`, `mto-invoice-template`. Say
which, and the hunk goes in after the `inst_list` loop in each.

### Touchpoints that need NO change — checked, not assumed

| Surface | Why not |
|---|---|
| **PO Queue script** (`services/po-ops/po-queue.gs`, tabs `mto`/`InStock`/`unclassified`) | Zero money columns across all three tabs — it is a per-line-item manufacturing queue, not a financial mirror. Nothing to be wrong. |
| **PO Tracker script** (`PO Ops/scripts/sheets-app-script.js`, `PO_Log`) | No payment columns. |
| **Credit Ledger tab** in the Reports sheet | No fixed column list — derives from the JSON, so `refunded_at`/`refund_mode`/`gateway_ref` appear on their own. Type filter already accepts `refund`. |
| **Webhooks / env vars** | Nothing new. |
| **`services/*` JS mirrors** (`services/reporting/reports.js` etc.) | Dead tree — `server.js` requires only `./src/...`. Deliberately left alone. The Apps Script files under `services/` are NOT dead and were both updated. |

---

## Part 2 — Test plan

Run on a real draft in the live store; every step is reversible. `{D}` = draft id, `{N}` = draft name.

### T0 — Preconditions
- `GET /api/version` shows the new SHA.
- Open a draft in Shopify admin → the panel shows a **Refunds** section with 2 legs and Total Refunded.
- The **Send refund email** button is NOT visible yet (nothing refunded).

### T1 — Record a payment (baseline, unchanged behaviour)
Add tag `cash-50000` to a fresh draft.

Expect: tag consumed; tags show `deposit:partial, paid:Rs50000, pending:Rs…`; deposit email sent.
This proves the existing pipeline is untouched.

### T2 — Partial refund (the order-contracted case)
In the panel: `refund_1_value = 10000`, mode `upi`, date = today, ref `UTR-TEST-1`. Save.

Expect:
- `sync-refund` appears then disappears (middleware consumed it).
- `GET /api/draft-order-metafields?draftOrderId={D}` → `amount_refunded = 10000.00`, **`amount_paid` still `50000.00`** (this is the whole design — gross is never written down).
- `amount_pending` has gone **up** by exactly 10,000.
- Tags now include `refunded:Rs10000` and `r1:10000@upi@2026-…`.
- Supabase: one `credit_instruments` row, `serial_code = '{N}-R1'`, `instrument_type='refund'`, `status='refunded'`, `gateway_ref='UTR-TEST-1'`, `email_sent_at` **null**.
- **No email sent.** Recording never notifies.

### T3 — Idempotency
Save the panel again without changing anything. Then `POST /api/recompute-payment {"draftOrderId":"{D}"}`.

Expect: still exactly **one** ledger row. Nothing duplicated. (The unique `(instrument_type, serial_code)` constraint is the guard.)

### T4 — The email button
Panel now shows **Send refund email**. Press it.

Expect: one email to the customer, cc store. It should carry the black callout with the orange amount,
the Refund Timeline box, and a payment summary showing paid / refunded / balance due. `email_sent_at`
now stamped.

Press it again → **nothing sent**, ledger unchanged. This is the guard that matters most.

### T5 — Contraction → balance → conversion (the arithmetic that forced the invoice change)
Add a product back, take the balance payment, convert the draft.

Expect: order tags carry the refund through; `amount_pending` is 0; ledger row **rekeyed** from
`{N}-R1` to `#<order>-R1` with `source_order_name` = the order name. The invoice ties out
(50,000 + 60,000 − 10,000 = 100,000) once the template hunk is in.

### T6 — Full refund (the sale-fell-through case)
On a second draft with a 50,000 deposit, refund the whole 50,000.

Expect:
- `payment_status = None`, `is_finalized = false`.
- Tag is **`deposit:refunded`**, NOT `deposit:partial`. This is the specific bug the new state exists to prevent — gross `amount_paid` is still 50,000, so the old `amountPaid > 0` test would have kept it "partial" forever.
- `store_deposits.payment_status = 'unpaid'`, `amount_refunded = 50000`.

### T7 — Delete the draft
Delete the fully-refunded draft.

Expect: the `credit_instruments` row **survives**, still `status='refunded'`, now with `voided_at` set
(the document is gone; the refund is not). Customer name, value, store code all still readable from
the row alone.

### T8 — Reports
- `GET /api/sales-report?from=…&to=…` → `amount_refunded` and `net_collected` populated; the T2 draft shows `payment_type: partial: part-refunded`; **the T6/T7 draft is gone from recorded partials** but still appears from the ledger.
- `GET /api/adjustment-report?from=…&to=…` → `refund_value` column populated; T7's refund present with `document_state: draft deleted`; the TOTAL row's sales columns are **unchanged** by refunds.
- `GET /api/recon-ledger?view=detail&type=refund` → both refunds with mode + gateway ref.
- `GET /api/recon-ledger?view=summary` → refunds in their own **`refunded`** bucket. **Check `outstanding_value` has NOT moved** — refunds must never inflate the outstanding-credit liability. `balances: true`.

### T9 — The sheets
- Reports sheet → 📊 Reports → Sales. Confirm `amount_refunded` and `net_collected` columns actually appear (this is what step 7 buys).
- Exchange Calculator → **💸 Sync draft refunds now**. One row per refund in **After-Sales Log**: Event `refunded`, Source `Draft refund`, Doc Type `Refund`, Serial `{N}-R1`, Ref `draft-refund:{N}-R1`.
- Run it **again** → no duplicates.
- Run **🔄 Refresh log statuses from ledger** → the refund rows are unharmed. (Unlike gateway refunds these carry a Serial, so the status join now reaches them; `refunded` is terminal so it should be a no-op, but confirm on the first run rather than assuming.)

### T10 — Regression sweep
- A draft with **no** refunds: tags, balance and deposit email all behave exactly as before.
- A draft with a CAD advance: `installment_1_type = cad_advance` still labels correctly and still counts toward `amount_paid`.
- Apply a voucher to a draft, then delete it → voucher still reverts to `open` (`revertApplied` matches only `status='applied'`, so refund rows can't be swept up by it).

---

## Two bugs found and fixed while assembling this

1. **`/api/recon-ledger?view=summary` counted refunds as outstanding credit.** `refunded` fell through
   to the `else` branch, so every refund would have inflated the open-credit liability figure. It now
   has its own bucket and the `balances` assertion includes it.
2. **The Reports Apps Script would have silently dropped the two new Sales columns.** It hard-codes
   its column list and discards anything not in it, so `amount_refunded` and `net_collected` would
   have been computed server-side and thrown away with no error anywhere.

## Known, pre-existing, not touched

- Deleting a refunded draft removes only `pending` rows from the PO Queue — `raised-po`/`po-created` rows survive. Correct if the PO was genuinely raised; worth a decision if not.
- `PO Ops` PO_Log drops a `po_comments` field the middleware sends (same silent-column class of bug, unrelated to refunds).
- The panel's `installment_1_type` comment still says a CAD advance is excluded from `amount_paid`; the code says the opposite since the Aug spec. Documentation only.
