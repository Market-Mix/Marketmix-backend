/*
  React Cart Component Example
  - This is a minimal React functional component showing how to:
    - fetch cart items
    - update item quantity
    - remove item
  - It is intentionally self-contained (uses native fetch) so you can copy/adapt it
    into your app without changing other code.

  Usage:
    - Place this in your frontend project (e.g. src/components/CartComponent.jsx)
    - Provide a `getToken()` prop that returns the current JWT (string) or null.
    - Provide a `API_BASE` constant or env var if your backend URL differs.

  Notes:
    - The backend endpoints used are:
      GET  /api/cart
      PUT  /api/cart/:cartItemId
      DELETE /api/cart/:cartItemId
*/

import React, { useEffect, useState } from 'react';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

export default function CartComponent({ getToken }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchCart = async () => {
    setLoading(true);
    setError(null);
    const token = getToken && getToken();

    try {
      const res = await fetch(`${API_BASE}/cart`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${res.status}`);
      }

      const json = await res.json();
      setItems(json.data.items || []);
    } catch (err) {
      console.error('Fetch cart error', err);
      setError(err.message || 'Failed to fetch cart');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateQuantity = async (cartItemId, newQty) => {
    const token = getToken && getToken();
    try {
      const res = await fetch(`${API_BASE}/cart/${cartItemId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ quantity: newQty })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${res.status}`);
      }

      await fetchCart();
    } catch (err) {
      console.error('Update quantity failed', err);
      alert(err.message || 'Failed to update quantity');
    }
  };

  const removeItem = async (cartItemId) => {
    const token = getToken && getToken();
    if (!window.confirm('Remove this item from cart?')) return;

    try {
      const res = await fetch(`${API_BASE}/cart/${cartItemId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${res.status}`);
      }

      await fetchCart();
    } catch (err) {
      console.error('Remove item failed', err);
      alert(err.message || 'Failed to remove item');
    }
  };

  if (loading) return <div>Loading cart...</div>;
  if (error) return <div className="error">{error}</div>;

  return (
    <div className="cart-component">
      <h2>Your Cart</h2>
      {items.length === 0 && <div>Your cart is empty</div>}
      <ul>
        {items.map((it) => (
          <li key={it.id} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <img src={it.image} alt={it.name} style={{ width: 60, height: 60, objectFit: 'cover' }} />
            <div style={{ flex: 1 }}>
              <div>{it.name}</div>
              <div>Price: ${parseFloat(it.price).toFixed(2)}</div>
              <div>Subtotal: ${parseFloat(it.totalPrice).toFixed(2)}</div>
            </div>
            <div>
              <button onClick={() => updateQuantity(it.id, it.quantity - 1)} disabled={it.quantity <= 1}>-</button>
              <span style={{ padding: '0 8px' }}>{it.quantity}</span>
              <button onClick={() => updateQuantity(it.id, it.quantity + 1)} disabled={it.quantity >= it.stockAvailable}>+</button>
            </div>
            <div>
              <button onClick={() => removeItem(it.id)}>Remove</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
