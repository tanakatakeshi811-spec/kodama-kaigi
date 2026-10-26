/* ===== Web Push(RFC 8030 / 8291 aes128gcm / 8292 VAPID)をWorkers上のWebCrypto(だけ)で実装 =====
   外部ライブラリなし。Node(18+)のwebcryptoでも同じコードが動くので、テストはNodeで行っている。 */

const enc = new TextEncoder();

export function b64uToBytes(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64u(b) {
  b = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concat(...arrs) {
  const n = arrs.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const x of arrs) { out.set(x, o); o += x.length; }
  return out;
}

/* VAPID鍵ペアを作る(セットアップ用)。公開鍵=65バイトの非圧縮点、秘密鍵=32バイトのd(どちらもbase64url) */
export async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = concat(new Uint8Array([4]), b64uToBytes(jwk.x), b64uToBytes(jwk.y));
  return { publicKey: bytesToB64u(pub), privateKey: jwk.d };
}

async function vapidAuthHeader(endpoint, vapid) {
  const pub = b64uToBytes(vapid.publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)), d: vapid.privateKey, ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const aud = new URL(endpoint).origin;
  const head = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = bytesToB64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body));
  return `vapid t=${head}.${body}.${bytesToB64u(sig)}, k=${vapid.publicKey}`;
}

/* RFC 8291: 受信側のp256dh(65B)とauth(16B)で、payload(Uint8Array)を1レコードのaes128gcmに暗号化 */
export async function encryptPayload(sub, payload) {
  const uaPublic = b64uToBytes(sub.keys.p256dh);
  const authSecret = b64uToBytes(sub.keys.auth);
  const asKp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKp.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKp.privateKey, 256));
  const hkdf = async (ikm, salt, info, bits) => {
    const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bits));
  };
  const ikm = await hkdf(ecdh, authSecret, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 256);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await hkdf(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 96);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(payload, new Uint8Array([2])); // 0x02 = 最後のレコードの区切り
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, padded));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // レコードサイズ4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

/* 1件のPush送信。戻り値: {ok, status, gone}  goneは購読が無効(404/410)なので削除すべき、の意味 */
export async function sendPush(sub, payloadObj, vapid, opts = {}) {
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(payloadObj)));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthHeader(sub.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(opts.ttl || 86400),
      Urgency: opts.urgency || 'high',
    },
    body,
  });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
}
