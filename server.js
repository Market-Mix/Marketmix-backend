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
const sellerRoutes = require('./routes/seller.routes');
const adminRoutes = require('./routes/admin.routes');
const productRoutes = require('./routes/product.routes');
const cartRoutes = require('./routes/cart.routes');
const orderRoutes = require('./routes/order.routes');
const earningsRoutes = require('./routes/earnings.routes');
const withdrawalRoutes = require('./routes/withdrawal.routes');
const notificationRoutes = require('./routes/notification.routes');

// Mount routes
app.use('/api/auth', authRoutes);
app.use('/api/buyer', buyerRoutes);
app.use('/api/seller', sellerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/earnings', earningsRoutes);
app.use('/api/withdrawals', withdrawalRoutes);
app.use('/api/notifications', notificationRoutes);

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

// Port configuration
const PORT = process.env.PORT || 5000;

// Start server
app.listen(PORT, () => {
  console.log(`🚀 MarketMix server listening on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 API available at: http://localhost:${PORT}/api`);
});

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('Shutting down gracefully...');
  await db.closePool();
  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);