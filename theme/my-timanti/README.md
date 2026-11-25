# My Timanti page and referral session (theme code)

Source of truth for the theme changes that go with the referral programme online
(`docs/Referral-Online-PRD.md`, server in `src/modules/loyalty/referral.js`). The live theme is
`auracarat/main`; these files were built on the unpublished copy
**"My Timanti + referral (build 25-11-2026)"** (theme id 166697074945), committed 26 Nov 2026.

Preview: `https://timanti.in/pages/my-timanti?preview_theme_id=166697074945`

## New files (copy as-is)

| File | What it does |
|---|---|
| `templates/page.my-timanti.json` | Page template for the Shopify page `my-timanti` (created 26 Nov, template suffix `my-timanti`). |
| `sections/main-my-timanti.liquid` | The page. Logged out: a Log in button to `routes.account_login_url`, which the KwikPass embed intercepts (same as the cart drawer). Logged in: loyalty tier and progress, referral link with Copy and WhatsApp, rewards ready, recent orders (Liquid `customer.orders`), vouchers, after-sales placeholder, links to Shopify's hosted Orders and Profile pages. Loyalty and referral data come from the app proxy `/apps/loyalty/benefits` and `/apps/loyalty/referral`. |
| `snippets/referral-session.liquid` | The 14-day referral session. `?ref=CODE` on any URL starts it (and a new link restarts it). The code is kept on the cart as `_referral` + `_referral_at` and removed when the session ends; when logged in it also POSTs `/apps/loyalty/referral/claim {code, at}` once per session. |

## Edits to existing theme files

1. `layout/theme.liquid`: `{%- render 'referral-session' -%}` added on the line before `</body>`.
2. `sections/header.liquid` (about line 261) and `snippets/header-drawer.liquid` (about line 192): the account
   link's logged-in target changed from `{{ routes.account_url }}` to `/pages/my-timanti`. Logged out it is
   unchanged (`routes.account_login_url`, intercepted by KwikPass).
3. `snippets/cart-drawer.liquid`, `renderBenefits()` (about line 1650): the tier block now also shows a ready
   referral reward. With a tier: an orange second line "Referral reward ready · 10% off diamonds. The larger of
   the two applies." With no tier but a reward: the reward line and the Apply button. The server's `/apply`
   already gives whichever saves more, so there is still one Apply.

The replaced `renderBenefits()` tier block, for reference:

```js
        var ref = b.referral && b.referral.available > 0 ? b.referral : null;
        var applyBtn = '<button type="button" class="lb__btn" data-lb-loyalty-apply' + (loyApplied ? ' disabled' : '') + '>' + (loyApplied ? 'Applied' : 'Apply') + '</button>';
        var refText = ref ? 'Referral reward ready · ' + esc(ref.pct) + '% off diamonds' + (ref.available > 1 ? ' (' + esc(ref.available) + ' ready)' : '') : '';
        if (b.tier) {
          var bonus = (b.occasion && b.occasion.length) ? ' (' + esc(b.occasion.join(' + ')) + ' bonus)' : '';
          this.showTier('<span class="lb__tier-text cart-drawer__price-breakdown-label">' + esc(b.tier.name) + ' member · ' + esc(b.rate) + '% off diamonds' + bonus
            + (ref ? '<br><span style="color:#fc7d27">' + refText + '. The larger of the two applies.</span>' : '') + '</span>' + applyBtn);
        } else if (ref) {
          this.showTier('<span class="lb__tier-text cart-drawer__price-breakdown-label">' + refText + '</span>' + applyBtn);
        } else if (b.next) {
          /* unchanged: lifetime spend and the gap to the next tier */
        }
```

## Going live

Publishing the copy replaces the live theme. If `auracarat/main` is synced from GitHub, apply these same files
and edits in that repo instead, or the next sync undoes them.
