'use strict';

/**
 * Outside-jewellery repair routes. Registered from registerRepairRoutes (../index.js).
 *
 *   POST /api/repairs/outside-intake   the intake form's Submit: writes the inspection, then tags
 *                                      the draft into the ordinary repair flow
 *   POST /api/repairs/photo            one intake photo (raw image body) → Shopify Files → CDN URL
 *
 * Both are called by the "Outside repair intake" admin action and authenticate with its session
 * token, exactly like /api/repairs/order-items.
 */

const express = require('express');
const { config } = require('../../../core/config');
const { getJson, putJson, postJson, graphql } = require('../../../core/shopify');
const { log } = require('../../../core/logger');
const { verifySessionToken } = require('../session_token');
const S = require('./specs');

const PAID_TAG = 'repair-intake';
const FREE_TAGS = ['free-repair', 'repair-free'];
// Present once the intake trigger has run for either class.
const INTAKE_DONE_TAGS = ['repair-hq-notified', 'repair-free-notified'];

const PHOTO_MAX_BYTES = 15 * 1024 * 1024;

function requireStaffSession(req, res, next) {
  try {
    const h = String(req.headers.authorization || '');
    verifySessionToken(h.startsWith('Bearer ') ? h.slice(7).trim() : '', {
      clientId: config.loyalty.mfmClientId,
      clientSecrets: config.loyalty.proxySecrets,
      shopDomain: config.shopify.storeUrl,
    });
    return next();
  } catch (e) {
    log.warn('outside-repair', `auth refused: ${e.message}`);
    return res.status(e.message === 'not configured' ? 503 : 401).json({ ok: false, error: `auth: ${e.message}` });
  }
}

// Upsert one draft metafield with an explicit type. The module's writeDraftOrderMetafields always
// writes single_line_text_field, which Shopify refuses for a key whose definition is a number, and
// a JSON record over 255 characters does not fit that type at all.
async function upsertDraftMetafield(draftId, namespace, key, type, value) {
  const { metafields = [] } = await getJson(`draft_orders/${draftId}/metafields.json`);
  const existing = metafields.find(m => m.namespace === namespace && m.key === key);
  if (existing) {
    await putJson(`metafields/${existing.id}.json`, { metafield: { id: existing.id, value: String(value), type } });
  } else {
    await postJson(`draft_orders/${draftId}/metafields.json`, { metafield: { namespace, key, type, value: String(value) } });
  }
}

// The tag set an outside intake leaves on the draft. The class tag is only added when the draft
// has none yet: staff may already have tagged it, and adding the other class would start both.
function intakeTags(currentTags, { repairClass, campaign }) {
  const tags = currentTags.filter(t => t !== S.MISSING_INSPECTION_TAG);
  const add = (t) => { if (t && !tags.includes(t)) tags.push(t); };
  add(S.OUTSIDE_TAG);
  add(S.campaignTag(campaign));
  const hasClass = tags.includes(PAID_TAG) || FREE_TAGS.some(t => tags.includes(t));
  if (!hasClass) add(repairClass === 'free' ? FREE_TAGS[0] : PAID_TAG);
  return tags;
}

async function outsideIntake(req, res) {
  const { draftId, inspection, repairClass, campaign } = req.body || {};
  const id = String(draftId || '').replace(/\D/g, '');
  if (!id) return res.status(400).json({ ok: false, error: 'draftId is required' });

  const missing = S.validateInspection(inspection);
  if (missing.length) return res.status(400).json({ ok: false, error: 'Inspection is incomplete', missing });

  try {
    const { draft_order: draft } = await getJson(`draft_orders/${id}.json`);
    if (!draft) return res.status(404).json({ ok: false, error: 'Draft order not found' });
    if (draft.status === 'completed') {
      return res.status(409).json({ ok: false, error: `${draft.name} is already completed` });
    }
    const tags = S.splitTags(draft.tags);
    if (!S.isOutside(tags) && INTAKE_DONE_TAGS.some(t => tags.includes(t))) {
      return res.status(409).json({ ok: false, error: `${draft.name} is already running as a Timanti repair` });
    }
    const line = draft.line_items?.[0];
    if (!line) {
      return res.status(400).json({ ok: false, error: 'Add the custom "repair" line to the draft first, then submit again.' });
    }

    // Metafields first. They fire no draft webhook, so the intake trigger cannot see the draft
    // until the single PUT below, which carries the props and the tags together. Two separate
    // writes would race the trigger's in-process lock and could leave the tagged pass skipped.
    await upsertDraftMetafield(id, 'custom', 'repair_inspection', 'json',
      JSON.stringify({ ...inspection, repairClass: repairClass === 'free' ? 'free' : 'paid', campaign: campaign || '', recordedAt: new Date().toISOString() }));
    await upsertDraftMetafield(id, 'custom', 'repair_intake_gross_weight', 'number_decimal',
      Number(inspection.grossWeight).toFixed(2));

    const existing = {};
    for (const p of (line.properties || [])) existing[p.name] = p.value;
    const props = S.buildOutsideProps(inspection);
    // Re-submitting to correct a detail must not move the moment the customer accepted the terms.
    if (existing._terms_ok) props._terms_ok = existing._terms_ok;
    const merged = Object.entries({ ...existing, ...props }).map(([name, value]) => ({ name, value: String(value) }));

    const newTags = intakeTags(tags, { repairClass, campaign });
    await putJson(`draft_orders/${id}.json`, { draft_order: { id: Number(id), tags: newTags.join(', '), line_items: [
      { id: line.id, title: line.title, quantity: line.quantity, price: line.price, properties: merged },
      ...draft.line_items.slice(1).map(li => ({ id: li.id })),
    ] } });

    const intakeAlreadySent = INTAKE_DONE_TAGS.some(t => tags.includes(t));
    log.info('outside-repair', `${draft.name}: inspection saved${intakeAlreadySent ? ' (update after intake)' : ''} — tags ${newTags.join(', ')}`);
    return res.json({ ok: true, draft: draft.name, tags: newTags, intakeAlreadySent });
  } catch (e) {
    log.error('outside-repair', `intake ${id}: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
    return res.status(502).json({ ok: false, error: 'Could not save the inspection to Shopify — try again.' });
  }
}

const STAGED_UPLOAD = `mutation($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;
const FILE_CREATE = `mutation($files: [FileCreateInput!]!) {
  fileCreate(files: $files) {
    files { id fileStatus }
    userErrors { field message }
  }
}`;
const FILE_READ = `query($id: ID!) { node(id: $id) { ... on MediaImage { fileStatus image { url } } } }`;

// Shopify Files is the store for intake photos: its CDN URL is what goes onto the line as
// _image_url, so the acknowledgement email and the repair note show the customer's own piece.
async function uploadToShopifyFiles(buffer, filename, mimeType) {
  const staged = await graphql(STAGED_UPLOAD, { input: [{
    resource: 'IMAGE', filename, mimeType, httpMethod: 'POST', fileSize: String(buffer.length),
  }] });
  const sErr = staged.stagedUploadsCreate.userErrors;
  if (sErr?.length) throw new Error(`stagedUploadsCreate: ${sErr.map(e => e.message).join('; ')}`);
  const target = staged.stagedUploadsCreate.stagedTargets[0];

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  const up = await fetch(target.url, { method: 'POST', body: form });
  if (!up.ok) throw new Error(`staged upload HTTP ${up.status}`);

  const created = await graphql(FILE_CREATE, { files: [{
    originalSource: target.resourceUrl, contentType: 'IMAGE', alt: 'Repair intake photo',
  }] });
  const cErr = created.fileCreate.userErrors;
  if (cErr?.length) throw new Error(`fileCreate: ${cErr.map(e => e.message).join('; ')}`);
  const fileId = created.fileCreate.files[0].id;

  // Processing is asynchronous; the URL appears within a few seconds.
  for (let i = 0; i < 15; i++) {
    const { node } = await graphql(FILE_READ, { id: fileId });
    if (node?.image?.url) return node.image.url;
    if (node?.fileStatus === 'FAILED') throw new Error('Shopify could not process the image');
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Shopify is still processing the image — try again in a moment');
}

async function uploadPhoto(req, res) {
  const buffer = req.body;
  const mimeType = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (!Buffer.isBuffer(buffer) || !buffer.length || !mimeType.startsWith('image/')) {
    return res.status(400).json({ ok: false, error: 'Send the image itself as the request body, with an image/* content type.' });
  }
  const ext = mimeType.split('/')[1] || 'jpg';
  const base = String(req.query.filename || '').replace(/[^\w.-]+/g, '_').slice(0, 60) || `repair-intake.${ext}`;
  const filename = `${Date.now()}-${base}`;
  try {
    const url = await uploadToShopifyFiles(buffer, filename, mimeType);
    log.info('outside-repair', `photo uploaded: ${filename} (${Math.round(buffer.length / 1024)} KB)`);
    return res.json({ ok: true, url });
  } catch (e) {
    log.error('outside-repair', `photo upload ${filename}: ${e.message}`);
    // An access-denied here means the middleware's token lacks write_files.
    return res.status(502).json({ ok: false, error: `Photo upload failed: ${e.message}` });
  }
}

function register(app) {
  app.post('/api/repairs/outside-intake', requireStaffSession, outsideIntake);
  // The global JSON parser ignores image bodies and caps at 100 KB, so this route reads its own.
  app.post('/api/repairs/photo', requireStaffSession,
    express.raw({ type: 'image/*', limit: PHOTO_MAX_BYTES }), uploadPhoto);
}

module.exports = { register, intakeTags };
