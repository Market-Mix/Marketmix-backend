const https = require('https');

const apiUrl = 'https://marketmix-backend-production.up.railway.app/api/products?limit=1';
let attempts = 0;
const maxAttempts = 8; // ~2 minutes with 15s intervals
const interval = 15000;

function checkDeployment() {
  attempts++;
  console.log(`\nAttempt ${attempts}/${maxAttempts}...`);

  https.get(apiUrl, { timeout: 5000 }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        console.log(`✅ Railway deployed! Status: ${json.status}`);
        console.log(`Message: ${json.message}`);
        console.log(`Products in response: ${json.data ? json.data.length : 0}`);
        process.exit(0);
      } catch (e) {
        console.log(`❌ Invalid JSON response: ${res.statusCode}`);
        retry();
      }
    });
  }).on('error', (err) => {
    console.log(`❌ Request failed: ${err.message}`);
    retry();
  });
}

function retry() {
  if (attempts >= maxAttempts) {
    console.log(`\nDeployment check timed out after ${maxAttempts} attempts.`);
    console.log('Railway may still be building. Check the Railway dashboard for logs.');
    process.exit(1);
  }
  setTimeout(checkDeployment, interval);
}

console.log('🚀 Checking Railway deployment...');
checkDeployment();
