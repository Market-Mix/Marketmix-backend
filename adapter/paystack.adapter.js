/**
 * MarketPay — Paystack Adapter
 * Docs: https://paystack.com/docs/api/
 *
 * Env vars required:
 *   PAYSTACK_SECRET_KEY   — sk_live_... or sk_test_...
 *   PAYSTACK_PUBLIC_KEY   — pk_live_... or pk_test_...
 *   FRONTEND_URL        — https://marketmix.vercel.app
 */

const PAYSTACK_BASE = 'https://api.paystack.co';
const SECRET_KEY    = process.env.PAYSTACK_SECRET_KEY;

function headers() {
  if (!SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY is not configured');
  return {
    Authorization: `Bearer ${SECRET_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function paystackPost(path, body) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  return res.json();
}

async function paystackGet(path) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method: 'GET',
    headers: headers(),
  });
  return res.json();
}

/**
 * Initialize Paystack transaction.
 * Returns: { authorizationUrl, accessCode, reference }
 */
async function initiate({
  orderId,
  amount,        // in Naira (we convert to kobo)
  currency = 'NGN',
  email,
  metadata = {},
  callbackUrl,
}) {
  const reference = `MX-PS-${orderId}-${Date.now()}`;

  const body = {
    email,
    amount:    Math.round(amount * 100), // kobo
    currency,
    reference,
    callback_url: callbackUrl || `${process.env.FRONTEND_URL}/api/payments/paystack/callback`,
    metadata: {
      order_id:   orderId,
      provider:   'paystack',
      ...metadata,
    },
    channels: ['card', 'bank', 'ussd', 'bank_transfer', 'mobile_money'],
  };

  const data = await paystackPost('/transaction/initialize', body);

  if (!data.status) {
    throw new Error(data.message || 'Paystack initialization failed');
  }

  return {
    success:          true,
    provider:         'paystack',
    reference,
    authorizationUrl: data.data.authorization_url,
    accessCode:       data.data.access_code,
    amount,
    currency,
    status:           'pending',
    paymentStatus:    'unpaid',
    raw:              data.data,
  };
}

/**
 * Verify a Paystack transaction by reference.
 */
async function verify(reference) {
  const data = await paystackGet(`/transaction/verify/${reference}`);

  if (!data.status) {
    throw new Error(data.message || 'Paystack verification failed');
  }

  const tx = data.data;

  return {
    success:       true,
    provider:      'paystack',
    reference:     tx.reference,
    status:        tx.status,                          // 'success' | 'failed' | 'abandoned'
    paymentStatus: tx.status === 'success' ? 'paid' : 'unpaid',
    amount:        tx.amount / 100,                    // back to Naira
    currency:      tx.currency,
    channel:       tx.channel,
    paidAt:        tx.paid_at,
    gatewayResponse: tx.gateway_response,
    metadata:      tx.metadata,
    fees:          tx.fees ? tx.fees / 100 : 0,
    raw:           tx,
  };
}

/**
 * Refund a Paystack transaction.
 */
async function refund({ reference, amount, reason }) {
  const body = {
    transaction: reference,
    amount:      amount ? Math.round(amount * 100) : undefined,
    merchant_note: reason,
  };

  const data = await paystackPost('/refund', body);

  if (!data.status) {
    throw new Error(data.message || 'Paystack refund failed');
  }

  return {
    success:   true,
    provider:  'paystack',
    reference,
    refundId:  data.data?.id,
    amount:    data.data?.amount ? data.data.amount / 100 : amount,
    status:    data.data?.status,
    raw:       data.data,
  };
}

/**
 * Verify Paystack webhook signature.
 * Call this before processing any webhook event.
 */
function verifyWebhookSignature(payload, signature) {
  const crypto = require('crypto');
  const hash = crypto
    .createHmac('sha512', SECRET_KEY)
    .update(JSON.stringify(payload))
    .digest('hex');
  return hash === signature;
}

module.exports = { initiate, verify, refund, verifyWebhookSignature };