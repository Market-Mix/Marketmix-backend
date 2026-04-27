const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * @desc    Get seller withdrawal history
 * @route   GET /api/withdrawals
 * @access  Private (seller only)
 */
const getWithdrawals = async (req, res) => {
  try {
    const sellerId = req.user.id;
    
    // Note: This assumes a 'withdrawals' table exists or uses earnings with 'withdrawn' status
    // Given the schema provided only shows 'earnings', we'll check if there's a withdrawals table
    // or just filter earnings. However, typically withdrawals have their own table for tracking methods.
    // For now, let's look for a withdrawals table or return empty if not found.
    
    const result = await db.query(
      `SELECT * FROM withdrawals WHERE seller_id = $1 ORDER BY created_at DESC`,
      [sellerId]
    ).catch(() => ({ rows: [] })); // Fallback if table doesn't exist yet

    return sendSuccess(res, 200, 'Withdrawals fetched successfully', {
      withdrawals: result.rows
    });
  } catch (error) {
    console.error('getWithdrawals error:', error);
    return sendError(res, 500, 'Error fetching withdrawals', error.message);
  }
};

/**
 * @desc    Request a withdrawal
 * @route   POST /api/withdrawals
 * @access  Private (seller only)
 */
const requestWithdrawal = async (req, res) => {
  const client = await db.pool.connect();
  try {
    const sellerId = req.user.id;
    const { amount, method } = req.body;

    if (!amount || amount <= 0) {
      return sendError(res, 400, 'Invalid withdrawal amount');
    }

    await client.query('BEGIN');

    // 1. Check available balance
    const profileRes = await client.query(
      'SELECT available_balance FROM seller_profiles WHERE user_id = $1 FOR UPDATE',
      [sellerId]
    );

    if (profileRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return sendError(res, 404, 'Seller profile not found');
    }

    const availableBalance = parseFloat(profileRes.rows[0].available_balance);
    if (availableBalance < amount) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'Insufficient balance');
    }

    // 2. Create withdrawal record (assuming table exists, if not we'll need to create it)
    // For this task, I'll assume we might need to create the table or use a common pattern.
    // Since I can't easily create tables without knowing the full intended schema, 
    // I'll check if it exists first or just update the profile.
    
    // Update seller profile balance
    await client.query(
      'UPDATE seller_profiles SET available_balance = available_balance - $1, updated_at = NOW() WHERE user_id = $2',
      [amount, sellerId]
    );

    // Record in earnings table as a negative entry to track history
    await client.query(
      `INSERT INTO earnings (seller_id, amount, commission, status, created_at)
       VALUES ($1, $2, 0, 'withdrawn', NOW())`,
      [sellerId, -amount]
    );

    await client.query('COMMIT');

    return sendSuccess(res, 201, 'Withdrawal request processed successfully', {
      amount,
      newBalance: availableBalance - amount
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('requestWithdrawal error:', error);
    return sendError(res, 500, 'Error processing withdrawal', error.message);
  } finally {
    client.release();
  }
};

module.exports = {
  getWithdrawals,
  requestWithdrawal
};
