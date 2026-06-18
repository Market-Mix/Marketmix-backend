// scripts/test_sendbox.js
require('dotenv').config();
const sendbox = require('../adapter/providers/sendbox');

(async () => {
  try {
    const quotes = await sendbox.getQuotes('test-session', [
      { seller_id: '0e977220-9f40-4c74-bafd-9b69264b7483', name: 'Test Item', price: 5000, quantity: 1, weight_kg: 1 }
    ], {
      full_name: 'Test Buyer', phone: '08000000000',
      address_line1: '12 Test Street', city: 'Owerri', state: 'Imo'
    });
    console.log('✅ quotes:', quotes);
 } catch (err) {
  console.error('❌ failed:', err.message, err.cause || '');
}
})();