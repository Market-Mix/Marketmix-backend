const db = require('../config/db');
const { createDedupedNotification } = require('../controllers/notification.controller');

function buildPaymentReference() {
  const today = new Date();
  const stamp = today.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `SIM-REF-${stamp}-${suffix}`;
}

function resolveProcessedBy(refund, actor) {
  if (actor && /^[0-9a-fA-F-]{8,}$/.test(String(actor))) {
    return actor;
  }
  return refund?.seller_id || refund?.buyer_id || null;
}

async function resolveRefundCase(refundCaseOrId) {
  if (refundCaseOrId && typeof refundCaseOrId === 'object' && refundCaseOrId.id) {
    return refundCaseOrId;
  }

  const refundId = refundCaseOrId;
  if (!refundId) {
    throw new Error('refundCaseOrId is required');
  }

  const refundRes = await db.query('SELECT * FROM refund_cases WHERE id = $1 LIMIT 1', [refundId]);
  if (refundRes.rows.length === 0) {
    throw new Error(`Refund case ${refundId} not found`);
  }

  return refundRes.rows[0];
}

async function prepareRefundForPayment({ refundCase, refundId, actor = 'system' } = {}) {
  const refund = await resolveRefundCase(refundCase || refundId);
  if (!refund) {
    throw new Error('Refund case could not be loaded');
  }

  const existingPaymentStatus = String(refund.refund_payment_status || '').toLowerCase();
  const existingTxId = refund.refund_transaction_id;
  if (existingPaymentStatus === 'processing' || existingPaymentStatus === 'paid' || existingTxId) {
    return {
      refundCase: refund,
      transaction: null,
      prepared: false,
      reason: 'already_prepared'
    };
  }

  const refundAmount = Number(refund.refund_amount ?? refund.total_amount ?? refund.amount ?? 0);
  const shippingAmount = Number(refund.shipping_reimbursement_amount ?? refund.shipping_reimbursement ?? 0);
  const totalAmount = refundAmount + shippingAmount;
  const processedBy = resolveProcessedBy(refund, actor);

  const paymentReference = refund.refund_payment_reference || buildPaymentReference();

  const result = await db.transaction(async (client) => {
    const txRes = await client.query(
      `INSERT INTO refund_transactions (
         refund_case_id,
         buyer_id,
         seller_id,
         order_id,
         refund_amount,
         shipping_amount,
         total_amount,
         payment_mode,
         payment_status,
         payment_reference,
         processed_by,
         created_at,
         completed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NULL)
       RETURNING *`,
      [
        refund.id,
        refund.buyer_id || null,
        refund.seller_id || null,
        refund.order_id || null,
        refundAmount,
        shippingAmount,
        totalAmount,
        'simulation',
        'processing',
        paymentReference,
        processedBy
      ]
    );

    const tx = txRes.rows[0];
    const updateRes = await client.query(
      `UPDATE refund_cases
       SET refund_processing_started_at = NOW(),
           refund_paid_at = NULL,
           refund_payment_status = 'processing',
           refund_payment_reference = $1,
           refund_payment_mode = 'simulation',
           refund_transaction_id = $2,
           status = 'refund_processing',
           resolution_status = 'refund_processing',
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [paymentReference, tx.id, refund.id]
    );

    return {
      refundCase: updateRes.rows[0],
      transaction: tx
    };
  });

  await Promise.allSettled([
    createDedupedNotification({
      userId: refund.buyer_id,
      title: 'Refund processing started',
      message: 'Your refund has entered the payment-processing stage. MarketMix will complete the payout shortly.',
      type: 'refund',
      referenceId: refund.id,
      link: '/buyers/buyers%20return%20report.html'
    }),
    createDedupedNotification({
      userId: refund.seller_id,
      title: 'Refund processing started',
      message: 'The refund for this order is now being prepared for payment processing.',
      type: 'refund',
      referenceId: refund.id,
      link: '/sellers/sellers%20returns.html'
    })
  ]);

  try {
    const adminRes = await db.query("SELECT id FROM users WHERE role = 'admin' AND is_deleted = FALSE");
    await Promise.allSettled(adminRes.rows.map((row) => (
      createDedupedNotification({
        userId: row.id,
        title: 'Refund processing started',
        message: `Refund case ${refund.id} has entered payment processing.`,
        type: 'refund',
        referenceId: refund.id,
        link: '/admin/refunds/pending'
      })
    )));
  } catch (err) {
    console.warn('⚠️ Could not notify admins about refund processing:', err.message || err);
  }

  return {
    refundCase: result.refundCase,
    transaction: result.transaction,
    prepared: true,
    reason: 'prepared'
  };
}

module.exports = {
  prepareRefundForPayment
};
