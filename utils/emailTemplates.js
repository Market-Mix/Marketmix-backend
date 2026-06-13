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
};