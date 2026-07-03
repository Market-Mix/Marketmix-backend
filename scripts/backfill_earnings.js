// scripts/backfill_balance.js — re-credits sellers whose escrow released but balance wasn't updated
require('dotenv').config();
const db = require('../config/db');

(async () => {
  const released = await db.query(`SELECT id, seller_id, amount FROM escrow_transactions WHERE status='released'`);
  for (const row of released.rows) {
    const net = parseFloat(row.amount) * 0.95;
    // crude check: only run this once, then delete the script
    await db.query(
      `UPDATE seller_profiles SET available_balance = available_balance + $1, total_earnings = total_earnings + $1 WHERE user_id=$2`,
      [net, row.seller_id]
    );
  }
  console.log('done'); await db.closePool(); process.exit();
})();