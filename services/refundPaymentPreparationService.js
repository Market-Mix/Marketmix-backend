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
    amountFromEscrow,
    amountFromBalance,
    remainingUncovered
  };
}

async function resolveRefundAmount(refund) {
  if (refund?.order_item_id) {
    try {
      const itemRes = await db.query(
        `SELECT COALESCE((quantity * price_at_purchase), 0) AS line_total
         FROM order_items
         WHERE id = $1
         LIMIT 1`,
        [refund.order_item_id]
      );
      const lineTotal = toNumber(itemRes.rows[0]?.line_total);
      if (lineTotal > 0) {
        return lineTotal;
      }
    } catch (err) {
      console.warn('⚠️ Could not resolve refund amount from order_item:', err.message || err);
    }
  }

  if (refund?.order_id && refund?.order_item_id) {
    try {
      const itemRes = await db.query(
        `SELECT COALESCE((quantity * price_at_purchase), 0) AS line_total
         FROM order_items
         WHERE order_id = $1 AND id = $2
         LIMIT 1`,
        [refund.order_id, refund.order_item_id]
      );
      const lineTotal = toNumber(itemRes.rows[0]?.line_total);
      if (lineTotal > 0) {
        return lineTotal;
      }
    } catch (err) {
      console.warn('⚠️ Could not resolve refund amount from order item by order id:', err.message || err);
    }
  }

  const refundCaseAmountCandidates = [
    refund?.approved_refund_amount,
    refund?.approved_amount,
    refund?.refund_amount,
    refund?.amount,
    refund?.total_amount
  ];

  for (const candidate of refundCaseAmountCandidates) {
    const numericValue = toNumber(candidate);
    if (numericValue > 0) {
      return numericValue;
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

async function applyRefundWalletDeductions(client, refund, paymentSummary) {
  if (!refund?.seller_id) return;

  const amountFromEscrow = toNumber(paymentSummary?.amountFromEscrow ?? 0);
  const amountFromBalance = toNumber(paymentSummary?.amountFromBalance ?? 0);
  const totalDeduction = amountFromEscrow + amountFromBalance;

  if (totalDeduction <= 0) return;

  let remainingEscrowDeduction = amountFromEscrow;
  if (remainingEscrowDeduction > 0) {
    const escrowRows = await client.query(
      `SELECT id, amount
       FROM escrow_transactions
       WHERE seller_id = $1 AND status = 'held' AND amount > 0
       ORDER BY held_at ASC, id ASC`,
      [refund.seller_id]
    );

    for (const row of escrowRows.rows) {
      if (remainingEscrowDeduction <= 0) break;

      const currentAmount = toNumber(row.amount);
      if (currentAmount <= 0) continue;

      if (currentAmount <= remainingEscrowDeduction) {
        await client.query(
          `UPDATE escrow_transactions
           SET amount = 0,
               status = 'released',
               released_at = NOW(),
               updated_at = NOW()
           WHERE id = $1`,
          [row.id]
        );
        remainingEscrowDeduction -= currentAmount;
      } else {
        await client.query(
          `UPDATE escrow_transactions
           SET amount = $1,
               updated_at = NOW()
           WHERE id = $2`,
          [currentAmount - remainingEscrowDeduction, row.id]
        );
        remainingEscrowDeduction = 0;
      }
    }
  }

  const remainingBalanceDeduction = Math.max(0, amountFromBalance);
  if (remainingBalanceDeduction > 0) {
    await client.query(
      `UPDATE seller_profiles
       SET available_balance = GREATEST(0, available_balance - $1),
           updated_at = NOW()
       WHERE user_id = $2 AND is_deleted = false`,
      [remainingBalanceDeduction, refund.seller_id]
    );
  }
}

async function finalizeRefundCasePayment(client, refund, paymentReference, transactionId) {
  return await client.query(
    `UPDATE refund_cases
     SET refund_processing_started_at = COALESCE(refund_processing_started_at, NOW()),
         refund_paid_at = COALESCE(refund_paid_at, NOW()),
         refund_payment_status = 'paid',
         refund_payment_reference = COALESCE(NULLIF($1, ''), refund_payment_reference),
         refund_payment_mode = COALESCE(refund_payment_mode, 'simulation'),
         refund_transaction_id = COALESCE($2, refund_transaction_id),
         status = 'resolved',
         resolution_status = 'resolved',
         updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [paymentReference, transactionId, refund.id]
  );
}

async function loadRefundProcessingSummary(refund) {
  console.log('[refund-debug] enter loadRefundProcessingSummary', { refundId: refund?.id, sellerId: refund?.seller_id });
  const refundAmount = await resolveRefundAmount(refund);
  const shippingAmount = await resolveShippingRefundAmount(refund);
  console.log('[refund-debug] resolved refund amounts', { refundId: refund?.id, refundAmount, shippingAmount });

  let escrowAvailable = 0;
  let sellerAvailableBalance = 0;

  if (refund?.seller_id) {
    try {
      console.log('[refund-debug] calculating escrow availability', { refundId: refund.id, sellerId: refund.seller_id });
      const escrowRes = await db.query(
        `SELECT COALESCE(SUM(CASE WHEN status = 'held' THEN amount ELSE 0 END), 0) AS escrow_available
         FROM escrow_transactions
         WHERE seller_id = $1 AND status = 'held'`,
        [refund.seller_id]
      );
      escrowAvailable = toNumber(escrowRes.rows[0]?.escrow_available);
      console.log('[refund-debug] escrow availability result', { refundId: refund.id, escrowAvailable });
    } catch (err) {
      console.warn('⚠️ Could not resolve escrow availability for refund processing summary:', err.message || err);
    }

    try {
      console.log('[refund-debug] calculating seller balance', { refundId: refund.id, sellerId: refund.seller_id });
      const balanceRes = await db.query(
        `SELECT COALESCE(available_balance, 0) AS available_balance
         FROM seller_profiles
         WHERE user_id = $1 AND is_deleted = false
         LIMIT 1`,
        [refund.seller_id]
      );
      sellerAvailableBalance = toNumber(balanceRes.rows[0]?.available_balance);
      console.log('[refund-debug] seller balance result', { refundId: refund.id, sellerAvailableBalance });
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

  console.log('[refund-debug] refund processing summary built', summary);
  console.log('[refund-accounting] Refund Calculation | refundAmount:', summary.refundAmount, '| shippingAmount:', summary.shippingAmount, '| totalRefundAmount:', summary.totalRefundAmount, '| escrowAvailable:', summary.escrowAvailable, '| amountFromEscrow:', summary.amountFromEscrow, '| amountFromBalance:', summary.amountFromBalance, '| remainingUncovered:', summary.remainingUncovered);

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

async function getPaymentSummariesForRefundCases(refundCaseIds) {
  if (!refundCaseIds?.length) return new Map();
  try {
    await ensurePaymentSummaryColumn({ query: (text, params) => db.query(text, params) });
  } catch (err) {
    console.warn('⚠️ Could not ensure refund transaction summary column exists:', err.message || err);
  }

  const res = await db.query(
    `SELECT DISTINCT ON (refund_case_id) refund_case_id, payment_summary
     FROM refund_transactions
     WHERE refund_case_id = ANY($1::uuid[])
     ORDER BY refund_case_id, created_at DESC`,
    [refundCaseIds]
  );

  const map = new Map();
  res.rows.forEach(r => {
    let s = r.payment_summary;
    if (typeof s === 'string') { try { s = JSON.parse(s); } catch { s = null; } }
    if (s) map.set(r.refund_case_id, s);
  });
  return map;
}

async function prepareRefundForPayment({ refundCase, refundId, actor = 'system' } = {}) {
  console.log('[refund-debug] enter prepareRefundForPayment', { refundCaseId: refundCase?.id, refundId, actor });
  const refund = await resolveRefundCase(refundCase || refundId);
  console.log('[refund-debug] loaded refund', { id: refund?.id, refund_payment_status: refund?.refund_payment_status, refund_transaction_id: refund?.refund_transaction_id, seller_id: refund?.seller_id, order_id: refund?.order_id });
  if (!refund) {
    console.log('[refund-debug] exit prepareRefundForPayment: refund could not be loaded');
    throw new Error('Refund case could not be loaded');
  }

  await ensurePaymentSummaryColumn({ query: (text, params) => db.query(text, params) });

  const existingPaymentStatus = String(refund.refund_payment_status || '').toLowerCase();
  const existingTxId = refund.refund_transaction_id;
  const existingTxRes = existingTxId
    ? await db.query('SELECT id, payment_summary, completed_at, payment_status FROM refund_transactions WHERE id = $1 LIMIT 1', [existingTxId])
    : await db.query('SELECT id, payment_summary, completed_at, payment_status FROM refund_transactions WHERE refund_case_id = $1 ORDER BY created_at DESC LIMIT 1', [refund.id]);
  const existingTransaction = existingTxRes.rows[0] || null;
  const hasExistingTransactionRow = Boolean(existingTransaction?.id);

  if ((existingPaymentStatus === 'processing' || existingPaymentStatus === 'paid') && hasExistingTransactionRow) {
    console.log('[refund-debug] existing payment path taken', { existingPaymentStatus, existingTxId, existingTransactionId: existingTransaction?.id });

    const txPaymentStatus = String(existingTransaction.payment_status || '').toLowerCase();
    if (txPaymentStatus === 'paid' && existingPaymentStatus !== 'paid') {
      console.log('[refund-debug] synchronizing refund case from existing paid transaction', {
        refundId: refund.id,
        existingTransactionId: existingTransaction.id,
        refundCasePaymentStatus: refund.refund_payment_status,
        transactionPaymentStatus: existingTransaction.payment_status
      });
      const synchronizedRefund = await finalizeRefundCasePayment({ query: (text, params) => db.query(text, params) }, refund, refund.refund_payment_reference || existingTransaction.payment_reference || buildPaymentReference(), existingTransaction.id);
      console.log('[refund-debug] synchronized refund case after paid transaction discovery', {
        refundId: refund.id,
        syncedRefundCase: synchronizedRefund.rows?.[0]
      });

      return {
        refundCase: synchronizedRefund.rows?.[0] || refund,
        transaction: existingTransaction,
        prepared: true,
        reason: 'payment_status_synchronized'
      };
    }

    if (existingTransaction && (!existingTransaction.payment_summary || !existingTransaction.completed_at)) {
      console.log('[refund-debug] backfilling existing refund transaction', { existingTransactionId: existingTransaction.id, refundId: refund.id });
      const paymentSummary = await loadRefundProcessingSummary(refund);
      console.log('[refund-debug] paymentSummary for backfill', paymentSummary);
      const refundAmount = paymentSummary.refundAmount;
      const shippingAmount = paymentSummary.shippingAmount;
      const totalAmount = paymentSummary.totalRefundAmount;

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

      console.log('[refund-debug] updated existing refund_transactions record', { refundTransactionId: existingTransaction.id, updatedTx: updatedTx.rows[0] });
      await applyRefundWalletDeductions({ query: (text, params) => db.query(text, params) }, refund, paymentSummary);
      console.log('[refund-debug] completed wallet deductions for backfill', { refundId: refund.id, sellerId: refund.seller_id });
      const finalizedRefund = await finalizeRefundCasePayment({ query: (text, params) => db.query(text, params) }, refund, refund.refund_payment_reference || existingTransaction.payment_reference || buildPaymentReference(), existingTransaction.id);
      console.log('[refund-debug] after finalizeRefundCasePayment for backfill', { refundId: refund.id, finalizedRefundId: finalizedRefund.rows?.[0]?.id });

      return {
        refundCase: finalizedRefund.rows?.[0] || refund,
        transaction: updatedTx.rows[0] || existingTransaction,
        prepared: true,
        reason: 'summary_backfilled'
      };
    }

    console.log('[refund-debug] exit prepareRefundForPayment: already prepared or no update needed', { refundId: refund.id, existingTransactionId: existingTransaction?.id });
    return {
      refundCase: refund,
      transaction: existingTransaction,
      prepared: false,
      reason: 'already_prepared'
    };
  }

  if (existingTxId && !hasExistingTransactionRow) {
    console.log('[refund-debug] stale refund_transaction_id detected, proceeding to create a fresh transaction row', {
      refundId: refund.id,
      existingTxId,
      refundPaymentStatus: refund.refund_payment_status
    });
  }

  const calculatedRefund = await loadRefundProcessingSummary(refund);
  console.log('[refund-debug] Calculated refund object', { refundId: refund.id, calculatedRefund });
  const refundAmount = calculatedRefund.refundAmount;
  const shippingAmount = calculatedRefund.shippingAmount;
  const totalAmount = calculatedRefund.totalRefundAmount;
  const paymentSummary = calculatedRefund;
  const processedBy = resolveProcessedBy(refund, actor);

  const paymentReference = refund.refund_payment_reference || buildPaymentReference();

  const result = await db.transaction(async (client) => {
    await ensurePaymentSummaryColumn(client);

    const insertPayload = [
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
    ];

    console.log('[refund-debug] before INSERT refund_transactions', {
      refundId: refund.id,
      sellerId: refund.seller_id,
      buyerId: refund.buyer_id,
      orderId: refund.order_id,
      insertPayload
    });
    console.log('[refund-debug] Calculated refund object before insert', {
      refundId: refund.id,
      refundAmount,
      shippingAmount,
      totalAmount,
      paymentSummary
    });
    console.log('[refund-debug] Insert payload', {
      refundId: refund.id,
      payload: insertPayload
    });

    let txRes;
    try {
      txRes = await client.query(
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
        insertPayload
      );
    } catch (err) {
      console.error('[refund-debug] INSERT refund_transactions failed', {
        refundCaseId: refund.id,
        sellerId: refund.seller_id,
        paymentSummary,
        insertPayload,
        error: err
      });
      throw err;
    }

    const tx = txRes.rows[0];
    console.log('[refund-debug] Inserted values', {
      refundId: refund.id,
      refundAmount: tx?.refund_amount,
      shippingAmount: tx?.shipping_amount,
      totalAmount: tx?.total_amount,
      paymentSummary: tx?.payment_summary
    });
    console.log('[refund-debug] Inserted row', { refundCaseId: refund.id, transactionId: tx?.id, tx });
    await applyRefundWalletDeductions(client, refund, paymentSummary);
    console.log('[refund-debug] after applyRefundWalletDeductions', { refundCaseId: refund.id, sellerId: refund.seller_id });

    console.log('[refund-debug] before finalizeRefundCasePayment', { refundId: refund.id, paymentReference, transactionId: tx.id });
    const updateRes = await finalizeRefundCasePayment(client, refund, paymentReference, tx.id);
    console.log('[refund-debug] after finalizeRefundCasePayment', { refundId: refund.id, finalizedRefundCase: updateRes.rows?.[0] });

    await client.query(
      `UPDATE refund_transactions
       SET payment_status = 'paid',
           completed_at = NOW(),
           refund_amount = $2,
           shipping_amount = $3,
           total_amount = $4,
           payment_summary = $5
       WHERE id = $1`,
      [tx.id, refundAmount, shippingAmount, totalAmount, JSON.stringify(paymentSummary)]
    );
    console.log('[refund-debug] after UPDATE refund_transactions payment_status paid', { transactionId: tx.id });

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
  getPaymentSummaryForRefundCase,
  getPaymentSummariesForRefundCases
};
