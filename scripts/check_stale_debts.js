// scripts/check_stale_debts.js
require('dotenv').config();
const db = require('../config/db');

(async () => {
  const stale = await db.query(
    `SELECT seller_id, SUM(remaining_debt) AS total_owed, MIN(created_at) AS oldest
     FROM seller_debts
     WHERE status IN ('active','partial')
     GROUP BY seller_id
     HAVING SUM(remaining_debt) > 5000 AND MIN(created_at) < NOW() - INTERVAL '14 days'`
  );

  for (const row of stale.rows) {
    console.warn(`⚠️ Seller ${row.seller_id} owes ₦${row.total_owed} since ${row.oldest}`);
    await db.query(
      `INSERT INTO notifications (user_id, title, message, type, is_read, is_deleted, created_at, updated_at)
       VALUES ($1,'Outstanding Balance Owed',$2,'account',FALSE,FALSE,NOW(),NOW())`,
      [row.seller_id, `You owe ₦${Number(row.total_owed).toLocaleString()} from a refund shortfall. This will be deducted from future earnings.`]
    );
  }

  console.log(`Checked. ${stale.rows.length} sellers flagged.`);
  await db.closePool(); process.exit();
})();