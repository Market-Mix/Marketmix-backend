require('dotenv').config();
const db = require('../config/db');

async function autoEscalateRefunds() {
  console.log('Running refund auto-escalation job...');
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Find refund cases to escalate
    const dueRes = await client.query(
      `SELECT id, buyer_id, seller_id, resolution_status, created_at, escalated_to_marketmix
       FROM refund_cases
       WHERE resolution_status = 'pending'
         AND buyer_confirmed_resolution = false
         AND escalated_to_marketmix = false
         AND created_at <= NOW() - INTERVAL '48 hours'
       FOR UPDATE SKIP LOCKED`
    );

    const due = dueRes.rows || [];
    console.log(`Found ${due.length} refund(s) to auto-escalate`);

    const escalatedIds = [];

    for (const r of due) {
      try {
        await client.query(
          `UPDATE refund_cases
           SET resolution_status='escalated', escalated_to_marketmix = true, escalated_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [r.id]
        );

        escalatedIds.push(r.id);

        const noteMsg = 'Refund case has been automatically escalated to MarketMix because the resolution window expired.';

        // Notify buyer
        await client.query(
          `INSERT INTO notifications(user_id,title,message,type,is_read,is_deleted,created_at,updated_at)
           VALUES($1,$2,$3,'refund',FALSE,FALSE,NOW(),NOW())`,
          [r.buyer_id, 'Refund Escalated', noteMsg]
        );

        // Notify seller
        await client.query(
          `INSERT INTO notifications(user_id,title,message,type,is_read,is_deleted,created_at,updated_at)
           VALUES($1,$2,$3,'refund',FALSE,FALSE,NOW(),NOW())`,
          [r.seller_id, 'Refund Escalated', noteMsg]
        );

        // Notify all admins
        const admins = await client.query(`SELECT id FROM users WHERE role = 'admin'`);
        for (const a of admins.rows) {
          await client.query(
            `INSERT INTO notifications(user_id,title,message,type,is_read,is_deleted,created_at,updated_at)
             VALUES($1,$2,$3,'refund',FALSE,FALSE,NOW(),NOW())`,
            [a.id, 'Refund Escalated', noteMsg]
          );
        }

        console.log(`Escalated refund ${r.id} and created notifications`);
      } catch (errRow) {
        console.error(`Failed to escalate refund ${r.id}:`, errRow.message);
      }
    }

    await client.query('COMMIT');

    if (escalatedIds.length) {
      console.log('Auto-escalation complete. Escalated refund IDs:', escalatedIds.join(', '));
    } else {
      console.log('Auto-escalation complete. No refunds escalated.');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Auto-escalation job failed:', err.message);
  } finally {
    client.release();
  }
}

autoEscalateRefunds();

module.exports = { autoEscalateRefunds };
