const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

// ─── Public helper ────────────────────────────────────────────────────────────
/**
 * Insert one activity entry.  Fails silently so it never breaks the caller.
 *
 * @param {object} opts
 * @param {string} opts.sellerId
 * @param {string} opts.type          – e.g. 'product_added'
 * @param {string} opts.title         – short human-readable headline
 * @param {string} [opts.detail]      – optional context
 * @param {string} [opts.entityId]    – UUID of the related product / order / etc.
 * @param {string} [opts.entityType]  – 'product' | 'order' | 'withdrawal'
 */
async function logActivity({ sellerId, type, title, detail, entityId, entityType }) {
  try {
    await db.query(
      `INSERT INTO seller_activity_log
         (seller_id, type, title, detail, entity_id, entity_type)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sellerId, type, title, detail || null, entityId || null, entityType || null]
    );
  } catch (err) {
    // Non-critical — log but never propagate
    console.warn('seller_activity_log insert failed:', err.message);
  }
}

// ─── GET /api/seller/activity ─────────────────────────────────────────────────
/**
 * @desc  Fetch recent activity for the authenticated seller
 * @route GET /api/seller/activity
 * @query limit  – default 50, max 200
 * @query offset – default 0
 * @access Private (seller only)
 */
const getSellerActivity = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const result = await db.query(
      `SELECT
         id, type, title, detail, entity_id AS "entityId",
         entity_type AS "entityType", created_at AS "createdAt"
       FROM seller_activity_log
       WHERE seller_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [sellerId, limit, offset]
    );

    const countRes = await db.query(
      `SELECT COUNT(*) AS total FROM seller_activity_log WHERE seller_id = $1`,
      [sellerId]
    );

    return sendSuccess(res, 200, 'Activity log fetched', {
      activities: result.rows,
      total: parseInt(countRes.rows[0].total),
    });
  } catch (error) {
    console.error('getSellerActivity error:', error);
    return sendError(res, 500, 'Error fetching activity log', error.message);
  }
};

module.exports = { logActivity, getSellerActivity };