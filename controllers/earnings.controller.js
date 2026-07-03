const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const { stripFee } = require('../utils/pricing');

/**
 * @desc    Get seller earnings summary and transactions
 * @route   GET /api/earnings
 * @access  Private (seller only)
 */
const getSellerEarnings = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const storeHeader = typeof req.headers['x-store-id'] === 'string' ? req.headers['x-store-id'].trim() : '';
    const storeId = storeHeader && storeHeader !== 'null' && storeHeader !== 'undefined'
      ? storeHeader
      : req.query.storeId;
    const storeFilter = storeId ? ' AND e.store_id = $2' : '';

    const runQuery = async (query, params, fallbackQuery = null, fallbackParams = null) => {
      try {
        return await db.query(query, params);
      } catch (error) {
        if (storeId && fallbackQuery && fallbackParams) {
          console.warn('Earnings query failed with store filter, retrying without storeId:', error.message);
          return await db.query(fallbackQuery, fallbackParams);
        }
        throw error;
      }
    };

    const profileResult = await runQuery(
      storeId
        ? `SELECT COALESCE(total_earnings, 0) as total_earnings,
                  COALESCE(available_balance, 0) as available_balance
           FROM stores WHERE id = $1 AND user_id = $2`
        : `SELECT COALESCE(total_earnings, 0) as total_earnings,
                  COALESCE(available_balance, 0) as available_balance
           FROM seller_profiles WHERE user_id = $1`,
      storeId ? [storeId, sellerId] : [sellerId],
      storeId
        ? `SELECT COALESCE(total_earnings, 0) as total_earnings,
                  COALESCE(available_balance, 0) as available_balance
           FROM seller_profiles WHERE user_id = $1`
        : null,
      storeId ? [sellerId] : null
    );

    // Pending = escrow held amounts (net of commission) - NOT yet released
    const pendingResult = await runQuery(
      `SELECT COALESCE(SUM(amount), 0) as pending_earnings
       FROM escrow_transactions 
       WHERE seller_id = $1${storeId ? ' AND store_id = $2' : ''}`,
      storeId ? [sellerId, storeId] : [sellerId],
      storeId
        ? `SELECT COALESCE(SUM(amount), 0) as pending_earnings
           FROM escrow_transactions 
           WHERE seller_id = $1`
        : null,
      storeId ? [sellerId] : null
    );

    // Total withdrawn = sum of withdrawal transactions
    const withdrawnResult = await runQuery(
      `SELECT COALESCE(SUM(ABS(amount)), 0) as total_withdrawn
       FROM earnings 
       WHERE seller_id = $1 AND status = 'withdrawn'${storeId ? ' AND store_id = $2' : ''}`,
      storeId ? [sellerId, storeId] : [sellerId],
      storeId
        ? `SELECT COALESCE(SUM(ABS(amount)), 0) as total_withdrawn
           FROM earnings 
           WHERE seller_id = $1 AND status = 'withdrawn'`
        : null,
      storeId ? [sellerId] : null
    );

    const debugEscrow = await runQuery(
      `SELECT id, amount, status, held_at, released_at 
       FROM escrow_transactions 
       WHERE seller_id = $1${storeId ? ' AND store_id = $2' : ''}
       ORDER BY held_at DESC LIMIT 10`,
      storeId ? [sellerId, storeId] : [sellerId],
      storeId
        ? `SELECT id, amount, status, held_at, released_at 
           FROM escrow_transactions 
           WHERE seller_id = $1
           ORDER BY held_at DESC LIMIT 10`
        : null,
      storeId ? [sellerId] : null
    );
    console.log('Escrow rows:', JSON.stringify(debugEscrow.rows, null, 2));

    const profile = profileResult.rows[0] || { total_earnings: 0, available_balance: 0 };
    const pendingEarnings = stripFee(parseFloat(pendingResult.rows[0]?.pending_earnings ?? 0));
    const availableBalance = parseFloat(profile.available_balance ?? 0);
    const totalWithdrawn = parseFloat(withdrawnResult.rows[0]?.total_withdrawn ?? 0);

    // Total earnings = available + pending + withdrawn (what they've actually earned)
    const totalEarnings = Number.isFinite(availableBalance) && Number.isFinite(pendingEarnings) && Number.isFinite(totalWithdrawn)
      ? availableBalance + pendingEarnings + totalWithdrawn
      : 0;

    // Recent transactions
    const transactionsResult = await runQuery(
      `SELECT 
        e.id, e.amount, e.net_amount, e.status, e.created_at,
        p.name as product_name, o.id as order_id
       FROM earnings e
       LEFT JOIN order_items oi ON e.order_item_id = oi.id
       LEFT JOIN products p ON oi.product_id = p.id
       LEFT JOIN orders o ON e.order_id = o.id
       WHERE e.seller_id = $1${storeFilter}
       ORDER BY e.created_at DESC LIMIT 50`,
      storeId ? [sellerId, storeId] : [sellerId],
      storeId
        ? `SELECT 
        e.id, e.amount, e.net_amount, e.status, e.created_at,
        p.name as product_name, o.id as order_id
       FROM earnings e
       LEFT JOIN order_items oi ON e.order_item_id = oi.id
       LEFT JOIN products p ON oi.product_id = p.id
       LEFT JOIN orders o ON e.order_id = o.id
       WHERE e.seller_id = $1
       ORDER BY e.created_at DESC LIMIT 50`
        : null,
      storeId ? [sellerId] : null
    );

    // Escrow pending transactions (show as pending in transaction list)
    const escrowResult = await runQuery(
      `SELECT 
        et.id, et.amount, et.held_at as created_at,
        et.auto_release_at, et.order_id
       FROM escrow_transactions et
       WHERE et.seller_id = $1 AND et.status = 'held'${storeId ? ' AND et.store_id = $2' : ''}
       ORDER BY et.held_at DESC`,
      storeId ? [sellerId, storeId] : [sellerId],
      storeId
        ? `SELECT 
        et.id, et.amount, et.held_at as created_at,
        et.auto_release_at, et.order_id
       FROM escrow_transactions et
       WHERE et.seller_id = $1 AND et.status = 'held'
       ORDER BY et.held_at DESC`
        : null,
      storeId ? [sellerId] : null
    );

    // Product earnings
    const productEarningsResult = await runQuery(
      `SELECT p.name, COUNT(e.id) as quantity, SUM(e.net_amount) as revenue
       FROM earnings e
       JOIN order_items oi ON e.order_item_id = oi.id
       JOIN products p ON oi.product_id = p.id
       WHERE e.seller_id = $1${storeId ? ' AND e.store_id = $2' : ''}
       GROUP BY p.id, p.name
       ORDER BY revenue DESC`,
      storeId ? [sellerId, storeId] : [sellerId],
      storeId
        ? `SELECT p.name, COUNT(e.id) as quantity, SUM(e.net_amount) as revenue
       FROM earnings e
       JOIN order_items oi ON e.order_item_id = oi.id
       JOIN products p ON oi.product_id = p.id
       WHERE e.seller_id = $1
       GROUP BY p.id, p.name
       ORDER BY revenue DESC`
        : null,
      storeId ? [sellerId] : null
    );

    // Combine transactions + pending escrow into one list
    const pendingTxs = escrowResult.rows.map(et => ({
      id: et.id,
      date: et.created_at,
      amount: stripFee(parseFloat(et.amount)),
      status: 'pending',
      productName: null,
      orderId: et.order_id,
      type: 'Escrow (releasing ' + (et.auto_release_at ? new Date(et.auto_release_at).toLocaleDateString() : 'unknown') + ')',
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
        totalEarnings,
        availableBalance,
        pendingEarnings,
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
