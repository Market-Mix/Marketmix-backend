const express = require('express');
const router = express.Router();

// Inline db and utils to avoid any require path issues
const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const { protect } = require('../middlewares/auth.middleware');
const { isSeller } = require('../middlewares/role.middleware');

// ─── GET /api/seller/ping — no auth, confirms file loaded ─────────────────────
router.get('/ping', (req, res) => {
  res.json({ status: 'success', message: 'Seller routes loaded ✅' });
});

// ─── GET /api/seller/profile ───────────────────────────────────────────────────
router.get('/profile', protect, isSeller, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await db.query(
      `SELECT
          u.id             AS user_id,
          u.email,
          u.first_name,
          u.last_name,
          u.phone,
          u.role,
          u.avatar_url,
          sp.id            AS profile_id,
          sp.business_name,
          sp.business_description,
          sp.business_address,
          sp.business_phone,
          sp.business_email,
          sp.total_sales,
          sp.total_earnings,
          sp.available_balance,
          sp.rating,
          sp.total_reviews,
          sp.is_verified,
          sp.kyc_document_urls,
          sp.store_logo_url,
          sp.created_at
       FROM users u
       LEFT JOIN seller_profiles sp ON sp.user_id = u.id AND sp.is_deleted = false
       WHERE u.id = $1 AND u.is_deleted = false`,
      [userId]
    );

    if (result.rows.length === 0) {
      return sendError(res, 404, 'Seller not found');
    }

    const row = result.rows[0];

    let productCount = 0;
    try {
      const countRes = await db.query(
        'SELECT COUNT(*) FROM products WHERE seller_id = $1 AND is_deleted = false',
        [userId]
      );
      productCount = parseInt(countRes.rows[0].count);
    } catch (e) {
      console.warn('Could not fetch product count:', e.message);
    }

    return sendSuccess(res, 200, 'Seller profile fetched successfully', {
      seller: {
        userId: row.user_id,
        email: row.email,
        firstName: row.first_name,
        lastName: row.last_name,
        phone: row.phone,
        role: row.role,
        avatarUrl: row.avatar_url,
        profile: row.profile_id ? {
          id: row.profile_id,
          businessName: row.business_name,
          businessDescription: row.business_description,
          businessAddress: row.business_address,
          businessPhone: row.business_phone,
          businessEmail: row.business_email,
          totalSales: parseFloat(row.total_sales) || 0,
          totalEarnings: parseFloat(row.total_earnings) || 0,
          availableBalance: parseFloat(row.available_balance) || 0,
          rating: parseFloat(row.rating) || 0,
          totalReviews: row.total_reviews || 0,
          isVerified: row.is_verified,
          kycDocumentUrls: row.kyc_document_urls,
          storeLogo: row.store_logo_url,
          createdAt: row.created_at
        } : null,
        productCount
      }
    });
  } catch (error) {
    console.error('Get seller profile error:', error);
    return sendError(res, 500, 'Error fetching seller profile', error);
  }
});

// ─── POST /api/seller/setup-profile ───────────────────────────────────────────
router.post('/setup-profile', protect, isSeller, async (req, res) => {
  try {
    const { storeName, businessType, productCategory, address } = req.body;
    const userId = req.user.id;

    if (!storeName) {
      return sendError(res, 400, 'Store name is required');
    }

    // Fetch phone + email from users table to populate seller_profiles
    const userCheck = await db.query(
      'SELECT id, role, phone, email FROM users WHERE id = $1 AND is_deleted = false',
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return sendError(res, 404, 'User not found');
    }

    if (userCheck.rows[0].role !== 'seller') {
      return sendError(res, 403, 'Only sellers can set up a store profile');
    }

    const { phone: userPhone, email: userEmail } = userCheck.rows[0];

    // Combine businessType + productCategory into business_description
    const descriptionParts = [];
    if (businessType)     descriptionParts.push(`Business Type: ${businessType}`);
    if (productCategory)  descriptionParts.push(`Product Category: ${productCategory}`);
    const businessDescription = descriptionParts.length > 0
      ? descriptionParts.join(' | ')
      : null;

    // UPSERT into seller_profiles
    const result = await db.query(
      `INSERT INTO seller_profiles (
          user_id,
          business_name,
          business_description,
          business_address,
          business_phone,
          business_email,
          updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
          business_name        = EXCLUDED.business_name,
          business_description = EXCLUDED.business_description,
          business_address     = EXCLUDED.business_address,
          business_phone       = EXCLUDED.business_phone,
          business_email       = EXCLUDED.business_email,
          updated_at           = NOW()
       RETURNING
          id, user_id, business_name, business_description,
          business_address, business_phone, business_email,
          is_verified, rating, created_at`,
      [
        userId,
        storeName,
        businessDescription,
        address || null,
        userPhone || null,
        userEmail || null
      ]
    );

    const profile = result.rows[0];
    console.log(`✅ Seller profile upserted for user_id: ${userId} | store: ${storeName}`);

    return sendSuccess(res, 201, 'Seller profile set up successfully', {
      sellerProfile: {
        id: profile.id,
        userId: profile.user_id,
        businessName: profile.business_name,
        businessDescription: profile.business_description,
        businessAddress: profile.business_address,
        businessPhone: profile.business_phone,
        businessEmail: profile.business_email,
        isVerified: profile.is_verified,
        rating: profile.rating,
        createdAt: profile.created_at
      }
    });
  } catch (error) {
    console.error('Setup seller profile error:', error);
    return sendError(res, 500, 'Error setting up seller profile', error);
  }
});

// ─── POST /api/seller/send-otp ────────────────────────────────────────────────
// Generates a 6-digit OTP, stores it in seller_profiles, sends via SendGrid
router.post('/send-otp', protect, isSeller, async (req, res) => {
  try {
    const { email } = req.body;
    const userId = req.user.id;

    if (!email) return sendError(res, 400, 'Email is required');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendError(res, 400, 'Invalid email address');
    }

    // Confirm seller_profiles row exists
    const profileCheck = await db.query(
      'SELECT id FROM seller_profiles WHERE user_id = $1 AND is_deleted = false',
      [userId]
    );
    if (profileCheck.rows.length === 0) {
      return sendError(res, 404, 'Seller profile not found. Please complete signup first.');
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store OTP in seller_profiles kyc_document_urls jsonb column
    await db.query(
      `UPDATE seller_profiles
       SET kyc_document_urls = COALESCE(kyc_document_urls, '{}'::jsonb) ||
           jsonb_build_object(
             'otp_code', $1::text,
             'otp_expires_at', $2::text,
             'otp_email', $3::text
           ),
           business_email = $3,
           updated_at = NOW()
       WHERE user_id = $4`,
      [otp, expiresAt.toISOString(), email, userId]
    );

    // Send via SendGrid HTTP API (works on Render free tier — no SMTP ports needed)
    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);

    await sgMail.send({
      to: email,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject: 'MarketMix — Your Email Verification Code',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;border:1px solid #eee;border-radius:8px;">
          <h2 style="color:#667eea;">MarketMix</h2>
          <p>Hi there,</p>
          <p>Use the code below to verify your email address. It expires in <strong>10 minutes</strong>.</p>
          <div style="text-align:center;margin:32px 0;">
            <span style="font-size:2.5rem;font-weight:bold;letter-spacing:12px;color:#333;">${otp}</span>
          </div>
          <p style="color:#888;font-size:0.85rem;">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `
    });

    console.log(`✅ OTP sent to ${email} for user_id: ${userId}`);
    return sendSuccess(res, 200, 'Verification code sent to your email');

  } catch (error) {
    console.error('Send OTP error:', error);
    if (error.response?.body?.errors) {
      console.error('SendGrid errors:', JSON.stringify(error.response.body.errors));
    }
    return sendError(res, 500, 'Failed to send verification email. Please try again.');
  }
});

// ─── POST /api/seller/verify-otp ──────────────────────────────────────────────
router.post('/verify-otp', protect, isSeller, async (req, res) => {
  try {
    const { email, otp } = req.body;
    const userId = req.user.id;

    if (!email || !otp) return sendError(res, 400, 'Email and OTP code are required');

    // Fetch stored OTP data from seller_profiles
    const result = await db.query(
      `SELECT kyc_document_urls, is_verified
       FROM seller_profiles
       WHERE user_id = $1 AND is_deleted = false`,
      [userId]
    );

    if (result.rows.length === 0) {
      return sendError(res, 404, 'Seller profile not found');
    }

    const { kyc_document_urls, is_verified } = result.rows[0];

    if (is_verified) {
      return sendSuccess(res, 200, 'Email already verified');
    }

    const storedOtp      = kyc_document_urls?.otp_code;
    const storedExpiry   = kyc_document_urls?.otp_expires_at;
    const storedEmail    = kyc_document_urls?.otp_email;

    if (!storedOtp || !storedExpiry) {
      return sendError(res, 400, 'No verification code found. Please request a new one.');
    }

    // Check email matches
    if (storedEmail !== email) {
      return sendError(res, 400, 'Email does not match the one the code was sent to.');
    }

    // Check expiry
    if (new Date() > new Date(storedExpiry)) {
      return sendError(res, 400, 'Verification code has expired. Please request a new one.');
    }

    // Check OTP matches
    if (storedOtp !== otp.toString().trim()) {
      return sendError(res, 400, 'Invalid verification code. Please try again.');
    }

    // Mark as verified — clear OTP data from kyc_document_urls
    await db.query(
      `UPDATE seller_profiles
       SET is_verified = true,
           kyc_document_urls = kyc_document_urls - 'otp_code' - 'otp_expires_at' - 'otp_email',
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );

    console.log(`✅ Email verified for user_id: ${userId}`);
    return sendSuccess(res, 200, 'Email verified successfully! ✅');

  } catch (error) {
    console.error('Verify OTP error:', error);
    return sendError(res, 500, 'Error verifying code', error);
  }
});

// ─── POST /api/seller/update-store ────────────────────────────────────────────
// Save full store setup form data
router.post('/update-store', protect, isSeller, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      storeName, storeDescription, businessEmail, businessPhone,
      businessAddress, website, category,
      facebook, twitter, tiktok, instagram, telegram
    } = req.body;

    if (!storeName) return sendError(res, 400, 'Store name is required');

    // Build social links as jsonb
    const socialLinks = { facebook, twitter, tiktok, instagram, telegram };

    await db.query(
      `UPDATE seller_profiles SET
          business_name        = $1,
          business_description = $2,
          business_email       = $3,
          business_phone       = $4,
          business_address     = $5,
          kyc_document_urls    = COALESCE(kyc_document_urls, '{}'::jsonb) ||
                                 jsonb_build_object(
                                   'website', $6::text,
                                   'category', $7::text,
                                   'social_links', $8::jsonb
                                 ),
          updated_at           = NOW()
       WHERE user_id = $9`,
      [
        storeName,
        storeDescription || null,
        businessEmail || null,
        businessPhone || null,
        businessAddress || null,
        website || '',
        category || '',
        JSON.stringify(socialLinks),
        userId
      ]
    );

    console.log(`✅ Store updated for user_id: ${userId}`);
    return sendSuccess(res, 200, 'Store setup saved successfully');

  } catch (error) {
    console.error('Update store error:', error);
    return sendError(res, 500, 'Error saving store setup', error);
  }
});

module.exports = router;