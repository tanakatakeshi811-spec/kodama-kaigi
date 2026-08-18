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
