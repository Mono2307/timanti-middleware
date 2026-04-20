# Data Model

## Input (from Shopify Variant Metafields)

- gold_price
- diamond_price
- making_price
- metal_kt (14 / 18)
- gst_rate (default 3%)

## Request Payload

{
  variant_id: string,
  quantity: number,
  discount: {
    type: string,
    value: number
  }
}

## Response Payload

{
  gold: number,
  diamond: number,
  making: number,
  discount: number,
  subtotal: number,
  gst: number,
  final_price: number
}


## Updated Input Sources

- gold_price (variant level, precomputed)
- diamond_price (aggregated stones)
- making_price

## New Fields

- list_price (Shopify variant price)
- computed_price (gold + diamond + making)

## Output Additions

{
  ...
  list_price: number,
  computed_price: number,
  final_price: number,
  discount_type: string
}