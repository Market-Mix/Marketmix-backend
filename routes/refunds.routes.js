const express = require('express');
const router = express.Router();
const { sendSuccess, sendError } = require('../utils/response');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zfyoxmwwuwgvaevwlgzn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function getSupabaseHeaders() {
  return {
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    apikey: SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json'
  };
}

function ensureSupabaseConfigured(res) {
  if (!SUPABASE_SERVICE_KEY) {
    console.error('❌ SUPABASE_SERVICE_KEY not configured');
    res.status(500).json({ success: false, message: 'Server misconfiguration: Supabase service key not available' });
    return false;
  }
  return true;
}

// ─── POST /api/refunds/create — Create refund case ───────────────────────────
router.post('/create', async (req, res) => {
  try {
    const {
      buyer_id,
      order_id,
      order_item_id,
      product_id,
      product_name,
      complaint_text,
      seller_id,
      evidence_url
    } = req.body;

    console.log('➡️ /api/refunds/create hit with body:', req.body);

    const requiredFields = ['buyer_id', 'order_id', 'order_item_id', 'product_id', 'product_name', 'complaint_text'];
    const missing = requiredFields.filter(field => !req.body[field]);
    if (missing.length > 0) {
      console.error('❌ Missing required refund fields:', missing);
      return res.status(400).json({ success: false, message: 'Missing required fields', missing });
    }

    if (!ensureSupabaseConfigured(res)) return;

    let resolvedSellerId = seller_id;
    if (!resolvedSellerId && order_id) {
      try {
        const orderItemsRes = await db.query(
          'SELECT seller_id FROM order_items WHERE order_id = $1 AND seller_id IS NOT NULL LIMIT 1',
          [order_id]
        );
        if (orderItemsRes.rows.length > 0) {
          resolvedSellerId = orderItemsRes.rows[0].seller_id;
          console.log('🔎 Resolved seller_id from order_items:', resolvedSellerId);
        }
      } catch (err) {
        console.warn('⚠️ Could not resolve seller_id from order_items:', err.message);
      }
    }

    if (!resolvedSellerId && product_name) {
      try {
        const productRes = await db.query(
          'SELECT seller_id FROM products WHERE name = $1 AND seller_id IS NOT NULL LIMIT 1',
          [product_name]
        );
        if (productRes.rows.length > 0) {
          resolvedSellerId = productRes.rows[0].seller_id;
          console.log('🔎 Resolved seller_id from product record:', resolvedSellerId);
        }
      } catch (err) {
        console.warn('⚠️ Could not resolve seller_id from product record:', err.message);
      }
    }

    if (!resolvedSellerId) {
      console.error('❌ Unable to resolve seller_id for refund create payload:', { order_id, product_name, receivedSellerId: seller_id });
      return res.status(400).json({ success: false, message: 'Unable to resolve seller_id for this order', details: { order_id, product_name } });
    }

    // Fetch buyer name and order item amount
    let buyerName = null;
    let totalAmount = 0;
    try {
      const buyerRes = await db.query('SELECT first_name, last_name FROM users WHERE id = $1', [buyer_id]);
      if (buyerRes.rows.length > 0) {
        const row = buyerRes.rows[0];
        buyerName = `${row.first_name || ''} ${row.last_name || ''}`.trim() || null;
      }

      const itemRes = await db.query(
        'SELECT quantity, price_at_purchase FROM order_items WHERE order_id = $1 AND id = $2',
        [order_id, order_item_id]
      );
      if (itemRes.rows.length > 0) {
        const row = itemRes.rows[0];
        totalAmount = (parseFloat(row.quantity) || 1) * (parseFloat(row.price_at_purchase) || 0);
      }
    } catch (err) {
      console.warn('⚠️ Could not fetch buyer name or amount:', err.message);
    }

    const refundPayload = {
      buyer_id,
      buyer_name: buyerName,
      total_amount: totalAmount,
      seller_id: resolvedSellerId,
      order_id: String(order_id),
      order_item_id: order_item_id || null,
      product_id: product_id || null,
      product_name,
      complaint_text,
      evidence_url: evidence_url || null,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    console.log('📦 Refund payload prepared for Supabase insert:', refundPayload);
    console.log('Final refund insert payload:', refundPayload);

    console.log('📦 Inserting refund case into Supabase:', refundPayload);

    const insertResponse = await fetch(`${SUPABASE_URL}/rest/v1/refund_cases`, {
      method: 'POST',
      headers: {
        ...getSupabaseHeaders(),
        Prefer: 'return=representation'
      },
      body: JSON.stringify(refundPayload)
    });

    const insertedData = await insertResponse.json().catch(async () => {
      const text = await insertResponse.text().catch(() => 'No body');
      return { errorBody: text };
    });

    if (!insertResponse.ok) {
      console.error(`❌ Supabase insert failed: ${insertResponse.status} ${insertResponse.statusText}`);
      console.error('Supabase error body:', insertedData);
      return res.status(insertResponse.status).json({ success: false, message: 'Failed to create refund case', details: insertedData });
    }

    const refundCase = Array.isArray(insertedData) ? insertedData[0] : insertedData;
    if (!refundCase || !refundCase.id) {
      console.error('❌ Missing refund case ID after insert', insertedData);
      return res.status(500).json({ success: false, message: 'Refund case created but no ID returned' });
    }

    console.log('✅ Refund case inserted successfully:', { id: refundCase.id, buyer_id: refundCase.buyer_id, order_id: refundCase.order_id });

    const buyerNotification = {
      user_id: buyer_id,
      title: 'Refund Case Created',
      message: `Your refund case for order ${order_id} has been created successfully.`,
      type: 'refund',
      link: '/buyers/buyers%20return%20report.html',
      is_read: false,
      is_deleted: false,
      created_at: new Date().toISOString()
    };

    console.log('📬 Inserting buyer notification');
    const buyerNotifResponse = await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
      method: 'POST',
      headers: getSupabaseHeaders(),
      body: JSON.stringify(buyerNotification)
    });

    if (!buyerNotifResponse.ok) {
      const errorText = await buyerNotifResponse.text();
      console.error('⚠️ Failed to create buyer notification:', errorText);
    } else {
      console.log('✅ Buyer notification created successfully');
    }

    if (seller_id) {
      const sellerNotification = {
        user_id: seller_id,
        title: 'New Refund Request',
        message: `A refund request was submitted for order ${order_id}.`,
        type: 'refund',
        link: '/sellers/sellers%20returns.html',
        is_read: false,
        is_deleted: false,
        created_at: new Date().toISOString()
      };

      console.log('📬 Inserting seller notification');
      const sellerNotifResponse = await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
        method: 'POST',
        headers: getSupabaseHeaders(),
        body: JSON.stringify(sellerNotification)
      });

      if (!sellerNotifResponse.ok) {
        const errorText = await sellerNotifResponse.text();
        console.error('⚠️ Failed to create seller notification:', errorText);
      } else {
        console.log('✅ Seller notification created successfully');
      }
    }

    return res.status(200).json({ success: true, refundCase });
  } catch (error) {
    console.error('❌ Error in /api/refunds/create:', error);
    console.error('Refund insert error:', error);
    console.error('Refund payload received:', req.body);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

// ─── GET /api/refunds/buyer/:buyerId — Fetch buyer refund cases ─────────────
router.get('/buyer/:buyerId', async (req, res) => {
  try {
    const { buyerId } = req.params;
    console.log('➡️ /api/refunds/buyer/:buyerId hit for buyerId:', buyerId);
    if (!buyerId) {
      return res.status(400).json({ success: false, message: 'Missing buyerId parameter' });
    }

    if (!ensureSupabaseConfigured(res)) return;

    const queryUrl = `${SUPABASE_URL}/rest/v1/refund_cases?select=*&buyer_id=eq.${encodeURIComponent(buyerId)}&order=created_at.desc`;
    console.log('📦 Fetching refund cases from Supabase:', queryUrl);

    const response = await fetch(queryUrl, {
      method: 'GET',
      headers: getSupabaseHeaders()
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Supabase refund fetch failed: ${response.status} ${response.statusText}`);
      return res.status(response.status).json({ success: false, message: 'Failed to fetch refund cases', details: errorText });
    }

    const refundCases = await response.json();
    console.log('✅ Refund cases fetched successfully:', refundCases.length);
    return res.status(200).json({ success: true, refundCases });
  } catch (error) {
    console.error('❌ Error in /api/refunds/buyer/:buyerId:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

router.patch('/:caseId/status', async (req, res) => {
  try {
    const { caseId } = req.params;
    const { status } = req.body;

    if (!caseId || !status) {
      return res.status(400).json({ success: false, message: 'Missing caseId or status' });
    }

    if (!ensureSupabaseConfigured(res)) return;

    const updatePayload = {
      status,
      updated_at: new Date().toISOString()
    };

    const response = await fetch(`${SUPABASE_URL}/rest/v1/refund_cases?id=eq.${encodeURIComponent(caseId)}`, {
      method: 'PATCH',
      headers: {
        ...getSupabaseHeaders(),
        Prefer: 'return=representation'
      },
      body: JSON.stringify(updatePayload)
    });

    const updatedData = await response.json().catch(async () => {
      const text = await response.text().catch(() => 'No body');
      return { errorBody: text };
    });

    if (!response.ok) {
      console.error(`❌ Supabase refund update failed: ${response.status} ${response.statusText}`);
      return res.status(response.status).json({ success: false, message: 'Failed to update refund case status', details: updatedData });
    }

    return res.status(200).json({ success: true, refundCase: Array.isArray(updatedData) ? updatedData[0] : updatedData });
  } catch (error) {
    console.error('❌ Error in /api/refunds/:caseId/status:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

module.exports = router;
