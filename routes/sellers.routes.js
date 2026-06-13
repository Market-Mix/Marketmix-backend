const express = require('express');
const router = express.Router();

// Inline db and utils to avoid any require path issues
const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const { protect } = require('../middlewares/auth.middleware');
const { isSeller } = require('../middlewares/role.middleware');
const { createDedupedNotification } = require('../controllers/notification.controller');
const multer = require('multer');
const { uploadToCloudinary } = require('../utils/cloudinary');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function normalizeKycStatus(isVerified, status) {
  const normalized = String(status || 'not_submitted').toLowerCase();
  if (isVerified === true) return 'approved';
  if (isVerified === false && ['approved', 'failed'].includes(normalized)) return 'rejected';
  return normalized;
}

async function ensureKycStatusSync(userId, isVerified, status) {
  const normalizedStatus = normalizeKycStatus(isVerified, status);
  const currentStatus = String(status || 'not_submitted').toLowerCase();

  if (normalizedStatus !== currentStatus) {
    await db.query(
      `UPDATE seller_profiles
       SET kyc_status = $2,
           updated_at = NOW()
       WHERE user_id = $1 AND is_deleted = false`,
      [userId, normalizedStatus]
    );
  }

  console.log({ is_verified: isVerified, kyc_status: normalizedStatus });
  return normalizedStatus;
}


router.get('/stores/public/test', (req, res) => res.json({ ok: true }));

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
          sp.kyc_status,
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
    const rawStatus = row.kyc_status || (row.kyc_document_urls?.kyc_status || null);
    const normalizedStatus = await ensureKycStatusSync(userId, row.is_verified, rawStatus);

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
          kycStatus: normalizedStatus,
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

// ─── GET /api/seller/dashboard-stats ─────────────────────────────────────────
router.get('/dashboard-stats', protect, isSeller, async (req, res) => {
  const storeId = req.headers['x-store-id'];
  const sellerId = req.user.id;

  if (!storeId) return sendError(res, 400, 'X-Store-Id header required');

  try {
    const [orderStats, storeData] = await Promise.all([
      db.query(
        `SELECT COUNT(DISTINCT o.id) AS total_orders,
                COUNT(DISTINCT o.id) FILTER (WHERE o.status='pending') AS pending,
                COUNT(DISTINCT o.id) FILTER (WHERE o.status='delivered') AS delivered,
                COALESCE(SUM(oi.quantity * oi.price_at_purchase), 0) AS total_revenue
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE oi.seller_id = $1 AND oi.store_id = $2`,
        [sellerId, storeId]
      ),
      db.query(
        `SELECT total_earnings, available_balance, rating, total_reviews, store_logo_url
         FROM stores WHERE id = $1 AND user_id = $2`,
        [storeId, sellerId]
      )
    ]);

    const o = orderStats.rows[0] || {};
    const s = storeData.rows[0] || {};

    return sendSuccess(res, 200, 'Stats fetched', {
      stats: {
        totalOrders: parseInt(o.total_orders) || 0,
        pending: parseInt(o.pending) || 0,
        delivered: parseInt(o.delivered) || 0,
        totalRevenue: parseFloat(o.total_revenue) || 0,
        totalEarnings: parseFloat(s.total_earnings) || 0,
        availableBalance: parseFloat(s.available_balance) || 0,
        rating: parseFloat(s.rating) || 0,
        totalReviews: parseInt(s.total_reviews) || 0,
        storeLogoUrl: s.store_logo_url || null
      }
    });
  } catch (err) {
    return sendError(res, 500, 'Error fetching dashboard stats', err.message);
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

// ─── sendOtpEmail Helper Function ──────────────────────────────────────────────
async function sendOtpEmail(to, otp) {
  // // Former Resend implementation (commented out)
  // const { Resend } = require('resend');
  // const resend = new Resend(process.env.RESEND_API_KEY);
  // await resend.emails.send({
  //   from: process.env.FROM_EMAIL || 'MarketMix <onboarding@resend.dev>',
  //   to,
  //   subject: 'Your MarketMix Verification Code',
  //   html: `<p>Your code: <strong style="font-size:1.5rem;letter-spacing:8px">${otp}</strong></p><p>Expires in 10 minutes.</p>`
  // });

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: 'MarketMix', email: process.env.FROM_EMAIL || 'noreply@marketmix.com' },
      to: [{ email: to }],
      subject: 'Your MarketMix Verification Code',
      htmlContent: `<p>Your code: <strong style="font-size:1.5rem;letter-spacing:8px">${otp}</strong></p><p>Expires in 10 minutes.</p>`
    })
  });

  const result = await response.json();
  console.log('Brevo result:', JSON.stringify(result));
  
  if (!response.ok) {
    throw new Error(result.message || 'Brevo email failed');
  }
  
  return result;
}

// ─── POST /api/seller/send-otp ────────────────────────────────────────────────
// Generates a 6-digit OTP, stores it in seller_profiles, sends via Resend
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

    // Send via Resend
    await sendOtpEmail(email, otp);

    console.log(`✅ OTP sent to ${email} for user_id: ${userId}`);
    return sendSuccess(res, 200, 'Verification code sent to your email');

  } catch (error) {
    console.error('Send OTP error:', error);
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
      `SELECT kyc_document_urls, email_verified
       FROM seller_profiles
       WHERE user_id = $1 AND is_deleted = false`,
      [userId]
    );

    if (result.rows.length === 0) {
      return sendError(res, 404, 'Seller profile not found');
    }

    const { kyc_document_urls, email_verified } = result.rows[0];

    if (email_verified) {
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
       SET email_verified = true,
           kyc_document_urls = kyc_document_urls - 'otp_code' - 'otp_expires_at' - 'otp_email',
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );

    try {
      await createDedupedNotification({
        userId,
        title: 'Email Verified',
        message: 'Your email verification is complete. You can now continue selling on MarketMix.',
        type: 'account',
        link: '/sellers/sellers notification page.html'
      });
    } catch (notifError) {
      console.warn('Failed to create deduplicated KYC notification:', notifError);
    }

    console.log(`✅ Email verified for user_id: ${userId}`);
    return sendSuccess(res, 200, 'Email verified successfully! ✅');

  } catch (error) {
    console.error('Verify OTP error:', error);
    return sendError(res, 500, 'Error verifying code', error);
  }
});

// ─── POST /api/seller/update-store ────────────────────────────────────────────
// Replaces the old seller_profiles-based store setup.
// Upserts store #1 into the `stores` table and sets it as the seller's active store.
router.post('/update-store', protect, isSeller, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      storeName, storeDescription, businessEmail, businessPhone,
      businessAddress, website, category, storeLogoUrl,
      facebook, twitter, tiktok, instagram, telegram
    } = req.body;

    if (!storeName) return sendError(res, 400, 'Store name is required');

    // Check if store #1 already exists for this user
    const existing = await db.query(
      `SELECT id FROM stores WHERE user_id = $1 AND store_number = 1 AND is_deleted = false`,
      [userId]
    );

    let result;

    if (existing.rows.length > 0) {
      // Update existing store #1
      result = await db.query(
        `UPDATE stores SET
           business_name        = $1,
           business_description = $2,
           business_email       = $3,
           business_phone       = $4,
           business_address     = $5,
           store_logo_url       = COALESCE($6, store_logo_url),
           website              = $7,
           facebook             = $8,
           twitter              = $9,
           instagram            = $10,
           tiktok               = $11,
           telegram             = $12,
           category             = $13,
           updated_at           = NOW()
         WHERE user_id = $14 AND store_number = 1
         RETURNING id, store_number, business_name, store_logo_url, is_verified, created_at`,
        [
          storeName, storeDescription || null, businessEmail || null,
          businessPhone || null, businessAddress || null,
          storeLogoUrl || null, website || null,
          facebook || null, twitter || null, instagram || null,
          tiktok || null, telegram || null, category || null,
          userId
        ]
      );
    } else {
      // Create store #1
      result = await db.query(
        `INSERT INTO stores (
           user_id, store_number, business_name, business_description,
           business_address, business_phone, business_email,
           store_logo_url, website, facebook, twitter, instagram,
           tiktok, telegram, category
         ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id, store_number, business_name, store_logo_url, is_verified, created_at`,
        [
          userId, storeName, storeDescription || null,
          businessAddress || null, businessPhone || null, businessEmail || null,
          storeLogoUrl || null, website || null,
          facebook || null, twitter || null, instagram || null,
          tiktok || null, telegram || null, category || null
        ]
      );
    }

    const store = result.rows[0];
    console.log(`✅ Store #1 upserted for user_id: ${userId} | store id: ${store.id}`);

    return sendSuccess(res, 200, 'Store setup saved successfully', { store });

  } catch (error) {
    console.error('Update store error:', error);
    return sendError(res, 500, 'Error saving store setup', error);
  }
});


// ─── POST /api/seller/kyc/upload ──────────────────────────────────────────────
// Receives a file from the frontend, uploads it to Supabase Storage
// using the service key (server-side only), returns a signed URL.
router.post('/kyc/upload', protect, isSeller, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return sendError(res, 400, 'No file provided');
    }

    const pathPrefix = req.body.pathPrefix || 'misc';
    const timestamp  = Date.now();
    const safeName   = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${pathPrefix}-${timestamp}-${safeName}`;

    const SUPABASE_URL         = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
      return sendError(res, 500, 'Storage service not configured');
    }

    // Upload file to Supabase Storage
    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/kyc-documents/${storagePath}`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': req.file.mimetype,
          'x-upsert':     'true',
        },
        body: req.file.buffer,
      }
    );

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.error('Supabase Storage upload error:', errText);
      return sendError(res, 500, 'Failed to upload file');
    }

    // Generate a long-lived signed URL (10 years) for admin review later
    const signedRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/kyc-documents/${storagePath}`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: 315360000 }), // 10 years in seconds
      }
    );

    let fileUrl;
    if (signedRes.ok) {
      const signedData = await signedRes.json();
      fileUrl = `${SUPABASE_URL}/storage/v1${signedData.signedURL}`;
    } else {
      // Fallback: store the path so admin can generate URLs later
      fileUrl = `kyc-documents/${storagePath}`;
    }

    console.log(`✅ KYC file uploaded: ${storagePath}`);
    return sendSuccess(res, 200, 'File uploaded successfully', { url: fileUrl });

  } catch (error) {
    console.error('KYC upload error:', error);
    return sendError(res, 500, 'Error uploading file', error);
  }
});


// ─── POST /api/seller/logo/upload ─────────────────────────────────────────────
// Receives a file from the frontend, uploads it to Cloudinary,
// returns the secure URL.
router.post('/logo/upload', protect, isSeller, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return sendError(res, 400, 'No file provided');
    }

    const fileUrl = await uploadToCloudinary(req.file.buffer, req.file.mimetype, 'store-logos');

    console.log(`Store logo uploaded: ${fileUrl}`);
    return sendSuccess(res, 200, 'Logo uploaded successfully', { url: fileUrl });

  } catch (error) {
    console.error('Logo upload error:', error);
    return sendError(res, 500, 'Error uploading file', error);
  }
});

// ─── POST /api/seller/banner/upload ───────────────────────────────────────────
// Similar to logo upload but for store banners.
router.post('/banner/upload', protect, isSeller, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return sendError(res, 400, 'No file provided');
    const fileUrl = await uploadToCloudinary(req.file.buffer, req.file.mimetype, 'store-banners');
    return sendSuccess(res, 200, 'Banner uploaded', { url: fileUrl });
  } catch (error) {
    return sendError(res, 500, 'Error uploading banner', error);
  }
});


// ─── POST /api/seller/kyc ─────────────────────────────────────────────────────
// Saves KYC form data + Supabase Storage file URLs into
// seller_profiles.kyc_document_urls JSONB.
// Sets kyc_status = 'pending' for manual admin review.
router.post('/kyc', protect, isSeller, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      fullName,
      dob,
      businessName,
      businessAddress,
      email,
      phone,
      idType,
      idDocumentUrl,
      selfiePhotoUrl,
    } = req.body;

    // Validation
    if (!fullName || !fullName.trim()) {
      return sendError(res, 400, 'Full name is required');
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return sendError(res, 400, 'A valid email address is required');
    }
    if (!idType) {
      return sendError(res, 400, 'ID type is required');
    }
    if (!idDocumentUrl) {
      return sendError(res, 400, 'ID document URL is required');
    }
    if (!selfiePhotoUrl) {
      return sendError(res, 400, 'Selfie photo URL is required');
    }

    // Ensure seller_profiles row exists
    const profileCheck = await db.query(
      'SELECT id, is_verified, kyc_status, kyc_document_urls FROM seller_profiles WHERE user_id = $1 AND is_deleted = false',
      [userId]
    );
    if (profileCheck.rows.length === 0) {
      return sendError(res, 404, 'Seller profile not found. Please complete store setup first.');
    }

    const profileRow = profileCheck.rows[0];
    const existingKyc = profileRow.kyc_document_urls || {};
    const currentKycStatus = existingKyc.kyc_status || profileRow.kyc_status;
    const normalizedStatus = await ensureKycStatusSync(userId, profileRow.is_verified, currentKycStatus);

    // Block re-submission if already approved
    if (normalizedStatus === 'approved') {
      return sendError(res, 409, 'Your KYC has already been approved.');
    }

    // Build KYC payload — spread existing JSONB so we don't wipe other stored data
    // (e.g. OTP fields, social links stored by /update-store)
    const kycData = {
      ...existingKyc,
      kyc_submitted_at:     new Date().toISOString(),
      kyc_full_name:        fullName.trim(),
      kyc_dob:              dob || null,
      kyc_business_name:    businessName || null,
      kyc_business_address: businessAddress || null,
      kyc_email:            email.trim(),
      kyc_phone:            phone || null,
      kyc_id_type:          idType,
      kyc_id_document_url:  idDocumentUrl,
      kyc_selfie_url:       selfiePhotoUrl,
    };

    await db.query(
      `UPDATE seller_profiles
       SET kyc_document_urls = $1::jsonb,
           kyc_status        = 'pending',
           business_email    = COALESCE(NULLIF($2, ''), business_email),
           updated_at        = NOW()
       WHERE user_id = $3`,
      [JSON.stringify(kycData), email.trim(), userId]
    );

    console.log(`✅ KYC submitted for user_id: ${userId} | status: pending`);

    return sendSuccess(res, 200, 'KYC submitted successfully. We will review your documents and notify you.', {
      kycStatus: 'pending',
    });

  } catch (error) {
    console.error('KYC submission error:', error);
    return sendError(res, 500, 'Error submitting KYC', error);
  }
});


// ─── GET /api/seller/kyc/status ──────────────────────────────────────────────
// Returns the current KYC status for the logged-in seller.
// Used by the frontend on page load to show the correct UI state.
router.get('/kyc/status', protect, isSeller, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await db.query(
      `SELECT is_verified, kyc_status, kyc_document_urls
       FROM seller_profiles
       WHERE user_id = $1 AND is_deleted = false`,
      [userId]
    );

    if (result.rows.length === 0) {
      return sendError(res, 404, 'Seller profile not found');
    }

    const { is_verified, kyc_status, kyc_document_urls } = result.rows[0];
    const kyc = kyc_document_urls || {};
    const rawStatus = kyc_status || kyc.kyc_status;
    const normalizedStatus = await ensureKycStatusSync(userId, is_verified, rawStatus);

    return sendSuccess(res, 200, 'KYC status fetched', {
      isVerified:     is_verified,
      kycStatus:      normalizedStatus,
      kycSubmittedAt: kyc.kyc_submitted_at || null,
    });

  } catch (error) {
    console.error('KYC status error:', error);
    return sendError(res, 500, 'Error fetching KYC status', error);
  }
});


// GET /api/seller/stores/public/:storeId/products ──────────────────
// Falls back to seller_id when products don't have store_id set
router.get('/stores/public/:storeId/products', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { category, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
 
    // First resolve the seller_id for this store (needed for fallback query)
    const storeRow = await db.query(
      `SELECT user_id FROM stores WHERE id = $1 AND is_deleted = false`,
      [storeId]
    );
    const sellerId = storeRow.rows[0]?.user_id;
 
    // Products may be linked by store_id (new) OR seller_id (legacy)
    let where = `WHERE (p.store_id = $1 OR (p.store_id IS NULL AND p.seller_id = $2))
                 AND p.is_active = true AND p.is_deleted = false`;
    const params = [storeId, sellerId || storeId];
    let idx = 3;
 
    if (category && category !== 'all') {
      where += ` AND LOWER(COALESCE(c.name, 'uncategorized')) = $${idx++}`;
      params.push(category.toLowerCase());
    }
 
    const result = await db.query(
      `SELECT
          p.id, p.name, p.description, p.price, p.stock_quantity,
          p.main_image_url, p.color, p.size,
          p."flash start" as flash_start, p."flash end" as flash_end,
          COALESCE(c.name, 'Uncategorized') AS category_name,
          COALESCE(
            (SELECT AVG(r.rating)::numeric(10,1) FROM reviews r
             WHERE r.product_id = p.id AND r.is_deleted = false), 0
          ) AS avg_rating,
          (SELECT COUNT(*) FROM reviews r
           WHERE r.product_id = p.id AND r.is_deleted = false) AS review_count
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parseInt(limit), offset]
    );
 
    const countRes = await db.query(
      `SELECT COUNT(*) FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       ${where}`,
      params
    );
 
    const categoriesRes = await db.query(
      `SELECT DISTINCT COALESCE(c.name, 'Uncategorized') AS name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE (p.store_id = $1 OR (p.store_id IS NULL AND p.seller_id = $2))
         AND p.is_active = true AND p.is_deleted = false
       ORDER BY name`,
      [storeId, sellerId || storeId]
    );
 
    return sendSuccess(res, 200, 'Store products fetched', {
      products: result.rows.map(p => ({
        ...p,
        price:       parseFloat(p.price),
        avgRating:   parseFloat(p.avg_rating),
        reviewCount: parseInt(p.review_count),
      })),
      categories:  categoriesRes.rows.map(r => r.name),
      total:       parseInt(countRes.rows[0].count),
      page:        parseInt(page),
      limit:       parseInt(limit),
    });
  } catch (error) {
    console.error('Public store products error:', error);
    return sendError(res, 500, 'Error fetching store products', error);
  }
});

// ─── FIX 2: GET /api/seller/stores/public/:storeId ───────────────────────────
// Also fix product count to use seller_id fallback
router.get('/stores/public/:storeId', async (req, res) => {
  try {
    const { storeId } = req.params;
 
    const result = await db.query(
      `SELECT
          s.id             AS store_id,
          s.user_id        AS seller_id,
          s.store_number,
          s.business_name,
          s.business_description,
          s.business_address,
          s.business_email,
          s.business_phone,
          s.store_logo_url,
          s.website,
          s.facebook,
          s.twitter,
          s.instagram,
          s.tiktok,
          s.telegram,
          s.category,
          s.rating,
          s.total_reviews,
          s.total_sales,
          s.is_verified,
          s.created_at,
          u.first_name,
          u.last_name,
          u.avatar_url
       FROM stores s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = $1
         AND s.is_active = true
         AND s.is_deleted = false
         AND u.is_deleted = false`,
      [storeId]
    );
 
    if (result.rows.length === 0) {
      return sendError(res, 404, 'Store not found');
    }
 
    const row = result.rows[0];
 
    // Count products by store_id OR seller_id (legacy)
    const countRes = await db.query(
      `SELECT COUNT(*) FROM products
       WHERE (store_id = $1 OR (store_id IS NULL AND seller_id = $2))
         AND is_active = true AND is_deleted = false`,
      [storeId, row.seller_id]
    );
 
    return sendSuccess(res, 200, 'Store profile fetched', {
      store: {
        storeId:             row.store_id,
        sellerId:            row.seller_id,
        storeNumber:         row.store_number,
        businessName:        row.business_name,
        businessDescription: row.business_description,
        businessAddress:     row.business_address,
        businessEmail:       row.business_email,
        businessPhone:       row.business_phone,
        storeLogo:           row.store_logo_url,
        avatarUrl:           row.avatar_url,
        rating:              parseFloat(row.rating) || 0,
        totalReviews:        row.total_reviews || 0,
        totalSales:          row.total_sales || 0,
        isVerified:          row.is_verified,
        website:             row.website,
        category:            row.category,
        socialLinks: {
          facebook:  row.facebook,
          twitter:   row.twitter,
          instagram: row.instagram,
          tiktok:    row.tiktok,
          telegram:  row.telegram,
        },
        productCount: parseInt(countRes.rows[0].count),
        memberSince:  row.created_at,
        seller: {
          firstName: row.first_name,
          lastName:  row.last_name,
          avatarUrl: row.avatar_url,
        },
      },
    });
  } catch (error) {
    console.error('Public store profile error:', error);
    return sendError(res, 500, 'Error fetching store profile', error);
  }
});


// ─── GET /api/seller/public — list all active sellers with profiles ───────────
// Public endpoint — no auth required
router.get('/public', async (req, res) => {
  try {
    const { limit = 12, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const result = await db.query(
      `SELECT
          s.id             AS store_id,
          s.user_id        AS seller_id,
          s.business_name,
          s.business_description,
          s.rating,
          s.total_reviews,
          s.total_sales,
          s.is_verified,
          s.store_logo_url,
          s.category,
          (SELECT COUNT(*) FROM products p
           WHERE p.store_id = s.id AND p.is_active = true AND p.is_deleted = false
          ) AS product_count,
          (SELECT main_image_url FROM products p
           WHERE p.store_id = s.id AND p.is_active = true AND p.is_deleted = false
           ORDER BY p.created_at DESC LIMIT 1
          ) AS featured_product_image
       FROM stores s
       JOIN users u ON u.id = s.user_id
       WHERE s.is_active = true AND s.is_deleted = false
         AND u.is_deleted = false AND u.role = 'seller'
         AND s.business_name IS NOT NULL
       ORDER BY s.total_sales DESC NULLS LAST, s.rating DESC NULLS LAST, s.created_at DESC
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), offset]
    );

    const countRes = await db.query(
      `SELECT COUNT(*) FROM stores s JOIN users u ON u.id = s.user_id
       WHERE s.is_active = true AND s.is_deleted = false AND u.is_deleted = false AND u.role = 'seller'
         AND s.business_name IS NOT NULL`
    );

    return sendSuccess(res, 200, 'Sellers fetched', {
      sellers: result.rows.map(s => ({
        sellerId: s.seller_id,
        storeId: s.store_id,
        businessName: s.business_name,
        businessDescription: s.business_description,
        storeLogo: s.store_logo_url,
        featuredProductImage: s.featured_product_image,
        rating: parseFloat(s.rating) || 0,
        totalReviews: s.total_reviews || 0,
        totalSales: s.total_sales || 0,
        isVerified: s.is_verified,
        productCount: parseInt(s.product_count) || 0,
        category: s.category || null
      })),
      total: parseInt(countRes.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('List sellers error:', error);
    return sendError(res, 500, 'Error fetching sellers', error);
  }
});

//  GET /api/seller/public/:id ───────────────────────────────────────
// Fix product count fallback
router.get('/public/:id', async (req, res) => {
  try {
    const { id } = req.params;
 
    const result = await db.query(
      `SELECT
          s.id             AS store_id,
          s.user_id        AS seller_id,
          s.store_number,
          s.business_name,
          s.business_description,
          s.business_address,
          s.business_email,
          s.business_phone,
          s.store_logo_url,
          s.website,
          s.facebook,
          s.twitter,
          s.instagram,
          s.tiktok,
          s.telegram,
          s.category,
          s.rating,
          s.total_reviews,
          s.total_sales,
          s.is_verified,
          s.created_at,
          u.first_name,
          u.last_name,
          u.avatar_url
       FROM stores s
       JOIN users u ON u.id = s.user_id
       WHERE (s.id = $1 OR s.user_id = $1)
         AND s.is_active = true
         AND s.is_deleted = false
         AND u.is_deleted = false
       ORDER BY
         CASE WHEN s.id = $1 THEN 0 ELSE 1 END,
         s.store_number ASC
       LIMIT 1`,
      [id]
    );
 
    if (result.rows.length === 0) {
      return sendError(res, 404, 'Store not found');
    }
 
    const row = result.rows[0];
 
    const countRes = await db.query(
      `SELECT COUNT(*) FROM products
       WHERE (store_id = $1 OR (store_id IS NULL AND seller_id = $2))
         AND is_active = true AND is_deleted = false`,
      [row.store_id, row.seller_id]
    );
 
    return sendSuccess(res, 200, 'Store profile fetched', {
      store: {
        storeId:             row.store_id,
        sellerId:            row.seller_id,
        storeNumber:         row.store_number,
        businessName:        row.business_name || `${row.first_name} ${row.last_name}`,
        businessDescription: row.business_description,
        businessAddress:     row.business_address,
        businessEmail:       row.business_email,
        businessPhone:       row.business_phone,
        storeLogo:           row.store_logo_url,
        avatarUrl:           row.avatar_url,
        rating:              parseFloat(row.rating) || 0,
        totalReviews:        row.total_reviews || 0,
        totalSales:          row.total_sales || 0,
        isVerified:          row.is_verified,
        website:             row.website,
        category:            row.category,
        socialLinks: {
          facebook:  row.facebook,
          twitter:   row.twitter,
          instagram: row.instagram,
          tiktok:    row.tiktok,
          telegram:  row.telegram,
        },
        productCount: parseInt(countRes.rows[0].count),
        memberSince:  row.created_at,
        seller: {
          firstName: row.first_name,
          lastName:  row.last_name,
          avatarUrl: row.avatar_url,
        },
      },
    });
  } catch (error) {
    console.error('Public seller/store detail error:', error);
    return sendError(res, 500, 'Error fetching store profile', error);
  }
});

// ─── GET /api/seller/refund-cases — Fetch seller's refund cases ────────────────
router.get('/refund-cases', protect, isSeller, async (req, res) => {
  try {
    const sellerId = req.user.id;

    const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zfyoxmwwuwgvaevwlgzn.supabase.co';
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_SERVICE_KEY) {
      console.warn('⚠️ SUPABASE_SERVICE_KEY not configured. Refund cases will not be fetched.');
      return sendSuccess(res, 200, 'Refund cases (service key not configured)', []);
    }

    // Fetch refund cases from Supabase using service role key
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/refund_cases?select=*&seller_id=eq.${sellerId}&order=created_at.desc`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'apikey': SUPABASE_SERVICE_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      console.error(`Supabase fetch failed: ${response.status} ${response.statusText}`);
      const errorText = await response.text();
      console.error('Supabase error:', errorText);
      return sendError(res, response.status, 'Failed to fetch refund cases from Supabase', errorText);
    }

    const data = await response.json();
    // Enrich refund cases with local DB data (buyer name, total amount) when available
    const enriched = await Promise.all((data || []).map(async (c) => {
      try {
        const caseCopy = { ...c };

        // Resolve buyer name from local users table if missing
        if (!caseCopy.buyer_name && caseCopy.buyer_id) {
          try {
            const userRes = await db.query('SELECT first_name, last_name FROM users WHERE id = $1', [caseCopy.buyer_id]);
            if (userRes.rows.length > 0) {
              const row = userRes.rows[0];
              caseCopy.buyer_name = `${row.first_name || ''} ${row.last_name || ''}`.trim() || null;
            }
          } catch (err) {
            console.warn('⚠️ Could not resolve buyer name for refund case', caseCopy.id, err.message);
          }
        }

        // Resolve total amount from order_items if missing
        if ((caseCopy.total_amount === undefined || caseCopy.total_amount === null) && (caseCopy.order_item_id || caseCopy.order_id)) {
          try {
            if (caseCopy.order_item_id) {
              const itemRes = await db.query(
                'SELECT quantity, price_at_purchase FROM order_items WHERE id = $1 LIMIT 1',
                [caseCopy.order_item_id]
              );
              if (itemRes.rows.length > 0) {
                const r = itemRes.rows[0];
                caseCopy.total_amount = (parseFloat(r.quantity) || 1) * (parseFloat(r.price_at_purchase) || 0);
              }
            } else if (caseCopy.order_id) {
              // Fallback: sum order_items for the order (optionally filtered by seller_id)
              const itemsRes = await db.query(
                'SELECT quantity, price_at_purchase FROM order_items WHERE order_id = $1',
                [caseCopy.order_id]
              );
              if (itemsRes.rows.length > 0) {
                caseCopy.total_amount = itemsRes.rows.reduce((sum, r) => {
                  return sum + ((parseFloat(r.quantity) || 1) * (parseFloat(r.price_at_purchase) || 0));
                }, 0);
              }
            }
          } catch (err) {
            console.warn('⚠️ Could not resolve total_amount for refund case', caseCopy.id, err.message);
          }
        }

        // Fetch color, size, and product_snapshot from order_items for seller refund cases
        if (caseCopy.order_item_id) {
          try {
            const itemSpecRes = await db.query(
              'SELECT color, size, product_snapshot FROM order_items WHERE id = $1 LIMIT 1',
              [caseCopy.order_item_id]
            );
            if (itemSpecRes.rows.length > 0) {
              const r = itemSpecRes.rows[0];
              caseCopy.color = r.color ?? caseCopy.color ?? null;
              caseCopy.size = r.size ?? caseCopy.size ?? null;
              caseCopy.product_snapshot = r.product_snapshot ?? caseCopy.product_snapshot ?? null;
            }
          } catch (err) {
            console.warn('⚠️ Could not resolve specifications for refund case', caseCopy.id, err.message);
          }
        } else if (caseCopy.order_id) {
          try {
            const itemSpecRes = await db.query(
              'SELECT color, size, product_snapshot FROM order_items WHERE order_id = $1 LIMIT 1',
              [caseCopy.order_id]
            );
            if (itemSpecRes.rows.length > 0) {
              const r = itemSpecRes.rows[0];
              caseCopy.color = r.color ?? caseCopy.color ?? null;
              caseCopy.size = r.size ?? caseCopy.size ?? null;
              caseCopy.product_snapshot = r.product_snapshot ?? caseCopy.product_snapshot ?? null;
            }
          } catch (err) {
            console.warn('⚠️ Could not resolve specifications for refund case fallback', caseCopy.id, err.message);
          }
        }

        return caseCopy;
      } catch (err) {
        console.warn('⚠️ Failed to enrich refund case', c?.id, err?.message || err);
        return c;
      }
    }));

    return sendSuccess(res, 200, 'Refund cases fetched successfully', enriched);
  } catch (error) {
    console.error('Error fetching refund cases:', error);
    return sendError(res, 500, 'Error fetching refund cases', error.message);
  }
});

// ─── GET /api/seller/escrow ────────────────────────────────────────────────────
router.get('/escrow', protect, isSeller, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT et.id, et.order_id, et.amount, et.status,
              et.held_at, et.auto_release_at, et.released_at, et.notes
       FROM escrow_transactions et
       WHERE et.seller_id = $1
       ORDER BY et.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    return sendSuccess(res, 200, 'Escrow records', { escrows: result.rows });
  } catch (error) {
    console.error('Get escrow records error:', error);
    return sendError(res, 500, 'Error fetching escrow records', error.message);
  }
});

module.exports = router;
