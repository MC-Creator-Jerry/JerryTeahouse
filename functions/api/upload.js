// Cloudflare Pages Function: /api/upload
// 接收附件文件，存入 KV（file:<uuid>，原始字节），返回可引用 key。
// 限制：单文件 <= 20MB（KV 单值上限 25MB，留余量）；需登录。
import { getLogin, json } from '../_lib/auth.js';

const MAX = 20 * 1024 * 1024; // 20MB

export async function onRequestPost(context) {
  const login = await getLogin(context);
  if (!login) return json({ error: 'unauthorized' }, 401);

  let form;
  try {
    form = await context.request.formData();
  } catch (e) {
    return json({ error: 'bad_form' }, 400);
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return json({ error: 'no_file' }, 400);
  if (file.size > MAX) return json({ error: 'too_large', max: MAX }, 413);

  let buf;
  try {
    buf = await file.arrayBuffer();
  } catch (e) {
    return json({ error: 'read_failed' }, 400);
  }

  const key = crypto.randomUUID();
  const meta = {
    name: String(file.name || 'file'),
    type: String(file.type || 'application/octet-stream'),
    size: file.size,
    owner: login,
    ts: Date.now(),
  };
  try {
    await context.env.TEAHOUSE_KV.put('file:' + key, buf, { metadata: meta });
  } catch (e) {
    return json({ error: 'store_failed' }, 500);
  }
  return json({ ok: true, key, name: meta.name, type: meta.type, size: meta.size });
}
