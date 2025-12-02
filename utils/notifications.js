/**
 * Notifications Module
 * Handles all notification-related operations
 */

const API_BASE_URL = window.API_BASE_URL || 'http://localhost:5000/api';

/**
 * Fetch all notifications for current user
 * @param {boolean} unreadOnly - Only fetch unread notifications
 * @returns {Promise<Object>} Notifications data
 */
async function getNotifications(unreadOnly = false) {
  try {
    const token = localStorage.getItem('token');
    if (!token) {
      console.warn('No token found for notifications');
      return { notifications: [], unreadCount: 0 };
    }

    const url = `${API_BASE_URL}/notifications${unreadOnly ? '?unread=true' : ''}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      console.error(`Failed to fetch notifications: ${response.status}`);
      return { notifications: [], unreadCount: 0 };
    }

    const data = await response.json();
    return data.data || { notifications: [], unreadCount: 0 };
  } catch (error) {
    console.error('Error fetching notifications:', error);
    return { notifications: [], unreadCount: 0 };
  }
}

/**
 * Mark a notification as read
 * @param {string} notificationId - The notification ID
 * @returns {Promise<boolean>} Success status
 */
async function markNotificationAsRead(notificationId) {
  try {
    const token = localStorage.getItem('token');
    if (!token) return false;

    const response = await fetch(`${API_BASE_URL}/notifications/${notificationId}/read`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });

    return response.ok;
  } catch (error) {
    console.error('Error marking notification as read:', error);
    return false;
  }
}

/**
 * Mark all notifications as read
 * @returns {Promise<boolean>} Success status
 */
async function markAllNotificationsAsRead() {
  try {
    const token = localStorage.getItem('token');
    if (!token) return false;

    const response = await fetch(`${API_BASE_URL}/notifications/read-all`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });

    return response.ok;
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    return false;
  }
}

/**
 * Delete a notification
 * @param {string} notificationId - The notification ID
 * @returns {Promise<boolean>} Success status
 */
async function deleteNotification(notificationId) {
  try {
    const token = localStorage.getItem('token');
    if (!token) return false;

    const response = await fetch(`${API_BASE_URL}/notifications/${notificationId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });

    return response.ok;
  } catch (error) {
    console.error('Error deleting notification:', error);
    return false;
  }
}

/**
 * Delete all notifications
 * @returns {Promise<boolean>} Success status
 */
async function deleteAllNotifications() {
  try {
    const token = localStorage.getItem('token');
    if (!token) return false;

    const response = await fetch(`${API_BASE_URL}/notifications`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });

    return response.ok;
  } catch (error) {
    console.error('Error deleting all notifications:', error);
    return false;
  }
}

/**
 * Show notification UI (toast/alert)
 * @param {string} message - The message to show
 * @param {string} type - Type: 'success', 'error', 'info', 'warning'
 * @param {number} duration - Duration in ms
 */
function showNotification(message, type = 'info', duration = 4000) {
  // Check if toast library is available (e.g., Toastr or custom)
  if (typeof showToast === 'function') {
    showToast(message, type);
  } else if (typeof toastr !== 'undefined') {
    toastr[type](message);
  } else {
    // Fallback to alert
    console.log(`[${type.toUpperCase()}] ${message}`);
  }
}

/**
 * Load and display notifications UI
 * Renders notification bell with count and dropdown
 */
async function loadNotificationsUI() {
  try {
    const { notifications, unreadCount } = await getNotifications();

    // Update notification bell
    const notificationBell = document.getElementById('notificationBell');
    if (notificationBell) {
      const badgeElement = notificationBell.querySelector('.notification-badge');
      if (badgeElement) {
        if (unreadCount > 0) {
          badgeElement.textContent = unreadCount > 99 ? '99+' : unreadCount;
          badgeElement.style.display = 'flex';
        } else {
          badgeElement.style.display = 'none';
        }
      }

      // Attach click handler to show dropdown
      notificationBell.addEventListener('click', () => showNotificationsDropdown(notifications));
    }
  } catch (error) {
    console.error('Error loading notifications UI:', error);
  }
}

/**
 * Show notifications dropdown
 * @param {Array} notifications - Array of notification objects
 */
function showNotificationsDropdown(notifications) {
  const dropdown = document.getElementById('notificationsDropdown') || createNotificationsDropdown();
  
  if (notifications.length === 0) {
    dropdown.innerHTML = '<div class="notification-item empty">No notifications</div>';
  } else {
    dropdown.innerHTML = notifications.map(notif => `
      <div class="notification-item ${notif.isRead ? 'read' : 'unread'}" data-id="${notif.id}">
        <div class="notification-content">
          <h4>${notif.title}</h4>
          <p>${notif.message}</p>
          <small>${formatDate(notif.createdAt)}</small>
        </div>
        <button class="notification-delete" onclick="deleteNotification('${notif.id}')">✕</button>
      </div>
    `).join('');
  }

  dropdown.style.display = 'block';

  // Add click handlers for marking as read
  dropdown.querySelectorAll('.notification-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      if (!e.target.closest('.notification-delete')) {
        const id = item.dataset.id;
        await markNotificationAsRead(id);
        item.classList.add('read');
      }
    });
  });
}

/**
 * Create notifications dropdown if not exists
 */
function createNotificationsDropdown() {
  const dropdown = document.createElement('div');
  dropdown.id = 'notificationsDropdown';
  dropdown.className = 'notifications-dropdown';
  document.body.appendChild(dropdown);
  return dropdown;
}

/**
 * Format date for display
 * @param {string} dateString - ISO date string
 */
function formatDate(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now - date;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return date.toLocaleDateString();
}

// Export functions if using ES6 modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getNotifications,
    markNotificationAsRead,
    markAllNotificationsAsRead,
    deleteNotification,
    deleteAllNotifications,
    showNotification,
    loadNotificationsUI,
    showNotificationsDropdown
  };
}
