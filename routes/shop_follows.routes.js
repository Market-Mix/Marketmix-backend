const express = require('express');
const router = express.Router();
const { followShop, unfollowShop, getFollowedShops, checkFollowStatus } = require('../controllers/shop_follows.controller');
const { protect } = require('../middlewares/auth.middleware');

router.use(protect);

router.get('/', getFollowedShops);
router.post('/:sellerId', followShop);
router.delete('/:sellerId', unfollowShop);
router.get('/:sellerId/status', checkFollowStatus);

module.exports = router;