require('dotenv').config();
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


// Mount routes — ORDER MATTERS
app.use('/api/auth', authRoutes);
app.use('/api/buyer', buyerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/checkout', checkoutRoutes);
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
app.use('/api/seller/stores', storesRoutes);   // ← BEFORE /api/seller
app.use('/api/seller/shipping', vendorRoutes);
app.use('/api/refunds', refundsRoutes);
app.use('/api/refund-chat', refundChatRoutes);
app.use('/api/seller', sellerRoutes);           // ← AFTER /api/seller/stores
app.use('/api/shops/following', shopFollowsRoutes);
app.use('/api/cron', cronRoutes);



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
