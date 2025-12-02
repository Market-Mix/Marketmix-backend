const db = require('../config/db');

/**
 * Test notification API endpoints
 * Run with: node test_notifications.js
 */

const API_BASE_URL = 'http://localhost:5000/api';
let testToken = null;
let testUserId = null;
let testNotificationId = null;

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

const log = {
  success: (msg) => console.log(`${colors.green}✅ ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}❌ ${msg}${colors.reset}`),
  info: (msg) => console.log(`${colors.cyan}ℹ️  ${msg}${colors.reset}`),
  test: (msg) => console.log(`${colors.blue}🧪 ${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}⚠️  ${msg}${colors.reset}`)
};

/**
 * Get an existing user or create one for testing
 */
async function getTestUser() {
  try {
    log.test('Getting test user...');
    
    const result = await db.query(
      'SELECT id, email FROM users WHERE role = $1 AND is_deleted = FALSE LIMIT 1',
      ['buyer']
    );

    if (result.rows.length > 0) {
      testUserId = result.rows[0].id;
      log.success(`Found test user: ${result.rows[0].email}`);
      return testUserId;
    }

    // Create a test user if none exists
    log.info('No buyer user found, would need to create one via API');
    return null;
  } catch (error) {
    log.error(`Error getting test user: ${error.message}`);
    return null;
  }
}

/**
 * Simulate login to get token
 */
async function loginTestUser() {
  try {
    log.test('Attempting to get test token...');
    
    // Try to get a user email first
    const result = await db.query(
      'SELECT email FROM users WHERE role = $1 AND is_deleted = FALSE LIMIT 1',
      ['buyer']
    );

    if (result.rows.length === 0) {
      log.warn('No test user available for login');
      return false;
    }

    const email = result.rows[0].email;
    log.info(`Using test user email: ${email}`);
    
    // In a real scenario, you'd call the login API
    // For this test, we'll generate a JWT directly
    const jwt = require('../utils/jwt');
    const userResult = await db.query(
      'SELECT id, role FROM users WHERE email = $1',
      [email]
    );

    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      testToken = jwt.generateToken({
        id: user.id,
        email: email,
        role: user.role
      });
      testUserId = user.id;
      log.success(`Generated test token for user: ${user.id}`);
      return true;
    }

    return false;
  } catch (error) {
    log.error(`Error logging in test user: ${error.message}`);
    return false;
  }
}

/**
 * Test: Create Notification
 */
async function testCreateNotification() {
  try {
    log.test('Testing CREATE notification...');

    if (!testToken || !testUserId) {
      log.warn('Skipping - no token or user ID');
      return false;
    }

    const response = await fetch(`${API_BASE_URL}/notifications`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testToken}`
      },
      body: JSON.stringify({
        user_id: testUserId,
        title: 'Order Confirmation',
        message: 'Your order #12345 has been confirmed and will be shipped soon.',
        type: 'success',
        data: { orderId: '12345', amount: 99.99 }
      })
    });

    if (!response.ok) {
      log.error(`Create notification failed: ${response.status}`);
      return false;
    }

    const data = await response.json();
    if (data.data && data.data.notification) {
      testNotificationId = data.data.notification.id;
      log.success(`Notification created: ${testNotificationId}`);
      return true;
    }

    log.error('Invalid response format');
    return false;
  } catch (error) {
    log.error(`Error creating notification: ${error.message}`);
    return false;
  }
}

/**
 * Test: Get Notifications
 */
async function testGetNotifications() {
  try {
    log.test('Testing GET notifications...');

    if (!testToken) {
      log.warn('Skipping - no token');
      return false;
    }

    const response = await fetch(`${API_BASE_URL}/notifications`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testToken}`
      }
    });

    if (!response.ok) {
      log.error(`Get notifications failed: ${response.status}`);
      return false;
    }

    const data = await response.json();
    const { notifications = [], unreadCount = 0 } = data.data || {};

    log.success(`Retrieved ${notifications.length} notifications (${unreadCount} unread)`);
    
    if (notifications.length > 0) {
      log.info(`Sample notification: "${notifications[0].title}"`);
    }

    return true;
  } catch (error) {
    log.error(`Error getting notifications: ${error.message}`);
    return false;
  }
}

/**
 * Test: Mark as Read
 */
async function testMarkAsRead() {
  try {
    log.test('Testing MARK AS READ...');

    if (!testToken || !testNotificationId) {
      log.warn('Skipping - no token or notification ID');
      return false;
    }

    const response = await fetch(`${API_BASE_URL}/notifications/${testNotificationId}/read`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testToken}`
      }
    });

    if (!response.ok) {
      log.error(`Mark as read failed: ${response.status}`);
      return false;
    }

    log.success(`Notification marked as read: ${testNotificationId}`);
    return true;
  } catch (error) {
    log.error(`Error marking notification as read: ${error.message}`);
    return false;
  }
}

/**
 * Test: Delete Notification
 */
async function testDeleteNotification() {
  try {
    log.test('Testing DELETE notification...');

    if (!testToken || !testNotificationId) {
      log.warn('Skipping - no token or notification ID');
      return false;
    }

    const response = await fetch(`${API_BASE_URL}/notifications/${testNotificationId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testToken}`
      }
    });

    if (!response.ok) {
      log.error(`Delete notification failed: ${response.status}`);
      return false;
    }

    log.success(`Notification deleted: ${testNotificationId}`);
    return true;
  } catch (error) {
    log.error(`Error deleting notification: ${error.message}`);
    return false;
  }
}

/**
 * Test: Verify notifications in database
 */
async function testVerifyInDatabase() {
  try {
    log.test('Verifying notifications in database...');

    const result = await db.query(
      `SELECT COUNT(*) as count FROM notifications 
       WHERE user_id = $1 AND is_deleted = FALSE`,
      [testUserId]
    );

    const count = parseInt(result.rows[0].count, 10);
    log.success(`Found ${count} active notifications in database`);
    return true;
  } catch (error) {
    log.error(`Error verifying notifications: ${error.message}`);
    return false;
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  log.info('========== NOTIFICATION SYSTEM TESTS ==========\n');

  // Setup
  const hasUser = await getTestUser();
  if (!hasUser) {
    log.warn('No test user available - creating limited tests');
  }

  const loggedIn = await loginTestUser();
  if (!loggedIn) {
    log.error('Could not login test user - skipping API tests');
    return;
  }

  // Run tests
  const results = [];
  results.push(['Create Notification', await testCreateNotification()]);
  results.push(['Get Notifications', await testGetNotifications()]);
  results.push(['Mark as Read', await testMarkAsRead()]);
  results.push(['Delete Notification', await testDeleteNotification()]);
  results.push(['Verify in Database', await testVerifyInDatabase()]);

  // Summary
  log.info('\n========== TEST SUMMARY ==========');
  results.forEach(([name, passed]) => {
    const status = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`${status}: ${name}`);
  });

  const passCount = results.filter(r => r[1]).length;
  log.info(`\nTotal: ${passCount}/${results.length} tests passed\n`);

  process.exit(passCount === results.length ? 0 : 1);
}

// Run tests
runAllTests().catch(error => {
  log.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
