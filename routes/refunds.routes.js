const express = require('express');
const router = express.Router();
const { sendSuccess, sendError } = require('../helpers/response');
const { protect } = require('../middleware/auth');
const db = require('../config/db');

// ─── POST /api/refunds/create — Create refund case ───────────────────────────
router.post('/create', async (req, res) => {
  try {
    const {
      buyer_id,
      order_id,
      product_name,
      complaint_text,
      seller_id,
      evidence_url,
      evidence_public_id,
      evidence_type
    } = req.body;

    // Validate required fields
    if (!buyer_id || !order_id || !product_name || !complaint_text) {
      console.error('❌ Missing required fields:', {
        buyer_id: !!buyer_id,
        order_id: !!order_id,
        product_name: !!product_name,
        complaint_text: !!complaint_text
      });
      return sendError(res, 400, 'Missing required fields', {
        required: ['buyer_id', 'order_id', 'product_name', 'complaint_text']
      });
    }

    // Validate Supabase credentials
    const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zfyoxmwwuwgvaevwlgzn.supabase.co';
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_SERVICE_KEY) {
      console.error('❌ SUPABASE_SERVICE_KEY not configured');
      return sendError(res, 500, 'Server misconfiguration: Supabase service key not available', null);
    }

    console.log('📝 Creating refund case:', {
      buyer_id,
      order_id,
      product_name,
      seller_id,
      evidence_url: evidence_url ? '(provided)' : null
    });

    // Prepare refund case payload
    const refundPayload = {
      buyer_id,
      order_id: String(order_id),
      product_name,
      complaint_text,
      seller_id: seller_id || null,
      status: 'pending',
      evidence_url: evidence_url || null,
      evidence_public_id: evidence_public_id || null,
      evidence_type: evidence_type || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    console.log('📦 Refund payload to insert:', refundPayload);

    // Insert refund case into Supabase
    const insertResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/refund_cases`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'apikey': SUPABASE_SERVICE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(refundPayload)
      }
    );

    if (!insertResponse.ok) {
      const errorText = await insertResponse.text();
      console.error(`❌ Supabase insert failed: ${insertResponse.status} ${insertResponse.statusText}`);
      console.error('Supabase error body:', errorText);
      return sendError(
        res,
        insertResponse.status,
        'Failed to create refund case',
        errorText
      );
    }

    const insertedData = await insertResponse.json();
    const refundCase = Array.isArray(insertedData) ? insertedData[0] : insertedData;

    if (!refundCase || !refundCase.id) {
      console.error('❌ No refund case ID returned from Supabase');
      return sendError(res, 500, 'Refund case created but no ID returned', null);
    }

    console.log('✅ Refund case created successfully:', {
      id: refundCase.id,
      buyer_id: refundCase.buyer_id,
      order_id: refundCase.order_id
    });

    // Create buyer notification
    console.log('📬 Creating buyer notification...');
    const buyerNotification = {
      user_id: buyer_id,
      title: 'Refund Case Created',
      message: `Your refund case for order ${order_id} has been created. We'll review your complaint shortly.`,
      type: 'refund',
      link: '/buyers/buyers%20return%20report.html',
      is_read: false,
      is_deleted: false,
      created_at: new Date().toISOString()
    };

    const buyerNotifResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/notifications`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'apikey': SUPABASE_SERVICE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(buyerNotification)
      }
    );

    if (!buyerNotifResponse.ok) {
      const errorText = await buyerNotifResponse.text();
      console.error('⚠️ Failed to create buyer notification:', errorText);
      // Don't fail the whole request, but log it
    } else {
      console.log('✅ Buyer notification created successfully');
    }

    // Create seller notification if seller_id is provided
    if (seller_id) {
      console.log('📬 Creating seller notification for seller:', seller_id);
      const sellerNotification = {
        user_id: seller_id,
        title: 'New Refund Request',
        message: `A refund case has been submitted for order ${order_id}: "${product_name}"`,
        type: 'refund',
        link: '/sellers/sellers%20returns.html',
        is_read: false,
        is_deleted: false,
        created_at: new Date().toISOString()
      };

      const sellerNotifResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/notifications`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'apikey': SUPABASE_SERVICE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify(sellerNotification)
        }
      );

      if (!sellerNotifResponse.ok) {
        const errorText = await sellerNotifResponse.text();
        console.error('⚠️ Failed to create seller notification:', errorText);
        // Don't fail the whole request, but log it
      } else {
        console.log('✅ Seller notification created successfully');
      }
    }

    // Return success response with refund case data
    return sendSuccess(res, 201, 'Refund case created successfully', {
      refund_case: refundCase,
      notifications_created: true
    });

  } catch (error) {
    console.error('❌ Error creating refund case:', error);
    return sendError(res, 500, 'Internal server error while creating refund case', error.message);
  }
});

// ─── POST /api/refunds/add-message — Add message to refund case ─────────────
router.post('/:caseId/message', async (req, res) => {
  try {
    const { caseId } = req.params;
    const { sender_type, message_text, file_url } = req.body;

    if (!caseId || !sender_type || !message_text) {
      return sendError(res, 400, 'Missing required fields', {
        required: ['caseId', 'sender_type', 'message_text']
      });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zfyoxmwwuwgvaevwlgzn.supabase.co';
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_SERVICE_KEY) {
      return sendError(res, 500, 'Server misconfiguration: Supabase service key not available', null);
    }

    const messagePayload = {
      refund_case_id: caseId,
      sender_type,
      message_text,
      file_url: file_url || null,
      created_at: new Date().toISOString()
    };

    console.log('📝 Adding message to refund case:', { caseId, sender_type });

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/refund_messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'apikey': SUPABASE_SERVICE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(messagePayload)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Failed to add message: ${response.status}`);
      return sendError(res, response.status, 'Failed to add message', errorText);
    }

    const data = await response.json();
    console.log('✅ Message added successfully');

    return sendSuccess(res, 201, 'Message added successfully', {
      message: Array.isArray(data) ? data[0] : data
    });

  } catch (error) {
    console.error('❌ Error adding message:', error);
    return sendError(res, 500, 'Internal server error', error.message);
  }
});

module.exports = router;
