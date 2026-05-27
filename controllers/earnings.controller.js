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

    // Available + total from seller_profiles (source of truth)
    const profileResult = await db.query(
      `SELECT 
        COALESCE(total_earnings, 0) as total_earnings,
        COALESCE(available_balance, 0) as available_balance
       FROM seller_profiles WHERE user_id = $1`,
      [sellerId]
    );

    // Pending = escrow held amounts for this seller
    const pendingResult = await db.query(
      `SELECT COALESCE(SUM(amount * 0.95), 0) as pending_earnings
       FROM escrow_transactions 
       WHERE seller_id = $1 AND status = 'held'`,
      [sellerId]
    );

    // Total withdrawn
    const withdrawnResult = await db.query(
      `SELECT COALESCE(SUM(ABS(amount)), 0) as total_withdrawn
       FROM earnings 
       WHERE seller_id = $1 AND status = 'withdrawn'`,
      [sellerId]
    );

    // Recent transactions
    const transactionsResult = await db.query(
      `SELECT 
        e.id, e.amount, e.net_amount, e.status, e.created_at,
        p.name as product_name, o.id as order_id
       FROM earnings e
       LEFT JOIN order_items oi ON e.order_item_id = oi.id
       LEFT JOIN products p ON oi.product_id = p.id
       LEFT JOIN orders o ON e.order_id = o.id
       WHERE e.seller_id = $1
       ORDER BY e.created_at DESC LIMIT 50`,
      [sellerId]
    );

    // Escrow pending transactions (show as pending in transaction list)
    const escrowResult = await db.query(
      `SELECT 
        et.id, et.amount, et.held_at as created_at,
        et.auto_release_at, et.order_id
       FROM escrow_transactions et
       WHERE et.seller_id = $1 AND et.status = 'held'
       ORDER BY et.held_at DESC`,
      [sellerId]
    );

    // Product earnings
    const productEarningsResult = await db.query(
      `SELECT p.name, COUNT(e.id) as quantity, SUM(e.net_amount) as revenue
       FROM earnings e
       JOIN order_items oi ON e.order_item_id = oi.id
       JOIN products p ON oi.product_id = p.id
       WHERE e.seller_id = $1
       GROUP BY p.id, p.name
       ORDER BY revenue DESC`,
      [sellerId]
    );

    const profile = profileResult.rows[0] || { total_earnings: 0, available_balance: 0 };

    // Combine transactions + pending escrow into one list
    const pendingTxs = escrowResult.rows.map(et => ({
      id: et.id,
      date: et.created_at,
      amount: parseFloat(et.amount) * 0.95,
      status: 'pending',
      productName: null,
      orderId: et.order_id,
      type: 'Escrow (releasing ' + new Date(et.auto_release_at).toLocaleDateString() + ')',
      autoReleaseAt: et.auto_release_at
    }));

    const allTransactions = [
      ...pendingTxs,
      ...transactionsResult.rows.map(row => ({
        id: row.id,
        date: row.created_at,
        amount: parseFloat(row.net_amount || row.amount),
        status: row.status,
        productName: row.product_name,
        orderId: row.order_id,
        type: 'Sale'
      }))
    ];

    return sendSuccess(res, 200, 'Earnings fetched', {
      summary: {
        totalEarnings: parseFloat(profile.total_earnings),
        availableBalance: parseFloat(profile.available_balance),
        pendingEarnings: parseFloat(pendingResult.rows[0].pending_earnings),
        totalWithdrawn: parseFloat(withdrawnResult.rows[0].total_withdrawn)
      },
      transactions: allTransactions,
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
