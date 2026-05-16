/**
 * Vendor Shipping Settings Controller
 * Sellers configure their own delivery pricing and rules.
 *
 * Routes (all under /api/seller/shipping):
 *   GET    /        — get own settings
 *   POST   /        — create / upsert settings
 *   PUT    /:id     — update
 *   DELETE /:id     — deactivate
 */

const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

// GET /api/seller/shipping
const getShippingSettings = async (req, res) => {
  try {
    const sellerId = req.user.id;

    const result = await db.query(
      `SELECT * FROM vendor_shipping_settings WHERE seller_id = $1 ORDER BY created_at DESC`,
      [sellerId]
    );

    return sendSuccess(res, 200, 'Shipping settings fetched', { settings: result.rows });
  } catch (err) {
    console.error('getShippingSettings error:', err);
    return sendError(res, 500, 'Error fetching shipping settings', err.message);
  }
};

// POST /api/seller/shipping  (upsert)
const upsertShippingSettings = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const {
      base_fee,
      free_above,
      min_days,
      max_days,
      coverage_areas,   // array of strings: ['Lagos', 'Abuja']
      notes,
      is_active,
    } = req.body;

    if (base_fee === undefined || base_fee === null) {
      return sendError(res, 400, 'base_fee is required');
    }

    // Check for existing
    const existing = await db.query(
      `SELECT id FROM vendor_shipping_settings WHERE seller_id = $1 LIMIT 1`,
      [sellerId]
    );

    let result;
    if (existing.rows.length) {
      result = await db.query(
        `UPDATE vendor_shipping_settings SET
           base_fee       = $1,
           free_above     = $2,
           min_days       = $3,
           max_days       = $4,
           coverage_areas = $5,
           notes          = $6,
           is_active      = $7,
           updated_at     = NOW()
         WHERE seller_id = $8
         RETURNING *`,
        [
          parseFloat(base_fee),
          free_above ? parseFloat(free_above) : null,
          min_days || 1,
          max_days || 5,
          coverage_areas ? JSON.stringify(coverage_areas) : null,
          notes || null,
          is_active !== false,
          sellerId,
        ]
      );
    } else {
      result = await db.query(
        `INSERT INTO vendor_shipping_settings
           (seller_id, base_fee, free_above, min_days, max_days, coverage_areas, notes, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          sellerId,
          parseFloat(base_fee),
          free_above ? parseFloat(free_above) : null,
          min_days || 1,
          max_days || 5,
          coverage_areas ? JSON.stringify(coverage_areas) : null,
          notes || null,
          is_active !== false,
        ]
      );
    }

    return sendSuccess(res, 200, 'Shipping settings saved', { settings: result.rows[0] });
  } catch (err) {
    console.error('upsertShippingSettings error:', err);
    return sendError(res, 500, 'Error saving shipping settings', err.message);
  }
};

// PUT /api/seller/shipping/:id
const updateShippingSettings = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const { id }   = req.params;

    const ownership = await db.query(
      `SELECT id FROM vendor_shipping_settings WHERE id = $1 AND seller_id = $2`,
      [id, sellerId]
    );
    if (!ownership.rows.length) return sendError(res, 404, 'Settings not found');

    const {
      base_fee, free_above, min_days, max_days,
      coverage_areas, notes, is_active,
    } = req.body;

    const result = await db.query(
      `UPDATE vendor_shipping_settings SET
         base_fee       = COALESCE($1, base_fee),
         free_above     = $2,
         min_days       = COALESCE($3, min_days),
         max_days       = COALESCE($4, max_days),
         coverage_areas = COALESCE($5, coverage_areas),
         notes          = $6,
         is_active      = COALESCE($7, is_active),
         updated_at     = NOW()
       WHERE id = $8
       RETURNING *`,
      [
        base_fee ? parseFloat(base_fee) : null,
        free_above !== undefined ? (free_above ? parseFloat(free_above) : null) : undefined,
        min_days || null,
        max_days || null,
        coverage_areas ? JSON.stringify(coverage_areas) : null,
        notes !== undefined ? notes : undefined,
        is_active !== undefined ? is_active : null,
        id,
      ]
    );

    return sendSuccess(res, 200, 'Shipping settings updated', { settings: result.rows[0] });
  } catch (err) {
    console.error('updateShippingSettings error:', err);
    return sendError(res, 500, 'Error updating shipping settings', err.message);
  }
};

// DELETE /api/seller/shipping/:id  (soft-deactivate)
const deactivateShippingSettings = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const { id }   = req.params;

    const result = await db.query(
      `UPDATE vendor_shipping_settings SET is_active = false, updated_at = NOW()
       WHERE id = $1 AND seller_id = $2 RETURNING id`,
      [id, sellerId]
    );

    if (!result.rows.length) return sendError(res, 404, 'Settings not found');
    return sendSuccess(res, 200, 'Shipping settings deactivated');
  } catch (err) {
    console.error('deactivateShippingSettings error:', err);
    return sendError(res, 500, 'Error deactivating shipping settings', err.message);
  }
};

module.exports = {
  getShippingSettings,
  upsertShippingSettings,
  updateShippingSettings,
  deactivateShippingSettings,
};