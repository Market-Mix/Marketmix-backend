/**
 * Category Utility Functions
 * Provides helper functions for managing product counts and category statistics
 */

const db = require('../config/db');

/**
 * Recalculate product count for a specific category
 * @param {number|string} categoryId - The category ID
 * @returns {Promise<Object>} Updated category data with new count
 */
async function recalculateCategoryCount(categoryId) {
  try {
    const result = await db.query(
      `UPDATE categories
       SET product_count = (
         SELECT COUNT(*) FROM products
         WHERE category_id = $1 AND is_active = true AND is_deleted = false
       ),
       updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, product_count;`,
      [categoryId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: 'Category not found' };
    }

    return {
      success: true,
      category: result.rows[0]
    };
  } catch (error) {
    console.error('Error recalculating category count:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Recalculate product counts for all categories
 * @returns {Promise<Object>} Summary of updated categories
 */
async function recalculateAllCategoryCounts() {
  try {
    const result = await db.query(
      `UPDATE categories
       SET product_count = (
         SELECT COUNT(*) FROM products
         WHERE category_id = categories.id 
           AND is_active = true 
           AND is_deleted = false
       ),
       updated_at = NOW()
       WHERE is_active = true AND is_deleted = false
       RETURNING id, name, product_count;`
    );

    return {
      success: true,
      categoriesUpdated: result.rowCount,
      categories: result.rows
    };
  } catch (error) {
    console.error('Error recalculating all category counts:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get categories with their product counts (useful for frontend)
 * @returns {Promise<Array>} List of categories with product counts
 */
async function getCategoriesWithCounts() {
  try {
    const result = await db.query(
      `SELECT id, name, description, product_count, is_active
       FROM categories
       WHERE is_active = true AND is_deleted = false
       ORDER BY name ASC;`
    );

    return {
      success: true,
      data: result.rows,
      count: result.rows.length
    };
  } catch (error) {
    console.error('Error fetching categories with counts:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Verify product counts are accurate (comparing stored vs actual)
 * @returns {Promise<Object>} Verification results
 */
async function verifyProductCounts() {
  try {
    const result = await db.query(
      `SELECT c.id, c.name, c.product_count as stored_count, 
              COUNT(p.id) as actual_count
       FROM categories c
       LEFT JOIN products p ON c.id = p.category_id 
                            AND p.is_active = true 
                            AND p.is_deleted = false
       WHERE c.is_active = true AND c.is_deleted = false
       GROUP BY c.id, c.name, c.product_count
       ORDER BY c.name;`
    );

    const discrepancies = result.rows.filter(
      row => parseInt(row.stored_count) !== parseInt(row.actual_count)
    );

    return {
      success: true,
      allAccurate: discrepancies.length === 0,
      totalCategories: result.rows.length,
      discrepancies: discrepancies,
      summary: result.rows
    };
  } catch (error) {
    console.error('Error verifying product counts:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  recalculateCategoryCount,
  recalculateAllCategoryCounts,
  getCategoriesWithCounts,
  verifyProductCounts
};
