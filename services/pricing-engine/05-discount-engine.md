# Discount Engine

## Supported Types (Phase 1)

- diamond_percent
- diamond_flat

## Future Support

- making_percent
- making_flat
- hybrid (diamond + making)

## Constraints

- No discount on gold
- Discount cannot exceed component value

## Example

diamond = 5000
discount = 20%

→ discount_amount = 1000
→ new_diamond = 4000


# Discount Engine (Expanded)

## Supported Types (Phase 1)

1. diamond_percent
2. diamond_flat
3. making_percent
4. making_flat

## Shopify-Compatible Mapping (Future)

- order_percent → mapped to diamond absorption
- order_flat → mapped to diamond absorption

## Rule

All "order-level discounts" MUST be absorbed into:
→ diamond first
→ then making (if needed in future)