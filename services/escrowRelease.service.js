// services/escrowRelease.service.js
const { stripFee } = require('../utils/pricing');
const { recoverSellerDebtFromEscrowRelease } = require('./sellerDebtRecoveryService');
const db = require('../config/db');

async function releaseEscrowRow(client, row, notes = 'Auto-released') {
  const netAmount = stripFee(row.amount);

  await client.query(
    `UPDATE escrow_transactions SET status='released', released_at=NOW(), updated_at=NOW(), notes=$2 WHERE id=$1`,
    [row.id, notes]
  );

  await recoverSellerDebtFromEscrowRelease(client, {
    sellerId: row.seller_id, releaseAmount: netAmount,
    orderId: row.order_id, escrowId: row.id, context: 'escrow-release'
  });

  await client.query(
    `UPDATE seller_profiles SET available_balance=available_balance+$1, total_earnings=total_earnings+$1, updated_at=NOW()
     WHERE user_id=$2`,
    [netAmount, row.seller_id]
  );

  // earnings rows
  const items = await client.query(
    `SELECT id, price_at_purchase, quantity FROM order_items WHERE order_id=$1 AND seller_id=$2`,
    [row.order_id, row.seller_id]
  );
  for (const it of items.rows) {
    const gross = parseFloat(it.price_at_purchase) * it.quantity;
    await client.query(
      `INSERT INTO earnings (seller_id, store_id, order_id, order_item_id, amount, net_amount, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'available',NOW())`,
      [row.seller_id, row.store_id, row.order_id, it.id, gross, stripFee(gross)]
    );
  }

  return netAmount;
}

module.exports = { releaseEscrowRow };