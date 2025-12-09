// controllers/category.controller.js
const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

// Get all active categories
const getAllCategories = async (req, res) => {
  try {
    const query = `
      SELECT * FROM categories 
      WHERE is_active = true AND is_deleted = false
      ORDER BY name ASC
    `;
    
    const result = await db.query(query);

    return sendSuccess(res, 200, 'Categories fetched successfully', result.rows, {
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching categories:', error);
    return sendError(res, 500, 'Error fetching categories', error.message);
  }
};

// Get single category by ID
const getCategoryById = async (req, res) => {
  try {
    const { id } = req.params;

    const query = `
      SELECT * FROM categories 
      WHERE id = $1 AND is_active = true AND is_deleted = false
    `;
    
    const result = await db.query(query, [id]);

    if (result.rows.length === 0) {
      return sendError(res, 404, 'Category not found');
    }

    return sendSuccess(res, 200, 'Category fetched successfully', result.rows[0]);
  } catch (error) {
    console.error('Error fetching category:', error);
    return sendError(res, 500, 'Error fetching category', error.message);
  }
};

// Get products by category
const getProductsByCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    // First verify category exists and is active
    const categoryQuery = `
      SELECT * FROM categories 
      WHERE id = $1 AND is_active = true AND is_deleted = false
    `;
    
    const categoryResult = await db.query(categoryQuery, [id]);

    if (categoryResult.rows.length === 0) {
      return sendError(res, 404, 'Category not found');
    }

    // Get products count
    const countQuery = `
      SELECT COUNT(*) FROM products 
      WHERE category_id = $1 AND is_active = true AND is_deleted = false
    `;
    
    const countResult = await db.query(countQuery, [id]);
    const totalCount = parseInt(countResult.rows[0].count);

    // Get products in this category with pagination
    const productsQuery = `
      SELECT * FROM products 
      WHERE category_id = $1 AND is_active = true AND is_deleted = false
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `;
    
    const productsResult = await db.query(productsQuery, [id, limit, offset]);

    return sendSuccess(res, 200, 'Products fetched successfully', productsResult.rows, {
      category: categoryResult.rows[0],
      pagination: {
        total: totalCount,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: totalCount > (parseInt(offset) + parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    return sendError(res, 500, 'Error fetching products', error.message);
  }
};

// Get categories with product count (uses stored count column, automatically updated by triggers)
const getCategoriesWithCount = async (req, res) => {
  try {
    const query = `
      SELECT 
        id,
        name,
        description,
        product_count,
        is_active,
        created_at,
        updated_at
      FROM categories
      WHERE is_active = true AND is_deleted = false
      ORDER BY name ASC
    `;
    
    const result = await db.query(query);

    return sendSuccess(res, 200, 'Categories with count fetched successfully', result.rows, {
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching categories with count:', error);
    return sendError(res, 500, 'Error fetching categories', error.message);
  }
};

// Search categories by name
const searchCategories = async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.trim().length === 0) {
      return sendSuccess(res, 200, 'No search query provided', []);
    }

    const searchQuery = `%${q.toLowerCase()}%`;

    let result;
    try {
      // Try full query with all columns
      const query = `
        SELECT 
          id,
          name,
          description,
          product_count,
          is_active,
          created_at,
          updated_at
        FROM categories
        WHERE is_active = true AND is_deleted = false 
        AND LOWER(name) LIKE $1
        ORDER BY name ASC
        LIMIT 50
      `;
      result = await db.query(query, [searchQuery]);
    } catch (columnError) {
      console.error('Full query failed, trying minimal columns:', columnError.message);
      // Fallback to minimal columns if some don't exist
      const query = `
        SELECT 
          id,
          name
        FROM categories
        WHERE is_active = true AND is_deleted = false 
        AND LOWER(name) LIKE $1
        ORDER BY name ASC
        LIMIT 50
      `;
      result = await db.query(query, [searchQuery]);
    }

    // Add default values for missing fields
    const categoriesWithDefaults = result.rows.map(c => ({
      ...c,
      description: c.description || '',
      product_count: c.product_count || 0,
      is_active: c.is_active !== false,
      created_at: c.created_at || new Date().toISOString(),
      updated_at: c.updated_at || new Date().toISOString()
    }));

    return sendSuccess(res, 200, 'Categories search successful', categoriesWithDefaults, {
      count: categoriesWithDefaults.length
    });
  } catch (error) {
    console.error('Error searching categories:', error);
    return sendError(res, 500, 'Error searching categories', error.message);
  }
};

module.exports = {
  getAllCategories,
  getCategoryById,
  getProductsByCategory,
  getCategoriesWithCount,
  searchCategories
};