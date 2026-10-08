# Loyalty Programme: user acceptance criteria

**Scope:** Plan A loyalty (tiers on lifetime spend, diamond-only discount online and in-store).
**Rule for every test:** no real order is created and nothing is paid.
- The live tests work on scratch **draft** orders. They are never converted and are deleted afterwards.
- They use one-time codes the test creates and deletes itself.
- They use a dedicated test customer whose points are moved with temporary adjustments, which are removed afterwards.

**Method key:**
- **AUTO-OFFLINE:** runs on a laptop with no connection to Shopify.
- **AUTO-LIVE:** runs inside the deployed service against the real store and cleans up after itself.
- **MANUAL:** a person looks at a screen. These checks are the UI and GoKwik, which a script cannot see.

---

## 1. Before you start (one time)

| # | Prerequisite | How |
|---|---|---|
| 1 | Loyalty deployed and switched on | `loyalty/ROLLOUT.md` steps 1–3 (migration, deploy, `LOYALTY_ENABLED=true`, `/api/loyalty/setup`) |
| 2 | Card-terminal auto-push is **off** | If `AUTO_PUSH_TO_TERMINAL` is on, the self-test refuses to create scratch drafts and skips the in-store tests |
| 3 | A **UAT test customer** in Shopify | e.g. "UAT Loyalty", using an email you own. Note the numeric customer id from its admin URL |
| 4 | Three variant ids from the catalogue | **eligible**: a diamond piece. **second**: another diamond piece. **excluded**: the gold coin (SKU `SCOIN`) or any product tagged `no-loyalty` |
| 5 | The admin secret | The same `ADMIN_API_SECRET` the other operator endpoints use |

## 2. Run the automated criteria

```powershell
$env:ADMIN_API_SECRET = "<secret>"
node tools/loyalty-uat.js --customer <uatCustomerId> --eligible <variant> --second <variant> --excluded <variant>
```

It runs the offline suites (53 checks) and then the live self-test. Each criterion below is printed as PASS, FAIL or SKIP, and the exit code is 0 only if everything passed. A full run takes about 5–8 minutes because it waits for Shopify's webhooks.

Afterwards, the UAT customer is put back to its real points, and its scratch drafts and codes are gone.

---

## 3. Acceptance criteria

### A. Rules (AUTO-OFFLINE, `src/modules/loyalty/engine.test.js`, 37 checks)

| ID | Criterion | Expected |
|---|---|---|
| A1 | Tier thresholds | Below ₹2L there is no tier. Exactly ₹2L / ₹5L / ₹10L is tier 1 / 2 / 3. The top tier has no "next tier" |
| A2 | Diamond-only discount | Gold tier on a ₹80,000 diamond gives ₹4,000 off. Gold, making and gemstone are untouched |
| A3 | Birthday / anniversary month | +2% in the month. Both in the same month still gives +2% once. Another month gives +0% |
| A4 | Month is Indian time | 31 Mar 20:00 UTC already counts as April |
| A5 | Exclusions | The gold coin, `no-loyalty`-tagged products, lines with no diamond value and exchange-note lines are never discounted. Exclusions always beat inclusions |
| A6 | Not eligible | Below tier, no eligible pieces, or programme switched off: refused with a reason |
| A7 | Online amount | The pre-tax discount × 1.03 (prices include GST) |
| A8 | Earning | Points = what was paid, floored. Cancelled orders earn 0. Online vouchers and exchange notes count as payment. Refunds come off |
| A9 | Exclusivity | Any discount code or per-line discount blocks loyalty. Vouchers and exchange notes do not |
| A10 | Config safety | A % over 100 is refused. Tiers are sorted whatever order they are typed in |

### B. Behaviour with Shopify simulated (AUTO-OFFLINE, `src/modules/loyalty/flows.test.js`, 16 checks)

| ID | Criterion | Expected |
|---|---|---|
| B1 | Apply on a draft | Tier customer: rate recorded, `loyalty-applied` + `reprice` tags, only eligible pieces listed |
| B2 | Pricing hook | The engine receives 5% of the diamond on eligible lines only. Other discount inputs are ignored while loyalty is on |
| B3 | Line changes | Adding a piece re-checks the draft and covers the new eligible line |
| B4 | Conflict | A discount code added later takes loyalty off and leaves a reason |
| B5 | Refusals | Another discount, below tier, or no customer: a short `loyalty-invalid` tag plus a full note. Every tag is ≤ 40 characters |
| B6 | Remove | Loyalty record and `discount_applied` deleted, then reprice |
| B7 | Conversion | Exactly one store redemption recorded per draft |
| B8 | Earning | Order lifts the tier and swaps the tag. A duplicate delivery changes nothing. A refund lowers the tier |
| B9 | Online settlement | Code marked used. Points go to whoever asked for the code. GoKwik phone mismatch flagged. Code deleted |
| B10 | Proxy security | A correctly signed storefront request passes. A tampered customer id, an unsigned request, or a missing secret is rejected |

### C. Live: setup (AUTO-LIVE, self-test P1–P6)

| ID | Criterion | Expected |
|---|---|---|
| P1 | Switched on | `LOYALTY_ENABLED` is true |
| P2 | Config | The shop setting reads and validates. The tiers are printed |
| P3 | Database | Both loyalty tables are reachable |
| P4 | Customer fields | All `loyalty.*` definitions exist and are readable by the storefront and the customer account |
| P5 | Test customer | Exists |
| P6 | Proxy secret | Configured |

### D. Live: tier on the customer (AUTO-LIVE, T1–T5)

| ID | Criterion | Expected on the Shopify customer |
|---|---|---|
| T1 | ₹1 below the first tier | Tier `none`, no `loyalty-T*` tag |
| T2 | Exactly on the first threshold | Tier 1, tag `loyalty-T1` |
| T3 | Second tier | Tier 2, only `loyalty-T2` |
| T4 | Top tier | Tier 3, only `loyalty-T3` |
| T5 | Points fall (as after a refund) | Steps back to tier 2. The tier-3 tag is removed |

### E. Live: in-store on a scratch draft (AUTO-LIVE, D1–D9)

| ID | Criterion | Expected on the draft |
|---|---|---|
| D1 | Apply loyalty (tier 2 customer) | For each eligible line: Discount on Diamond = rate × Diamond (±₹1), Discount Applied = Discount on Diamond, Taxable = Gross ÷ 1.03 − discount, GST = 3% of Taxable, price = Taxable + GST |
| D2 | Excluded piece on the same draft | No discount on that line |
| D3 | Preview vs result | The stored rate matches the panel preview. `discount_applied` = the sum of line discounts |
| D4 | Add a piece after applying | Re-checked automatically. The new line is discounted correctly |
| D5 | Staff try a discount code on a loyalty draft | Refused: tag `discount-invalid: loyalty applied`. No discount written |
| D6 | A discount gets on anyway | Loyalty comes off. Tag `loyalty-invalid: removed, other discount`. Reason in the note |
| D7 | Remove loyalty | No Discount on Diamond left on any line. No loyalty record or `discount_applied` |
| D8 | Below-tier customer | Refused: tag `loyalty-invalid: below tier`. The note states the spend and the threshold |
| D9 | Tag length | Every tag ≤ 40 characters |

### F. Live: online cart (AUTO-LIVE, O1–O7)

| ID | Criterion | Expected |
|---|---|---|
| O1 | Security | A tampered storefront request is rejected (401) |
| O2 | Benefits, tier customer | Tier, today's rate and open vouchers returned |
| O3 | Benefits, logged out | "Log in" response |
| O4 | Apply on a cart (eligible + excluded piece) | A code exists in Shopify with: amount = diamond-only discount incl. GST, single use, expiry ≤ 2h, combines with order discounts only, eligible variant entitled, excluded variant not entitled |
| O5 | Same cart again | The same code comes back, not a new one |
| O6 | Below tier | Refused: "Spend ₹… more to unlock" |
| O7 | Vouchers | Every open voucher is set to combine with a loyalty code. If not, run `POST /api/loyalty/voucher-combos` |

### G. Live: earning without real orders (AUTO-LIVE, E1–E3)

| ID | Criterion | Expected |
|---|---|---|
| E1 | Code settles on an order (synthetic order, never sent to Shopify) | Redemption marked used. Phone mismatch flagged. Code deleted from Shopify. 100,000 points to the customer who asked for the code |
| E2 | Refund on that order, delivered twice | Points drop to 60,000. The duplicate changes nothing |
| E3 | Last 20 real orders (read only) | The earning rule reads every one without error. Points per order printed |

### H. Live: marketing (AUTO-LIVE, M1)

| ID | Criterion | Expected |
|---|---|---|
| M1 | Occasion sweep, dry run | Runs. Reports how many customers would gain or lose `loyalty-occasion-month` |

---

## 4. Manual criteria (screens and GoKwik)

Use the UAT customer at **tier 2**. To set it: `POST /api/loyalty/adjust` with `{"customerId": <id>, "points": <amount to reach ₹5L+>, "key": "uat-manual", "note": "UAT"}`. Reverse it afterwards with the same key and `points: 0`.

### U. Staff panel (in store)

| ID | Steps | Expected | Pass? |
|---|---|---|---|
| U1 | Make a draft for the UAT customer with a diamond piece → More actions → all-fields panel → Discounts | The "Loyalty" box shows the name, tier, lifetime spend, each piece with its saving, and the estimated total | |
| U2 | Click **Apply loyalty**, wait about 5 s | "Applied: Gold 5%…" appears. The line props show Discount on Diamond | |
| U3 | Try "Apply discount" in the same panel | Refused (`discount-invalid: loyalty applied`) | |
| U4 | Click **Remove loyalty** | Prices go back. The box offers Apply again | |
| U5 | Draft for a customer below tier | The box says how much more spend is needed. Apply is disabled | |
| U6 | Delete the draft | — (never convert a UAT draft) | |

### V. Customer profile (new customer accounts)

| ID | Steps | Expected | Pass? |
|---|---|---|---|
| V1 | Log in as the UAT customer → Profile | A "Timanti Loyalty" block shows the tier badge, the % off the diamond value, lifetime purchases, and the spend to the next tier | |
| V2 | Set the UAT customer below tier and reload | It reads "You are a Timanti member…" with no badge | |
| V3 | Check on a phone | Readable, no overflow | |

### W. Cart: "My benefits" block

| ID | Steps | Expected | Pass? |
|---|---|---|---|
| W1 | Logged out, add a diamond piece, open the cart | "Log in to see your loyalty benefit and vouchers" with a Log in button. After login it returns to the cart | |
| W2 | Logged in as tier 2 | "Gold member: 5% off the diamond value" with Apply. Any open vouchers are listed with value and expiry | |
| W3 | Apply loyalty | The cart reloads. The discount shows on the eligible piece only, and equals the panel / simulate figure | |
| W4 | Apply a voucher as well | Both codes on the cart. Totals reduce by both | |
| W5 | Type a promo code in the cart's own code box | Shopify refuses to combine it with loyalty | |
| W6 | Remove loyalty | The code is removed and the cart reloads | |
| W7 | Below-tier customer | "Spend ₹… more to unlock…". No Apply button | |
| W8 | Phone width | The block fits, buttons are tappable | |

### X. GoKwik (stop before paying)

| ID | Steps | Expected | Pass? |
|---|---|---|---|
| X1 | GoKwik dashboard | Its own coupon entry and offers list are switched off | |
| X2 | With loyalty + voucher on the cart, click Checkout | GoKwik shows both discounts, the same amounts as the cart, and no way to edit codes | |
| X3 | Log in to GoKwik with a **different** phone from the Shopify account | Discounts still shown. **Close the checkout without paying.** | |
| X4 | Wait 2 hours, or run `POST /api/loyalty/sweep` after the expiry | The unused LOY code is deleted from Shopify discounts | |

*The only part not covered without a real order:* GoKwik actually creating the paid order. That path is covered by E1 (settlement on a synthetic order with the same shape). Confirm it on the first live customer order with `GET /api/loyalty/redemptions`.

### Y. Backfill review

| ID | Steps | Expected | Pass? |
|---|---|---|---|
| Y1 | `POST /api/loyalty/backfill` (dry run), then `GET /api/loyalty/backfill?format=csv` | A CSV of every customer with orders, points and tier. Nothing written | |
| Y2 | Spot-check 5 known customers against their order history | Points = sum of paid orders minus refunds | |
| Y3 | Founder approves → `{"commit": true}` | The tiers appear on the customers. No emails sent | |

---

## 5. Useful checks while testing

- **Simulate any cart on any date without creating anything:** `POST /api/loyalty/simulate/cart`
  - body: `{ "lines": [{"variant_id": 123, "quantity": 1}], "customerId": 456 }`, or use `"profile": {"points": 600000, "birthday": "1990-03-14"}` in place of `customerId`;
  - add `"date": "2026-03-10"` to test birthday months.
- **What a real order earns (read only):** `POST /api/loyalty/simulate/order` with `{ "orderId": 789 }`. It shows the computed points beside the ledger row.
- **One customer:** `GET /api/loyalty/customer/<id>` shows the ledger rows, points and tier.
- **Review list:** `GET /api/loyalty/redemptions?mismatch=1` lists online orders whose GoKwik customer differs from the account that applied the code.

## 6. Sign-off

| Area | Result | Tested by | Date |
|---|---|---|---|
| Automated (A, B, C–H) | `tools/loyalty-uat.js` exit 0 | | |
| Staff panel (U) | | | |
| Customer profile (V) | | | |
| Cart (W) | | | |
| GoKwik (X) | | | |
| Backfill (Y) | | | |
