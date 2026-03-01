// Simple manual test for OTP endpoints
// Usage: 
//   node test_send_otp.js
// Make sure your backend is running (npm run dev) and environment variables are set.

const fetch = require('node-fetch');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:5000/api';

async function main() {
  const email = process.env.TEST_OTP_EMAIL || 'user@example.com';

  console.log('Sending OTP to', email);
  const res = await fetch(`${API_BASE}/auth/send-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  const data = await res.json().catch(() => ({}));
  console.log('status', res.status, data);
  if (data.previewURL) {
    console.log('Preview URL (Ethereal):', data.previewURL);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});