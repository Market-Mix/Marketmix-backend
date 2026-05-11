const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * Insert one activity entry scoped to a store.
 * storeId is optional — callers without a store context can omit it.
 */
async function logActivity({ sellerId, storeId = null, type, title, detail, entityId, entityType }) {
  try {
    await db.query(
      `INSERT INTO seller_activity_log
         (seller_id, store_id, type, title, detail, entity_id, entity_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sellerId, storeId || null, type, title, detail || null, entityId || null, entityType || null]
    );
  } catch (err) {
    console.warn('seller_activity_log insert failed:', err.message);
  }
}

/**
 * @desc  Fetch recent activity for the authenticated seller, scoped to active store
 * @route GET /api/seller/activity
 * @query storeId  — filter to a specific store (via X-Store-Id header or ?storeId param)
 * @query limit, offset
 */
const getSellerActivity = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const storeId  = req.headers['x-store-id'] || req.query.storeId || null;
    const limit    = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset   = parseInt(req.query.offset) || 0;

    let where  = `WHERE seller_id = $1`;
    const params = [sellerId];
    let idx = 2;

    if (storeId) {
      where += ` AND (store_id = $${idx++} OR store_id IS NULL)`;
      params.push(storeId);
    }

    const result = await db.query(
      `SELECT
         id, store_id AS "storeId", type, title, detail,
         entity_id AS "entityId", entity_type AS "entityType",
         created_at AS "createdAt"
       FROM seller_activity_log
       ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset]
    );

    const countRes = await db.query(
      `SELECT COUNT(*) AS total FROM seller_activity_log ${where}`,
      params
    );

    return sendSuccess(res, 200, 'Activity log fetched', {
      activities: result.rows,
      total: parseInt(countRes.rows[0].total),
    });
  } catch (err) {
    console.error('getSellerActivity error:', err);
    return sendError(res, 500, 'Error fetching activity log', err.message);
  }
};

module.exports = { logActivity, getSellerActivity };