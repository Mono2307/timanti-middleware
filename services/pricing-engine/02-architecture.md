# Architecture Overview

## Core Components

1. Pricing Engine (this service)
2. Shopify Admin API (draft orders)
3. POS system

## Flow (Phase 1 - Offline)

POS → Pricing Engine → Draft Order → POS Payment → Webhook → Complete Order

## Responsibilities

### Pricing Engine
- Compute price
- Apply discount logic
- Return structured breakdown

### Shopify
- Store draft order
- Handle payment + order lifecycle

## Design Constraint

Pricing engine must be:
- Stateless
- Deterministic
- Channel-agnostic