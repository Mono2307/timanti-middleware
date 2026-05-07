# Timanti Middleware — E2E Test Plan
> Cashier POV · All flows · All edge cases  
> Last updated: 2026-05-07

---

## How to use this document

Each section is a **flow**. Within each flow:
- **Setup** — preconditions before the test starts
- **Steps** — what the cashier does (or what the system triggers automatically)
- **System expectations** — every table row, tag, metafield, SMS, email the system must produce
- **Edge cases** — variations that must be tested separately

A ✅ column is provided so you can mark off each assertion as you verify it.

---

## Flow Index

| # | Flow | Trigger | Entry Point |
|---|------|---------|-------------|
| F1 | Draft created → price baked in | Shopify webhook | `/api/shopify-draft-created` |
| F2 | Discount applied → reprice | Shopify webhook | `/api/shopify-draft-updated` |
| F3 | Cash tag — advance payment | Cashier adds tag | `/api/shopify-draft-updated` |
| F4 | Cash tag — final payment (full) | Cashier adds tag | `/api/shopify-draft-updated` |
| F5 | Cash tag — advance then final (two-step) | Two separate tags | `/api/shopify-draft-updated` |
| F6 | GoKwik link — advance payment | Cashier adds tag | `/api/shopify-draft-updated` |
| F7 | GoKwik link — customer pays → webhook | GoKwik POST | `/api/gokwik-webhook` |
| F8 | GoKwik link — expires unpaid | Time-based | `/api/gokwik-webhook` |
| F9 | GoKwik link — manually cancelled | Cashier action | `/api/cancel-active-link` |
| F10 | Pine terminal — advance push | Cashier action | `/api/push-to-terminal` |
| F11 | Pine terminal — payment confirmed | Pine webhook | `/webhook/pine` |
| F12 | Pine terminal — payment failed/timeout | Pine webhook | `/webhook/pine` |
| F13 | Jewel reprice tag (MTO) | Cashier adds tag | `/api/shopify-draft-updated` |
| F14 | Jewel reprice — weight delta ≤ 5% | Same | Same |
| F15 | Manual: convert draft to order | Cashier action | `/api/convert-to-order` |
| F16 | Manual: send draft invoice | Cashier action | `/api/send-draft-invoice` |
| F17 | Manual: generate payment link | Cashier action | `/api/generate-payment-link` |
| F18 | Manual: log cash payment (API) | Cashier action | `/api/log-cash-payment` |
| F19 | Full offline order — cash only | End-to-end | F3 → F4 → F15 |
| F20 | Full offline order — Pine advance + GoKwik final | End-to-end | F10 → F6 → F7 → F15 |
| F21 | Full offline order — mixed (cash advance + Pine final) | End-to-end | F3 → F10 → F11 |

---

## Baseline: Supabase State Before Any Test

For each fresh test, verify these are clean or set up correctly:

| Table | Check |
|-------|-------|
| `store_deposits` | No row for test draft_order_id |
| `store_deposit_payments` | No rows for test draft_order_id |
| `payment_links` | No rows for test draft_order_id |
| `transactions` | No rows for test draft_order_name |

---

---

## F1 — Draft Created → Price Baked In

**Trigger:** Shopify creates a new draft order → fires `draft_orders/create` webhook

**Setup:**
- Shopify webhook registered: `draft_orders/create` → `POST /api/shopify-draft-created`
- Draft has at least one line item with a product that has a `Gold Value` property or gold-rate variant metafield

**Steps (cashier):**
1. Cashier creates a new draft order in Shopify Admin for a customer

**System expectations:**

| # | Assertion | ✅ |
|---|-----------|---|
| 1.1 | Webhook fires within Shopify's retry window | |
| 1.2 | Server responds 200 immediately (async processing) | |
| 1.3 | `recalculatePricing()` is called with the new draft ID | |
| 1.4 | Draft line item prices updated to reflect gold-rate-based calculation | |
| 1.5 | `_gold_rate` line item property written to the draft | |
| 1.6 | `Discount Applied` property matches current discount (loop prevention primed) | |

**Edge cases:**
- Draft has no products → webhook fires, no pricing action taken, no error thrown
- Draft created with 0 total → no crash

---

## F2 — Discount Applied → Reprice

**Trigger:** Cashier applies a discount to a draft → Shopify fires `draft_orders/update` webhook

**Setup:**
- Existing draft with gold-rate priced line item
- `_gold_rate` property already present
- Cashier applies a percentage or fixed discount in Shopify

**Steps (cashier):**
1. Open draft in Shopify Admin
2. Apply a discount (e.g., ₹500 off or 5%)

**System expectations:**

| # | Assertion | ✅ |
|---|-----------|---|
| 2.1 | `/api/shopify-draft-updated` receives full draft body | |
| 2.2 | `handleSendLinkTag` runs first — no `send-link-*` tag, exits cleanly | |
| 2.3 | `handleCashPaymentTag` runs — no `cash-*` tag, exits cleanly | |
| 2.4 | `handleRecalculatePriceTag` runs — no `recalculate-price` tag, exits cleanly | |
| 2.5 | Discount recalc logic detects `applied_discount.amount > 0` | |
| 2.6 | `Discount Applied` property on line item does NOT match new discount → recalc runs | |
| 2.7 | `recalculatePricing()` called with draft ID | |
| 2.8 | Line item price updated to reflect discount (Gold/Gross/Taxable/GST recalculated) | |
| 2.9 | `Discount Applied` property updated to new discount value | |

**Edge cases:**
- Same discount applied twice → loop prevention fires, recalc skipped (no infinite webhook loop)
- Discount removed (set to 0) → recalc runs to restore original price

---

## F3 — Cash Tag: Advance Payment

**Trigger:** Cashier adds tag `cash-AMOUNT` to a draft where no prior payment exists

**Setup:**
- Draft with a customer attached (with phone)
- No row in `store_deposits` for this draft
- Draft total known (e.g., ₹20,000 draft, cashier collects ₹10,000 advance)

**Steps (cashier):**
1. Open draft in Shopify Admin
2. Add tag `cash-10000` (for ₹10,000 cash advance)
3. Save draft

**System expectations:**

| # | Assertion | ✅ |
|---|-----------|---|
| 3.1 | `/api/shopify-draft-updated` webhook fires | |
| 3.2 | `handleCashPaymentTag` detects `cash-10000` tag | |
| 3.3 | `store_deposits` row CREATED: `draft_order_id`, `total_amount=20000`, `amount_paid=0`, `amount_pending=20000`, `payment_status='unpaid'` | |
| 3.4 | `installmentType` derived as `'advance'` (since status was 'unpaid') | |
| 3.5 | `store_deposits` row UPDATED: `amount_paid=10000`, `amount_pending=10000`, `payment_status='partial'` | |
| 3.6 | `store_deposit_payments` row INSERTED: `amount=10000`, `payment_mode='cash'`, `installment_type='advance'`, `payment_source='cash'`, `utr=null` | |
| 3.7 | Shopify draft tags ATOMIC update (single PUT): removes `cash-10000`, removes any old `paid:*`/`pending:*`/`deposit:*`/`pmode-*` tags | |
| 3.8 | Shopify draft tags contain `deposit:partial` | |
| 3.9 | Shopify draft tags contain `paid:Rs10000` | |
| 3.10 | Shopify draft tags contain `pending:Rs10000` | |
| 3.11 | Shopify draft tags contain `pmode-advance:cash` | |
| 3.12 | `cash-10000` tag NO LONGER present on draft | |
| 3.13 | Draft metafield `payment_status = 'partial'` | |
| 3.14 | Draft metafield `amount_paid = '10000.00'` | |
| 3.15 | Draft metafield `amount_pending = '10000.00'` | |
| 3.16 | Draft metafield `payment_mode_advance = 'cash'` | |
| 3.17 | Draft metafield `payment_mode_final` NOT set (still advance only) | |
| 3.18 | Draft metafield `is_finalized` NOT set or `false` | |
| 3.19 | No conversion to order (still partial) | |

**Edge cases:**
- Tag `cash-0` → amount = 0, handler exits early, tag NOT removed (or removed with error log)
- Tag `cash-abc` → invalid amount, handler exits cleanly, tag removed or left (check behavior)
- No customer attached to draft → phone absent, cash flow should still complete (no SMS for cash)
- Amount > draft total → `amount_pending` goes negative or 0 → treat as 'paid', check if conversion triggers

---

## F4 — Cash Tag: Final Payment (Full Order)

**Trigger:** Cashier adds `cash-AMOUNT` tag where amount equals outstanding balance → fully pays order

**Setup:**
- Existing `store_deposits` row with `payment_status='partial'`, `amount_paid=10000`, `amount_pending=10000`
- Draft total = ₹20,000

**Steps (cashier):**
1. Add tag `cash-10000` to draft (paying remaining balance)

**System expectations:**

| # | Assertion | ✅ |
|---|-----------|---|
| 4.1 | `installmentType` derived as `'final'` (deposit.payment_status was 'partial') | |
| 4.2 | `store_deposits` UPDATED: `amount_paid=20000`, `amount_pending=0`, `payment_status='paid'` | |
| 4.3 | `store_deposit_payments` row INSERTED: `installment_type='final'`, `payment_mode='cash'`, `amount=10000` | |
| 4.4 | Shopify tags: `deposit:fully-paid`, `paid:Rs20000`, `pmode-final:cash` | |
| 4.5 | `pending:*` tag removed | |
| 4.6 | `pmode-advance:cash` tag still present (from F3, should not be removed) | |
| 4.7 | Draft metafield `payment_status = 'full'` | |
| 4.8 | Draft metafield `amount_pending = '0.00'` | |
| 4.9 | Draft metafield `payment_mode_final = 'cash'` | |
| 4.10 | Draft metafield `is_finalized = 'true'` | |
| 4.11 | `convertDraftToOrder()` called → draft converted to order in Shopify | |
| 4.12 | Cash tag `cash-10000` removed from final order | |

---

## F5 — Cash Tag: Full Two-Step (Advance then Final)

**Full scenario combining F3 and F4:**

**Steps:**
1. Draft created, total = ₹20,000
2. Cashier adds `cash-10000` → F3 runs
3. [verify F3 assertions]
4. Cashier adds `cash-10000` again (final payment) → F4 runs
5. [verify F4 assertions]
6. Order conversion triggered

**Additional check:**

| # | Assertion | ✅ |
|---|-----------|---|
| 5.1 | `store_deposit_payments` has exactly 2 rows (advance + final) | |
| 5.2 | Both rows linked to same `deposit_id` | |
| 5.3 | First row: `installment_type='advance'` | |
| 5.4 | Second row: `installment_type='final'` | |
| 5.5 | Final Shopify order has both `pmode-advance:cash` and `pmode-final:cash` tags | |

---

## F6 — GoKwik Link: Advance Payment via Tag

**Trigger:** Cashier adds `send-link-AMOUNT` tag to draft

**Setup:**
- Draft with customer having a valid 10-digit phone
- Customer has email on profile
- No prior deposit record

**Steps (cashier):**
1. Add tag `send-link-10000` to draft in Shopify Admin

**System expectations:**

| # | Assertion | ✅ |
|---|-----------|---|
| 6.1 | `handleSendLinkTag` detects `send-link-10000` | |
| 6.2 | Phone extracted from `draft.customer.phone` (10-digit sanitized) | |
| 6.3 | `store_deposits` checked — `installmentType='advance'` (no prior record) | |
| 6.4 | `createGokwikLink()` called with `amount=10000`, `customerPhone`, `customerName`, `customerEmail` | |
| 6.5 | GoKwik API returns `{ gokwikLinkId, shortUrl, expiresAt }` | |
| 6.6 | `payment_links` row INSERTED: `status='created'`, `installment_type='advance'`, `amount=10000`, `expires_at` = ~7 days out | |
| 6.7 | SMS sent to customer with payment link URL | |
| 6.8 | Email sent to customer with payment link (if email present) | |
| 6.9 | `send-link-10000` tag REMOVED from draft | |
| 6.10 | No payment tags added yet (link created but not paid) | |
| 6.11 | No `store_deposits` row created (link generation does not create deposit record) | |

**Edge cases:**
- Customer has no phone on profile, no billing/shipping phone → error logged, tag still removed (or left?), no link created
- `send-link-0` → exits early
- `send-link-abc` → invalid amount, exits early
- GoKwik API returns error → payment_links NOT inserted, error logged, tag removed
- Customer has no email → SMS sent, email skipped silently

---

## F7 — GoKwik Webhook: Customer Pays Online

**Trigger:** Customer clicks link and pays → GoKwik POSTs to `/api/gokwik-webhook`

**Setup:**
- `payment_links` row exists with `status='created'` for the draft
- `merchant_reference_id` = `{draftOrderId}-{timestamp}`

**Webhook payload:**
```json
{
  "status": "success",
  "gokwik_oid": "{draftOrderId}-{timestamp}",
  "transaction_id": "GK_TXN_123",
  "gateway_reference_id": "UTR123456789",
  "payment_provider": "easebuzz",
  "status_code": "E0000"
}
```

**System expectations:**

| # | Assertion | ✅ |
|---|-----------|---|
| 7.1 | Middleware responds 200 immediately (always, even on error) | |
| 7.2 | `draftOrderId` extracted by stripping `-{timestamp}` suffix from `gokwik_oid` | |
| 7.3 | `payment_links` row UPDATED: `status='success'`, `gokwik_txn_id='GK_TXN_123'`, `utr='UTR123456789'`, `updated_at=now()` | |
| 7.4 | `handlePaymentCompletion` called with `is_partial=true`, `paymentSource='gokwik'`, `utr='UTR123456789'` | |
| 7.5 | `store_deposits` CREATED (if first payment): `total_amount` from Shopify draft, `amount_paid=0` | |
| 7.6 | `installmentType` correctly derived ('advance' if first payment) | |
| 7.7 | `store_deposits` UPDATED with new amounts and status | |
| 7.8 | `store_deposit_payments` row INSERTED: `installment_type='advance'`, `utr='UTR123456789'`, `payment_source='gokwik'`, `payment_mode='upi'` or as returned | |
| 7.9 | Shopify draft tagged: `deposit:partial`, `paid:Rs10000`, `pending:Rs10000`, `pmode-advance:gokwik` | |
| 7.10 | Draft metafields updated: `payment_status`, `amount_paid`, `amount_pending`, `payment_mode_advance='gokwik'` | |

**Edge cases:**
- Webhook fires twice (GoKwik retry) → idempotency check: `payment_links.status` already `'success'` → skip processing, return 200
- `status='cancelled'` payload → `payment_links` updated to `'cancelled'`, no `handlePaymentCompletion`
- `status='expired'` payload → `payment_links` updated to `'expired'`, no payment completion
- `status_code` not `'E0000'` → handle as failure (check if code validates this)
- `gokwik_oid` has no timestamp suffix → `draftOrderId` extraction fails → log error, return 200

---

## F8 — GoKwik Link: Expires Unpaid

**Trigger:** GoKwik POSTs `status='expired'` webhook after 7 days

**System expectations:**

| # | Assertion | ✅ |
|---|-----------|---|
| 8.1 | Middleware returns 200 | |
| 8.2 | `payment_links` row UPDATED: `status='expired'` | |
| 8.3 | No `handlePaymentCompletion` called | |
| 8.4 | Shopify draft tags UNCHANGED | |
| 8.5 | `store_deposits` UNCHANGED | |
| 8.6 | Cashier can create new link for same draft (new `payment_links` row) | |

---

## F9 — GoKwik Link: Manually Cancelled

**Trigger:** Cashier calls `/api/cancel-active-link` (by draft ID)

**Setup:**
- `payment_links` row with `status='created'` for the draft

**Steps (cashier):**
1. POST `/api/cancel-active-link` with body `{ "draftOrderId": "..." }`

**System expectations:**

| # | Assertion | ✅ |
|---|-----------|---|
| 9.1 | Server queries `payment_links` for latest `'created'` row for this draft | |
| 9.2 | `cancelPaymentLink(gokwikLinkId)` called with GoKwik API | |
| 9.3 | GoKwik returns `{ status: 'cancelled', cancelledAt }` | |
| 9.4 | `payment_links` row UPDATED: `status='cancelled'` | |
| 9.5 | 200 response with confirmation | |
| 9.6 | No `store_deposits` changes | |

**Edge cases:**
- No active link for draft → 404 or meaningful error returned
- GoKwik API fails on cancel → error returned, DB not updated

---

## F10 — Pine Terminal: Advance Push

**Trigger:** Cashier pushes a draft order to the Pine terminal for payment

**Setup:**
- Draft has `terminal:XXXX` tag set (or locationId maps to a known store)
- Store row exists in `stores` table with Pine credentials
- `is_partial = true`, amount = ₹10,000, total = ₹20,000

**Steps (cashier):**
1. POST `/api/push-to-terminal` with:
   ```json
   {
     "draftOrderId": "...",
     "draftOrderName": "#D1001",
     "amountInRupees": 10000,
     "locationId": "...",
     "terminalTag": "terminal:ABCD",
     "isPartial": true,
     "totalAmountInRupees": 20000,
     "customerName": "Rahul Sharma"
   }
   ```

**System expectations:**

| # | Assertion | ✅ |
|---|-----------|---|
| 10.1 | `resolveStoreForLocation()` resolves correct store from tag → location → fallback | |
| 10.2 | `transactions` row INSERTED with `status='pending'`, `pine_ptrid=null` initially | |
| 10.3 | Pine API called with correct `TransactionNumber`, `Amount`, `AllowedPaymentMode` | |
| 10.4 | Pine returns `PlutusTransactionReferenceID` (PTRID) | |
| 10.5 | `transactions` row UPDATED with `pine_ptrid` | |
| 10.6 | Response includes PTRID for cashier to reference | |
| 10.7 | Customer sees payment prompt on terminal | |

**Edge cases:**
- `terminal:XXXX` tag absent → fallback to locationId lookup → fallback to default store
- Pine API timeout → `transactions` row left as pending, error returned
- Store not found → 400 error returned

---

## F11 — Pine Terminal: Payment Confirmed

**Trigger:** Customer pays on terminal → Pine POSTs to `/webhook/pine`

**Webhook payload (CSV):**
```
ResponseCode=00&PlutusTransactionReferenceID=PTRID123&TransactionNumber=#D1001-{ts}&RRN=UTR987654321&PaymentMode=UPI
```

**System expectations:**

| # | Assertion | ✅ |
|---|-----------|---|
| 11.1 | `parsePineCSV()` extracts all fields correctly | |
| 11.2 | `ResponseCode=00` → maps to `'PAID'` via `getPineStatusResult()` | |
| 11.3 | `transactions` row found by `pine_ptrid` or `TransactionNumber` | |
| 11.4 | `transactions` row UPDATED: `status='PAID'`, `utr='UTR987654321'`, `payment_mode='UPI'` | |
| 11.5 | `handlePaymentCompletion` called with `is_partial=true`, `utr='UTR987654321'`, `paymentModeOverride='UPI'`, `paymentSource='pine'` | |
| 11.6 | `store_deposits` CREATED/UPDATED (same as F7 assertions 7.5–7.7) | |
| 11.7 | `store_deposit_payments` INSERTED: `pine_ptrid='PTRID123'`, `utr='UTR987654321'`, `payment_mode='UPI'`, `payment_source='pine'` | |
| 11.8 | Shopify draft tags updated with `deposit:partial`, `paid:Rs10000`, `pmode-advance:UPI` | |
| 11.9 | Draft metafields updated | |
| 11.10 | Pine webhook returns 200 | |

**Edge cases:**
- `ResponseCode` not `00` → `getPineStatusResult()` returns `null` or `'FAILED'` → no `handlePaymentCompletion`, status updated to failed
- Same PTRID received twice → idempotency: transaction already `'PAID'`, skip processing
- `TransactionNumber` doesn't match any transaction → log error, return 200

---

## F12 — Pine Terminal: Payment Failed / Timeout

**Trigger:** Customer cancels or terminal times out → Pine POSTs failure

**Payload:** `ResponseCode=01` (or any non-`00` code)

**System expectations:**

| # | Assertion | ✅ |
|---|-----------|---|
| 12.1 | `transactions` row UPDATED: `status='FAILED'` | |
| 12.2 | No `handlePaymentCompletion` called | |
| 12.3 | `store_deposits` UNCHANGED | |
| 12.4 | Shopify tags UNCHANGED | |
| 12.5 | Cashier can retry push to terminal (new transaction row created) | |

---

## F13 — Jewel Reprice Tag (MTO): Weight Delta > 5%

**Trigger:** Cashier adds `recalculate-price` tag to an MTO draft

**Setup:**
- Draft has a line item with `_gold_rate` property (e.g., ₹7,200/g)
- Draft has `Gold Value: ₹36,000` property (implies old_net_wt = 36000/7200 = 5g)
- Staff sets draft metafields: `custom.net_wt = 5.5` (new weight — >5% delta from 5g)
- Draft metafields also have: `custom.gross_wt`, `custom.diamond_cts`, `custom.diamond_pcs`, `custom.jewel_code`

**Steps (cashier/staff):**
1. Set `custom.net_wt = 5.5` on draft metafields
2. Add tag `recalculate-price` to draft

**System expectations:**

| # | Assertion | ✅ |
|---|-----------|---|
| 13.1 | `handleRecalculatePriceTag` detects `recalculate-price` tag | |
| 13.2 | Fetches draft metafields (custom namespace) | |
| 13.3 | `net_wt = 5.5` extracted from metafields | |
| 13.4 | Line item with `_gold_rate` property found | |
| 13.5 | `oldNetWt = oldGoldValue / goldRate = 36000 / 7200 = 5.0` | |
| 13.6 | `delta = |5.5 - 5.0| / 5.0 = 10%` → > 5% → REPRICE | |
| 13.7 | `newGoldValue = 5.5 × 7200 = ₹39,600` | |
| 13.8 | `deltaGold = 39600 - 36000 = ₹3,600` | |
| 13.9 | `newGrossValue = oldGrossValue + 3600` | |
| 13.10 | Existing discount respected → `newFinalValue = newGrossValue - discountAmount` | |
| 13.11 | `newTaxableValue = newFinalValue / 1.03` | |
| 13.12 | `newGst = newTaxableValue × 0.03` | |
| 13.13 | Line item `Gold Value` property updated to new value | |
| 13.14 | Line item `Gross Value` property updated | |
| 13.15 | Line item `Taxable Value` property updated | |
| 13.16 | Line item `GST` property updated | |
| 13.17 | Line item `price` updated to `newFinalValue` | |
| 13.18 | Hidden `_net_wt`, `_gross_wt`, `_diamond_cts`, `_diamond_pcs`, `_jewel_code` properties written | |
| 13.19 | Hidden `_jewel_data` property written as JSON with `repriced: true`, `weight_delta_pct: 0.10` | |
| 13.20 | `timanti.jewelcode` metafield written with full jewel JSON | |
| 13.21 | ATOMIC PUT: tag removal (`recalculate-price`) + line item updates in SINGLE PUT call | |
| 13.22 | `recalculate-price` tag NO LONGER on draft | |
| 13.23 | No webhook loop triggered (tag already removed before next webhook fires) | |

---

## F14 — Jewel Reprice: Weight Delta ≤ 5%

**Setup:** Same as F13 but `custom.net_wt = 5.2` (delta = 4% ≤ 5%)

**System expectations:**

| # | Assertion | ✅ |
|---|-----------|---|
| 14.1 | Delta computed: `|5.2 - 5.0| / 5.0 = 4%` | |
| 14.2 | No line item price changes | |
| 14.3 | Gold/Gross/Taxable/GST properties UNCHANGED | |
| 14.4 | Hidden jewel props still written (`_jewel_data` with `repriced: false`) | |
| 14.5 | `recalculate-price` tag removed | |
| 14.6 | ATOMIC PUT issued (tag removal only, no price changes) | |

---

## F15 — Manual: Convert Draft to Order

**Trigger:** Cashier explicitly converts draft (IRREVERSIBLE)

**Steps:**
1. POST `/api/convert-to-order` with `{ "draftOrderId": "..." }`

**System expectations:**

| # | Assertion | ✅ |
|---|-----------|---|
| 15.1 | `convertDraftToOrder()` called, bypasses `AUTO_CONVERT_DRAFT_TO_ORDER` flag | |
| 15.2 | Shopify `POST /draft_orders/{id}/complete.json` called | |
| 15.3 | Draft converted to order in Shopify | |
| 15.4 | Final order ID returned in response | |
| 15.5 | Calling again on same draft returns error (already converted) | |

**Edge cases:**
- Draft already converted → Shopify returns 422 → error passed back to cashier

---

## F16 — Manual: Send Draft Invoice

**Steps:**
1. POST `/api/send-draft-invoice` with `{ "draftOrderId": "..." }`

**System expectations:**

| # | Assertion | ✅ |
|---|-----------|---|
| 16.1 | `sendDraftOrderInvoice()` called, bypasses `AUTO_SEND_DRAFT_INVOICE` flag | |
| 16.2 | Shopify `POST /draft_orders/{id}/send_invoice.json` called | |
| 16.3 | Customer receives Shopify invoice email | |
| 16.4 | 200 returned to cashier | |

---

## F17 — Manual: Generate Payment Link (API)

**Steps:**
1. POST `/api/generate-payment-link` with full body:
   ```json
   {
     "draftOrderId": "...",
     "draftOrderName": "#D1001",
     "amount": 10000,
     "totalAmount": 20000,
     "customerPhone": "9876543210",
     "customerName": "Rahul",
     "customerEmail": "rahul@example.com"
   }
   ```

**System expectations:**

| # | Assertion | ✅ |
|---|-----------|---|
| 17.1 | `createGokwikLink()` called | |
| 17.2 | `payment_links` row inserted | |
| 17.3 | SMS sent to `9876543210` | |
| 17.4 | Email sent to `rahul@example.com` | |
| 17.5 | Response includes `shortUrl` and `gokwikLinkId` | |

**Edge cases:**
- `amount` missing → 400 or validation error
- GoKwik API fails → meaningful error, no DB insert

---

## F18 — Manual: Log Cash Payment (API)

**Steps:**
1. POST `/api/log-cash-payment`:
   ```json
   {
     "draftOrderId": "...",
     "draftOrderName": "#D1001",
     "amountInRupees": 10000,
     "totalAmountInRupees": 20000,
     "customerName": "Rahul"
   }
   ```

**System expectations:**

| # | Assertion | ✅ |
|---|-----------|---|
| 18.1 | `handlePaymentCompletion` called with `is_partial=true`, `paymentSource='cash'` | |
| 18.2 | `store_deposits` created/updated | |
| 18.3 | `store_deposit_payments` inserted with `payment_mode='cash'` | |
| 18.4 | Shopify tags updated | |
| 18.5 | Metafields updated | |

> Note: This is the API-direct route. The tag-based `cash-AMOUNT` (F3/F4) is the cashier's primary method. F18 is for Postman/scripted use.

---

## F19 — Full Offline Order: Cash Only (End-to-End)

This stitches F3 → F4 → F15 into a single linear flow.

**Scenario:** Walk-in customer, ₹20,000 jewellery purchase, pays ₹10,000 advance in cash, returns next day for final ₹10,000 in cash.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Create draft in Shopify for ₹20,000 | Webhook fires, price baked in |
| 2 | Add `cash-10000` tag | F3 assertions pass; `deposit:partial` tag on draft |
| 3 | Verify invoice (optional) | POST `/api/send-draft-invoice` |
| 4 | Customer returns, add `cash-10000` tag | F4 assertions pass; `deposit:fully-paid` tag |
| 5 | Verify order conversion | Draft becomes order in Shopify |
| 6 | Check `store_deposit_payments` | 2 rows: advance + final, both `payment_mode='cash'` |
| 7 | Check final order tags | `pmode-advance:cash`, `pmode-final:cash`, `deposit:fully-paid` |

---

## F20 — Full Offline Order: Pine Advance + GoKwik Final

**Scenario:** Customer pays ₹10,000 advance via Pine terminal, later pays remaining ₹10,000 via GoKwik link.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Create draft for ₹20,000 | Draft priced |
| 2 | POST `/api/push-to-terminal` with `isPartial=true`, amount=10000 | Transaction in `transactions` |
| 3 | Customer pays on terminal | Pine webhook fires → F11 assertions |
| 4 | `store_deposits`: partial, `amount_paid=10000` | |
| 5 | Add `send-link-10000` tag to draft | F6 assertions; GoKwik link created |
| 6 | Customer pays via link | F7 webhook fires |
| 7 | `installmentType='final'` derived (prior partial exists) | |
| 8 | `store_deposits` updated: `payment_status='paid'` | |
| 9 | Draft auto-converted to order | F11/F4 assertions |
| 10 | Final tags: `pmode-advance:UPI`, `pmode-final:gokwik` | |
| 11 | `store_deposit_payments` has 2 rows: pine (advance) + gokwik (final) | |

---

## F21 — Full Offline Order: Cash Advance + Pine Final

**Scenario:** Cash advance via tag, final via Pine terminal.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Create draft for ₹20,000 | |
| 2 | Add `cash-10000` tag → F3 | `deposit:partial`, `pmode-advance:cash` |
| 3 | POST `/api/push-to-terminal`, `isPartial=true`, amount=10000 | |
| 4 | Terminal payment confirmed → F11 | `installmentType='final'` derived |
| 5 | `store_deposits`: `payment_status='paid'` | |
| 6 | Order converted | |
| 7 | Tags: `pmode-advance:cash`, `pmode-final:UPI` | |

---

## Shared Edge Cases (Apply Across All Flows)

| # | Edge Case | Check |
|---|-----------|-------|
| E1 | Shopify webhook fires multiple times (retry storm) — tag handler must be idempotent | Tag already removed on second fire → no duplicate DB rows |
| E2 | `store_deposits` row missing when payment arrives — auto-CREATE with Shopify total | Shopify total fetch succeeds even if draft is old |
| E3 | `AUTO_SEND_DEPOSIT_EMAIL=true` — deposit email fires on every payment | Verify email arrives for advance AND final; NOT for full-payment-in-one-go |
| E4 | `AUTO_SEND_DRAFT_INVOICE=true` — invoice fires on partial status only | Verify invoice NOT sent if `payment_status='paid'` |
| E5 | `AUTO_CONVERT_DRAFT_TO_ORDER=false` — `/api/convert-to-order` still works (bypasses flag) | Conversion succeeds via manual route |
| E6 | Amount exactly equals total (₹0 pending) — treated as fully paid | `amount_pending` floored to 0, `payment_status='paid'` |
| E7 | Two simultaneous webhook calls for same draft (race condition) — check DB upsert behavior | No duplicate `store_deposit_payments` rows |
| E8 | GoKwik link created, then another `send-link-*` tag added — should create new link | `payment_links` gets second row, first left as `'created'` |
| E9 | Pine PTRID missing from webhook — fallback to `TransactionNumber` lookup | Transaction found, payment processed |
| E10 | MTO draft — `_gold_rate` property absent, variant has `custom.gold_rate` metafield | Bootstrap from variant metafield succeeds |

---

## API Quick Reference (for Postman)

| Route | Method | Key Body Params |
|-------|--------|-----------------|
| `/api/push-to-terminal` | POST | draftOrderId, draftOrderName, amountInRupees, locationId, terminalTag, isPartial, totalAmountInRupees, customerName |
| `/api/cancel-transaction` | POST | transactionId |
| `/api/generate-payment-link` | POST | draftOrderId, draftOrderName, amount, totalAmount, customerPhone, customerName, customerEmail |
| `/api/cancel-active-link` | POST | draftOrderId |
| `/api/cancel-payment-link` | POST | gokwikLinkId |
| `/api/log-cash-payment` | POST | draftOrderId, draftOrderName, amountInRupees, totalAmountInRupees, customerName |
| `/api/send-draft-invoice` | POST | draftOrderId |
| `/api/convert-to-order` | POST | draftOrderId |
| `/api/recalculate-price` | POST | draftOrderId |
| `/pricing/recalculate` | POST | draftOrderId |
| `/api/draft-order-metafields` | GET | ?draftOrderId=X |
| `/api/draft-order-metafields` | POST | draftOrderId, fields: { key: value } |
| `/api/draft-order-line-items` | GET | ?draftOrderId=X |
| `/api/payment-links` | GET | ?draftOrderId=X |

---

## Supabase Verification Queries

Run these in Supabase SQL editor after each flow:

```sql
-- Check deposit record
SELECT * FROM store_deposits WHERE draft_order_id = '{ID}';

-- Check installment records
SELECT * FROM store_deposit_payments WHERE draft_order_id = '{ID}' ORDER BY created_at;

-- Check payment links
SELECT * FROM payment_links WHERE draft_order_id = '{ID}' ORDER BY created_at DESC;

-- Check Pine transactions
SELECT * FROM transactions WHERE draft_order_name = '#D1001' ORDER BY created_at DESC;
```

---

*Total flows: 21 | Total assertions: ~120 | Edge cases: 10 shared*
