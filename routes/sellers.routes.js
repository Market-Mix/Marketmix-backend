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

module.exports = router;