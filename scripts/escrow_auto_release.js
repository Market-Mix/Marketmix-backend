require('dotenv').config();
const db = require('../config/db');

async function autoReleaseEscrow() {
  console.log('Running escrow auto-release...');
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    // Find escrows where:
    // 1. Held + buyer hasn't confirmed delivery after 2 days
    // 2. Delivered + 24hrs passed with no dispute
    const due = await client.query(
      `SELECT et.*, o.id AS order_id, o.status AS order_status, o.delivery_confirmed_at
       FROM escrow_transactions et
       JOIN orders o ON o.id = et.order_id
       WHERE et.status = 'held'
         AND (
           -- Case 1: buyer never confirmed delivery after 2 days
           (o.status != 'delivered' AND et.held_at <= NOW() - INTERVAL '2 days')
           OR
           -- Case 2: buyer confirmed delivery but no dispute after 24hrs
           (o.status = 'delivered' AND o.delivery_confirmed_at <= NOW() - INTERVAL '24 hours'
            AND NOT EXISTS (
              SELECT 1 FROM order_reports r 
              WHERE r.order_id = o.id AND r.status IN ('pending','under_review')
            ))
         )
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

      // Notify seller
      await client.query(
        `INSERT INTO notifications(user_id,title,message,type,is_read,is_deleted,created_at,updated_at)
         VALUES($1,$2,$3,'payment',FALSE,FALSE,NOW(),NOW())`,
        [row.seller_id, 'Funds Auto-Released', `₦${netAmount.toFixed(2)} has been auto-released after 3 days.`]
      );

      // Notify buyer
      await client.query(
        `INSERT INTO notifications(user_id,title,message,type,is_read,is_deleted,created_at,updated_at)
         VALUES($1,$2,$3,'order',FALSE,FALSE,NOW(),NOW())`,
        [row.buyer_id, 'Order Auto-Completed', `Your order has been marked as delivered and payment released to the seller.`]
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