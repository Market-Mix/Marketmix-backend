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
router.post('/', upload.single('image'), createSellerProduct);
router.put('/:productId', upload.single('image'), updateSellerProduct);
router.delete('/:productId', deleteSellerProduct);

module.exports = router;