const BASE = process.env.FRONTEND_URL || 'https://marketmix.vercel.app';
const LOGO = `${BASE}/assets/logo.png`;

const wrap = (content) => `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden">
  <div style="background:#1d4ed8;padding:20px;text-align:center">
    <h1 style="color:#fff;margin:0">MarketMix</h1>
  </div>
  <div style="padding:30px">${content}</div>
  <div style="background:#f8fafc;padding:15px;text-align:center;color:#94a3b8;font-size:12px">
    &copy; 2025 MarketMix. All rights reserved.
  </div>
</div>
</body></html>`;

const btn = (url, text) => `<a href="${url}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;margin-top:15px">${text}</a>`;

module.exports = {
  newOrder: ({ sellerName, orderId, buyerName, amount, items }) => wrap(`
    <h2>New Order Received! 🎉</h2>
    <p>Hi ${sellerName},</p>
    <p>You have a new order from <strong>${buyerName}</strong>.</p>
    <table style="width:100%;border-collapse:collapse;margin:15px 0">
      <tr><td style="padding:8px;border:1px solid #e2e8f0"><strong>Order ID</strong></td><td style="padding:8px;border:1px solid #e2e8f0">#${String(orderId).slice(0,8).toUpperCase()}</td></tr>
      <tr><td style="padding:8px;border:1px solid #e2e8f0"><strong>Amount</strong></td><td style="padding:8px;border:1px solid #e2e8f0">₦${Number(amount).toLocaleString()}</td></tr>
      <tr><td style="padding:8px;border:1px solid #e2e8f0"><strong>Items</strong></td><td style="padding:8px;border:1px solid #e2e8f0">${items}</td></tr>
    </table>
    ${btn(`${BASE}/sellers/sellers order.html`, 'View Order')}`),

  paymentReceived: ({ sellerName, orderId, amount }) => wrap(`
    <h2>Payment Received! 💰</h2>
    <p>Hi ${sellerName},</p>
    <p>Payment of <strong>₦${Number(amount).toLocaleString()}</strong> for order <strong>#${String(orderId).slice(0,8).toUpperCase()}</strong> has been received and held in escrow.</p>
    <p>Funds will be released after delivery confirmation.</p>
    ${btn(`${BASE}/sellers/sellers earning.html`, 'View Earnings')}`),

  withdrawalSuccess: ({ sellerName, amount, bankName, accountNumber }) => wrap(`
    <h2>Withdrawal Successful ✅</h2>
    <p>Hi ${sellerName},</p>
    <p>Your withdrawal of <strong>₦${Number(amount).toLocaleString()}</strong> to <strong>${bankName}</strong> (****${String(accountNumber).slice(-4)}) has been processed successfully.</p>
    ${btn(`${BASE}/sellers/sellers earning.html`, 'View Earnings')}`),

  withdrawalFailed: ({ sellerName, amount, reason }) => wrap(`
    <h2>Withdrawal Failed ❌</h2>
    <p>Hi ${sellerName},</p>
    <p>Your withdrawal of <strong>₦${Number(amount).toLocaleString()}</strong> failed.</p>
    <p><strong>Reason:</strong> ${reason || 'Bank declined the transfer'}</p>
    <p>Your balance has been restored. Please try again or contact support.</p>
    ${btn(`${BASE}/sellers/sellers earning.html`, 'Try Again')}`),

  orderCancelled: ({ sellerName, orderId, buyerName }) => wrap(`
    <h2>Order Cancelled</h2>
    <p>Hi ${sellerName},</p>
    <p>Order <strong>#${String(orderId).slice(0,8).toUpperCase()}</strong> from ${buyerName} has been cancelled.</p>
    ${btn(`${BASE}/sellers/sellers order.html`, 'View Orders')}`),

  newLogin: ({ sellerName, ip, device, time }) => wrap(`
    <h2>New Login Detected 🔐</h2>
    <p>Hi ${sellerName},</p>
    <p>A new login to your account was detected:</p>
    <table style="width:100%;border-collapse:collapse;margin:15px 0">
      <tr><td style="padding:8px;border:1px solid #e2e8f0"><strong>Time</strong></td><td style="padding:8px;border:1px solid #e2e8f0">${time}</td></tr>
      <tr><td style="padding:8px;border:1px solid #e2e8f0"><strong>Device</strong></td><td style="padding:8px;border:1px solid #e2e8f0">${device || 'Unknown'}</td></tr>
      <tr><td style="padding:8px;border:1px solid #e2e8f0"><strong>IP</strong></td><td style="padding:8px;border:1px solid #e2e8f0">${ip || 'Unknown'}</td></tr>
    </table>
    <p>If this wasn't you, change your password immediately.</p>`),

  newReview: ({ sellerName, productName, rating, comment, reviewerName }) => wrap(`
    <h2>New Product Review ⭐</h2>
    <p>Hi ${sellerName},</p>
    <p><strong>${reviewerName}</strong> left a ${rating}-star review on <strong>${productName}</strong>:</p>
    <blockquote style="border-left:4px solid #1d4ed8;padding:10px 15px;background:#f0f4ff;margin:15px 0">${comment}</blockquote>
    ${btn(`${BASE}/sellers/sellers product.html`, 'View Products')}`),

  weeklySalesReport: ({ sellerName, totalOrders, totalRevenue, topProduct, weekStart, weekEnd }) => wrap(`
    <h2>Weekly Sales Report 📊</h2>
    <p>Hi ${sellerName}, here's your summary for ${weekStart} – ${weekEnd}:</p>
    <table style="width:100%;border-collapse:collapse;margin:15px 0">
      <tr><td style="padding:8px;border:1px solid #e2e8f0"><strong>Total Orders</strong></td><td style="padding:8px;border:1px solid #e2e8f0">${totalOrders}</td></tr>
      <tr><td style="padding:8px;border:1px solid #e2e8f0"><strong>Total Revenue</strong></td><td style="padding:8px;border:1px solid #e2e8f0">₦${Number(totalRevenue).toLocaleString()}</td></tr>
      <tr><td style="padding:8px;border:1px solid #e2e8f0"><strong>Top Product</strong></td><td style="padding:8px;border:1px solid #e2e8f0">${topProduct || '—'}</td></tr>
    </table>
    ${btn(`${BASE}/sellers/sellers earning.html`, 'Full Report')}`),

  outOfStock: ({ sellerName, productName, productId }) => wrap(`
    <h2>Product Out of Stock ⚠️</h2>
    <p>Hi ${sellerName},</p>
    <p>Your product <strong>${productName}</strong> is now out of stock.</p>
    <p>Update your inventory to avoid missing sales.</p>
    ${btn(`${BASE}/sellers/sellers product.html`, 'Update Inventory')}`),

  refundRequest: ({ sellerName, orderId, buyerName, productName, reason }) => wrap(`
    <h2>Refund Request Received</h2>
    <p>Hi ${sellerName},</p>
    <p><strong>${buyerName}</strong> has submitted a refund request for order <strong>#${String(orderId).slice(0,8).toUpperCase()}</strong>.</p>
    <p><strong>Product:</strong> ${productName}</p>
    <p><strong>Reason:</strong> ${reason}</p>
    <p>Please respond within 2 days to avoid automatic escalation.</p>
    ${btn(`${BASE}/sellers/sellers returns.html`, 'View Refund')}`),


    
// Add these to the existing module.exports object:

orderConfirmed: ({ buyerName, orderId, items, total, estimatedDelivery }) => wrap(`
  <h2>Order Confirmed! 🎉</h2>
  <p>Hi ${buyerName}, your order has been confirmed.</p>
  <table style="width:100%;border-collapse:collapse;margin:15px 0">
    <tr><td style="padding:8px;border:1px solid #e2e8f0"><strong>Order ID</strong></td><td style="padding:8px;border:1px solid #e2e8f0">#${String(orderId).slice(0,8).toUpperCase()}</td></tr>
    <tr><td style="padding:8px;border:1px solid #e2e8f0"><strong>Items</strong></td><td style="padding:8px;border:1px solid #e2e8f0">${items}</td></tr>
    <tr><td style="padding:8px;border:1px solid #e2e8f0"><strong>Total</strong></td><td style="padding:8px;border:1px solid #e2e8f0">₦${Number(total).toLocaleString()}</td></tr>
    ${estimatedDelivery ? `<tr><td style="padding:8px;border:1px solid #e2e8f0"><strong>Est. Delivery</strong></td><td style="padding:8px;border:1px solid #e2e8f0">${estimatedDelivery}</td></tr>` : ''}
  </table>
  ${btn(`${BASE}/buyers/buyers%20order%20&%20tracking.html`, 'Track Order')}`),

orderProcessing: ({ buyerName, orderId }) => wrap(`
  <h2>Order Being Prepared 📦</h2>
  <p>Hi ${buyerName}, the seller is preparing your order <strong>#${String(orderId).slice(0,8).toUpperCase()}</strong>.</p>
  ${btn(`${BASE}/buyers/buyers%20order%20&%20tracking.html`, 'Track Order')}`),

orderShipped: ({ buyerName, orderId, trackingId, courierName, trackingLink, estimatedDelivery }) => wrap(`
  <h2>Your Order is On the Way! 🚚</h2>
  <p>Hi ${buyerName}, your order <strong>#${String(orderId).slice(0,8).toUpperCase()}</strong> has been shipped.</p>
  <table style="width:100%;border-collapse:collapse;margin:15px 0">
    <tr><td style="padding:8px;border:1px solid #e2e8f0"><strong>Courier</strong></td><td style="padding:8px;border:1px solid #e2e8f0">${courierName || 'N/A'}</td></tr>
    <tr><td style="padding:8px;border:1px solid #e2e8f0"><strong>Tracking ID</strong></td><td style="padding:8px;border:1px solid #e2e8f0">${trackingId || 'N/A'}</td></tr>
    ${estimatedDelivery ? `<tr><td style="padding:8px;border:1px solid #e2e8f0"><strong>Est. Delivery</strong></td><td style="padding:8px;border:1px solid #e2e8f0">${estimatedDelivery}</td></tr>` : ''}
  </table>
  ${trackingLink ? btn(trackingLink, 'Track Shipment') : ''}
  ${btn(`${BASE}/buyers/buyers%20order%20&%20tracking.html`, 'View Order')}`),

orderDelivered: ({ buyerName, orderId }) => wrap(`
  <h2>Order Delivered! ✅</h2>
  <p>Hi ${buyerName}, your order <strong>#${String(orderId).slice(0,8).toUpperCase()}</strong> has been delivered.</p>
  <p>If you have any issues, you have <strong>24 hours</strong> to open a dispute.</p>
  ${btn(`${BASE}/buyers/buyers%20order%20&%20tracking.html`, 'View Order')}`),

paymentFailed: ({ buyerName, orderId, amount }) => wrap(`
  <h2>Payment Failed ❌</h2>
  <p>Hi ${buyerName}, your payment of <strong>₦${Number(amount).toLocaleString()}</strong> for order <strong>#${String(orderId).slice(0,8).toUpperCase()}</strong> failed.</p>
  <p>Please retry your payment to complete the order.</p>
  ${btn(`${BASE}/buyers/buyers%20order%20&%20tracking.html`, 'Retry Payment')}`),

disputeOpened: ({ buyerName, orderId, caseId }) => wrap(`
  <h2>Dispute Received 🔍</h2>
  <p>Hi ${buyerName}, we've received your dispute for order <strong>#${String(orderId).slice(0,8).toUpperCase()}</strong>.</p>
  <p><strong>Case ID:</strong> ${caseId}</p>
  <h3>Next Steps:</h3>
  <ol>
    <li>The seller has been notified and has <strong>2 days</strong> to respond.</li>
    <li>You can chat with the seller in the dispute portal.</li>
    <li>If unresolved, MarketMix will step in after 48 hours.</li>
  </ol>
  ${btn(`${BASE}/buyers/buyers%20return%20report.html?case=${caseId}`, 'View Dispute')}`)
  
};
