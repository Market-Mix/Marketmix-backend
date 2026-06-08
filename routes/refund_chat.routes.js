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
    // Allow admins to access any case, otherwise restrict to buyer/seller
    if (req.user.role !== 'admin') {
      const access = await db.query(
        `SELECT rc.id FROM refund_cases rc
         JOIN order_items oi ON oi.order_id = rc.order_id::uuid
         WHERE rc.id = $1
           AND (rc.buyer_id = $2 OR rc.seller_id = $2 OR oi.seller_id = $2)
         LIMIT 1`,
        [caseId, userId]
      );
      if (!access.rows.length) return sendError(res, 403, 'Access denied');
    }

    const msgs = await db.query(
      `SELECT id, sender_id, sender_type, message AS message_text, is_read, created_at
       FROM refund_messages
       WHERE refund_case_id = $1
       ORDER BY created_at ASC`,
      [caseId]
    );

    // Mark unread messages from other party as read (admins do not trigger this)
    if (req.user.role !== 'admin') {
      await db.query(
        `UPDATE refund_messages SET is_read = true
         WHERE refund_case_id = $1 AND sender_id != $2 AND is_read = false`,
        [caseId, userId]
      );
    }

    // Also return case info so UI can determine chat lock state
    const caseInfoRes = await db.query(
      `SELECT id, resolution_status, seller_marked_resolved, buyer_confirmed_resolution, escalated_to_marketmix
       FROM refund_cases WHERE id = $1`,
      [caseId]
    );
    const caseInfo = caseInfoRes.rows.length ? caseInfoRes.rows[0] : null;

    return sendSuccess(res, 200, 'Messages fetched', { messages: msgs.rows, caseInfo });
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
    const { message_text } = req.body;

    if (!message_text) return sendError(res, 400, 'Message required');

    // Determine sender_type and verify access
    const caseRes = await db.query(
      `SELECT buyer_id, seller_id, resolution_status FROM refund_cases WHERE id = $1`,
      [caseId]
    );
    if (!caseRes.rows.length) return sendError(res, 404, 'Case not found');

    const c = caseRes.rows[0];
    let senderType = null;
    if (req.user.role === 'admin') {
      senderType = 'admin';
    } else if (c.buyer_id === userId) senderType = 'buyer';
    else if (c.seller_id === userId) senderType = 'seller';
    else return sendError(res, 403, 'Access denied');

    // Enforce chat locking for resolved/escalated cases (admins may still post)
    if (['resolved','escalated'].includes(String(c.resolution_status)) && req.user.role !== 'admin') {
      console.log(`Chat locked for case ${caseId}. resolution_status=${c.resolution_status}. User ${userId} (${req.user.role}) blocked from posting.`);
      return sendError(res, 403, 'Chat is read-only for this case');
    }

    const result = await db.query(
      `INSERT INTO refund_messages
         (refund_case_id, sender_id, sender_type, message)
       VALUES ($1, $2, $3, $4)
       RETURNING id, refund_case_id, sender_id, sender_type, message AS message_text, is_read, created_at`,
      [caseId, userId, senderType, message_text || null]
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
          (message_text || 'Message received').substring(0, 100)
        ]
      ).catch(() => {});
    }

    console.log(`Refund chat message stored. refund_id=${caseId}, sender_type=${senderType}, sender_id=${userId}`);

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
