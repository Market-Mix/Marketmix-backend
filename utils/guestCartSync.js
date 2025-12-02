/**
 * Guest Cart Sync Module
 * Handles cart persistence for guest users and sync on login/logout
 */

const API_BASE_URL = window.API_BASE_URL || 'http://localhost:5000/api';

/**
 * Get guest cart from localStorage
 * @returns {Array} Array of cart items
 */
function getGuestCart() {
  try {
    const cart = localStorage.getItem('guestCart');
    return cart ? JSON.parse(cart) : [];
  } catch (error) {
    console.error('Error parsing guest cart:', error);
    return [];
  }
}

/**
 * Save guest cart to localStorage
 * @param {Array} items - Cart items to save
 */
function saveGuestCart(items) {
  try {
    localStorage.setItem('guestCart', JSON.stringify(items || []));
    console.log('✅ Guest cart saved to localStorage');
  } catch (error) {
    console.error('Error saving guest cart:', error);
  }
}

/**
 * Clear guest cart from localStorage
 */
function clearGuestCart() {
  try {
    localStorage.removeItem('guestCart');
    console.log('✅ Guest cart cleared');
  } catch (error) {
    console.error('Error clearing guest cart:', error);
  }
}

/**
 * Add item to guest cart
 * @param {Object} item - Item to add { product_id, quantity, name, image, price }
 */
function addToGuestCart(item) {
  const cart = getGuestCart();
  
  // Check if item already exists
  const existingIndex = cart.findIndex(i => i.product_id === item.product_id);
  
  if (existingIndex >= 0) {
    // Update quantity
    cart[existingIndex].quantity += item.quantity;
  } else {
    // Add new item
    cart.push(item);
  }
  
  saveGuestCart(cart);
  return cart;
}

/**
 * Remove item from guest cart
 * @param {string} productId - Product ID to remove
 */
function removeFromGuestCart(productId) {
  const cart = getGuestCart();
  const filtered = cart.filter(item => item.product_id !== productId);
  saveGuestCart(filtered);
  return filtered;
}

/**
 * Update item quantity in guest cart
 * @param {string} productId - Product ID
 * @param {number} quantity - New quantity
 */
function updateGuestCartItem(productId, quantity) {
  const cart = getGuestCart();
  const item = cart.find(i => i.product_id === productId);
  
  if (item) {
    if (quantity <= 0) {
      return removeFromGuestCart(productId);
    }
    item.quantity = quantity;
  }
  
  saveGuestCart(cart);
  return cart;
}

/**
 * Persist guest cart on logout
 * This saves the current cart to localStorage before clearing auth token
 * @returns {Promise<void>}
 */
async function persistCartOnLogout() {
  try {
    // Get current cart from DOM or API
    const cartItems = getCurrentCartItems() || getGuestCart();
    
    if (cartItems.length > 0) {
      saveGuestCart(cartItems);
      console.log(`✅ Guest cart persisted with ${cartItems.length} items on logout`);
      
      // Show notification
      showNotification(
        `Your cart (${cartItems.length} items) has been saved. It will sync when you log back in.`,
        'info',
        3000
      );
    } else {
      clearGuestCart();
    }
  } catch (error) {
    console.error('Error persisting cart on logout:', error);
  }
}

/**
 * Sync guest cart on login
 * Called after successful login to merge saved cart items with server
 * @param {string} token - JWT token
 * @returns {Promise<Object>} Merge result
 */
async function syncGuestCartOnLogin(token) {
  try {
    const guestCart = getGuestCart();
    
    if (!guestCart || guestCart.length === 0) {
      console.log('No guest cart to sync');
      return { mergedItems: [], adjustments: [] };
    }

    console.log(`📦 Syncing ${guestCart.length} items from guest cart...`);

    // Prepare items for merge (only send product_id and quantity)
    const items = guestCart.map(item => ({
      product_id: item.product_id,
      quantity: item.quantity
    }));

    const response = await fetch(`${API_BASE_URL}/cart/merge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ items })
    });

    if (!response.ok) {
      throw new Error(`Cart merge failed: ${response.status}`);
    }

    const data = await response.json();
    const { mergedItems = [], adjustments = [] } = data.data || {};

    // Show merge notifications if there were adjustments
    if (adjustments.length > 0) {
      const adjustmentMessages = adjustments
        .map(adj => `${adj.product_id}: adjusted to ${adj.adjusted_to || 'unavailable'}`)
        .join(', ');
      
      showNotification(
        `Some items in your cart were adjusted due to availability: ${adjustmentMessages}`,
        'warning',
        5000
      );
    } else {
      showNotification(`✅ Cart synced successfully with ${mergedItems.length} items`, 'success', 3000);
    }

    // Clear guest cart after successful sync
    clearGuestCart();
    
    return { mergedItems, adjustments };
  } catch (error) {
    console.error('Error syncing guest cart on login:', error);
    
    // Show error but don't fail login
    showNotification(
      'Unable to sync your saved cart. You can add items again.',
      'error',
      4000
    );
    
    return { mergedItems: [], adjustments: [] };
  }
}

/**
 * Get current cart items from DOM
 * Can be overridden by frontend to return actual cart state
 * @returns {Array|null}
 */
function getCurrentCartItems() {
  // This should be overridden in the frontend to return actual cart items
  // For now, return null to use localStorage
  return null;
}

/**
 * Handle logout with cart persistence
 * Called from logout button/handler
 * @returns {Promise<void>}
 */
async function handleLogoutWithCartPersistence() {
  try {
    // Persist cart before logout
    await persistCartOnLogout();

    // Then proceed with logout (token removal and redirect)
    // This should be implemented in the main auth.js
    console.log('Ready to logout');
  } catch (error) {
    console.error('Error during logout:', error);
  }
}

// Auto-sync on page load if user is logged in
document.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem('token');
  if (token && getGuestCart().length > 0) {
    // User is logged in and has a saved guest cart - sync it
    syncGuestCartOnLogin(token).catch(err => {
      console.error('Auto-sync failed:', err);
    });
  }
});

// Export functions if using ES6 modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getGuestCart,
    saveGuestCart,
    clearGuestCart,
    addToGuestCart,
    removeFromGuestCart,
    updateGuestCartItem,
    persistCartOnLogout,
    syncGuestCartOnLogin,
    handleLogoutWithCartPersistence,
    getCurrentCartItems
  };
}
