const express = require('express');
const router = express.Router();

// Seller routes placeholder
router.get('/', (req, res) => {
	res.json({ status: 'success', message: 'Seller routes placeholder' });
});

module.exports = router;
