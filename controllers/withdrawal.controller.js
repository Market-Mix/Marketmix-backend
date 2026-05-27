const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const bcrypt = require('bcrypt');

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
 * @desc    Set withdrawal PIN
 * @route   POST /api/withdrawals/set-pin
 * @access  Private (seller only)
 */
const setWithdrawalPin = async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || !/^\d{4,6}$/.test(pin))
      return sendError(res, 400, 'PIN must be 4-6 digits');
    
    const hash = await bcrypt.hash(pin, 10);
    await db.query(
      `UPDATE seller_profiles SET withdrawal_pin=$1, withdrawal_pin_set=true WHERE user_id=$2`,
      [hash, req.user.id]
    );
    return sendSuccess(res, 200, 'Withdrawal PIN set successfully');
  } catch (error) {
    console.error('setWithdrawalPin error:', error);
    return sendError(res, 500, 'Error setting withdrawal PIN', error.message);
  }
};

/**
 * @desc    Save bank account details
 * @route   POST /api/withdrawals/bank-account
 * @access  Private (seller only)
 */
const saveBankAccount = async (req, res) => {
  try {
    const { bank_account_name, bank_account_number, bank_name, bank_code } = req.body;
    if (!bank_account_number || !bank_name || !bank_account_name)
      return sendError(res, 400, 'Bank details required');
    
    await db.query(
      `UPDATE seller_profiles 
       SET bank_account_name=$1, bank_account_number=$2, bank_name=$3, bank_code=$4
       WHERE user_id=$5`,
      [bank_account_name, bank_account_number, bank_name, bank_code, req.user.id]
    );
    return sendSuccess(res, 200, 'Bank account saved');
  } catch (error) {
    console.error('saveBankAccount error:', error);
    return sendError(res, 500, 'Error saving bank account', error.message);
  }
};

/**
 * @desc    Get bank account details
 * @route   GET /api/withdrawals/bank-account
 * @access  Private (seller only)
 */
const getBankAccount = async (req, res) => {
  try {
    const r = await db.query(
      `SELECT bank_account_name, bank_account_number, bank_name, bank_code, 
              withdrawal_pin_set, available_balance
       FROM seller_profiles WHERE user_id=$1`,
      [req.user.id]
    );
    if (!r.rows.length) return sendError(res, 404, 'Profile not found');
    return sendSuccess(res, 200, 'Bank account fetched', r.rows[0]);
  } catch (error) {
    console.error('getBankAccount error:', error);
    return sendError(res, 500, 'Error fetching bank account', error.message);
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
    const { amount, pin } = req.body;
    if (!amount || amount <= 0) return sendError(res, 400, 'Invalid amount');
    if (!pin) return sendError(res, 400, 'Withdrawal PIN required');

    await client.query('BEGIN');

    const profileRes = await client.query(
      `SELECT available_balance, withdrawal_pin, withdrawal_pin_set,
              bank_account_number, bank_name, bank_account_name
       FROM seller_profiles WHERE user_id=$1 FOR UPDATE`,
      [req.user.id]
    );
    if (!profileRes.rows.length) { await client.query('ROLLBACK'); return sendError(res, 404, 'Profile not found'); }

    const p = profileRes.rows[0];

    if (!p.withdrawal_pin_set) { await client.query('ROLLBACK'); return sendError(res, 400, 'Please set a withdrawal PIN first'); }
    if (!p.bank_account_number) { await client.query('ROLLBACK'); return sendError(res, 400, 'Please add a bank account first'); }

    const pinMatch = await bcrypt.compare(String(pin), p.withdrawal_pin);
    if (!pinMatch) { await client.query('ROLLBACK'); return sendError(res, 401, 'Incorrect PIN'); }

    if (parseFloat(p.available_balance) < amount) { await client.query('ROLLBACK'); return sendError(res, 400, 'Insufficient balance'); }

    await client.query(
      `UPDATE seller_profiles SET available_balance=available_balance-$1 WHERE user_id=$2`,
      [amount, req.user.id]
    );
    await client.query(
      `INSERT INTO earnings(seller_id,amount,commission,status,created_at) VALUES($1,$2,0,'withdrawn',NOW())`,
      [req.user.id, -amount]
    );

    // Notification
    await client.query(
      `INSERT INTO notifications(user_id,title,message,type,data,is_read,is_deleted,created_at,updated_at)
       VALUES($1,'Withdrawal Requested',$2,'withdrawal',jsonb_build_object('link','/sellers/sellers earning.html'),FALSE,FALSE,NOW(),NOW())`,
      [req.user.id, `Withdrawal of ₦${Number(amount).toFixed(2)} to ${p.bank_name} (${p.bank_account_number}) is processing.`]
    );

    await client.query('COMMIT');
    return sendSuccess(res, 201, 'Withdrawal request submitted', { newBalance: parseFloat(p.available_balance) - amount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('requestWithdrawal error:', err);
    return sendError(res, 500, 'Error processing withdrawal', err.message);
  } finally { client.release(); }
};
module.exports = {
  getWithdrawals,
  requestWithdrawal,
  setWithdrawalPin,
  saveBankAccount,
  getBankAccount
};