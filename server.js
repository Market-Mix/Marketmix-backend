require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const corsOptions = require('./config/cors');
const db = require('./config/db');

// Create Express app
const app = express();

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors(corsOptions));

// Logging middleware
app.use(morgan(process.env.NODE_ENV === 'development' ? 'dev' : 'combined'));

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

// Import routes
const authRoutes = require('./routes/auth.routes');
const buyerRoutes = require('./routes/buyer.routes');
const sellerRoutes = require('./routes/sellers.routes');
const adminRoutes = require('./routes/admin.routes');
const productsRoutes = require('./routes/products.routes');
const cartRoutes = require('./routes/cart.routes');
const ordersRoutes = require('./routes/orders.routes');
const earningsRoutes = require('./routes/earnings.routes');
const reviewsRoutes = require('./routes/reviews.routes');
const categoryRoutes = require('./routes/category.routes');
const withdrawalRoutes = require('./routes/withdrawal.routes');
const notificationRoutes = require('./routes/notification.routes');
const paymentMethodsRoutes = require('./routes/paymentMethods.routes');
const wishlistRoutes = require('./routes/wishlist.routes');

// Mount routes
app.use('/api/auth', authRoutes);
app.use('/api/buyer', buyerRoutes);
app.use('/api/sellers', sellerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/earnings', earningsRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/withdrawals', withdrawalRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/payment-methods', paymentMethodsRoutes);
app.use('/api/wishlist', wishlistRoutes);


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