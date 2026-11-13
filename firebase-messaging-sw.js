// firebase-messaging-sw.js  ― index.html と同じ階層(ルート)に置く
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

// Firebase コンソール「プロジェクトの設定 > マイアプリ(ウェブ)」の値に置き換える
firebase.initializeApp({
  apiKey: 'AIzaSyCgk3UnNj3fajHMJ1GONn06fQ-4mdvXchc',
  authDomain: 'race-schedule-2346b.firebaseapp.com',
  projectId: 'race-schedule-2346b',
  messagingSenderId: '235126728379',
  appId: '1:235126728379:web:c56f74c8eedaa454066b9e'
});

const messaging = firebase.messaging();

// data-only メッセージを受け取り、必ず通知として表示する(iOS は表示しないと配信停止される)
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  self.registration.showNotification(d.title || 'Race Event', {
    body: d.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: d.tag || undefined,
    data: { url: d.url || './' }
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});
