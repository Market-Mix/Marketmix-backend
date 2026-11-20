const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const { generateJSON } = require('../services/ai.service');
const { LISTING_SYSTEM } = require('../ai/prompts');

const clip = (value, length) => String(value || '').trim().slice(0, length);

const logUsage = (sellerId, task, tokens, status) =>
  db.query(
    'INSERT INTO ai_usage (seller_id, task, tokens, status) VALUES ($1, $2, $3, $4)',
    [sellerId, task, tokens, status]
  ).catch((error) => console.warn('ai_usage log failed:', error.message));

function sanitizeFields(schema, output = {}) {
  const clean = {};
  if (!output || typeof output !== 'object' || Array.isArray(output)) output = {};
  for (const field of schema) {
    if (!field || typeof field.key !== 'string') continue;
    const value = output[field.key];
    if (value === undefined || value === null || value === '') continue;

    const options = Array.isArray(field.options) ? field.options : [];
    if (field.type === 'select') {
      if (options.includes(value)) clean[field.key] = value;
    } else if (field.type === 'multiselect') {
      const values = (Array.isArray(value) ? value : [value]).filter((item) => options.includes(item));
      if (values.length) clean[field.key] = values;
    } else if (field.type === 'tags') {
      const values = (Array.isArray(value) ? value : [value])
        .map((item) => clip(item, 30))
        .filter(Boolean)
        .slice(0, 8);
      if (values.length) clean[field.key] = values;
    } else {
      clean[field.key] = clip(value, 100);
    }
  }
  return clean;
}

// POST /api/seller/ai/listing
const generateListing = async (req, res) => {
  const sellerId = req.user.id;
  try {
    const name = clip(req.body.name, 120);
    if (name.length < 3) return sendError(res, 400, 'Product name is required (min 3 chars)');
    const notes = clip(req.body.notes, 500);
    const { category_id, subcategory_id } = req.body;

    let categoryName = null;
    let schema = [];
    if (category_id) {
      const category = await db.query(
        'SELECT name FROM categories WHERE id = $1 AND is_deleted = false',
        [category_id]
      );
      categoryName = category.rows[0]?.name || null;
    }
    if (subcategory_id) {
      const subcategory = await db.query(
        'SELECT name, fields FROM subcategories WHERE id = $1 AND is_active = true',
        [subcategory_id]
      );
      if (subcategory.rows[0]) {
        categoryName = [categoryName, subcategory.rows[0].name].filter(Boolean).join(' > ');
        const fields = subcategory.rows[0].fields;
        schema = typeof fields === 'string' ? JSON.parse(fields) : (fields || []);
        if (!Array.isArray(schema)) throw new Error('Invalid subcategory fields schema');
      }
    }

    const prompt = JSON.stringify({
      product_name: name,
      category: categoryName,
      seller_notes: notes || null,
      dynamic_fields_schema: schema.map(({ key, label, type, options }) => ({ key, label, type, options }))
    });

    const { json, tokens } = await generateJSON({ system: LISTING_SYSTEM, prompt, maxTokens: 900 });
    await logUsage(sellerId, 'listing', tokens, 'ok');

    return sendSuccess(res, 200, 'Listing draft generated', {
      draft: {
        title: clip(json?.title, 80),
        description: clip(json?.description, 1500),
        keywords: (Array.isArray(json?.keywords) ? json.keywords : [])
          .map((keyword) => clip(keyword, 30))
          .filter(Boolean)
          .slice(0, 8),
        dynamic_fields: sanitizeFields(schema, json?.dynamic_fields)
      },
      quota: { used: req.aiQuota.used + 1, limit: req.aiQuota.limit }
    });
  } catch (error) {
    await logUsage(sellerId, 'listing', 0, 'error');
    console.error('generateListing error:', error.message);
    return sendError(
      res,
      error.status || 500,
      error.status === 429 ? 'AI is busy, try again in a minute' : 'Could not generate listing',
      error.message
    );
  }
};

// GET /api/seller/ai/quota
const getQuota = (req, res) =>
  sendSuccess(res, 200, 'Quota', { quota: req.aiQuota });

module.exports = { generateListing, getQuota };
