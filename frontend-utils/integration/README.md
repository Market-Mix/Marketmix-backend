Cart integration notes

1) Copy files
   - Copy `frontend-utils/integration/CartComponent.jsx` into your React app (for example `src/components/CartComponent.jsx`).
   - Copy `frontend-utils/integration/getToken.js` into your app (for example `src/utils/getToken.js`).

2) Environment
   - Set `REACT_APP_API_URL` in your frontend environment to the backend API base URL, e.g.
     REACT_APP_API_URL=https://marketmix-backend-production.up.railway.app/api

3) Usage (example)
   - Import and render the component in your cart page:

     import CartComponent from '../components/CartComponent';

     function CartPage(){
       return <div><CartComponent /></div>;
     }

4) Auth token
   - The helper expects a JWT token stored as `localStorage.setItem('token', '...')`.
   - If your app stores JWT elsewhere (Redux, cookies), update `getToken.js` to return it.

5) Notes
   - The component fetches `GET /api/cart` and calls `PUT /api/cart/:cartItemId` and `DELETE /api/cart/:cartItemId`.
   - Ensure your frontend sends the Authorization header and that the token is valid.
   - If you see `401` responses, check token expiration and that the token was issued by the same JWT secret as backend.

6) Quick test
   - Use `frontend-utils/test_cart_ui.html` if you want a standalone quick tester that doesn't depend on your frontend bundle.

If you want, I can adapt this component to your exact frontend structure (hooks, context, or auth provider) — tell me where your token is stored in your frontend and I will update `getToken.js` accordingly.
