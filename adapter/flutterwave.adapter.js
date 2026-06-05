// /**
//  * MarketPay — Flutterwave Adapter
//  * Docs: https://developer.flutterwave.com/docs/
//  *
//  * Env vars required:
//  *   FLUTTERWAVE_SECRET_KEY       — FLWSECK_...
//  *   FLUTTERWAVE_PUBLIC_KEY       — FLWPUBK_...
//  *   FLUTTERWAVE_ENCRYPTION_KEY   — (for direct charge)
//  *   APP_BASE_URL                 — https://marketmix-backend.onrender.com
//  */
//
// const FLW_BASE   = 'https://api.flutterwave.com/v3';
// const SECRET_KEY = process.env.FLUTTERWAVE_SECRET_KEY;
//
// function headers() {
//   if (!SECRET_KEY) throw new Error('FLUTTERWAVE_SECRET_KEY is not configured');
//   return {
//     Authorization: `Bearer ${SECRET_KEY}`,
//     'Content-Type': 'application/json',
//   };
// }
//
// async function flwPost(path, body) {
//   const res = await fetch(`${FLW_BASE}${path}`, {
//     method: 'POST',
//     headers: headers(),
//     body: JSON.stringify(body),
//   });
//   return res.json();
// }
//
// async function flwGet(path) {
//   const res = await fetch(`${FLW_BASE}${path}`, {
//     method: 'GET',
//     headers: headers(),
//   });
//   return res.json();
// }
//
// /**
//  * Initialize Flutterwave Standard (redirect) payment.
//  * Returns: { paymentLink, txRef }
//  */
// async function initiate({
//   orderId,
//   amount,
//   currency = 'NGN',
//   email,
//   name,
//   phone,
//   metadata = {},
//   callbackUrl,
//   redirectUrl,
// }) {
//   const txRef = `MX-FLW-${orderId}-${Date.now()}`;
//
//   const body = {
//     tx_ref:           txRef,
//     amount,
//     currency,
//     redirect_url:     redirectUrl || callbackUrl || `${process.env.APP_BASE_URL}/api/payments/flutterwave/callback`,
//     customer: {
//       email,
//       phonenumber: phone,
//       name:        name || email,
//     },
//     customizations: {
//       title:       'MarketPay',
//       description: `Payment for order #${orderId}`,
//       logo:        process.env.APP_LOGO_URL || '',
//     },
//     meta: {
//       order_id: orderId,
//       provider: 'flutterwave',
//       ...metadata,
//     },
//     payment_options: 'card,banktransfer,ussd,account,barter',
//   };
//
//   const data = await flwPost('/payments', body);
//
//   if (data.status !== 'success') {
//     throw new Error(data.message || 'Flutterwave initialization failed');
//   }
//
//   return {
//     success:       true,
//     provider:      'flutterwave',
//     reference:     txRef,
//     paymentLink:   data.data.link,
//     amount,
//     currency,
//     status:        'pending',
//     paymentStatus: 'unpaid',
//     raw:           data.data,
//   };
// }
//
// /**
//  * Verify a Flutterwave transaction by transaction ID or tx_ref.
//  */
// async function verify(reference) {
//   // reference can be tx_ref or transaction ID
//   const isId = /^\d+$/.test(String(reference));
//   const data  = isId
//     ? await flwGet(`/transactions/${reference}/verify`)
//     : await _verifyByRef(reference);
//
//   if (data.status !== 'success') {
//     throw new Error(data.message || 'Flutterwave verification failed');
//   }
//
//   const tx = data.data;
//
//   return {
//     success:         true,
//     provider:        'flutterwave',
//     reference:       tx.tx_ref,
//     transactionId:   tx.id,
//     status:          tx.status,                           // 'successful' | 'failed' | 'pending'
//     paymentStatus:   tx.status === 'successful' ? 'paid' : 'unpaid',
//     amount:          tx.amount,
//     chargedAmount:   tx.charged_amount,
//     currency:        tx.currency,
//     channel:         tx.payment_type,
//     paidAt:          tx.created_at,
//     gatewayResponse: tx.processor_response,
//     fees:            tx.app_fee || 0,
//     metadata:        tx.meta,
//     raw:             tx,
//   };
// }
//
// async function _verifyByRef(txRef) {
//   const data = await flwGet(`/transactions?tx_ref=${txRef}`);
//   if (!data.data || !data.data.length) {
//     return { status: 'error', message: 'Transaction not found' };
//   }
//   // Re-verify by ID for authoritative response
//   const txId = data.data[0].id;
//   return flwGet(`/transactions/${txId}/verify`);
// }
//
// /**
//  * Refund a Flutterwave transaction.
//  */
// async function refund({ transactionId, amount, reference }) {
//   if (!transactionId) {
//     throw new Error('transactionId required for Flutterwave refund');
//   }
//
//   const body = { amount };
//   const data = await flwPost(`/transactions/${transactionId}/refund`, body);
//
//   if (data.status !== 'success') {
//     throw new Error(data.message || 'Flutterwave refund failed');
//   }
//
//   return {
//     success:   true,
//     provider:  'flutterwave',
//     reference,
//     transactionId,
//     refundId:  data.data?.id,
//     amount:    data.data?.amount_refunded || amount,
//     status:    data.data?.status,
//     raw:       data.data,
//   };
// }
//
// /**
//  * Verify Flutterwave webhook signature.
//  */
// function verifyWebhookSignature(payload, signature) {
//   const secretHash = process.env.FLUTTERWAVE_WEBHOOK_HASH;
//   if (!secretHash) return true; // skip if not configured
//   return signature === secretHash;
// }
//
// module.exports = { initiate, verify, refund, verifyWebhookSignature };
