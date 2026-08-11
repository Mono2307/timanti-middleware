const assert = require('assert');

// Enough env to construct the module graph; nothing here dials out.
process.env.SUPABASE_URL         ||= 'https://metafields-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://metafields-test.invalid';
const { getMetafieldType } = require('./metafields');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// Why this file exists: Shopify rejects a metafield write whose type does not match the existing
// definition, and the writer swallows the error so the caller sees success. A wrong type here is
// therefore a SILENT data loss — the value simply never lands. These assertions pin every key the
// system writes, so moving this function between files can never quietly change a type.

console.log('getMetafieldType — money fields must be number_decimal');
for (const k of ['amount_paid', 'amount_paid_final', 'amount_pending', 'exchange_note_value',
                 'voucher_value', 'amount_to_be_collected', 'old_gold_value', 'old_gold_weight',
                 'old_gold_purity', 'gross_value', 'discount_applied', 'discount_rate', 'advance']) {
  t(k, () => assert.strictEqual(getMetafieldType(k), 'number_decimal'));
}

console.log('positional CSV fields must stay TEXT, not numeric');
// gold_rate and making carry a comma-separated list ("9713,10200") for multi-product reprice.
// Making either numeric would reject every multi-line draft.
t('gold_rate is text', () => assert.strictEqual(getMetafieldType('gold_rate'), 'single_line_text_field'));
t('making is text',    () => assert.strictEqual(getMetafieldType('making'),    'single_line_text_field'));

console.log('installment legs');
t('installment_1_value is number_decimal', () => assert.strictEqual(getMetafieldType('installment_1_value'), 'number_decimal'));
t('installment_4_value is number_decimal', () => assert.strictEqual(getMetafieldType('installment_4_value'), 'number_decimal'));
t('installment_2_date is date',            () => assert.strictEqual(getMetafieldType('installment_2_date'),  'date'));
t('installment_1_mode falls through to text', () => assert.strictEqual(getMetafieldType('installment_1_mode'), 'single_line_text_field'));
t('installment_1_type falls through to text', () => assert.strictEqual(getMetafieldType('installment_1_type'), 'single_line_text_field'));
t('installment_0_value is NOT matched (slots are 1-based)', () =>
  assert.strictEqual(getMetafieldType('installment_0_value'), 'single_line_text_field'));

console.log('typed singletons');
t('is_finalized is boolean',        () => assert.strictEqual(getMetafieldType('is_finalized'),   'boolean'));
t('gold_rate_date is date_time',    () => assert.strictEqual(getMetafieldType('gold_rate_date'), 'date_time'));
t('advance_date is date',           () => assert.strictEqual(getMetafieldType('advance_date'),   'date'));
t('serial_no is number_integer',    () => assert.strictEqual(getMetafieldType('serial_no'),      'number_integer'));

console.log('default');
t('an unknown key is text, never numeric', () =>
  assert.strictEqual(getMetafieldType('something_new'), 'single_line_text_field'));
t('empty key does not throw', () =>
  assert.strictEqual(getMetafieldType(''), 'single_line_text_field'));

console.log(`\n${n} assertions passed`);
