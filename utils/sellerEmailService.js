const sendEmail = require('./sendEmail');
const templates = require('./emailTemplates');
const db = require('../config/db');

async function getSellerEmail(sellerId) {
  const r = await db.query(
    `SELECT u.email, u.first_name, u.last_name,
            sp.business_email
     FROM users u
     LEFT JOIN seller_profiles sp ON sp.user_id = u.id
     WHERE u.id = $1`, [sellerId]
  );
    console.log('getSellerEmail rows:', r.rows); // ADD THIS
  if (!r.rows.length) {
    console.warn('No user found for sellerId', sellerId); // ADD THIS
    return null;
  }

  if (!r.rows.length) return null;
  const row = r.rows[0];
   const resolvedEmail = row.business_email || row.email;
  console.log('Resolved email:', resolvedEmail); // ADD THIS
  return {
    email: row.business_email || row.email,
    name: `${row.first_name} ${row.last_name}`.trim()
  };
}

async function notifySeller(sellerId, type, data) {
  console.log(`📬 notifySeller called: type=${type} sellerId=${sellerId}`);
  // ... rest of function

  try {
    const seller = await getSellerEmail(sellerId);
    if (!seller) return;

    const payloads = {
      newOrder:          { subject: '🎉 New Order Received', html: templates.newOrder({ sellerName: seller.name, ...data }) },
      paymentReceived:   { subject: '💰 Payment Received', html: templates.paymentReceived({ sellerName: seller.name, ...data }) },
      withdrawalSuccess: { subject: '✅ Withdrawal Successful', html: templates.withdrawalSuccess({ sellerName: seller.name, ...data }) },
      withdrawalFailed:  { subject: '❌ Withdrawal Failed', html: templates.withdrawalFailed({ sellerName: seller.name, ...data }) },
      orderCancelled:    { subject: 'Order Cancelled', html: templates.orderCancelled({ sellerName: seller.name, ...data }) },
      newLogin:          { subject: '🔐 New Login Detected', html: templates.newLogin({ sellerName: seller.name, ...data }) },
      newReview:         { subject: '⭐ New Product Review', html: templates.newReview({ sellerName: seller.name, ...data }) },
      weeklySalesReport: { subject: '📊 Weekly Sales Report', html: templates.weeklySalesReport({ sellerName: seller.name, ...data }) },
      outOfStock:        { subject: '⚠️ Product Out of Stock', html: templates.outOfStock({ sellerName: seller.name, ...data }) },
      refundRequest:     { subject: 'Refund Request Received', html: templates.refundRequest({ sellerName: seller.name, ...data }) },
    };
    
const p = payloads[type];
if (!p) {
  console.warn('No template for type:', type); // ADD THIS
  return;
}
console.log('Sending email to:', seller.email, 'subject:', p.subject); // ADD THIS
const result = await sendEmail({ to: seller.email, ...p });
console.log('sendEmail result:', result); // ADD THIS
 } catch (err) {
  console.error(`sellerEmailService[${type}] error:`, err); // remove .message
}
}

module.exports = { notifySeller };