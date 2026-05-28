const express = require('express');
const router = express.Router();
const { sendSuccess, sendError } = require('../utils/response');
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

        console.log('➡️ /api/refunds/create reached with body:', req.body);

        // Validate required fields
        if (!buyer_id || !order_id || !product_name || !complaint_text) {
          console.error('❌ Missing required fields:', {
            buyer_id: !!buyer_id,
            order_id: !!order_id,
            product_name: !!product_name,
            complaint_text: !!complaint_text
          });
          return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Validate Supabase credentials
        const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zfyoxmwwuwgvaevwlgzn.supabase.co';
        const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

        if (!SUPABASE_SERVICE_KEY) {
          console.error('❌ SUPABASE_SERVICE_KEY not configured');
          return res.status(500).json({ success: false, message: 'Server misconfiguration: Supabase service key not available' });
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

        // Insert refund case into Supabase via REST (service role key)
        console.log('🔁 Inserting refund case into Supabase...');
        const insertResponse = await fetch(`${SUPABASE_URL}/rest/v1/refund_cases`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'apikey': SUPABASE_SERVICE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
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
          console.error('❌ No refund case ID returned from Supabase', insertedData);
          return res.status(500).json({ success: false, message: 'Refund case created but no ID returned' });
        }

        console.log('✅ Refund case created successfully:', { id: refundCase.id, buyer_id: refundCase.buyer_id, order_id: refundCase.order_id });

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
          } else {
            console.log('✅ Seller notification created successfully');
          }
        }

        // Return success response with refund case data in requested format
        return res.status(200).json({ success: true, refundCase: refundCase });
      } catch (error) {
        console.error('❌ Error creating refund case:', error);
        return res.status(500).json({ success: false, message: error.message || 'Internal server error while creating refund case' });
      }
    });

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
