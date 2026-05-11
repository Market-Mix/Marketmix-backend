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

/* ── Protected routes (seller only) ────────────────────────────────────── */
router.use(protect, isSeller);

// Logo upload — reuses same Supabase proxy pattern as KYC/product images
router.post('/logo-upload', upload.single('file'), async (req, res) => {
  const { sendSuccess, sendError } = require('../utils/response');
  if (!req.file) return sendError(res, 400, 'No file provided');

  const SUPABASE_URL         = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)
    return sendError(res, 500, 'Storage not configured');

  try {
    const ext      = req.file.originalname.split('.').pop() || 'jpg';
    const filename = `${req.user.id}-store${Date.now()}.${ext}`;

    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/store-logos/${filename}`,
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
      const err = await uploadRes.text();
      return sendError(res, 500, `Upload failed: ${err}`);
    }

    const fileUrl = `${SUPABASE_URL}/storage/v1/object/public/store-logos/${filename}`;
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