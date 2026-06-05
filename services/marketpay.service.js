/**
 * MarketPay — Core Payment Service
 *
 * Central router for all payment providers.
 * Add a new provider by:
 *   1. Creating adapter in ./adapter/<name>.adapter.js
 *   2. Registering it in ADAPTERS below
 *   3. Adding env vars — zero changes to business logic
 *
 * Supported methods: 'paystack'
 */

const paystackAdapter    = require('../adapter/paystack.adapter');
// const flutterwaveAdapter = require('../adapter/flutterwave.adapter');

const ADAPTERS = {
  paystack:    paystackAdapter,
  // flutterwave: flutterwaveAdapter,
};

const SUPPORTED_METHODS = Object.keys(ADAPTERS);

function getAdapter(method) {
  const adapter = ADAPTERS[method];
  if (!adapter) {
    throw new Error(`Payment method "${method}" is not supported. Supported: ${SUPPORTED_METHODS.join(', ')}`);
  }
  return adapter;
}

/**
 * Initialize a payment transaction.
 *
 * @param {string} method   - 'paystack'
 * @param {object} payload  - { orderId, amount, currency, email, name, phone, metadata, callbackUrl }
 * @returns {PaymentInitResult}
 */
async function initiatePayment(method, payload) {
  const adapter = getAdapter(method);
  return adapter.initiate(payload);
}

/**
 * Verify a payment transaction.
 *
 * @param {string} method    - provider used
 * @param {string} reference - transaction reference
 * @param {string} [transactionId] - provider-specific ID
 * @returns {PaymentVerifyResult}
 */
async function verifyPayment(method, reference, transactionId) {
  const adapter = getAdapter(method);
  return adapter.verify(transactionId || reference);
}

/**
 * Refund a payment.
 *
 * @param {string} method   - provider used
 * @param {object} payload  - { reference, transactionId, amount, reason }
 * @returns {RefundResult}
 */
async function refundPayment(method, payload) {
  const adapter = getAdapter(method);
  return adapter.refund(payload);
}

/**
 * Verify a webhook signature for a given provider.
 */
function verifyWebhook(method, payload, signature) {
  const adapter = getAdapter(method);
  if (typeof adapter.verifyWebhookSignature !== 'function') return true;
  return adapter.verifyWebhookSignature(payload, signature);
}

/**
 * Get list of available payment methods.
 * Filters out providers whose keys are not configured.
 */
function getAvailableMethods() {
  const methods = [];

  methods.push({
    id:          'paystack',
    label:       'Pay with Card / Bank Transfer',
    description: 'Visa, Mastercard, USSD, Bank Transfer',
    icon:        'paystack',
    available:   !!process.env.PAYSTACK_SECRET_KEY,
  });

  // methods.push({
  //   id:          'flutterwave',
  //   label:       'Pay with Flutterwave',
  //   description: 'Card, Bank, USSD, Barter, Mobile Money',
  //   icon:        'flutterwave',
  //   available:   !!process.env.FLUTTERWAVE_SECRET_KEY,
  // });

  return methods.filter(m => m.available);
}

module.exports = {
  initiatePayment,
  verifyPayment,
  refundPayment,
  verifyWebhook,
  getAvailableMethods,
  SUPPORTED_METHODS,
};
