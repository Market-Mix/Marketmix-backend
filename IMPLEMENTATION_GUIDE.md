# User Notifications & Guest Cart Sync Implementation

## Overview
This document describes the implementation of two major features:
1. **User Notifications System** - Allows users to receive and manage notifications
2. **Guest Cart Sync on Logout** - Persists guest cart data across sessions

---

## 1. User Notifications System

### Database Schema
A `notifications` table has been created with the following structure:
```sql
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'info',
  data JSONB DEFAULT NULL,
  is_read BOOLEAN DEFAULT false,
  is_deleted BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Indexes:**
- `idx_notifications_user_id` - For fast user lookups
- `idx_notifications_user_read` - For filtering unread notifications

### Backend Implementation

#### Notification Controller (`controllers/notification.controller.js`)
Provides the following functions:

1. **createNotification(req, res)**
   - Creates a new notification for a user
   - POST `/api/notifications`
   - Body: `{ user_id, title, message, type?, data? }`
   - Returns: Created notification object

2. **getNotifications(req, res)**
   - Fetches all notifications for current user
   - GET `/api/notifications?unread=true` (optional filter)
   - Returns: Array of notifications + unreadCount

3. **markAsRead(req, res)**
   - Marks a specific notification as read
   - PUT `/api/notifications/:notificationId/read`
   - Returns: Updated notification

4. **markAllAsRead(req, res)**
   - Marks all notifications as read
   - PUT `/api/notifications/read-all`
   - Returns: Count of updated notifications

5. **deleteNotification(req, res)**
   - Soft deletes a notification
   - DELETE `/api/notifications/:notificationId`
   - Returns: Success message

6. **deleteAllNotifications(req, res)**
   - Soft deletes all notifications for user
   - DELETE `/api/notifications`
   - Returns: Count of deleted notifications

#### Notification Routes (`routes/notification.routes.js`)
All routes are protected with authentication middleware:
```javascript
GET    /api/notifications              - Get user notifications
POST   /api/notifications              - Create notification (admin/system)
PUT    /api/notifications/:id/read     - Mark as read
PUT    /api/notifications/read-all     - Mark all as read
DELETE /api/notifications/:id          - Delete notification
DELETE /api/notifications              - Delete all notifications
```

### Frontend Implementation

#### Notifications Module (`utils/notifications.js`)
JavaScript utility functions for notification management:

- **getNotifications(unreadOnly?): Promise**
  - Fetches notifications from API
  - Returns: `{ notifications, unreadCount }`

- **markNotificationAsRead(notificationId): Promise<boolean>**
  - Marks single notification as read

- **markAllNotificationsAsRead(): Promise<boolean>**
  - Marks all notifications as read

- **deleteNotification(notificationId): Promise<boolean>**
  - Deletes a notification

- **deleteAllNotifications(): Promise<boolean>**
  - Deletes all notifications

- **showNotification(message, type?, duration?): void**
  - Shows toast/alert notification to user
  - Types: 'success', 'error', 'info', 'warning'
  - Works with Toastr or custom toast library

- **loadNotificationsUI(): Promise<void>**
  - Auto-loads notifications and updates UI
  - Updates notification bell badge with count

- **showNotificationsDropdown(notifications): void**
  - Renders dropdown with notification list

### Usage Example

#### Backend - Creating Notifications
```javascript
// In an order confirmation handler
const db = require('../config/db');
const { createNotification } = require('../controllers/notification.controller');

await db.query(
  `INSERT INTO notifications (user_id, title, message, type, data)
   VALUES ($1, $2, $3, $4, $5)`,
  [
    buyerId,
    'Order Confirmed',
    `Your order #${orderId} has been confirmed`,
    'success',
    JSON.stringify({ orderId, amount: 99.99 })
  ]
);
```

#### Frontend - Displaying Notifications
```html
<!-- Include the notifications module -->
<script src="/utils/notifications.js"></script>

<!-- Notification bell in header -->
<div id="notificationBell" class="notification-bell">
  🔔
  <span class="notification-badge" style="display:none">0</span>
</div>

<div id="notificationsDropdown" class="notifications-dropdown"></div>

<script>
  // Load notifications when page loads
  document.addEventListener('DOMContentLoaded', () => {
    loadNotificationsUI();
    
    // Refresh every 30 seconds
    setInterval(loadNotificationsUI, 30000);
  });

  // Show notifications on events
  showNotification('Order shipped!', 'success', 3000);
</script>
```

### Notification Types
- **'info'** - General information
- **'success'** - Successful action
- **'warning'** - Warning message
- **'error'** - Error message
- **'order'** - Order related
- **'payment'** - Payment related
- **'delivery'** - Delivery related

---

## 2. Guest Cart Sync on Logout

### Overview
This feature allows guest users to:
1. Add items to cart without logging in (stored in localStorage)
2. Persist cart when logging out
3. Resume shopping in next session
4. Merge cart when logging back in

### Implementation Strategy

#### Backend - Updated Logout Endpoint
**File:** `controllers/auth.controller.js`

The logout endpoint now accepts optional cart items:
```javascript
POST /api/auth/logout
Body: {
  cartItems: [
    { product_id, quantity, name, image, price },
    ...
  ]
}

Response: {
  status: 'success',
  data: {
    message: 'Your cart has been saved locally...',
    cartItemsSaved: 2
  }
}
```

#### Frontend - Guest Cart Module
**File:** `utils/guestCartSync.js`

Provides complete cart persistence functionality:

**Storage Functions:**
- `getGuestCart(): Array` - Retrieve cart from localStorage
- `saveGuestCart(items): void` - Save cart to localStorage
- `clearGuestCart(): void` - Clear cart from localStorage

**Cart Manipulation:**
- `addToGuestCart(item): Array` - Add item to guest cart
- `removeFromGuestCart(productId): Array` - Remove item
- `updateGuestCartItem(productId, quantity): Array` - Update quantity

**Sync Functions:**
- `persistCartOnLogout(): Promise` - Called on logout
- `syncGuestCartOnLogin(token): Promise` - Called after login
- `handleLogoutWithCartPersistence(): Promise` - Complete logout flow

### Data Flow

#### Adding Items as Guest
```
User browsing → Add to cart → Stored in localStorage
                                ↓
                    guestCart = [
                      { product_id, quantity, name, price, image },
                      ...
                    ]
```

#### On Login
```
User clicks Login → Authenticate → Token returned
                                     ↓
                        syncGuestCartOnLogin(token)
                                     ↓
                    POST /api/cart/merge with localStorage cart
                                     ↓
                        Server validates & merges items
                                     ↓
                    clearGuestCart() - Remove from localStorage
```

#### On Logout
```
User clicks Logout → persistCartOnLogout()
                                     ↓
                    Save current cart to localStorage
                                     ↓
                    POST /api/auth/logout with cartItems
                                     ↓
                    Clear authentication token
                                     ↓
                    localStorage.guestCart still available
                    for next session
```

### Usage Example

#### Frontend - HTML
```html
<!-- Include the guest cart sync module -->
<script src="/utils/guestCartSync.js"></script>

<!-- Add to cart button (for guests) -->
<button onclick="addToGuestCart({
  product_id: '123',
  quantity: 1,
  name: 'Product Name',
  price: 99.99,
  image: 'img.jpg'
})">
  Add to Cart
</button>

<!-- Logout button -->
<button onclick="handleLogoutWithCartPersistence(); redirect('/login')">
  Logout
</button>
```

#### Frontend - JavaScript Integration
```javascript
// On page load, auto-sync if user is logged in with saved cart
document.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem('token');
  const guestCart = getGuestCart();

  if (token && guestCart.length > 0) {
    // User logged in and has saved cart - sync it
    syncGuestCartOnLogin(token);
  }
});

// On login success
async function onLoginSuccess(token) {
  localStorage.setItem('token', token);
  
  // Check for saved guest cart and sync
  if (getGuestCart().length > 0) {
    const result = await syncGuestCartOnLogin(token);
    
    if (result.adjustments.length > 0) {
      showNotification(
        'Some items were adjusted due to stock limits',
        'warning',
        5000
      );
    }
  }
}

// On logout
async function onLogout() {
  const cartItems = getCurrentCartItems();
  
  // Persist cart before logout
  await persistCartOnLogout();
  
  // Call logout API
  const token = localStorage.getItem('token');
  await fetch('/api/auth/logout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ cartItems })
  });
  
  // Clear auth
  localStorage.removeItem('token');
  redirect('/login');
}
```

### Features

✅ **Guest Cart Persistence**
- Items stored in browser localStorage
- Survives browser refresh and close

✅ **Smart Cart Merge**
- Transactional merge with FOR UPDATE locks
- Stock limit validation
- Adjusts quantities if stock unavailable

✅ **Session Continuity**
- Cart persists across login/logout cycles
- No data loss on browser refresh
- Auto-sync on next login

✅ **User Feedback**
- Notifications on merge completion
- Warnings for stock adjustments
- Success/error messages

✅ **Stock Awareness**
- Validates product availability during merge
- Caps quantities to available stock
- Reports adjustments to user

### Storage Structure
```javascript
// localStorage.guestCart
[
  {
    product_id: "uuid-string",
    quantity: 2,
    name: "Product Name",
    price: 99.99,
    image: "image-url.jpg"
  },
  // ... more items
]
```

---

## Testing

### Test Notification System
```bash
node test_notifications.js
```
Tests:
- Create notification
- Get notifications
- Mark as read
- Delete notification
- Database verification

### Test Guest Cart Sync
```bash
node test_guest_cart_sync.js
```
Tests:
- Guest cart simulation
- Complete flow walkthrough
- Persistence scenarios
- Logout behavior

---

## API Endpoints Summary

### Notifications
```
GET    /api/notifications              - Get user notifications
POST   /api/notifications              - Create notification
PUT    /api/notifications/:id/read     - Mark as read
PUT    /api/notifications/read-all     - Mark all as read
DELETE /api/notifications/:id          - Delete notification
DELETE /api/notifications              - Delete all notifications
```

### Auth (Updated)
```
POST   /api/auth/logout                - Logout with optional cart persistence
```

### Cart (Existing)
```
POST   /api/cart/merge                 - Merge guest cart into authenticated cart
```

---

## Error Handling

### Notification Errors
- 400: Missing required fields
- 404: Notification/User not found
- 500: Server error (gracefully handled)

### Cart Sync Errors
- 400: Invalid cart items format
- 401: Unauthorized (no valid token)
- 409: Stock conflict (handled with adjustments)
- 500: Server error

All errors return appropriate HTTP status codes and user-friendly messages.

---

## Security Considerations

✅ **Authentication Required**
- All notification endpoints require valid JWT token
- Cart merge validates user ownership

✅ **Data Privacy**
- Users can only access their own notifications
- Soft deletes preserve audit trail

✅ **Stock Validation**
- Products locked during merge (FOR UPDATE)
- Stock limits enforced
- Prevents overselling

✅ **localStorage Safety**
- Guest cart stored locally (not exposed)
- Merged into server cart after authentication
- Cleared after successful merge

---

## Future Enhancements

- [ ] Real-time notifications via WebSocket
- [ ] Email notification preferences
- [ ] Push notifications support
- [ ] Notification scheduling
- [ ] Bulk notification creation
- [ ] Notification analytics/reporting
- [ ] Guest cart expiration (after X days)
- [ ] Cart sync dry-run mode (preview before merge)

---

## Troubleshooting

**Issue:** Notifications not appearing
- Check: User is authenticated
- Check: Notifications table exists in database
- Check: Authentication middleware is applied

**Issue:** Cart items not syncing on login
- Check: Token is valid and present
- Check: localStorage has guestCart data
- Check: API endpoint is accessible

**Issue:** Stock conflicts during merge
- Expected: Items adjusted to available quantity
- Solution: Show user the adjustments and ask for confirmation

---

## Database Setup

To create the notifications table in Supabase:

```sql
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'info',
  data JSONB DEFAULT NULL,
  is_read BOOLEAN DEFAULT false,
  is_deleted BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_user_read ON notifications(user_id, is_read);
```

Or run the creation script:
```bash
node scripts/create_notifications_table.js
```

---

**Last Updated:** December 2, 2025
**Version:** 1.0.0
**Status:** ✅ Complete & Ready for Testing
