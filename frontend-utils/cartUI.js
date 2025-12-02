/**
 * Cart UI Utilities
 * 
 * This file provides frontend utilities for handling cart operations:
 * - Update cart item quantity
 * - Remove cart item from cart
 * - Display cart items in UI
 * - Handle errors and loading states
 * 
 * Usage: Import these functions in your cart page/component
 * Example: const { updateQuantity, removeItem } = require('./cartUI');
 */

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

/**
 * @desc    Update a cart item's quantity
 * @param   {string} cartItemId - The ID of the cart item to update
 * @param   {number} newQuantity - The new quantity value
 * @param   {string} token - JWT authentication token
 * @returns {Promise<Object>} - Response with updated cart item data
 * 
 * @example
 * const response = await updateQuantity('cart-item-123', 5, token);
 * console.log(response.cartItem); // { id, productId, quantity, price, totalPrice, ... }
 */
const updateQuantity = async (cartItemId, newQuantity, token) => {
  try {
    // Validate inputs
    if (!cartItemId || !newQuantity) {
      throw new Error('Cart item ID and quantity are required');
    }

    if (newQuantity < 1 || !Number.isInteger(newQuantity)) {
      throw new Error('Quantity must be a positive integer');
    }

    if (!token) {
      throw new Error('Authentication token is required');
    }

    // Make API request
    const response = await fetch(`${API_BASE}/cart/${cartItemId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ quantity: newQuantity })
    });

    // Handle response
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || `Failed to update quantity: ${response.status}`);
    }

    const data = await response.json();
    
    // Return success response with updated item
    return {
      success: true,
      message: data.message,
      cartItem: data.data.cartItem
    };
  } catch (error) {
    console.error('Error updating quantity:', error);
    return {
      success: false,
      message: error.message,
      error: error
    };
  }
};

/**
 * @desc    Remove a cart item from the cart
 * @param   {string} cartItemId - The ID of the cart item to remove
 * @param   {string} token - JWT authentication token
 * @returns {Promise<Object>} - Response with success status
 * 
 * @example
 * const response = await removeItem('cart-item-123', token);
 * if (response.success) {
 *   console.log('Item removed successfully');
 *   // Refresh cart display
 * }
 */
const removeItem = async (cartItemId, token) => {
  try {
    // Validate inputs
    if (!cartItemId) {
      throw new Error('Cart item ID is required');
    }

    if (!token) {
      throw new Error('Authentication token is required');
    }

    // Make API request
    const response = await fetch(`${API_BASE}/cart/${cartItemId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    // Handle response
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || `Failed to remove item: ${response.status}`);
    }

    const data = await response.json();
    
    // Return success response
    return {
      success: true,
      message: data.message
    };
  } catch (error) {
    console.error('Error removing item:', error);
    return {
      success: false,
      message: error.message,
      error: error
    };
  }
};

/**
 * @desc    Clear the entire cart (remove all items)
 * @param   {string} token - JWT authentication token
 * @returns {Promise<Object>} - Response with success status
 * 
 * @example
 * const response = await clearCart(token);
 * if (response.success) {
 *   console.log('Cart cleared');
 *   // Reset UI
 * }
 */
const clearCart = async (token) => {
  try {
    // Validate inputs
    if (!token) {
      throw new Error('Authentication token is required');
    }

    // Make API request
    const response = await fetch(`${API_BASE}/cart`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    // Handle response
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || `Failed to clear cart: ${response.status}`);
    }

    const data = await response.json();
    
    // Return success response
    return {
      success: true,
      message: data.message
    };
  } catch (error) {
    console.error('Error clearing cart:', error);
    return {
      success: false,
      message: error.message,
      error: error
    };
  }
};

/**
 * @desc    Fetch current cart items from server
 * @param   {string} token - JWT authentication token
 * @returns {Promise<Object>} - Cart data with items and totals
 * 
 * @example
 * const response = await fetchCart(token);
 * console.log(response.items); // Array of cart items
 * console.log(response.totalPrice); // Total cart value
 */
const fetchCart = async (token) => {
  try {
    // Validate inputs
    if (!token) {
      throw new Error('Authentication token is required');
    }

    // Make API request
    const response = await fetch(`${API_BASE}/cart`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    // Handle response
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || `Failed to fetch cart: ${response.status}`);
    }

    const data = await response.json();
    
    // Return cart data
    return {
      success: true,
      items: data.data.items,
      totalItems: data.data.totalItems,
      totalPrice: data.data.totalPrice
    };
  } catch (error) {
    console.error('Error fetching cart:', error);
    return {
      success: false,
      message: error.message,
      error: error,
      items: [],
      totalItems: 0,
      totalPrice: 0
    };
  }
};

/**
 * @desc    UI Helper: Handle quantity increase button click
 * @param   {Object} cartItem - The cart item object
 * @param   {number} maxStock - Maximum available stock
 * @param   {string} token - JWT authentication token
 * @param   {Function} onSuccess - Callback function on successful update
 * @returns {Promise<void>}
 * 
 * @example
 * handleIncreaseQuantity(cartItem, product.stock, token, () => {
 *   // Refresh cart display
 *   fetchAndDisplayCart();
 * });
 */
const handleIncreaseQuantity = async (cartItem, maxStock, token, onSuccess) => {
  try {
    const newQuantity = cartItem.quantity + 1;

    // Validate stock limit
    if (newQuantity > maxStock) {
      alert(`Cannot exceed available stock (${maxStock})`);
      return;
    }

    // Show loading state (UI responsibility)
    // e.g., disable button, show spinner

    // Update quantity
    const result = await updateQuantity(cartItem.id, newQuantity, token);

    if (result.success) {
      // Call success callback
      if (typeof onSuccess === 'function') {
        onSuccess(result.cartItem);
      }
    } else {
      alert(`Error: ${result.message}`);
    }
  } catch (error) {
    console.error('Error increasing quantity:', error);
    alert('Failed to update quantity');
  }
};

/**
 * @desc    UI Helper: Handle quantity decrease button click
 * @param   {Object} cartItem - The cart item object
 * @param   {string} token - JWT authentication token
 * @param   {Function} onSuccess - Callback function on successful update
 * @returns {Promise<void>}
 * 
 * @example
 * handleDecreaseQuantity(cartItem, token, () => {
 *   // Refresh cart display
 *   fetchAndDisplayCart();
 * });
 */
const handleDecreaseQuantity = async (cartItem, token, onSuccess) => {
  try {
    const newQuantity = cartItem.quantity - 1;

    // Prevent quantity below 1
    if (newQuantity < 1) {
      // Suggest removal instead
      alert('Quantity cannot be 0. Remove the item instead?');
      return;
    }

    // Show loading state
    // e.g., disable button, show spinner

    // Update quantity
    const result = await updateQuantity(cartItem.id, newQuantity, token);

    if (result.success) {
      // Call success callback
      if (typeof onSuccess === 'function') {
        onSuccess(result.cartItem);
      }
    } else {
      alert(`Error: ${result.message}`);
    }
  } catch (error) {
    console.error('Error decreasing quantity:', error);
    alert('Failed to update quantity');
  }
};

/**
 * @desc    UI Helper: Handle remove item button click with confirmation
 * @param   {Object} cartItem - The cart item object
 * @param   {string} token - JWT authentication token
 * @param   {Function} onSuccess - Callback function on successful removal
 * @returns {Promise<void>}
 * 
 * @example
 * handleRemoveItem(cartItem, token, () => {
 *   // Refresh cart display
 *   fetchAndDisplayCart();
 * });
 */
const handleRemoveItem = async (cartItem, token, onSuccess) => {
  try {
    // Ask for confirmation
    const confirmed = window.confirm(
      `Are you sure you want to remove "${cartItem.name}" from your cart?`
    );

    if (!confirmed) {
      return; // User cancelled
    }

    // Show loading state
    // e.g., disable button, show spinner

    // Remove item
    const result = await removeItem(cartItem.id, token);

    if (result.success) {
      // Call success callback
      if (typeof onSuccess === 'function') {
        onSuccess();
      }
    } else {
      alert(`Error: ${result.message}`);
    }
  } catch (error) {
    console.error('Error removing item:', error);
    alert('Failed to remove item');
  }
};

/**
 * @desc    Format cart item for display
 * @param   {Object} cartItem - The cart item from API response
 * @returns {Object} - Formatted cart item for UI display
 * 
 * @example
 * const formatted = formatCartItem(cartItem);
 * // { 
 * //   id, productId, name, image, price, quantity, 
 * //   totalPrice (formatted), stockAvailable 
 * // }
 */
const formatCartItem = (cartItem) => {
  return {
    id: cartItem.id,
    productId: cartItem.productId,
    name: cartItem.name,
    image: cartItem.image,
    price: parseFloat(cartItem.price).toFixed(2),
    quantity: cartItem.quantity,
    totalPrice: parseFloat(cartItem.totalPrice).toFixed(2),
    stockAvailable: cartItem.stockAvailable
  };
};

/**
 * @desc    Validate quantity input from user
 * @param   {string|number} input - The quantity input from user
 * @param   {number} maxStock - Maximum available stock
 * @returns {Object} - { valid: boolean, value: number, error: string }
 * 
 * @example
 * const validation = validateQuantityInput("5", 10);
 * if (validation.valid) {
 *   // Use validation.value
 * } else {
 *   // Show validation.error to user
 * }
 */
const validateQuantityInput = (input, maxStock) => {
  const value = parseInt(input, 10);

  // Check if valid number
  if (isNaN(value)) {
    return {
      valid: false,
      value: null,
      error: 'Please enter a valid number'
    };
  }

  // Check minimum quantity
  if (value < 1) {
    return {
      valid: false,
      value: null,
      error: 'Quantity must be at least 1'
    };
  }

  // Check maximum stock
  if (value > maxStock) {
    return {
      valid: false,
      value: null,
      error: `Cannot exceed available stock (${maxStock})`
    };
  }

  return {
    valid: true,
    value: value,
    error: null
  };
};

// Export all functions
module.exports = {
  // Core API functions
  updateQuantity,
  removeItem,
  clearCart,
  fetchCart,

  // UI helper functions
  handleIncreaseQuantity,
  handleDecreaseQuantity,
  handleRemoveItem,

  // Utility functions
  formatCartItem,
  validateQuantityInput
};
