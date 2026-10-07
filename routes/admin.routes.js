const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const { isAdmin } = require('../middlewares/role.middleware');
const { requirePermission } = require('../middlewares/rbac.middleware');
const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const { stripFee } = require('../utils/pricing');
const { processWithdrawal } = require('../services/payout.service');
const { createDedupedNotification } = require('../controllers/notification.controller');
const { getPaymentSummaryForRefundCase } = require('../services/refundPaymentPreparationService');
const { recoverSellerDebtFromEscrowRelease } = require('../services/sellerDebtRecoveryService');
const { syncRefundCase } = require('../utils/refundSync');
const { logAudit } = require('../utils/audit');

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

async function enrichRefundCases(refundCases) {
  if (!Array.isArray(refundCases) || refundCases.length === 0) {
    return [];
  }

  const buyerIds = [...new Set(refundCases.map((refundCase) => refundCase?.buyer_id).filter(Boolean))];
  const sellerIds = [...new Set(refundCases.map((refundCase) => refundCase?.seller_id).filter(Boolean))];

  const buyerNameMap = new Map();
  if (buyerIds.length) {
    const buyerRes = await db.query(
      `SELECT id, first_name, last_name FROM users WHERE id = ANY($1::uuid[])`,
      [buyerIds]
    );
    buyerRes.rows.forEach((row) => {
      buyerNameMap.set(row.id, `${row.first_name || ''} ${row.last_name || ''}`.trim() || null);
    });
  }

  const sellerNameMap = new Map();
  const storeNameMap = new Map();
  if (sellerIds.length) {
    const sellerRes = await db.query(
      `SELECT id, first_name, last_name FROM users WHERE id = ANY($1::uuid[])`,
      [sellerIds]
    );
    sellerRes.rows.forEach((row) => {
      sellerNameMap.set(row.id, `${row.first_name || ''} ${row.last_name || ''}`.trim() || null);
    });

    const storeRes = await db.query(
      `SELECT DISTINCT ON (user_id) user_id, business_name
       FROM stores
       WHERE user_id = ANY($1::uuid[]) AND is_deleted = false
       ORDER BY user_id, store_number ASC, id ASC`,
      [sellerIds]
    );
    storeRes.rows.forEach((row) => {
      storeNameMap.set(row.user_id, row.business_name || null);
    });
  }

  const enriched = refundCases.map((refundCase) => {
    const enrichedCase = { ...refundCase };

    if (enrichedCase.buyer_id) {
      enrichedCase.buyer_name = buyerNameMap.get(enrichedCase.buyer_id) || null;
    }

    if (enrichedCase.seller_id) {
      enrichedCase.seller_name = sellerNameMap.get(enrichedCase.seller_id) || null;
      enrichedCase.store_name = storeNameMap.get(enrichedCase.seller_id) || null;
    }

    enrichedCase.return_received = enrichedCase.return_received || false;
    enrichedCase.return_received_at = enrichedCase.return_received_at || enrichedCase.returnReceivedAt || null;

    return enrichedCase;
  });

  return enrichRefundCasesWithSummary(enriched);
}

async function enrichRefundCaseWithSummary(refundCase) {
  if (!refundCase?.id) return refundCase;

  try {
    const paymentSummary = await getPaymentSummaryForRefundCase(refundCase.id);
    if (paymentSummary) {
      return { ...refundCase, payment_summary: paymentSummary };
    }
  } catch (err) {
    console.warn('⚠️ Could not enrich admin refund case with payment summary', refundCase.id, err.message || err);
  }

  return refundCase;
}

async function enrichRefundCasesWithSummary(refundCases) {
  if (!Array.isArray(refundCases)) return [];
  return Promise.all(refundCases.map(enrichRefundCaseWithSummary));
}

// GET /api/admin/refund-summary
router.get('/refund-summary', protect, isAdmin, requirePermission('Refunds', 'View'), async (req, res) => {
  try {
    const openRes = await db.query(`SELECT COUNT(*) AS total FROM refund_cases WHERE COALESCE(resolution_status,'pending') NOT IN ('resolved','refund_rejected')`);
    const awaitingSellerRes = await db.query(`SELECT COUNT(*) AS total FROM refund_cases WHERE COALESCE(resolution_status,'pending') = 'waiting_seller_return_decision'`);
    const awaitingBuyerRes = await db.query(`SELECT COUNT(*) AS total FROM refund_cases WHERE COALESCE(resolution_status,'pending') IN ('waiting_buyer_confirmation','return_required')`);
    const awaitingDecisionRes = await db.query(
      `SELECT COUNT(*) AS total FROM refund_cases WHERE COALESCE(resolution_status,'') IN ('awaiting_admin','escalated') OR (escalated_to_marketmix = true AND (marketmix_decision IS NULL OR marketmix_decision = ''))`
    );
    const refundProcessingRes = await db.query(
      `SELECT COUNT(*) AS total FROM refund_cases WHERE COALESCE(resolution_status,'') IN ('refund_processing','awaiting_refund_release') OR (refund_processing_started_at IS NOT NULL AND COALESCE(refund_payment_status,'') != 'paid' AND refund_paid_at IS NULL)`
    );
    const completedTodayRes = await db.query(
      `SELECT COUNT(*) AS total FROM refund_cases WHERE COALESCE(resolution_status,'') = 'resolved' AND (
         (refund_paid_at IS NOT NULL AND (refund_paid_at::date = CURRENT_DATE)) OR
         (buyer_confirmed_at IS NOT NULL AND (buyer_confirmed_at::date = CURRENT_DATE)) OR
         (marketmix_decided_at IS NOT NULL AND (marketmix_decided_at::date = CURRENT_DATE)) OR
         (seller_resolved_at IS NOT NULL AND (seller_resolved_at::date = CURRENT_DATE))
      )`
    );

    return sendSuccess(res, 200, 'Refund summary fetched', {
      openCases: parseInt(openRes.rows[0]?.total || 0, 10),
      awaitingSellerResponse: parseInt(awaitingSellerRes.rows[0]?.total || 0, 10),
      awaitingBuyerResponse: parseInt(awaitingBuyerRes.rows[0]?.total || 0, 10),
      awaitingDecision: parseInt(awaitingDecisionRes.rows[0]?.total || 0, 10),
      refundProcessing: parseInt(refundProcessingRes.rows[0]?.total || 0, 10),
      completedToday: parseInt(completedTodayRes.rows[0]?.total || 0, 10)
    });
  } catch (err) {
    console.error('[admin] refund-summary error:', err);
    return sendError(res, 500, 'Error fetching refund summary', err.message);
  }
});

// GET /api/admin/debt-summary
router.get('/debt-summary', protect, isAdmin, requirePermission('Sellers', 'View'), async (req, res) => {
  try {
    const debtRes = await db.query(`
      WITH active AS (
        SELECT seller_id, SUM(COALESCE(remaining_debt,0))::numeric AS remaining
        FROM seller_debts
        WHERE status IN ('active','partial')
        GROUP BY seller_id
      )
      SELECT
        COALESCE((SELECT SUM(remaining) FROM active), 0)::numeric AS outstanding_debt,
        COALESCE((SELECT COUNT(*) FROM active WHERE remaining > 0), 0) AS sellers_with_debt,
        COALESCE((SELECT SUM(recovered_amount) FROM seller_debt_recoveries WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)), 0)::numeric AS recovered_this_month,
        COALESCE((SELECT SUM(remaining) FROM active WHERE remaining > 0), 0)::numeric AS unrecovered_debt
    `);

    const row = debtRes.rows[0] || {};
    return sendSuccess(res, 200, 'Debt summary fetched', {
      outstandingDebt: parseFloat(row.outstanding_debt) || 0,
      sellersWithDebt: parseInt(row.sellers_with_debt, 10) || 0,
      recoveredThisMonth: parseFloat(row.recovered_this_month) || 0,
      unrecoveredDebt: parseFloat(row.unrecovered_debt) || 0
    });
  } catch (err) {
    console.error('[admin] debt-summary error:', err);
    return sendError(res, 500, 'Error fetching debt summary', err.message);
  }
});

// POST /api/admin/escrow/:escrowId/resolve
// body: { action: 'release' | 'refund', notes: string }
router.post('/escrow/:escrowId/resolve', protect, isAdmin, requirePermission('Refunds', 'Manage'), async (req, res) => {
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

      await recoverSellerDebtFromEscrowRelease(client, {
        sellerId: escrow.seller_id,
        releaseAmount: net,
        orderId: escrow.order_id,
        escrowId: escrow.id,
        context: 'admin-escrow-release'
      });

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
    await logAudit(req.user.id, 'ESCROW_RESOLVED', 'escrow', escrowId, { action, notes });
    return sendSuccess(res, 200, `Escrow ${action}d successfully`);
  } catch (err) {
    await client.query('ROLLBACK');
    return sendError(res, 500, err.message);
  } finally {
    client.release();
  }
});

// GET /api/admin/dashboard-stats
router.get('/dashboard-stats', protect, isAdmin, requirePermission('Dashboard', 'View'), async (req, res) => {
  try {
    const statsRes = await db.query(`
      SELECT
        COALESCE((SELECT COUNT(*) FROM users WHERE role = 'buyer' AND is_deleted = false), 0) AS total_buyers,
        COALESCE((SELECT COUNT(*) FROM users WHERE role = 'seller' AND is_deleted = false), 0) AS total_sellers,
        COALESCE((SELECT COUNT(*) FROM products WHERE is_deleted = false), 0) AS total_products,
        COALESCE((SELECT COUNT(*) FROM orders), 0) AS total_orders,
        COALESCE((SELECT SUM(total_amount) FROM orders WHERE payment_status = 'paid'), 0) AS total_sales,
        COALESCE((SELECT SUM(amount) FROM escrow_transactions WHERE status = 'held'), 0) AS escrow_held,
        COALESCE((SELECT SUM(COALESCE(available_balance, 0)) FROM seller_profiles), 0) AS available_seller_funds,
        COALESCE((SELECT SUM(ABS(amount)) FROM withdrawals WHERE status IN ('pending','processing')), 0) AS pending_withdrawals,
        COALESCE((SELECT SUM(COALESCE(ABS(refund_amount), 0) + COALESCE(ABS(shipping_amount), 0)) FROM refund_transactions WHERE payment_status = 'paid'), 0) AS total_refunds,
        COALESCE((SELECT SUM(amount) FROM seller_debts WHERE status IN ('active','partial')), 0) AS outstanding_seller_debt
    `);

    const row = statsRes.rows[0] || {};
    const totalSales = parseFloat(row.total_sales) || 0;
    const pendingEscrowGross = parseFloat(row.escrow_held) || 0;

    return sendSuccess(res, 200, 'Dashboard stats fetched', {
      totalBuyers: parseInt(row.total_buyers, 10) || 0,
      totalSellers: parseInt(row.total_sellers, 10) || 0,
      totalProducts: parseInt(row.total_products, 10) || 0,
      totalOrders: parseInt(row.total_orders, 10) || 0,
      totalSales: totalSales,
      platformEarnings: Math.max(0, totalSales - stripFee(totalSales)),
      fundsInEscrow: parseFloat(row.escrow_held) || 0,
      availableSellerFunds: parseFloat(row.available_seller_funds) || 0,
      pendingSellerEarnings: stripFee(pendingEscrowGross),
      pendingWithdrawals: parseFloat(row.pending_withdrawals) || 0,
      refunds: parseFloat(row.total_refunds) || 0,
      outstandingSellerDebt: parseFloat(row.outstanding_seller_debt) || 0
    });
  } catch (err) {
    console.error('Error fetching admin dashboard stats:', err);
    return sendError(res, 500, 'Error fetching dashboard stats', err.message);
  }
});

// GET /api/admin/pending-actions
router.get('/pending-actions', protect, isAdmin, requirePermission('Dashboard', 'View'), async (req, res) => {
  try {
    const sellersRes = await db.query(
      `SELECT COUNT(*) AS total FROM seller_profiles WHERE kyc_status = 'pending' AND is_deleted = false`
    );

    const productsRes = await db.query(
      `SELECT COUNT(*) AS total FROM products WHERE is_deleted = false AND is_active = false`
    );

    const withdrawalsRes = await db.query(
      `SELECT COUNT(*) AS total FROM withdrawals WHERE status IN ('pending', 'processing')`
    );

    let refundCasesCount = 0;
    let escalatedCasesCount = 0;

    if (SUPABASE_SERVICE_KEY) {
      try {
        const pendingCasesUrl = `${SUPABASE_URL}/rest/v1/refund_cases?select=id&or=(resolution_status.eq.awaiting_admin,resolution_status.eq.escalated)&limit=1`;
        const escalatedCasesUrl = `${SUPABASE_URL}/rest/v1/refund_cases?select=id&resolution_status=eq.escalated&limit=1`;

        const [pendingResp, escalatedResp] = await Promise.all([
          fetch(pendingCasesUrl, { method: 'GET', headers: { ...getSupabaseHeaders(), Prefer: 'count=exact' } }),
          fetch(escalatedCasesUrl, { method: 'GET', headers: { ...getSupabaseHeaders(), Prefer: 'count=exact' } })
        ]);

        if (pendingResp.ok) {
          const pendingCount = pendingResp.headers.get('content-range')?.split('/')[1];
          refundCasesCount = Number(pendingCount) || 0;
        }

        if (escalatedResp.ok) {
          const escalatedCount = escalatedResp.headers.get('content-range')?.split('/')[1];
          escalatedCasesCount = Number(escalatedCount) || 0;
        }
      } catch (supabaseErr) {
        console.warn('Unable to fetch admin pending refund case counts from Supabase:', supabaseErr?.message || supabaseErr);
      }
    }

    return sendSuccess(res, 200, 'Pending action counts fetched', {
      pendingSellers: parseInt(sellersRes.rows[0]?.total, 10) || 0,
      pendingProducts: parseInt(productsRes.rows[0]?.total, 10) || 0,
      pendingWithdrawals: parseInt(withdrawalsRes.rows[0]?.total, 10) || 0,
      refundCases: refundCasesCount,
      escalatedCases: escalatedCasesCount
    });
  } catch (err) {
    console.error('Error fetching pending action counts:', err);
    return sendError(res, 500, 'Error fetching pending action counts', err.message);
  }
});

// GET /api/admin/activity
router.get('/activity', protect, isAdmin, requirePermission('Dashboard', 'View'), async (req, res) => {
  try {
    const limit = Number.parseInt(req.query.limit || '5', 10);
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 20) : 5;

    const activityRes = await db.query(
      `SELECT a.id,
              a.actor_id,
              a.action,
              a.object_type,
              a.object_id,
              a.metadata,
              a.created_at,
              u.first_name,
              u.last_name,
              u.email
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
       ORDER BY a.created_at DESC
       LIMIT $1`,
      [safeLimit]
    );

    const activities = activityRes.rows.map((row) => {
      let metadata = null;
      try {
        metadata = row.metadata && typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || null;
      } catch (err) {
        metadata = null;
      }

      const actorName = [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email || 'System';
      const description = metadata?.description || metadata?.message || row.action || 'Admin activity';

      return {
        id: row.id,
        actor_id: row.actor_id,
        actor_name: actorName,
        action: row.action,
        object_type: row.object_type,
        object_id: row.object_id,
        description,
        metadata,
        created_at: row.created_at
      };
    });

    return sendSuccess(res, 200, 'Recent admin activity fetched', { activities });
  } catch (err) {
    if (String(err.message || '').includes('audit_logs') || String(err.message || '').includes('relation')) {
      return sendSuccess(res, 200, 'No audit log table available', { activities: [] });
    }

    console.error('[admin] GET /activity error:', err);
    return sendError(res, 500, 'Error fetching admin activity', err.message);
  }
});

// GET /api/admin/marketplace-health
router.get('/marketplace-health', protect, isAdmin, requirePermission('Dashboard', 'View'), async (req, res) => {
  try {
    const checks = {
      paymentSystem: `SELECT COUNT(*) AS total FROM payment_transactions LIMIT 1`,
      shippingAPI: `SELECT COUNT(*) AS total FROM vendor_orders LIMIT 1`,
      refundSystem: `SELECT COUNT(*) AS total FROM refund_cases LIMIT 1`,
      notifications: `SELECT COUNT(*) AS total FROM notifications LIMIT 1`,
      database: `SELECT 1 AS ok`
    };

    const health = {};

    for (const [key, query] of Object.entries(checks)) {
      try {
        const result = await db.query(query);
        const value = result?.rows?.[0];
        health[key] = value && (value.total !== undefined ? Number(value.total) >= 0 : value.ok !== undefined ? 'ok' : 'operational') === 'ok'
          ? 'operational'
          : 'operational';
      } catch (err) {
        console.warn('[Connection 7B] health check failed:', key, err.message || err);
        health[key] = 'offline';
      }
    }

    return sendSuccess(res, 200, 'Marketplace health fetched', health);
  } catch (err) {
    console.error('[Connection 7B] marketplace-health error:', err);
    return sendError(res, 500, 'Error fetching marketplace health', err.message);
  }
});

// GET /api/admin/dashboard-activity
router.get('/dashboard-activity', protect, isAdmin, requirePermission('Dashboard', 'View'), async (req, res) => {
  try {
    const recentOrdersRes = await db.query(
      `SELECT o.id AS order_id,
              o.total_amount,
              o.status,
              o.payment_status,
              o.created_at,
              COALESCE(b.first_name || ' ' || b.last_name, b.email, 'Buyer') AS buyer_name,
              COALESCE(seller_profile.business_name, seller_user.first_name || ' ' || seller_user.last_name, 'Seller') AS seller_name
       FROM orders o
       LEFT JOIN users b ON b.id = o.buyer_id
       LEFT JOIN LATERAL (
         SELECT oi.seller_id
         FROM order_items oi
         WHERE oi.order_id = o.id AND oi.seller_id IS NOT NULL
         ORDER BY oi.created_at DESC
         LIMIT 1
       ) AS recent_seller ON TRUE
       LEFT JOIN users seller_user ON seller_user.id = recent_seller.seller_id
       LEFT JOIN seller_profiles seller_profile ON seller_profile.user_id = recent_seller.seller_id
       ORDER BY o.created_at DESC
       LIMIT 5`
    );

    const topProductsRes = await db.query(
      `SELECT p.id AS product_id,
              p.name,
              p.price,
              p.stock_quantity,
              p.is_active,
              COALESCE(seller_profile.business_name, seller_user.first_name || ' ' || seller_user.last_name, 'Seller') AS seller_name,
              SUM(oi.quantity) AS quantity_sold
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       LEFT JOIN users seller_user ON seller_user.id = p.seller_id
       LEFT JOIN seller_profiles seller_profile ON seller_profile.user_id = p.seller_id
       GROUP BY p.id, p.name, p.price, p.stock_quantity, p.is_active, seller_profile.business_name, seller_user.first_name, seller_user.last_name
       ORDER BY SUM(oi.quantity) DESC
       LIMIT 5`
    );

    return sendSuccess(res, 200, 'Dashboard activity fetched', {
      recentOrders: recentOrdersRes.rows.map((row) => ({
        order_id: row.order_id,
        total_amount: parseFloat(row.total_amount) || 0,
        status: row.status || 'unknown',
        payment_status: row.payment_status || null,
        created_at: row.created_at,
        buyer_name: row.buyer_name || 'Buyer',
        seller_name: row.seller_name || 'Seller'
      })),
      topProducts: topProductsRes.rows.map((row) => ({
        product_id: row.product_id,
        name: row.name || 'Unknown Product',
        price: parseFloat(row.price) || 0,
        stock_quantity: row.stock_quantity != null ? parseInt(row.stock_quantity, 10) : 0,
        quantity_sold: parseInt(row.quantity_sold, 10) || 0,
        seller_name: row.seller_name || 'Seller'
      }))
    });
  } catch (err) {
    console.error('Error fetching admin dashboard activity:', err);
    return sendError(res, 500, 'Error fetching dashboard activity', err.message);
  }
});

// GET /api/admin/marketplace-performance?period=today|7d|30d|6m|1y
router.get('/marketplace-performance', protect, isAdmin, requirePermission('Analytics', 'View'), async (req, res) => {
  try {
    const period = String(req.query.period || 'today').toLowerCase();
    
    // Calculate date range based on period
    const now = new Date();
    let startDate = new Date(now);
    let endDate = new Date(now);
    endDate.setHours(23, 59, 59, 999);
    startDate.setHours(0, 0, 0, 0);
    
    switch (period) {
      case '7d':
      case '7days':
        startDate.setDate(now.getDate() - 6);
        break;
      case '30d':
      case '30days':
        startDate.setDate(now.getDate() - 29);
        break;
      case '6m':
      case '6months':
        startDate.setMonth(now.getMonth() - 6);
        break;
      case '1y':
      case '1year':
        startDate.setFullYear(now.getFullYear() - 1);
        break;
      case 'today':
      default:
        // startDate is already today
        break;
    }
    
    // Also calculate previous period for comparison
    let prevStartDate = new Date(startDate);
    let prevEndDate = new Date(startDate);
    prevEndDate.setDate(prevEndDate.getDate() - 1);
    prevEndDate.setHours(23, 59, 59, 999);
    const periodDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
    prevStartDate.setDate(prevStartDate.getDate() - periodDays);
    
    console.log(`[admin] marketplace-performance for period: ${period}, dates: ${startDate.toISOString()} to ${endDate.toISOString()}`);
    
    // Current period metrics - separate queries for clarity
    const salesRes = await db.query(
      `SELECT COALESCE(SUM(total_amount), 0) AS gross_sales FROM orders WHERE payment_status = 'paid' AND created_at >= $1 AND created_at <= $2`,
      [startDate, endDate]
    );
    
    const refundsRes = await db.query(
      `SELECT COALESCE(SUM(COALESCE(refund_amount, 0) + COALESCE(shipping_amount, 0)), 0) AS total_refunds FROM refund_transactions WHERE payment_status = 'paid' AND created_at >= $1 AND created_at <= $2`,
      [startDate, endDate]
    );
    
    // Get seller payouts (total amount released from escrow in this period)
    const payoutsRes = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS seller_payouts FROM escrow_transactions WHERE status = 'released' AND released_at >= $1 AND released_at <= $2`,
      [startDate, endDate]
    );
    
    const grossSales = parseFloat(salesRes.rows[0]?.gross_sales || 0);
    const totalRefunds = parseFloat(refundsRes.rows[0]?.total_refunds || 0);
    const sellerPayouts = parseFloat(payoutsRes.rows[0]?.seller_payouts || 0);
    
    // Platform revenue is 10% of gross sales (standard marketplace commission)
    const platformRevenue = stripFee(grossSales);
    
    // Previous period metrics for comparison
    const prevSalesRes = await db.query(
      `SELECT COALESCE(SUM(total_amount), 0) AS gross_sales FROM orders WHERE payment_status = 'paid' AND created_at >= $1 AND created_at <= $2`,
      [prevStartDate, prevEndDate]
    );
    
    const prevGrossSales = parseFloat(prevSalesRes.rows[0]?.gross_sales || 0);
    
    // Calculate comparison percentage
    let grossSalesComparison = 0;
    if (prevGrossSales > 0) {
      grossSalesComparison = ((grossSales - prevGrossSales) / prevGrossSales) * 100;
    }
    
    return sendSuccess(res, 200, 'Marketplace performance fetched', {
      period,
      dateRange: {
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0]
      },
      metrics: {
        grossSales,
        platformRevenue,
        refunds: totalRefunds,
        sellerPayouts
      },
      comparison: {
        grossSalesPercentage: parseFloat(grossSalesComparison.toFixed(2)),
        platformRevenuePercentage: grossSales > 0 ? parseFloat((platformRevenue / grossSales * 100).toFixed(2)) : 0,
        refundRate: grossSales > 0 ? parseFloat((totalRefunds / grossSales * 100).toFixed(2)) : 0,
        sellerPayoutPercentage: grossSales > 0 ? parseFloat((sellerPayouts / grossSales * 100).toFixed(2)) : 0
      }
    });
  } catch (err) {
    console.error('Error fetching marketplace performance:', err);
    return sendError(res, 500, 'Error fetching marketplace performance', err.message);
  }
});

// GET /api/admin/marketplace-performance/chart?period=today|7d|30d|6m|1y
router.get('/marketplace-performance/chart', protect, isAdmin, requirePermission('Analytics', 'View'), async (req, res) => {
  try {
    const period = String(req.query.period || 'today').toLowerCase();
    const now = new Date();
    let startDate = new Date(now);
    let endDate = new Date(now);
    endDate.setHours(23, 59, 59, 999);
    startDate.setHours(0, 0, 0, 0);

    switch (period) {
      case '7d':
      case '7days':
        startDate.setDate(now.getDate() - 6);
        break;
      case '30d':
      case '30days':
        startDate.setDate(now.getDate() - 29);
        break;
      case '6m':
      case '6months':
        startDate.setMonth(now.getMonth() - 6);
        break;
      case '1y':
      case '1year':
        startDate.setFullYear(now.getFullYear() - 1);
        break;
      case 'today':
      default:
        break;
    }

    // Determine granularity and SQL step
    let step = '1 day';
    let trunc = 'day';
    if (period === 'today') {
      step = '1 hour';
      trunc = 'hour';
    } else if (['6m', '6months', '1y', '1year'].includes(period)) {
      step = '1 month';
      trunc = 'month';
      // normalize start/end to month boundaries
      startDate = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
      endDate = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
      endDate.setMonth(endDate.getMonth() + 1);
      endDate.setDate(0);
      endDate.setHours(23,59,59,999);
    }

    // Build series query using generate_series and left join aggregated sums
    const seriesQuery = trunc === 'month'
      ? `SELECT to_char(d::date, 'YYYY-MM') AS label, d::date as period_date
         FROM generate_series(date_trunc('month', $1::timestamptz)::date, date_trunc('month', $2::timestamptz)::date, '1 month') d` 
      : `SELECT d AS period_date, to_char(d::date, 'YYYY-MM-DD') AS label
         FROM generate_series($1::timestamptz::date, $2::timestamptz::date, '${step}') d`;

    // Aggregate orders by trunc
    const ordersAgg = `
      SELECT date_trunc('${trunc}', created_at) AS period, COALESCE(SUM(total_amount),0) AS gross
      FROM orders
      WHERE payment_status = 'paid' AND created_at >= $1 AND created_at <= $2
      GROUP BY period
    `;

    const refundsAgg = `
      SELECT date_trunc('${trunc}', created_at) AS period, COALESCE(SUM(COALESCE(refund_amount,0) + COALESCE(shipping_amount,0)),0) AS refunds
      FROM refund_transactions
      WHERE payment_status = 'paid' AND created_at >= $1 AND created_at <= $2
      GROUP BY period
    `;

    const payoutsAgg = `
      SELECT date_trunc('${trunc}', released_at) AS period, COALESCE(SUM(amount),0) AS payouts
      FROM escrow_transactions
      WHERE status = 'released' AND released_at >= $1 AND released_at <= $2
      GROUP BY period
    `;

    // Compose main query joining series with aggregates
    const mainQuery = `
      WITH series AS (
        ${seriesQuery}
      ), o AS (
        ${ordersAgg}
      ), r AS (
        ${refundsAgg}
      ), p AS (
        ${payoutsAgg}
      )
      SELECT s.label::text,
             COALESCE(o.gross,0) AS gross_sales,
             COALESCE(r.refunds,0) AS refunds,
             COALESCE(p.payouts,0) AS seller_payouts
      FROM series s
      LEFT JOIN o ON (date_trunc('${trunc}', s.period_date::timestamp) = o.period)
      LEFT JOIN r ON (date_trunc('${trunc}', s.period_date::timestamp) = r.period)
      LEFT JOIN p ON (date_trunc('${trunc}', s.period_date::timestamp) = p.period)
      ORDER BY s.period_date;
    `;

    const rowsRes = await db.query(mainQuery, [startDate, endDate]);
    const rows = rowsRes.rows || [];

    const labels = rows.map(r => r.label);
    const gross = rows.map(r => parseFloat(r.gross_sales || 0));
    const refunds = rows.map(r => parseFloat(r.refunds || 0));
    const sellerPayouts = rows.map(r => parseFloat(r.seller_payouts || 0));
    const platformRevenue = gross.map(g => Math.max(0, g - stripFee(g)));

    return sendSuccess(res, 200, 'Marketplace performance chart data fetched', {
      period,
      labels,
      datasets: {
        grossSales: gross,
        platformRevenue,
        refunds,
        sellerPayouts
      }
    });
  } catch (err) {
    console.error('Error fetching marketplace performance chart data:', err);
    return sendError(res, 500, 'Error fetching marketplace performance chart data', err.message);
  }
});

// GET /api/admin/refunds/pending
// Development-only route for admin refund testing page
router.get('/refunds/pending', protect, isAdmin, requirePermission('Refunds', 'View'), async (req, res) => {
  try {
    if (!SUPABASE_SERVICE_KEY) {
      return sendError(res, 500, 'SUPABASE_SERVICE_KEY not configured');
    }

    const queryUrl = `${SUPABASE_URL}/rest/v1/refund_cases?select=id,status,resolution_status,created_at,order_id,product_name&or=(resolution_status.eq.awaiting_admin,resolution_status.eq.escalated)&order=created_at.desc`;
    const response = await fetch(queryUrl, {
      method: 'GET',
      headers: getSupabaseHeaders()
    });

    if (!response.ok) {
      const errorText = await response.text();
      return sendError(res, response.status, 'Failed to fetch refund cases from Supabase', errorText);
    }

    const refundCases = await response.json();
    const enriched = await enrichRefundCases(refundCases || []);

    return sendSuccess(res, 200, 'Refund cases fetched successfully', { refundCases: enriched });
  } catch (err) {
    return sendError(res, 500, err.message || 'Unable to fetch refund cases');
  }
});

// GET /api/admin/refunds
router.get('/refunds', protect, isAdmin, requirePermission('Refunds', 'View'), async (req, res) => {
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
    const enriched = await enrichRefundCases(refundCases || []);

    for (const enrichedCase of enriched) {
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
    }

    return sendSuccess(res, 200, 'Refund cases fetched successfully', { refundCases: enriched });
  } catch (err) {
    return sendError(res, 500, err.message || 'Unable to fetch refund cases');
  }
});

// GET /api/admin/seller-adjustments
router.get(['/seller-adjustments', '/seller-adjustments/'], protect, isAdmin, requirePermission('Refunds', 'View'), async (req, res) => {
  try {
    const refundCaseId = typeof req.query.refundCaseId === 'string' ? req.query.refundCaseId.trim() : '';
    const normalizedRefundCaseId = refundCaseId ? refundCaseId : null;

    const adjustmentsRes = await db.query(
      `SELECT id, seller_id, refund_case_id, original_debt, remaining_debt, status, reason, created_at
       FROM seller_debts
       WHERE ($1::uuid IS NULL OR refund_case_id = $1::uuid)
       ORDER BY created_at DESC`,
      [normalizedRefundCaseId]
    );

    const adjustments = [];

    for (const adjustment of adjustmentsRes.rows) {
      const sellerRes = await db.query(
        `SELECT first_name, last_name FROM users WHERE id = $1 LIMIT 1`,
        [adjustment.seller_id]
      );
      const storeRes = await db.query(
        `SELECT business_name FROM stores WHERE user_id = $1 AND is_deleted = false ORDER BY store_number ASC, id ASC LIMIT 1`,
        [adjustment.seller_id]
      );
      const recoveriesRes = await db.query(
        `SELECT release_amount, recovered_amount, remaining_debt, status, created_at, order_id, escrow_transaction_id
         FROM seller_debt_recoveries
         WHERE debt_id = $1
         ORDER BY created_at ASC, id ASC`,
        [adjustment.id]
      );

      const originalAmount = Number(adjustment.original_debt || 0);
      const remainingAmount = Number(adjustment.remaining_debt || 0);
      const recoveredAmount = Math.max(0, originalAmount - remainingAmount);
      const sellerName = sellerRes.rows[0]
        ? `${sellerRes.rows[0].first_name || ''} ${sellerRes.rows[0].last_name || ''}`.trim() || 'Unknown Seller'
        : 'Unknown Seller';

      adjustments.push({
        id: adjustment.id,
        seller_id: adjustment.seller_id,
        seller: sellerName,
        seller_name: sellerName,
        store_name: storeRes.rows[0]?.business_name || null,
        refund_case: adjustment.refund_case_id,
        refund_case_id: adjustment.refund_case_id,
        original_debt: originalAmount,
        original_amount: originalAmount,
        remaining_debt: remainingAmount,
        remaining_amount: remainingAmount,
        recovered_amount: recoveredAmount,
        status: adjustment.status || 'active',
        seller_notice: adjustment.reason || null,
        created_at: adjustment.created_at,
        created_date: adjustment.created_at,
        recovery_history: recoveriesRes.rows.map((row) => ({
          created_at: row.created_at,
          recovered_amount: Number(row.recovered_amount || 0),
          remaining_debt: Number(row.remaining_debt || 0),
          status: row.status || 'recovered',
          release_amount: Number(row.release_amount || 0),
          order_id: row.order_id,
          escrow_transaction_id: row.escrow_transaction_id
        }))
      });
    }

    console.log('[admin] GET seller adjustments', { refundCaseId: normalizedRefundCaseId || null, count: adjustments.length });
    return res.status(200).json(adjustments);
  } catch (err) {
    console.warn('[admin] GET seller adjustments failed:', err.message || err);
    return res.status(200).json([]);
  }
});

// POST /api/admin/refunds/:refundId/approve
router.post('/refunds/:refundId/approve', protect, isAdmin, requirePermission('Refunds', 'Approve'), async (req, res) => {
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
         AND COALESCE(marketmix_decision,'') = ''
         AND resolution_status IN ('escalated','awaiting_admin')
       RETURNING id, buyer_id, seller_id, order_id, resolution_status, status`,
      [refundId, trimmedReason, decidedBy]
    );

    if (!result.rows.length) {
      const ex = await db.query('SELECT 1 FROM refund_cases WHERE id = $1', [refundId]);
      return ex.rows.length
        ? sendError(res, 409, 'This case was already decided or is not awaiting an admin decision')
        : sendError(res, 404, 'Refund case not found');
    }

    await logAudit(req.user.id, 'REFUND_APPROVED', 'refund_case', refundId, { reason: trimmedReason });
    const reasonSummary = truncateText(trimmedReason, 150);
    const updatedCase = result.rows[0];
    const { buyer_id, seller_id } = updatedCase;
    syncRefundCase(updatedCase).catch(() => {});

    const notificationPromises = [];
    if (seller_id) {
      notificationPromises.push(createDedupedNotification({
        userId: seller_id,
        title: 'Refund Approved',
        message: 'MarketMix approved this refund request. Please choose either Return Product or Returnless Refund.',
        type: 'refund',
        referenceId: refundId,
        link: '/sellers/sellers%20returns.html'
      }));
    }
    if (buyer_id) {
      notificationPromises.push(createDedupedNotification({
        userId: buyer_id,
        title: 'Refund Approved',
        message: 'MarketMix has approved your refund request. Please wait while the seller chooses the refund method.',
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
router.post('/refunds/:refundId/reject', protect, isAdmin, requirePermission('Refunds', 'Reject'), async (req, res) => {
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
         AND COALESCE(marketmix_decision,'') = ''
         AND resolution_status IN ('escalated','awaiting_admin')
       RETURNING id, buyer_id, seller_id, order_id, resolution_status, status`,
      [refundId, trimmedReason, decidedBy]
    );

    if (!result.rows.length) {
      const ex = await db.query('SELECT 1 FROM refund_cases WHERE id = $1', [refundId]);
      return ex.rows.length
        ? sendError(res, 409, 'This case was already decided or is not awaiting an admin decision')
        : sendError(res, 404, 'Refund case not found');
    }

    await logAudit(req.user.id, 'REFUND_REJECTED', 'refund_case', refundId, { reason: trimmedReason });
    const reasonSummary = truncateText(trimmedReason, 150);
    const updatedCase = result.rows[0];
    const { buyer_id, seller_id } = updatedCase;
    syncRefundCase(updatedCase).catch(() => {});

    const notificationPromises = [];
    if (buyer_id) {
      notificationPromises.push(createDedupedNotification({
        userId: buyer_id,
        title: 'Refund Rejected',
        message: 'Unfortunately, MarketMix rejected your refund request after reviewing the evidence.',
        type: 'refund',
        referenceId: refundId,
        link: '/buyers/buyers%20return%20report.html'
      }));
    }
    if (seller_id) {
      notificationPromises.push(createDedupedNotification({
        userId: seller_id,
        title: 'Refund Closed',
        message: 'MarketMix rejected this refund request. No further action is required.',
        type: 'refund',
        referenceId: refundId,
        link: '/sellers/sellers%20returns.html'
      }));
    }

    await Promise.all(notificationPromises);
    return sendSuccess(res, 200, 'Refund rejected successfully');
  } catch (err) {
    return sendError(res, 500, err.message);
  }
});

// POST /api/admin/withdrawals/:id/process
router.post('/withdrawals/:id/process', protect, isAdmin, requirePermission('Withdrawals', 'Manage'), async (req, res) => {
  try {
    // Admin can force-process regardless of scheduled time
    await db.query(`UPDATE withdrawals SET scheduled_for=NOW() WHERE id=$1`, [req.params.id]);
    const result = await processWithdrawal(req.params.id);
    if (result.success) await logAudit(req.user.id, 'WITHDRAWAL_PROCESSED', 'withdrawal', req.params.id);
    return sendSuccess(res, 200, 'Processing initiated', result);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
});

// POST /api/admin/withdrawals/:id/reject  
router.post('/withdrawals/:id/reject', protect, isAdmin, requirePermission('Withdrawals', 'Reject'), async (req, res) => {
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
  await logAudit(req.user.id, 'WITHDRAWAL_REJECTED', 'withdrawal', req.params.id, { reason: reason || 'Rejected by admin' });
  return sendSuccess(res, 200, 'Withdrawal rejected and balance restored');
});

// GET /api/admin/sellers/:sellerId/kyc/status
router.get('/sellers/:sellerId/kyc/status', protect, isAdmin, requirePermission('Seller KYC', 'View'), async (req, res) => {
  try {
    const sellerId = req.params.sellerId;
    const result = await db.query(
      `SELECT user_id, is_verified, kyc_status
       FROM seller_profiles
       WHERE user_id = $1 AND is_deleted = false
       LIMIT 1`,
      [sellerId]
    );

    if (!result.rows.length) {
      return sendError(res, 404, 'Seller profile not found');
    }

    const row = result.rows[0];
    return sendSuccess(res, 200, 'Seller KYC status fetched', {
      sellerId: row.user_id,
      isVerified: row.is_verified,
      kycStatus: row.kyc_status
    });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
});

// ─── GET /api/admin/sellers — paginated seller directory ─────────────────────
router.get('/sellers', protect, isAdmin, requirePermission('Sellers', 'View'), requirePermission('Seller KYC', 'View'), async (req, res) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    let where = `WHERE u.role = 'seller' AND u.is_deleted = false`;
    let idx = 1;

    if (search) {
      where += ` AND (LOWER(u.email) LIKE $${idx} OR LOWER(u.first_name || ' ' || u.last_name) LIKE $${idx} OR LOWER(COALESCE(sp.business_name,'')) LIKE $${idx})`;
      params.push(`%${search.toLowerCase()}%`);
      idx++;
    }

    if (status && status !== 'all') {
      where += ` AND COALESCE(sp.kyc_status, 'not_submitted') = $${idx}`;
      params.push(String(status).toLowerCase());
      idx++;
    }

    const result = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.created_at, u.is_suspended,
              sp.business_name, sp.kyc_status, sp.is_verified, sp.rating,
              (SELECT COUNT(*) FROM products p WHERE p.seller_id = u.id AND p.is_deleted = false) AS product_count
       FROM users u
       LEFT JOIN seller_profiles sp ON sp.user_id = u.id AND sp.is_deleted = false
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, parseInt(limit), offset]
    );

    const countRes = await db.query(
      `SELECT COUNT(*) FROM users u LEFT JOIN seller_profiles sp ON sp.user_id = u.id AND sp.is_deleted = false ${where}`,
      params
    );

    const normStatus = (isVerified, kyc) => {
      const s = String(kyc || 'not_submitted').toLowerCase();
      if (isVerified === true) return 'approved';
      if (isVerified === false && ['approved', 'failed'].includes(s)) return 'rejected';
      return s;
    };

    return sendSuccess(res, 200, 'Sellers fetched', {
      sellers: result.rows.map(r => ({
        id: r.id,
        shopName: r.business_name || `${r.first_name} ${r.last_name}`.trim(),
        sellerName: `${r.first_name} ${r.last_name}`.trim(),
        email: r.email,
        phone: r.phone,
        kycStatus: normStatus(r.is_verified, r.kyc_status),
        accountStatus: r.is_suspended ? 'Suspended' : 'Active',
        rating: parseFloat(r.rating) || 0,
        joinDate: r.created_at,
        productCount: parseInt(r.product_count) || 0,
      })),
      total: parseInt(countRes.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    console.error('GET /admin/sellers error:', err);
    return sendError(res, 500, 'Error fetching sellers', err.message);
  }
});

// ─── GET /api/admin/sellers/:id — full seller detail for the drawer/view page ─
router.get('/sellers/:id', protect, isAdmin, requirePermission('Sellers', 'View'), requirePermission('Seller KYC', 'View'), async (req, res) => {
  try {
    const { id } = req.params;

    const userRes = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.created_at, u.is_suspended,
              sp.business_name, sp.business_description, sp.business_address, sp.business_phone,
              sp.business_email, sp.kyc_status, sp.is_verified, sp.kyc_document_urls,
              sp.rating, sp.total_reviews, sp.available_balance, sp.total_earnings
       FROM users u
       LEFT JOIN seller_profiles sp ON sp.user_id = u.id AND sp.is_deleted = false
       WHERE u.id = $1 AND u.role = 'seller' AND u.is_deleted = false`,
      [id]
    );

    if (!userRes.rows.length) return sendError(res, 404, 'Seller not found');
    const row = userRes.rows[0];

    const [productCount, orderStats, salesRes, debtRes, withdrawRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM products WHERE seller_id=$1 AND is_deleted=false`, [id]),
      db.query(`SELECT COUNT(DISTINCT o.id) AS total_orders FROM orders o JOIN order_items oi ON oi.order_id=o.id WHERE oi.seller_id=$1`, [id]),
      db.query(`SELECT COALESCE(SUM(oi.quantity*oi.price_at_purchase),0) AS total_sales FROM order_items oi WHERE oi.seller_id=$1`, [id]),
      db.query(`SELECT COALESCE(SUM(remaining_debt),0) AS debt FROM seller_debts WHERE seller_id=$1 AND status IN ('active','partial')`, [id]),
      db.query(`SELECT COALESCE(SUM(amount),0) AS withdrawn FROM withdrawals WHERE seller_id=$1 AND status='success'`, [id]),
    ]);

    const kyc = row.kyc_document_urls || {};
    const totalSales = parseFloat(salesRes.rows[0].total_sales) || 0;
    const availableBalance = parseFloat(row.available_balance) || 0;
    const totalWithdrawn = parseFloat(withdrawRes.rows[0].withdrawn) || 0;

    return sendSuccess(res, 200, 'Seller detail fetched', {
      seller: {
        id: row.id,
        email: row.email,
        fullName: kyc.kyc_full_name || `${row.first_name} ${row.last_name}`.trim(),
        sellerName: `${row.first_name} ${row.last_name}`.trim(),
        phone: row.phone,
        shopName: row.business_name,
        businessDescription: row.business_description,
        businessAddress: row.business_address,
        businessPhone: row.business_phone,
        businessEmail: row.business_email,
        kycStatus: row.is_verified ? 'approved' : (row.kyc_status || 'not_submitted'),
        isSuspended: !!row.is_suspended,
        rating: parseFloat(row.rating) || 0,
        totalReviews: row.total_reviews || 0,
        joinDate: row.created_at,
        productCount: parseInt(productCount.rows[0].count) || 0,
        totalOrders: parseInt(orderStats.rows[0].total_orders) || 0,

        // ── Fields viewAdminSeller() reads directly ──
        dateOfBirth: kyc.kyc_dob || null,
        country: kyc.kyc_country || null,
        idType: kyc.kyc_id_type || null,
        idNumber: kyc.kyc_id_number || null,
        residentialAddress: kyc.kyc_business_address || row.business_address || null,
        idDocumentUrl: kyc.kyc_id_document_url || null,
        proofOfAddressUrl: kyc.kyc_proof_of_address_url || kyc.kyc_selfie_url || null,

        // ── Financial summary (matches financialSummary[] lookups) ──
        walletBalance: availableBalance,
        pendingSettlements: parseFloat(debtRes.rows[0].debt) || 0,
        totalSales,
        totalPayouts: totalWithdrawn,
        wallet: { balance: availableBalance, pending: parseFloat(debtRes.rows[0].debt) || 0 },
        financial: { totalSales, totalPayouts: totalWithdrawn },

        availableBalance,
        totalEarnings: parseFloat(row.total_earnings) || 0,
        outstandingDebt: parseFloat(debtRes.rows[0].debt) || 0,
        totalWithdrawn,

        kycFullName: kyc.kyc_full_name || null,
        kycDob: kyc.kyc_dob || null,
        kycIdType: kyc.kyc_id_type || null,
        kycIdDocumentUrl: kyc.kyc_id_document_url || null,
        kycSelfieUrl: kyc.kyc_selfie_url || null,
        kycSubmittedAt: kyc.kyc_submitted_at || null,
      }
    });
  } catch (err) {
    console.error('GET /admin/sellers/:id error:', err);
    return sendError(res, 500, 'Error fetching seller', err.message);
  }
});

// ─── POST /api/admin/sellers/:id/suspend & /activate ──────────────────────────
router.post('/sellers/:id/suspend', protect, isAdmin, requirePermission('Sellers', 'Edit'), async (req, res) => {
  try {
    const { duration, reason } = req.body;
    const durationDays = { '1week': 7, '2weeks': 14, '1month': 30 };
    const suspendedUntil = duration === 'indefinite'
      ? null
      : new Date(Date.now() + (durationDays[duration] || 7) * 86400000);
    const result = await db.query(
      `UPDATE users
       SET is_suspended = true, suspended_until = $1, suspension_reason = $2,
           suspended_by = $3, suspended_at = NOW(), updated_at = NOW()
       WHERE id = $4 AND role = 'seller' RETURNING id`,
      [suspendedUntil, reason || 'Policy violation', req.user.id, req.params.id]
    );
    if (!result.rows.length) return sendError(res, 404, 'Seller not found');

    await logAudit(req.user.id, 'SELLER_SUSPENDED', 'seller', req.params.id, { duration, reason });
    await createDedupedNotification({
      userId: req.params.id,
      title: 'Account Suspended',
      message: `Your account was suspended by MarketMix admin. Reason: ${reason || 'Policy violation'}. ${suspendedUntil ? `Until ${suspendedUntil.toLocaleDateString()}` : 'Indefinite - contact support.'}`,
      type: 'account',
      link: '/sellers/sellers%20notification%20page.html'
    });

    return sendSuccess(res, 200, 'Seller suspended', { suspendedUntil });
  } catch (err) {
    return sendError(res, 500, 'Error suspending seller', err.message);
  }
});

router.post('/sellers/:id/unsuspend', protect, isAdmin, requirePermission('Sellers', 'Edit'), async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE users
       SET is_suspended = false, suspended_until = NULL, suspension_reason = NULL,
           suspended_by = NULL, suspended_at = NULL, updated_at = NOW()
       WHERE id = $1 AND role = 'seller' RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) return sendError(res, 404, 'Seller not found');

    await db.query(
      `UPDATE auto_moderation_actions
       SET admin_reviewed = true, reviewed_by = $1, reviewed_at = NOW()
       WHERE seller_id = $2 AND admin_reviewed = false`,
      [req.user.id, req.params.id]
    );
    await logAudit(req.user.id, 'SELLER_REACTIVATED', 'seller', req.params.id);
    return sendSuccess(res, 200, 'Seller reinstated');
  } catch (err) {
    return sendError(res, 500, 'Error reinstating seller', err.message);
  }
});

router.post('/sellers/:id/activate', protect, isAdmin, requirePermission('Sellers', 'Edit'), async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE users SET is_suspended = false, suspended_until = NULL, suspension_reason = NULL, updated_at = NOW() WHERE id = $1 AND role='seller' RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) return sendError(res, 404, 'Seller not found');
    await logAudit(req.user.id, 'SELLER_REACTIVATED', 'seller', req.params.id);
    return sendSuccess(res, 200, 'Seller reactivated');
  } catch (err) {
    return sendError(res, 500, 'Error reactivating seller', err.message);
  }
});

router.get('/reports', protect, isAdmin, requirePermission('Support Center', 'View'), async (req, res) => {
  try {
    const [products, stores, pendingReview] = await Promise.all([
      db.query(
        `SELECT pr.*, p.name AS product_name
         FROM product_reports pr JOIN products p ON p.id = pr.product_id
         ORDER BY pr.created_at DESC LIMIT 100`
      ),
      db.query(
        `SELECT sr.*, s.business_name
         FROM store_reports sr JOIN stores s ON s.id = sr.store_id
         ORDER BY sr.created_at DESC LIMIT 100`
      ),
      db.query(
        `SELECT ama.*, u.email, u.first_name, u.last_name
         FROM auto_moderation_actions ama JOIN users u ON u.id = ama.seller_id
         WHERE ama.admin_reviewed = false ORDER BY ama.created_at DESC`
      )
    ]);
    return sendSuccess(res, 200, 'Reports fetched', {
      productReports: products.rows,
      storeReports: stores.rows,
      pendingAutoActions: pendingReview.rows
    });
  } catch (err) {
    return sendError(res, 500, 'Error fetching reports', err.message);

  }
});

// POST /api/admin/sellers/:sellerId/kyc/approve
router.post('/sellers/:sellerId/kyc/approve', protect, isAdmin, requirePermission('Seller KYC', 'Approve'), async (req, res) => {
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

    await db.query(
      `UPDATE stores
       SET is_verified = true,
           updated_at = NOW()
       WHERE user_id = $1 AND is_deleted = false`,
      [sellerId]
    );

    await logAudit(req.user.id, 'SELLER_KYC_APPROVED', 'seller', sellerId);
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
router.post('/sellers/:sellerId/kyc/reject', protect, isAdmin, requirePermission('Seller KYC', 'Reject'), async (req, res) => {
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

    await db.query(
      `UPDATE stores
       SET is_verified = false,
           updated_at = NOW()
       WHERE user_id = $1 AND is_deleted = false`,
      [sellerId]
    );

    await logAudit(req.user.id, 'SELLER_KYC_REJECTED', 'seller', sellerId);
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
router.get('/withdrawals', protect, isAdmin, requirePermission('Withdrawals', 'View'), async (req, res) => {
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
router.post('/withdrawals/:id/force-process', protect, isAdmin, requirePermission('Withdrawals', 'Manage'), async (req, res) => {
  try {
    await db.query(
      `UPDATE withdrawals SET scheduled_for=NOW(), updated_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    const { processWithdrawal } = require('../services/payout.service');
    const result = await processWithdrawal(req.params.id);
    if (result.success) await logAudit(req.user.id, 'WITHDRAWAL_PROCESSED', 'withdrawal', req.params.id);
    return sendSuccess(res, 200, 'Processing initiated', result);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
});

// POST /api/admin/withdrawals/:id/approve - override anti-fraud hold
router.post('/withdrawals/:id/approve', protect, isAdmin, requirePermission('Withdrawals', 'Approve'), async (req, res) => {
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
  await logAudit(req.user.id, 'WITHDRAWAL_APPROVED', 'withdrawal', req.params.id, { notes });
  return sendSuccess(res, 200, 'Withdrawal approved and queued for immediate processing');
});

// GET /api/admin/orders - paginated, searchable order list
router.get('/orders', protect, isAdmin, requirePermission('Orders', 'View'), async (req, res) => {
  try {
    const { search, status, paymentStatus, page = 1, limit = 20, from, to } = req.query;
    const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
    const pageLimit = Math.max(parseInt(limit, 10) || 20, 1);
    const offset = (pageNumber - 1) * pageLimit;
    const params = [];
    let where = 'WHERE 1=1';
    let index = 1;

    if (search) {
      where += ` AND (CAST(o.order_number AS TEXT) ILIKE $${index} OR CAST(o.id AS TEXT) ILIKE $${index} OR u.email ILIKE $${index} OR (u.first_name || ' ' || u.last_name) ILIKE $${index})`;
      params.push(`%${search}%`);
      index++;
    }
    if (status && status !== 'all') {
      where += ` AND o.status = $${index}`;
      params.push(status);
      index++;
    }
    if (paymentStatus && paymentStatus !== 'all') {
      where += ` AND o.payment_status = $${index}`;
      params.push(paymentStatus);
      index++;
    }
    if (from) {
      where += ` AND o.created_at >= $${index}`;
      params.push(from);
      index++;
    }
    if (to) {
      where += ` AND o.created_at <= $${index}`;
      params.push(to);
      index++;
    }

    const result = await db.query(
      `SELECT o.id, o.order_number, o.total_amount, o.status, o.payment_status,
              o.payment_method, o.created_at,
              u.first_name, u.last_name, u.email AS buyer_email,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
              (SELECT STRING_AGG(DISTINCT COALESCE(sp.business_name, su.first_name || ' ' || su.last_name), ', ')
               FROM order_items oi2
               JOIN users su ON su.id = oi2.seller_id
               LEFT JOIN seller_profiles sp ON sp.user_id = su.id
               WHERE oi2.order_id = o.id) AS seller_names
       FROM orders o
       JOIN users u ON u.id = o.buyer_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT $${index} OFFSET $${index + 1}`,
      [...params, pageLimit, offset]
    );

    const countResult = await db.query(
      `SELECT COUNT(*) FROM orders o JOIN users u ON u.id = o.buyer_id ${where}`,
      params
    );

    return sendSuccess(res, 200, 'Orders fetched', {
      orders: result.rows.map(row => ({
        id: row.id,
        orderNumber: row.order_number ? `MMX-${row.order_number}` : `#${String(row.id).slice(0, 8).toUpperCase()}`,
        buyerName: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        buyerEmail: row.buyer_email,
        totalAmount: parseFloat(row.total_amount) || 0,
        status: row.status,
        paymentStatus: row.payment_status,
        paymentMethod: row.payment_method,
        itemCount: parseInt(row.item_count, 10) || 0,
        sellerNames: row.seller_names || '-',
        createdAt: row.created_at,
      })),
      total: parseInt(countResult.rows[0].count, 10),
      page: pageNumber,
      limit: pageLimit,
    });
  } catch (err) {
    console.error('GET /admin/orders error:', err);
    return sendError(res, 500, 'Error fetching orders', err.message);
  }
});

// GET /api/admin/orders/:id - full order detail
router.get('/orders/:id', protect, isAdmin, requirePermission('Orders', 'View'), async (req, res) => {
  try {
    const { id } = req.params;
    const orderResult = await db.query(
      `SELECT o.*, u.first_name, u.last_name, u.email AS buyer_email, u.phone AS buyer_phone
       FROM orders o JOIN users u ON u.id = o.buyer_id WHERE o.id = $1`,
      [id]
    );
    if (!orderResult.rows.length) return sendError(res, 404, 'Order not found');
    const order = orderResult.rows[0];

    const [itemsResult, vendorOrdersResult, paymentsResult, escrowResult] = await Promise.all([
      db.query(
        `SELECT oi.*, p.name AS product_name, p.main_image_url,
                COALESCE(sp.business_name, su.first_name || ' ' || su.last_name) AS seller_name
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
         LEFT JOIN users su ON su.id = oi.seller_id
         LEFT JOIN seller_profiles sp ON sp.user_id = su.id
         WHERE oi.order_id = $1 ORDER BY oi.created_at`,
        [id]
      ),
      db.query(
        `SELECT vo.*, COALESCE(sp.business_name, su.first_name || ' ' || su.last_name) AS seller_name
         FROM vendor_orders vo
         LEFT JOIN users su ON su.id = vo.seller_id
         LEFT JOIN seller_profiles sp ON sp.user_id = vo.seller_id
         WHERE vo.order_id = $1 ORDER BY vo.created_at`,
        [id]
      ),
      db.query(
        `SELECT id, provider, provider_reference, amount, currency, status, paid_at, created_at
         FROM payment_transactions WHERE order_id = $1 ORDER BY created_at DESC`,
        [id]
      ),
      db.query(
        `SELECT id, seller_id, amount, status, held_at, auto_release_at, released_at
         FROM escrow_transactions WHERE order_id = $1`,
        [id]
      ),
    ]);

    return sendSuccess(res, 200, 'Order detail fetched', {
      order: {
        ...order,
        buyerName: `${order.first_name || ''} ${order.last_name || ''}`.trim(),
        totalAmount: parseFloat(order.total_amount) || 0,
        subtotal: parseFloat(order.subtotal) || 0,
        shippingFee: parseFloat(order.shipping_fee) || 0,
        couponDiscount: parseFloat(order.coupon_discount) || 0,
      },
      items: itemsResult.rows,
      vendorOrders: vendorOrdersResult.rows,
      payments: paymentsResult.rows,
      escrow: escrowResult.rows,
    });
  } catch (err) {
    console.error('GET /admin/orders/:id error:', err);
    return sendError(res, 500, 'Error fetching order detail', err.message);
  }
});

// PUT /api/admin/orders/:id/status - admin override
router.put('/orders/:id/status', protect, isAdmin, requirePermission('Orders', 'Edit'), async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    const { status, reason } = req.body;
    const validStatuses = ['pending', 'awaiting_payment', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded', 'returned'];
    if (!validStatuses.includes(status)) return sendError(res, 400, 'Invalid status');

    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE orders SET status = $1, updated_at = NOW()
       WHERE id = $2 RETURNING id, status, buyer_id, order_number`,
      [status, id]
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return sendError(res, 404, 'Order not found');
    }
    const order = result.rows[0];

    const vendorOrders = await client.query(
      `UPDATE vendor_orders SET status = $1, updated_at = NOW()
       WHERE order_id = $2 RETURNING seller_id`,
      [status, id]
    );
    await client.query('COMMIT');

    const { logAudit, AUDIT_ACTIONS } = require('../utils/audit');
    await logAudit(req.user.id, AUDIT_ACTIONS.ORDER_UPDATED, 'order', id, {
      status,
      reason: reason || null,
    });

    const shortId = order.order_number ? `MMX-${order.order_number}` : `#${String(id).slice(0, 8).toUpperCase()}`;
    await createDedupedNotification({
      userId: order.buyer_id,
      title: 'Order Status Updated',
      message: `Your order ${shortId} status was updated to "${status}" by MarketMix support.${reason ? ` Reason: ${reason}` : ''}`,
      type: 'order',
      referenceId: id,
      link: '/buyers/buyers%20order%20&%20tracking.html',
    });

    await Promise.allSettled(vendorOrders.rows.map(vendorOrder => createDedupedNotification({
      userId: vendorOrder.seller_id,
      title: 'Order Status Updated by Admin',
      message: `Order ${shortId} was updated to "${status}" by MarketMix support.`,
      type: 'order',
      referenceId: id,
      link: '/sellers/sellers%20order.html',
    })));

    return sendSuccess(res, 200, 'Order status updated', { order });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /admin/orders/:id/status error:', err);
    return sendError(res, 500, 'Error updating order status', err.message);
  } finally {
    client.release();
  }
});

// ─── BUYERS ───────────────────────────────────────────────────────────────
const EFFECTIVELY_SUSPENDED = `(u.is_suspended = true AND (u.suspended_until IS NULL OR u.suspended_until > NOW()))`;

// GET /api/admin/buyers?search=&status=all|active|suspended&page=&limit=
router.get('/buyers', protect, isAdmin, requirePermission('Buyers', 'View'), async (req, res) => {
  try {
    const { search, status = 'all' } = req.query;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const params = [];
    let where = `WHERE u.role = 'buyer' AND u.is_deleted = false`;
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where += ` AND (LOWER(u.email) LIKE $${params.length}
                 OR LOWER(u.first_name || ' ' || u.last_name) LIKE $${params.length}
                 OR COALESCE(u.phone,'') LIKE $${params.length})`;
    }
    if (status === 'suspended') where += ` AND ${EFFECTIVELY_SUSPENDED}`;
    if (status === 'active') where += ` AND NOT ${EFFECTIVELY_SUSPENDED}`;

    const [rows, count, stats] = await Promise.all([
      db.query(
        `SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.created_at,
                ${EFFECTIVELY_SUSPENDED} AS suspended,
                (SELECT COUNT(*) FROM orders o WHERE o.buyer_id = u.id
                   AND o.status NOT IN ('awaiting_payment','payment_failed')) AS order_count,
                (SELECT COALESCE(SUM(total_amount),0) FROM orders o
                   WHERE o.buyer_id = u.id AND o.payment_status = 'paid') AS total_spent
         FROM users u ${where}
         ORDER BY u.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      db.query(`SELECT COUNT(*) FROM users u ${where}`, params),
      db.query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE ${EFFECTIVELY_SUSPENDED}) AS suspended,
                COUNT(*) FILTER (WHERE u.created_at >= NOW() - INTERVAL '30 days') AS new_30d
         FROM users u WHERE u.role='buyer' AND u.is_deleted=false`
      ),
    ]);

    return sendSuccess(res, 200, 'Buyers fetched', {
      buyers: rows.rows.map(r => ({
        id: r.id,
        name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
        email: r.email,
        phone: r.phone || '—',
        status: r.suspended ? 'Suspended' : 'Active',
        joinDate: r.created_at,
        orders: parseInt(r.order_count) || 0,
        totalSpent: parseFloat(r.total_spent) || 0,
      })),
      stats: {
        total: +stats.rows[0].total, suspended: +stats.rows[0].suspended, new30d: +stats.rows[0].new_30d,
      },
      total: parseInt(count.rows[0].count), page, limit,
    });
  } catch (err) {
    console.error('GET /admin/buyers error:', err);
    return sendError(res, 500, 'Error fetching buyers', err.message);
  }
});

// GET /api/admin/buyers/:id
router.get('/buyers/:id', protect, isAdmin, requirePermission('Buyers', 'View'), async (req, res) => {
  try {
    const { id } = req.params;
    const u = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.created_at, u.avatar_url,
              u.suspended_until, u.suspension_reason, u.suspended_at,
              ${EFFECTIVELY_SUSPENDED} AS suspended
       FROM users u WHERE u.id = $1 AND u.role='buyer' AND u.is_deleted=false`, [id]);
    if (!u.rows.length) return sendError(res, 404, 'Buyer not found');

    const [orders, agg, refunds, addr] = await Promise.all([
      db.query(`SELECT id, order_number, total_amount, status, payment_status, created_at
                FROM orders WHERE buyer_id=$1 ORDER BY created_at DESC LIMIT 5`, [id]),
      db.query(`SELECT COUNT(*) AS orders,
                       COALESCE(SUM(total_amount) FILTER (WHERE payment_status='paid'),0) AS spent
                FROM orders WHERE buyer_id=$1`, [id]),
      db.query(`SELECT COUNT(*) FROM refund_cases WHERE buyer_id=$1`, [id]),
      db.query(`SELECT address_line1, city, state, country FROM addresses
                WHERE user_id=$1 AND is_deleted=false ORDER BY is_default DESC LIMIT 1`, [id]),
    ]);

    const r = u.rows[0];
    return sendSuccess(res, 200, 'Buyer fetched', { buyer: {
      id: r.id, name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      email: r.email, phone: r.phone, avatarUrl: r.avatar_url, joinDate: r.created_at,
      suspended: r.suspended, suspendedUntil: r.suspended_until,
      suspensionReason: r.suspension_reason, suspendedAt: r.suspended_at,
      totalOrders: +agg.rows[0].orders, totalSpent: parseFloat(agg.rows[0].spent),
      refundCases: +refunds.rows[0].count,
      address: addr.rows[0] || null,
      recentOrders: orders.rows.map(o => ({
        id: o.id, orderNumber: o.order_number ? `MMX-${o.order_number}` : `#${String(o.id).slice(0,8).toUpperCase()}`,
        amount: parseFloat(o.total_amount), status: o.status,
        paymentStatus: o.payment_status, createdAt: o.created_at })),
    }});
  } catch (err) {
    return sendError(res, 500, 'Error fetching buyer', err.message);
  }
});

// POST /api/admin/buyers/:id/suspend { duration, reason }
router.post('/buyers/:id/suspend', protect, isAdmin, requirePermission('Buyers', 'Edit'), async (req, res) => {
  try {
    const { duration = '1week', reason } = req.body;
    const days = { '1week': 7, '2weeks': 14, '1month': 30 };
    if (duration !== 'indefinite' && !days[duration]) return sendError(res, 400, 'Invalid duration');
    const until = duration === 'indefinite' ? null : new Date(Date.now() + days[duration] * 86400000);

    const r = await db.query(
      `UPDATE users SET is_suspended=true, suspended_until=$1, suspension_reason=$2,
              suspended_by=$3, suspended_at=NOW(), updated_at=NOW()
       WHERE id=$4 AND role='buyer' AND is_deleted=false RETURNING id`,
      [until, reason || 'Policy violation', req.user.id, req.params.id]);
    if (!r.rows.length) return sendError(res, 404, 'Buyer not found');

    const { logAudit } = require('../utils/audit');
    await logAudit(req.user.id, 'BUYER_SUSPENDED', 'user', req.params.id, { duration, reason });
    await createDedupedNotification({
      userId: req.params.id, title: 'Account Suspended',
      message: `Your account was suspended. Reason: ${reason || 'Policy violation'}. ${until ? `Until ${until.toLocaleDateString()}` : 'Contact support.'}`,
      type: 'account', link: '/buyers/help%20center.html' });
    return sendSuccess(res, 200, 'Buyer suspended', { suspendedUntil: until });
  } catch (err) { return sendError(res, 500, 'Error suspending buyer', err.message); }
});

// POST /api/admin/buyers/:id/unsuspend
router.post('/buyers/:id/unsuspend', protect, isAdmin, requirePermission('Buyers', 'Edit'), async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE users SET is_suspended=false, suspended_until=NULL, suspension_reason=NULL,
              suspended_by=NULL, suspended_at=NULL, updated_at=NOW()
       WHERE id=$1 AND role='buyer' RETURNING id`, [req.params.id]);
    if (!r.rows.length) return sendError(res, 404, 'Buyer not found');
    const { logAudit } = require('../utils/audit');
    await logAudit(req.user.id, 'BUYER_UNSUSPENDED', 'user', req.params.id);
    await createDedupedNotification({ userId: req.params.id, title: 'Account Reinstated',
      message: 'Your account has been reactivated. Welcome back!', type: 'account' });
    return sendSuccess(res, 200, 'Buyer reactivated');
  } catch (err) { return sendError(res, 500, 'Error reactivating buyer', err.message); }
});

// DELETE /api/admin/buyers/:id (soft delete, blocked if orders in flight)
router.delete('/buyers/:id', protect, isAdmin, requirePermission('Users', 'Delete'), async (req, res) => {
  try {
    const live = await db.query(
      `SELECT 1 FROM orders WHERE buyer_id=$1 AND status IN ('confirmed','processing','shipped') LIMIT 1`,
      [req.params.id]);
    if (live.rows.length) return sendError(res, 409, 'Buyer has orders in progress. Suspend instead.');

    const r = await db.query(
      `UPDATE users SET is_deleted=true,
              email = CONCAT(email,'--deleted-',EXTRACT(EPOCH FROM NOW())::text), updated_at=NOW()
       WHERE id=$1 AND role='buyer' AND is_deleted=false RETURNING id`, [req.params.id]);
    if (!r.rows.length) return sendError(res, 404, 'Buyer not found');
    const { logAudit } = require('../utils/audit');
    await logAudit(req.user.id, 'USER_DELETED', 'user', req.params.id);
    return sendSuccess(res, 200, 'Buyer deleted');
  } catch (err) { return sendError(res, 500, 'Error deleting buyer', err.message); }
});

// ─── PRODUCTS ─────────────────────────────────────────────────────────────
// GET /api/admin/products?search=&status=all|active|inactive|out-of-stock|reported&limit=
router.get('/products', protect, isAdmin, requirePermission('Products', 'View'), async (req, res) => {
  try {
    const { search, status = 'all' } = req.query;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const params = [];
    let where = `WHERE p.is_deleted = false`;
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where += ` AND (LOWER(p.name) LIKE $${params.length}
                  OR LOWER(COALESCE(p.sku,'')) LIKE $${params.length}
                  OR LOWER(COALESCE(sp.business_name, u.first_name || ' ' || u.last_name)) LIKE $${params.length})`;
    }
    if (status === 'active') where += ` AND p.is_active = true`;
    else if (status === 'inactive') where += ` AND p.is_active = false`;
    else if (status === 'out-of-stock') where += ` AND p.stock_quantity = 0`;
    else if (status === 'reported') where += ` AND EXISTS (SELECT 1 FROM product_reports pr WHERE pr.product_id = p.id)`;

    const [rows, count, stats] = await Promise.all([
      db.query(
        `SELECT p.id, p.name, p.price, p.stock_quantity, p.is_active, p.admin_disabled,
                COALESCE(c.name,'Uncategorized') AS category,
                COALESCE(sp.business_name, u.first_name || ' ' || u.last_name) AS seller,
                (SELECT COUNT(*) FROM product_reports pr WHERE pr.product_id = p.id) AS reports
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN users u ON u.id = p.seller_id
         LEFT JOIN seller_profiles sp ON sp.user_id = p.seller_id
         ${where}
         ORDER BY p.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      db.query(
        `SELECT COUNT(*) FROM products p
         LEFT JOIN users u ON u.id = p.seller_id
         LEFT JOIN seller_profiles sp ON sp.user_id = p.seller_id
         ${where}`, params),
      db.query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE is_active) AS active,
                COUNT(*) FILTER (WHERE NOT is_active) AS inactive,
                COUNT(*) FILTER (WHERE stock_quantity = 0) AS out_of_stock,
                (SELECT COUNT(DISTINCT product_id) FROM product_reports) AS reported
         FROM products WHERE is_deleted = false`)
    ]);

    const s = stats.rows[0];
    return sendSuccess(res, 200, 'Products fetched', {
      products: rows.rows.map(r => ({
        id: r.id,
        name: r.name,
        category: r.category,
        seller: r.seller,
        price: parseFloat(r.price) || 0,
        stock: parseInt(r.stock_quantity) || 0,
        reports: parseInt(r.reports) || 0,
        status: r.admin_disabled ? 'Disabled' : r.is_active
          ? (r.stock_quantity === 0 ? 'Out of Stock' : 'Active') : 'Inactive',
      })),
      stats: {
        total: +s.total, active: +s.active, inactive: +s.inactive,
        out_of_stock: +s.out_of_stock, reported: +s.reported
      },
      total: parseInt(count.rows[0].count), page, limit
    });
  } catch (err) {
    console.error('GET /admin/products error:', err);
    return sendError(res, 500, 'Error fetching products', err.message);
  }
});

// GET /api/admin/products/:id
router.get('/products/:id', protect, isAdmin, requirePermission('Products', 'View'), async (req, res) => {
  try {
    const { id } = req.params;
    const r = await db.query(
      `SELECT p.*, COALESCE(c.name,'Uncategorized') AS category_name,
              COALESCE(sp.business_name, u.first_name || ' ' || u.last_name) AS seller_name,
              u.email AS seller_email,
              COALESCE((SELECT SUM(oi.quantity) FROM order_items oi WHERE oi.product_id = p.id),0) AS units_sold
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN users u ON u.id = p.seller_id
       LEFT JOIN seller_profiles sp ON sp.user_id = p.seller_id
       WHERE p.id = $1 AND p.is_deleted = false`, [id]);
    if (!r.rows.length) return sendError(res, 404, 'Product not found');

    const reports = await db.query(
      `SELECT reason, details, created_at FROM product_reports
       WHERE product_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]);

    const p = r.rows[0];
    return sendSuccess(res, 200, 'Product fetched', { product: {
      id: p.id, name: p.name, description: p.description,
      image: p.main_image_url, sku: p.sku,
      seller: p.seller_name, sellerEmail: p.seller_email,
      category: p.category_name,
      price: parseFloat(p.price) || 0,
      sellerPrice: p.seller_price ? parseFloat(p.seller_price) : null,
      stock: p.stock_quantity, unitsSold: parseInt(p.units_sold) || 0,
      views: p.views || 0,
      isActive: p.is_active, adminDisabled: !!p.admin_disabled,
      disabledReason: p.disabled_reason,
      reports: reports.rows
    }});
  } catch (err) {
    return sendError(res, 500, 'Error fetching product', err.message);
  }
});

// POST /api/admin/products/:id/deactivate { reason }
router.post('/products/:id/deactivate', protect, isAdmin, requirePermission('Products', 'Edit'), async (req, res) => {
  try {
    const reason = (req.body.reason || '').trim();
    if (reason.length < 10) return sendError(res, 400, 'Reason must be at least 10 characters');
    const r = await db.query(
      `UPDATE products SET is_active=false, admin_disabled=true, disabled_reason=$1,
              disabled_by=$2, disabled_at=NOW(), updated_at=NOW()
       WHERE id=$3 AND is_deleted=false RETURNING id, name, seller_id`,
      [reason, req.user.id, req.params.id]);
    if (!r.rows.length) return sendError(res, 404, 'Product not found');

    const { logAudit } = require('../utils/audit');
    await logAudit(req.user.id, 'PRODUCT_UPDATED', 'product', req.params.id, { action: 'disabled', reason });
    await createDedupedNotification({
      userId: r.rows[0].seller_id, title: 'Product Disabled',
      message: `"${r.rows[0].name}" was disabled by MarketMix. Reason: ${reason}`,
      type: 'account', referenceId: req.params.id, link: '/sellers/sellers%20product.html' });
    return sendSuccess(res, 200, 'Product disabled');
  } catch (err) { return sendError(res, 500, 'Error disabling product', err.message); }
});

// POST /api/admin/products/:id/activate
router.post('/products/:id/activate', protect, isAdmin, requirePermission('Products', 'Edit'), async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE products SET is_active=true, admin_disabled=false, disabled_reason=NULL,
              disabled_by=NULL, disabled_at=NULL, updated_at=NOW()
       WHERE id=$1 AND is_deleted=false RETURNING id, name, seller_id`, [req.params.id]);
    if (!r.rows.length) return sendError(res, 404, 'Product not found');

    const { logAudit } = require('../utils/audit');
    await logAudit(req.user.id, 'PRODUCT_UPDATED', 'product', req.params.id, { action: 'activated' });
    await createDedupedNotification({
      userId: r.rows[0].seller_id, title: 'Product Approved',
      message: `"${r.rows[0].name}" is now live.`, type: 'account',
      referenceId: req.params.id, link: '/sellers/sellers%20product.html' });
    return sendSuccess(res, 200, 'Product activated');
  } catch (err) { return sendError(res, 500, 'Error activating product', err.message); }
});

// DELETE /api/admin/products/:id (soft delete)
router.delete('/products/:id', protect, isAdmin, requirePermission('Products', 'Delete'), async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE products SET is_deleted=true, is_active=false, updated_at=NOW()
       WHERE id=$1 AND is_deleted=false RETURNING id`, [req.params.id]);
    if (!r.rows.length) return sendError(res, 404, 'Product not found');
    const { logAudit } = require('../utils/audit');
    await logAudit(req.user.id, 'PRODUCT_DELETED', 'product', req.params.id);
    return sendSuccess(res, 200, 'Product deleted');
  } catch (err) { return sendError(res, 500, 'Error deleting product', err.message); }
});

// ─── CATEGORIES ───────────────────────────────────────────────────────────
const catAudit = (...a) => require('../utils/audit').logAudit(...a);

// GET /api/admin/categories?search=&status=all|active|inactive
router.get('/categories', protect, isAdmin, requirePermission('Products', 'View'), async (req, res) => {
  try {
    const { search, status = 'all' } = req.query;
    const params = [];
    let where = `WHERE c.is_deleted = false`;
    if (search) { params.push(`%${search.toLowerCase()}%`); where += ` AND LOWER(c.name) LIKE $${params.length}`; }
    if (status === 'active') where += ` AND c.is_active = true`;
    if (status === 'inactive') where += ` AND c.is_active = false`;

    const r = await db.query(
      `SELECT c.id, c.name, c.description, c.is_active, c.created_at,
              (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_deleted = false) AS product_count,
              (SELECT COUNT(*) FROM subcategories s WHERE s.category_id = c.id AND s.is_active = true) AS subcategory_count
       FROM categories c ${where} ORDER BY c.name ASC`, params);

    return sendSuccess(res, 200, 'Categories fetched', {
      categories: r.rows.map(c => ({
        id: c.id, name: c.name, description: c.description || '',
        isActive: c.is_active, createdAt: c.created_at,
        productCount: +c.product_count, subcategoryCount: +c.subcategory_count,
      })),
    });
  } catch (err) { return sendError(res, 500, 'Error fetching categories', err.message); }
});

// POST /api/admin/categories { name, description }
router.post('/categories', protect, isAdmin, requirePermission('Products', 'Create'), async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const description = (req.body.description || '').trim() || null;
    if (name.length < 2 || name.length > 100) return sendError(res, 400, 'Name must be 2–100 characters');

    const dup = await db.query(
      `SELECT 1 FROM categories WHERE LOWER(name)=LOWER($1) AND is_deleted=false`, [name]);
    if (dup.rows.length) return sendError(res, 409, 'A category with this name already exists');

    const r = await db.query(
      `INSERT INTO categories (name, description, is_active, is_deleted, created_at, updated_at)
       VALUES ($1,$2,true,false,NOW(),NOW()) RETURNING id, name`, [name, description]);
    await catAudit(req.user.id, 'CATEGORY_CREATED', 'category', r.rows[0].id, { name });
    return sendSuccess(res, 201, 'Category created', { category: r.rows[0] });
  } catch (err) { return sendError(res, 500, 'Error creating category', err.message); }
});

// PUT /api/admin/categories/:id { name, description }
router.put('/categories/:id', protect, isAdmin, requirePermission('Products', 'Edit'), async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const description = (req.body.description || '').trim() || null;
    if (name.length < 2 || name.length > 100) return sendError(res, 400, 'Name must be 2–100 characters');

    const dup = await db.query(
      `SELECT 1 FROM categories WHERE LOWER(name)=LOWER($1) AND id<>$2 AND is_deleted=false`, [name, req.params.id]);
    if (dup.rows.length) return sendError(res, 409, 'A category with this name already exists');

    const r = await db.query(
      `UPDATE categories SET name=$1, description=$2, updated_at=NOW()
       WHERE id=$3 AND is_deleted=false RETURNING id, name`, [name, description, req.params.id]);
    if (!r.rows.length) return sendError(res, 404, 'Category not found');
    await catAudit(req.user.id, 'CATEGORY_UPDATED', 'category', req.params.id, { name });
    return sendSuccess(res, 200, 'Category updated', { category: r.rows[0] });
  } catch (err) { return sendError(res, 500, 'Error updating category', err.message); }
});

// POST /api/admin/categories/:id/toggle
router.post('/categories/:id/toggle', protect, isAdmin, requirePermission('Products', 'Edit'), async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE categories SET is_active = NOT is_active, updated_at=NOW()
       WHERE id=$1 AND is_deleted=false RETURNING id, is_active`, [req.params.id]);
    if (!r.rows.length) return sendError(res, 404, 'Category not found');
    await catAudit(req.user.id, 'CATEGORY_UPDATED', 'category', req.params.id, { isActive: r.rows[0].is_active });
    return sendSuccess(res, 200, r.rows[0].is_active ? 'Category activated' : 'Category deactivated', { isActive: r.rows[0].is_active });
  } catch (err) { return sendError(res, 500, 'Error toggling category', err.message); }
});

// DELETE /api/admin/categories/:id  (soft delete, blocked if products exist)
router.delete('/categories/:id', protect, isAdmin, requirePermission('Products', 'Delete'), async (req, res) => {
  try {
    const used = await db.query(
      `SELECT COUNT(*) FROM products WHERE category_id=$1 AND is_deleted=false`, [req.params.id]);
    if (+used.rows[0].count > 0)
      return sendError(res, 409, `Category has ${used.rows[0].count} product(s). Deactivate it instead, or move the products first.`);

    const r = await db.query(
      `UPDATE categories SET is_deleted=true, is_active=false, updated_at=NOW()
       WHERE id=$1 AND is_deleted=false RETURNING id`, [req.params.id]);
    if (!r.rows.length) return sendError(res, 404, 'Category not found');
    await db.query(`UPDATE subcategories SET is_active=false WHERE category_id=$1`, [req.params.id]);
    await catAudit(req.user.id, 'CATEGORY_DELETED', 'category', req.params.id);
    return sendSuccess(res, 200, 'Category deleted');
  } catch (err) { return sendError(res, 500, 'Error deleting category', err.message); }
});

// ─── SUBCATEGORIES ────────────────────────────────────────────────────────
const FIELD_TYPES = ['text', 'select', 'multiselect', 'tags', 'date'];

function validateFields(fields) {
  if (!Array.isArray(fields)) return 'fields must be an array';
  if (fields.length > 25) return 'Maximum 25 fields per subcategory';
  const seen = new Set();
  for (const f of fields) {
    if (!f || !/^[a-z][a-z0-9_]{0,39}$/.test(f.key || '')) return `Invalid key "${f?.key}" (lowercase letters, numbers, underscores)`;
    if (seen.has(f.key)) return `Duplicate key "${f.key}"`;
    seen.add(f.key);
    if (!(f.label || '').trim()) return `Field "${f.key}" needs a label`;
    if (!FIELD_TYPES.includes(f.type)) return `Field "${f.key}" has invalid type`;
    if (['select', 'multiselect'].includes(f.type) &&
        (!Array.isArray(f.options) || f.options.length < 1 || f.options.some(o => !String(o).trim())))
      return `Field "${f.key}" needs at least one option`;
  }
  return null;
}

const cleanFields = (fields) => fields.map(f => ({
  key: f.key, label: f.label.trim(), type: f.type, required: !!f.required,
  ...(['select', 'multiselect'].includes(f.type) ? { options: f.options.map(o => String(o).trim()) } : {}),
}));

// GET /api/admin/categories/:id/subcategories
router.get('/categories/:id/subcategories', protect, isAdmin, requirePermission('Products', 'View'), async (req, res) => {
  try {
    const r = await db.query(
      `SELECT s.id, s.name, s.fields, s.is_active,
              (SELECT COUNT(*) FROM products p WHERE p.subcategory_id = s.id AND p.is_deleted = false) AS product_count
       FROM subcategories s WHERE s.category_id = $1 ORDER BY s.name`, [req.params.id]);
    return sendSuccess(res, 200, 'Subcategories fetched', {
      subcategories: r.rows.map(s => ({
        id: s.id, name: s.name, isActive: s.is_active, productCount: +s.product_count,
        fields: typeof s.fields === 'string' ? JSON.parse(s.fields) : (s.fields || []),
      })),
    });
  } catch (err) { return sendError(res, 500, 'Error fetching subcategories', err.message); }
});

// POST /api/admin/categories/:id/subcategories { name, fields }
router.post('/categories/:id/subcategories', protect, isAdmin, requirePermission('Products', 'Create'), async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (name.length < 2 || name.length > 100) return sendError(res, 400, 'Name must be 2–100 characters');
    const fields = req.body.fields || [];
    const bad = validateFields(fields);
    if (bad) return sendError(res, 400, bad);

    const cat = await db.query(`SELECT 1 FROM categories WHERE id=$1 AND is_deleted=false`, [req.params.id]);
    if (!cat.rows.length) return sendError(res, 404, 'Category not found');
    const dup = await db.query(
      `SELECT 1 FROM subcategories WHERE category_id=$1 AND LOWER(name)=LOWER($2)`, [req.params.id, name]);
    if (dup.rows.length) return sendError(res, 409, 'Subcategory name already exists in this category');

    const r = await db.query(
      `INSERT INTO subcategories (category_id, name, fields, is_active) VALUES ($1,$2,$3,true) RETURNING id`,
      [req.params.id, name, JSON.stringify(cleanFields(fields))]);
    await catAudit(req.user.id, 'SUBCATEGORY_CREATED', 'subcategory', r.rows[0].id, { name });
    return sendSuccess(res, 201, 'Subcategory created', { id: r.rows[0].id });
  } catch (err) { return sendError(res, 500, 'Error creating subcategory', err.message); }
});

// PUT /api/admin/subcategories/:subId { name, fields }
router.put('/subcategories/:subId', protect, isAdmin, requirePermission('Products', 'Edit'), async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (name.length < 2 || name.length > 100) return sendError(res, 400, 'Name must be 2–100 characters');
    const fields = req.body.fields || [];
    const bad = validateFields(fields);
    if (bad) return sendError(res, 400, bad);

    const dup = await db.query(
      `SELECT 1 FROM subcategories WHERE LOWER(name)=LOWER($1) AND id<>$2
         AND category_id=(SELECT category_id FROM subcategories WHERE id=$2)`, [name, req.params.subId]);
    if (dup.rows.length) return sendError(res, 409, 'Subcategory name already exists in this category');

    const r = await db.query(
      `UPDATE subcategories SET name=$1, fields=$2 WHERE id=$3 RETURNING id`,
      [name, JSON.stringify(cleanFields(fields)), req.params.subId]);
    if (!r.rows.length) return sendError(res, 404, 'Subcategory not found');
    await catAudit(req.user.id, 'SUBCATEGORY_UPDATED', 'subcategory', req.params.subId, { name });
    return sendSuccess(res, 200, 'Subcategory updated');
  } catch (err) { return sendError(res, 500, 'Error updating subcategory', err.message); }
});

// POST /api/admin/subcategories/:subId/toggle
router.post('/subcategories/:subId/toggle', protect, isAdmin, requirePermission('Products', 'Edit'), async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE subcategories SET is_active = NOT is_active WHERE id=$1 RETURNING is_active`, [req.params.subId]);
    if (!r.rows.length) return sendError(res, 404, 'Subcategory not found');
    await catAudit(req.user.id, 'SUBCATEGORY_UPDATED', 'subcategory', req.params.subId, { isActive: r.rows[0].is_active });
    return sendSuccess(res, 200, r.rows[0].is_active ? 'Subcategory activated' : 'Subcategory deactivated');
  } catch (err) { return sendError(res, 500, 'Error toggling subcategory', err.message); }
});

// DELETE /api/admin/subcategories/:subId (blocked if products use it)
router.delete('/subcategories/:subId', protect, isAdmin, requirePermission('Products', 'Delete'), async (req, res) => {
  try {
    const used = await db.query(
      `SELECT COUNT(*) FROM products WHERE subcategory_id=$1 AND is_deleted=false`, [req.params.subId]);
    if (+used.rows[0].count > 0)
      return sendError(res, 409, `${used.rows[0].count} product(s) use this subcategory. Deactivate it instead.`);
    const r = await db.query(`DELETE FROM subcategories WHERE id=$1 RETURNING id`, [req.params.subId]);
    if (!r.rows.length) return sendError(res, 404, 'Subcategory not found');
    await catAudit(req.user.id, 'SUBCATEGORY_DELETED', 'subcategory', req.params.subId);
    return sendSuccess(res, 200, 'Subcategory deleted');
  } catch (err) { return sendError(res, 500, 'Error deleting subcategory', err.message); }
});

// ─── PAYMENTS ─────────────────────────────────────────────
const PAY_BASE = `WITH base AS (
 SELECT pt.id, pt.provider_reference AS reference, INITCAP(pt.provider) AS gateway, pt.channel,
  pt.amount::numeric AS amount, pt.created_at, pt.paid_at,
  CASE WHEN pt.status='refunded' THEN 'Refunded'
       WHEN pt.status='success'  THEN 'Paid'
       WHEN o.status='cancelled' THEN 'Cancelled'
       WHEN pt.status='failed'   THEN 'Failed'
       ELSE 'Pending' END AS status,
  o.id AS order_uuid, COALESCE('MMX-'||o.order_number::text,'#'||UPPER(LEFT(o.id::text,8))) AS order_no,
  u.first_name||' '||u.last_name AS buyer, u.email AS buyer_email, u.phone AS buyer_phone,
  (SELECT STRING_AGG(DISTINCT COALESCE(sp.business_name,su.first_name||' '||su.last_name),', ')
   FROM order_items oi JOIN users su ON su.id=oi.seller_id
   LEFT JOIN seller_profiles sp ON sp.user_id=su.id WHERE oi.order_id=o.id) AS seller
 FROM payment_transactions pt
 JOIN orders o ON o.id=pt.order_id JOIN users u ON u.id=pt.user_id)`;

const METHOD = { card:'Card', bank:'Bank Transfer', bank_transfer:'Bank Transfer', ussd:'USSD', mobile_money:'Mobile Money' };
const shape = r => ({
  id: r.id, displayId: r.reference, reference: r.reference, buyer: r.buyer, seller: r.seller || '—',
  orderId: r.order_no, amount: parseFloat(r.amount), gateway: r.gateway,
  method: METHOD[r.channel] || r.channel || '—', status: r.status, date: r.created_at,
});

router.get('/payments', protect, isAdmin, requirePermission('Payments', 'View'), async (req, res) => {
  try {
    const { search, status='all', method='all', gateway='all', date } = req.query;
    const page = Math.max(+req.query.page || 1, 1), limit = Math.min(+req.query.limit || 20, 100);
    const p = []; let w = 'WHERE 1=1';
    if (search) { p.push(`%${search}%`); w += ` AND (reference ILIKE $${p.length} OR order_no ILIKE $${p.length} OR buyer ILIKE $${p.length} OR buyer_email ILIKE $${p.length} OR seller ILIKE $${p.length})`; }
    if (status  !== 'all') { p.push(status.toLowerCase());  w += ` AND LOWER(status)=$${p.length}`; }
    if (method  !== 'all') { p.push(method);  w += ` AND channel=$${p.length}`; }
    if (gateway !== 'all') { p.push(gateway.toLowerCase()); w += ` AND LOWER(gateway)=$${p.length}`; }
    if (date) { p.push(date); w += ` AND created_at::date=$${p.length}`; }

    const [rows, count, st] = await Promise.all([
      db.query(`${PAY_BASE} SELECT * FROM base ${w} ORDER BY created_at DESC LIMIT $${p.length+1} OFFSET $${p.length+2}`, [...p, limit, (page-1)*limit]),
      db.query(`${PAY_BASE} SELECT COUNT(*) FROM base ${w}`, p),
      db.query(`${PAY_BASE} SELECT
         COALESCE(SUM(amount) FILTER (WHERE status='Paid'),0) total,
         COALESCE(SUM(amount) FILTER (WHERE status='Paid' AND created_at::date=CURRENT_DATE),0) today,
         COUNT(*) FILTER (WHERE status='Pending') pending,
         COUNT(*) FILTER (WHERE status='Failed') failed,
         COALESCE(SUM(amount) FILTER (WHERE status='Refunded'),0) refunded FROM base`)
    ]);
    const s = st.rows[0];
    return sendSuccess(res, 200, 'Payments fetched', {
      payments: rows.rows.map(shape), total: +count.rows[0].count, page, limit,
      stats: { total:+s.total, today:+s.today, pending:+s.pending, failed:+s.failed, refunded:+s.refunded }
    });
  } catch (e) {
    console.error('payments route error:', e.message, e.position || '');
    return sendError(res, 500, 'Error fetching payments', e.message);
  }
});

router.get('/payments/overview', protect, isAdmin, requirePermission('Payments', 'View'), async (req, res) => {
  try {
    const [gw, paid, esc, wd, act] = await Promise.all([
      db.query(`${PAY_BASE} SELECT gateway, COUNT(*) total, COUNT(*) FILTER (WHERE status='Paid') ok,
        COUNT(*) FILTER (WHERE created_at::date=CURRENT_DATE) today,
        AVG(EXTRACT(EPOCH FROM paid_at-created_at)) secs FROM base GROUP BY gateway`),
      db.query(`${PAY_BASE} SELECT COALESCE(SUM(amount) FILTER (WHERE status='Paid'),0) paid,
        COALESCE(SUM(amount) FILTER (WHERE status='Refunded'),0) refunded FROM base`),
      db.query(`SELECT COALESCE(SUM(amount),0) v FROM escrow_transactions WHERE status='held'`),
      db.query(`SELECT COALESCE(SUM(amount),0) v FROM withdrawals WHERE status='success'`),
      db.query(`${PAY_BASE} SELECT status, buyer, order_no, reference, created_at FROM base ORDER BY created_at DESC LIMIT 6`)
    ]);
    const paidT = +paid.rows[0].paid, refunded = +paid.rows[0].refunded;
    const ICON = { Paid:'fa-money-bill-wave', Failed:'fa-exclamation-triangle', Refunded:'fa-undo', Pending:'fa-hourglass-half', Cancelled:'fa-ban' };
    return sendSuccess(res, 200, 'Overview', {
      gateways: gw.rows.map(g => {
        const rate = g.total > 0 ? (g.ok / g.total) * 100 : 0;
        return { name: g.gateway, successRate: rate.toFixed(1)+'%', transactions: String(g.today),
          processingTime: g.secs ? Math.round(g.secs)+'s' : '—',
          status: rate >= 95 ? 'Healthy' : rate >= 85 ? 'Monitoring' : 'Degraded',
          health: rate >= 95 ? 'good' : rate >= 85 ? 'medium' : 'poor' };
      }),
      finance: {
        revenue: paidT - stripFee(paidT), pendingSettlements: stripFee(+esc.rows[0].v),
        withdrawals: +wd.rows[0].v, refundRatio: paidT ? +(refunded/paidT*100).toFixed(1) : 0
      },
      activity: act.rows.map(a => ({ icon: ICON[a.status], title: `Payment ${a.status.toLowerCase()}`,
        description: `${a.buyer} · ${a.order_no}`, time: a.created_at }))
    });
  } catch (e) {
    console.error('payments overview route error:', e.message, e.position || '');
    return sendError(res, 500, 'Error fetching overview', e.message);
  }
});

router.get('/payments/:id', protect, isAdmin, requirePermission('Payments', 'View'), async (req, res) => {
  try {
    const r = (await db.query(`${PAY_BASE} SELECT * FROM base WHERE id=$1`, [req.params.id])).rows[0];
    if (!r) return sendError(res, 404, 'Payment not found');
    const [esc, sl] = await Promise.all([
      db.query(`SELECT status FROM escrow_transactions WHERE order_id=$1`, [r.order_uuid]),
      db.query(`SELECT su.email, su.phone FROM order_items oi JOIN users su ON su.id=oi.seller_id WHERE oi.order_id=$1 LIMIT 1`, [r.order_uuid])
    ]);
    const amount = +r.amount, paid = ['Paid','Refunded'].includes(r.status);
    const released = esc.rows.length && esc.rows.every(e => e.status === 'released');
    const T = {
      Paid:      ['complete','complete','complete','complete', released?'complete':'active', released?'complete':'pending'],
      Refunded:  ['complete','complete','complete','complete','complete','refunded'],
      Failed:    ['complete','complete','failed','pending','pending','pending'],
      Cancelled: ['complete','cancelled','pending','pending','pending','pending'],
      Pending:   ['complete','active','pending','pending','pending','pending'],
    }[r.status];
    const NOTES = { Paid:'Payment captured; funds held in escrow until delivery is confirmed.',
      Pending:'Awaiting payment confirmation from the gateway.', Failed:'Gateway reported a failed or declined charge.',
      Refunded:'Payment was refunded to the buyer.', Cancelled:'Order was cancelled before payment was captured.' };
    return sendSuccess(res, 200, 'Payment fetched', { ...shape(r),
      fee: paid ? amount - stripFee(amount) : 0, earnings: paid ? stripFee(amount) : 0,
      notes: NOTES[r.status], timeline: T,
      buyerInfo:  { name: r.buyer, email: r.buyer_email, phone: r.buyer_phone || '—' },
      sellerInfo: { name: r.seller || '—', email: sl.rows[0]?.email || '—', phone: sl.rows[0]?.phone || '—' } });
  } catch (e) { return sendError(res, 500, 'Error fetching payment', e.message); }
});

module.exports = router;