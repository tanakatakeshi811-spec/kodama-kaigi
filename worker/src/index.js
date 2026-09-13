/* ===== コダマ会議: 部屋コードの信頼性向上+チャット画像保存 用リレー(Cloudflare Worker) =====
   このWorkerは会議の中身(映像・音声・チャットの実データ)には一切関与しない。今まで通り
   PeerJS(WebRTC)のP2Pメッシュがそのまま実データを運ぶ。ここが受け持つのはあくまで
   「合言葉(部屋コード) → 実際のPeerJS peer ID」の登録・在籍確認・検索という、これまで
   「合言葉をそのままpeer IDとして使う」ことで生じていた衝突・早い者勝ちの不安定さの解消と、
   チャット画像をP2Pで直接送る代わりに保存しておくためのR2ストレージ。

   放課後の居残りの houkago-inokori-relay (Worker+Durable Object) と全く同じ考え方・実装パターン。

   ルーティング:
     /ws        … RoomRegistry Durable Object への WebSocket (部屋コードの登録・在籍確認・検索)
     /upload    … チャット画像をR2に保存(POST、bodyは画像バイナリ)
     /img/:key  … 保存した画像の配信(GET)
     /health, / … 生存確認
*/

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

/* ---- RoomRegistry: 合言葉(部屋コード)の登録・在籍確認・検索 ----
   1インスタンス(idFromName('global'))が全部屋のコードを管理する。
   部屋コードとPeerJSのpeer IDを完全に切り離す(これまでは合言葉をそのままpeer IDにしていたため、
   PeerJSの公開ブローカー上で衝突・「使用中」の早い者勝ち判定にそのまま依存していた)。
   ここで部屋コードの「所有権」をDurable Object側で排他的に管理し、実際の接続先peer IDは
   登録時にホストから預かって参加者からの問い合わせに答えるだけにする。
   「早い者勝ちでホスト/参加者が決まる」という既存の体験そのものは変えていない
   (host_registerがcode_takenを返すかどうかが、そのまま早い者勝ちの判定になる)。 */
export class RoomRegistry {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** @type {Map<string, {peerId:string, ts:number, ws:WebSocket}>} */
    this.rooms = new Map();
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('room registry ok', { headers: CORS });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.attach(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  purgeStale() {
    const now = Date.now();
    // ホスト側は約8秒おきにheartbeatを送る想定。3回分(24秒)+余裕で40秒を閾値にした
    for (const [code, r] of this.rooms) {
      if (now - r.ts > 40000) this.rooms.delete(code);
    }
  }

  attach(ws) {
    let ownedCode = null;
    ws.addEventListener('message', (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }
      if (!msg || !msg.t) return;
      this.purgeStale();

      if (msg.t === 'host_register') {
        const code = String(msg.code || '').toUpperCase().slice(0, 4);
        const peerId = String(msg.peerId || '').slice(0, 100);
        if (!code || !peerId) { this.send(ws, { t: 'code_taken', code }); return; }
        if (this.rooms.has(code)) { this.send(ws, { t: 'code_taken', code }); return; }
        if (ownedCode) this.rooms.delete(ownedCode);
        ownedCode = code;
        this.rooms.set(code, { peerId, ts: Date.now(), ws });
        this.send(ws, { t: 'host_registered', code });

      } else if (msg.t === 'host_heartbeat') {
        if (!ownedCode) return;
        const r = this.rooms.get(ownedCode);
        if (r && r.ws === ws) r.ts = Date.now();

      } else if (msg.t === 'host_unregister') {
        if (ownedCode) {
          const r = this.rooms.get(ownedCode);
          if (r && r.ws === ws) this.rooms.delete(ownedCode);
          ownedCode = null;
        }

      } else if (msg.t === 'join_lookup') {
        const code = String(msg.code || '').toUpperCase().slice(0, 4);
        const r = this.rooms.get(code);
        if (r) this.send(ws, { t: 'join_result', found: true, code, peerId: r.peerId });
        else this.send(ws, { t: 'join_result', found: false, code });

      } else if (msg.t === 'ping') {
        this.send(ws, { t: 'pong' });
      }
    });

    const cleanup = () => {
      if (ownedCode) {
        const r = this.rooms.get(ownedCode);
        if (r && r.ws === ws) this.rooms.delete(ownedCode);
        ownedCode = null;
      }
    };
    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
}

/* ---- チャット画像のR2アップロード/配信 ----
   既存の「Canvasで長辺1280px・JPEG品質0.72にリサイズ圧縮」はクライアント側のまま活かし、
   ここでは圧縮済みの画像バイナリを受け取って保存するだけ。安全のため画像のcontent-type・
   サイズ上限(6MB、圧縮後の画像なら十分すぎる余裕)だけをサーバー側でも確認する。 */
const IMG_MAX_BYTES = 6 * 1024 * 1024;
const EXT_BY_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

async function handleUpload(request, env) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = EXT_BY_TYPE[type];
  if (!ext) return jsonRes({ ok: false, error: 'unsupported content-type' }, 400);
  const lenHeader = request.headers.get('content-length');
  if (lenHeader && Number(lenHeader) > IMG_MAX_BYTES) return jsonRes({ ok: false, error: 'too large' }, 413);

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return jsonRes({ ok: false, error: 'empty body' }, 400);
  if (buf.byteLength > IMG_MAX_BYTES) return jsonRes({ ok: false, error: 'too large' }, 413);

  const key = `${Date.now().toString(36)}-${crypto.randomUUID()}.${ext}`;
  await env.IMAGES.put(key, buf, { httpMetadata: { contentType: type } });
  const url = new URL(request.url);
  return jsonRes({ ok: true, url: `${url.origin}/img/${key}` });
}

async function handleGetImage(request, env, key) {
  const obj = await env.IMAGES.get(key);
  if (!obj) return new Response('not found', { status: 404, headers: CORS });
  const headers = new Headers(CORS);
  headers.set('content-type', (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream');
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers });
}

function jsonRes(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('kodama-kaigi relay: ok', { headers: CORS });
    }
    if (url.pathname === '/ws') {
      const id = env.ROOMS.idFromName('global');
      return env.ROOMS.get(id).fetch(request);
    }
    if (url.pathname === '/upload' && request.method === 'POST') {
      try { return await handleUpload(request, env); }
      catch (e) { return jsonRes({ ok: false, error: 'server error' }, 500); }
    }
    if (url.pathname.startsWith('/img/') && request.method === 'GET') {
      const key = url.pathname.slice('/img/'.length);
      try { return await handleGetImage(request, env, key); }
      catch (e) { return new Response('server error', { status: 500, headers: CORS }); }
    }
    return new Response('not found', { status: 404, headers: CORS });
  },
};
