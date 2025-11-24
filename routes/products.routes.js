const express = require('express');
const router = express.Router();

// Products routes placeholder
router.get('/', (req, res) => {
	res.json({ status: 'success', message: 'Products routes placeholder' });
});

module.exports = router;
