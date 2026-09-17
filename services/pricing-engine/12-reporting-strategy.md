# Reporting Strategy

## Goals

- Maintain Shopify compatibility for:
  - Gross sales
  - Net sales
  - Discounts

## Approach

- Shopify sees ONLY final_price
- All breakdown stored in line item properties

## Discount Tracking

Store:

- discount_type
- discount_value
- discount_code (if applicable)

## Future

Custom reports can parse line item properties if needed