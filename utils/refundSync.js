const db = require('../config/db');

async function syncRefundCase(refundCase) {
  if (!refundCase?.id) return;
  try {
    await db.query(
      `INSERT INTO refund_cases_sync (id, seller_id, buyer_id, order_id, resolution_status, status, chat_started, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (id) DO UPDATE SET
         resolution_status = EXCLUDED.resolution_status,
         status = EXCLUDED.status,
         chat_started = EXCLUDED.chat_started,
         updated_at = NOW()`,
      [
        refundCase.id,
        refundCase.seller_id,
        refundCase.buyer_id,
        refundCase.order_id,
        refundCase.resolution_status,
        refundCase.status,
        refundCase.chat_started || false
      ]
    );
  } catch (e) {
    console.warn('refund_cases_sync failed:', e.message);
  }
}

module.exports = { syncRefundCase };
