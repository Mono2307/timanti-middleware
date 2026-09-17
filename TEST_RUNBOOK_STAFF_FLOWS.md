# Staff-Flow E2E Runbook — internal processes, the way staff actually run them

**For:** validating the internal document-numbering + credit processes end-to-end · **Created:** 2026-07-05

Store staff never run curl. Each internal process is triggered the way they do it in real life — a **tag on
a draft**, an **action link in an email**, or a **menu item in the Recon/Exchange sheet**. This runbook
walks each one as the staff member experiences it, and tells you what to check afterwards.

> **Still excluded:** converting a customer draft into a final *customer invoice* (that's the parked
> draft→final pass). Internal docs (challan, transfer, PO, repair) legitimately mint a number when staff
> tag/complete them — that IS their real flow, so those are in scope here and run on **scratch drafts**.

---

## 0. Prerequisites (a deploy step, not a staff step)

Each doc type only mints when its flag is on. Confirm which you want to test, then someone with deploy
access runs (one line):

```
fly secrets set SERIAL_CUSTOMER_ORDER=true SERIAL_REPAIR=true SERIAL_MEMO_TRANSFER=true SERIAL_PO=true
```

| Flag | Enables | Number format |
|---|---|---|
| `SERIAL_CUSTOMER_ORDER` | customer orders | `TM27-KAHSR-00001` |
| `SERIAL_REPAIR` | repairs (paid + free) | `TS27-…` / `FS27-…` |
| `SERIAL_MEMO_TRANSFER` | **challan AND transfer** | `DC-…` / `AURA-…` |
| `SERIAL_PO` | purchase orders | `PO-KAHSR-00001` |

**Scratch resources:** use throwaway drafts and one demo order. Number everything with the fake store code
**`KA-TEST`** so test numbers stay separate from real `KA-HSR` and are easy to delete afterwards.

**How you check results:** the fastest read is the report page in a browser —
`https://timanti-middleware.fly.dev/api/serial-report?docType=customer_order` (swap `docType` per test).
Or open the draft/order in Shopify admin and look at its **Metafields → `custom.serial_code`**.

---

## 1. Customer order number  *(criterion E1–E3 · flag `SERIAL_CUSTOMER_ORDER`)*

**Real staff flow:** an order comes in → staff open it in Shopify admin → type the **State Code** into the
`custom.state_code` metafield (e.g. `KA-TEST`) → Save. That's it — no tag. Saving fires the webhook and the
number is minted automatically.

**Do this:**
1. Open a scratch order in admin → set metafield `custom.state_code = KA-TEST` → Save.
2. Open `…/api/serial-report?docType=customer_order` in a browser.

**Expect:** a new row `TM27-KATEST-00001`, status active; the order's `custom.serial_code` is filled in. ✅

**Idempotency (E2):** edit + save the order again → **no** second number appears. ✅
**No state → waits (E3):** on a different scratch order with a blank `state_code`, saving mints **nothing**. ✅

---

## 2. Repair / service number  *(E4 · flag `SERIAL_REPAIR`)*

**Real staff flow:** repairs are numbered when **HQ marks the repair complete** — HQ opens the signed
**"Mark Repair Complete & Notify Customer"** link from the repair email, fills the set-complete form
(Sequel tracking id, or "collect in-store"), and submits. The middleware then tags the draft
`repair-complete` and mints the number.

**Do this (paid repair):**
1. On a scratch repair draft, make sure `custom.state_code = KA-TEST` is set and it carries the
   `repair-paid` tag (the normal state after payment).
2. Open the set-complete link for that draft and submit the form.
3. Check `…/api/serial-report?docType=customer_service`.

**Expect:** one row `TS27-KATEST-00001`; the draft's `custom.serial_code` is stamped. ✅

**Free repair (FS):** on another scratch draft add the **`free-repair`** tag, then run set-complete.
**Expect:** a `free_service` row `FS27-KATEST-00001` (free repairs now DO get a number). ✅

**Idempotency:** re-submit set-complete → still exactly one row. ✅

---

## 3. Delivery challan  *(E5 · flag `SERIAL_MEMO_TRANSFER`)*

**Real staff flow:** staff open a scratch draft → add the tag **`make-challan`** → Save.

**Do this:**
1. Draft with `custom.state_code = KA-TEST` (a `delivery_code` is optional now).
2. Add tag `make-challan` → Save.
3. Check `…/api/serial-report?docType=delivery_challan`.

**Expect:** a row `DC-KATEST-0001`; draft stamped; the `make-challan` tag is **auto-removed** (so it can't
re-fire). ✅

**Void (staff flow):** add the tag **`cancel-challan`** → Save.
**Expect:** the ledger row flips to `cancelled`; the number is retired and never reused. ✅

---

## 4. B2B / inter-store transfer  *(E6 · flag `SERIAL_MEMO_TRANSFER`)*

**Real staff flow:** identical to challan, different tag.
1. Scratch draft, `state_code = KA-TEST`.
2. Add tag **`make-transfer`** → Save → check `…/api/serial-report?docType=b2b`.

**Expect:** `AURA-KATEST-0001`, draft stamped, tag removed. ✅
**Void:** tag **`cancel-transfer`** → Save → row `cancelled`. ✅

---

## 5. Purchase order  *(flag `SERIAL_PO`)*

**Real staff flow:** staff raise the PO from the **PO Ops** flow (tag `raise-po` on the source order, or a
batch); the PO number is minted when **HQ clicks the "Acknowledge" link** in the PO email.

**Do this:**
1. On a scratch order set `state_code = KA-TEST`, add tag `raise-po` → a PO record is created.
2. Open the **Acknowledge** action link from the PO email.
3. Check `…/api/serial-report?docType=po`.

**Expect:** `PO-KATEST-00001`, PO draft stamped. ✅
**Void:** click the PO **Cancel** action → row `cancelled`, number retired. ✅

> PO is the most involved flow (source order → PO Ops → email → acknowledge). If you'd rather I walk it
> live with you the first time, say so.

---

## 6. Voucher / exchange note — issue, redeem, void  *(B1, B4, B5 · table `credit_instruments`)*

**Real staff flow:** vouchers and exchange notes are created and redeemed from the **Exchange / Recon
Apps Script menu** in the linked Google Sheet (not curl). Issuing writes a row to `credit_instruments`;
redeeming at the counter attaches it to the new draft and kills its online code; voiding retires it.

**Do this:**
1. **Issue** a voucher from the sheet menu (e.g. "Create Voucher", value ₹5,000) → a `credit_instruments`
   row appears, `status='open'`.
2. **Redeem** it against a scratch draft from the menu → row goes `redeemed`, `target_draft_id` set, the
   online discount code is deleted, and the draft's `voucher_value` = 5000, collectible drops by 5000. ✅
3. **Single-use (B1):** try to redeem the same voucher on a *different* draft → **blocked** with a clear
   "already redeemed" message. ✅
4. **Void (B5):** run "Void Voucher" for it → row `voided`, the draft's collectible goes back up, serial
   cancelled. ✅

---

## 7. Expired / cancelled voucher refusals — the two Supabase-seeded cases  *(B2, B3)*

These two can't happen naturally in a quick test (you'd have to wait a year, or void first), so you seed
the state directly. **Supabase → SQL Editor**, run:

```sql
-- B2: an already-expired open voucher
insert into credit_instruments (instrument_type, serial_code, value, status, state_code, expires_at)
values ('voucher','VCH-TEST-EXP', 5000, 'open', 'KA-TEST', now() - interval '1 day');

-- B3: a voided voucher
insert into credit_instruments (instrument_type, serial_code, value, status, state_code)
values ('voucher','VCH-TEST-VOID', 5000, 'voided', 'KA-TEST');
```

Now, from the sheet menu (or the counter redeem flow), try to redeem **`VCH-TEST-EXP`** and
**`VCH-TEST-VOID`** onto a scratch draft.

**Expect:** both are **refused** — `VCH-TEST-EXP` with an "expired" reason, `VCH-TEST-VOID` with a
"was voided" reason. Neither reduces the draft's collectible. ✅

---

## 8. Cleanup — leave the store and database exactly as found

**In Shopify admin:** on the scratch drafts/order, remove any tags you added (`make-challan`,
`make-transfer`, `raise-po`, `free-repair`, `cash-*`, `vch-*`, `exc-*`) and clear the machine-written
`custom.serial_code`. (Or use the API: `…/api/serial/clear?orderId=<id>` and
`…/api/serial/clear?draftOrderId=<id>`.)

**In Supabase → SQL Editor:**

```sql
-- remove the seeded + minted test credit rows
delete from credit_instruments where serial_code like 'VCH-TEST-%' or serial_code like 'EXC-TEST-%';
delete from credit_instruments where state_code = 'KA-TEST';

-- remove the test serial ledger rows and the fake counter (real KA-HSR untouched)
delete from serial_ledger where store_code like '%KA-TEST%' or store_code like '%KATEST%';
delete from serial_counters where state_code like '%KA-TEST%' or state_code like '%KATEST%';
```

**Flags:** flip back off whatever you turned on for the test (leave `SERIAL_CUSTOMER_ORDER` as it was if
that one is your live one):

```
fly secrets set SERIAL_REPAIR=false SERIAL_MEMO_TRANSFER=false SERIAL_PO=false
```

---

## Staff-flow score sheet

| Ran it | Process | Section | Real staff trigger | Passed? |
|---|---|---|---|---|
| ☐ | Customer order number | 1 | type State Code + Save | |
| ☐ | Repair (paid) `TS` | 2 | HQ set-complete link | |
| ☐ | Repair (free) `FS` | 2 | `free-repair` tag + set-complete | |
| ☐ | Delivery challan `DC` | 3 | `make-challan` tag | |
| ☐ | Challan void | 3 | `cancel-challan` tag | |
| ☐ | B2B transfer `AURA` | 4 | `make-transfer` tag | |
| ☐ | Transfer void | 4 | `cancel-transfer` tag | |
| ☐ | Purchase order `PO` | 5 | `raise-po` + Acknowledge link | |
| ☐ | Voucher issue/redeem/void | 6 | Exchange/Recon sheet menu | |
| ☐ | Voucher single-use block | 6 | redeem twice | |
| ☐ | Expired voucher refused | 7 | Supabase seed + redeem | |
| ☐ | Voided voucher refused | 7 | Supabase seed + redeem | |

**Prerequisite for all of §1–5:** the matching `SERIAL_*` flag must be ON (see §0).
