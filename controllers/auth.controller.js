const bcrypt = require('bcrypt');
const db = require('../config/db');
const { generateToken } = require('../utils/jwt');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * @desc    Register new user
 * @route   POST /api/auth/register
 * @access  Public
 */
const register = async (req, res) => {
  try {
    const { email, password, firstName, lastName, fullName, phone, role } = req.body;

    // Handle both fullName and firstName/lastName formats
    let first_name, last_name;
    
    if (fullName) {
      // Split fullName into first and last name
      const nameParts = fullName.trim().split(' ');
      first_name = nameParts[0];
      last_name = nameParts.slice(1).join(' ') || nameParts[0]; // Use first name as last name if only one word
    } else {
      first_name = firstName;
      last_name = lastName;
    }

    // Validate required fields
    if (!email || !password || !first_name) {
      return sendError(res, 400, 'Please provide email, password, and name');
    }

    // Validate role
    const validRoles = ['buyer', 'seller'];
    if (role && !validRoles.includes(role)) {
      return sendError(res, 400, 'Invalid role. Must be either buyer or seller');
    }

    // Check if user already exists (including soft-deleted)
    const existingUser = await db.query(
      'SELECT id, is_deleted FROM users WHERE email = $1', 
      [email]
    );

    if (existingUser.rows.length > 0) {
      if (existingUser.rows[0].is_deleted) {
        return sendError(res, 400, 'This account has been deleted. Please contact support.');
      }
      return sendError(res, 400, 'User with this email already exists');
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Insert new user
    const result = await db.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, phone, role) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING id, email, first_name, last_name, phone, role, created_at`,
      [email, passwordHash, first_name, last_name, phone || null, role || 'buyer']
    );

    const user = result.rows[0];

    // Generate token
    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role
    });

    return sendSuccess(res, 201, 'User registered successfully', {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
        role: user.role
      },
      token
    });
  } catch (error) {
    console.error('Register error:', error);
    return sendError(res, 500, 'Error registering user', error);
  }
};

/**
 * @desc    Register user with Google OAuth
 * @route   POST /api/auth/google-register
 * @access  Public
 */
const googleRegister = async (req, res) => {
  try {
    const { 
      email, 
      firstName, 
      lastName, 
      googleId, 
      google_id, 
      role, 
      avatar_url
    } = req.body;

    // Use either googleId or google_id (frontend might send either)
    const finalGoogleId = googleId || google_id;

    // Validate required fields
    if (!email || !finalGoogleId || !firstName) {
      return sendError(res, 400, 'Please provide email, Google ID, and name');
    }

    // Validate role
    const validRoles = ['buyer', 'seller'];
    if (role && !validRoles.includes(role)) {
      return sendError(res, 400, 'Invalid role. Must be either buyer or seller');
    }

    // Check if user already exists by email or google_id
    const existingUser = await db.query(
      'SELECT * FROM users WHERE email = $1 OR google_id = $2', 
      [email, finalGoogleId]
    );

    if (existingUser.rows.length > 0) {
      const user = existingUser.rows[0];

      // Check if account is deleted
      if (user.is_deleted) {
        return sendError(res, 400, 'This account has been deleted. Please contact support.');
      }

      // If user exists but doesn't have google_id, link the Google account
      if (!user.google_id) {
        await db.query(
          'UPDATE users SET google_id = $1, avatar_url = COALESCE(avatar_url, $2) WHERE id = $3',
          [finalGoogleId, avatar_url || null, user.id]
        );
        console.log(`✅ Linked Google account to existing user: ${user.email}`);
      }

      // Generate token for existing user
      const token = generateToken({
        id: user.id,
        email: user.email,
        role: user.role
      });

      return sendSuccess(res, 200, 'Login successful', {
        user: {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          phone: user.phone,
          role: user.role,
          avatar_url: user.avatar_url,
          google_id: user.google_id
        },
        token
      });
    }

    // Create new user with Google OAuth (no password needed)
    // Do NOT insert a null into password_hash if the column is NOT NULL in the DB.
    const result = await db.query(
      `INSERT INTO users (
        email,
        first_name,
        last_name,
        role,
        google_id,
        avatar_url,
        is_verified
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, email, first_name, last_name, phone, role, avatar_url, google_id, created_at`,
      [
        email,
        firstName,
        lastName || firstName,
        role || 'buyer',
        finalGoogleId,
        avatar_url || null,
        true // Google users are auto-verified
      ]
    );

    const user = result.rows[0];

    // Generate token
    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role
    });

    console.log(`✅ New user registered via Google: ${user.email}`);

    return sendSuccess(res, 201, 'User registered successfully with Google', {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
        role: user.role,
        avatar_url: user.avatar_url,
        google_id: user.google_id
      },
      token
    });
  } catch (error) {
    console.error('❌ Google register error:', error);
    return sendError(res, 500, 'Error registering user with Google', error);
  }
};

/**
 * @desc    Login user with Google OAuth
 * @route   POST /api/auth/google-login
 * @access  Public
 */
const googleLogin = async (req, res) => {
  try {
    const { email, googleId, google_id } = req.body;

    // Use either googleId or google_id
    const finalGoogleId = googleId || google_id;

    // Validate input
    if (!email || !finalGoogleId) {
      return sendError(res, 400, 'Please provide email and Google ID');
    }

    // Check if user exists and is not deleted
    const result = await db.query(
      'SELECT * FROM users WHERE (email = $1 OR google_id = $2) AND is_deleted = FALSE', 
      [email, finalGoogleId]
    );

    if (result.rows.length === 0) {
      return sendError(res, 401, 'User not found. Please sign up first.');
    }

    const user = result.rows[0];

    // If user doesn't have google_id yet, link it
    if (!user.google_id) {
      await db.query(
        'UPDATE users SET google_id = $1 WHERE id = $2',
        [finalGoogleId, user.id]
      );
      user.google_id = finalGoogleId;
    }

    // Generate token
    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role
    });

    return sendSuccess(res, 200, 'Login successful', {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
        role: user.role,
        avatar_url: user.avatar_url,
        google_id: user.google_id
      },
      token
    });
  } catch (error) {
    console.error('❌ Google login error:', error);
    return sendError(res, 500, 'Error logging in with Google', error);
  }
};

/**
 * @desc    Login user
 * @route   POST /api/auth/login
 * @access  Public
 */
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return sendError(res, 400, 'Please provide email and password');
    }

    // Check if user exists and is not deleted
    const result = await db.query(
      'SELECT * FROM users WHERE email = $1 AND is_deleted = FALSE', 
      [email]
    );

    if (result.rows.length === 0) {
      return sendError(res, 401, 'Invalid email or password');
    }

    const user = result.rows[0];

    // Check if user signed up with Google (no password)
    if (!user.password_hash && user.google_id) {
      return sendError(res, 400, 'This account uses Google Sign-In. Please use "Sign in with Google" button.');
    }

    // Check if password exists
    if (!user.password_hash) {
      return sendError(res, 401, 'Invalid email or password');
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return sendError(res, 401, 'Invalid email or password');
    }

    // Generate token
    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role
    });

    return sendSuccess(res, 200, 'Login successful', {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
        role: user.role
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    return sendError(res, 500, 'Error logging in', error);
  }
};


/**
 * @desc    Get current user (UPDATED VERSION)
 * @route   GET /api/auth/me
 * @access  Private
 */
const getMe = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT 
        id, email, first_name, last_name, phone, role, avatar_url, google_id,
        address_line1, city, state, postal_code, country,
        email_notifications, sms_notifications, push_notifications,
        created_at
       FROM users 
       WHERE id = $1 AND is_deleted = FALSE`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return sendError(res, 404, 'User not found');
    }

    const user = result.rows[0];

    return sendSuccess(res, 200, 'User fetched successfully', {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
        role: user.role,
        avatar_url: user.avatar_url,
        google_id: user.google_id,
        
        // Address fields
        address: user.address_line1,
        city: user.city,
        state: user.state,
        postalCode: user.postal_code,
        country: user.country,
        
        // Notification preferences
        notificationPreferences: {
          email: user.email_notifications,
          sms: user.sms_notifications,
          inApp: user.push_notifications
        },
        
        createdAt: user.created_at
      }
    });
  } catch (error) {
    console.error('Get me error:', error);
    return sendError(res, 500, 'Error fetching user data', error);
  }
};

/**
 * @desc    Update password
 * @route   PUT /api/auth/password
 * @access  Private
 */
const updatePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return sendError(res, 400, 'Please provide current and new password');
    }

    // Get user with password
    const result = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];

    // Check if user has a password (Google users might not)
    if (!user.password_hash) {
      return sendError(res, 400, 'Cannot update password for Google Sign-In accounts');
    }

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) {
      return sendError(res, 401, 'Current password is incorrect');
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const newPasswordHash = await bcrypt.hash(newPassword, salt);

    // Update password
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      newPasswordHash,
      req.user.id
    ]);

    return sendSuccess(res, 200, 'Password updated successfully');
  } catch (error) {
    console.error('Update password error:', error);
    return sendError(res, 500, 'Error updating password', error);
  }
};

/**
 * @desc    Logout user
 * @route   POST /api/auth/logout
 * @access  Private
 *
 * Optionally accepts: { cartItems } to persist guest cart on logout
 */
const logout = async (req, res) => {
  try {
    const user_id = req.user.id;
    const { cartItems } = req.body;

    // If cart items are provided, they will be handled by frontend localStorage
    // Backend just clears the token and confirms logout
    
    // Optional: Log logout event for audit trail
    const auditResult = await db.query(
      `INSERT INTO audit_log (user_id, action, details, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [user_id, 'logout', JSON.stringify({ cartItemsCount: cartItems?.length || 0 })]
    ).catch(() => {
      // Audit log not critical, silently fail if table doesn't exist
      return null;
    });

    // If using httpOnly cookies, clear them
    res.clearCookie('token');
    
    return sendSuccess(res, 200, 'Logged out successfully', {
      message: 'Your cart has been saved locally. It will sync when you log back in.',
      cartItemsSaved: cartItems?.length || 0
    });
  } catch (error) {
    console.error('Logout error:', error);
    // Always clear token even if there's an error
    res.clearCookie('token');
    return sendSuccess(res, 200, 'Logged out successfully');
  }
};

/**
 * @desc    Update user phone number
 * @route   PUT /api/auth/update-phone
 * @access  Private
 */
const updatePhone = async (req, res) => {
  try {
    const { phone } = req.body;

    // Validate phone number
    if (!phone) {
      return sendError(res, 400, 'Please provide a phone number');
    }

    // Basic phone validation (10-15 digits)
    const phoneDigits = phone.replace(/[^0-9]/g, '');
    if (phoneDigits.length < 10 || phoneDigits.length > 15) {
      return sendError(res, 400, 'Please provide a valid phone number');
    }

    // Update phone number in database
    const result = await db.query(
      'UPDATE users SET phone = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, first_name, last_name, phone, role, created_at',
      [phone, req.user.id]
    );

    if (result.rows.length === 0) {
      return sendError(res, 404, 'User not found');
    }

    const user = result.rows[0];

    console.log(`✅ Phone number updated for user: ${user.email}`);

    return sendSuccess(res, 200, 'Phone number updated successfully', {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
        role: user.role,
        createdAt: user.created_at
      }
    });
  } catch (error) {
    console.error('Update phone error:', error);
    return sendError(res, 500, 'Error updating phone number', error);
  }
};

// Add these functions to your auth.controller.js

/**
 * @desc    Update profile
 * @route   PUT /api/auth/update-profile
 * @access  Private
 */
const updateProfile = async (req, res) => {
  try {
    const { firstName, lastName, fullName, phone, avatar_url } = req.body;

    // Determine names
    let first_name = firstName;
    let last_name = lastName;
    if (fullName) {
      const parts = fullName.trim().split(' ');
      first_name = parts[0];
      last_name = parts.slice(1).join(' ') || parts[0];
    }

    // Build update fields dynamically
    const fields = [];
    const values = [];
    let idx = 1;
    if (first_name) { fields.push(`first_name = $${idx++}`); values.push(first_name); }
    if (last_name) { fields.push(`last_name = $${idx++}`); values.push(last_name); }
    if (phone !== undefined) { fields.push(`phone = $${idx++}`); values.push(phone); }
    if (avatar_url !== undefined) { fields.push(`avatar_url = $${idx++}`); values.push(avatar_url); }

    if (fields.length === 0) {
      return sendError(res, 400, 'No profile fields provided to update');
    }

    const query = `UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING id, email, first_name, last_name, phone, role, avatar_url, created_at`;
    values.push(req.user.id);

    const result = await db.query(query, values);
    if (result.rows.length === 0) return sendError(res, 404, 'User not found');

    const user = result.rows[0];
    return sendSuccess(res, 200, 'Profile updated successfully', {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
        role: user.role,
        avatar_url: user.avatar_url,
        createdAt: user.created_at
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    return sendError(res, 500, 'Error updating profile', error);
  }
};

/**
 * @desc    Change password (wrapper for updatePassword)
 * @route   PUT /api/auth/change-password
 * @access  Private
 */
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return sendError(res, 400, 'Please provide current and new password');
    }

    if (newPassword.length < 8) {
      return sendError(res, 400, 'New password must be at least 8 characters long');
    }

    const result = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user) return sendError(res, 404, 'User not found');

    if (!user.password_hash) {
      return sendError(res, 400, 'Cannot update password for Google Sign-In accounts');
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) return sendError(res, 401, 'Current password is incorrect');

    const salt = await bcrypt.genSalt(10);
    const newPasswordHash = await bcrypt.hash(newPassword, salt);

    await db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [
      newPasswordHash, 
      req.user.id
    ]);

    console.log(`✅ Password changed for user: ${user.email}`);

    return sendSuccess(res, 200, 'Password changed successfully');
  } catch (error) {
    console.error('Change password error:', error);
    return sendError(res, 500, 'Error changing password', error);
  }
};

/**
 * @desc    Update address
 * @route   PUT /api/auth/update-address
 * @access  Private
 */
const updateAddress = async (req, res) => {
  try {
    const {
      address,      // Match frontend field name
      city,
      state,
      postalCode,   // Match frontend field name
      country
    } = req.body;

    // At least one address field must be provided
    if (!address && !city && !state && !postalCode && !country) {
      return sendError(res, 400, 'No address fields provided to update');
    }

    const fields = [];
    const values = [];
    let idx = 1;
    
    if (address !== undefined) { fields.push(`address_line1 = $${idx++}`); values.push(address); }
    if (city !== undefined) { fields.push(`city = $${idx++}`); values.push(city); }
    if (state !== undefined) { fields.push(`state = $${idx++}`); values.push(state); }
    if (postalCode !== undefined) { fields.push(`postal_code = $${idx++}`); values.push(postalCode); }
    if (country !== undefined) { fields.push(`country = $${idx++}`); values.push(country); }

    const query = `UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING id, email, address_line1, city, state, postal_code, country`;
    values.push(req.user.id);

    const result = await db.query(query, values);
    if (result.rows.length === 0) return sendError(res, 404, 'User not found');

    const user = result.rows[0];
    console.log(`✅ Address updated for user: ${user.email}`);

    return sendSuccess(res, 200, 'Address updated successfully', { 
      address: {
        address: user.address_line1,
        city: user.city,
        state: user.state,
        postalCode: user.postal_code,
        country: user.country
      }
    });
  } catch (error) {
    console.error('Update address error:', error);
    return sendError(res, 500, 'Error updating address', error);
  }
};

/**
 * @desc    Update notification preferences
 * @route   PUT /api/auth/notification-preferences
 * @access  Private
 */
const updateNotificationPreferences = async (req, res) => {
  try {
    const { email, sms, inApp } = req.body;

    // At least one preference should be provided
    if (email === undefined && sms === undefined && inApp === undefined) {
      return sendError(res, 400, 'No notification preferences provided');
    }

    const fields = [];
    const values = [];
    let idx = 1;
    
    if (email !== undefined) { fields.push(`email_notifications = $${idx++}`); values.push(email); }
    if (sms !== undefined) { fields.push(`sms_notifications = $${idx++}`); values.push(sms); }
    if (inApp !== undefined) { fields.push(`push_notifications = $${idx++}`); values.push(inApp); }

    const query = `UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING id, email_notifications, sms_notifications, push_notifications`;
    values.push(req.user.id);

    const result = await db.query(query, values);
    if (result.rows.length === 0) return sendError(res, 404, 'User not found');

    const user = result.rows[0];
    console.log(`✅ Notification preferences updated for user ID: ${req.user.id}`);

    return sendSuccess(res, 200, 'Notification preferences updated', { 
      preferences: {
        email: user.email_notifications,
        sms: user.sms_notifications,
        inApp: user.push_notifications
      }
    });
  } catch (error) {
    console.error('Update notification preferences error:', error);
    return sendError(res, 500, 'Error updating notification preferences', error);
  }
};

/**
 * @desc    Delete (soft) account
 * @route   DELETE /api/auth/delete-account
 * @access  Private
 */
const deleteAccount = async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return sendError(res, 400, 'Please provide your password to confirm deletion');
    }

    // Get user with password
    const userResult = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];

    if (!user) return sendError(res, 404, 'User not found');

    // Verify password (skip for Google users)
    if (user.password_hash) {
      const isMatch = await bcrypt.compare(password, user.password_hash);
      if (!isMatch) {
        return sendError(res, 401, 'Incorrect password');
      }
    }

    // Soft delete: mark is_deleted and append timestamp to email to avoid unique constraint
    const result = await db.query(
      `UPDATE users SET 
        is_deleted = TRUE, 
        email = CONCAT(email, '--deleted-', EXTRACT(EPOCH FROM NOW())::text), 
        updated_at = NOW() 
       WHERE id = $1 
       RETURNING id, email`,
      [req.user.id]
    );

    if (result.rows.length === 0) return sendError(res, 404, 'User not found');

    // Optional: write audit log
    await db.query(
      `INSERT INTO audit_log (user_id, action, details, created_at) 
       VALUES ($1, $2, $3, NOW())`,
      [req.user.id, 'delete_account', JSON.stringify({ reason: req.body.reason || 'User requested deletion' })]
    ).catch(() => {
      // Audit log is optional, continue even if it fails
      console.log('Audit log insert skipped (table may not exist)');
    });

    console.log(`✅ Account deleted for user: ${user.email}`);

    return sendSuccess(res, 200, 'Account deleted successfully');
  } catch (error) {
    console.error('Delete account error:', error);
    return sendError(res, 500, 'Error deleting account', error);
  }
};

// ============================================
// orders.controller.js
// ============================================
const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * @desc    Create new order from cart
 * @route   POST /api/orders/create
 * @access  Private
 */
const createOrder = async (req, res) => {
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');
    
    const {
      shippingAddress,
      paymentMethod,
      deliveryOption,
      cartItems
    } = req.body;

    const userId = req.user.id;

    // Validate required fields
    if (!shippingAddress || !paymentMethod || !deliveryOption || !cartItems || cartItems.length === 0) {
      return sendError(res, 400, 'Missing required fields');
    }

    // Calculate totals
    let subtotal = 0;
    const orderItems = [];

    // Validate and prepare order items
    for (const item of cartItems) {
      // Get product details and check stock
      const productResult = await client.query(
        'SELECT id, name, price, stock_quantity FROM products WHERE id = $1',
        [item.product_id]
      );

      if (productResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return sendError(res, 404, `Product ${item.product_id} not found`);
      }

      const product = productResult.rows[0];

      // Check stock availability
      if (product.stock_quantity < item.quantity) {
        await client.query('ROLLBACK');
        return sendError(res, 400, `Insufficient stock for ${product.name}. Available: ${product.stock_quantity}`);
      }

      const itemTotal = product.price * item.quantity;
      subtotal += itemTotal;

      orderItems.push({
        product_id: product.id,
        product_name: product.name,
        quantity: item.quantity,
        price: product.price,
        total: itemTotal
      });
    }

    // Calculate shipping (you can implement complex logic here)
    const shippingFee = deliveryOption === 'marketmix' ? 5.00 : 0;
    const total = subtotal + shippingFee;

    // Generate unique order number
    const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

    // Create order
    const orderResult = await client.query(
      `INSERT INTO orders (
        user_id, order_number, status, payment_method, payment_status,
        subtotal, shipping_fee, total,
        shipping_address, delivery_option,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING id, order_number, total, created_at`,
      [
        userId,
        orderNumber,
        'pending',
        paymentMethod,
        'pending',
        subtotal,
        shippingFee,
        total,
        JSON.stringify(shippingAddress),
        deliveryOption
      ]
    );

    const order = orderResult.rows[0];

    // Insert order items
    for (const item of orderItems) {
      await client.query(
        `INSERT INTO order_items (
          order_id, product_id, product_name, quantity, price, total
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [order.id, item.product_id, item.product_name, item.quantity, item.price, item.total]
      );

      // Reduce product stock
      await client.query(
        'UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2',
        [item.quantity, item.product_id]
      );
    }

    // Clear user's cart
    await client.query('DELETE FROM cart WHERE user_id = $1', [userId]);

    await client.query('COMMIT');

    console.log(`✅ Order created: ${orderNumber} for user ${userId}`);

    return sendSuccess(res, 201, 'Order created successfully', {
      order: {
        id: order.id,
        orderNumber: order.order_number,
        total: order.total,
        items: orderItems,
        createdAt: order.created_at
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Create order error:', error);
    return sendError(res, 500, 'Error creating order', error);
  } finally {
    client.release();
  }
};

/**
 * @desc    Get user's orders
 * @route   GET /api/orders
 * @access  Private
 */
const getUserOrders = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await db.query(
      `SELECT 
        o.id, o.order_number, o.status, o.payment_status,
        o.total, o.created_at,
        json_agg(
          json_build_object(
            'product_name', oi.product_name,
            'quantity', oi.quantity,
            'price', oi.price,
            'total', oi.total
          )
        ) as items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.user_id = $1
      GROUP BY o.id
      ORDER BY o.created_at DESC`,
      [userId]
    );

    return sendSuccess(res, 200, 'Orders fetched successfully', {
      orders: result.rows
    });

  } catch (error) {
    console.error('❌ Get orders error:', error);
    return sendError(res, 500, 'Error fetching orders', error);
  }
};

/**
 * @desc    Get single order details
 * @route   GET /api/orders/:orderId
 * @access  Private
 */
const getOrderById = async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.id;

    const orderResult = await db.query(
      `SELECT * FROM orders WHERE id = $1 AND user_id = $2`,
      [orderId, userId]
    );

    if (orderResult.rows.length === 0) {
      return sendError(res, 404, 'Order not found');
    }

    const order = orderResult.rows[0];

    // Get order items
    const itemsResult = await db.query(
      'SELECT * FROM order_items WHERE order_id = $1',
      [orderId]
    );

    return sendSuccess(res, 200, 'Order fetched successfully', {
      order: {
        ...order,
        items: itemsResult.rows
      }
    });

  } catch (error) {
    console.error('❌ Get order error:', error);
    return sendError(res, 500, 'Error fetching order', error);
  }
};

/**
 * @desc    Cancel order
 * @route   PUT /api/orders/:orderId/cancel
 * @access  Private
 */
const cancelOrder = async (req, res) => {
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');
    
    const { orderId } = req.params;
    const userId = req.user.id;

    // Get order
    const orderResult = await client.query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [orderId, userId]
    );

    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return sendError(res, 404, 'Order not found');
    }

    const order = orderResult.rows[0];

    // Check if order can be cancelled
    if (!['pending', 'processing'].includes(order.status)) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'Order cannot be cancelled at this stage');
    }

    // Get order items to restore stock
    const itemsResult = await client.query(
      'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
      [orderId]
    );

    // Restore product stock
    for (const item of itemsResult.rows) {
      await client.query(
        'UPDATE products SET stock_quantity = stock_quantity + $1 WHERE id = $2',
        [item.quantity, item.product_id]
      );
    }

    // Update order status
    await client.query(
      'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2',
      ['cancelled', orderId]
    );

    await client.query('COMMIT');

    console.log(`✅ Order cancelled: ${order.order_number}`);

    return sendSuccess(res, 200, 'Order cancelled successfully');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Cancel order error:', error);
    return sendError(res, 500, 'Error cancelling order', error);
  } finally {
    client.release();
  }
};

// UPDATE YOUR MODULE.EXPORTS to include all functions:
module.exports = {
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
   createOrder,
  getUserOrders,
  getOrderById,
  cancelOrder,
  updateNotificationPreferences,
  deleteAccount
 };

