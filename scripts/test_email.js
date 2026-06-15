// scripts/test_email.js
require('dotenv').config();
// at top of test_email.js, before calling notifySeller
console.log('BREVO_API_KEY set?', !!process.env.BREVO_API_KEY);
console.log('FROM_EMAIL:', process.env.FROM_EMAIL);
console.log('EMAIL_FROM_NAME:', process.env.EMAIL_FROM_NAME);
const { notifySeller } = require('../utils/sellerEmailService');

notifySeller('5ac5e337-2d00-4d08-a645-4e23eea0a262', 'newLogin', {
  ip: '127.0.0.1', device: 'Test', time: new Date().toLocaleString()
}).then(() => console.log('done')).catch(console.error);