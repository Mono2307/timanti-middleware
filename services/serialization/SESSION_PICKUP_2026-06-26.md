# Serialization Restructure — Session Pickup (2026-06-26)

## What got done this session

1. **GST fix in `templates/tax-invoice.liquid`** — the CGST/SGST-vs-IGST split was hardcoded
   intra-state. Now driven by supplier store state (from `custom.state_code` metafield, e.g.
   `KA-HSR`→`KA`) vs place of supply (shipping province; no-ship falls back to intra-state).
   Place of Supply line + state-name map added. ⚠️ This file is entangled with a near-total
   parallel-session rewrite (see Git section).

2. **Serialization restructure — BUILT & verified, NOT yet deployed/migrated.**
   Full spec: `SERIALIZATION_MIGRATION_PLAN.md`. New scheme (Option A prefix, user-approved):

   | docType | serial | scope | resets/FY |
   |---------|--------|-------|-----------|
   | customer_order | `TM27-KA-HSR-0001` | store | yes |
   | customer_service (repair+CAD/design merged) | `TS27-KA-HSR-0001` | store | yes |
   | b2b (== inter-store transfer == sale) | `AURA-KA-HSR-0001` | store | no |
   | delivery_challan (was memo) | `DC-KA-HSR-0001` | store | no |
   | po | `PO-KA-HSR-00001` | store | no |
   | voucher | `VCH-27-0001` | global | yes |
   | exchange_note | `EXC-27-0001` | global | yes |

   - FY = 2-digit financial-year-END, IST (`fyEnd()` in index.js, exported). Verified boundaries.
   - FY folded into the counter key (`27|KA-HSR`, `27|ALL`) and ledger `store_code` → per-FY reset
     + uniqueness; bare store still goes to the `state_code` metafield.
   - Brand trimmed `TMNT→TM`/`TMRS→TS` to keep `KA-HSR`+FY inside the 16-char GST cap.
   - Removed doc types: `memo`, `transfer`, `repair`, `credit_note`.

## Files changed
- `services/serialization/index.js` — registry, `fyEnd`, padded formatter, FY-folded `allocateSerial`, `mintSerial` store_code.
- `server.js` — repair→`customer_service`; `make-challan`/`delivery_challan` + `make-transfer`/`b2b` + renamed cancel tags; delivery optional; exc-void cancels by full code; restamp/serial-report/backfill FY-aware; comments.
- `services/exchange-cn/apps-script.js` — uses middleware canonical `serial_code`; `fyEndIST_` fallback; void by full code; prompts. (deploys to Google)
- `services/reporting/apps-script.js` — doc-type help comment. (deploys to Google)
- NEW: `SERIALIZATION_MIGRATION_PLAN.md`, `migrate_reset.sql`, `SESSION_PICKUP_2026-06-26.md`; banner on `SERIALIZATION_FOR_FOUNDER.md`.

## Verification done
- `node --check` passes on server.js, index.js, both apps-scripts, po-ops.
- Format/FY unit exercise: all 7 serials correct length; IST FY boundary (Mar-31 18:30 UTC → 28) correct.
- NOT done: live E2E, the DB migration, deploy.

## Git situation (IMPORTANT)
- All work is UNCOMMITTED in the working tree on branch `feat/metafield-manager-extension`,
  which is ~15 commits ahead of `origin/main` (metafield-manager / old-gold / typeform / exchange).
- User wants ONLY serialization on `main` — do NOT merge this branch to main.
- Clean files (this session only): `server.js`, `services/serialization/index.js` + new docs/sql.
- Entangled (leave OUT of the main commit): `templates/tax-invoice.liquid` (parallel rewrite),
  `services/exchange-cn/apps-script.js` (1 non-serial hunk + Google deploy), `reporting/apps-script.js` (Google).
- Recommended: base a new branch on `origin/main`, apply just this session's diffs (see recipe in chat / below).

## To resume tomorrow
1. Commit serialization to a main-based branch + push (recipe below).
2. Run `migrate_reset.sql` in Supabase (prototype clean wipe; snapshots first).
3. Deploy middleware (flyctl) from the new branch / after merge to main.
4. Redeploy the two Apps Scripts to Google.
5. Update Shopify saved tag macros: `make-memo`→`make-challan`, `cancel-memo`→`cancel-challan`.
6. Retag test orders (clear serial metafields → re-fire order-serial), run E2E.

## Open follow-ups
- CAD/design has NO mint trigger yet (only `repair-complete` mints customer_service).
- `b2b` is voidable via `cancel-transfer` (unusual for a tax invoice) — confirm desired.
- `SERIAL_MEMO_TRANSFER` flag still gates challan/b2b (misnomer).
- Separate AURA B2B invoice template may be needed.

## Git recipe (run from repo root; uses an isolated worktree so the shared tree is untouched)
```bash
repo="$(pwd)"
git diff HEAD -- server.js services/serialization/index.js > /tmp/serial.patch
git worktree add /tmp/serial-wt origin/main
cd /tmp/serial-wt && git checkout -b serialization-fy-restructure
git apply /tmp/serial.patch        # if it rejects, inspect *.rej — likely the exc-void hunk
cp "$repo/services/serialization/SERIALIZATION_MIGRATION_PLAN.md" services/serialization/
cp "$repo/services/serialization/migrate_reset.sql"               services/serialization/
cp "$repo/services/serialization/SERIALIZATION_FOR_FOUNDER.md"    services/serialization/
git add -A && git commit -m "feat(serialization): FY-scoped restructure (TM/TS/AURA/DC + per-FY EXC/VCH)"
git push -u origin serialization-fy-restructure
cd "$repo" && git worktree remove /tmp/serial-wt
```
