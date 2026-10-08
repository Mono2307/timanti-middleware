# Loyalty (Plan A): go-live runbook

The code is on `main`, but it stays switched off until `LOYALTY_ENABLED=true` is set. Do the steps below in order. The operator endpoints take the admin secret as the `x-admin-secret` header (or as `?secret=`).

## 1. Database
Run `src/modules/loyalty/migration.sql` in the Supabase SQL editor. It creates `loyalty_ledger` and `loyalty_redemptions`, and it is safe to run more than once.

## 2. Deploy the middleware and switch it on
1. Deploy `main` to Fly (Actions → `deploy.yml`).
2. Set the Fly secret `LOYALTY_ENABLED=true`.
3. Check that `MFM_CLIENT_SECRET` is set. It already serves the repair picker. The staff panel and the storefront proxy both verify against it.

## 3. Shopify setup (once)
- `POST /api/loyalty/setup`:
  - Creates the customer metafield definitions `loyalty.*`. They are readable by the storefront and by customer accounts, and pinned on the admin customer page.
  - Seeds the shop metafield `loyalty.program_config` with the founder's grid. It never overwrites an edited copy.
- **Edit tier names and rules** in Shopify admin → Settings → Custom data → Shop → `loyalty.program_config`.
  - The defaults are Silver ₹2L 3%, Gold ₹5L 5% and Platinum ₹10L 7%, plus 2% in the birthday or anniversary month. The bonus applies once even if both fall in the same month.
  - The gold coin (`SCOIN`) and the `no-loyalty` product tag are excluded.
  - The tier names are placeholders. Rename them here.
  - Changes take effect within 5 minutes.
- **Middleware token scopes:** the token needs `read_customers`, `write_customers` and `write_discounts`.
  - The discount scope is needed to create one-time codes and update voucher combinations.
  - If a call fails with an access error, add the scope to the middleware's app.

## 4. Backfill lifetime spend (founder review first)
1. `POST /api/loyalty/backfill`: starts a **dry run**, which writes nothing.
2. `GET /api/loyalty/backfill`: shows progress. Once it is finished, `GET /api/loyalty/backfill?format=csv` returns the CSV of customers, points and tiers for review.
3. Once the founder approves: `POST /api/loyalty/backfill` with body `{"commit": true}`.
   - This writes the ledger and publishes each customer's tier as metafields and `loyalty-T*` tags.
   - It sends no emails.

From this point every new order earns points automatically when it is created. Refunds reduce the points.

## 5. Staff panel, account page and cart block
1. `npx @shopify/cli app deploy -c timanti-metafield-manager-new`. This ships:
   - the panel's new **Loyalty** box (Draft → More actions → the all-fields panel → Discounts);
   - the customer-account **Loyalty tier** block;
   - the **My benefits** theme block;
   - the app proxy `/apps/loyalty/*`.
2. Shopify admin → Settings → Customer accounts → Customize: add the "Loyalty tier" block to the Profile page.
3. Online Store → Themes → Customize → Cart: add the "My benefits" app block above the checkout button.

## 6. Let vouchers sit beside loyalty on the cart
Run `POST /api/loyalty/voucher-combos` once. It sets every open voucher code to combine with product discounts. Vouchers issued from now on get this setting automatically.

## 7. GoKwik checks (before announcing online)
1. In GoKwik, turn off its own coupon entry and its offers list. It must only carry the cart's codes.
2. Logged-in tier customer → My benefits → Apply → GoKwik checkout. The Shopify order should carry `LOY-…` and show the diamond-only amount.
3. Do the same with a voucher applied too. The order should carry both codes.
4. A promo code plus loyalty on the cart: Shopify should refuse the pair.
5. Check with a GoKwik phone number that differs from the Shopify account. `GET /api/loyalty/redemptions?mismatch=1` should list the order, and the points should go to the account that applied the code.

## 8. Marketing
- **Tier tags:** `loyalty-T1`, `loyalty-T2` and `loyalty-T3` are kept current on every customer, for segments and Shopify Flow.
- **Occasion tag:** `loyalty-occasion-month` is on during a customer's birthday or anniversary month. It is refreshed by a daily sweep, which can be triggered with `POST /api/loyalty/sweep`.
- **Tier-upgrade email:** off by default. Set `"emails": {"tier_change": true}` in the config to send it.

## Day to day
- **In store:** open the draft → All fields → Discounts → **Loyalty** → *Apply loyalty*.
  - Loyalty blocks every other discount code and per-line discount. Vouchers, exchange notes, old gold and advances still apply.
  - Adding or removing pieces re-checks the draft automatically.
  - If another discount is added, loyalty comes off and the panel says why.
- **To look up a customer:** `GET /api/loyalty/customer/<id>`.
- **To correct points by hand:** `POST /api/loyalty/adjust` with `{customerId, points, note, key}`.
