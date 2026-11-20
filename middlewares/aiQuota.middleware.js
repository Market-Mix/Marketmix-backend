const db = require('../config/db');
const { sendError } = require('../utils/response');

const DAILY_LIMIT = parseInt(process.env.AI_DAILY_LIMIT || '10', 10);

const aiQuota = async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT COUNT(*) FROM ai_usage
       WHERE seller_id = $1 AND status = 'ok'
         AND created_at >= (date_trunc('day', NOW() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos')`,
      [req.user.id]
    );
    const used = parseInt(r.rows[0].count, 10);
    if (used >= DAILY_LIMIT) {
      return sendError(res, 429, `Daily AI limit reached (${DAILY_LIMIT}). Resets at midnight.`);
    }
    req.aiQuota = { used, limit: DAILY_LIMIT };
    return next();
  } catch (error) {
    return sendError(res, 500, 'Quota check failed', error.message);
  }
};

module.exports = { aiQuota, DAILY_LIMIT };
