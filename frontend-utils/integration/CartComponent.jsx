import React, { useEffect, useState } from 'react';
import getToken from './getToken';

const API_BASE = process.env.REACT_APP_API_URL || 'https://marketmix-backend-production.up.railway.app/api';

export default function CartComponent() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchCart = async () => {
    setLoading(true);
    setError(null);
    const token = getToken();

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

  useEffect(() => { fetchCart(); }, []);

  const updateQuantity = async (cartItemId, newQty) => {
    const token = getToken();
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
    const token = getToken();
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
