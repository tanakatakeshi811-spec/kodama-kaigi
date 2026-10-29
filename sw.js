// コダマ会議 Service Worker
// PWA(ホーム画面・スタートメニューへのインストール)として認識してもらうための最低限の実装。
// 凝ったオフラインキャッシュ戦略・バックグラウンド同期などは今回のスコープ外
// (このアプリはP2P/WebRTCでの通信が前提で、そもそもオフラインでは会議自体が成立しないため)。
// 「インストール可能にする」「起動を少しだけ速くする」程度の最低限の役割に留めている。
const CACHE_NAME = 'kodama-kaigi-v1';
const USER_CACHE = 'kodama-kaigi-user'; // 利用者が設定した通知アイコン(版が変わっても消さない)
const ICON_KEY = './__kdm-notif-icon';
const CORE_ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME && k !== USER_CACHE).map(k => caches.delete(k))))
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
   (画面の中で知らせるほうが自然なため。ただしテスト通知は、届いたことが分かるよう必ず表示する)。

   見た目(v3.7.0〜):
   - 種類ごとに色・ボタン(参加する/応答する/あとで)・振動パターンを変える
   - 重要通知(招待の「重要」): 赤いバナー画像つき・出しっぱなし・長く強い振動・ボタンも「今すぐ参加」
   - 左の大きいアイコンは、利用者が設定で選んだ画像(なければ既定のアイコン)
   - 状態バーの小さいアイコン(badge)は、Androidの決まりで単色になるので、吹き出しの形をその場で描く
   バナー画像とbadgeはOffscreenCanvasで描いてdata URLにする(描けない環境では、画像なしで普通に出す)。 */
const THEMES = {
  chat:      { c1: '#3b82f6', c2: '#6366f1' },
  call:      { c1: '#10b981', c2: '#059669' },
  invite:    { c1: '#8b5cf6', c2: '#6366f1' },
  important: { c1: '#ef4444', c2: '#b91c1c' },
  test:      { c1: '#64748b', c2: '#334155' },
};

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

async function getUserIcon() {
  try {
    const c = await caches.open(USER_CACHE);
    const r = await c.match(ICON_KEY);
    if (r) { const t = await r.text(); if (t.startsWith('data:image/')) return t; }
  } catch (_) {}
  return '';
}
async function setUserIcon(dataUrl) {
  const c = await caches.open(USER_CACHE);
  if (dataUrl && String(dataUrl).startsWith('data:image/')) await c.put(ICON_KEY, new Response(String(dataUrl)));
  else await c.delete(ICON_KEY);
}

// 状態バー用の単色(白)アイコン: 吹き出し+中の三点
async function makeBadge() {
  try {
    const cv = new OffscreenCanvas(96, 96);
    const g = cv.getContext('2d');
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(22, 14); g.lineTo(74, 14); g.quadraticCurveTo(86, 14, 86, 26);
    g.lineTo(86, 56); g.quadraticCurveTo(86, 68, 74, 68); g.lineTo(46, 68);
    g.lineTo(26, 84); g.lineTo(28, 68); g.lineTo(22, 68);
    g.quadraticCurveTo(10, 68, 10, 56); g.lineTo(10, 26); g.quadraticCurveTo(10, 14, 22, 14);
    g.closePath(); g.fill();
    g.globalCompositeOperation = 'destination-out';
    [32, 48, 64].forEach(x => { g.beginPath(); g.arc(x, 41, 5.5, 0, Math.PI * 2); g.fill(); });
    return await blobToDataUrl(await cv.convertToBlob({ type: 'image/png' }));
  } catch (_) { return 'favicon-32.png'; }
}

// 通知の下に出る横長バナー(Android Chrome。出ない環境では単に無視される)
async function makeHero(theme, heading, sub) {
  try {
    const W = 720, H = 360;
    const cv = new OffscreenCanvas(W, H);
    const g = cv.getContext('2d');
    const gr = g.createLinearGradient(0, 0, W, H);
    gr.addColorStop(0, theme.c1); gr.addColorStop(1, theme.c2);
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,.10)';
    g.beginPath(); g.arc(W - 90, 70, 190, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(80, H + 20, 150, 0, Math.PI * 2); g.fill();
    g.textBaseline = 'alphabetic';
    g.fillStyle = 'rgba(255,255,255,.55)';
    g.font = '700 30px sans-serif';
    g.fillText('コダマ会議', 36, 62);
    g.fillStyle = '#fff';
    g.shadowColor = 'rgba(0,0,0,.28)'; g.shadowBlur = 14; g.shadowOffsetY = 4;
    g.font = '800 70px sans-serif';
    g.fillText(heading, 36, 205);
    g.shadowColor = 'transparent';
    g.font = '600 34px sans-serif';
    g.fillStyle = 'rgba(255,255,255,.92)';
    g.fillText(String(sub || '').slice(0, 22), 36, 270);
    return await blobToDataUrl(await cv.convertToBlob({ type: 'image/jpeg', quality: 0.85 }));
  } catch (_) { return ''; }
}

function pickStyle(d) {
  if (d.kind === 'test' && d.variant) return d.variant;
  if (d.kind === 'invite') return d.important ? 'important' : 'invite';
  if (d.kind === 'call' || d.kind === 'chat' || d.kind === 'test') return d.kind;
  return 'chat';
}

async function showKdm(d) {
  const style = pickStyle(d);
  const theme = THEMES[style] || THEMES.chat;
  const [userIcon, badge] = await Promise.all([getUserIcon(), makeBadge()]);
  const opts = {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!(d.tag && d.renotify),
    icon: userIcon || 'icon-192.png',
    badge,
    timestamp: d.ts || Date.now(),
    data: { url: d.url || '', kind: d.kind || '', style },
  };
  const who = d.name ? d.name + 'さん' : '';
  const room = d.room ? '「' + d.room + '」' : '';
  if (style === 'call') {
    opts.vibrate = [300, 150, 300, 150, 300, 150, 300];
    opts.requireInteraction = true;
    opts.actions = [{ action: 'open', title: '📞 応答する' }, { action: 'later', title: '拒否' }];
  } else if (style === 'important') {
    opts.vibrate = [500, 200, 500, 200, 500, 200, 800];
    opts.requireInteraction = true;
    opts.actions = [{ action: 'open', title: '🚀 今すぐ参加' }, { action: 'later', title: 'あとで' }];
    opts.image = await makeHero(theme, '🚨 重要', (who ? who + 'から ' : '') + (room || '会議へのご招待'));
  } else if (style === 'invite') {
    opts.vibrate = [200, 100, 200, 100, 400];
    opts.requireInteraction = true;
    opts.actions = [{ action: 'open', title: '🎥 参加する' }, { action: 'later', title: 'あとで' }];
    opts.image = await makeHero(theme, '会議にご招待', (who ? who + '・' : '') + room);
  } else {
    opts.vibrate = [120, 60, 120];
  }
  if (!opts.image) delete opts.image;
  await self.registration.showNotification(d.title || 'コダマ会議', opts);
}

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'コダマ会議', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = cs.filter(c => c.visibilityState === 'visible');
    if (visible.length && d.kind !== 'test') { visible.forEach(c => c.postMessage({ kdmPush: d })); return; }
    await showKdm(d);
  })());
});

// 画面側からの依頼: kdmShow=画面が裏にいる時のローカル通知を同じ見た目で出す / kdmIcon=通知アイコンの設定(null・空で既定に戻す)
self.addEventListener('message', e => {
  const m = e.data || {};
  if (m.kdmShow) e.waitUntil(showKdm(m.kdmShow).catch(() => {}));
  else if (Object.prototype.hasOwnProperty.call(m, 'kdmIcon')) e.waitUntil(setUserIcon(m.kdmIcon).catch(() => {}));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'later') return;
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
