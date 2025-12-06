// ============================================
// PAYMENT METHODS CONTROLLER (PostgreSQL)
// ============================================

const db = require('../config/db');

// Get all payment methods for authenticated user
exports.getAllPaymentMethods = async (req, res) => {
  try {
    const query = `
      SELECT * FROM payment_methods
      WHERE user_id = $1
      ORDER BY is_default DESC, created_at DESC
    `;

    const result = await db.query(query, [req.user.id]);

    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching payment methods:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch payment methods'
    });
  }
};

// Get single payment method by ID
exports.getPaymentMethodById = async (req, res) => {
  try {
    const query = `
      SELECT * FROM payment_methods
      WHERE id = $1 AND user_id = $2
    `;

    const result = await db.query(query, [req.params.id, req.user.id]);

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Payment method not found'
      });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error fetching payment method:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch payment method'
    });
  }
};

// Create new payment method
exports.createPaymentMethod = async (req, res) => {
  try {
    const {
      payment_type,
      masked_number,
      cardholder_name,
      extra_info,
      billing_address,
      branch,
      is_default
    } = req.body;

    if (!payment_type || !masked_number || !cardholder_name) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // If new default → unset all others
    if (is_default) {
      await db.query(
        `UPDATE payment_methods SET is_default=false WHERE user_id=$1`,
        [req.user.id]
      );
    }

    const query = `
      INSERT INTO payment_methods 
      (user_id, payment_type, masked_number, cardholder_name, extra_info,
       billing_address, branch, is_default)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `;

    const values = [
      req.user.id,
      payment_type,
      masked_number,
      cardholder_name,
      extra_info,
      payment_type === 'Card' ? billing_address : null,
      payment_type === 'Bank' ? branch : null,
      is_default || false
    ];

    const result = await db.query(query, values);

    res.status(201).json({
      success: true,
      data: result.rows[0],
      message: 'Payment method added successfully'
    });
  } catch (error) {
    console.error('Error adding payment method:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add payment method'
    });
  }
};

// Update payment method
exports.updatePaymentMethod = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      payment_type,
      masked_number,
      cardholder_name,
      extra_info,
      billing_address,
      branch,
      is_default
    } = req.body;

    // Check ownership
    const existRes = await db.query(
      `SELECT user_id FROM payment_methods WHERE id=$1`,
      [id]
    );

    if (existRes.rowCount === 0 || existRes.rows[0].user_id !== req.user.id) {
      return res.status(404).json({ success: false, error: 'Payment method not found' });
    }

    if (is_default) {
      await db.query(
        `UPDATE payment_methods SET is_default=false WHERE user_id=$1 AND id<>$2`,
        [req.user.id, id]
      );
    }

    const query = `
      UPDATE payment_methods
      SET payment_type = COALESCE($1, payment_type),
          masked_number = COALESCE($2, masked_number),
          cardholder_name = COALESCE($3, cardholder_name),
          extra_info = COALESCE($4, extra_info),
          billing_address = COALESCE($5, billing_address),
          branch = COALESCE($6, branch),
          is_default = COALESCE($7, is_default)
      WHERE id=$8
      RETURNING *
    `;

    const result = await db.query(query, [
      payment_type,
      masked_number,
      cardholder_name,
      extra_info,
      billing_address,
      branch,
      is_default,
      id
    ]);

    res.json({
      success: true,
      data: result.rows[0],
      message: 'Payment method updated successfully'
    });
  } catch (error) {
    console.error('Error updating payment method:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update payment method'
    });
  }
};

// Delete payment method
exports.deletePaymentMethod = async (req, res) => {
  try {
    const { id } = req.params;

    const check = await db.query(
      `SELECT user_id FROM payment_methods WHERE id=$1`,
      [id]
    );

    if (check.rowCount === 0 || check.rows[0].user_id !== req.user.id) {
      return res.status(404).json({ success: false, error: 'Payment method not found' });
    }

    await db.query(`DELETE FROM payment_methods WHERE id=$1`, [id]);

    res.json({ success: true, message: 'Payment method deleted successfully' });
  } catch (error) {
    console.error('Error deleting payment method:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete payment method'
    });
  }
};

// Get default payment method
exports.getDefaultPaymentMethod = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM payment_methods WHERE user_id=$1 AND is_default=true`,
      [req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'No default payment method found'
      });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error fetching default payment method:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch default payment method'
    });
  }
};
