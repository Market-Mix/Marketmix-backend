const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { protect } = require('../middlewares/auth.middleware');
const { sendSuccess, sendError } = require('../utils/response');
const { createDedupedNotification } = require('../controllers/notification.controller');

const PRODUCT_THRESHOLD = parseInt(process.env.PRODUCT_REPORT_THRESHOLD || '5', 10);
const STORE_THRESHOLD = parseInt(process.env.STORE_REPORT_THRESHOLD || '5', 10);
const WINDOW_DAYS = parseInt(process.env.REPORT_WINDOW_DAYS || '7', 10);
const REASONS = ['counterfeit', 'misleading', 'prohibited', 'offensive', 'scam', 'other'];

router.post('/product/:productId', protect, async (req, res) => {
  try {
    const { productId } = req.params;
    const { reason, details } = req.body;
    if (!REASONS.includes(reason)) return sendError(res, 400, 'Invalid reason');

    const productResult = await db.query(
      `SELECT seller_id FROM products WHERE id = $1 AND is_deleted = false`,
      [productId]
    );
    if (!productResult.rows.length) return sendError(res, 404, 'Product not found');
    const sellerId = productResult.rows[0].seller_id;

    await db.query(
      `INSERT INTO product_reports (product_id, seller_id, reporter_id, reason, details)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (product_id, reporter_id) DO NOTHING`,
      [productId, sellerId, req.user.id, reason, details || null]
    );

    const countResult = await db.query(
      `SELECT COUNT(*) FROM product_reports
       WHERE product_id = $1 AND created_at >= NOW() - INTERVAL '${WINDOW_DAYS} days'`,
      [productId]
    );
    const count = parseInt(countResult.rows[0].count, 10);

    if (count >= PRODUCT_THRESHOLD) {
      const actionResult = await db.query(
        `SELECT id FROM auto_moderation_actions
         WHERE target_type = 'product' AND target_id = $1
           AND created_at >= NOW() - INTERVAL '${WINDOW_DAYS} days'`,
        [productId]
      );
      if (!actionResult.rows.length) {
        await db.query(`UPDATE products SET is_active = false, updated_at = NOW() WHERE id = $1`, [productId]);
        await db.query(
          `UPDATE seller_profiles
           SET upload_restricted_until = NOW() + INTERVAL '7 days', upload_limit_per_week = 3
           WHERE user_id = $1`,
          [sellerId]
        );
        await db.query(
          `INSERT INTO auto_moderation_actions (target_type, target_id, seller_id, report_count, action_taken)
           VALUES ('product', $1, $2, $3, 'Product hidden; seller upload-restricted to 3/week for 7 days')`,
          [productId, sellerId, count]
        );
        await createDedupedNotification({
          userId: sellerId,
          title: 'Product Removed - Multiple Reports',
          message: `Your product was auto-removed after ${count} reports. You're limited to 3 uploads/week for 7 days.`,
          type: 'account',
          link: '/sellers/sellers%20product.html'
        });
      }
    }

    return sendSuccess(res, 201, 'Report submitted');
  } catch (error) {
    return sendError(res, 500, 'Error submitting report', error.message);
  }
});

router.post('/store/:storeId', protect, async (req, res) => {
  try {
    const { storeId } = req.params;
    const { reason, details } = req.body;
    if (!REASONS.includes(reason)) return sendError(res, 400, 'Invalid reason');

    const storeResult = await db.query(
      `SELECT user_id FROM stores WHERE id = $1 AND is_deleted = false`,
      [storeId]
    );
    if (!storeResult.rows.length) return sendError(res, 404, 'Store not found');
    const sellerId = storeResult.rows[0].user_id;

    await db.query(
      `INSERT INTO store_reports (store_id, seller_id, reporter_id, reason, details)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (store_id, reporter_id) DO NOTHING`,
      [storeId, sellerId, req.user.id, reason, details || null]
    );

    const countResult = await db.query(
      `SELECT COUNT(*) FROM store_reports
       WHERE store_id = $1 AND created_at >= NOW() - INTERVAL '${WINDOW_DAYS} days'`,
      [storeId]
    );
    const count = parseInt(countResult.rows[0].count, 10);

    if (count >= STORE_THRESHOLD) {
      const actionResult = await db.query(
        `SELECT id FROM auto_moderation_actions
         WHERE target_type = 'store' AND target_id = $1
           AND created_at >= NOW() - INTERVAL '${WINDOW_DAYS} days'`,
        [storeId]
      );
      if (!actionResult.rows.length) {
        const suspendedUntil = new Date(Date.now() + 14 * 86400000);
        await db.query(
          `UPDATE users
           SET is_suspended = true, suspended_until = $1,
               suspension_reason = $2, suspended_at = NOW()
           WHERE id = $3`,
          [suspendedUntil, `Store auto-suspended after ${count} reports - pending admin review`, sellerId]
        );
        await db.query(
          `UPDATE seller_profiles
           SET is_verified = false, kyc_status = 'rejected', updated_at = NOW()
           WHERE user_id = $1`,
          [sellerId]
        );
        await db.query(`UPDATE stores SET is_verified = false, updated_at = NOW() WHERE user_id = $1`, [sellerId]);
        await db.query(`UPDATE products SET is_active = false WHERE seller_id = $1`, [sellerId]);
        await db.query(
          `INSERT INTO auto_moderation_actions (target_type, target_id, seller_id, report_count, action_taken)
           VALUES ('store', $1, $2, $3, 'Seller auto-suspended 14d, KYC revoked, all products hidden - pending admin review')`,
          [storeId, sellerId, count]
        );
        await createDedupedNotification({
          userId: sellerId,
          title: 'Account Suspended - Multiple Reports',
          message: `Your store was reported ${count} times and has been suspended pending review. Your KYC was revoked - resubmit KYC to request reinstatement.`,
          type: 'account',
          link: '/sellers/kyc-verification.html'
        });
      }
    }

    return sendSuccess(res, 201, 'Report submitted');
  } catch (error) {
    return sendError(res, 500, 'Error submitting report', error.message);
  }
});

module.exports = router;
