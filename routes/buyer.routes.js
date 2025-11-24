const express = require('express');
const router = express.Router();

// Buyer routes placeholder
router.get('/', (req, res) => {
	res.json({ status: 'success', message: 'Buyer routes placeholder' });
});

module.exports = router;
