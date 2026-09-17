# Pricing Logic

## Base Formula

subtotal = gold + diamond + making

gst = 3% of subtotal

final_price = subtotal + gst

## With Discount

discount applies ONLY to selected component

Example (diamond discount):

discount_amount = diamond * discount_rate

new_diamond = diamond - discount_amount

new_subtotal = gold + making + new_diamond

gst = 3% of new_subtotal

final_price = new_subtotal + gst

## Rules

- Gold is NEVER discounted
- Discount must be applied BEFORE GST
- GST always recalculated on final taxable value