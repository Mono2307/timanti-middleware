# Session context — Staff Catalog Lookbook

**Date:** 2026-09-05 → 2026-09-07
**Live:** https://timanti-middleware.fly.dev/lookbook (password gated)
**Commits:** `e0a2f10` → `b0f5ba0` → `6d9086b` → `44fbb85` (all on `main`)

A shop-floor lookbook: staff filter the catalog and present pieces to a customer on a device.
Collection view + PDP, styled to timanti.in, backed by a nightly snapshot with live prices.

---

## Where the code is

| File | Role |
|---|---|
| `src/core/auth.js` | Password → HMAC-signed cookie. **Fails closed**: unset secrets = 503, never an open page. |
| `src/modules/lookbook/routes.js` | 6 routes (below) |
| `src/modules/lookbook/snapshot.js` | Two-pass catalog walk, normalisation, facets |
| `src/modules/lookbook/store.js` | Snapshot cache (Supabase), rebuild cadence, pre-gzipped payload |
| `src/modules/lookbook/shopify-gql.js` | Throttle-aware GraphQL caller |
| `src/modules/lookbook/live.js` | Live price/stock for ≤100 variants |
| `src/modules/lookbook/page.js` | Both HTML pages (login + app), inline CSS/JS |
| `src/modules/lookbook/lookbook.test.js` | 42 assertions |

Routes: `GET /lookbook`, `POST /lookbook/login`, `POST /lookbook/logout`,
`GET /lookbook/catalog.json`, `GET /lookbook/live?ids=`, `POST /lookbook/refresh`.

`src/core/shopify.js` is deliberately **untouched** — the throttle-aware caller lives in the module
so the ~80 existing call sites are unaffected.

## Environment

`LOOKBOOK_PASSWORD`, `LOOKBOOK_SESSION_SECRET` (both required — 503 until set),
`LOOKBOOK_SESSION_DAYS` (30), `LOOKBOOK_REBUILD_HOURS` (default `14,19`).

**Not set yet: `ADMIN_API_SECRET`.** Setting it as a Fly secret *and* in the repo `.env` would let
`POST /lookbook/refresh` be triggered with `x-admin-secret` — i.e. production could be refreshed and
verified without a browser session. Much of this session's friction came from not having that.

## Cadence

- Catalog rebuild **14:00 and 19:00 IST**, an hour after each gold-rate reprice (13:00 / 18:00).
  Building *during* a reprice captures half-updated prices, and the breakup metafields live only in
  the snapshot, so a bad build shows a stale component table all day.
- **Plus on boot whenever `schemaVersion` changes** (see the trap below).
- Price and stock are re-read live per screen, batched — never from the snapshot.
- The page revalidates every 10 min and on tab focus (a counter device stays open all day).

---

## Traps found the hard way — do not re-learn these

**1. Adding a facet does nothing until a rebuild.** The filter bar renders only facets present in
the stored snapshot. Ship a new facet and it is silently absent — no error, no log — until 14:00.
This bit us in front of a customer. Fixed by `SCHEMA_VERSION` in `snapshot.js`: **bump it whenever
the snapshot's shape changes** and a deploy rebuilds on boot (serving the old snapshot meanwhile).

**2. `productVariants` ignores product status.** Unfiltered it walks the whole store — 19,434
variants to keep 10,184, ~70% archived. Now `query: "product_status:active OR product_status:draft"`.

**3. Price display must be gated per VARIANT, not per product.** Zero-weight variants are skipped by
the daily pricer and carry a stale hand-set price. `cheapest()` also prefers a *maintained* variant
so a piece never opens on an unpriced one.

**4. Don't retry a throttle that returned data.** An empty bucket alongside a 200 is not a failure;
retrying discards a page already paid for. Only retry an actual `THROTTLED` error; otherwise pace
before the *next* call.

**5. Absent ≠ zero.** `Number('')` is 0, so an unset metafield read as a real zero. A "Coloured
stones ₹0" row reads as a quoted component.

**6. Watch escape sequences when patching files with scripts.** `\bgzip\b` written through a JS
string literal became a **backspace character**, so the regex was `/⌫gzip⌫/` and gzip silently never
served — 9.25 MB instead of 497 KB. `grep`/`sed` render those bytes invisibly. `cat -A` found it.

---

## Real catalog facts (measured 2026-09-07)

- Store `auracarat.myshopify.com`, 611 products total, **487 active/draft**, 15,234 variants.
- **175 active products have NO photograph in Shopify** — verified three ways (no `media`, no
  `featuredImage`, no variant image). Confirmed visually in Admin. They are **shown last** with a
  "Photo coming soon" tile, never hidden. This is a merchandising gap, not a code issue.
- **Image alt text encodes the metal tone on every image**: `"White Gold-<product>_view=3DV"`.
  1049/1052 sampled carry it, 100% of those start with the colour. This is the storefront's own
  convention and is what drives colour switching — more reliable than `variant.image`, which only
  64% of variants have. **169 products have more than one colourway photographed.**
- `custom.category` exists (299/300) but **`productType` is the category of record** (user's call).
- `custom.sub_category` 298/300, 30 values — facet chips carry a `parent` so they narrow by category.
- `custom.stone_cut` is a JSON list: `["Round","Cushion"]`. Round(236) Pear(54) Marquise(25).
- `custom.cst_weight` / `cst_count` only on ~93/300 (solitaires). `custom.cst_cut` is empty on all —
  ignore it.
- Variant subtotal lives in **`custom.price_subtotal`**, not `price_breakup_subtotal` (which is
  declared but null). Do not "fix" this.
- Tone codes include **`PG`** (pink gold) — not just `P`/`RG`. Two thirds of the catalog.

## Performance

- Payload pre-gzipped once at build: **9,253,074 → 497,459 bytes (94.6%)**.
- Page sizes 100/100 (measured cost 173 and 164 against a 1000-point ceiling). Build 497s → 241s.
- `srcset` 320/520/800 + `sizes`, first row eager, rest lazy, `preconnect` to cdn.shopify.com.

---

## Open / not done

- **Unverified:** whether the schema-triggered rebuild on `44fbb85` actually produced the new
  facets in production. Inferred from uptime, not confirmed — `catalog.json` is password-gated.
- The natural-language search feature (the original `/claude-api` thread) was never built.
- Fable 5.1 design review never ran — no Anthropic credentials on this machine.
- `_cache/` in the scratchpad holds a local snapshot; production uses Supabase.
