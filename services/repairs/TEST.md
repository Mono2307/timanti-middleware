# Repairs Flow — E2E Test Guide

## How it works

The repair draft update webhook arrives at `/api/shopify-draft-updated` (existing registration).
`handleRepairDraftUpdate` runs at the end of that handler after all other tag handlers.

The GoKwik payment webhook arrives at `/api/gokwik-webhook` (existing registration).
If the draft has `repair-estimate-sent` or `repair-estimate-ready` tags, it branches to `handleRepairPayment` before the deposit flow.

**Required env vars:**
- `HQ_EMAIL` — internal email that receives intake notifications (e.g. `hq@timanti.in`)
- `SERVER_URL` — public URL of the middleware (defaults to `https://timanti-middleware.fly.dev`)

---

## Trigger 0 — Intake → HQ notification

1. Create a draft order in Shopify Admin
   - Customer with real email + phone
   - At least one line item (e.g. "Ring Repair")
   - Set price to ₹1 (placeholder)
   - Add notes describing the repair
2. Add tag `repair-intake` → Save

**Expected logs:**
```
Repair intake trigger: D#XXXX
✅ Repair intake sent to HQ: D#XXXX
```

**Expected in Shopify:** tag `repair-hq-notified` added, metafield `timanti.repair_intake_at` written

**Expected in HQ inbox:** intake email with customer details, notes, and "Set Estimate & Send to Customer" button

---

## Trigger 1 — Estimate email + GoKwik link

1. HQ clicks "Set Estimate & Send to Customer" in the intake email
2. Form page loads at `/repairs/set-estimate?d=...&t=...`
3. HQ enters the estimate amount (e.g. ₹1500) and submits

**What the server does:**
- Updates first line item price on the draft order to the entered amount
- Adds tag `repair-estimate-ready` in the same PUT
- Shopify webhook fires → `handleRepairDraftUpdate` → Trigger 1 runs

**Expected logs (after form submit):**
```
✅ Estimate set for D#XXXX: ₹1500 — repair-estimate-ready added
Repair estimate trigger: D#XXXX
✅ Repair estimate sent: D#XXXX
```

**Expected in Shopify:** tag `repair-estimate-sent` added, metafield `timanti.repair_estimate_sent_at` written, line item price updated to estimate amount

**Expected in customer inbox:** estimate email with GoKwik Pay Now button

---

## Trigger 2 — Payment received

1. Customer clicks the GoKwik link from the estimate email
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

**Expected in customer inbox:** payment confirmation email

---

## Trigger 3 — Repair complete

1. Add tag `repair-complete` to the same draft → Save

**Expected logs:**
```
Repair complete trigger: D#XXXX
✅ Repair completion notified: D#XXXX
```

**Expected in Shopify:** tag `repair-completion-notified` added, metafield `timanti.repair_completed_at` written

**Expected in customer inbox:** "Your Repair is Ready" email

---

## Tag lifecycle

```
repair-intake              set by staff         → triggers Trigger 0
repair-hq-notified         set by server        → dedup guard
repair-estimate-ready      set by server (form) → triggers Trigger 1
repair-estimate-sent       set by server        → dedup guard
repair-paid                set by server        → set by Trigger 2
repair-complete            set by staff         → triggers Trigger 3
repair-completion-notified set by server        → dedup guard
repair-returned            set by staff         → end of lifecycle
```

---

## If something doesn't fire

- **No HQ intake email:** check `REPAIR_HQ_EMAIL` env var is set; check logs for `REPAIR_HQ_EMAIL not set` or `Intake email failed`
- **Form link expired/invalid:** regenerated on every intake — only valid for the specific draft. If HQ needs a new link, remove `repair-hq-notified` tag and re-save the draft to retrigger intake
- **No estimate email after form submit:** check logs for `Repair estimate trigger` — if missing, the Shopify webhook may not have fired; verify `repair-estimate-ready` tag was actually added in Shopify admin
- **No estimate email:** check logs for `GoKwik link failed` or `Resend failed` — if either errors, tag is NOT added so the form can be resubmitted
- **GoKwik payment not recording:** check logs for `Repair branch check failed` — means the draft fetch errored; deposit flow will have run instead
- **Completion email not sending:** check `Resend failed (complete)` in logs

## Confirmed working

Triggers 1 → 2 → 3 tested 2026-05-19. Trigger 0 added 2026-05-19.
