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
    
    const result = await db.query(
      `INSERT INTO coupons (code, discount_percent, product_id, seller_id, expiry_date, usage_limit)
       VALUES (UPPER($1), $2, $3, $4, $5, $6) RETURNING *`,
      [code, discount_percent, product_id || null, req.user.id, expiry_date || null, usage_limit || 0]
    );
    return sendSuccess(res, 201, 'Coupon created', { coupon: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return sendError(res, 409, 'Coupon code already exists');
    return sendError(res, 500, 'Error creating coupon', err.message);
  }
});

module.exports = router;
