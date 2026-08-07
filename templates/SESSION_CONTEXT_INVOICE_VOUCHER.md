# Session Context — Tax Invoice + Voucher template work

**Date:** 2026-06-26
**Branch:** feat/metafield-manager-extension
**Files touched:** `templates/tax-invoice.liquid` (edited), `templates/voucher.liquid` (new)
**Status:** All edits done locally, **uncommitted + undeployed**.

---

## 1. `templates/tax-invoice.liquid` — changes made

Post-tax adjustments block (after "Total Invoice Price") now renders in this order, each as its own row, all subtract from a single running `final_payable`:

```
Total Invoice Price
Consideration against Gold...   (if og_value > 0)
Less: Exchange Note Adjustment  (if exc_value > 0)
Less: Voucher Adjustment        (if voucher_value > 0)
Less: Design Advance            (if design_advance > 0)   ← NEW
Credit Voucher Generated  + ₹X  (only if adjustments exceed invoice price)
Net Payable               ₹…    ← always last, after ALL adjustments
```

### Changes:
1. **Design Advance (NEW, 3rd post-tax adjustment)** — reads metafield
   `order.metafields.custom.design_advance` (decimal), fallback note-attribute
   `design_advance`. Renders "Less: Design Advance" and subtracts from `final_payable`.
   *(User adds the metafield + populate logic separately.)*
2. **Credit voucher on excess** — after all adjustments, if `final_payable < 0`:
   clamps Net Payable to **₹0** and emits a green "Credit Voucher Generated + ₹X" row
   for the excess. Handles multiple stacked adjustments (sum first, check once).
   Clamp propagates to Balance Due + amount-in-words (both show 0).
3. **Exchange row label** — "Less: Exchange Note Adjustment" with the `(code)` removed
   (user wanted code gone, label kept). Voucher row label left unchanged.
4. **Defunct Credit Note (CNTM) removed** — deleted the top `cn_applied`/`cn_amount`/
   `cn_code` detection block, the "Credit Note Applied" row, and `cn_applied` from the
   Net Payable guard. Replaced by the voucher adjustment which already existed.
5. **GST fix (was already in working copy before this session)** — intra/inter-state
   split now driven by supplier store state from `custom.state_code` (e.g. KA-HSR→KA,
   fallback KA) vs place-of-supply (shipping province), instead of hardcoded "KA".
   All three IGST/CGST/SGST rows always render. **Not yet deployed.**

### Metafield/tag confirmed: `custom.design_advance` (user corrected from custom_design.advance).

---

## 2. `templates/voucher.liquid` — NEW file (Order Printer Pro)

Rebrand of the old "Credit Note" printable into a **Voucher**. Source was the
credit-note Order Printer Pro template the user pasted.

### Changes from the credit-note original:
- Renamed everywhere → **Voucher**: `<h1>`, "Voucher No.", "Voucher Code",
  "Voucher Amount", footer "COMPUTER GENERATED VOUCHER", terms reworded.
- **Validity 365 days** (was 90) — box note, "Valid Until" default, Term 1.
- **Item table removed** + its SKU(s) detail row + unused table CSS.
- **`auracarat.com` stripped** from code note, checkout bar, Terms 2 & 5
  (Term 5 → www.timanti.in). Legal entity name "Auracarat Private Limited"
  kept at top / Term 8 / footer signatory.
- **Voucher code** still reads live from order tags `cn-num:` / `cn-val:` /
  `cn-exp:` / `cn-iss:` (what `services/exchange-cn/apps-script.js` actually
  writes, lines ~598-602). Falls back to `cn-issued:` tag.

---

## OPEN / TODO next session
- [ ] **Confirm voucher tags**: template reads `cn-num:` etc. If voucher system
      moves to `voucher-num:` tag names, repoint the reads in `voucher.liquid`.
- [ ] **Add `custom.design_advance` metafield** + populate logic (user owns this).
- [ ] **Deploy** tax-invoice.liquid (incl. GST fix) + register voucher.liquid in
      Order Printer Pro.
- [ ] E2E test: design advance row, credit-voucher-on-excess (adjustments > invoice).
