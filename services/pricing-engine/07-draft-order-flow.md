# Draft Order Flow

## Steps

1. Call pricing engine
2. Receive final_price + breakdown
3. Create draft order
## Draft Order Requirements

- Use computed final_price as line item price
- Attach breakdown as line item properties

## Example Properties

Gold: 10000
Diamond: 5000
Discount: -1000
Making: 2000
GST: 480

## Reporting Compatibility Requirement

Draft order must:

- Use final_price as line item price
- Store original list_price
- Store computed_price
- Store discount metadata

This ensures Shopify reports remain usable.