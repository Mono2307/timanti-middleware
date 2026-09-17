# Objective

Build a centralized pricing engine for jewellery products that:

- Computes final selling price using:
  - Gold value
  - Diamond value
  - Making charges
  - GST (3%)

- Applies selective discounts:
  - Primarily on diamond
  - Extendable to making charges

- Outputs:
  - Final price (tax inclusive)
  - Full component breakdown

## Key Principle

Shopify is NOT responsible for pricing logic.

This service computes final price BEFORE order creation.

## Phase 1 Scope (Critical)

- Offline (POS + Draft Orders) only
- No storefront or checkout integration
- No GoKwik dependency

## Phase 2 (Future)

- Online integration via Buy Now → Draft Order → Checkout