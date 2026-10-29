/* ===== 通知(Web Push)の登録所: Durable Object =====
   役割は「フレンドIDごとの通知先(購読)と、通知を送ってよい相手(allow)の記録」と「通知の中継」だけ。
   チャットや通話の中身そのものは今まで通りP2Pで送られ、ここには保存しない
   (通知の本文は、相手に表示するための短い文だけをその場でPushサービスへ暗号化して渡し、保存はしない)。

   認証: 端末ごとに作った秘密のtoken(端末にだけ保存)を、初回登録時にSHA-256にして預かる。
         以後の更新・送信にはtokenが必要。フレンドIDだけ知っていても、他人になりすませない。
   送信できる相手: 受け取る側が自分の端末から「このフレンドIDからの通知は受け取る」と登録した相手(allow)だけ。
   Pushサービス: SSRF対策として、既知のPushサービスのドメイン以外には送らない。 */
import { sendPush } from './push.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};
const ID_RE = /^f[a-z0-9]{16}$/;
const CODE_RE = /^[A-Z0-9]{4}$/;
const PUSH_HOSTS = ['googleapis.com', 'mozilla.com', 'push.apple.com', 'notify.windows.com'];
const MAX_SUBS = 6;
const MAX_ALLOW = 300;

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { ...CORS, 'content-type': 'application/json' } });
}
function clip(s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').slice(0, n); }
async function sha256hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}
function okEndpoint(ep) {
  try {
    const u = new URL(ep);
    if (u.protocol !== 'https:') return false;
    return PUSH_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch (e) { return false; }
}
function okSub(sub) {
  return !!(sub && typeof sub.endpoint === 'string' && okEndpoint(sub.endpoint) && sub.keys
    && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string'
    && sub.keys.p256dh.length < 200 && sub.keys.auth.length < 60);
}

export class PushRegistry {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rate = new Map(); // "from>to" -> [timestamps]
  }

  vapid() {
    if (this._vapid !== undefined) return this._vapid;
    this._vapid = null;
    try {
      const k = JSON.parse(this.env.VAPID_KEYS || 'null');
      if (k && k.publicKey && k.privateKey) {
        this._vapid = { publicKey: k.publicKey, privateKey: k.privateKey, subject: this.env.VAPID_SUBJECT || 'https://tanakatakeshi811-spec.github.io/kodama-kaigi/' };
      }
    } catch (e) {}
    return this._vapid;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/push/key' && request.method === 'GET') {
      const v = this.vapid();
      return v ? json({ ok: true, publicKey: v.publicKey }) : json({ ok: false, error: 'not_configured' }, 503);
    }
    if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
    let body;
    try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
    try {
      if (path === '/push/register') return await this.register(body);
      if (path === '/push/unregister') return await this.unregister(body);
      if (path === '/push/notify') return await this.notify(body);
    } catch (e) { return json({ ok: false, error: 'server_error' }, 500); }
    return json({ ok: false, error: 'not_found' }, 404);
  }

  async auth(id, token) {
    if (!ID_RE.test(String(id || '')) || typeof token !== 'string' || token.length < 16 || token.length > 100) return { status: 400 };
    const th = await sha256hex(token);
    const rec = await this.state.storage.get('u:' + id);
    if (rec && rec.th !== th) return { status: 403 };
    return { rec: rec || { th, subs: [], allow: [], name: '' }, th };
  }

  async register(b) {
    const a = await this.auth(b.id, b.token);
    if (a.status) return json({ ok: false, error: a.status === 403 ? 'bad_token' : 'bad_request' }, a.status);
    const rec = a.rec;
    if (Array.isArray(b.allow)) {
      rec.allow = Array.from(new Set(b.allow.map(String).filter(x => ID_RE.test(x)))).slice(0, MAX_ALLOW);
    }
    if (b.name != null) rec.name = clip(b.name, 30);
    if (b.sub != null) {
      if (!okSub(b.sub)) return json({ ok: false, error: 'bad_subscription' }, 400);
      rec.subs = rec.subs.filter(s => s.endpoint !== b.sub.endpoint);
      rec.subs.push({ endpoint: b.sub.endpoint, keys: { p256dh: b.sub.keys.p256dh, auth: b.sub.keys.auth }, t: Date.now() });
      if (rec.subs.length > MAX_SUBS) rec.subs = rec.subs.slice(-MAX_SUBS);
    }
    rec.u = Date.now();
    await this.state.storage.put('u:' + b.id, rec);
    return json({ ok: true, devices: rec.subs.length });
  }

  async unregister(b) {
    const a = await this.auth(b.id, b.token);
    if (a.status) return json({ ok: false, error: a.status === 403 ? 'bad_token' : 'bad_request' }, a.status);
    const rec = a.rec;
    rec.subs = b.endpoint ? rec.subs.filter(s => s.endpoint !== b.endpoint) : [];
    await this.state.storage.put('u:' + b.id, rec);
    return json({ ok: true, devices: rec.subs.length });
  }

  throttled(key, max) {
    const now = Date.now();
    const arr = (this.rate.get(key) || []).filter(t => now - t < 60000);
    if (arr.length >= max) { this.rate.set(key, arr); return true; }
    arr.push(now); this.rate.set(key, arr);
    if (this.rate.size > 2000) { for (const [k, v] of this.rate) { if (!v.length || now - v[v.length - 1] > 60000) this.rate.delete(k); } }
    return false;
  }

  async notify(b) {
    const v = this.vapid();
    if (!v) return json({ ok: false, error: 'not_configured' }, 503);
    const a = await this.auth(b.from, b.token);
    if (a.status) return json({ ok: false, error: a.status === 403 ? 'bad_token' : 'bad_request' }, a.status);
    // 未登録のfromはauthが新規レコードを作って返すだけ(保存はしていない)。送信者は事前にregisterしている必要がある
    const saved = await this.state.storage.get('u:' + b.from);
    if (!saved) return json({ ok: false, error: 'sender_not_registered' }, 403);
    const to = String(b.to || '');
    if (!ID_RE.test(to)) return json({ ok: false, error: 'bad_request' }, 400);
    if (this.throttled(b.from + '>' + to, 30)) return json({ ok: false, error: 'rate_limited' }, 429);
    const target = await this.state.storage.get('u:' + to);
    // 相手が未登録・許可していない・購読が無い場合も、存在を教えないよう同じ形で返す
    if (!target || !target.subs.length || !(to === b.from || target.allow.includes(b.from))) return json({ ok: true, sent: 0 });

    const kind = ['chat', 'call', 'invite', 'test'].includes(b.kind) ? b.kind : 'chat';
    const name = clip(b.name || saved.name || 'フレンド', 30);
    let payload, ttl, urgency;
    if (kind === 'call') {
      payload = { kind, title: `📞 ${name}さんから着信`, body: 'タップして応答します', url: `?fchat=${b.from}&call=1`, tag: 'call-' + b.from, renotify: true };
      ttl = 60; urgency = 'high';
    } else if (kind === 'invite') {
      const code = clip(b.code, 4).toUpperCase();
      if (!CODE_RE.test(code)) return json({ ok: false, error: 'bad_code' }, 400);
      const room = clip(b.room, 40) || '会議';
      const important = b.important === true; // 「重要通知」: 通知が出しっぱなし・長めに残る・見た目も目立つ(見た目はsw.js側)
      payload = important
        ? { kind, important: true, title: `🚨【重要】${name}さんから会議への招待`, body: `「${room}」に今すぐ参加してください`, url: `?code=${code}&autojoin=1`, tag: 'invite-' + code, code, room, renotify: true }
        : { kind, title: `🎥 ${name}さんが会議に招待しています`, body: `「${room}」に参加しませんか？`, url: `?code=${code}&autojoin=1`, tag: 'invite-' + code, code, room, renotify: true };
      ttl = important ? 3600 : 900; urgency = 'high';
    } else if (kind === 'test') {
      // variant: 通知の見た目をその場で試すための種類(中身は仮のもの。招待や着信は実際には発生しない)
      const variant = ['invite', 'important', 'call', 'chat'].includes(b.variant) ? b.variant : '';
      const T = {
        invite: ['🎥 テストさんが会議に招待しています', '「テスト会議」に参加しませんか？'],
        important: ['🚨【重要】テストさんから会議への招待', '「テスト会議」に今すぐ参加してください'],
        call: ['📞 テストさんから着信', 'タップして応答します'],
        chat: ['💬 テスト', 'こんにちは！通知の見た目のテストです'],
      };
      payload = { kind, variant, title: variant ? T[variant][0] : '🔔 通知テスト', body: variant ? T[variant][1] : 'この端末に通知が届いています', url: '', tag: 'test', room: 'テスト会議' };
      ttl = 60; urgency = 'normal';
    } else {
      payload = { kind, title: `💬 ${name}`, body: clip(b.text, 100) || 'メッセージが届きました', url: `?fchat=${b.from}`, tag: 'chat-' + b.from };
      ttl = 86400; urgency = 'normal';
    }
    payload.fid = b.from; payload.name = name; payload.ts = Date.now();

    let sent = 0, removed = 0;
    const keep = [];
    await Promise.all(target.subs.map(async s => {
      try {
        const r = await sendPush(s, payload, v, { ttl, urgency });
        if (r.ok) { sent++; keep.push(s); }
        else if (r.gone) removed++;
        else keep.push(s);
      } catch (e) { keep.push(s); }
    }));
    if (removed) {
      const cur = await this.state.storage.get('u:' + to);
      if (cur) { cur.subs = cur.subs.filter(s => keep.some(k => k.endpoint === s.endpoint)); await this.state.storage.put('u:' + to, cur); }
    }
    return json({ ok: true, sent, removed });
  }
}
