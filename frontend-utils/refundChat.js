/**
 * refundChat.js — shared real-time chat for refund disputes
 * Include on both buyer and seller returns pages
 *
 * Usage:
 *   RefundChat.init(caseId, currentUserId, senderType, token, onNewMessage)
 *   RefundChat.sendMessage(caseId, token, { message_text, file_url, file_type })
 *   RefundChat.loadMessages(caseId, token)
 *   RefundChat.renderMessages(messages, currentUserId, container)
 *   RefundChat.uploadFile(file, token)   — uploads via /api/seller/logo/upload (Cloudinary)
 */

const RefundChat = (() => {
  const API = 'https://marketmix-backend.onrender.com/api';
  let _pollInterval = null;
  let _lastMsgId = null;
  let _pollConfig = null;
  let _visibilityHandlerAttached = false;

  async function apiCall(path, token, opts = {}) {
    const res = await fetch(`${API}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(opts.headers || {})
      }
    });
    return res.json();
  }

  async function loadMessages(caseId, token) {
    const data = await apiCall(`/refund-chat/${caseId}`, token);
    return data.data?.messages || [];
  }

  async function sendMessage(caseId, token, { message_text, media_url, media_type, file_url, file_type }) {
    return apiCall(`/refund-chat/${caseId}`, token, {
      method: 'POST',
      body: JSON.stringify({ message_text, media_url, media_type, file_url, file_type })
    });
  }

  async function uploadFile(file, token) {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API}/seller/logo/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });
    const data = await res.json();
    return data.data?.url || null;
  }

  function renderMessages(messages, currentUserId, container) {
    if (!container) return;
    if (!messages.length) {
      container.innerHTML = '<div class="chat-message system"><div class="message-content"><p>No messages yet. Start the conversation.</p></div></div>';
      return;
    }

    container.innerHTML = messages.map(msg => {
      const isMine = msg.sender_id === currentUserId;
      const side = isMine ? 'buyer' : (msg.sender_type === 'seller' ? 'seller' : 'system');
      const senderLabel = isMine ? '<span class="message-sender">You</span>'
        : msg.sender_type === 'seller' ? '<span class="message-sender">Seller</span>'
        : msg.sender_type === 'buyer' ? '<span class="message-sender">Buyer</span>'
        : '<span class="message-sender">MarketMix</span>';

      const time = new Date(msg.created_at).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit'
      });

      let mediaHtml = '';
      const mediaUrl = msg.media_url || msg.file_url || '';
      const mediaType = msg.media_type || msg.file_type || '';
      if (mediaUrl) {
        const isImg = /\.(jpg|jpeg|png|webp|gif)$/i.test(mediaUrl) || mediaType === 'image';
        const isVid = /\.(mp4|webm|mov)$/i.test(mediaUrl) || mediaType === 'video';
        if (isImg) {
          mediaHtml = `<div class="message-media"><a href="${mediaUrl}" target="_blank" rel="noopener noreferrer"><img src="${mediaUrl}" alt="attachment" style="max-width:200px;border-radius:8px;margin-top:4px"></a></div>`;
        } else if (isVid) {
          mediaHtml = `<div class="message-media"><video controls style="max-width:200px;border-radius:8px;margin-top:4px"><source src="${mediaUrl}"></video></div>`;
        } else {
          mediaHtml = `<div class="message-media"><a href="${mediaUrl}" target="_blank" rel="noopener noreferrer" style="color:#f97316">📎 View attachment</a></div>`;
        }
      }

      const readIcon = isMine
        ? `<span class="read-status" title="${msg.is_read ? 'Seen' : 'Sent'}"><i class="fas fa-check${msg.is_read ? '-double' : ''}" style="color:${msg.is_read ? '#007bff' : '#999'}"></i></span>`
        : '';

      return `
        <div class="chat-message ${side}">
          <div class="message-content">
            ${senderLabel}
            ${msg.message_text ? `<p class="message-text">${escHtml(msg.message_text)}</p>` : ''}
            ${mediaHtml}
            <span class="message-time">${time}</span>
            ${readIcon}
          </div>
        </div>`;
    }).join('');

    container.scrollTop = container.scrollHeight;
    _lastMsgId = messages[messages.length - 1]?.id;
  }

  function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function ensureVisibilityHandler() {
    if (typeof document === 'undefined' || _visibilityHandlerAttached) return;
    _visibilityHandlerAttached = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopPolling(true);
      } else if (_pollConfig) {
        startPolling(
          _pollConfig.caseId,
          _pollConfig.token,
          _pollConfig.currentUserId,
          _pollConfig.container,
          _pollConfig.onNewMessage
        );
      }
    });
  }

  function startPolling(caseId, token, currentUserId, container, onNewMessage) {
    stopPolling(true);
    _pollConfig = { caseId, token, currentUserId, container, onNewMessage };
    ensureVisibilityHandler();

    if (typeof document !== 'undefined' && document.hidden) return;

    _pollInterval = setInterval(async () => {
      try {
        const msgs = await loadMessages(caseId, token);
        const latest = msgs[msgs.length - 1]?.id;
        if (latest && latest !== _lastMsgId) {
          renderMessages(msgs, currentUserId, container);
          if (onNewMessage) onNewMessage(msgs);
        }
      } catch (e) { /* silent */ }
    }, 15000);
  }

  function stopPolling(keepConfig = false) {
    if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
    if (!keepConfig) _pollConfig = null;
  }

  return { loadMessages, sendMessage, uploadFile, renderMessages, startPolling, stopPolling };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RefundChat;
