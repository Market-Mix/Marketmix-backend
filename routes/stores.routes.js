const express = require('express');
const router  = express.Router();
const {
  getMyStores,
  createStore,
  getStoreById,
  updateStore,
  getStoreStats,
  getPublicStore,
  getPublicStoreProducts,
} = require('../controllers/stores.controller');
const { protect }  = require('../middlewares/auth.middleware');
const { isSeller } = require('../middlewares/role.middleware');
const multer       = require('multer');
const { uploadToCloudinary } = require('../utils/cloudinary');

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Images only'));
  },
});

/* ── Public routes (no auth) ────────────────────────────────────────────── */
router.get('/public/:storeId',          getPublicStore);
router.get('/public/:storeId/products', getPublicStoreProducts);
router.get('/public-by-slug/:acctSlug/:storeSlug', async (req, res) => {
  const db = require('../config/db');
  const { sendSuccess, sendError } = require('../utils/response');
  const { acctSlug, storeSlug } = req.params;
  try {
    const r = await db.query(
      `SELECT s.id FROM stores s
       JOIN users u ON u.id = s.user_id
       WHERE u.account_slug = $1 AND s.slug = $2
         AND s.is_active = true AND s.is_deleted = false`,
      [acctSlug, storeSlug]
    );
    if (!r.rows.length) return sendError(res, 404, 'Store not found');
    req.params.storeId = r.rows[0].id;
    return require('../controllers/stores.controller').getPublicStore(req, res);
  } catch (err) {
    return sendError(res, 500, 'Error resolving store', err.message);
  }
});

/* ── Protected routes (seller only) ────────────────────────────────────── */
router.use(protect, isSeller);

// Logo upload via Cloudinary
router.post('/logo-upload', upload.single('file'), async (req, res) => {
  const { sendSuccess, sendError } = require('../utils/response');
  if (!req.file) return sendError(res, 400, 'No file provided');

  try {
    const fileUrl = await uploadToCloudinary(req.file.buffer, req.file.mimetype, 'store-logos');
    return sendSuccess(res, 200, 'Logo uploaded', { url: fileUrl });
  } catch (err) {
    return sendError(res, 500, 'Error uploading logo', err.message);
  }
});

router.get('/',              getMyStores);
router.post('/',             createStore);
router.get('/:storeId',      getStoreById);
router.put('/:storeId',      updateStore);
router.get('/:storeId/stats', getStoreStats);

module.exports = router;
