const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { stripFee } = require('../utils/pricing');

router.get('/release-escrow', async (req, res) => {
  // Simple secret to prevent abuse
  const secret = req.query.secret;
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const due = await client.query(
      `SELECT et.*, o.status AS order_status, o.delivery_confirmed_at
       FROM escrow_transactions et
       JOIN orders o ON o.id = et.order_id
       WHERE et.status = 'held'
         AND (
           (o.status = 'delivered')
           OR
           (et.held_at <= NOW() - INTERVAL '2 days')
         )
       FOR UPDATE SKIP LOCKED`
    );

    let released = 0;

    for (const row of due.rows) {
      const netAmount = stripFee(row.amount);

      await client.query(
        `UPDATE escrow_transactions
         SET status='released', released_at=NOW(), updated_at=NOW(),
             notes='Auto-released by cron'
         WHERE id=$1`,
        [row.id]
      );

      await client.query(
        `UPDATE seller_profiles
         SET available_balance = available_balance + $1,
             total_earnings = total_earnings + $1,
             updated_at = NOW()
         WHERE user_id = $2`,
        [netAmount, row.seller_id]
      );

      released++;
    }

    await client.query('COMMIT');
    res.json({ success: true, released, timestamp: new Date() });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Simple keepalive ping
router.get('/ping', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date() });
});

module.exports = router;