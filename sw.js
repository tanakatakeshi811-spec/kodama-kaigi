// コダマ会議 Service Worker
// PWA(ホーム画面・スタートメニューへのインストール)として認識してもらうための最低限の実装。
// 凝ったオフラインキャッシュ戦略・バックグラウンド同期などは今回のスコープ外
// (このアプリはP2P/WebRTCでの通信が前提で、そもそもオフラインでは会議自体が成立しないため)。
// 「インストール可能にする」「起動を少しだけ速くする」程度の最低限の役割に留めている。
const CACHE_NAME = 'kodama-kaigi-v1';
const CORE_ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// ネットワーク優先・失敗時だけキャッシュへフォールバック（常に最新のindex.htmlを優先する）
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== self.location.origin) return; // 通知サーバー等、別オリジンへの通信には関与しない
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, resClone)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

/* ===== 通知(Web Push) =====
   Cloudflare Workerから届いた通知を表示する。アプリの画面が見えている間は、通知を出さずに画面側へ渡す
   (画面の中で知らせるほうが自然なため。ただしテスト通知は、届いたことが分かるよう必ず表示する)。 */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'コダマ会議', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = cs.filter(c => c.visibilityState === 'visible');
    if (visible.length && d.kind !== 'test') { visible.forEach(c => c.postMessage({ kdmPush: d })); return; }
    await self.registration.showNotification(d.title || 'コダマ会議', {
      body: d.body || '',
      tag: d.tag || undefined,
      renotify: !!(d.tag && d.renotify),
      icon: 'icon-192.png',
      badge: 'favicon-32.png',
      vibrate: d.kind === 'call' ? [300, 150, 300, 150, 300] : [120, 60, 120],
      requireInteraction: d.kind === 'call' || d.kind === 'invite',
      data: { url: d.url || '', kind: d.kind || '' },
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '';
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const c = cs.find(x => 'focus' in x);
    if (c) {
      try { await c.focus(); } catch (_) {}
      if (url) c.postMessage({ kdmOpen: url });
      return;
    }
    await self.clients.openWindow(new URL(url || './', self.registration.scope).href);
  })());
});
