

const express = require('express');
const router  = express.Router();
const { getDeliveryOptions, selectDelivery } = require('../controllers/checkout_delivery.controller');
const { protect } = require('../middlewares/auth.middleware');

router.use(protect);

// GET  /api/checkout/session/:sessionId/delivery/options
router.get('/session/:sessionId/delivery/options', getDeliveryOptions);

// POST /api/checkout/session/:sessionId/delivery
router.post('/session/:sessionId/delivery', selectDelivery);

module.exports = router;