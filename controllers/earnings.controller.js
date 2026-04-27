const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * @desc    Get seller earnings summary and transactions
 * @route   GET /api/earnings
 * @access  Private (seller only)
 */
const getSellerEarnings = async (req, res) => {
  try {
    const sellerId = req.user.id;

    // 1. Get summary from seller_profiles (cached totals)
    const profileResult = await db.query(
      `SELECT 
        COALESCE(total_earnings, 0) as total_earnings,
        COALESCE(available_balance, 0) as available_balance
       FROM seller_profiles 
       WHERE user_id = $1`,
      [sellerId]
    );

    // 2. Get detailed summary from earnings table
    const summaryResult = await db.query(
      `SELECT 
        COALESCE(SUM(net_amount) FILTER (WHERE status = 'pending'), 0) as pending_earnings,
        COALESCE(SUM(net_amount) FILTER (WHERE status = 'withdrawn'), 0) as total_withdrawn
       FROM earnings 
       WHERE seller_id = $1`,
      [sellerId]
    );

    // 3. Get recent transactions
    const transactionsResult = await db.query(
      `SELECT 
        e.id,
        e.amount,
        e.commission,
        e.net_amount,
        e.status,
        e.created_at,
        p.name as product_name,
        o.id as order_id
       FROM earnings e
       LEFT JOIN order_items oi ON e.order_item_id = oi.id
       LEFT JOIN products p ON oi.product_id = p.id
       LEFT JOIN orders o ON e.order_id = o.id
       WHERE e.seller_id = $1
       ORDER BY e.created_at DESC
       LIMIT 50`,
      [sellerId]
    );

    // 4. Get earnings by product
    const productEarningsResult = await db.query(
      `SELECT 
        p.name,
        COUNT(e.id) as quantity,
        SUM(e.net_amount) as revenue
       FROM earnings e
       JOIN order_items oi ON e.order_item_id = oi.id
       JOIN products p ON oi.product_id = p.id
       WHERE e.seller_id = $1
       GROUP BY p.id, p.name
       ORDER BY revenue DESC`,
      [sellerId]
    );

    const profile = profileResult.rows[0] || { total_earnings: 0, available_balance: 0 };
    const summary = summaryResult.rows[0];

    return sendSuccess(res, 200, 'Earnings data fetched successfully', {
      summary: {
        totalEarnings: parseFloat(profile.total_earnings),
        availableBalance: parseFloat(profile.available_balance),
        pendingEarnings: parseFloat(summary.pending_earnings),
        totalWithdrawn: parseFloat(summary.total_withdrawn)
      },
      transactions: transactionsResult.rows.map(row => ({
        id: row.id,
        date: row.created_at,
        amount: parseFloat(row.net_amount),
        status: row.status,
        productName: row.product_name,
        orderId: row.order_id,
        type: 'Sale' // In this table, most entries are sales
      })),
      productEarnings: productEarningsResult.rows.map(row => ({
        name: row.name,
        qty: parseInt(row.quantity),
        revenue: parseFloat(row.revenue)
      }))
    });
  } catch (error) {
    console.error('getSellerEarnings error:', error);
    return sendError(res, 500, 'Error fetching earnings data', error.message);
  }
};

module.exports = {
  getSellerEarnings
};
