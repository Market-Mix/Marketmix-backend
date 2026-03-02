const express = require('express');
const router = express.Router();
const {
  register,
  googleRegister,
  googleLogin,
  login,
  getMe,
  updatePassword,
  updatePhone,
  logout,
  updateProfile,
  changePassword,
  updateAddress,
  updateNotificationPreferences,
  deleteAccount
} = require('../controllers/auth.controller');
const { protect } = require('../middlewares/auth.middleware');

// Public routes - Email/Password Authentication
router.post('/register', register);
router.post('/login', login);

// Public routes - Google OAuth Authentication
router.post('/google-register', googleRegister);
router.post('/google-login', googleLogin);

// OTP routes removed - email verification now handled via Supabase

// Protected routes
router.get('/me', protect, getMe);
router.put('/password', protect, updatePassword);
router.put('/update-phone', protect, updatePhone);
router.post('/logout', protect, logout);

// New Account Settings routes
router.put('/update-profile', protect, updateProfile);
router.put('/change-password', protect, changePassword);
router.put('/update-address', protect, updateAddress);
router.put('/notification-preferences', protect, updateNotificationPreferences);
router.delete('/delete-account', protect, deleteAccount);

module.exports = router;