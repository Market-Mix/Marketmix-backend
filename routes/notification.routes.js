const express = require('express');
const router = express.Router();
const {
  createNotification,
  getNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  deleteAllNotifications
} = require('../controllers/notification.controller');
const { protect } = require('../middlewares/auth.middleware');

// IMPORTANT: More specific routes must come BEFORE parameterized routes

// Mark all notifications as read (MUST BE BEFORE /:notificationId/read)
router.put('/read-all', protect, markAllAsRead);

// Get all notifications for current user
router.get('/', protect, getNotifications);

// Create notification (admin/system)
router.post('/', protect, createNotification);

// Delete all notifications (MUST BE BEFORE /:notificationId)
router.delete('/', protect, deleteAllNotifications);

// Mark specific notification as read
router.put('/:notificationId/read', protect, markAsRead);

// Delete specific notification
router.delete('/:notificationId', protect, deleteNotification);

module.exports = router;