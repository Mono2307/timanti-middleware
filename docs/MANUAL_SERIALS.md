# Numbering hand-raised documents from the Google Sheet

A delivery challan written at the counter and a delivery challan raised in Shopify are **one
series**. This is how the sheet draws from the same counter instead of keeping its own count.

Two things make it work, and both are necessary:

- the sheet never computes a number — it asks the middleware, and
- committing a number **advances the counter and writes a `serial_ledger` row**, so no other
  document can take it and the drift sweep sees it accounted for.

A number that existed only in a spreadsheet would be indistinguishable from the two invoice numbers
destroyed on 2026-08-29 — a gap with nothing behind it. See `RCA_INVOICE_COUNTER_2026-08-29.md`.

---

## One spreadsheet, one originating store

The series belongs to the store the document leaves **from**, so the store code is hard-coded once
at the top of the script and every tab inherits it. Each tab says which *series* it raises.

| Spreadsheet | `STORE_CODE` | Tab | Series | Prints as |
|---|---|---|---|---|
| KA → MH | `KA-HSR` | Delivery Challan | `delivery_challan` | `DC-KAHSR-0007` |
| | | Interstore Sale | `b2b` | `AURA-KAHSR-0003` |
| MH → KA | `MH-HQ` | Delivery Challan | `delivery_challan` | `DC-MHHQ-0004` |
| | | Interstore Sale | `b2b` | `AURA-MHHQ-0002` |

The two directions are two copies of the same script differing only in `STORE_CODE` and `DEST_CODE`.
The lookup is per **store code and series together**, so the four books above are four independent
counters.

`DEST_CODE` is recorded on the ledger row so the row reads as a movement. It is *not* printed in the
number — the challan series belongs to the origin alone. Any other KA-origin spreadsheet would draw
from the same `KA-HSR` counters, which is correct: one store, one challan book, however many forms
feed it.

### What the sheet can number

| Doc type | Prints as | Also minted by Shopify? |
|---|---|---|
| `delivery_challan` | `DC-KAHSR-0007` | **Yes** — the `make-memo-custom` tag on a draft |
| `b2b` | `AURA-KAHSR-0003` | **No, by design.** Interstore transfers are raised from the document, never from Shopify |

Nothing else. `customer_order`, `customer_service` and `free_service` are B2C tax invoices that mint
from Shopify at conversion and nowhere else; the server rejects any attempt to draw one from a
sheet, because a second issuer would put the whole series in doubt.

---

## Endpoints

| | |
|---|---|
| `GET /api/serial/peek?docType=…&state=KA-HSR` | What the next number would be. Consumes nothing. Public, read-only. |
| `POST /api/serial/manual-mint` | Draws the number for real. Needs `SHEET_API_SECRET`. |
| `POST /api/serial/manual-void` | Retires a number. Needs `SHEET_API_SECRET`. |

```
POST /api/serial/manual-mint
  x-sheet-secret: <SHEET_API_SECRET>
  { "docType": "delivery_challan", "storeCode": "KA-HSR", "deliveryCode": "MH-HQ",
    "reference": "<uuid, one per physical document>", "label": "KA-HSR → MH-HQ" }

  → { "success": true, "serial_code": "DC-KAHSR-0007", "serial_no": 7, "already_held": false }
```

`reference` is an idempotency key. Send it twice and the **same** number comes back — that is what
makes a retry after a timeout safe. The sheet writes the reference to Document Properties *before*
it sends the request; that ordering is the whole safety property, not an implementation detail.

Voiding does **not** return the number to the counter. A cancelled serial stays cancelled and the
drift check counts it as accounted for: a gap with an explanation is defensible to an auditor, a
reprinted number is not.

---

## Deploying

1. Generate a secret and set it on Fly:

   ```
   fly secrets set SHEET_API_SECRET=<random string>
   ```

   It is deliberately **not** `ADMIN_API_SECRET`. This value lives in the Script Properties of a
   spreadsheet every store staffer can open; the admin secret also unlocks `/api/serial/clear` and
   `/api/serial/counter`. Leaking this one costs a challan number. Leaking that one costs the series.

   With neither set, both manual endpoints return **503** rather than opening.

2. Deploy the middleware (GitHub Actions — see `docs/DEPLOY.md`).

3. For **each** spreadsheet: Extensions → Apps Script → paste
   `timanti-ops-assets/apps-script/services/serialization/manual-serials-apps-script.js`, then
   edit the CONFIGURATION block at the top:

   ```js
   var STORE_CODE = 'KA-HSR';   // originating store — this file is the KA→MH book
   var DEST_CODE  = 'MH-HQ';    // destination — recorded on the ledger, not printed

   var TABS = {
     'Delivery Challan': { docType: 'delivery_challan', numberCell: 'F4', partyCell: '' },
     'Interstore Sale':  { docType: 'b2b',              numberCell: 'F4', partyCell: '' }
   };
   ```

   Save, reload the sheet.

4. **🔢 Serial → Set the API secret** — paste the value from step 1.

5. **🔢 Serial → Refresh on every open** (optional, recommended).

6. **🔢 Serial → Diagnose** on *each tab* and check the book and series it reports.

### Refreshing without the open trigger

`refreshNextNumber` is a standalone, preview-only function. There is no path from it to a mint, so
it is safe to run from the menu or wire to an in-sheet button — Insert → Drawing → right-click →
Assign script → `refreshNextNumber`.

The on-open refresh is not blocked; it just needs the *installable* trigger that step 5 creates.
Google runs the plain `onOpen` without authorization, so that one can build the menu but cannot
reach the network. The installed trigger runs for everyone who opens the file, as the person who
installed it.

---

## How staff use it

| | |
|---|---|
| Open the sheet | the number cell shows the next number, **grey italic**. Nothing is reserved. |
| *Mint this number* | the cell turns **bold black**. It is recorded, and nothing else can take it. |
| *Start a new document* | clears the number so the form can be reused. |
| *Void this number* | retires a number on a spoiled form. |
| *Diagnose* | book, series, live counter, and whether the trigger is installed. |

The grey/bold distinction is the whole user interface: **grey means anyone can still take it.**

---

## Things worth knowing

**The preview is advisory.** Two staff can be looking at the same "next" number at once. Whoever
mints first gets it; the other is shown what they actually got. The cell always ends up holding what
the server returned, never what the preview promised — the only arrangement that cannot produce a
duplicate.

**A refresh never overwrites a minted number.** A form that has been minted but not yet printed
keeps its number through every reopen. This is checked before the network call, not after.

**A tab not listed in `TABS` falls back to keyword matching** on its name (`challan` → DC, `sale` /
`invoice` / `transfer` → AURA), so renaming a tab does not break it. The mint dialog always names
the series and the book before anything is drawn, so a wrong guess costs a cancelled dialog rather
than a number — and *Diagnose* says which way it resolved.

**A mint that never confirmed leaves the reference behind.** Pressing *Mint this number* again
returns the same number instead of drawing a second. Pressing *Start a new document* instead
abandons it, and if a number was in fact drawn it will sit in the ledger with no form against it —
the dialog says so.

**Voiding from the sheet cannot touch a Shopify document.** `manual-void` refuses any ledger row
that is not `resource_type = 'manual'`, so typing a live draft's challan number into the void prompt
gets a 409, not a cancelled document.
