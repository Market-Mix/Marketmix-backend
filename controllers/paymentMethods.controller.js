// ============================================
// FILE 1: controllers/paymentMethodsController.js
// ============================================
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Get all payment methods for authenticated user
exports.getAllPaymentMethods = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payment_methods')
      .select('*')
      .eq('user_id', req.user.id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ 
      success: true, 
      data,
      count: data.length 
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
    const { id } = req.params;

    const { data, error } = await supabase
      .from('payment_methods')
      .select('*')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ 
        success: false,
        error: 'Payment method not found' 
      });
    }

    res.json({ 
      success: true, 
      data 
    });
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

    // Validate required fields
    if (!payment_type || !masked_number || !cardholder_name) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing required fields: payment_type, masked_number, cardholder_name' 
      });
    }

    // Validate payment_type
    if (!['Card', 'Bank'].includes(payment_type)) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid payment_type. Must be "Card" or "Bank"' 
      });
    }

    // If setting as default, unset other defaults first
    if (is_default) {
      await supabase
        .from('payment_methods')
        .update({ is_default: false })
        .eq('user_id', req.user.id);
    }

    const { data, error } = await supabase
      .from('payment_methods')
      .insert([{
        user_id: req.user.id,
        payment_type,
        masked_number,
        cardholder_name,
        extra_info,
        billing_address: payment_type === 'Card' ? billing_address : null,
        branch: payment_type === 'Bank' ? branch : null,
        is_default: is_default || false
      }])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({ 
      success: true, 
      data,
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

    // Verify ownership
    const { data: existing, error: fetchError } = await supabase
      .from('payment_methods')
      .select('user_id, payment_type')
      .eq('id', id)
      .single();

    if (fetchError || !existing || existing.user_id !== req.user.id) {
      return res.status(404).json({ 
        success: false,
        error: 'Payment method not found' 
      });
    }

    // If setting as default, unset other defaults first
    if (is_default) {
      await supabase
        .from('payment_methods')
        .update({ is_default: false })
        .eq('user_id', req.user.id)
        .neq('id', id);
    }

    // Build update object
    const updateData = {};
    if (payment_type !== undefined) {
      if (!['Card', 'Bank'].includes(payment_type)) {
        return res.status(400).json({ 
          success: false,
          error: 'Invalid payment_type. Must be "Card" or "Bank"' 
        });
      }
      updateData.payment_type = payment_type;
    }
    if (masked_number !== undefined) updateData.masked_number = masked_number;
    if (cardholder_name !== undefined) updateData.cardholder_name = cardholder_name;
    if (extra_info !== undefined) updateData.extra_info = extra_info;
    if (billing_address !== undefined) updateData.billing_address = billing_address;
    if (branch !== undefined) updateData.branch = branch;
    if (is_default !== undefined) updateData.is_default = is_default;

    const { data, error } = await supabase
      .from('payment_methods')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({ 
      success: true, 
      data,
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

// Set payment method as default
exports.setDefaultPaymentMethod = async (req, res) => {
  try {
    const { id } = req.params;

    // Verify ownership
    const { data: existing, error: fetchError } = await supabase
      .from('payment_methods')
      .select('user_id')
      .eq('id', id)
      .single();

    if (fetchError || !existing || existing.user_id !== req.user.id) {
      return res.status(404).json({ 
        success: false,
        error: 'Payment method not found' 
      });
    }

    // Unset all defaults for this user
    await supabase
      .from('payment_methods')
      .update({ is_default: false })
      .eq('user_id', req.user.id);

    // Set this one as default
    const { data, error } = await supabase
      .from('payment_methods')
      .update({ is_default: true })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({ 
      success: true, 
      data,
      message: 'Default payment method set successfully' 
    });
  } catch (error) {
    console.error('Error setting default payment method:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to set default payment method' 
    });
  }
};

// Delete payment method
exports.deletePaymentMethod = async (req, res) => {
  try {
    const { id } = req.params;

    // Verify ownership
    const { data: existing, error: fetchError } = await supabase
      .from('payment_methods')
      .select('user_id')
      .eq('id', id)
      .single();

    if (fetchError || !existing || existing.user_id !== req.user.id) {
      return res.status(404).json({ 
        success: false,
        error: 'Payment method not found' 
      });
    }

    const { error } = await supabase
      .from('payment_methods')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ 
      success: true, 
      message: 'Payment method deleted successfully' 
    });
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
    const { data, error } = await supabase
      .from('payment_methods')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('is_default', true)
      .single();

    if (error || !data) {
      return res.status(404).json({ 
        success: false,
        error: 'No default payment method found' 
      });
    }

    res.json({ 
      success: true, 
      data 
    });
  } catch (error) {
    console.error('Error fetching default payment method:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch default payment method' 
    });
  }
};