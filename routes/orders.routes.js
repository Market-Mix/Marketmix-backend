const express = require('express');
const router = express.Router();

// Orders routes placeholder
router.get('/', (req, res) => {
	res.json({ status: 'success', message: 'Orders routes placeholder' });
});

module.exports = router;
