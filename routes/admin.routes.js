const express = require('express');
const router = express.Router();

// Admin routes placeholder
router.get('/', (req, res) => {
	res.json({ status: 'success', message: 'Admin routes placeholder' });
});

module.exports = router;
