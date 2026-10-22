# Exchange Calculator: staff guide to messages

## How to start every exchange

1. **Set Source first.**
   - *Purchase Exchange*: the customer is returning something bought from us.
   - *Old Gold*: scrap or old gold with no Timanti order.
2. Choose the **Exchange Type**:
   - *Deduction*: revalued at today's prices.
   - *Full Value*: what the customer paid.
3. Choose the **Document Type** (Voucher or Exchange Note). For an Exchange Note, enter the new sale's draft number (e.g. #D123) in **New Draft/Order #**.
4. Type the original order number. The sheet fills everything in and runs its checks.
5. Read the **CHECKS** cell. Hover over it to see the full list.
   - ✅ **OK**: everything came straight from the order.
   - ⚠️ **To confirm**: you will be asked to read something and press Yes. Your answer is saved in the log.
   - ❌ **Blocked**: nothing can be issued in this mode. The message says why.

If you change anything on the order, the SKU or the sheet's calculated figures, re-enter the order number before creating the document.

---

## ❌ Blocked: cannot be exchanged

| Message says | What it means | What to do |
|---|---|---|
| tagged "test orders" | A test, not a real sale | Nothing. It can't be exchanged. |
| was cancelled | The order was cancelled | Nothing to exchange. |
| is REFUNDED / VOIDED in Shopify | The customer already has their money back | Can't exchange. Check with HQ if the customer disagrees. |
| is "pending" / not paid | The order isn't fully paid in Shopify | Can't credit an unpaid item. Ask HQ to check the payment. |
| This item was refunded | This piece was refunded | Can't also be exchanged. |
| tagged "returned" | The piece has already come back | Can't be exchanged again. |
| was already exchanged (EXC…) | An exchange note was already issued for this order | If the exchange is being redone, void that Exchange Note first (menu → Void Exchange Note), then try again. |
| The item on the sheet has not been checked | Something changed since the lookup | Re-enter the order number. |
| The value on the sheet does not match the checked value | A calculated cell was typed over | Re-enter the order number. Don't edit calculated cells; use Custom deductions instead. |
| Custom deductions must be entered as a NEGATIVE number | A positive number was typed in Custom deductions | Enter it as negative, e.g. -500. |
| Enter the new sale's draft order number | Exchange Note chosen, but no draft number given | Ring up the new item as a draft in Shopify, then enter its number (#D…) in New Draft/Order #. |

### Blocked for Deduction only (Full Value still works)

| Message says | What it means | What to do |
|---|---|---|
| The metal weight of this piece is not recorded | No weight on the order or in the catalogue | Weigh the piece. Enter its **net** metal weight (gross weight minus stones) in **Weighed net gold wt**, and write why in **Final value override — reason**. Or use Full Value. |
| A weighed net weight was entered. Write the reason… | You entered a weight but no reason | Fill in the reason cell. |
| The diamond on this item has no current value anywhere | The listing is gone and the order never recorded a diamond price | Use Full Value. |
| No gold rate for this item | The karat can't be read. Usually a custom item with no listing | Put the matching catalogue SKU (e.g. NSP00001) in **Catalogue SKU (custom items only)**, with a reason. Or use Full Value. |
| mapped to catalogue SKU… Write the reason | You entered a catalogue SKU but no reason | Fill in the reason cell. |
| matches N listings — paste the exact one | The code you typed fits several tones or karats | Copy the exact SKU from the list shown into the Catalogue SKU cell. |
| works for one piece at a time | A weighed weight or catalogue SKU was entered with several pieces selected | Exchange those pieces one by one. |
| Could not read this product from Shopify | A temporary connection problem | Re-enter the order number. If it keeps happening, tell HQ. |
| Too many pieces to check together | Too many pieces selected in one go | Exchange them in smaller groups. |

---

## ⚠️ Read, then press Yes

None of these stop the exchange. They tell you where a figure came from so you can check the piece in front of you. Press **No** if something looks wrong.

| Message says | Check before pressing Yes |
|---|---|
| A voucher was already issued against this order | Make sure this piece wasn't already credited. Some vouchers are balance refunds, not returns. Ask HQ if unsure. |
| N of the pieces on this line were refunded | You are exchanging a piece that was not refunded. |
| The weight sold was not recorded… catalogue weight is used | If you can, weigh the piece. If it differs, enter the weighed net weight. |
| The order records X g, but the gold charged works out to Y g | Weigh the piece if the difference matters. |
| The variant sold has a new ID… same code | Nothing usually. The same design's current listing is being used. |
| No listing with the sold code exists… a DIFFERENT code | Check that the piece matches the listing named before you continue. |
| no current diamond price… valued at what was charged | Nothing usually. The diamond is credited at 80% of what was paid for it. |
| diamond credit is capped at what was paid for the piece less its gold | Old order with no stone price. The credit is limited to keep it fair. |
| more than the … paid ex-GST. The credit is held to … | Old order with no price breakup. The credit can't exceed what was paid excluding GST. If the piece is lighter than the catalogue says, weigh it. |
| The Deduction credit is more than … paid for this piece | Usually gold has gone up since the sale. Confirm it looks right. |
| Silver has no daily rate… valued at ₹X/g | Silver is credited at 100% of the metal at today's catalogue price. |
| The price breakup on this order does not add up | Full Value still credits exactly what Shopify recorded as charged. |
| Using the weight entered in store / custom item mapped to SKU… | Confirms your own entry and reason. |

---

## Old Gold

- With **Source = Old Gold**, the order section turns grey and refuses order numbers. Old Gold always issues a **Voucher**.
- With **Source = Purchase Exchange**, the Old Gold fields refuse input. Switch Source first.

## Quick decision guide

- **Test, cancelled, refunded, returned or already exchanged:** no exchange.
- **No weight on record:** weigh it, or use Full Value.
- **Silver:** fine. Deduction gives 100% of the metal.
- **Custom item with no listing:** map it to a catalogue SKU, or use Full Value.
- **Anything else unclear:** press No and call HQ. Nothing is issued until you press Yes.
