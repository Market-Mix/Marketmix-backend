/**
 * MarketPay — Cash on Delivery Adapter
 * COD is the only method that creates an order immediately
 * without waiting for payment confirmation.
 */

const COD_FEE = parseFloat(process.env.COD_FEE || 0);

/**
 * Initialize a COD "payment" — no external call needed.
 * Returns a mock transaction reference for record-keeping.
 */
async function initiate({ orderId, amount, currency = 'NGN', metadata = {} }) {
  const reference = `COD-${orderId}-${Date.now()}`;

  return {
    success: true,
    provider: 'cod',
    reference,
    amount,
    currency,
    status: 'pending',       // payment collected on delivery
    paymentStatus: 'unpaid',
    message: 'Cash on Delivery order created. Payment collected on delivery.',
    fee: COD_FEE,
    metadata,
  };
}

/**
 * COD orders are "verified" when the delivery agent confirms collection.
 * This is a manual process — webhook or seller confirms via dashboard.
 */
async function verify(reference) {
  return {
    success: true,
    provider: 'cod',
    reference,
    status: 'pending',
    paymentStatus: 'unpaid',
    message: 'COD payment pending delivery confirmation',
  };
}

/**
 * COD refund = manual process (no external API)
 */
async function refund({ reference, amount, reason }) {
  return {
    success: true,
    provider: 'cod',
    reference,
    amount,
    reason,
    message: 'COD refund must be processed manually',
    requiresManualProcessing: true,
  };
}

module.exports = { initiate, verify, refund };