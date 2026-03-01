const bcrypt = require('bcrypt');
const db = require('../config/db');
const { generateToken } = require('../utils/jwt');
const { sendSuccess, sendError } = require('../utils/response');
const nodemailer = require('nodemailer');

// In-memory OTP store: email -> { code, expiresAt }
// WARNING: this is volatile; restarting the server will clear OTPs.
const otpStore = new Map();
let transporter; // lazily initialized

async function getTransporter() {
  if (transporter) return transporter;
  // Prefer explicit SMTP settings if provided via env vars
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
  } else {
    // fallback to ethereal test account for development
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass
      }
    });
    console.log('🧪 Ethereal test account created. Visit https://ethereal.email with credentials:', testAccount);
  }
  return transporter;
}

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


/**
 * @desc    Send OTP code to email for verification
 * @route   POST /api/auth/send-otp
 * @access  Public
 */
const sendOtp = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return sendError(res, 400, 'Email is required');

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

    otpStore.set(email, { code, expiresAt });

    // send email
    const tr = await getTransporter();
    const mailOptions = {
      from: process.env.EMAIL_FROM || '"MarketMix" <no-reply@marketmix.com>',
      to: email,
      subject: 'Your MarketMix verification code',
      text: `Your verification code is ${code}. It expires in 5 minutes.`,
      html: `<p>Your verification code is <b>${code}</b>.</p><p>Expires in 5 minutes.</p>`
    };

    let resp = { email };
    // attempt to send mail but don't fail the whole endpoint if it errors
    try {
      const info = await tr.sendMail(mailOptions);
      console.log('sendOtp: email sent', info.messageId);
      if (info.previewURL) {
        console.log('Preview URL:', info.previewURL);
      }
    } catch (emailErr) {
      // log and continue, we still have the OTP stored
      console.warn('sendOtp: email delivery failed -', emailErr.message);
      resp.emailFailed = true;
    }

    // always include code in response when not in production **or** if mail failed
    if (process.env.NODE_ENV !== 'production' || resp.emailFailed) {
      resp.code = code;
    }
    return sendSuccess(res, 200, 'OTP generated', resp);
  } catch (error) {
    console.error('sendOtp error:', error);
    // On any unexpected error we still want to send success with code for debugging
    const codeOnly = { code };
    return sendSuccess(res, 200, 'OTP generated (partial failure)', codeOnly);
  }
};

/**
 * @desc    Verify OTP code previously sent
 * @route   POST /api/auth/verify-otp
 * @access  Public
 */
const verifyOtp = async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return sendError(res, 400, 'Email and code required');

    const entry = otpStore.get(email);
    if (!entry) return sendError(res, 400, 'No OTP requested for this email');

    if (Date.now() > entry.expiresAt) {
      otpStore.delete(email);
      return sendError(res, 400, 'OTP expired');
    }

    if (String(code) !== entry.code) {
      return sendError(res, 400, 'Invalid OTP');
    }

    otpStore.delete(email);

    // if user is authenticated update seller_profiles email_verified flag
    if (req.user && req.user.id) {
      try {
        await db.query(
          'UPDATE seller_profiles SET email_verified = TRUE WHERE user_id = $1',
          [req.user.id]
        );
      } catch (dbErr) {
        console.warn('verifyOtp: could not update seller_profiles email_verified', dbErr);
      }
    }

    return sendSuccess(res, 200, 'OTP verified');
  } catch (error) {
    console.error('verifyOtp error:', error);
    return sendError(res, 500, 'Error verifying OTP');
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
  updateNotificationPreferences,
  deleteAccount,
  sendOtp,
  verifyOtp
};

