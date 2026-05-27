require('dotenv').config();
const db = require('../config/db');

async function autoReleaseEscrow() {
  console.log('Running escrow auto-release...');
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    // Find overdue held escrows
    const due = await client.query(
      `SELECT et.*, o.id AS order_id
       FROM escrow_transactions et
       JOIN orders o ON o.id = et.order_id
       WHERE et.status = 'held'
         AND et.auto_release_at <= NOW()
       FOR UPDATE SKIP LOCKED`
    );

    console.log(`Found ${due.rows.length} escrows to auto-release`);

    for (const row of due.rows) {
      const COMMISSION = 0.05;
      const netAmount = parseFloat(row.amount) * (1 - COMMISSION);

      // Release escrow
      await client.query(
        `UPDATE escrow_transactions
         SET status='released', released_at=NOW(), updated_at=NOW(),
             notes='Auto-released after 3 days'
         WHERE id=$1`,
        [row.id]
      );

      // Update order status
      await client.query(
        `UPDATE orders SET status='delivered', updated_at=NOW()
         WHERE id=$1 AND status='shipped'`,
        [row.order_id]
      );

      // Credit seller
      await client.query(
        `UPDATE seller_profiles
         SET available_balance = available_balance + $1,
             total_earnings = total_earnings + $1,
             updated_at = NOW()
         WHERE user_id = $2`,
        [netAmount, row.seller_id]
      );

      // Notify both parties
      await client.query(
        `INSERT INTO notifications
           (user_id, title, message, type, data, is_read, is_deleted, created_at, updated_at)
         VALUES
           ($1,'Funds Auto-Released',
            $2,'payment',
            jsonb_build_object('orderId',$3,'link','/sellers/sellers earning.html'),
            FALSE,FALSE,NOW(),NOW()),
           ($4,'Order Auto-Completed',
            $5,'order',
            jsonb_build_object('orderId',$3,'link','/buyers/buyers order & tracking.html'),
            FALSE,FALSE,NOW(),NOW())`,
        [
          row.seller_id,
          `₦${netAmount.toFixed(2)} has been auto-released after 3 days.`,
          row.order_id,
          row.buyer_id,
          `Your order has been marked as delivered and payment released to the seller.`
        ]
      );
    }

    await client.query('COMMIT');
    console.log('Auto-release complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Auto-release error:', err.message);
  } finally {
    client.release();
    await db.closePool();
  }
}

autoReleaseEscrow();