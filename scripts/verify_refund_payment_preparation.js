require('dotenv').config({ path: 'Marketmix-backend.env' });
const { Pool } = require('pg');
const service = require('../services/refundPaymentPreparationService');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    const refundId = '2c116e4f-03c0-4dad-812d-abf7f66b9a10';
    const before = await pool.query(
      `SELECT refund_payment_status, refund_processing_started_at, refund_payment_reference, refund_transaction_id, status, resolution_status
       FROM refund_cases WHERE id = $1`,
      [refundId]
    );
    console.log('BEFORE', before.rows[0]);

    const result = await service.prepareRefundForPayment({ refundId, actor: 'test' });
    console.log('RESULT', {
      prepared: result.prepared,
      paymentStatus: result.refundCase?.refund_payment_status,
      paymentReference: result.refundCase?.refund_payment_reference,
      transactionId: result.refundCase?.refund_transaction_id,
      status: result.refundCase?.status,
      resolutionStatus: result.refundCase?.resolution_status
    });

    const after = await pool.query(
      `SELECT refund_payment_status, refund_processing_started_at, refund_payment_reference, refund_transaction_id, status, resolution_status
       FROM refund_cases WHERE id = $1`,
      [refundId]
    );
    console.log('AFTER', after.rows[0]);

    const tx = await pool.query(
      `SELECT id, payment_status, payment_reference, total_amount FROM refund_transactions WHERE refund_case_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [refundId]
    );
    console.log('TX', tx.rows[0]);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
})();
