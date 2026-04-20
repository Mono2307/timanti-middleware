# 🔴 7A. Draft Order Recalculation Layer (Phase 1A — Mandatory)

## 🎯 Objective

Ensure that:
- Discounts entered in Draft Orders are applied on **taxable value (not tax-inclusive value)**
- GST is **recomputed correctly**
- Draft Order totals and Invoice totals are **always identical**

---

## ⚠️ Problem Statement

Shopify Draft Orders:

- Apply discounts on **tax-inclusive values**
- Do NOT recompute GST after discount
- Result in incorrect:
  - taxable value
  - GST
  - final total

👉 Therefore, Draft Orders must be **explicitly recalculated before payment**

---

## 🧠 Core Principle

> Invoice must NOT “fix” pricing  
> Draft Order must already contain correct values

---

## 🔁 Updated Flow (Phase 1A)

Draft Order Created  
→ Staff adds Discount (as line item)  
→ 🔴 Recalculation Triggered (manual / API)  
→ Draft Order UPDATED with corrected pricing  
→ POS → Payment  
→ Invoice renders (no transformation logic)

---

## 🧩 Discount Input Mechanism

Discount is entered as a **custom negative line item**:

- Title: "Discount Adjustment" (standardized)
- Price: negative value (₹-X)
- No variant_id

---

## 🧠 Detection Rule

Discount line item is identified as:

- line item where:
  - title contains "Discount"
  - AND price < 0

---

## ⚙️ Recalculation Logic

### Step 1 — Separate Values

gross_total = sum(all NON-discount line items)

discount_amount = absolute value of discount line item

---

### Step 2 — Convert to Taxable

taxable_before_discount = gross_total / 1.03

---

### Step 3 — Apply Discount

taxable_after_discount = taxable_before_discount - discount_amount

Constraint:
discount_amount ≤ taxable_before_discount

---

### Step 4 — Recompute GST

gst = 3% of taxable_after_discount

---

### Step 5 — Final Value

final_total = taxable_after_discount + gst

---

## 🔄 Draft Order Update Rule (CRITICAL)

After recalculation:

- Product line item price MUST be updated to:
  → final_total

- Discount line item:
  → may be retained for visibility OR removed
  → MUST NOT affect final calculation

---

## ⚠️ Non-Negotiable Constraint

> Draft Order total MUST equal computed final_total

If not:
- POS mismatch occurs
- Invoice mismatch occurs
- Accounting breaks

---

## 🧾 Invoice Dependency

Invoice MUST:

- Read values directly from Draft Order
- NOT recompute pricing independently

---

## 🔧 Trigger Mechanism

One of the following MUST be implemented:

### Option A — Manual Trigger (Phase 1)
- “Recalculate Price” action before POS push

### Option B — Automated Trigger (Phase 2)
- On draft order update webhook

---

## 🧪 Validation Criteria (Phase 1A)

- Draft Order total = recalculated final_total
- Invoice total = Draft Order total
- GST = exactly 3% of discounted taxable value
- No rounding errors