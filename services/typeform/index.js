// Typeform -> Shopify Customer sync.
// In-store capture form posts here; we resolve/create the Shopify customer,
// upsert profile metafields (namespace `custom`), and tag TYPEFORM.
//
// Auth: HMAC SHA-256 over the raw body, compared to the Typeform-Signature
// header. Enforced only when TYPEFORM_WEBHOOK_SECRET is set (so the endpoint
// can be smoke-tested before the secret is configured).
//
// Wire-up in server.js:
//   const { handleTypeformWebhook } = require('./services/typeform');
//   app.post('/api/webhooks/typeform/customer-capture',
//     (req, res) => handleTypeformWebhook(req, res, { supabase, getShopifyToken }));

const crypto = require('crypto');
const axios  = require('axios');

const SHOPIFY_API = '2025-01';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
// Returns true (valid), false (present but wrong), or null (cannot verify).
function verifyTypeformSignature(rawBody, header, secret) {
  if (!secret) return null;
  if (!header) return false;
  const digest   = crypto.createHmac('sha256', secret).update(rawBody || '', 'utf8').digest('base64');
  const expected = 'sha256=' + digest;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Payload mapping
// ---------------------------------------------------------------------------
// Typeform answers reference fields by id/ref, never by title. We read titles
// from form_response.definition.fields and classify by keyword. answer.type is
// used to disambiguate (e.g. which date is the birthday) and to pull the value.

function getAnswerValue(answer) {
  switch (answer.type) {
    case 'text':
    case 'short_text':
    case 'long_text':   return answer.text;
    case 'email':       return answer.email;
    case 'phone_number':return answer.phone_number;
    case 'date':        return answer.date;
    case 'number':      return answer.number;
    case 'boolean':     return answer.boolean;
    case 'choice':      return answer.choice && (answer.choice.label || answer.choice.other);
    case 'choices':     return answer.choices && [].concat(answer.choices.labels || [], answer.choices.other || []).filter(Boolean).join(', ');
    case 'url':         return answer.url;
    default:            return answer.text ?? answer.email ?? answer.phone_number ?? answer.date ?? null;
  }
}

// Ordered, most-specific-first. First matching rule wins per field.
// Order matters: "Store Staff Comments" must hit `staff_comments` before the
// `captured_by` (`store staff`) rule, and "Store Staff Name" must hit
// `captured_by` before the bare-`store` `store_location` rule.
const FIELD_RULES = [
  ['staff_comments',   /comment|remark/i],
  ['captured_by',      /staff\s*name|captured\s*by|associate|staff\s*member|store\s*staff/i],
  ['store_location',   /store\s*location|\blocation\b|branch|outlet|\bstore\b/i],
  ['pincode',          /pin\s*code|pincode|postal|\bzip\b|where do you (stay|live)/i],
  ['birthday',         /birth\s*day|birthday|\bdob\b|date of birth/i],
  ['anniversary',      /anniversary/i],
  ['lead_source',      /hear about|how did you|lead\s*source|\bsource\b|find us|refer/i],
  ['product_interest', /\bproducts?\b|\binterest|looking for/i],
  ['marketing_consent',/consent|marketing|subscrib|opt[\s-]?in|newsletter|promotion/i],
  ['email',            /e-?mail/i],
  ['phone',            /phone|mobile|contact\s*number|whats\s*app|whatsapp/i],
  ['name',             /\bname\b|full name|your name/i],
];

// Fallback by answer type when the title matched nothing.
const TYPE_FALLBACK = { email: 'email', phone_number: 'phone', boolean: 'marketing_consent' };

function normalizePhone(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  const last10 = digits.slice(-10);
  if (last10.length !== 10) return null;
  return '+91' + last10;
}

function truthyConsent(v) {
  if (typeof v === 'boolean') return v;
  return /^(y|yes|true|i agree|agree|subscribe|opt[\s-]?in|1)/i.test(String(v || '').trim());
}

function mapSubmission(body) {
  const fr        = body.form_response || {};
  const fields    = (fr.definition && fr.definition.fields) || [];
  const metaById  = {};
  for (const f of fields) {
    const title = f.title || '';
    // Titles can be vague ("Where do you stay?"); the hint often lives in the
    // description. Match against both when the payload carries a description.
    const desc  = f.description || (f.properties && f.properties.description) || '';
    metaById[f.id] = { title, text: `${title} ${desc}`.trim() };
  }

  const out      = {};
  const unmapped = [];

  for (const answer of (fr.answers || [])) {
    const fieldId = answer.field && answer.field.id;
    const meta    = metaById[fieldId] || { title: '', text: '' };
    const title   = meta.title;
    const value   = getAnswerValue(answer);

    let target = null;
    for (const [key, rx] of FIELD_RULES) {
      if (rx.test(meta.text)) { target = key; break; }
    }
    if (!target) target = TYPE_FALLBACK[answer.type] || null;

    if (!target) { unmapped.push({ title, type: answer.type, value }); continue; }
    // Don't clobber an earlier, more-confident answer for the same target.
    if (out[target] == null || out[target] === '') out[target] = value;
  }

  return {
    name:             out.name != null ? String(out.name).trim() : null,
    email:            out.email != null ? String(out.email).trim().toLowerCase() : null,
    phone:            normalizePhone(out.phone),
    marketingConsent: out.marketing_consent != null ? truthyConsent(out.marketing_consent) : null,
    metafields: {
      pincode:          out.pincode,
      birthday:         out.birthday,
      anniversary:      out.anniversary,
      lead_source:      out.lead_source,
      product_interest: out.product_interest,
      staff_comments:   out.staff_comments,
      store_location:   out.store_location,
      captured_by:      out.captured_by,
    },
    unmapped,
  };
}

function buildMetafields(mf) {
  const defs = [
    ['pincode',          'single_line_text_field', mf.pincode],
    ['birthday',         'date',                    mf.birthday],
    ['anniversary',      'date',                    mf.anniversary],
    ['lead_source',      'single_line_text_field', mf.lead_source],
    ['product_interest', 'single_line_text_field', mf.product_interest],
    ['staff_comments',   'multi_line_text_field',  mf.staff_comments],
    ['store_location',   'single_line_text_field', mf.store_location],
    ['captured_by',      'single_line_text_field', mf.captured_by],
  ];
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim());
  return defs
    .filter(([, type, v]) => v != null && String(v).trim() !== '' && (type !== 'date' || isDate(v)))
    .map(([key, type, value]) => ({ namespace: 'custom', key, type, value: String(value).trim() }));
}

// ---------------------------------------------------------------------------
// Shopify GraphQL
// ---------------------------------------------------------------------------
async function gql(token, query, variables) {
  const resp = await axios.post(
    `${process.env.SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API}/graphql.json`,
    { query, variables },
    { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  if (resp.data && resp.data.errors && resp.data.errors.length) {
    throw new Error('GraphQL: ' + JSON.stringify(resp.data.errors));
  }
  return resp.data.data;
}

async function findCustomerId(token, { email, phone }) {
  const search = async (q) => {
    const data = await gql(token,
      `query($q:String!){ customers(first:1, query:$q){ edges{ node{ id } } } }`,
      { q });
    const edge = data.customers.edges[0];
    return edge ? edge.node.id : null;
  };
  if (email) { const id = await search(`email:"${email}"`); if (id) return id; }
  if (phone) { const id = await search(`phone:"${phone}"`); if (id) return id; }
  return null;
}

function consentInput(consent) {
  if (consent == null) return undefined;
  return consent
    ? { marketingState: 'SUBSCRIBED',   marketingOptInLevel: 'SINGLE_OPT_IN' }
    : { marketingState: 'UNSUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN' };
}

// Run a customer mutation, retrying once while stripping fields that Shopify
// rejects (phone already taken, or no permission for marketing consent).
async function runCustomerMutation(token, mutationName, input) {
  const mutation = `mutation customer($input: CustomerInput!){
    ${mutationName}(input: $input){ customer{ id } userErrors{ field message } } }`;
  let attempt = { ...input };
  for (let i = 0; i < 3; i++) {
    const data   = await gql(token, mutation, { input: attempt });
    const result = data[mutationName];
    const errs   = result.userErrors || [];
    if (!errs.length && result.customer) return result.customer.id;

    const blob = JSON.stringify(errs).toLowerCase();
    if (/phone/.test(blob) && attempt.phone) { delete attempt.phone; continue; }
    if (/(consent|marketing)/.test(blob) && attempt.emailMarketingConsent) { delete attempt.emailMarketingConsent; continue; }
    throw new Error(`${mutationName} userErrors: ${JSON.stringify(errs)}`);
  }
  throw new Error(`${mutationName}: exhausted retries`);
}

async function addTag(token, customerId, tag) {
  const data = await gql(token,
    `mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id, tags:$tags){ userErrors{ field message } } }`,
    { id: customerId, tags: [tag] });
  const errs = data.tagsAdd.userErrors || [];
  if (errs.length) throw new Error('tagsAdd: ' + JSON.stringify(errs));
}

// ---------------------------------------------------------------------------
// Logging / idempotency (tolerant of the table not existing yet)
// ---------------------------------------------------------------------------
const TABLE = 'typeform_submissions';

function tableMissing(error) {
  return error && (error.code === '42P01' || /relation .* does not exist|could not find the table/i.test(error.message || ''));
}

async function alreadyProcessed(supabase, eventId) {
  if (!eventId) return false;
  const { data, error } = await supabase.from(TABLE).select('id,success').eq('event_id', eventId).maybeSingle();
  if (error) { if (!tableMissing(error)) console.warn('[typeform] idempotency check failed:', error.message); return false; }
  return !!(data && data.success);
}

async function logSubmission(supabase, row) {
  const { error } = await supabase.from(TABLE).upsert(row, { onConflict: 'event_id' });
  if (error && !tableMissing(error)) console.warn('[typeform] log write failed:', error.message);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
async function handleTypeformWebhook(req, res, { supabase, getShopifyToken }) {
  const startedAt = Date.now();

  // 1. Auth
  const secret  = process.env.TYPEFORM_WEBHOOK_SECRET;
  const verdict = verifyTypeformSignature(req.rawBody, req.headers['typeform-signature'], secret);
  if (secret && verdict === false) {
    console.warn('[typeform] rejected: invalid signature');
    return res.status(401).json({ error: 'invalid signature' });
  }
  if (!secret) console.warn('[typeform] TYPEFORM_WEBHOOK_SECRET not set — signature check skipped');

  // 2. Parse body (express.json gives an object; tolerate a raw string too)
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'invalid JSON' }); } }
  if (!body || !body.form_response) {
    return res.status(400).json({ error: 'not a Typeform form_response payload' });
  }

  const eventId     = body.event_id || (body.form_response && body.form_response.token) || null;
  const submittedAt = body.form_response.submitted_at || null;

  // 3. Idempotency
  if (await alreadyProcessed(supabase, eventId)) {
    return res.status(200).json({ status: 'duplicate', event_id: eventId });
  }

  // 4. Map
  const mapped = mapSubmission(body);
  if (mapped.unmapped.length) {
    console.warn('[typeform] unmapped fields:', JSON.stringify(mapped.unmapped.map(u => u.title)));
  }
  if (!mapped.email && !mapped.phone) {
    await logSubmission(supabase, {
      event_id: eventId, submitted_at: submittedAt, success: false,
      error: 'missing email and phone', raw: body, duration_ms: Date.now() - startedAt,
    });
    return res.status(422).json({ error: 'customer requires email or phone' });
  }

  // 5. Resolve -> create/update -> metafields -> tag
  try {
    const token      = await getShopifyToken();
    const metafields = buildMetafields(mapped.metafields);
    const consent    = consentInput(mapped.marketingConsent);

    let customerId = await findCustomerId(token, { email: mapped.email, phone: mapped.phone });
    let action;

    if (customerId) {
      action = 'UPDATE';
      const input = { id: customerId };
      if (mapped.name)        input.firstName = mapped.name;
      if (mapped.phone)       input.phone = mapped.phone;
      if (consent)            input.emailMarketingConsent = consent;
      if (metafields.length)  input.metafields = metafields;
      customerId = await runCustomerMutation(token, 'customerUpdate', input);
      await addTag(token, customerId, 'TYPEFORM');
    } else {
      action = 'CREATE';
      const input = { tags: ['TYPEFORM'] };
      if (mapped.name)        input.firstName = mapped.name;
      if (mapped.email)       input.email = mapped.email;
      if (mapped.phone)       input.phone = mapped.phone;
      if (consent)            input.emailMarketingConsent = consent;
      if (metafields.length)  input.metafields = metafields;
      customerId = await runCustomerMutation(token, 'customerCreate', input);
    }

    const durationMs = Date.now() - startedAt;
    await logSubmission(supabase, {
      event_id: eventId, submitted_at: submittedAt, email: mapped.email, phone: mapped.phone,
      shopify_customer_id: customerId, action, success: true, duration_ms: durationMs, raw: body,
    });

    console.log(`[typeform] ${action} ${customerId} (${durationMs}ms) email=${mapped.email || '-'} phone=${mapped.phone || '-'} mf=${metafields.length}`);
    return res.status(200).json({ status: 'ok', action, customer_id: customerId, metafields_written: metafields.length });
  } catch (err) {
    const message = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error('[typeform] Shopify failure:', message);
    await logSubmission(supabase, {
      event_id: eventId, submitted_at: submittedAt, email: mapped.email, phone: mapped.phone,
      success: false, error: message, raw: body, duration_ms: Date.now() - startedAt,
    });
    return res.status(500).json({ error: 'shopify operation failed', detail: message });
  }
}

module.exports = { handleTypeformWebhook, verifyTypeformSignature, mapSubmission, buildMetafields, normalizePhone };
