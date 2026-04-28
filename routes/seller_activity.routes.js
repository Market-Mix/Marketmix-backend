const express = require('express');
const router  = express.Router();
const { getSellerActivity } = require('../controllers/seller_activity.controller');
const { protect }           = require('../middlewares/auth.middleware');
const { isSeller }          = require('../middlewares/role.middleware');

router.use(protect, isSeller);

/**
 * GET /api/seller/activity
 * Returns paginated activity log for the authenticated seller.
 * Query params: limit (default 50, max 200), offset (default 0)
 */
router.get('/', getSellerActivity);

module.exports = router;