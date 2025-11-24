const express = require('express');
const router = express.Router();
const {
  register,
  login,
  getMe,
  updatePassword,
  logout
} = require('../controllers/auth.controller');
const { protect } = require('../middlewares/auth.middleware');

// Public routes
router.post('/register', register);
router.post('/login', login);

// Protected routes
router.get('/me', protect, getMe);
router.put('/password', protect, updatePassword);
router.post('/logout', protect, logout);

module.exports = router;