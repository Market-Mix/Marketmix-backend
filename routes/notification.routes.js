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

// Get all notifications for current user
router.get('/', protect, getNotifications);

// Create notification (admin/system)
router.post('/', protect, createNotification);

// Mark specific notification as read
router.put('/:notificationId/read', protect, markAsRead);

// Mark all notifications as read
router.put('/read-all', protect, markAllAsRead);

// Delete specific notification
router.delete('/:notificationId', protect, deleteNotification);

// Delete all notifications
router.delete('/', protect, deleteAllNotifications);

module.exports = router;
