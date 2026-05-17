const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

let notificationHasLinkColumnCache = null;

async function notificationHasLinkColumn() {
  if (notificationHasLinkColumnCache !== null) {
    return notificationHasLinkColumnCache;
  }

  const query = `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'notifications' AND column_name = 'link'
  `;

  const result = await db.query(query);
  notificationHasLinkColumnCache = result.rows.length > 0;
  return notificationHasLinkColumnCache;
}

/**
 * @desc    Create a notification for a user
 * @route   POST /api/notifications
 * @access  Private (Admin/System)
 *
 * Body: { user_id, title, message, type, link }
 */
    const createNotification = async (req, res) => {
  try {
    const { user_id, title, message, type = 'info', link } = req.body;

    console.log('📩 createNotification request body:', req.body);

    if (!user_id || !title || !message) {
      return sendError(res, 400, 'Please provide user_id, title, and message');
    }

    const userResult = await db.query(
      'SELECT id FROM users WHERE id = $1',
      [user_id]
    );

    if (userResult.rows.length === 0) {
      return sendError(res, 404, 'User not found');
    }

    const hasLink = await notificationHasLinkColumn();

    let insertQuery;
    let params;

    if (hasLink) {
      insertQuery = `
        INSERT INTO notifications (user_id, title, message, type, link, is_read, is_deleted, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, FALSE, FALSE, NOW(), NOW())
        RETURNING id, user_id, title, message, type, is_read, link, created_at, updated_at, is_deleted
      `;
      params = [user_id, title, message, type, link || null];
    } else {
      insertQuery = `
        INSERT INTO notifications (user_id, title, message, type, data, is_read, is_deleted, created_at, updated_at)
        VALUES ($1, $2, $3, $4, jsonb_build_object('link', $5), FALSE, FALSE, NOW(), NOW())
        RETURNING id, user_id, title, message, type, is_read, data->>'link' AS link, created_at, updated_at, is_deleted
      `;
      params = [user_id, title, message, type, link || null];
    }

    const result = await db.query(insertQuery, params);
    const notification = result.rows[0];

    console.log('✅ Notification inserted:', notification);

    return sendSuccess(res, 201, 'Notification created successfully', {
      notification: {
        id: notification.id,
        userId: notification.user_id,
        title: notification.title,
        message: notification.message,
        type: notification.type,
        isRead: notification.is_read,
        link: notification.link || null,
        createdAt: notification.created_at,
        updatedAt: notification.updated_at,
        isDeleted: notification.is_deleted
      }
    });

  } catch (error) {
    console.error('Create notification error:', error);
    return sendError(res, 500, 'Error creating notification', error);
  }
};

/**
 * @desc    Get all notifications for current user
 * @route   GET /api/notifications
 * @access  Private
 * @query   unread (boolean) - filter only unread notifications
 */
const getNotifications = async (req, res) => {
  try {
    const user_id = req.user.id;
    const { unread } = req.query;

    const hasLink = await notificationHasLinkColumn();
    const linkSelect = hasLink ? 'link' : `data->>'link' AS link`;

    let query = `
      SELECT id, user_id, title, message, type, ${linkSelect}, is_read, created_at, updated_at
      FROM notifications
      WHERE user_id = $1 AND is_deleted = FALSE
    `;

    let params = [user_id];

    // Filter by unread if requested
    if (unread === 'true' || unread === '1') {
      query += ' AND is_read = FALSE';
    }

    query += ' ORDER BY created_at DESC LIMIT 50';

    const result = await db.query(query, params);

    const notifications = result.rows.map(notif => ({
      id: notif.id,
      userId: notif.user_id,
      title: notif.title,
      message: notif.message,
      type: notif.type,
      link: notif.link,
      isRead: notif.is_read,
      createdAt: notif.created_at,
      updatedAt: notif.updated_at
    }));

    // Count unread
    const unreadResult = await db.query(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND is_deleted = FALSE AND is_read = FALSE',
      [user_id]
    );

    const unreadCount = parseInt(unreadResult.rows[0].count, 10);

    return sendSuccess(res, 200, 'Notifications retrieved successfully', {
      notifications,
      totalCount: notifications.length,
      unreadCount
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    return sendError(res, 500, 'Error retrieving notifications', error);
  }
};

/**
 * @desc    Mark notification as read
 * @route   PUT /api/notifications/:notificationId/read
 * @access  Private
 */
const markAsRead = async (req, res) => {
  try {
    const { notificationId } = req.params;
    const user_id = req.user.id;

    // Check if notification exists and belongs to user
    const notifResult = await db.query(
      'SELECT id FROM notifications WHERE id = $1 AND user_id = $2',
      [notificationId, user_id]
    );

    if (notifResult.rows.length === 0) {
      return sendError(res, 404, 'Notification not found');
    }

    // Update notification
    const result = await db.query(
      `UPDATE notifications 
       SET is_read = TRUE, updated_at = NOW()
       WHERE id = $1
       RETURNING id, is_read, updated_at`,
      [notificationId]
    );

    const notification = result.rows[0];

    return sendSuccess(res, 200, 'Notification marked as read', {
      notification: {
        id: notification.id,
        isRead: notification.is_read,
        updatedAt: notification.updated_at
      }
    });
  } catch (error) {
    console.error('Mark as read error:', error);
    return sendError(res, 500, 'Error marking notification as read', error);
  }
};

/**
 * @desc    Mark all notifications as read
 * @route   PUT /api/notifications/read-all
 * @access  Private
 */
const markAllAsRead = async (req, res) => {
  try {
    const user_id = req.user.id;

    // Update all unread notifications for user
    const result = await db.query(
      `UPDATE notifications 
       SET is_read = TRUE, updated_at = NOW()
       WHERE user_id = $1 AND is_read = FALSE AND is_deleted = FALSE
       RETURNING id`,
      [user_id]
    );

    const updatedCount = result.rows.length;

    return sendSuccess(res, 200, 'All notifications marked as read', {
      updatedCount
    });
  } catch (error) {
    console.error('Mark all as read error:', error);
    return sendError(res, 500, 'Error marking all notifications as read', error);
  }
};

/**
 * @desc    Delete a notification (soft delete)
 * @route   DELETE /api/notifications/:notificationId
 * @access  Private
 */
const deleteNotification = async (req, res) => {
  try {
    const { notificationId } = req.params;
    const user_id = req.user.id;

    // Check if notification exists and belongs to user
    const notifResult = await db.query(
      'SELECT id FROM notifications WHERE id = $1 AND user_id = $2',
      [notificationId, user_id]
    );

    if (notifResult.rows.length === 0) {
      return sendError(res, 404, 'Notification not found');
    }

    // Soft delete notification
    await db.query(
      `UPDATE notifications 
       SET is_deleted = TRUE, updated_at = NOW()
       WHERE id = $1`,
      [notificationId]
    );

    return sendSuccess(res, 200, 'Notification deleted successfully');
  } catch (error) {
    console.error('Delete notification error:', error);
    return sendError(res, 500, 'Error deleting notification', error);
  }
};

/**
 * @desc    Delete all notifications for user (soft delete)
 * @route   DELETE /api/notifications
 * @access  Private
 */
const deleteAllNotifications = async (req, res) => {
  try {
    const user_id = req.user.id;

    // Soft delete all notifications for user
    const result = await db.query(
      `UPDATE notifications 
       SET is_deleted = TRUE, updated_at = NOW()
       WHERE user_id = $1 AND is_deleted = FALSE
       RETURNING id`,
      [user_id]
    );

    const deletedCount = result.rows.length;

    return sendSuccess(res, 200, 'All notifications deleted successfully', {
      deletedCount
    });
  } catch (error) {
    console.error('Delete all notifications error:', error);
    return sendError(res, 500, 'Error deleting all notifications', error);
  }
};

module.exports = {
  createNotification,
  getNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  deleteAllNotifications
};