# GoKwik webhook: what actually arrives

This comes from a live test on 2026-10-22. Draft #D290 (`1487067709697`) was sent a ₹1 link via `send-link-1`, and the payment was attempted twice: once successfully by UPI or card, then once with a card that failed. Every delivery was captured by `src/integrations/gokwik/capture.js` into `gokwik_webhook_log`.

Both shapes below POST to `/api/gokwik-webhook` (the `webhook_url` set on the link), from `52.66.34.242` with user agent `axios`.

## Shape A: link status callback (the one the handler uses today)

- **Headers:** `app-id` and `app-secret`. These are our own GoKwik app credentials, echoed back to us. **That is GoKwik's only proof of origin. There is no HMAC.**
- **Body:**
  ```json
  { "status": "success" | "failure", "status_code": "E0000" | "E000X",
    "status_description": "Transaction successful",
    "gokwik_oid": "<draftId>-<ms timestamp>",   // our merchant_reference_id
    "transaction_id": "KWIKT…",                 // GoKwik payment id
    "gateway_reference_id": "E2610…",           // Easebuzz ref, stored as utr
    "payment_provider": "easebuzz", "moid": "NA",
    "request_id": "<uuid>", "timestamp": 1792685247634 }
  ```
- **No amount in this shape.** The handler takes the amount from our own `payment_links` row, which is correct.
- `failure` is sent once for each failed attempt. The link stays payable, so a failure after a success on the same link must never undo the success.

## Shape B: transaction event webhook

This shape was only seen for the failure, which arrived in the same second as shape A's failure.

- **No credential headers.**
- **Body:** `{ "event": "transaction.failure", "entity": "transaction", "data": { … } }`. The `data` object has:
  - `hmac`: 128 hex characters, so probably SHA-512;
  - `amount` in rupees;
  - `paymentId`;
  - `merchantReferenceId`;
  - `gatewayReferenceId`;
  - `method`, `cardNetwork`, `cardIssuer`;
  - a `description` with the decline reason.
- The current handler ignores this shape, because it has no top-level `status`.
- We don't know what the HMAC is computed over or with which key. We need GoKwik's documentation before we can trust this shape.

## How the buy plan verifies a payment before recording it

1. **Accept only shape A with `status === "success"`.**
2. **Check the origin:** `app-id === GOKWIK_APP_ID` and `app-secret === GOKWIK_APP_SECRET`, compared in constant time. The capture now logs `[matches GOKWIK_APP_SECRET]` or `[MISMATCH]` instead of the secret, which shows whether this check holds in production.
3. **Confirm with GoKwik:** call `getLinkStatus(gokwik_link_id)` ourselves and record the payment only if GoKwik reports the link as paid. A forged body that carries a leaked secret still can't create a payment that GoKwik doesn't have.
4. **Prevent double-recording:** use `transaction_id` as the key. The existing `id: gk-<transaction_id>` passed to `handlePaymentCompletion` should be checked to make sure it is unique.

## Open
- The `getLinkStatus` response shape: which status value means paid, and is the amount paid included? Call it once on `KWIKLINKIDJ4K6IW4292732` to find out.
- Ask GoKwik how the shape B `hmac` is computed and whether a `transaction.success` event exists.
- The app secret has been seen in plain text: in the first capture rows, a CSV export and a chat transcript. Rotate it in the GoKwik dashboard, then update the Fly secret `GOKWIK_APP_SECRET`.
