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
const authMiddleware = require('../middlewares/auth.middleware');

// Get all notifications for current user
router.get('/', authMiddleware, getNotifications);

// Create notification (admin/system)
router.post('/', authMiddleware, createNotification);

// Mark specific notification as read
router.put('/:notificationId/read', authMiddleware, markAsRead);

// Mark all notifications as read
router.put('/read-all', authMiddleware, markAllAsRead);

// Delete specific notification
router.delete('/:notificationId', authMiddleware, deleteNotification);

// Delete all notifications
router.delete('/', authMiddleware, deleteAllNotifications);

module.exports = router;
