const express = require('express');
const router  = express.Router();
const {
  getShippingSettings,
  upsertShippingSettings,
  updateShippingSettings,
  deactivateShippingSettings,
} = require('../controllers/Vendor_shipping.controller');
const { protect }  = require('../middlewares/auth.middleware');
const { isSeller } = require('../middlewares/role.middleware');

router.use(protect, isSeller);

router.get('/',    getShippingSettings);
router.post('/',   upsertShippingSettings);
router.put('/:id', updateShippingSettings);
router.delete('/:id', deactivateShippingSettings);

module.exports = router;