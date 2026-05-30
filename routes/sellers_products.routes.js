const express = require('express');
const router = express.Router();
const {
  upload,
  getSellerProducts,
  createSellerProduct,
  updateSellerProduct,
  deleteSellerProduct,
} = require('../controllers/sellers_products.controller');
const { protect } = require('../middlewares/auth.middleware');
const { isSeller } = require('../middlewares/role.middleware');

// All routes require auth + seller role
router.use(protect, isSeller);

router.get('/', getSellerProducts);
router.post('/', upload.array('images', 5), createSellerProduct);
router.put('/:productId', upload.array('images', 5), updateSellerProduct);
router.delete('/:productId', deleteSellerProduct);

module.exports = router;