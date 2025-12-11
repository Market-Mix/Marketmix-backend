/**
 * Flash Sale Helper Utility
 * 
 * Provides functions to check flash sale status and calculate effective prices
 * with flash sale discounts applied.
 * 
 * Usage:
 * const { isFlashSaleActive, getEffectivePrice } = require('./utils/flashSaleHelper');
 * 
 * if (isFlashSaleActive(product.flash_start, product.flash_end)) {
 *   const discountedPrice = getEffectivePrice(product.price, product.flash_price);
 * }
 */

/**
 * Check if a product is currently in a flash sale period
 * 
 * @param {string|Date|null} flashStart - Flash sale start timestamp (ISO string or Date object)
 * @param {string|Date|null} flashEnd - Flash sale end timestamp (ISO string or Date object)
 * @returns {boolean} true if current time is within flash sale period, false otherwise
 * 
 * @example
 * const isActive = isFlashSaleActive(product.flash_start, product.flash_end);
 * if (isActive) {
 *   console.log('Product is on flash sale!');
 * }
 */
function isFlashSaleActive(flashStart, flashEnd) {
  // If either timestamp is null/undefined, no flash sale
  if (!flashStart || !flashEnd) {
    return false;
  }

  try {
    // Convert to Date objects if they're strings
    const startDate = typeof flashStart === 'string' ? new Date(flashStart) : flashStart;
    const endDate = typeof flashEnd === 'string' ? new Date(flashEnd) : flashEnd;

    // Validate dates
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return false;
    }

    const now = new Date();

    // Check if current time is between start and end
    return now >= startDate && now <= endDate;
  } catch (error) {
    console.error('Error checking flash sale status:', error.message);
    return false;
  }
}

/**
 * Get the effective price considering flash sale discount
 * 
 * Returns the flash_price if provided and flash sale is active,
 * otherwise returns the regular price
 * 
 * @param {number} regularPrice - Regular product price
 * @param {number|null|undefined} flashPrice - Flash sale discounted price (optional)
 * @param {boolean} isActive - Whether flash sale is currently active
 * @returns {Object} { price: number, isFlashPrice: boolean, savings: number|null }
 * 
 * @example
 * const priceInfo = getEffectivePrice(100, 75, true);
 * console.log(priceInfo);
 * // Output: { price: 75, isFlashPrice: true, savings: 25 }
 */
function getEffectivePrice(regularPrice, flashPrice, isActive) {
  // If flash sale is not active or no flash price provided, return regular price
  if (!isActive || flashPrice === null || flashPrice === undefined) {
    return {
      price: regularPrice,
      isFlashPrice: false,
      savings: null,
      originalPrice: null
    };
  }

  const savings = regularPrice - flashPrice;
  const savingsPercent = ((savings / regularPrice) * 100).toFixed(1);

  return {
    price: flashPrice,
    isFlashPrice: true,
    savings: savings,
    savingsPercent: savingsPercent,
    originalPrice: regularPrice
  };
}

/**
 * Format flash sale information for API responses
 * 
 * @param {string|Date|null} flashStart - Flash sale start timestamp
 * @param {string|Date|null} flashEnd - Flash sale end timestamp
 * @param {number} regularPrice - Regular product price
 * @param {number|null} flashPrice - Flash sale price (optional)
 * @returns {Object} Formatted flash sale info with all necessary fields
 * 
 * @example
 * const flashInfo = formatFlashSaleInfo(
 *   product.flash_start,
 *   product.flash_end,
 *   product.price,
 *   product.flash_price
 * );
 */
function formatFlashSaleInfo(flashStart, flashEnd, regularPrice, flashPrice = null) {
  const isActive = isFlashSaleActive(flashStart, flashEnd);
  const priceInfo = getEffectivePrice(regularPrice, flashPrice, isActive);

  // Calculate time remaining if flash sale is active
  let timeRemaining = null;
  let timeRemainingMs = null;

  if (isActive && flashEnd) {
    try {
      const endDate = typeof flashEnd === 'string' ? new Date(flashEnd) : flashEnd;
      const now = new Date();
      timeRemainingMs = endDate.getTime() - now.getTime();
      
      if (timeRemainingMs > 0) {
        // Convert to human-readable format
        const hours = Math.floor(timeRemainingMs / (1000 * 60 * 60));
        const minutes = Math.floor((timeRemainingMs % (1000 * 60 * 60)) / (1000 * 60));
        timeRemaining = `${hours}h ${minutes}m`;
      }
    } catch (error) {
      console.error('Error calculating time remaining:', error.message);
    }
  }

  return {
    isFlashSaleActive: isActive,
    flashStart: flashStart,
    flashEnd: flashEnd,
    currentPrice: priceInfo.price,
    originalPrice: priceInfo.originalPrice,
    savings: priceInfo.savings,
    savingsPercent: priceInfo.savingsPercent,
    isFlashPrice: priceInfo.isFlashPrice,
    timeRemaining: timeRemaining,
    timeRemainingMs: timeRemainingMs
  };
}

/**
 * Check if a product's flash sale has recently expired
 * Returns true if flash sale just ended (within last 5 minutes)
 * 
 * @param {string|Date|null} flashEnd - Flash sale end timestamp
 * @param {number} bufferMinutes - Buffer time in minutes (default: 5)
 * @returns {boolean} true if flash sale recently expired
 */
function hasFlashSaleExpired(flashEnd, bufferMinutes = 5) {
  if (!flashEnd) {
    return false;
  }

  try {
    const endDate = typeof flashEnd === 'string' ? new Date(flashEnd) : flashEnd;
    if (isNaN(endDate.getTime())) {
      return false;
    }

    const now = new Date();
    const timeSinceExpiry = now.getTime() - endDate.getTime();
    const bufferMs = bufferMinutes * 60 * 1000;

    return timeSinceExpiry >= 0 && timeSinceExpiry <= bufferMs;
  } catch (error) {
    console.error('Error checking flash sale expiry:', error.message);
    return false;
  }
}

/**
 * Get all flash sale products from a list of products
 * 
 * @param {Array} products - Array of product objects with flash_start and flash_end
 * @returns {Array} Products that are currently in flash sale period
 */
function getActiveFlashSaleProducts(products) {
  if (!Array.isArray(products)) {
    return [];
  }

  return products.filter(product => 
    isFlashSaleActive(product.flash_start, product.flash_end)
  );
}

/**
 * Calculate flash sale statistics for a set of products
 * 
 * @param {Array} products - Array of product objects
 * @returns {Object} Statistics about flash sales in the product set
 */
function getFlashSaleStats(products) {
  if (!Array.isArray(products)) {
    return {
      totalProducts: 0,
      productsWithFlashSale: 0,
      activeFlashSales: 0,
      percentageWithFlashSale: 0
    };
  }

  const productsWithFlashSale = products.filter(p => p.flash_start || p.flash_end).length;
  const activeFlashSales = products.filter(p => 
    isFlashSaleActive(p.flash_start, p.flash_end)
  ).length;

  return {
    totalProducts: products.length,
    productsWithFlashSale: productsWithFlashSale,
    activeFlashSales: activeFlashSales,
    percentageWithFlashSale: (productsWithFlashSale / products.length * 100).toFixed(1),
    percentageActive: (activeFlashSales / products.length * 100).toFixed(1)
  };
}

module.exports = {
  isFlashSaleActive,
  getEffectivePrice,
  formatFlashSaleInfo,
  hasFlashSaleExpired,
  getActiveFlashSaleProducts,
  getFlashSaleStats
};
