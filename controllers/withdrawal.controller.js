const crypto = require('crypto');
const db = require('../config/db');
const bcrypt = require('bcrypt');
const { sendSuccess, sendError } = require('../utils/response');

const MIN_WITHDRAWAL = parseFloat(process.env.MIN_WITHDRAWAL || '1000');
const WITHDRAWAL_DELAY_HOURS = parseInt(process.env.WITHDRAWAL_DELAY_HOURS || '24');
const NEW_USER_HOLD_HOURS = parseInt(process.env.NEW_USER_HOLD_HOURS || '48');

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
    const sellerId = req.user.id;

    console.log('=== WITHDRAWAL REQUEST ===');
    console.log('sellerId:', sellerId);
    console.log('amount:', amount);
    console.log('pin provided:', !!pin);
    console.log('MIN_WITHDRAWAL:', MIN_WITHDRAWAL);
    console.log('WITHDRAWAL_DELAY_HOURS:', WITHDRAWAL_DELAY_HOURS);
    console.log('NEW_USER_HOLD_HOURS:', NEW_USER_HOLD_HOURS);

    if (!amount || amount < MIN_WITHDRAWAL)
      return sendError(res, 400, `Minimum withdrawal is ₦${MIN_WITHDRAWAL}`);
    if (!pin)
      return sendError(res, 400, 'Withdrawal PIN required');

    await client.query('BEGIN');

    // Lock row
    const profileRes = await client.query(
      `SELECT sp.available_balance, sp.withdrawal_pin, sp.withdrawal_pin_set,
              sp.bank_account_number, sp.bank_name, sp.bank_account_name, sp.bank_code,
              u.withdrawal_eligible_at, u.created_at
       FROM seller_profiles sp
       JOIN users u ON u.id = sp.user_id
       WHERE sp.user_id = $1 FOR UPDATE`,
      [sellerId]
    );

    if (!profileRes.rows.length) {
      await client.query('ROLLBACK');
      return sendError(res, 404, 'Profile not found');
    }

    const p = profileRes.rows[0];

    // Anti-fraud: new user hold
    const eligibleAt = p.withdrawal_eligible_at
      ? new Date(p.withdrawal_eligible_at)
      : new Date(new Date(p.created_at).getTime() + NEW_USER_HOLD_HOURS * 3600000);

    if (new Date() < eligibleAt) {
      await client.query('ROLLBACK');
      const hoursLeft = Math.ceil((eligibleAt - new Date()) / 3600000);
      return sendError(res, 403, `Withdrawals available in ${hoursLeft}h (new account hold)`);
    }

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

    // Check for pending withdrawals (prevent double submit)
    const pending = await client.query(
      `SELECT id FROM withdrawals WHERE seller_id = $1 AND status IN ('pending','processing') LIMIT 1`,
      [sellerId]
    );
    if (pending.rows.length) {
      await client.query('ROLLBACK');
      return sendError(res, 409, 'You already have a pending withdrawal');
    }

    // Generate unique reference
    const reference = `MX-WD-${sellerId.slice(0,8)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    // Schedule for future (withdrawal delay)
    const scheduledFor = new Date(Date.now() + WITHDRAWAL_DELAY_HOURS * 3600000);

    // Reserve balance immediately
    await client.query(
      `UPDATE seller_profiles SET available_balance = available_balance - $1 WHERE user_id = $2`,
      [amount, sellerId]
    );

    const wdRes = await client.query(
      `INSERT INTO withdrawals 
        (seller_id, amount, bank_account_name, bank_account_number, bank_name, bank_code,
         account_masked, status, reference, scheduled_for, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,NOW())
       RETURNING id, reference, scheduled_for`,
      [
        sellerId,
        amount,
        p.bank_account_name,
        p.bank_account_number,
        p.bank_name,
        p.bank_code || null,
        p.bank_account_number ? `****${p.bank_account_number.slice(-4)}` : null,
        reference,
        scheduledFor
      ]
    );

   await client.query(
  `INSERT INTO notifications(user_id,title,message,type,link,is_read,is_deleted,created_at,updated_at)
   VALUES($1,'Withdrawal Requested',$2,'withdrawal','/sellers/sellers earning.html',
   FALSE,FALSE,NOW(),NOW())`,
  [sellerId, `Withdrawal of ₦${Number(amount).toFixed(2)} to ${p.bank_name} queued. Processing in ${WITHDRAWAL_DELAY_HOURS}h.`]
);
    await client.query('COMMIT');

    return sendSuccess(res, 201, 'Withdrawal request created', {
      reference,
      scheduledFor,
      amount,
      newBalance: parseFloat(p.available_balance) - amount
    });

  } catch (err) {
    await client.query('ROLLBACK');
    return sendError(res, 500, 'Error processing withdrawal', err.message);
  } finally {
    client.release();
  }
};

const handlePaystackWithdrawalWebhook = async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const hash = crypto.createHmac('sha512', secret)
    .update(JSON.stringify(req.body)).digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(401).end();
  }

  res.status(200).end(); // Acknowledge immediately

  const { event, data } = req.body;
  if (!['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(event)) return;

  const reference = data.reference;
  const wd = await db.query(`SELECT * FROM withdrawals WHERE reference=$1`, [reference]);
  if (!wd.rows.length) return;

  const withdrawal = wd.rows[0];

  if (event === 'transfer.success') {
    await db.query(
      `UPDATE withdrawals SET status='success', processed_at=NOW() WHERE id=$1`,
      [withdrawal.id]
    );
    await db.query(
      `INSERT INTO notifications(user_id,title,message,type,link,is_read,is_deleted,created_at,updated_at)
       VALUES($1,'Withdrawal Successful',$2,'withdrawal','/sellers/sellers earning.html',FALSE,FALSE,NOW(),NOW())`,
      [withdrawal.seller_id,
       `₦${Number(withdrawal.amount).toFixed(2)} has been sent to your bank account.`]
    );
  } else {
    // failed or reversed — restore balance
    await db.query(
      `UPDATE withdrawals SET status='failed', failure_reason=$1, processed_at=NOW() WHERE id=$2`,
      [data.reason || event, withdrawal.id]
    );
    await db.query(
      `UPDATE seller_profiles SET available_balance=available_balance+$1 WHERE user_id=$2`,
      [withdrawal.amount, withdrawal.seller_id]
    );
    await db.query(
      `INSERT INTO notifications(user_id,title,message,type,link,is_read,is_deleted,created_at,updated_at)
       VALUES($1,'Withdrawal Failed',$2,'withdrawal','/sellers/sellers earning.html',FALSE,FALSE,NOW(),NOW())`,
      [withdrawal.seller_id,
       `Withdrawal of ₦${Number(withdrawal.amount).toFixed(2)} failed: ${data.reason || 'Bank declined'}.`]
    );
  }
};

const handleFlutterwaveTransferWebhook = async (req, res) => {
  const secretHash = process.env.FLUTTERWAVE_WEBHOOK_HASH;
  const signature = req.headers['verif-hash'];
  
  if (secretHash && signature !== secretHash) {
    return res.status(401).end();
  }

  res.status(200).end(); // Acknowledge immediately

  const { event, data } = req.body;
  if (!['transfer.completed', 'transfer.failed'].includes(event)) return;

  const reference = data.reference;
  const wd = await db.query(`SELECT * FROM withdrawals WHERE reference=$1`, [reference]);
  if (!wd.rows.length) return;

  const withdrawal = wd.rows[0];

  if (event === 'transfer.completed' && data.status === 'SUCCESSFUL') {
    await db.query(
      `UPDATE withdrawals SET status='success', processed_at=NOW() WHERE id=$1`,
      [withdrawal.id]
    );
    await db.query(
      `INSERT INTO notifications(user_id,title,message,type,link,is_read,is_deleted,created_at,updated_at)
       VALUES($1,'Withdrawal Successful',$2,'withdrawal','/sellers/sellers earning.html',FALSE,FALSE,NOW(),NOW())`,
      [withdrawal.seller_id,
       `₦${Number(withdrawal.amount).toFixed(2)} has been sent to your bank account.`]
    );
  } else {
    await db.query(
      `UPDATE withdrawals SET status='failed', failure_reason=$1, processed_at=NOW() WHERE id=$2`,
      [data.complete_message || event, withdrawal.id]
    );
    await db.query(
      `UPDATE seller_profiles SET available_balance=available_balance+$1 WHERE user_id=$2`,
      [withdrawal.amount, withdrawal.seller_id]
    );
    await db.query(
      `INSERT INTO notifications(user_id,title,message,type,link,is_read,is_deleted,created_at,updated_at)
       VALUES($1,'Withdrawal Failed',$2,'withdrawal','/sellers/sellers earning.html',FALSE,FALSE,NOW(),NOW())`,
      [withdrawal.seller_id,
       `Withdrawal of ₦${Number(withdrawal.amount).toFixed(2)} failed: ${data.complete_message || 'Bank declined'}.`]
    );
  }
};

module.exports = {
  getWithdrawals,
  requestWithdrawal,
  setWithdrawalPin,
  saveBankAccount,
  getBankAccount,
  handlePaystackWithdrawalWebhook,
  handleFlutterwaveTransferWebhook
};
