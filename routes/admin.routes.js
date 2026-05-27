const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const { isAdmin } = require('../middlewares/role.middleware');
const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

// POST /api/admin/escrow/:escrowId/resolve
// body: { action: 'release' | 'refund', notes: string }
router.post('/escrow/:escrowId/resolve', protect, isAdmin, async (req, res) => {
  const { escrowId } = req.params;
  const { action, notes } = req.body;

  if (!['release', 'refund'].includes(action)) {
    return sendError(res, 400, 'action must be release or refund');
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const escrowRes = await client.query(
      `SELECT * FROM escrow_transactions WHERE id=$1 FOR UPDATE`,
      [escrowId]
    );
    if (!escrowRes.rows.length) {
      await client.query('ROLLBACK');
      return sendError(res, 404, 'Escrow not found');
    }
    const escrow = escrowRes.rows[0];

    if (action === 'release') {
      const COMMISSION = 0.05;
      const net = parseFloat(escrow.amount) * (1 - COMMISSION);

      await client.query(
        `UPDATE escrow_transactions
         SET status='released', released_at=NOW(), notes=$2, updated_at=NOW()
         WHERE id=$1`,
        [escrowId, notes || 'Admin released']
      );

      await client.query(
        `UPDATE seller_profiles
         SET available_balance=available_balance+$1, total_earnings=total_earnings+$1
         WHERE user_id=$2`,
        [net, escrow.seller_id]
      );

      await client.query(
        `INSERT INTO notifications(user_id,title,message,type,is_read,is_deleted,created_at,updated_at)
         VALUES($1,'Dispute Resolved - Funds Released',
           'Admin reviewed your dispute and released funds to the seller.',
           'payment',FALSE,FALSE,NOW(),NOW())`,
        [escrow.buyer_id]
      );

    } else {
      // refund — in a real system you'd call gateway refund API here
      await client.query(
        `UPDATE escrow_transactions
         SET status='refunded', released_at=NOW(), notes=$2, updated_at=NOW()
         WHERE id=$1`,
        [escrowId, notes || 'Admin refunded']
      );

      await client.query(
        `UPDATE orders SET status='refunded', updated_at=NOW() WHERE id=$1`,
        [escrow.order_id]
      );

      await client.query(
        `INSERT INTO notifications(user_id,title,message,type,is_read,is_deleted,created_at,updated_at)
         VALUES($1,'Dispute Resolved - Refund Approved',
           'Admin reviewed your dispute and approved a refund.',
           'payment',FALSE,FALSE,NOW(),NOW())`,
        [escrow.buyer_id]
      );
    }

    await client.query('COMMIT');
    return sendSuccess(res, 200, `Escrow ${action}d successfully`);
  } catch (err) {
    await client.query('ROLLBACK');
    return sendError(res, 500, err.message);
  } finally {
    client.release();
  }
});

module.exports = router;