const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const { isAdmin } = require('../middlewares/role.middleware');
const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const { processWithdrawal } = require('../services/payout.service');

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

// POST /api/admin/withdrawals/:id/process
router.post('/withdrawals/:id/process', protect, isAdmin, async (req, res) => {
  try {
    // Admin can force-process regardless of scheduled time
    await db.query(`UPDATE withdrawals SET scheduled_for=NOW() WHERE id=$1`, [req.params.id]);
    const result = await processWithdrawal(req.params.id);
    return sendSuccess(res, 200, 'Processing initiated', result);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
});

// POST /api/admin/withdrawals/:id/reject  
router.post('/withdrawals/:id/reject', protect, isAdmin, async (req, res) => {
  const { reason } = req.body;
  const wd = await db.query(
    `UPDATE withdrawals SET status='failed', failure_reason=$1, processed_at=NOW()
     WHERE id=$2 AND status IN ('pending','processing') RETURNING seller_id, amount`,
    [reason || 'Rejected by admin', req.params.id]
  );
  if (!wd.rows.length) return sendError(res, 404, 'Withdrawal not found');
  
  await db.query(
    `UPDATE seller_profiles SET available_balance=available_balance+$1 WHERE user_id=$2`,
    [wd.rows[0].amount, wd.rows[0].seller_id]
  );
  return sendSuccess(res, 200, 'Withdrawal rejected and balance restored');
});

// POST /api/admin/sellers/:sellerId/kyc/approve
router.post('/sellers/:sellerId/kyc/approve', protect, isAdmin, async (req, res) => {
  try {
    const sellerId = req.params.sellerId;
    const result = await db.query(
      `UPDATE seller_profiles
       SET is_verified = true,
           kyc_status = 'approved',
           updated_at = NOW()
       WHERE user_id = $1 AND is_deleted = false
       RETURNING user_id`,
      [sellerId]
    );

    if (!result.rows.length) {
      return sendError(res, 404, 'Seller profile not found');
    }

    console.log({ is_verified: true, kyc_status: 'approved' });
    return sendSuccess(res, 200, 'Seller KYC approved successfully');
  } catch (err) {
    return sendError(res, 500, err.message);
  }
});

// POST /api/admin/sellers/:sellerId/kyc/reject
router.post('/sellers/:sellerId/kyc/reject', protect, isAdmin, async (req, res) => {
  try {
    const sellerId = req.params.sellerId;
    const result = await db.query(
      `UPDATE seller_profiles
       SET is_verified = false,
           kyc_status = 'rejected',
           updated_at = NOW()
       WHERE user_id = $1 AND is_deleted = false
       RETURNING user_id`,
      [sellerId]
    );

    if (!result.rows.length) {
      return sendError(res, 404, 'Seller profile not found');
    }

    console.log({ is_verified: false, kyc_status: 'rejected' });
    return sendSuccess(res, 200, 'Seller KYC rejected successfully');
  } catch (err) {
    return sendError(res, 500, err.message);
  }
});

// GET /api/admin/withdrawals - list all withdrawals
router.get('/withdrawals', protect, isAdmin, async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  
  let where = status ? `WHERE status = $1` : '';
  const params = status ? [status, limit, offset] : [limit, offset];

  const result = await db.query(
    `SELECT w.*, sp.bank_account_name, sp.bank_name, u.email
     FROM withdrawals w
     JOIN seller_profiles sp ON sp.user_id = w.seller_id
     JOIN users u ON u.id = w.seller_id
     ${where}
     ORDER BY w.created_at DESC
     LIMIT $${status ? 2 : 1} OFFSET $${status ? 3 : 2}`,
    params
  );

  return sendSuccess(res, 200, 'Withdrawals fetched', {
    withdrawals: result.rows,
    page: parseInt(page)
  });
});

// POST /api/admin/withdrawals/:id/force-process - bypass schedule
router.post('/withdrawals/:id/force-process', protect, isAdmin, async (req, res) => {
  try {
    await db.query(
      `UPDATE withdrawals SET scheduled_for=NOW(), updated_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    const { processWithdrawal } = require('../services/payout.service');
    const result = await processWithdrawal(req.params.id);
    return sendSuccess(res, 200, 'Processing initiated', result);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
});

// POST /api/admin/withdrawals/:id/approve - override anti-fraud hold
router.post('/withdrawals/:id/approve', protect, isAdmin, async (req, res) => {
  const { notes } = req.body;
  const wd = await db.query(
    `UPDATE withdrawals 
     SET scheduled_for=NOW(), admin_approved=true, admin_notes=$1, updated_at=NOW()
     WHERE id=$2 AND status='pending'
     RETURNING seller_id, amount`,
    [notes || 'Admin approved', req.params.id]
  );
  if (!wd.rows.length) return sendError(res, 404, 'Withdrawal not found or not pending');
  
  // Also clear user hold if that's blocking
  await db.query(
    `UPDATE users SET withdrawal_eligible_at=NOW() WHERE id=$1`,
    [wd.rows[0].seller_id]
  );
  return sendSuccess(res, 200, 'Withdrawal approved and queued for immediate processing');
});

module.exports = router;