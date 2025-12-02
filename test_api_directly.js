// Test the API directly
const apiUrl = 'https://marketmix-backend-production.up.railway.app/api/products?limit=12';

console.log('Testing API: ' + apiUrl);

fetch(apiUrl)
  .then(res => {
    console.log('Status:', res.status);
    return res.json();
  })
  .then(data => {
    console.log('Response:', JSON.stringify(data, null, 2));
    if (data.data && data.data.length > 0) {
      console.log('\n✅ SUCCESS: Products found!');
      console.log(`First product: ${data.data[0].name} - $${data.data[0].price}`);
    } else {
      console.log('\n❌ No products in response');
    }
  })
  .catch(err => console.error('Error:', err.message));
