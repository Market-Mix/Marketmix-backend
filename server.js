require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const corsOptions = require('./config/cors');
const db = require('./config/db');
const { handlePaystackWithdrawalWebhook } = require('./controllers/withdrawal.controller');
// const { handleFlutterwaveTransferWebhook } = require('./controllers/withdrawal.controller');

// Create Express app
const app = express();

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors(corsOptions));

// Cache public read-only routes at CDN/browser level
app.use((req, res, next) => {
  const publicRoutes = ['/api/products', '/api/categories', '/api/seller/public'];
  const isPublicGet = req.method === 'GET' &&
    publicRoutes.some(r => req.path.startsWith(r));
  if (isPublicGet) {
    res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=60');
  }
  next();
});

// Logging middleware
app.use(morgan(process.env.NODE_ENV === 'development' ? 'dev' : 'combined'));

// Webhook routes (BEFORE body-parsing middleware to preserve raw body for signature verification)
app.post('/api/webhooks/paystack',
  express.raw({ type: 'application/json' }),
  handlePaystackWithdrawalWebhook
);
// app.post('/api/webhooks/flutterwave-transfer',
//   express.raw({ type: 'application/json' }),
//   handleFlutterwaveTransferWebhook
// );

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check route
app.get('/', (req, res) => {
  res.json({
    status: 'success',
    message: 'MarketMix API is running',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

const cookieParser = require('cookie-parser');
app.use(cookieParser());

// Import routes (keep your existing imports)
const authRoutes = require('./routes/auth.routes');
const buyerRoutes = require('./routes/buyer.routes');
const adminRoutes = require('./routes/admin.routes');
const productsRoutes = require('./routes/products.routes');
const cartRoutes = require('./routes/cart.routes');
const checkoutRoutes = require('./routes/checkout.routes');
const vendorRoutes = require('./routes/vendor_shipping.routes');
const deliveryRoutes = require('./routes/checkout_delivery.routes');
const paymentRoutes = require('./routes/payment.routes');
const ordersRoutes = require('./routes/orders.routes');
const earningsRoutes = require('./routes/earnings.routes');
const reviewsRoutes = require('./routes/reviews.routes');
const categoryRoutes = require('./routes/category.routes');
const withdrawalRoutes = require('./routes/withdrawal.routes');
const notificationRoutes = require('./routes/notification.routes');
const paymentMethodsRoutes = require('./routes/paymentMethods.routes');
const wishlistRoutes = require('./routes/wishlist.routes');
const sellerProductsRoutes = require('./routes/sellers_products.routes');
const sellerOrdersRoutes = require('./routes/seller_orders.routes');
const sellerActivityRoutes = require('./routes/seller_activity.routes');
const shopFollowsRoutes = require('./routes/shop_follows.routes');
const storesRoutes = require('./routes/stores.routes');
const refundsRoutes = require('./routes/refunds.routes');
const refundChatRoutes = require('./routes/refund_chat.routes');
const sellerRoutes = require('./routes/sellers.routes'); 
const cronRoutes = require('./routes/cron.routes'); // ← keep last
const couponsRoutes = require('./routes/coupons.routes');


// Mount routes — ORDER MATTERS
app.use('/api/auth', authRoutes);
app.use('/api/buyer', buyerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/webhooks/shipbubble', require('./routes/shipbubble_webhook.routes'));
app.use('/api/webhooks/sendbox', require('./routes/sendbox_webhook.routes'));
app.use('/api/checkout', deliveryRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/earnings', earningsRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/withdrawals', withdrawalRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/payment-methods', paymentMethodsRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/seller/products', sellerProductsRoutes);
app.use('/api/seller/orders', sellerOrdersRoutes);
app.use('/api/seller/activity', sellerActivityRoutes);
app.use('/api/seller/stores', storesRoutes);  // ← BEFORE /api/seller
app.use('/api/seller/shipping', vendorRoutes);
app.use('/api/refunds', refundsRoutes);
app.use('/api/refund-chat', refundChatRoutes);
app.use('/api/seller', sellerRoutes);           // ← AFTER /api/seller/stores
app.use('/api/shops/following', shopFollowsRoutes);
app.use('/api/cron', cronRoutes);
app.use('/api/coupons', couponsRoutes);



const { execFile } = require('child_process');
setInterval(() => {
  execFile('node', ['scripts/escrow_auto_release.js'], (err, stdout) => {
    if (err) console.error('Escrow cron error:', err.message);
    else console.log(stdout);
  });
}, 6 * 60 * 60 * 1000); // Every 6 hours

// Add after existing cron
const { processWithdrawal } = require('./services/payout.service');

setInterval(async () => {
  try {
    const due = await db.query(
      `SELECT id FROM withdrawals 
       WHERE status='pending' AND scheduled_for <= NOW()
       LIMIT 10`
    );
    for (const row of due.rows) {
      await processWithdrawal(row.id).catch(e =>
        console.error(`Withdrawal ${row.id} failed:`, e.message)
      );
    }
  } catch (e) { console.error('Withdrawal cron error:', e.message); }
}, 15 * 60 * 1000); // Every 15 min

// Auto-escalate refunds every 15 minutes (runs script)
setInterval(() => {
  execFile('node', ['scripts/auto_escalate_refunds.js'], (err, stdout) => {
    if (err) console.error('Refund auto-escalation cron error:', err.message);
    else if (stdout) console.log(stdout);
  });
}, 15 * 60 * 1000); // Every 15 minutes

const { notifySeller } = require('./utils/sellerEmailService');

// Weekly sales report — every Monday at 8am
setInterval(async () => {
  const now = new Date();
  if (now.getDay() !== 1 || now.getHours() !== 8) return;

  try {
    const sellers = await db.query(
      `SELECT DISTINCT seller_id FROM order_items 
       WHERE created_at >= NOW() - INTERVAL '7 days'`
    );
    for (const { seller_id } of sellers.rows) {
      const stats = await db.query(
        `SELECT COUNT(DISTINCT order_id) as orders,
                SUM(quantity * price_at_purchase) as revenue,
                (SELECT p.name FROM products p 
                 JOIN order_items oi2 ON oi2.product_id = p.id
                 WHERE oi2.seller_id = $1 AND oi2.created_at >= NOW() - INTERVAL '7 days'
                 GROUP BY p.id ORDER BY COUNT(*) DESC LIMIT 1) as top_product
         FROM order_items WHERE seller_id=$1 AND created_at >= NOW() - INTERVAL '7 days'`,
        [seller_id]
      );
      const s = stats.rows[0];
      const d = new Date();
      notifySeller(seller_id, 'weeklySalesReport', {
        totalOrders: s.orders,
        totalRevenue: s.revenue || 0,
        topProduct: s.top_product,
        weekStart: new Date(d - 7*864e5).toDateString(),
        weekEnd: d.toDateString()
      }).catch(() => {});
    }
  } catch (e) { console.error('Weekly report cron:', e.message); }
}, 60 * 60 * 1000); // check every hour

app.post('/api/waitlist', async (req, res) => {
  const { full_name, email, phone, role } = req.body;
  if (!full_name || !email) return res.status(400).json({ success: false, message: 'Name and email are required' });
  try {
    await db.query(
      `INSERT INTO waitlist (full_name, email, phone, role) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING`,
      [full_name, email, phone || null, role || 'buyer']
    );
    res.json({ success: true, message: 'Joined successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error joining waitlist' });
  }
});

// Development-only admin refund testing page
if (process.env.NODE_ENV !== 'production') {
  app.get('/admin-refund-testing', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-refund-testing.html'));
  });
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    message: 'Route not found'
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    status: 'error',
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Port configuration - Railway provides PORT via environment variable
const PORT = process.env.PORT || 5000;

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 MarketMix server listening on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 API available at: http://localhost:${PORT}/api`);
  console.log(`📊 Database: ${process.env.DATABASE_URL ? '✅ Connected' : '❌ Not configured'}`);
  console.log(`🔐 JWT: ${process.env.JWT_SECRET ? '✅ Configured' : '❌ Not configured'}`);
});

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('Shutting down gracefully...');
  await db.closePool();
  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
