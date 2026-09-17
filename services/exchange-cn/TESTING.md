# Exchange CN — Test Plan (Voucher + Exchange Note)

Covers the dual doc-type flow: **Voucher** (1-year discount code, replaces old CNTM credit notes)
and **Exchange Note** (instant post-tax deduction on a new draft invoice).

- Apps Script: `services/exchange-cn/apps-script.js` (commit `1044353` or later)
- Middleware: `https://timanti-middleware.fly.dev`
- Endpoints: `/api/cn-email`, `/api/exc-email`, `/api/exc-redeem`, `/api/exc-void`,
  `/api/serial/allocate`, `/api/serial/cancel-by-code`, `/api/serial/peek`
- Serial doc-types: `voucher` (VCH-YYYY-NNNN), `exchange_note` (EXC-YYYY-NNNN)

---

## How the two flows differ

|                       | **Voucher**                     | **Exchange Note**                          |
| --------------------- | ------------------------------- | ------------------------------------------ |
| When money is used    | Later — a future purchase       | Now — on the purchase happening today      |
| Mechanism             | Shopify discount code (price rule) | Negative line item on a new draft       |
| Customer gets         | Code `VCH-2026-NNNN`, 1-year    | Instant reduction on today's invoice       |
| GST treatment         | Discount applied at checkout    | **Post-tax** — deduction sits outside GST  |
| Expiry                | 1 year                          | None (already consumed)                    |
| Needs a new draft #   | No                              | Yes (the new sale's draft, e.g. `#D123`)   |

### Exchange Note — step by step
1. Staff rings up the new item in Shopify as a **draft** (taxed normally on full price).
2. Sheet: old order in `B7`, value computed in `B36`, select **Exchange Note** in `B37`,
   new draft `#D123` in `D37`.
3. `createExchangeNote_()` allocates `EXC-2026-NNNN` (aborts if middleware down — no fallback),
   then `/api/exc-redeem` appends a negative custom line (`taxable:false`, post-tax),
   re-sends the full line set, tags the draft, tags the OLD order, logs to Exchange Log, emails.
4. New draft total = (new item price + GST on full price) − exchange value.

Void only works while the new sale is still a **draft**; after conversion `/api/exc-void` 409s.

---

## Pre-req (do once)

| #   | Step                                                                 | Expected                                                                 |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 0.1 | Re-paste latest `apps-script.js` (commit `1044353`+) into Apps Script, save | —                                                                 |
| 0.2 | Run **🧩 Set up Document Type fields** again                          | Dropdown at **B37**, New Draft at **D37**; guard aborts if row 37 has data; both log tabs present |
| 0.3 | Confirm `B37` dropdown + `D37` grays out when "Voucher" selected      | Visual check                                                             |

## Phase A — Voucher (regression — already working)

| #   | Step                                                                 | Expected                                                                 |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| A.1 | Pick a real test order, fill sheet, select **Voucher**, *Create Document* | Alert: `VCH-2026-0001` created                                      |
| A.2 | Shopify → Discounts                                                  | Discount code `VCH-2026-0001` exists, 1-year expiry, value = net credit  |
| A.3 | Shopify → that order's tags                                          | `cn-issued`, `cn-num:VCH-2026-0001`, `cn-val:`, `cn-exp:`, `cn-iss:`     |
| A.4 | Voucher Log tab                                                      | New row, status `Issued`, price_rule_id in last column                   |
| A.5 | Inbox                                                                | Voucher email received                                                   |
| A.6 | `curl '.../api/serial/peek?docType=voucher'`                         | `current_value: 1, next_value: 2`                                        |

## Phase B — Exchange Note happy path

| #   | Step                                                                 | Expected                                                                 |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| B.1 | Ring up a throwaway **draft** in Shopify (note total + GST)          | e.g. `#D123`, total = ₹X                                                 |
| B.2 | Sheet: old order in B7, value in B36, select **Exchange Note**, draft `#D123` in D37, *Create Document* | Alert: `EXC-2026-0001` applied, ₹ deducted             |
| B.3 | Open draft `#D123` in Shopify                                        | Line `Exchange Note EXC-2026-0001` at **−₹value**; **GST unchanged** vs B.1; total dropped by exactly the exchange value |
| B.4 | Draft tags                                                          | `exc-applied`, `exc-num:EXC-2026-0001`                                   |
| B.5 | OLD order tags                                                      | `exc-given`, `exc-num:`, `exc-val:`, `exc-applied-to:#D123`, `exc-iss:`  |
| B.6 | Exchange Log tab                                                    | New row, status `Applied`, numeric draft id in last column               |
| B.7 | Inbox                                                              | Exchange Note email received                                             |
| B.8 | `curl '.../api/serial/peek?docType=exchange_note'`                  | `current_value: 1, next_value: 2`                                        |

## Phase C — Exchange Note edge cases

| #   | Step                                                                 | Expected                                                                 |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| C.1 | **Idempotency:** re-run *Create Document* on same draft (or re-fire `/api/exc-redeem`) | No duplicate line; returns `alreadyApplied:true`       |
| C.2 | **Bad draft:** enter a non-existent draft `#D99999`                  | Clean error, no line added, serial reserved with "void it if you don't retry" note |
| C.3 | **Middleware down (optional):** simulate failure                     | Aborts before touching invoice (no orphan EXC line)                      |

## Phase D — Voids

| #   | Step                                                                 | Expected                                                                 |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| D.1 | **Void Voucher** `VCH-2026-0001` (before expiry)                     | Discount deleted in Shopify; Voucher Log row → `Voided`; serial retired  |
| D.2 | **Void Exchange Note** `EXC-2026-0001` while `#D123` still a draft   | EXC line removed; draft total back to original; `exc-*` tags stripped from old order; Exchange Log → `Voided` |
| D.3 | **Void after conversion:** convert `#D123` to an order, then try to void | Refused with 409 "draft already completed"                          |

## Phase E — Ledger integrity

| #   | Step                                                                 | Expected                                                                 |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| E.1 | After a void, allocate the next serial                               | Voided number **not reused**; counter keeps climbing (no reused gaps, no dupes) |

---

## curl helpers (for direct middleware testing)

```bash
BASE="https://timanti-middleware.fly.dev"

# Peek serial counters (read-only)
curl -s "$BASE/api/serial/peek?docType=voucher"
curl -s "$BASE/api/serial/peek?docType=exchange_note"

# Send test emails (to your own address)
curl -s -X POST "$BASE/api/cn-email"  -H "Content-Type: application/json" \
  -d '{"customerName":"TEST","customerEmail":"you@example.com","cnNumber":"VCH-2026-TEST","creditValue":"184230","validUntil":"11-06-2027","originalOrder":"#1052"}'
curl -s -X POST "$BASE/api/exc-email" -H "Content-Type: application/json" \
  -d '{"customerName":"TEST","customerEmail":"you@example.com","excNumber":"EXC-2026-TEST","excValue":"184230","oldOrder":"#1052","newOrder":"#D999"}'

# Apply an Exchange Note to a real draft (MUTATES the draft — use a throwaway)
curl -s -X POST "$BASE/api/exc-redeem" -H "Content-Type: application/json" \
  -d '{"newDraftRef":"#D123","excNumber":"EXC-2026-TEST","excValue":1000,"oldOrderNumber":"#1052","customerName":"TEST"}'

# Void an Exchange Note line (needs the numeric draft id)
curl -s -X POST "$BASE/api/exc-void" -H "Content-Type: application/json" \
  -d '{"newDraftId":"123456789","excNumber":"EXC-2026-TEST"}'
```

> Note: `/api/exc-redeem` does NOT allocate a serial — it only appends the line. The Apps Script
> allocates via `/api/serial/allocate` first. When testing exc-redeem directly with curl, use a
> dummy `excNumber` so you don't burn a real ledger serial.
