const express = require('express');
const router = express.Router();
const {
  register,
  googleRegister,
  googleLogin,
  login,
  getMe,
  updatePassword,
  changePassword,
  updateProfile,
  updatePassword,
  updatePhone,
  updateAddress,
  updateNotificationPreferences,
  deleteAccount,
  logout
} = require('../controllers/auth.controller');
const { protect } = require('../middlewares/auth.middleware');

// Public routes - Email/Password Authentication
router.post('/register', register);
router.post('/login', login);

// Public routes - Google OAuth Authentication
router.post('/google-register', googleRegister);
router.post('/google-login', googleLogin);

// Protected routes
router.get('/me', protect, getMe);
router.put('/change-password', protect, changePassword);
router.put('/password', protect, updatePassword);
router.put('/update-profile', protect, updateProfile);
router.put('/update-phone', protect, updatePhone);
router.put('/update-address', protect, updateAddress);
router.put('/notification-preferences', protect, updateNotificationPreferences);
router.post('/logout', protect, logout);
router.delete('/delete-account', protect, deleteAccount);

module.exports = router;