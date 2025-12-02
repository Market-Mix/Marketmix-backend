require('dotenv').config();
const { generateToken } = require('./utils/jwt');
const fetch = globalThis.fetch || (async () => { throw new Error('No fetch available in this Node runtime'); });

(async () => {
  try {
    // Use an existing buyer from the DB (found earlier)
    const user = {
      id: '8cf78482-14c2-46af-8c07-97d2a5fb5d65',
      email: 'emmystyles33@gmail.com',
      role: 'buyer'
    };

    // Ensure JWT_EXPIRE is a valid value for this test (override if malformed in .env)
    process.env.JWT_EXPIRE = process.env.JWT_EXPIRE && process.env.JWT_EXPIRE.includes('*') ? '7d' : process.env.JWT_EXPIRE;
    const token = generateToken(user);

    const apiUrl = process.env.API_BASE_URL || 'https://marketmix-backend-production.up.railway.app';
    const url = `${apiUrl.replace(/\/$/, '')}/api/cart/merge`;

    const localCart = [
      { product_id: '<REPLACE_WITH_PRODUCT_ID_1>', quantity: 2 },
      { product_id: '<REPLACE_WITH_PRODUCT_ID_2>', quantity: 1 }
    ];

    console.log('Using API URL:', url);
    console.log('Token (first 8 chars):', token.slice(0,8));
    console.log('Posting merge with sample cart (please replace product ids in this script if needed)');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ items: localCart })
    });

    const data = await res.json().catch(() => ({}));
    console.log('Status:', res.status);
    console.log('Response:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Test error:', err.message || err);
  }
})();
