const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth.middleware');
const { isSeller, checkSellerActive } = require('../middlewares/role.middleware');
const { aiQuota } = require('../middlewares/aiQuota.middleware');
const { generateListing, getQuota } = require('../controllers/seller_ai.controller');

router.use(protect, isSeller, checkSellerActive);

router.get('/quota', aiQuota, getQuota);
router.post('/listing', aiQuota, generateListing);

module.exports = router;
