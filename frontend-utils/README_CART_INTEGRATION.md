Cart UI Integration - MarketMix

Overview
--------
This document explains how to integrate the cart UI utilities into your frontend (React/Vue/Vanilla) safely, how to wire the JWT, and how to test update/remove/clear flows locally and in production.

Files included in this repo (use as reference or copy into your frontend project)
- `frontend-utils/cartUI.js` - Promise-based helpers (CommonJS). You can adapt to ESM when copying into a modern frontend project.
- `frontend-utils/CartComponent.react.js` - Minimal React component example using native `fetch` so it won't conflict with your build system.
- `frontend-utils/test_cart_ops.js` - Node script to run local smoke tests (requires `TEST_TOKEN` and `TEST_PRODUCT_ID` environment variables).

Integration steps (React)
-------------------------
1. Copy helpers or use the logic from `cartUI.js` inside your frontend codebase (e.g. `src/utils/cart.js`).
   - If your project uses ESM imports, convert `module.exports` to `export` syntax.
2. Ensure your frontend attaches the JWT to requests as `Authorization: Bearer <token>`.
   - If you store JWT in `localStorage`, `sessionStorage`, or in app state, pass a small function `getToken()` into the cart component or use your app's auth layer.
3. Use the provided `CartComponent.react.js` example as a starting point. It uses `getToken()` prop to obtain the current token.
4. Handle UI loading states and errors where appropriate — the helpers return success/failure responses and messages.

API endpoints used
------------------
- GET `/api/cart` - returns cart items and totals
- POST `/api/cart/add` - add an item to user's cart (used by product pages)
- PUT `/api/cart/:cartItemId` - update quantity for a cart item
- DELETE `/api/cart/:cartItemId` - remove a cart item
- DELETE `/api/cart` - clear the cart
- POST `/api/cart/merge` - merge guest cart to server cart on login

Curl examples
-------------
Replace `<TOKEN>` and `<CART_ITEM_ID>` as needed.

Fetch cart
```bash
curl -H "Authorization: Bearer <TOKEN>" https://your-backend-domain/api/cart
```

Update quantity
```bash
curl -X PUT -H "Content-Type: application/json" -H "Authorization: Bearer <TOKEN>" \
  -d '{"quantity":3}' https://your-backend-domain/api/cart/<CART_ITEM_ID>
```

Remove item
```bash
curl -X DELETE -H "Authorization: Bearer <TOKEN>" https://your-backend-domain/api/cart/<CART_ITEM_ID>
```

Clear cart
```bash
curl -X DELETE -H "Authorization: Bearer <TOKEN>" https://your-backend-domain/api/cart
```

Local testing (recommended order)
---------------------------------
1. Start your backend locally:
```powershell
cd "d:\MARKETMIX BACKEND\Marketmix-backend"
node server.js
```
2. Use the `CartComponent.react.js` in your frontend and run your frontend locally so the browser can test flows against `http://localhost:5000/api`.
3. Or run the Node smoke test (see below). You must provide a valid JWT with a user that exists in your DB and a `TEST_PRODUCT_ID` that exists and has stock.

Node smoke test
---------------
Create environment variables and run the provided test script:

Windows PowerShell example
```powershell
$env:TEST_API_URL = "http://localhost:5000/api"
$env:TEST_TOKEN = "<YOUR_TEST_JWT>"
$env:TEST_PRODUCT_ID = "<PRODUCT_ID_TO_ADD>"
node frontend-utils/test_cart_ops.js
```

The script will:
- Fetch current cart
- Add the `TEST_PRODUCT_ID` with quantity 1
- Update the newly created cart item quantity to 2
- Remove the item

If any step fails, it prints details to the console.

Safety notes
------------
- Do not modify backend endpoints or DB models from the frontend; only call the APIs.
- When integrating into an existing frontend, keep the new code bounded to a single module/file and import it; do not change global app configuration.
- Convert CommonJS to ESM before dropping into most modern frontends (CRA, Vite, Next.js) if needed.

If you want, I can:
- Run the node smoke test locally (I will need a test JWT and a product id), or
- Convert `cartUI.js` to an ES module flavor for direct copying into a React/Vite/Next project.
