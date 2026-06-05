const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const { protect } = require('../middlewares/auth.middleware');

// GET /api/refund-chat/:caseId — fetch messages
router.get('/:caseId', protect, async (req, res) => {
  try {
    const { caseId } = req.params;
    const userId = req.user.id;

    // Verify user is buyer or seller of this case
    const access = await db.query(
      `SELECT rc.id FROM refund_cases rc
       JOIN order_items oi ON oi.order_id = rc.order_id::uuid
       WHERE rc.id = $1
         AND (rc.buyer_id = $2 OR rc.seller_id = $2 OR oi.seller_id = $2)
       LIMIT 1`,
      [caseId, userId]
    );
    if (!access.rows.length) return sendError(res, 403, 'Access denied');

    const msgs = await db.query(
      `SELECT id, sender_id, sender_type, message, file_url, file_type, is_read, created_at
       FROM refund_messages
       WHERE refund_case_id = $1
       ORDER BY created_at ASC`,
      [caseId]
    );

    // Mark unread messages from other party as read
    await db.query(
      `UPDATE refund_messages SET is_read = true
       WHERE refund_case_id = $1 AND sender_id != $2 AND is_read = false`,
      [caseId, userId]
    );

    return sendSuccess(res, 200, 'Messages fetched', { messages: msgs.rows });
  } catch (err) {
    console.error('refund-chat GET error:', err);
    return sendError(res, 500, 'Error fetching messages', err.message);
  }
});

// POST /api/refund-chat/:caseId — send message
router.post('/:caseId', protect, async (req, res) => {
  try {
    const { caseId } = req.params;
    const userId = req.user.id;
    const { message_text, file_url, file_type } = req.body;

    if (!message_text && !file_url) return sendError(res, 400, 'Message or file required');

    // Determine sender_type and verify access
    const caseRes = await db.query(
      `SELECT buyer_id, seller_id FROM refund_cases WHERE id = $1`,
      [caseId]
    );
    if (!caseRes.rows.length) return sendError(res, 404, 'Case not found');

    const c = caseRes.rows[0];
    let senderType = null;
    if (c.buyer_id === userId) senderType = 'buyer';
    else if (c.seller_id === userId) senderType = 'seller';
    else return sendError(res, 403, 'Access denied');

    const result = await db.query(
      `INSERT INTO refund_messages
         (refund_case_id, sender_id, sender_type, message, file_url, file_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [caseId, userId, senderType, message_text || null, file_url || null, file_type || null]
    );

    const msg = result.rows[0];

    // Notify the other party
    const notifyUserId = senderType === 'buyer' ? c.seller_id : c.buyer_id;
    if (notifyUserId) {
      await db.query(
        `INSERT INTO notifications
           (user_id, title, message, type, is_read, is_deleted, created_at, updated_at)
         VALUES ($1, $2, $3, 'refund', false, false, NOW(), NOW())`,
        [
          notifyUserId,
          'New message in refund case',
          message_text ? message_text.substring(0, 100) : 'Media shared'
        ]
      ).catch(() => {});
    }

    return sendSuccess(res, 201, 'Message sent', { message: msg });
  } catch (err) {
    console.error('refund-chat POST error:', err);
    return sendError(res, 500, 'Error sending message', err.message);
  }
});

// GET /api/refund-chat/:caseId/unread-count
router.get('/:caseId/unread-count', protect, async (req, res) => {
  try {
    const { caseId } = req.params;
    const userId = req.user.id;
    const r = await db.query(
      `SELECT COUNT(*) as count FROM refund_messages
       WHERE refund_case_id = $1 AND sender_id != $2 AND is_read = false`,
      [caseId, userId]
    );
    return sendSuccess(res, 200, 'OK', { count: parseInt(r.rows[0].count, 10) });
  } catch (err) {
    return sendError(res, 500, 'Error', err.message);
  }
});

module.exports = router;
