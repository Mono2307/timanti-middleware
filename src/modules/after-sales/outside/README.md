# Outside-jewellery repairs (campaign)

The repair flow normally takes only pieces Timanti sold. This campaign also takes **outside pieces**
(not sold by Timanti) and runs them through the **same** draft-order repair flow: the same tags,
emails, estimate and payment, Mark Complete, TS serial and printed repair note. The difference is where
the "as received" specs come from. For a Timanti repair they are copied off the original order. For an
outside piece the counter records them at inspection, in a separate intake form.

This file holds the history, decisions and open items. Read it before changing anything here.

---

## 1. Decisions (founder, Oct 2026)

| Topic | Decision |
|---|---|
| Where intake is captured | A **separate button-launched admin action** ("Outside repair intake" under *More actions* on a draft). **Not** in the Metafield Manager scroll ("the meta field manager app is becoming very large and bloated"). |
| Photos | Uploaded from the form into **Shopify Files**; the CDN URL goes on the line. |
| Estimate | **Itemised breakdown** (labour / stones / metal added g × rate / other); total = sum. |
| Terms customer accepts | 4 clauses: stones uncertified; pre-existing damage; metal test result accepted; collection within 30 days. |
| Metafields | **No new pinned metafields.** Order Printer only sees the top 10 pinned ones, so printable data goes on **line-item props + tags**. One *unpinned* JSON metafield (`custom.repair_inspection`) keeps the full audit record. |
| Weights | **Before and after are critical.** There is **no "tolerance"**: every gram of change is accounted for by cause (metal added/removed, polish loss, solder, stones). |
| Collection | **30 days** from the ready email. After that, ship to the address on file **at the customer's cost** ("shipping is always borne by the party"); with no address, a late fee accrues. |
| Late fee | **Not defined yet.** Placeholder `[LATE FEE: TBD]` (`LATE_FEE_TEXT` in specs.js). |
| Serial | All repairs share the **TS** serial (FS for free). No change. |
| GST | **18%**, same as Timanti repairs. |
| Value limit | **None.** Store staff can accept goods of any value; no HQ approval. |
| Accept/refuse | Judged at the store (examples in section 5). |
| **Printed repair note** | **No template change whatsoever.** An outside piece prints exactly the same fields as a Timanti repair (before/after gross, net, dia, gem, metal). Note Number = TS serial (`serial_display`). Original Invoice Reference = "—". The order number appears in Shopify once the draft is converted. Any template work is deferred to the very end, done locally, and the exact hunks are shown for approval first. |

Rejected along the way (don't re-propose):
- Many new metafields (blocked by the 10-pinned cap).
- The form in the MFM.
- A weight tolerance.
- Outside-only rows, terms or header labels on the repair note. A proposed diff was rejected on 2026-10-24: "What are you even adding?"

---

## 2. Data model

| What | Stored as |
|---|---|
| Outside piece | tag `repair-outside` |
| Campaign | tag `camp:<code>` (≤40 chars, slugged) |
| Paid / free | existing `repair-intake` / `free-repair` (added only if neither is present) |
| Intake incomplete (someone tagged by hand) | tag `repair-missing-inspection` (the webhook holds the draft and emails the store) |
| Full inspection record (audit, never printed) | metafield `custom.repair_inspection` (json) |
| Intake gross weight | existing metafield `custom.repair_intake_gross_weight` and prop `_intake_gross_wt` |
| Description | prop `_item_title` |
| Item ID | prop `_sku` = `OUTSIDE` (there is no design ID) |
| Metal as tested | prop `_variant_title` (e.g. "22K YG") + `_metal_test` (method + reading) |
| Hallmark/HUID | `_hallmark` (default "None") |
| Stones as declared | `_diamond_pcs`, `_diamond_cts`, `_gemstone_cts` (existing keys) + `_stones_note` |
| Condition / work requested | `_condition`, `_work` |
| Photo | `_image_url` (more photos live in the JSON) |
| Terms accepted | `_terms_ok` = timestamp |
| Estimate breakdown | `_cost_lines` = `label|amount~||~label|amount` |
| After repair | existing `_post_gross_wt`, `_post_net_wt`, `_post_dia_cts`, `_post_gem_cts` + metafields |
| Weight accounting | `_wt_reconcile`, e.g. `In 18.40 g | +0.30 g metal added | −0.03 g polish loss | Out 18.67 g` |

Because outside pieces use the **same prop keys** as Timanti repairs, the unchanged repair-note
template prints them correctly (checked with LiquidJS on 2026-10-24).

---

## 3. Code map

**This folder** (`src/modules/after-sales/outside/`):
- `specs.js`: pure rules and constants: `OUTSIDE_TERMS`, `COLLECTION_DAYS`, `WEIGHT_CAUSES`, `validateInspection`,
  `buildOutsideProps`, `missingFromProps`, cost-line format/parse/total, `reconcileWeight` / `formatReconcile`.
- `routes.js`: `POST /api/repairs/outside-intake` (staff session token). It validates, writes the JSON and intake-weight
  metafields, then makes ONE PUT with props + tags (tags go last, so the webhook sees complete data).
  It returns 409 if the draft is completed or is a Timanti repair. `POST /api/repairs/photo` takes a raw `image/*`
  body (≤15 MB), uploads it to Shopify Files (stagedUploadsCreate → POST → fileCreate → poll) and returns `{url}`.
- `forms.js`: the Set Estimate breakdown block and the Mark Complete weight-accounting block (+ parsers).
- `emails.js`: extra HTML for the received / estimate / ready / HQ emails. It returns '' for non-outside drafts.
- `outside.test.js`: 48 assertions, run by `npm test`.

**Hook-ins elsewhere (kept minimal):**
- `src/modules/after-sales/index.js`:
  - `resolveRepairSpecs()` reads props for outside pieces and copies from the order otherwise. It is used in
    reconcile, resync, the intake gate and the free trigger.
  - The outside intake gate (`repair-missing-inspection`).
  - The email extras.
  - The Set Estimate GET/POST breakdown.
  - The Mark Complete GET/POST weight accounting (outside only; post gross weight mandatory).
  - `require('./outside/routes').register(app)`.
- `src/integrations/email/templates.js`: optional `extraHtml` / `breakdown` params on the received, estimate and ready
  builders; exports `h3`, `termsSection`.
- `server.js`: the global `express.text` parser **skips `image/*`**. Without that, photo uploads got HTTP 413
  (fixed in a3c3289).
- `tools/baseline-routes.txt`: has the two new routes.
- Intake form: `apps/metafield-manager/extensions/outside-repair-intake/` (`src/OutsideRepairIntake.jsx`). It is a
  4-step Preact/Polaris form (Piece → Stones & condition → Work → Terms & submit) with photo drop zone and thumbnails.
  Deploy: `npx @shopify/cli app deploy -c timanti-metafield-manager-new`.

---

## 4. How an outside repair runs (workflow note)

★ = new for outside pieces. Everything else is today's flow, unchanged.

| # | Stage | Who | Action | System | Customer hears |
|---|---|---|---|---|---|
| 1 | ★ Accept? | Counter | Check: precious metal, testable, safe to work, within workshop skills (any value) | none | none |
| 2 | Open job | Counter | Create draft: customer (new → create profile), custom line "repair" | none | none |
| 3 | ★ Inspect | Counter | *More actions → Outside repair intake*: weigh, test metal, photograph, stones/condition/work, read terms, tick accepted, Submit | props + JSON + intake weight, then tags | none |
| 4 | Intake | auto | existing trigger | internal mail with Set Estimate link; `repair-hq-notified` | "We've received your jewellery" + photo, ★ specs as inspected, ★ terms + collection rule |
| 5 | Assessment | HQ | Set Estimate: amount (★ optional breakdown) or Free | `repair-estimate-ready` | Estimate email (★ breakdown rows) / complimentary |
| 6 | Approve/pay | Customer | Pay online or approve at store | `repair-paid` / `repair-store-approved` | Payment confirmed |
| 7 | Repair | Workshop | Do the work | none | none |
| 8 | Complete | HQ | Mark Complete: final cost, ★ mandatory post gross wt + account for the change by cause | `_post_*`, `_wt_reconcile`, `repair-complete` | Ready email (★ weight record, ★ collect within 30 days) |
| 9 | Serial | auto | none | TS (paid) / FS (free) | none |
| 10 | Handover | Counter | Print the repair note (unchanged template), customer signs, settle the balance | none | none |
| 11 | ★ Collection window | Counter | 30 days from the ready email | (later: reminders at day 20/30) | none |
| 12 | ★ Day 30+ | Counter | Ship to the address on file at the customer's cost; no address → late fee `[LATE FEE: TBD]` | (later: tag `repair-overdue`) | Dispatch / late-fee notice |

Only steps 1, 3 and 8 change for staff. There's no order number to enter and no piece to pick.

## 5. Refusal examples (judged at the store)
- Not precious metal: plated, filled or costume; the metal test fails or is inconclusive.
- Too fragile or worn to work on safely: thin or cracked shanks, brittle old solder, enamel or antique work we can't guarantee.
- Stones at risk (emerald, opal, pearl or coral near heat) where the customer won't accept the risk in writing.
- Work we don't do: re-casting, engraving, watch work, or a redesign rather than a repair.
- Doubtful provenance: no ID or contact given, or the piece looks tampered with or not theirs.
- The customer won't accept the four terms.

---

## 6. Status and open items (as of 2026-11-06)

Done and pushed to `main` (deployed by the founder): middleware, emails, estimate breakdown, Mark Complete
weight accounting, intake extension, and the 413 photo-upload fix.

Open:
- [ ] **Photo upload after the deploy is unconfirmed.** If it fails with a scope error, the app token needs `write_files`.
- [ ] **App deploy** of the extension's thumbnail change (if not done).
- [ ] **Estimate breakdown is offered on ALL repairs**, not just outside pieces (forms.js block in Set Estimate, index.js ~1297).
      Not yet decided whether to make it outside-only (a one-line gate).
- [ ] Late fee amount (replace `LATE_FEE_TEXT`).
- [ ] Later: day-20/day-30 collection reminders, `repair-overdue` tag.
- [ ] End-to-end test with `REPAIR_TEST_EMAIL`: steps 2–10 on a test draft + a regression run on a Timanti repair.
- [ ] Counter SOP for staff (photo standard: front, back, damage close-up, on the scale; terms script; profile + loyalty enrolment).
- [ ] Repair-note template: **no change planned**. Revisit only at the very end, locally, with hunk approval.

## 7. Gotchas met during the build
- The global text parser in `server.js` ate image bodies (100 KB limit) → 413. Keep the `image/*` skip.
- A patch script lost a backslash (`/^image\//` became `/^image//`), which broke every non-JSON body. Prefer `startsWith`.
- New files under `src/modules` must not read `process.env`; use `core/config` (module-contract ratchet).
- New routes must be added to `tools/baseline-routes.txt` (`node tools/route-inventory.js --check`).
- The installed Order Printer template can drift from `templates/repair-note.liquid`.

Original planning and build session transcript (full context):
`C:\Users\monod\.claude\projects\C--Users-monod-OneDrive-Desktop-Claude-Projects-timanti-middleware-src\c2944d26-c4e0-4117-bf48-3a11dd2dcc7a.jsonl`
Plan file: `C:\Users\monod\.claude\plans\pasted-content-id-72b8-the-current-logical-waterfall.md`
