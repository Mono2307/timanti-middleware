# Brief — "Ship Outside Codes" on the delivery challan

**File to change:** `templates/delivery-challan.liquid` (371 lines). Nothing else.
**Status:** everything EXCEPT this template is already done and live.

## What already exists (do not redo)

- Metafield `custom.ship_outside_codes` is created on **DRAFTORDER** and **ORDER**:
  `single_line_text_field`, validation `choices = ["Yes","No"]`.
- Metafield Manager extension **v-39** is live. In the System section staff now see
  **Ship Outside Codes** directly above **Delivery / Store Code**, and picking *Yes*
  greys the code field (value kept, not cleared).
- Serial minting already treats `delivery_code` as **optional**, so leaving it blank
  breaks no numbering (`server.js`, `assignDocSerial`).

So the flag saves correctly today; the challan simply ignores it.

## Goal

When `custom.ship_outside_codes` is `Yes`, the **Consignee (Delivered To)** block must
show the customer address from the draft instead of a store, and the CGST/SGST vs IGST
split must follow the customer's state. Everything else on the document is unchanged.

## Hunk 1 — read the flag

Insert after the existing `to_key` assign (currently line 60):

```liquid
{% assign ship_outside = order.metafields.custom.ship_outside_codes | strip | downcase %}
{% assign is_outside = false %}
{% if ship_outside == "yes" or ship_outside == "true" %}{% assign is_outside = true %}{% endif %}
```

`"true"` is accepted too, in case the field is ever migrated to a real boolean.

## Hunk 2 — a new first branch on the consignee block

The consignee block is currently `{% if to_key == "KAHSR" %} ... {% endif %}` at
**lines 87-108**. Leave all three existing branches exactly as they are; add one in front,
changing `{% if to_key == "KAHSR" %}` to `{% elsif to_key == "KAHSR" %}`:

```liquid
{% if is_outside %}
  {% assign _to = order.shipping_address %}
  {% if _to == blank %}{% assign _to = order.billing_address %}{% endif %}
  {% assign _pc = _to.province_code | strip | upcase %}
  {% if _pc == "JK" %}{% assign to_state = "01 Jammu & Kashmir" %}{% elsif _pc == "HP" %}{% assign to_state = "02 Himachal Pradesh" %}{% elsif _pc == "PB" %}{% assign to_state = "03 Punjab" %}{% elsif _pc == "CH" %}{% assign to_state = "04 Chandigarh" %}{% elsif _pc == "UK" %}{% assign to_state = "05 Uttarakhand" %}{% elsif _pc == "HR" %}{% assign to_state = "06 Haryana" %}{% elsif _pc == "DL" %}{% assign to_state = "07 Delhi" %}{% elsif _pc == "RJ" %}{% assign to_state = "08 Rajasthan" %}{% elsif _pc == "UP" %}{% assign to_state = "09 Uttar Pradesh" %}{% elsif _pc == "BR" %}{% assign to_state = "10 Bihar" %}{% elsif _pc == "SK" %}{% assign to_state = "11 Sikkim" %}{% elsif _pc == "AR" %}{% assign to_state = "12 Arunachal Pradesh" %}{% elsif _pc == "NL" %}{% assign to_state = "13 Nagaland" %}{% elsif _pc == "MN" %}{% assign to_state = "14 Manipur" %}{% elsif _pc == "MZ" %}{% assign to_state = "15 Mizoram" %}{% elsif _pc == "TR" %}{% assign to_state = "16 Tripura" %}{% elsif _pc == "ML" %}{% assign to_state = "17 Meghalaya" %}{% elsif _pc == "AS" %}{% assign to_state = "18 Assam" %}{% elsif _pc == "WB" %}{% assign to_state = "19 West Bengal" %}{% elsif _pc == "JH" %}{% assign to_state = "20 Jharkhand" %}{% elsif _pc == "OR" %}{% assign to_state = "21 Odisha" %}{% elsif _pc == "CT" %}{% assign to_state = "22 Chhattisgarh" %}{% elsif _pc == "MP" %}{% assign to_state = "23 Madhya Pradesh" %}{% elsif _pc == "GJ" %}{% assign to_state = "24 Gujarat" %}{% elsif _pc == "DN" or _pc == "DD" %}{% assign to_state = "26 Dadra & Nagar Haveli and Daman & Diu" %}{% elsif _pc == "MH" %}{% assign to_state = "27 Maharashtra" %}{% elsif _pc == "KA" %}{% assign to_state = "29 Karnataka" %}{% elsif _pc == "GA" %}{% assign to_state = "30 Goa" %}{% elsif _pc == "LD" %}{% assign to_state = "31 Lakshadweep" %}{% elsif _pc == "KL" %}{% assign to_state = "32 Kerala" %}{% elsif _pc == "TN" %}{% assign to_state = "33 Tamil Nadu" %}{% elsif _pc == "PY" %}{% assign to_state = "34 Puducherry" %}{% elsif _pc == "AN" %}{% assign to_state = "35 Andaman & Nicobar Islands" %}{% elsif _pc == "TG" %}{% assign to_state = "36 Telangana" %}{% elsif _pc == "AP" %}{% assign to_state = "37 Andhra Pradesh" %}{% elsif _pc == "LA" %}{% assign to_state = "38 Ladakh" %}{% else %}{% assign to_state = "" %}{% endif %}
  {% if _to == blank or to_state == blank %}
    {% assign to_entity = "NO CONSIGNEE - Ship Outside Codes is Yes but this draft has no usable customer address" %}
    {% assign to_addr  = "" %}
    {% assign to_state = "-" %}
    {% assign to_email = "" %}
    {% assign to_phone = "" %}
  {% else %}
    {% assign to_entity = _to.name %}
    {% capture to_addr %}{{ _to.address1 }}{% if _to.address2 != blank %}, {{ _to.address2 }}{% endif %}, {{ _to.city }}, {{ _to.province }}{% if _to.zip != blank %} - {{ _to.zip }}{% endif %}, {{ _to.country }}{% endcapture %}
    {% assign to_email = order.email %}
    {% assign to_phone = _to.phone %}
  {% endif %}
{% elsif to_key == "KAHSR" %}
```

Use the real em-dash/warning glyphs already used elsewhere in the file for the `-` placeholders
above; they are written plain here only to keep this brief copy-safe.

## Hunk 3 — drop the GSTIN row from the consignee block

A delivery challan under s.31(7) is a movement of goods, **not a supply**, and the consignee
is an unregistered individual. Printing a placeholder GSTIN invites the reader to treat the
document as a sale. Remove the row entirely rather than printing a dash.

In the rendered consignee block (currently **line 203**), replace the GSTIN line with:

```liquid
      {% unless is_outside %}<strong>GSTIN:</strong> {{ to_gstin }}<br>{% endunless %}
```

`to_gstin` is then never assigned nor read on the outside path - it is referenced nowhere
else in the file, so nothing further needs changing. The store branches keep their GSTIN
row untouched.

## Invariants — do not change these

1. **`is_same_state` stays as it is.** It compares the RESOLVED `from_state`/`to_state`
   strings, never the typed codes. The province chain above emits exactly `"29 Karnataka"`
   and `"27 Maharashtra"` - byte-identical to the store branches - so a Karnataka customer
   shipped from KA-HSR correctly compares equal and gets CGST/SGST. Verified.
2. **Place of Supply stays `from_state`.** Founder directive 2026-09-15: goods move on
   approval under s.31(7), so the document states the state supplied FROM. Do not
   "correct" it to `to_state`.
3. **Consignor is untouched.** Goods still ship from a store, so `custom.state_code` and
   the whole `from_*` block are unchanged. Only the consignee switches.
4. **Never invent a party.** The template's existing stance: a challan that fabricates a
   party is a GST document asserting a movement that never happened. Hence the visible
   error block rather than a silent fallback.

## Order Printer gotchas (both have bitten this repo)

- **Order Printer validates the template as HTML, including inside `{% comment %}`.**
  An angle-bracketed token in a comment is rejected as `Tag value invalid` and the paste
  fails. Keep angle brackets out of comments.
- **The installed copy can lag `templates/*.liquid`.** Replay a real draft against the repo
  file before blaming the data.

## Decisions - settled, do not re-open

1. **No GSTIN row on the outside path.** Founder, 2026-09-16: the challan is not a sale by any
   means, it is just movement of goods, so the field should not appear at all. See hunk 3.
2. **Fail loud on a missing address.** Confirmed acceptable - there is no real case where both
   the delivery code and the customer details are empty, so the error block is unreachable in
   practice and exists only as a guard.

## Test plan

Raise a challan off a draft in each state:

| Case | `ship_outside_codes` | Expect |
|---|---|---|
| Normal store route | No / blank | Unchanged from today - store consignee from `delivery_code` |
| Customer, same state | Yes, KA customer, from KA-HSR | Customer address, NO GSTIN row; CGST + SGST |
| Customer, other state | Yes, MH customer, from KA-HSR | Customer address; IGST |
| No customer on draft | Yes, no addresses | Visible error block, no address |
| Flag set, code still filled | Yes + `delivery_code` = KA-HSR | Customer address wins; code ignored |

The last row matters: staff can flip the toggle on a draft that already has a code typed,
because the extension greys the field without clearing it.
