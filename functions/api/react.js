// Cloudflare Pages Function: /api/react
//   POST /api/react  body:{post}  -> { ok, liked, count }   切换「喜欢」（登录用户）
// KV（TEAHOUSE_KV）：likes:<postId> -> JSON 数组，存小蓝页账户 sub（去重即一人一票）
import { getSession, readJson, json } from '../_lib/teaauth.js';

export async function onRequestPost(context) {
  const kv = context.env.TEAHOUSE_KV;
  if (!kv) return json({ error: 'not_ready' }, 503);

  const sess = await getSession(context);
  if (!sess) return json({ error: 'login_required' }, 401);

  const body = await readJson(context.request);
  const postId = String(body.post || '').trim();
  if (!postId) return json({ error: 'missing_post' }, 400);

  const praw = await kv.get('post:' + postId);
  if (!praw) return json({ error: 'post_not_found' }, 404);

  const sub = String(sess.sub || '');
  if (!sub) return json({ error: 'bad_session' }, 401);

  let arr = [];
  try { arr = JSON.parse(await kv.get('likes:' + postId)) || []; } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];

  const at = arr.indexOf(sub);
  let liked = false;
  if (at >= 0) {
    arr.splice(at, 1);
  } else {
    arr.push(sub);
    liked = true;
  }
  await kv.put('likes:' + postId, JSON.stringify(arr));

  const count = arr.length;

  // 同步计数到帖子与索引（失败不影响点赞本身）
  try {
    const p = JSON.parse(praw);
    p.likes = count;
    await kv.put('post:' + postId, JSON.stringify(p));

    const rawIdx = await kv.get('posts:index');
    const idx = rawIdx ? JSON.parse(rawIdx) : [];
    if (Array.isArray(idx)) {
      let changed = false;
      idx.forEach(function (x) { if (x && x.id === postId) { x.likes = count; changed = true; } });
      if (changed) await kv.put('posts:index', JSON.stringify(idx));
    }
  } catch (e) { /* 忽略 */ }

  return json({ ok: true, liked: liked, count: count });
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return json({ error: 'method_not_allowed' }, 405);
}
