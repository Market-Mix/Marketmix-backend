// utils/sendEmail.js

console.log('sendEmail.js version: HTTPS-direct-v2');
const https = require('https');

async function sendEmail({ to, subject, html }) {
  console.log('sendEmail called →', to, subject);

  const body = JSON.stringify({
    sender: { email: process.env.FROM_EMAIL, name: process.env.EMAIL_FROM_NAME },
    to: [{ email: to }],
    subject,
    htmlContent: html,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Brevo response status:', res.statusCode, 'body:', data);
        if (res.statusCode >= 400) return reject(new Error(`Brevo error: ${data}`));
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Brevo parse error: ${data}`));
        }
      });
    });

    req.on('error', (e) => {
      console.error('sendEmail req error:', e.message);
      reject(e);
    });

    req.write(body);
    req.end();
  });
}

module.exports = sendEmail;