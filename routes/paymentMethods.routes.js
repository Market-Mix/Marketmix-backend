// ============================================
// FILE 2: routes/paymentMethods.js
// ============================================
const express = require('express');
const router = express.Router();
const paymentMethodsController = require('../controllers/paymentMethods.controller');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Authentication middleware
// If you already have an auth middleware file, replace this with:
// const authenticate = require('../middleware/auth');
const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ 
        success: false,
        error: 'No token provided' 
      });
    }

    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ 
        success: false,
        error: 'Invalid or expired token' 
      });
    }

    req.user = user;
    req.token = token;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ 
      success: false,
      error: 'Authentication failed' 
    });
  }
};

// Apply authentication middleware to all routes
router.use(authenticate);

// Routes
router.get('/', paymentMethodsController.getAllPaymentMethods);
router.get('/default', paymentMethodsController.getDefaultPaymentMethod);
router.get('/:id', paymentMethodsController.getPaymentMethodById);
router.post('/', paymentMethodsController.createPaymentMethod);
router.put('/:id', paymentMethodsController.updatePaymentMethod);
router.put('/:id/set-default', paymentMethodsController.setDefaultPaymentMethod);
router.delete('/:id', paymentMethodsController.deletePaymentMethod);

module.exports = router;

