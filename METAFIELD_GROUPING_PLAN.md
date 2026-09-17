# Draft Metafield Grouping — Metafields Guru Plan

_Goal: staff can tell at a glance which draft-order metafields they FILL vs which the system
AUTO-populates. Native Shopify gives no visual grouping in the order editor; Metafields Guru groups
by namespace, so we encode ownership in the namespace and let Guru render the groups._

## The principle
Namespace = ownership. Two buckets:
- `intake`  → staff fill (the only things a human touches)
- `custom`  → system / auto-populated (serial, adjustments, payment_state, exchange_* …)

Guru lists metafields grouped by namespace, so on any draft staff see an **`intake` group** (fill these)
separate from the **`custom` group** (ignore — system).

## Steps

1. **Install Metafields Guru** from the Shopify App Store. Grant it access to Orders / Draft Orders.

2. **Decide the two namespaces** and which existing fields move where (use the classification table):
   - `intake.channel`, `intake.stock_type`, `intake.store` — staff fill.
   - everything auto (`custom.exchange_note_post_tax`, `custom.serial_*`, `custom.amount_*`, …) — leave in `custom`.

3. **Create/relocate definitions in Guru** → *Settings → Metafield definitions* (or the Guru definitions
   panel). For each FILL field, create the definition under the `intake` namespace.
   > Namespace is part of a definition's identity — moving a field to a new namespace is a **new
   > definition**; migrate existing values with Guru's bulk editor / import-export before retiring the old one.

4. **Order + label the FILL fields** so the intake group reads as a checklist: prefix display names
   (`1 · Channel`, `2 · Stock Type`, `3 · Store`) and set their order in the definition list.

5. **Open a draft in Guru's metafield editor.** Confirm fields render grouped by namespace — the
   `intake` group is the fill surface; `custom` is the system group below it.

6. **Pin only the `intake` group** in the native draft editor too (Admin → pin definitions), so even
   staff who bypass Guru see only the fill fields in Shopify's own Metafields card; `custom` stays unpinned/hidden.

7. **Staff SOP (one line):** *"Fill the `intake` group. Never edit `custom` — the system writes it."*

## Notes / caveats
- Exact Guru menu labels vary by app version — the flow (definitions → namespace → grouped order view) holds.
- This is a **migration**: changing a live field's namespace requires copying values to the new
  definition first. Do it field-by-field, lowest-risk fields first.
- JSON-consolidation of the `custom` (auto) fields is a *separate, later* de-bloat — Guru grouping
  solves the staff-clarity problem on its own without touching the system fields' shape.
