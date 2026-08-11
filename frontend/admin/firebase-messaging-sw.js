/**
 * Firebase Messaging Service Worker
 * Qatar Oasis - Admin Notifications
 *
 * Handles push notifications EVEN WHEN BROWSER IS COMPLETELY CLOSED
 * This is the key for background push notifications!
 */

// Import Firebase Messaging (Compat version for service worker support)
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

// Firebase configuration - MUST match frontend config
firebase.initializeApp({
  apiKey: "AIzaSyA9sRFkHrqOlRkyMfzl4AyK618J12D_uk8",
  authDomain: "adminqatar-d4192.firebaseapp.com",
  projectId: "adminqatar-d4192",
  storageBucket: "adminqatar-d4192.firebasestorage.app",
  messagingSenderId: "927564639029",
  appId: "1:927564639029:web:025a0c2e77ce6bba367a7c"
});

const messaging = firebase.messaging();

/**
 * CRITICAL: setBackgroundMessageHandler
 * This is what makes notifications work when browser is CLOSED
 * Firebase will wake up this service worker automatically
 */
messaging.setBackgroundMessageHandler((payload) => {
  console.log('📱 [SW] Background message received:', payload);
  
  // Extract notification data - supports both notification and data fields
  const title = payload.notification?.title || payload.data?.title || '🔔 إشعار جديد';
  const body = payload.notification?.body || payload.data?.body || 'لديك إشعار جديد';
  const icon = payload.data?.icon || '/admin/icon.png';
  const tag = payload.data?.type || 'general';
  const clickAction = payload.data?.clickAction || payload.notification?.click_action || '/admin/';
  
  // Build notification options for OS-level notification
  const notificationOptions = {
    body: body,
    icon: icon,
    badge: '/admin/badge.png',
    tag: tag,
    data: payload.data,
    requireInteraction: true, // Keep notification visible until user clicks
    silent: false,
    vibrate: [200, 100, 200, 100, 200],
    dir: 'rtl',
    lang: 'ar',
    renotify: true,
    actions: [
      { action: 'open', title: 'فتح لوحة التحكم' },
      { action: 'dismiss', title: 'تجاهل' }
    ]
  };

  console.log('📱 [SW] Showing notification:', title, body);

  // Show the notification - this works even when browser is closed!
  return self.registration.showNotification(title, notificationOptions);
});

/**
 * Handle notification click events
 */
self.addEventListener('notificationclick', (event) => {
  console.log('🔔 [SW] Notification clicked:', event.action);
  
  // Handle dismiss action
  if (event.action === 'dismiss') {
    event.notification.close();
    return;
  }
  
  // Close the notification
  event.notification.close();

  // Get the click action URL from notification data
  const clickUrl = event.notification.data?.clickAction || '/admin/';
  
  // Open/focus admin page
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Try to focus existing window
        for (const client of clientList) {
          if (client.url.includes('/admin/') && 'focus' in client) {
            client.focus();
            client.postMessage({
              type: 'NOTIFICATION_CLICK',
              data: event.notification.data
            });
            return;
          }
        }
        // Open new window if none found
        if (clients.openWindow) {
          return clients.openWindow(clickUrl);
        }
      })
  );
});

/**
 * Handle notification close events
 */
self.addEventListener('notificationclose', (event) => {
  console.log('🔔 [SW] Notification closed:', event.notification.title);
});
