const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const { isAdmin } = require('../middlewares/role.middleware');
const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const { stripFee } = require('../utils/pricing');
const { processWithdrawal } = require('../services/payout.service');
const { createDedupedNotification } = require('../controllers/notification.controller');
const { getPaymentSummaryForRefundCase } = require('../services/refundPaymentPreparationService');
const { recoverSellerDebtFromEscrowRelease } = require('../services/sellerDebtRecoveryService');
const { syncRefundCase } = require('../utils/refundSync');

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

  return refundCases.map((refundCase) => {
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
    return sendSuccess(res, 200, `Escrow ${action}d successfully`);
  } catch (err) {
    await client.query('ROLLBACK');
    return sendError(res, 500, err.message);
  } finally {
    client.release();
  }
});

// GET /api/admin/dashboard-stats
router.get('/dashboard-stats', protect, isAdmin, async (req, res) => {
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

// GET /api/admin/marketplace-performance?period=today|7d|30d|6m|1y
router.get('/marketplace-performance', protect, isAdmin, async (req, res) => {
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
router.get('/marketplace-performance/chart', protect, isAdmin, async (req, res) => {
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
router.get('/refunds/pending', protect, isAdmin, async (req, res) => {
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
router.get(['/seller-adjustments', '/seller-adjustments/'], protect, isAdmin, async (req, res) => {
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
       RETURNING id, buyer_id, seller_id, order_id, resolution_status, status`,
      [refundId, trimmedReason, decidedBy]
    );

    if (!result.rows.length) {
      return sendError(res, 404, 'Refund case not found');
    }

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
       RETURNING id, buyer_id, seller_id, order_id, resolution_status, status`,
      [refundId, trimmedReason, decidedBy]
    );

    if (!result.rows.length) {
      return sendError(res, 404, 'Refund case not found');
    }

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