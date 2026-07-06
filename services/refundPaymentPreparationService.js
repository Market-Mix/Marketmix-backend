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

function toNumber(value) {
  const numericValue = Number(value ?? 0);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function buildRefundProcessingSummary({ refundAmount = 0, shippingAmount = 0, escrowAvailable = 0, sellerAvailableBalance = 0 } = {}) {
  const refundAmountValue = toNumber(refundAmount);
  const shippingAmountValue = toNumber(shippingAmount);
  const totalRefundAmount = refundAmountValue + shippingAmountValue;
  const escrowAvailableValue = Math.max(0, toNumber(escrowAvailable));
  const sellerAvailableBalanceValue = Math.max(0, toNumber(sellerAvailableBalance));
  const amountFromEscrow = Math.min(totalRefundAmount, escrowAvailableValue);
  const remainingAfterEscrow = Math.max(0, totalRefundAmount - amountFromEscrow);
  const amountFromBalance = Math.min(remainingAfterEscrow, sellerAvailableBalanceValue);
  const remainingUncovered = Math.max(0, remainingAfterEscrow - amountFromBalance);

  return {
    refundAmount: refundAmountValue,
    shippingAmount: shippingAmountValue,
    totalRefundAmount,
    escrowAvailable: escrowAvailableValue,
    sellerAvailableBalance: sellerAvailableBalanceValue,
    amountFromEscrow,
    amountFromBalance,
    remainingUncovered: remainingUncovered
  };
}

async function resolveRefundAmount(refund) {
  const explicitAmount = toNumber(refund?.refund_amount ?? refund?.total_amount ?? refund?.amount ?? 0);
  if (explicitAmount > 0) {
    return explicitAmount;
  }

  if (refund?.order_id) {
    try {
      const orderRes = await db.query(
        `SELECT COALESCE(total_amount, 0) AS total_amount
         FROM orders
         WHERE id = $1
         LIMIT 1`,
        [refund.order_id]
      );
      const orderTotal = toNumber(orderRes.rows[0]?.total_amount);
      if (orderTotal > 0) {
        return orderTotal;
      }
    } catch (err) {
      console.warn('⚠️ Could not resolve refund amount from orders table:', err.message || err);
    }

    try {
      const itemRes = await db.query(
        `SELECT COALESCE(SUM((quantity * price_at_purchase)), 0) AS item_total
         FROM order_items
         WHERE order_id = $1`,
        [refund.order_id]
      );
      const itemTotal = toNumber(itemRes.rows[0]?.item_total);
      if (itemTotal > 0) {
        return itemTotal;
      }
    } catch (err) {
      console.warn('⚠️ Could not resolve refund amount from order_items:', err.message || err);
    }
  }

  return 0;
}

async function resolveShippingRefundAmount(refund) {
  const candidateValues = [
    refund?.shipping_refund_amount,
    refund?.shipping_cost,
    refund?.approved_shipping_amount,
    refund?.shipping_reimbursement_amount,
    refund?.shipping_reimbursement
  ];

  for (const value of candidateValues) {
    const numericValue = toNumber(value);
    if (numericValue > 0) {
      return numericValue;
    }
  }

  return 0;
}

async function loadRefundProcessingSummary(refund) {
  const refundAmount = await resolveRefundAmount(refund);
  const shippingAmount = await resolveShippingRefundAmount(refund);

  let escrowAvailable = 0;
  let sellerAvailableBalance = 0;

  if (refund?.seller_id) {
    try {
      const escrowRes = await db.query(
        `SELECT COALESCE(SUM(CASE WHEN status = 'held' THEN amount ELSE 0 END), 0) AS escrow_available
         FROM escrow_transactions
         WHERE seller_id = $1 AND status = 'held'`,
        [refund.seller_id]
      );
      escrowAvailable = toNumber(escrowRes.rows[0]?.escrow_available);
    } catch (err) {
      console.warn('⚠️ Could not resolve escrow availability for refund processing summary:', err.message || err);
    }

    try {
      const balanceRes = await db.query(
        `SELECT COALESCE(available_balance, 0) AS available_balance
         FROM seller_profiles
         WHERE user_id = $1 AND is_deleted = false
         LIMIT 1`,
        [refund.seller_id]
      );
      sellerAvailableBalance = toNumber(balanceRes.rows[0]?.available_balance);
    } catch (err) {
      console.warn('⚠️ Could not resolve seller balance for refund processing summary:', err.message || err);
    }
  }

  const summary = buildRefundProcessingSummary({
    refundAmount,
    shippingAmount,
    escrowAvailable,
    sellerAvailableBalance
  });

  console.log('[refund-accounting] Refund Calculation | refundAmount:', summary.refundAmount, '| shippingAmount:', summary.shippingAmount, '| totalRefundAmount:', summary.totalRefundAmount, '| escrowAvailable:', summary.escrowAvailable, '| sellerAvailableBalance:', summary.sellerAvailableBalance, '| amountFromEscrow:', summary.amountFromEscrow, '| amountFromBalance:', summary.amountFromBalance, '| remainingUncovered:', summary.remainingUncovered);

  return summary;
}

async function ensurePaymentSummaryColumn(client) {
  try {
    await client.query('ALTER TABLE refund_transactions ADD COLUMN IF NOT EXISTS payment_summary JSONB');
  } catch (err) {
    if (err?.code === '42703' || /payment_summary/i.test(err.message || '')) {
      await client.query('ALTER TABLE refund_transactions ADD COLUMN IF NOT EXISTS payment_summary JSONB');
      return;
    }
    throw err;
  }
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

async function getPaymentSummaryForRefundCase(refundCaseId) {
  if (!refundCaseId) return null;

  try {
    await ensurePaymentSummaryColumn({ query: (text, params) => db.query(text, params) });
  } catch (err) {
    console.warn('⚠️ Could not ensure refund transaction summary column exists:', err.message || err);
  }

  const txRes = await db.query(
    `SELECT payment_summary
     FROM refund_transactions
     WHERE refund_case_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [refundCaseId]
  );

  const summary = txRes.rows[0]?.payment_summary;
  if (!summary) return null;

  if (typeof summary === 'string') {
    try {
      return JSON.parse(summary);
    } catch (err) {
      return null;
    }
  }

  return summary;
}

async function prepareRefundForPayment({ refundCase, refundId, actor = 'system' } = {}) {
  const refund = await resolveRefundCase(refundCase || refundId);
  if (!refund) {
    throw new Error('Refund case could not be loaded');
  }

  await ensurePaymentSummaryColumn({ query: (text, params) => db.query(text, params) });

  const existingPaymentStatus = String(refund.refund_payment_status || '').toLowerCase();
  const existingTxId = refund.refund_transaction_id;
  const existingTxRes = existingTxId
    ? await db.query('SELECT id, payment_summary FROM refund_transactions WHERE id = $1 LIMIT 1', [existingTxId])
    : await db.query('SELECT id, payment_summary FROM refund_transactions WHERE refund_case_id = $1 ORDER BY created_at DESC LIMIT 1', [refund.id]);
  const existingTransaction = existingTxRes.rows[0] || null;

  if (existingPaymentStatus === 'processing' || existingPaymentStatus === 'paid' || existingTxId) {
    if (existingTransaction && (!existingTransaction.payment_summary || !existingTransaction.completed_at)) {
      const paymentSummary = await loadRefundProcessingSummary(refund);
      const refundAmount = paymentSummary.refundAmount;
      const shippingAmount = paymentSummary.shippingAmount;
      const totalAmount = paymentSummary.totalRefundAmount;
      const amountFromBalance = paymentSummary.amountFromBalance;

      const updatedTx = await db.query(
        `UPDATE refund_transactions
         SET refund_amount = $1,
             shipping_amount = $2,
             total_amount = $3,
             payment_summary = $4,
             payment_status = COALESCE(NULLIF($5, ''), payment_status),
             completed_at = COALESCE(completed_at, NOW())
         WHERE id = $6
         RETURNING *`,
        [refundAmount, shippingAmount, totalAmount, JSON.stringify(paymentSummary), 'paid', existingTransaction.id]
      );

      if (amountFromBalance > 0 && refund.seller_id) {
        await db.query(
          `UPDATE seller_profiles
           SET available_balance = GREATEST(0, available_balance - $1),
               updated_at = NOW()
           WHERE user_id = $2 AND is_deleted = false`,
          [amountFromBalance, refund.seller_id]
        );
      }

      return {
        refundCase: refund,
        transaction: updatedTx.rows[0] || existingTransaction,
        prepared: true,
        reason: 'summary_backfilled'
      };
    }

    return {
      refundCase: refund,
      transaction: existingTransaction,
      prepared: false,
      reason: 'already_prepared'
    };
  }

  const paymentSummary = await loadRefundProcessingSummary(refund);
  const refundAmount = paymentSummary.refundAmount;
  const shippingAmount = paymentSummary.shippingAmount;
  const totalAmount = paymentSummary.totalRefundAmount;
  const processedBy = resolveProcessedBy(refund, actor);

  const paymentReference = refund.refund_payment_reference || buildPaymentReference();

  const result = await db.transaction(async (client) => {
    await ensurePaymentSummaryColumn(client);

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
         payment_summary,
         created_at,
         completed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NULL)
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
        processedBy,
        JSON.stringify(paymentSummary)
      ]
    );

    const tx = txRes.rows[0];
    if (paymentSummary.amountFromBalance > 0 && refund.seller_id) {
      await client.query(
        `UPDATE seller_profiles
         SET available_balance = GREATEST(0, available_balance - $1),
             updated_at = NOW()
         WHERE user_id = $2 AND is_deleted = false`,
        [paymentSummary.amountFromBalance, refund.seller_id]
      );
    }

    const updateRes = await client.query(
      `UPDATE refund_cases
       SET refund_processing_started_at = NOW(),
           refund_paid_at = NOW(),
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

    await client.query(
      `UPDATE refund_transactions
       SET payment_status = 'paid',
           completed_at = NOW()
       WHERE id = $1`,
      [tx.id]
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
  prepareRefundForPayment,
  loadRefundProcessingSummary,
  buildRefundProcessingSummary,
  getPaymentSummaryForRefundCase
};
