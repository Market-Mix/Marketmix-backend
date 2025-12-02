/**
 * Cart UI Component Implementation Example
 * 
 * This file demonstrates how to implement cart UI with:
 * - Display cart items
 * - Update quantity buttons (+/-)
 * - Remove item buttons
 * - Cart totals
 * - Error handling and loading states
 * 
 * This can be adapted to React, Vue, or vanilla JavaScript
 */

// ============================================================================
// VANILLA JAVASCRIPT EXAMPLE
// ============================================================================

class CartUI {
  constructor(containerId, token) {
    this.container = document.getElementById(containerId);
    this.token = token;
    this.cartItems = [];
    this.isLoading = false;
  }

  /**
   * @desc Initialize cart UI - fetch and display cart
   */
  async init() {
    try {
      this.setLoading(true);
      await this.fetchAndDisplay();
    } catch (error) {
      this.showError('Failed to load cart');
    } finally {
      this.setLoading(false);
    }
  }

  /**
   * @desc Fetch cart from API and render
   */
  async fetchAndDisplay() {
    try {
      const response = await fetch('/api/cart', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });

      if (!response.ok) throw new Error('Failed to fetch cart');

      const data = await response.json();
      this.cartItems = data.data.items;
      this.totalPrice = data.data.totalPrice;
      this.totalItems = data.data.totalItems;

      this.render();
    } catch (error) {
      console.error('Fetch cart error:', error);
      this.showError(error.message);
    }
  }

  /**
   * @desc Render cart UI
   */
  render() {
    if (this.cartItems.length === 0) {
      this.container.innerHTML = `
        <div class="empty-cart">
          <p>Your cart is empty</p>
          <a href="/products" class="btn btn-primary">Continue Shopping</a>
        </div>
      `;
      return;
    }

    const itemsHTML = this.cartItems
      .map(item => this.renderCartItem(item))
      .join('');

    const html = `
      <div class="cart-container">
        <div class="cart-items">
          ${itemsHTML}
        </div>

        <div class="cart-summary">
          <div class="summary-row">
            <span>Subtotal:</span>
            <span>$${parseFloat(this.totalPrice).toFixed(2)}</span>
          </div>
          <div class="summary-row">
            <span>Shipping:</span>
            <span>Free</span>
          </div>
          <div class="summary-row total">
            <span>Total:</span>
            <span>$${parseFloat(this.totalPrice).toFixed(2)}</span>
          </div>
          <button class="btn btn-success btn-block" onclick="checkout()">
            Proceed to Checkout
          </button>
          <button class="btn btn-secondary btn-block" onclick="location.href='/products'">
            Continue Shopping
          </button>
        </div>
      </div>
    `;

    this.container.innerHTML = html;
    this.attachEventListeners();
  }

  /**
   * @desc Render individual cart item
   */
  renderCartItem(item) {
    return `
      <div class="cart-item" data-item-id="${item.id}">
        <div class="item-image">
          <img src="${item.image}" alt="${item.name}" />
        </div>

        <div class="item-details">
          <h4>${item.name}</h4>
          <p class="item-price">$${parseFloat(item.price).toFixed(2)}</p>
        </div>

        <div class="item-quantity">
          <button class="btn-qty-decrease" data-item-id="${item.id}">−</button>
          <input 
            type="number" 
            class="qty-input" 
            value="${item.quantity}" 
            min="1" 
            max="${item.stockAvailable}"
            data-item-id="${item.id}"
          />
          <button class="btn-qty-increase" data-item-id="${item.id}">+</button>
        </div>

        <div class="item-total">
          <p>$${parseFloat(item.totalPrice).toFixed(2)}</p>
          <small>${item.quantity} × $${parseFloat(item.price).toFixed(2)}</small>
        </div>

        <div class="item-actions">
          <button class="btn-remove" data-item-id="${item.id}" title="Remove item">
            🗑️ Remove
          </button>
        </div>
      </div>
    `;
  }

  /**
   * @desc Attach event listeners to dynamic elements
   */
  attachEventListeners() {
    // Increase quantity
    document.querySelectorAll('.btn-qty-increase').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const itemId = e.target.dataset.itemId;
        this.increaseQuantity(itemId);
      });
    });

    // Decrease quantity
    document.querySelectorAll('.btn-qty-decrease').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const itemId = e.target.dataset.itemId;
        this.decreaseQuantity(itemId);
      });
    });

    // Quantity input (manual entry)
    document.querySelectorAll('.qty-input').forEach(input => {
      input.addEventListener('change', (e) => {
        const itemId = e.target.dataset.itemId;
        const newQuantity = parseInt(e.target.value, 10);
        this.updateQuantity(itemId, newQuantity);
      });
    });

    // Remove item
    document.querySelectorAll('.btn-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const itemId = e.target.dataset.itemId;
        this.removeItem(itemId);
      });
    });
  }

  /**
   * @desc Handle increase quantity
   */
  async increaseQuantity(itemId) {
    const item = this.cartItems.find(i => i.id === itemId);
    if (!item) return;

    const newQuantity = item.quantity + 1;

    if (newQuantity > item.stockAvailable) {
      this.showError(`Cannot exceed available stock (${item.stockAvailable})`);
      return;
    }

    await this.updateQuantity(itemId, newQuantity);
  }

  /**
   * @desc Handle decrease quantity
   */
  async decreaseQuantity(itemId) {
    const item = this.cartItems.find(i => i.id === itemId);
    if (!item) return;

    const newQuantity = item.quantity - 1;

    if (newQuantity < 1) {
      this.showError('Quantity cannot be 0. Remove the item instead?');
      return;
    }

    await this.updateQuantity(itemId, newQuantity);
  }

  /**
   * @desc Update quantity for a cart item
   */
  async updateQuantity(itemId, newQuantity) {
    try {
      this.setLoading(true);

      const response = await fetch(`/api/cart/${itemId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ quantity: newQuantity })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to update quantity');
      }

      // Refresh cart display
      await this.fetchAndDisplay();
      this.showSuccess('Quantity updated');
    } catch (error) {
      console.error('Update quantity error:', error);
      this.showError(error.message);
    } finally {
      this.setLoading(false);
    }
  }

  /**
   * @desc Remove item from cart
   */
  async removeItem(itemId) {
    const item = this.cartItems.find(i => i.id === itemId);
    if (!item) return;

    // Ask for confirmation
    if (!confirm(`Remove "${item.name}" from cart?`)) {
      return;
    }

    try {
      this.setLoading(true);

      const response = await fetch(`/api/cart/${itemId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to remove item');
      }

      // Refresh cart display
      await this.fetchAndDisplay();
      this.showSuccess('Item removed');
    } catch (error) {
      console.error('Remove item error:', error);
      this.showError(error.message);
    } finally {
      this.setLoading(false);
    }
  }

  /**
   * @desc Show loading state
   */
  setLoading(isLoading) {
    this.isLoading = isLoading;
    if (isLoading) {
      this.container.classList.add('loading');
    } else {
      this.container.classList.remove('loading');
    }
  }

  /**
   * @desc Show error message
   */
  showError(message) {
    const errorEl = document.createElement('div');
    errorEl.className = 'alert alert-danger';
    errorEl.textContent = message;
    this.container.prepend(errorEl);

    setTimeout(() => errorEl.remove(), 5000);
  }

  /**
   * @desc Show success message
   */
  showSuccess(message) {
    const successEl = document.createElement('div');
    successEl.className = 'alert alert-success';
    successEl.textContent = message;
    this.container.prepend(successEl);

    setTimeout(() => successEl.remove(), 3000);
  }
}

// ============================================================================
// USAGE EXAMPLE
// ============================================================================

/*
// In your HTML file:
<div id="cart-container"></div>

// In your JavaScript:
const token = localStorage.getItem('authToken');
const cart = new CartUI('cart-container', token);
cart.init();
*/

// ============================================================================
// REACT COMPONENT EXAMPLE
// ============================================================================

/*
import React, { useState, useEffect } from 'react';

function CartComponent({ token }) {
  const [cartItems, setCartItems] = useState([]);
  const [totalPrice, setTotalPrice] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchCart();
  }, [token]);

  const fetchCart = async () => {
    try {
      setIsLoading(true);
      const response = await fetch('/api/cart', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      setCartItems(data.data.items);
      setTotalPrice(data.data.totalPrice);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateQuantity = async (itemId, newQuantity) => {
    try {
      const response = await fetch(`/api/cart/${itemId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ quantity: newQuantity })
      });
      await fetchCart(); // Refresh cart
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRemoveItem = async (itemId) => {
    try {
      const response = await fetch(`/api/cart/${itemId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      await fetchCart(); // Refresh cart
    } catch (err) {
      setError(err.message);
    }
  };

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div className="alert alert-danger">{error}</div>;

  return (
    <div className="cart-container">
      {cartItems.length === 0 ? (
        <p>Your cart is empty</p>
      ) : (
        <>
          {cartItems.map(item => (
            <div key={item.id} className="cart-item">
              <img src={item.image} alt={item.name} />
              <div>
                <h4>{item.name}</h4>
                <p>${parseFloat(item.price).toFixed(2)}</p>
              </div>
              <input
                type="number"
                value={item.quantity}
                onChange={(e) => handleUpdateQuantity(item.id, parseInt(e.target.value))}
              />
              <p>${parseFloat(item.totalPrice).toFixed(2)}</p>
              <button onClick={() => handleRemoveItem(item.id)}>Remove</button>
            </div>
          ))}
          <div className="cart-summary">
            <h3>Total: ${parseFloat(totalPrice).toFixed(2)}</h3>
            <button className="checkout-btn">Checkout</button>
          </div>
        </>
      )}
    </div>
  );
}

export default CartComponent;
*/

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CartUI;
}
