# Loyalty Program, Plan A: build it into our own middleware

*Status: planning only, nothing built. Last updated 2026-10-07.*

## Program
- **Points:** ₹1 = 1 point, counted on **lifetime spend net of refunds, including all past orders**. Points only measure spend toward a tier; they are never spent.
- **Points are recorded only when an order is created.** That covers online orders, and draft orders when they convert. Installment entries logged on a draft earn nothing.
- **Tiers** (editable):

  | Tier | Lifetime spend | Off the diamond value | Birthday or anniversary month |
  |---|---|---|---|
  | T1 | ₹2L | 3% | +2% |
  | T2 | ₹5L | 5% | +2% |
  | T3 | ₹10L | 7% | +2% |

  - The birthday and anniversary bonuses don't add together. If both fall in the same month, the customer gets +2% once.
  - The dates come from customer metafields `custom.birthday` and `custom.anniversary`, written by the Typeform webhook.
- **What the discount applies to:**
  - The **diamond component of each line only**, never gold, making or gemstone, and never the order total.
  - Products are included or excluded by SKU and attribute rules.
- **Stacking:**
  - Loyalty can be combined with **vouchers and exchange notes**.
  - Nothing else can be combined with loyalty.
- **Where the tier shows:** the customer's account page (new customer accounts), and to staff in the panel and on the admin customer page.
- **Marketing:** triggered by tier changes and by the birthday and anniversary months.

## What already exists and is reused
- **`resolveLineDiscount`** (`server.js:1455`): per-line `{t:'dia', m:'pct'}` discount entries, capped at the diamond value and applied before GST.
- **The tag-triggered draft step chain** `runDraftUpdateHandlers` (`server.js:3453`) and the reprice through line-item properties.
- **The VCH voucher pattern:** single-use Shopify codes, frozen at order time (`freezeOnlineVoucher`, `src/modules/serialization/routes.js:147`).
- **The staff panel's "Apply an Adjustment" pattern**, such as Redeem a Design Advance (`apps/metafield-manager/.../MetafieldManager.jsx`).
- **Typeform:** it already captures birthday and anniversary.

## 1. Data model
- **Supabase `loyalty_ledger`:** the source of truth.
  - One row per event: customer_id, order_id/name, kind (`earn` | `reverse` | `backfill` | `adjust`), points, channel, created_at.
  - Unique on (order_id, kind), so the same order can never be counted twice.
- **Supabase `loyalty_redemptions`:** order/draft, customer, tier, rate, occasion flag, diamond base, rupee discount, channel, code, status.
- **Customer metafields** (a copy of the ledger, rewritten on every change):
  - `loyalty.points`, `loyalty.tier`, `loyalty.tier_since`, `loyalty.next_tier_gap`, `loyalty.discount_pct`
  - `loyalty.available_codes`: a JSON list of the customer's open vouchers and exchange notes, for the cart block.
- **Customer tags:** `loyalty-T1`, `loyalty-T2`, `loyalty-T3`, `loyalty-occasion-month`. These are what segments and Shopify Flow use.

## 2. Configuration (changed without a deploy)
The config is the shop metafield `loyalty.program_config` (JSON), edited in Shopify admin → Settings → Custom data. It is validated, cached for 5 minutes, and falls back to the last good copy if an edit breaks it.
```json
{ "enabled": true,
  "tiers": [{"key":"T1","name":"…","min":200000,"pct":3},
            {"key":"T2","name":"…","min":500000,"pct":5},
            {"key":"T3","name":"…","min":1000000,"pct":7}],
  "birthday": {"pct":2,"window":"month"}, "anniversary": {"pct":2,"window":"month"},
  "occasion_bonus_stacks": false,
  "eligibility": {"include": {"product_types":[], "tags":[], "collections":[]},
                  "exclude": {"skus":["SCOIN"], "tags":["no-loyalty"], "jewel_code_prefixes":[]},
                  "require_diamond_value": true},
  "stacking": {"allow_vouchers": true, "allow_exchange_notes": true, "allow_other_discounts": false} }
```

## 3. Shared engine (`src/modules/loyalty/engine.js`)
- **`tierFor(points, cfg)`**: the tier for a lifetime points total.
- **`occasionBonus(customer, date, cfg)`**: the birthday or anniversary bonus, using IST dates.
- **`eligibleLines(lines, cfg)`**:
  - applies the include and exclude rules;
  - drops exchange-note lines and negative "discount" lines (`isExcLine`);
  - drops lines with no diamond value.
- **`computeLoyalty(customer, lines, cfg)`** returns `{tier, rate, occasion, perLine:[{idx, diamond, rupees}], total}`.

The same function is used online and in-store, so the two always give the same numbers.

## 4. Earning and backfill
- **Earning:**
  - Triggered by order creation, through the existing `orders/create` webhook (`/api/serial/order-serial`), which also covers drafts when they convert.
  - The order value is recorded as an `earn` row; a refund adds a `reverse` row.
  - Then the customer's points and tier are recomputed, and the metafields and tags rewritten.
- **Backfill:**
  - `tools/loyalty-backfill.js` does a dry run over all historical orders with the same rule, net of refunds.
  - It produces a CSV for the founder's review.
  - It writes `backfill` rows only after approval.

## 5. In-store redemption (draft orders)
- **Panel:** a new "Loyalty Benefit" option under "Apply an Adjustment", in all four `MetafieldManager.jsx` copies.
  - It calls `GET /api/loyalty/draft-preview?draft=`, authenticated with the session token (the same pattern as `/api/repairs/order-items`).
  - The preview shows the tier, rate, occasion bonus, eligible lines and estimated saving.
  - **Apply** adds the tag `apply-loyalty`; **Remove** adds `remove-loyalty`.
- **Server step `apply-loyalty`** (next to `apply-discount`, before `sync-net`). It:
  - checks the draft has a customer and the customer has reached a tier; otherwise it adds `loyalty-invalid: <reason>`;
  - rejects the draft if another discount is already on it (`discount_rate`, `discount_code`, or non-loyalty `line_discounts`);
  - writes `{t:'dia', m:'pct', v:rate, src:'loyalty'}` into `custom.line_discounts` for eligible product lines;
  - sets `custom.loyalty_applied` and adds the `reprice` tag.

  `resolveLineDiscount` then works out the diamond-only discount before GST, and the invoice props (`Discount on Diamond`, `Taxable Value`, `GST`) fill in as they do today.
- **Live repricing:**
  - The entries are percentages, so when staff edit the Diamond prop, the reprice stays correct.
  - If the line set changes and `wipeStalePositionalPricing` clears the entries, the step puts them back because `loyalty_applied` is set.
- **Guards:**
  - `handleApplyDiscountTag` refuses `apply-discount:*` while loyalty is applied.
  - Vouchers and exchange notes are unaffected: they are deducted after tax, as today.
- **On conversion:** a `loyalty_redemptions` row is written, and the order then earns points.

## 6. Online redemption (cart → GoKwik)
**Rule:** all codes are applied at the cart. GoKwik's own code entry is turned off, it only reads the cart's codes, and it does not allow cart edits.

- **The "My benefits" cart block** (theme app extension, Liquid and JS):
  - **Logged out:** "Log in to see your benefits", which goes to the Shopify customer-account login and back to the cart.
  - **Logged in:** everything the customer can use, each with Apply and Remove:
    - Loyalty: "Gold member: 5% off diamond value (+2% birthday month)". It is hidden below tier.
    - Open vouchers and exchange notes, from `loyalty.available_codes`: code, value and expiry.
  - The free-text code box stays.
  - At most one loyalty code plus one voucher or exchange-note code can be applied.
- **Applying loyalty:** the block calls the app proxy `POST /apps/loyalty/apply`. Shopify signs the request and passes `logged_in_customer_id`. The middleware then:
  - verifies the signature;
  - runs `computeLoyalty` on the cart lines (diamond from `custom.price_breakup_diamond`, × 1.03 because prices include tax);
  - creates a `LOY-<random>` code:
    - fixed amount, limited to the eligible products;
    - single use, expires in 2 hours;
    - no customer restriction (because GoKwik's phone login may map to a different customer);
    - product class, set to combine with order discounts;
  - records a pending redemption row keyed by the code, with the requesting customer.
- **Codes in the cart:** the block writes the codes comma-separated (`/cart/update.js` `discount: 'LOY-…,VCH…'`). Shopify allows several codes on a cart.
- **Stacking rules in Shopify:**
  - VCH and exchange-note codes are order class and set to combine with product discounts. This needs a change to the issuing Apps Script plus a one-time update of open codes.
  - Promo codes don't combine, so Shopify refuses a promo code alongside LOY.
- **When the order arrives** (`freezeOnlineVoucher`-style):
  - recognise `LOY-` codes;
  - credit the customer **who requested the code**, and flag a mismatch with `order.customer` for staff review;
  - check the amount against `computeLoyalty`;
  - mark the code used and delete it.
- **Cleanup:** a sweep deletes unused expired `LOY-` codes.

## 7. Customer account page
A customer-account UI extension (`customer-account.profile.block.render`) shows:
- the tier;
- lifetime spend and the gap to the next tier;
- the current diamond discount;
- the active birthday or anniversary bonus.

## 8. Marketing
- **Tier change:**
  - rewrite the tags and metafields;
  - send a Resend email (the existing `sendEmail` function);
  - the tag lets Shopify Flow start Shopify Email or WhatsApp-app sequences.
- **Daily IST sweep:** sets and clears `loyalty-occasion-month` for segments and Flow ("your extra 2% is live this month").

## GoKwik checks (before online goes live)
1. A LOY code and a VCH code applied on the cart both reach the Shopify order intact.
2. A phone mismatch at GoKwik still credits the customer who requested the code, and the mismatch is flagged.
3. A promo code plus a LOY code on the cart is refused by Shopify.

## Rollout
1. Engine, config, ledger and metafield definitions, then the dry-run backfill for founder review.
2. Write the backfill and turn on earning, so tiers become visible.
3. In-store redemption in the panel, then deploy the app (`npx @shopify/cli app deploy -c timanti-metafield-manager-new`).
4. GoKwik checks, then the cart block and app proxy.
5. Marketing tags, the sweep and the Flow templates.

## Files touched
- **New:**
  - `src/modules/loyalty/{engine,config,ledger,routes,sweep}.js`
  - `tools/loyalty-backfill.js`
  - `tools/loyalty-engine.test.js` (added to the `package.json` test list)
  - Supabase migration
- **`server.js`:**
  - `apply-loyalty` step
  - guard in `handleApplyDiscountTag`
  - conversion hook
  - module mount (about line 4831)
- **`src/modules/serialization/routes.js`:** earning, and recording LOY codes when orders arrive.
- **`apps/metafield-manager/`:**
  - the panel section, in all four copies
  - theme app extension (cart block)
  - customer-account extension
  - app proxy
  - `read_customers` scope
- **`services/exchange-cn/apps-script-issue-voucher.gs.txt`:** the combination setting on voucher codes.
- **Route gate:** `tools/baseline-routes.txt` (`node tools/route-inventory.js --write`) and the `MODULES` list in `tools/module-contract.test.js`.

## Testing
- **`npm run verify`**, including engine unit tests for:
  - tier boundaries
  - occasion month across month and year ends in IST
  - exclusions
  - the diamond cap
  - refusal when another discount is present
- **In-store test:**
  - The Diamond discount equals rate × Diamond for each eligible line; Gold and Making are untouched; GST is on the reduced value.
  - Editing the Diamond prop keeps it correct.
  - `apply-discount` is refused.
  - Adding a line restores the entries.
- **Online test:**
  - Login, then the cart block, then LOY + VCH on the cart, then GoKwik, then the order has both codes, then a redemption row is written and the code deleted.
  - A customer below tier is refused.
- **Earning test:** creating an order raises points and tier, and the account block updates. A refund lowers them.
