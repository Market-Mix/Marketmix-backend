const express = require('express');
const router  = express.Router();
const { protect } = require('../middlewares/auth.middleware');

const {
  createOrResumeSession,
  getSession,
  applyCoupon,
  removeCoupon,
} = require('../controllers/checkout.controller');

const {
  getAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
  setSessionAddress,
} = require('../controllers/address.controller');

// ─── All checkout routes require authentication ───────────────────────────────
router.use(protect);

// ─── Session ─────────────────────────────────────────────────────────────────
// POST   /api/checkout/session              → create or resume
// GET    /api/checkout/session/:sessionId   → get full session
router.post('/session',                     createOrResumeSession);
router.get('/session/:sessionId',           getSession);

// ─── Coupon ──────────────────────────────────────────────────────────────────
// POST   /api/checkout/session/:sessionId/coupon   → apply
// DELETE /api/checkout/session/:sessionId/coupon   → remove
router.post('/session/:sessionId/coupon',   applyCoupon);
router.delete('/session/:sessionId/coupon', removeCoupon);

// ─── Address on session ───────────────────────────────────────────────────────
// POST   /api/checkout/session/:sessionId/address  → set address
router.post('/session/:sessionId/address',  setSessionAddress);

// ─── Address CRUD ─────────────────────────────────────────────────────────────
// GET    /api/checkout/addresses            → list saved addresses
// POST   /api/checkout/addresses            → create address
// PUT    /api/checkout/addresses/:addressId → update
// DELETE /api/checkout/addresses/:addressId → soft delete
router.get('/addresses',                    getAddresses);
router.post('/addresses',                   createAddress);
router.put('/addresses/:addressId',         updateAddress);
router.delete('/addresses/:addressId',      deleteAddress);

module.exports = router;