// Cloudflare Pages Function: /api/comment
//   GET  /api/comment?post=<id>   取该帖评论
//   POST /api/comment             发评论（需小蓝页 SSO 登录） body:{post,text}
// KV（TEAHOUSE_KV）：comments:<postId> -> JSON [{id,author,authorSub,text,ts,when}]（最多 200 条）
import { getSession, readJson, randomId, json } from '../_lib/teaauth.js';

export async function onRequestGet(context) {
  const kv = context.env.TEAHOUSE_KV;
  const url = new URL(context.request.url);
  const postId = url.searchParams.get('post');
  if (!postId) return json({ error: 'missing_post' }, 400);
  if (!kv) return json({ comments: [], count: 0 });
  const raw = await kv.get('comments:' + postId);
  let comments = [];
  if (raw) { try { comments = JSON.parse(raw) || []; } catch (e) { comments = []; } }
  if (!Array.isArray(comments)) comments = [];
  return json({ comments: comments, count: comments.length });
}

export async function onRequestPost(context) {
  const kv = context.env.TEAHOUSE_KV;
  if (!kv) return json({ error: 'not_ready' }, 503);

  const sess = await getSession(context);
  if (!sess) return json({ error: 'login_required' }, 401);

  const body = await readJson(context.request);
  const postId = String(body.post || '').trim();
  const text = String(body.text || '').trim();
  if (!postId) return json({ error: 'missing_post' }, 400);
  if (text.length < 1 || text.length > 1000) {
    return json({ error: 'bad_text', hint: '评论需要 1–1000 字' }, 400);
  }

  const praw = await kv.get('post:' + postId);
  if (!praw) return json({ error: 'post_not_found' }, 404);

  let comments = [];
  try { comments = JSON.parse(await kv.get('comments:' + postId)) || []; } catch (e) { comments = []; }
  if (!Array.isArray(comments)) comments = [];

  const now = Date.now();
  const c = {
    id: now.toString(36) + randomId(3),
    ts: now,
    when: new Date(now).toISOString().slice(0, 16).replace('T', ' '),
    author: sess.name || sess.login || '茶客',
    authorSub: sess.sub || '',
    text: text
  };
  comments.push(c);
  if (comments.length > 200) comments = comments.slice(-200);
  await kv.put('comments:' + postId, JSON.stringify(comments));

  // 同步评论数（失败不影响评论本身已写入）
  try {
    const p = JSON.parse(praw);
    p.comments = comments.length;
    await kv.put('post:' + postId, JSON.stringify(p));
    const rawIdx = await kv.get('posts:index');
    const index = rawIdx ? JSON.parse(rawIdx) : [];
    if (Array.isArray(index)) {
      let changed = false;
      index.forEach(function (x) { if (x && x.id === postId) { x.comments = comments.length; changed = true; } });
      if (changed) await kv.put('posts:index', JSON.stringify(index));
    }
  } catch (e) { /* 忽略 */ }

  return json({ ok: true, comment: c, count: comments.length });
}

export async function onRequest(context) {
  const m = context.request.method;
  if (m === 'GET') return onRequestGet(context);
  if (m === 'POST') return onRequestPost(context);
  return json({ error: 'method_not_allowed' }, 405);
}
