const db = require('../config/db');

const SECRET = process.env.PAYSTACK_SECRET_KEY;
const FLW_SECRET = process.env.FLUTTERWAVE_SECRET_KEY;

async function ensureRecipient(withdrawal) {
  if (withdrawal.recipient_code) return withdrawal.recipient_code;

  const body = {
    type: 'nuban',
    name: withdrawal.bank_account_name,
    account_number: withdrawal.bank_account_number,
    bank_code: withdrawal.bank_code,
    currency: 'NGN'
  };

  const res = await fetch('https://api.paystack.co/transferrecipient', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!data.status) throw new Error(data.message || 'Could not create recipient');

  const code = data.data.recipient_code;

  await db.query(
    `UPDATE withdrawals SET recipient_code=$1 WHERE id=$2`,
    [code, withdrawal.id]
  );

  // Cache on seller profile too
  await db.query(
    `UPDATE seller_profiles SET bank_code=$1 WHERE user_id=$2`,
    [withdrawal.bank_code, withdrawal.seller_id]
  );

  return code;
}

async function processWithdrawal(withdrawalId) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const wdRes = await client.query(
      `SELECT * FROM withdrawals WHERE id=$1 AND status='pending' FOR UPDATE`,
      [withdrawalId]
    );

    if (!wdRes.rows.length) {
      await client.query('ROLLBACK');
      return { skipped: true };
    }

    const wd = wdRes.rows[0];

    // Double-check scheduled time
    if (new Date(wd.scheduled_for) > new Date()) {
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'Not scheduled yet' };
    }

    await client.query(`UPDATE withdrawals SET status='processing' WHERE id=$1`, [wd.id]);
    await client.query('COMMIT');

    // Get/create recipient
    const recipientCode = await ensureRecipient(wd);

    // Initiate transfer
    const transferRes = await fetch('https://api.paystack.co/transfer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'balance',
        amount: Math.round(wd.amount * 100), // kobo
        recipient: recipientCode,
        reference: wd.reference,
        reason: `MarketMix withdrawal ${wd.reference}`
      })
    });

    const transfer = await transferRes.json();

    if (!transfer.status) {
      // Revert to pending + restore balance on hard failure
      await db.query(`UPDATE withdrawals SET status='failed', failure_reason=$1 WHERE id=$2`,
        [transfer.message, wd.id]);
      await db.query(`UPDATE seller_profiles SET available_balance=available_balance+$1 WHERE user_id=$2`,
        [wd.amount, wd.seller_id]);
      return { success: false, reason: transfer.message };
    }

    await db.query(
      `UPDATE withdrawals SET gateway_reference=$1, status='processing' WHERE id=$2`,
      [String(transfer.data?.id || ''), wd.id]
    );

    return { success: true, reference: wd.reference };

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { processWithdrawal };