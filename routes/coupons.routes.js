const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { protect } = require('../middlewares/auth.middleware');
const { isSeller } = require('../middlewares/role.middleware');
const { sendSuccess, sendError } = require('../utils/response');

router.post('/', protect, isSeller, async (req, res) => {
  try {
    const { code, discount_percent, product_id, expiry_date, usage_limit } = req.body;
    if (!code || !discount_percent) return sendError(res, 400, 'code and discount_percent required');
    const pct = parseFloat(discount_percent);
    if (!(pct > 0 && pct <= 100)) return sendError(res, 400, 'discount_percent must be between 1 and 100');

    let expiry = null;
    if (expiry_date) {
      expiry = /^\d{4}-\d{2}-\d{2}$/.test(expiry_date)
        ? new Date(`${expiry_date}T23:59:59.999Z`)
        : new Date(expiry_date);
      if (isNaN(expiry.getTime())) return sendError(res, 400, 'Invalid expiry date');
      if (expiry < new Date()) return sendError(res, 400, 'Expiry date must be in the future');
    }

    const result = await db.query(
      `INSERT INTO coupons
         (code, discount_percent, discount_type, discount_value, product_id, seller_id,
          expiry_date, usage_limit, used_count, per_user_limit, start_date,
          admin_status, is_active, is_deleted)
       VALUES (UPPER($1), $2, 'percentage', $2, $3, $4, $5, $6, 0, 0, NULL,
               'active', true, false)
       RETURNING *`,
      [code, pct, product_id || null, req.user.id, expiry, parseInt(usage_limit, 10) || 0]
    );
    return sendSuccess(res, 201, 'Coupon created', { coupon: result.rows[0] });
  } catch (err) {
    console.error('Coupon create error:', err.message, err.code, err.detail);
    if (err.code === '23505') return sendError(res, 409, 'Coupon code already exists');
    return sendError(res, 500, err.message);
  }
});

module.exports = router;
