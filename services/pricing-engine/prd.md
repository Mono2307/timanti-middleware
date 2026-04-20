🧾 UPDATED PRD — Jewellery Pricing Engine (Phase 1: Offline, Finalized)
🎯 1. Objective

Build a centralized pricing engine that:

Computes jewellery pricing using:
Gold (per SKU)
Diamond (aggregated stones)
Making charges
Applies selective discounts entered at Draft Order level
Recalculates GST @ 3% on discounted taxable value
Outputs final tax-inclusive price
Ensures Shopify-native reporting compatibility
Works seamlessly with:
Draft Orders
POS flow via Retool
🛑 2. Critical Execution Constraint

Phase 1 is strictly Offline (Draft Orders + POS)

No storefront integration
No cart logic
No GoKwik
No Shopify discount engine

👉 All pricing must be validated inside Draft Orders first

🧠 3. System Principles
3.1 Pricing Ownership
Shopify does NOT calculate price
Pricing Engine is the single source of truth
3.2 Discount Input Location (UPDATED)

Discounts are entered inside Shopify Draft Order UI by staff

NOT via Retool
NOT via frontend
Engine must:
read discount input
interpret it
recompute pricing
3.3 No Rounding Rule

❌ NO rounding allowed at any stage

Preserve exact decimals
Prevent GST mismatch
3.4 Tax Model
Prices are GST inclusive
GST = 3% of discounted taxable value
Always recomputed
💰 4. Pricing Model
Base:
computed_price = gold + diamond + making
Discount Application:
discount applied to:
1. diamond (default)
2. making (if specified)
Final:
taxable_value = gold + making + discounted_diamond
gst = 3% of taxable_value
final_price = taxable_value + gst
🧾 5. Price Layers (MANDATORY)
Field	Description
list_price	Shopify variant price
computed_price	gold + diamond + making
final_price	post-discount + GST
🎯 6. Discount System (UPDATED CORE)
🔥 Source of Discount

Discount is entered in Shopify Draft Order UI

Possible formats:
Flat amount (₹)
Percentage (%)
🧠 Interpretation Rule

Engine must map discount into:

diamond absorption (primary)

Example:
₹2000 order discount
→ reduce diamond value by ₹2000
⚙️ Supported Types
Input	Engine Mapping
% off order	% off diamond
Flat ₹ off order	flat off diamond
Future: making discount	secondary layer
🚫 Constraints
Gold NEVER discounted
Discount ≤ (diamond + optionally making)
🧾 7. Draft Order Interaction Model (UPDATED)

Using:

Shopify Admin API
🧩 Two Modes of Operation
Mode A — Draft Creation (initial)
Engine computes base price
Draft created with:
computed_price + GST
no discount yet
Mode B — Draft Update (CRITICAL)

After staff enters discount:

👉 Engine must:

Fetch draft order
Read:
discount value / %
Recompute:
diamond adjustment
GST
Update draft order price
🔁 Flow
Draft created
→ Staff adds discount in Shopify
→ Engine triggered (manual / webhook)
→ Recalculate price
→ Update draft order
→ POS → Payment
🏪 8. POS Flow (UNCHANGED BUT CLARIFIED)
Draft created → Retool fetch → POS
→ Payment → Webhook → Complete

👉 Retool is transport only
👉 No pricing logic there

🧾 9. Reporting Strategy (IMPORTANT UPGRADE)
🎯 Goal

Maintain Shopify-native reporting AND track discount identity

✅ Implementation
Line Item Price:
price = final_price
Line Item Properties:
List Price
Computed Price
Gold
Diamond
Making
Discount Value
Discount Type
Discount Code (ENGINE GENERATED)
GST
🧠 Discount Code Requirement

Engine must generate a unique identifier

Example:

DISC-DIA-20P-APR26-001

This enables:

filtering in exports
campaign tracking
staff attribution later
⚠️ Note
This is NOT Shopify discount codes
Stored as metadata only
Fully reportable via exports / APIs
⚙️ 10. Data Handling
Source
Variant metafields (seeded via Excel)
Runtime Behavior (UPDATED)

Pricing Engine caches pricing in memory

Requirements:
Load on startup
Refresh periodically OR via manual trigger
⚡ 11. Performance Requirements
Pricing compute: <100 ms
Draft update: <400 ms
No noticeable delay in POS flow
🧪 12. Validation Criteria (STRICT GATE)

Before online:

✅ Draft order updates correctly after discount
✅ GST always accurate
✅ No mismatch in paid vs draft value
✅ Discount correctly absorbed into diamond
✅ No rounding errors
✅ Discount code visible in order
🚨 13. Risks & Mitigations
Risk	Mitigation
Staff enters large discount	cap at diamond value
GST mismatch	no rounding
Draft not updated	enforce trigger step
Reporting confusion	store breakdown