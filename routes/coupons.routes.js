const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { protect } = require('../middlewares/auth.middleware');
const { isSeller } = require('../middlewares/role.middleware');
const { sendSuccess, sendError } = require('../utils/response');

router.use(protect, isSeller);

router.post('/', async (req, res) => {
  const { code, discount_percent, product_id, expiry_date, usage_limit } = req.body;
  const sellerId = req.user.id;
  if (!code || !discount_percent) return sendError(res, 400, 'code and discount_percent required');
  if (discount_percent < 1 || discount_percent > 100) return sendError(res, 400, 'Discount must be 1-100%');
  try {
    const exists = await db.query(`SELECT id FROM coupons WHERE UPPER(code) = UPPER($1)`, [code]);
    if (exists.rows.length) return sendError(res, 409, 'Coupon code already exists');
    const result = await db.query(
      `INSERT INTO coupons (code, discount_percent, seller_id, product_id, expiry_date, usage_limit, used_count, is_active, created_at)
       VALUES (UPPER($1), $2, $3, $4, $5, $6, 0, true, NOW()) RETURNING *`,
      [code, discount_percent, sellerId, product_id || null, expiry_date || null, usage_limit || 0]
    );
    return sendSuccess(res, 201, 'Coupon created', { coupon: result.rows[0] });
  } catch (err) {
    return sendError(res, 500, 'Error creating coupon', err.message);
  }
});

router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM coupons WHERE seller_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    return sendSuccess(res, 200, 'Coupons fetched', { coupons: result.rows });
  } catch (err) {
    return sendError(res, 500, 'Error fetching coupons', err.message);
  }
});

module.exports = router;
