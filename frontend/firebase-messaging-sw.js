/**
 * Firebase Messaging Service Worker
 * Qatar Oasis - Admin Notifications
 * 
 * This file handles push notifications even when the admin page is closed
 */

// Import Firebase Messaging
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

// Firebase configuration - MUST match backend firebase-admin.js project
firebase.initializeApp({
  apiKey: "AIzaSyA9sRFkHrqOlRkyMfzl4AyK618J12D_uk8",
  authDomain: "adminqatar-d4192.firebaseapp.com",
  projectId: "adminqatar-d4192",
  storageBucket: "adminqatar-d4192.firebasestorage.app",
  messagingSenderId: "927564639029",
  appId: "1:927564639029:web:025a0c2e77ce6bba367a7c"
});

const messaging = firebase.messaging();

// Handle background messages
messaging.onBackgroundMessage((payload) => {
  console.log('📱 Background message received:', payload);
  
  const notificationTitle = payload.notification?.title || 'إشعار جديد';
  const notificationOptions = {
    body: payload.notification?.body || 'لديك إشعار جديد',
    icon: '/admin/icon.png',
    badge: '/admin/badge.png',
    tag: payload.data?.type || 'general',
    data: payload.data,
    requireInteraction: true, // Keep notification until clicked
    vibrate: [200, 100, 200],
    dir: 'rtl',
    lang: 'ar'
  };

  // Show notification
  return self.registration.showNotification(notificationTitle, notificationOptions);
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
  console.log('🔔 Notification clicked:', event);
  
  event.notification.close();
  
  // Open admin page
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Check if admin page is already open
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
      // Open new window if not found
      if (clients.openWindow) {
        return clients.openWindow('/admin/');
      }
    })
  );
});
