// コダマ会議の通知(Web Push)機能を Cloudflare Worker に反映する。
// やること: ①通知用の鍵(VAPID)を作る(初回だけ・このPCに保存) ②Workerを更新 ③鍵をWorkerの秘密設定に登録 ④動作確認
// 事前に Cloudflare にログイン済み(npx wrangler login)であること。以前Workerを更新したときと同じ手順で動く。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
process.chdir(dir);
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function ensureKeys() {
  const f = join(dir, 'vapid-keys.json');
  if (existsSync(f)) { console.log('[1/4] 通知用の鍵: 保存済みのものを使います'); return JSON.parse(readFileSync(f, 'utf8')); }
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const keys = { publicKey: b64u(pub), privateKey: jwk.d };
  writeFileSync(f, JSON.stringify(keys));
  console.log('[1/4] 通知用の鍵を新しく作りました(vapid-keys.json。人に見せない・消さないでください)');
  return keys;
}
function run(args, input) {
  const r = spawnSync('npx', ['--yes', 'wrangler', ...args], { stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit', input, shell: true });
  return r.status === 0;
}

const keys = await ensureKeys();
console.log('[2/4] Workerを更新しています…');
if (!run(['deploy'])) { console.error('\n[失敗] Workerを更新できませんでした。Cloudflareにログインしていない場合は、先に「npx wrangler login」を実行してください。'); process.exit(1); }
console.log('[3/4] 通知用の鍵をWorkerに登録しています…');
if (!run(['secret', 'put', 'VAPID_KEYS'], JSON.stringify(keys))) { console.error('\n[失敗] 鍵を登録できませんでした。'); process.exit(1); }
console.log('[4/4] 動作確認…');
await new Promise(z => setTimeout(z, 3000));
try {
  const j = await (await fetch('https://kodama-kaigi-relay.shunri-ai.workers.dev/push/key')).json();
  if (j.publicKey === keys.publicKey) console.log('\n✔ 完了です。コダマ会議の🔔から通知をオンにできます。');
  else console.log('\n△ 反映待ちかもしれません。1分ほどしてから、もう一度このファイルを実行してください。', j);
} catch (e) { console.log('\n△ 確認できませんでした。1分ほどしてからもう一度実行してください。', String(e)); }
