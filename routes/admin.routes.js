const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const { isAdmin } = require('../middlewares/role.middleware');
const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const { stripFee } = require('../utils/pricing');
const { processWithdrawal } = require('../services/payout.service');
const { createDedupedNotification } = require('../controllers/notification.controller');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zfyoxmwwuwgvaevwlgzn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function getSupabaseHeaders() {
  return {
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    apikey: SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json'
  };
}

function truncateText(text, maxLength = 150) {
  if (!text || typeof text !== 'string') return '';
  const cleaned = text.trim();
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength).trim()}...`;
}

function getAdminDecidedBy(req) {
  if (req.user && req.user.id) {
    return req.user.id;
  }
  return (req.user && req.user.email) || 'MarketMix Admin';
}

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
      const net = stripFee(escrow.amount);

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

// GET /api/admin/refunds/pending
// Development-only route for admin refund testing page
router.get('/refunds/pending', protect, isAdmin, async (req, res) => {
  try {
    if (!SUPABASE_SERVICE_KEY) {
      return sendError(res, 500, 'SUPABASE_SERVICE_KEY not configured');
    }

    const queryUrl = `${SUPABASE_URL}/rest/v1/refund_cases?select=*&or=(resolution_status.eq.awaiting_admin,resolution_status.eq.escalated)&order=created_at.desc`;
    const response = await fetch(queryUrl, {
      method: 'GET',
      headers: getSupabaseHeaders()
    });

    if (!response.ok) {
      const errorText = await response.text();
      return sendError(res, response.status, 'Failed to fetch refund cases from Supabase', errorText);
    }

    const refundCases = await response.json();
    const enriched = await Promise.all((refundCases || []).map(async (refundCase) => {
      const enrichedCase = { ...refundCase };

      try {
        if (enrichedCase.buyer_id) {
          const buyerRes = await db.query('SELECT first_name, last_name FROM users WHERE id = $1', [enrichedCase.buyer_id]);
          if (buyerRes.rows.length > 0) {
            enrichedCase.buyer_name = `${buyerRes.rows[0].first_name || ''} ${buyerRes.rows[0].last_name || ''}`.trim();
          }
        }
      } catch (err) {
        enrichedCase.buyer_name = null;
      }

      try {
        if (enrichedCase.seller_id) {
          const sellerRes = await db.query('SELECT first_name, last_name FROM users WHERE id = $1', [enrichedCase.seller_id]);
          if (sellerRes.rows.length > 0) {
            enrichedCase.seller_name = `${sellerRes.rows[0].first_name || ''} ${sellerRes.rows[0].last_name || ''}`.trim();
          }

          const storeRes = await db.query(
            `SELECT business_name FROM stores WHERE user_id = $1 AND is_deleted = false ORDER BY store_number ASC LIMIT 1`,
            [enrichedCase.seller_id]
          );
          enrichedCase.store_name = storeRes.rows.length > 0 ? storeRes.rows[0].business_name : null;
        }
      } catch (err) {
        enrichedCase.seller_name = null;
        enrichedCase.store_name = null;
      }

      return enrichedCase;
    }));

    return sendSuccess(res, 200, 'Refund cases fetched successfully', { refundCases: enriched });
  } catch (err) {
    return sendError(res, 500, err.message || 'Unable to fetch refund cases');
  }
});

// GET /api/admin/refunds
router.get('/refunds', protect, isAdmin, async (req, res) => {
  try {
    if (!SUPABASE_SERVICE_KEY) {
      return sendError(res, 500, 'SUPABASE_SERVICE_KEY not configured');
    }

    const queryUrl = `${SUPABASE_URL}/rest/v1/refund_cases?select=*&order=created_at.desc`;
    const response = await fetch(queryUrl, {
      method: 'GET',
      headers: getSupabaseHeaders()
    });

    if (!response.ok) {
      const errorText = await response.text();
      return sendError(res, response.status, 'Failed to fetch refund cases from Supabase', errorText);
    }

    const refundCases = await response.json();
    const enriched = await Promise.all((refundCases || []).map(async (refundCase) => {
      const enrichedCase = { ...refundCase };

      try {
        if (enrichedCase.buyer_id) {
          const buyerRes = await db.query('SELECT first_name, last_name FROM users WHERE id = $1', [enrichedCase.buyer_id]);
          if (buyerRes.rows.length > 0) {
            enrichedCase.buyer_name = `${buyerRes.rows[0].first_name || ''} ${buyerRes.rows[0].last_name || ''}`.trim();
          }
        }
      } catch (err) {
        enrichedCase.buyer_name = null;
      }

      try {
        if (enrichedCase.seller_id) {
          const sellerRes = await db.query('SELECT first_name, last_name FROM users WHERE id = $1', [enrichedCase.seller_id]);
          if (sellerRes.rows.length > 0) {
            enrichedCase.seller_name = `${sellerRes.rows[0].first_name || ''} ${sellerRes.rows[0].last_name || ''}`.trim();
          }

          const storeRes = await db.query(
            `SELECT business_name FROM stores WHERE user_id = $1 AND is_deleted = false ORDER BY store_number ASC LIMIT 1`,
            [enrichedCase.seller_id]
          );
          enrichedCase.store_name = storeRes.rows.length > 0 ? storeRes.rows[0].business_name : null;
        }
      } catch (err) {
        enrichedCase.seller_name = null;
        enrichedCase.store_name = null;
      }

      try {
        const totalAmountMissing = enrichedCase.total_amount === undefined || enrichedCase.total_amount === null;
        if (totalAmountMissing && (enrichedCase.order_item_id || enrichedCase.order_id)) {
          if (enrichedCase.order_item_id) {
            const itemRes = await db.query(
              'SELECT quantity, price_at_purchase FROM order_items WHERE id = $1 LIMIT 1',
              [enrichedCase.order_item_id]
            );
            if (itemRes.rows.length > 0) {
              const item = itemRes.rows[0];
              enrichedCase.total_amount = (parseFloat(item.quantity) || 1) * (parseFloat(item.price_at_purchase) || 0);
            }
          } else {
            const itemsRes = await db.query(
              'SELECT quantity, price_at_purchase FROM order_items WHERE order_id = $1',
              [enrichedCase.order_id]
            );
            if (itemsRes.rows.length > 0) {
              enrichedCase.total_amount = itemsRes.rows.reduce((sum, item) => {
                return sum + ((parseFloat(item.quantity) || 1) * (parseFloat(item.price_at_purchase) || 0));
              }, 0);
            }
          }
        }

        if ((enrichedCase.total_amount === undefined || enrichedCase.total_amount === null) && enrichedCase.refund_amount !== undefined && enrichedCase.refund_amount !== null) {
          enrichedCase.total_amount = parseFloat(enrichedCase.refund_amount) || 0;
        }
      } catch (err) {
        console.warn('⚠️ Could not resolve total_amount for admin refund case', enrichedCase.id, err.message);
      }

      try {
        if ((!enrichedCase.color || !enrichedCase.size || !enrichedCase.product_snapshot) && (enrichedCase.order_item_id || enrichedCase.order_id)) {
          const specQuery = enrichedCase.order_item_id
            ? 'SELECT color, size, product_snapshot FROM order_items WHERE id = $1 LIMIT 1'
            : 'SELECT color, size, product_snapshot FROM order_items WHERE order_id = $1 LIMIT 1';
          const specParams = [enrichedCase.order_item_id || enrichedCase.order_id];
          const specRes = await db.query(specQuery, specParams);
          if (specRes.rows.length > 0) {
            const item = specRes.rows[0];
            enrichedCase.color = item.color ?? enrichedCase.color ?? null;
            enrichedCase.size = item.size ?? enrichedCase.size ?? null;
            enrichedCase.product_snapshot = item.product_snapshot ?? enrichedCase.product_snapshot ?? null;
          }
        }
      } catch (err) {
        console.warn('⚠️ Could not resolve product specifications for admin refund case', enrichedCase.id, err.message);
      }

      return enrichedCase;
    }));

    return sendSuccess(res, 200, 'Refund cases fetched successfully', { refundCases: enriched });
  } catch (err) {
    return sendError(res, 500, err.message || 'Unable to fetch refund cases');
  }
});

// POST /api/admin/refunds/:refundId/approve
router.post('/refunds/:refundId/approve', protect, isAdmin, async (req, res) => {
  try {
    const { refundId } = req.params;
    const { reason } = req.body;
    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';

    if (!trimmedReason) {
      return sendError(res, 400, 'Decision reason is required.');
    }
    if (trimmedReason.length < 20) {
      return sendError(res, 400, 'Decision reason must be at least 20 characters.');
    }

    const decidedBy = getAdminDecidedBy(req);
    const result = await db.query(
      `UPDATE refund_cases
       SET marketmix_decision = 'approved',
           marketmix_decision_reason = $2,
           marketmix_decided_at = NOW(),
           marketmix_decided_by = $3,
           resolution_status = 'waiting_seller_return_decision',
           updated_at = NOW()
       WHERE id = $1
       RETURNING buyer_id, seller_id`,
      [refundId, trimmedReason, decidedBy]
    );

    if (!result.rows.length) {
      return sendError(res, 404, 'Refund case not found');
    }

    const reasonSummary = truncateText(trimmedReason, 150);
    const { buyer_id, seller_id } = result.rows[0];

    const notificationPromises = [];
    if (seller_id) {
      notificationPromises.push(createDedupedNotification({
        userId: seller_id,
        title: 'Refund Approved',
        message: `MarketMix approved this refund request.\n\nPlease choose how you want the refund handled:\n\n• Return Product\n• Returnless Refund`,
        type: 'refund',
        referenceId: refundId,
        link: '/sellers/sellers%20returns.html'
      }));
    }
    if (buyer_id) {
      notificationPromises.push(createDedupedNotification({
        userId: buyer_id,
        title: 'Refund Approved',
        message: `MarketMix approved your refund request.\n\nPlease wait while the seller chooses whether this refund will require returning the product or will be processed as a returnless refund.`,
        type: 'refund',
        referenceId: refundId,
        link: '/buyers/buyers%20return%20report.html'
      }));
    }

    await Promise.all(notificationPromises);
    return sendSuccess(res, 200, 'Refund approved successfully');
  } catch (err) {
    return sendError(res, 500, err.message);
  }
});

// POST /api/admin/refunds/:refundId/reject
router.post('/refunds/:refundId/reject', protect, isAdmin, async (req, res) => {
  try {
    const { refundId } = req.params;
    const { reason } = req.body;
    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';

    if (!trimmedReason) {
      return sendError(res, 400, 'Decision reason is required.');
    }
    if (trimmedReason.length < 20) {
      return sendError(res, 400, 'Decision reason must be at least 20 characters.');
    }

    const decidedBy = getAdminDecidedBy(req);
    const result = await db.query(
      `UPDATE refund_cases
       SET marketmix_decision = 'rejected',
           marketmix_decision_reason = $2,
           marketmix_decided_at = NOW(),
           marketmix_decided_by = $3,
           resolution_status = 'refund_rejected',
           updated_at = NOW()
       WHERE id = $1
       RETURNING buyer_id, seller_id`,
      [refundId, trimmedReason, decidedBy]
    );

    if (!result.rows.length) {
      return sendError(res, 404, 'Refund case not found');
    }

    const reasonSummary = truncateText(trimmedReason, 150);
    const { buyer_id, seller_id } = result.rows[0];

    const notificationPromises = [];
    if (buyer_id) {
      notificationPromises.push(createDedupedNotification({
        userId: buyer_id,
        title: 'Refund Rejected',
        message: `After reviewing the evidence, MarketMix rejected your refund request. Reason: ${reasonSummary}`,
        type: 'refund'
      }));
    }
    if (seller_id) {
      notificationPromises.push(createDedupedNotification({
        userId: seller_id,
        title: 'Refund Rejected',
        message: `MarketMix rejected this refund request. Reason: ${reasonSummary}`,
        type: 'refund'
      }));
    }

    await Promise.all(notificationPromises);
    return sendSuccess(res, 200, 'Refund rejected successfully');
  } catch (err) {
    return sendError(res, 500, err.message);
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

    await createDedupedNotification({
      userId: sellerId,
      title: 'KYC Approved',
      message: 'Your KYC has been approved. Your seller account is now fully verified.',
      type: 'account',
      link: '/sellers/sellers%20notification%20page.html'
    });

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

    await createDedupedNotification({
      userId: sellerId,
      title: 'KYC Rejected',
      message: 'Your KYC was rejected. Please resubmit your documents to continue onboarding.',
      type: 'account',
      link: '/sellers/kyc-verification.html'
    });

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