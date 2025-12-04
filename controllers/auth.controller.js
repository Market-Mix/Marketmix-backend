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
 * @desc    Get current user
 * @route   GET /api/auth/me
 * @access  Private
 */
const getMe = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, email, first_name, last_name, phone, role, avatar_url, google_id, created_at FROM users WHERE id = $1 AND is_deleted = FALSE',
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

module.exports = {
  register,
  googleRegister,
  googleLogin,
  login,
  getMe,
  updatePassword,
  logout
};