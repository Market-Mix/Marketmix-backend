const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const { protect } = require('../middlewares/auth.middleware');
const { isAdmin } = require('../middlewares/role.middleware');
const { requirePermission } = require('../middlewares/rbac.middleware');
const { normalizePauseParty, canSendRefundMessage } = require('../services/refundChatControl.service');

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
         LEFT JOIN order_items oi
           ON rc.order_item_id IS NOT NULL AND oi.id = rc.order_item_id
         WHERE rc.id = $1
           AND (
             rc.buyer_id = $2
             OR rc.seller_id = $2
             OR (rc.seller_id IS NULL AND rc.order_item_id IS NOT NULL AND oi.seller_id = $2)
           )
         LIMIT 1`,
        [caseId, userId]
      );
      if (!access.rows.length) return sendError(res, 403, 'Access denied');
    }

    const msgs = await db.query(
      `SELECT id, sender_id, sender_type, message AS message_text, media_url, media_type, is_read, created_at
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
      `SELECT id, resolution_status, seller_marked_resolved, buyer_confirmed_resolution, escalated_to_marketmix,
              COALESCE(buyer_chat_paused, false) AS buyer_chat_paused,
              COALESCE(seller_chat_paused, false) AS seller_chat_paused
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
    const { message_text, media_url, media_type } = req.body;

    if (!message_text && !media_url) return sendError(res, 400, 'Message or media required');

    // Determine sender_type and verify access
    const caseRes = await db.query(
      `SELECT rc.buyer_id,
              COALESCE(rc.seller_id, oi.seller_id) AS seller_id,
              rc.resolution_status,
              COALESCE(rc.buyer_chat_paused, false) AS buyer_chat_paused,
              COALESCE(rc.seller_chat_paused, false) AS seller_chat_paused
       FROM refund_cases rc
       LEFT JOIN order_items oi
         ON rc.order_item_id IS NOT NULL AND oi.id = rc.order_item_id
       WHERE rc.id = $1
       LIMIT 1`,
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

    const sendPermission = canSendRefundMessage({
      role: req.user.role,
      senderType,
      buyerPaused: c.buyer_chat_paused,
      sellerPaused: c.seller_chat_paused,
      resolutionStatus: c.resolution_status
    });
    if (!sendPermission.allowed) {
      console.log(`Refund chat send blocked: refund_id=${caseId}, sender_type=${senderType}, reason=${sendPermission.reason}`);
      return sendError(res, 403, sendPermission.reason);
    }

    const result = await db.query(
      `INSERT INTO refund_messages
         (refund_case_id, sender_id, sender_type, message, media_url, media_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, refund_case_id, sender_id, sender_type, message AS message_text, media_url, media_type, is_read, created_at`,
      [caseId, userId, senderType, message_text || null, media_url || null, media_type || null]
    );

    const msg = result.rows[0];

    // Notify the other party, or both parties when MarketMix posts.
    const targets = senderType === 'admin' ? [c.buyer_id, c.seller_id]
      : [senderType === 'buyer' ? c.seller_id : c.buyer_id];
    for (const notifyUserId of targets.filter(Boolean)) {
      const notificationTitle = 'New Refund Message';
      const notificationMessage = senderType === 'buyer'
        ? 'The buyer sent a new message regarding a refund case.'
        : senderType === 'admin'
          ? 'MarketMix support sent a new message regarding a refund case.'
          : 'The seller replied to your refund case.';
      const notifyRecipient = notifyUserId === c.buyer_id ? 'buyer' : 'seller';
      const refundLink = notifyRecipient === 'buyer'
        ? `/buyers/buyers%20return%20report.html?case=${caseId}`
        : `/sellers/sellers%20returns.html?case=${caseId}`;
      
      await db.query(
        `INSERT INTO notifications
           (user_id, title, message, type, link, is_read, is_deleted, created_at, updated_at)
         VALUES ($1, $2, $3, 'refund_chat', $4, false, false, NOW(), NOW())`,
        [
          notifyUserId,
          notificationTitle,
          notificationMessage,
          refundLink
        ]
      ).catch(err => console.warn('Notification creation failed:', err.message));
    }

    console.log(`Refund chat message stored. refund_id=${caseId}, sender_type=${senderType}, sender_id=${userId}`);

    return sendSuccess(res, 201, 'Message sent', { message: msg });
  } catch (err) {
    console.error('refund-chat POST error:', err);
    return sendError(res, 500, 'Error sending message', err.message);
  }
});

async function setPartyChatPaused(req, res, paused) {
  try {
    const { caseId, party } = req.params;
    const normalizedParty = normalizePauseParty(party);
    if (!normalizedParty) return sendError(res, 400, 'Party must be buyer or seller');

    const caseRes = await db.query(
      `SELECT rc.id, rc.buyer_id,
              COALESCE(rc.seller_id, oi.seller_id) AS seller_id,
              COALESCE(rc.buyer_chat_paused, false) AS buyer_chat_paused,
              COALESCE(rc.seller_chat_paused, false) AS seller_chat_paused
       FROM refund_cases rc
       LEFT JOIN order_items oi
         ON rc.order_item_id IS NOT NULL AND oi.id = rc.order_item_id
       WHERE rc.id = $1
       LIMIT 1`,
      [caseId]
    );
    if (!caseRes.rows.length) return sendError(res, 404, 'Case not found');

    const refundCase = caseRes.rows[0];
    const affectedUserId = normalizedParty === 'buyer' ? refundCase.buyer_id : refundCase.seller_id;
    if (!affectedUserId) return sendError(res, 404, `${normalizedParty} participant not found`);

    const pauseColumn = normalizedParty === 'buyer' ? 'buyer_chat_paused' : 'seller_chat_paused';
    const updateResult = await db.query(
      `UPDATE refund_cases
       SET ${pauseColumn} = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id,
                 COALESCE(buyer_chat_paused, false) AS buyer_chat_paused,
                 COALESCE(seller_chat_paused, false) AS seller_chat_paused`,
      [paused, caseId]
    );

    const partyLabel = normalizedParty === 'buyer' ? 'Buyer' : 'Seller';
    const notificationTitle = paused ? 'Refund Chat Paused' : 'Refund Chat Resumed';
    const notificationMessage = paused
      ? `MarketMix has paused ${normalizedParty} messaging in refund case ${caseId}.`
      : `MarketMix has resumed ${normalizedParty} messaging in refund case ${caseId}.`;
    const refundLink = normalizedParty === 'buyer'
      ? `/buyers/buyers%20return%20report.html?case=${caseId}`
      : `/sellers/sellers%20returns.html?case=${caseId}`;

    await db.query(
      `INSERT INTO notifications
         (user_id, title, message, type, link, is_read, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, 'refund_chat', $4, false, false, NOW(), NOW())`,
      [affectedUserId, notificationTitle, notificationMessage, refundLink]
    ).catch(err => console.warn('Pause/resume notification creation failed:', err.message));

    return sendSuccess(res, 200, `${partyLabel} chat ${paused ? 'paused' : 'resumed'}`, {
      caseId,
      party: normalizedParty,
      paused,
      buyer_chat_paused: updateResult.rows[0].buyer_chat_paused,
      seller_chat_paused: updateResult.rows[0].seller_chat_paused
    });
  } catch (err) {
    console.error('refund chat pause/resume error:', err);
    return sendError(res, 500, 'Unable to update refund chat pause state', err.message);
  }
}

router.put('/:caseId/pause/:party', protect, isAdmin, requirePermission('Refunds', 'Manage'), (req, res) =>
  setPartyChatPaused(req, res, true)
);

router.put('/:caseId/resume/:party', protect, isAdmin, requirePermission('Refunds', 'Manage'), (req, res) =>
  setPartyChatPaused(req, res, false)
);

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

// GET /api/refund-chat/:caseId/unread-notification-count — unread refund_chat notifications for this case
router.get('/:caseId/unread-notification-count', protect, async (req, res) => {
  try {
    const { caseId } = req.params;
    const userId = req.user.id;
    
    const r = await db.query(
      `SELECT COUNT(*) as count FROM notifications
       WHERE user_id = $1 
         AND type = 'refund_chat'
         AND link LIKE '%case=' || $2 || '%'
         AND is_read = false
         AND is_deleted = false`,
      [userId, caseId]
    );
    return sendSuccess(res, 200, 'OK', { count: parseInt(r.rows[0].count, 10) });
  } catch (err) {
    return sendError(res, 500, 'Error', err.message);
  }
});

// PUT /api/refund-chat/:caseId/mark-notifications-read — mark refund_chat notifications as read for this case
router.put('/:caseId/mark-notifications-read', protect, async (req, res) => {
  try {
    const { caseId } = req.params;
    const userId = req.user.id;
    
    await db.query(
      `UPDATE notifications
       SET is_read = true, updated_at = NOW()
       WHERE user_id = $1
         AND type = 'refund_chat'
         AND link LIKE '%case=' || $2 || '%'
         AND is_read = false
         AND is_deleted = false`,
      [userId, caseId]
    );
    
    return sendSuccess(res, 200, 'Notifications marked as read');
  } catch (err) {
    return sendError(res, 500, 'Error', err.message);
  }
});

module.exports = router;
