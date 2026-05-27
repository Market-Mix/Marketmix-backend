const db = require('../config/db');
const bcrypt = require('bcrypt');
const { sendSuccess, sendError } = require('../utils/response');

const getWithdrawals = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM withdrawals WHERE seller_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    ).catch(() => ({ rows: [] }));
    return sendSuccess(res, 200, 'Withdrawals fetched', { withdrawals: result.rows });
  } catch (err) {
    return sendError(res, 500, 'Error fetching withdrawals', err.message);
  }
};

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
  } catch (err) {
    return sendError(res, 500, 'Error setting PIN', err.message);
  }
};

const saveBankAccount = async (req, res) => {
  try {
    const { bank_account_name, bank_account_number, bank_name, bank_code } = req.body;
    if (!bank_account_name || !bank_account_number || !bank_name)
      return sendError(res, 400, 'Bank details required');
    await db.query(
      `UPDATE seller_profiles 
       SET bank_account_name=$1, bank_account_number=$2, bank_name=$3, bank_code=$4
       WHERE user_id=$5`,
      [bank_account_name, bank_account_number, bank_name, bank_code || null, req.user.id]
    );
    return sendSuccess(res, 200, 'Bank account saved');
  } catch (err) {
    return sendError(res, 500, 'Error saving bank account', err.message);
  }
};

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
  } catch (err) {
    return sendError(res, 500, 'Error fetching bank account', err.message);
  }
};

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

    if (!profileRes.rows.length) {
      await client.query('ROLLBACK');
      return sendError(res, 404, 'Profile not found');
    }

    const p = profileRes.rows[0];

    if (!p.withdrawal_pin_set) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'Please set a withdrawal PIN first');
    }
    if (!p.bank_account_number) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'Please add a bank account first');
    }

    const pinMatch = await bcrypt.compare(String(pin), p.withdrawal_pin);
    if (!pinMatch) {
      await client.query('ROLLBACK');
      return sendError(res, 401, 'Incorrect PIN');
    }

    if (parseFloat(p.available_balance) < amount) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'Insufficient balance');
    }

    await client.query(
      `UPDATE seller_profiles SET available_balance=available_balance-$1 WHERE user_id=$2`,
      [amount, req.user.id]
    );

    // Insert into withdrawals table for history
    await client.query(
      `INSERT INTO withdrawals 
        (seller_id, amount, bank_account_name, bank_account_number, bank_name, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', NOW())`,
      [req.user.id, amount, p.bank_account_name, p.bank_account_number, p.bank_name]
    );

    // Record in earnings as withdrawn transaction
    await client.query(
      `INSERT INTO earnings(seller_id, amount, net_amount, commission, status, created_at)
       VALUES($1, $2, $3, 0, 'withdrawn', NOW())`,
      [req.user.id, -amount, -amount]
    );

    await client.query(
      `INSERT INTO notifications(user_id,title,message,type,data,is_read,is_deleted,created_at,updated_at)
       VALUES($1,'Withdrawal Requested',$2,'withdrawal',
       jsonb_build_object('link','/sellers/sellers earning.html'),
       FALSE,FALSE,NOW(),NOW())`,
      [req.user.id, `Withdrawal of ₦${Number(amount).toFixed(2)} to ${p.bank_name} (${p.bank_account_number}) is processing.`]
    );

    await client.query('COMMIT');
    return sendSuccess(res, 201, 'Withdrawal request submitted', {
      newBalance: parseFloat(p.available_balance) - amount
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendError(res, 500, 'Error processing withdrawal', err.message);
  } finally {
    client.release();
  }
};

module.exports = {
  getWithdrawals,
  requestWithdrawal,
  setWithdrawalPin,
  saveBankAccount,
  getBankAccount
};