# Repairs Flow — E2E Test Guide

## How it works

The repair draft update webhook arrives at `/api/shopify-draft-updated` (existing registration).
`handleRepairDraftUpdate` runs at the end of that handler after all other tag handlers.

The GoKwik payment webhook arrives at `/api/gokwik-webhook` (existing registration).
If the draft has `repair-estimate-sent` or `repair-estimate-ready` tags, it branches to `handleRepairPayment` before the deposit flow.

---

## Trigger 1 — Estimate email + GoKwik link

1. Create a draft order in Shopify Admin
   - Customer with real email + phone
   - At least one line item (e.g. "Ring Repair")
   - Set a price (e.g. ₹1500)
2. Add tag `repair-estimate-ready` → Save

**Expected logs:**
```
Repair estimate trigger: D#XXXX
✅ Repair estimate sent: D#XXXX
```

**Expected in Shopify:** tag `repair-estimate-sent` added, metafield `timanti.repair_estimate_sent_at` written

**Expected in inbox:** estimate email with GoKwik Pay Now button

---

## Trigger 2 — Payment received

1. Click the GoKwik link from the estimate email
2. Complete payment (use GoKwik sandbox card)

**Expected logs:**
```
GoKwik repair payment: draft=XXXXXXX txn=...
✅ Repair payment recorded: D#XXXX txn=...
```

**Expected in Shopify:** tags → `repair-paid` (estimate tags removed), metafields written:
- `timanti.payment_status` = paid
- `timanti.gokwik_transaction_id`
- `timanti.payment_amount`
- `timanti.payment_method` = gokwik_link
- `timanti.payment_date`

**Expected in inbox:** payment confirmation email

---

## Trigger 3 — Repair complete

1. Add tag `repair-complete` to the same draft → Save

**Expected logs:**
```
Repair complete trigger: D#XXXX
✅ Repair completion notified: D#XXXX
```

**Expected in Shopify:** tag `repair-completion-notified` added, metafield `timanti.repair_completed_at` written

**Expected in inbox:** "Your Repair is Ready" email

---

## Tag lifecycle

```
repair-intake            set by staff
repair-estimate-ready    set by staff       → triggers Trigger 1
repair-estimate-sent     set by server      → dedup guard
repair-paid              set by server      → set by Trigger 2
repair-complete          set by staff       → triggers Trigger 3
repair-completion-notified set by server    → dedup guard
repair-returned          set by staff       → end of lifecycle
```

---

## If something doesn't fire

- **No estimate email:** check logs for `GoKwik link failed` or `Resend failed` — if either errors, tag is NOT added so staff can retry by re-saving the draft
- **GoKwik payment not recording:** check logs for `Repair branch check failed` — means the draft fetch errored; deposit flow will have run instead
- **Completion email not sending:** same pattern — check `Resend failed (complete)` in logs

## Confirmed working

Tested 2026-05-19. Full Trigger 1 → 2 → 3 cycle verified.
