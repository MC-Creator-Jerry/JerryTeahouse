// Cloudflare Pages Function: /api/post
//   GET  /api/post            列表（?sort=hot 按热度）
//   GET  /api/post?id=xxx     单篇
//   POST /api/post            发帖（需小蓝页 SSO 登录）
// KV（TEAHOUSE_KV）：
//   posts:index -> JSON 数组 [{id,title,excerpt,author,tags,likes,comments,ts,when}]（最多 200 条）
//   post:<id>   -> JSON {id,title,body,author,tags,likes,comments,ts,when}
// 未绑定 KV 时优雅降级为空列表（不影响静态页）。
import { getSession, readJson, randomId, json } from '../_lib/teaauth.js';

export async function onRequestGet(context) {
  const kv = context.env.TEAHOUSE_KV;
  const url = new URL(context.request.url);
  const id = url.searchParams.get('id');

  if (id) {
    if (!kv) return json({ error: 'not_ready' }, 503);
    const raw = await kv.get('post:' + id);
    if (!raw) return json({ error: 'not_found' }, 404);
    let post = null;
    try { post = JSON.parse(raw); } catch (e) { post = null; }
    if (!post) return json({ error: 'bad_data' }, 500);

    // 已登录时附带「我是否点过赞」，供详情页初始化按钮状态
    let liked = false;
    try {
      const sess = await getSession(context);
      if (sess && sess.sub) {
        const lraw = await kv.get('likes:' + id);
        if (lraw) {
          const arr = JSON.parse(lraw);
          liked = Array.isArray(arr) && arr.indexOf(String(sess.sub)) >= 0;
        }
      }
    } catch (e) { liked = false; }

    return json({ post: post, liked: liked });
  }

  if (!kv) return json({ posts: [] });
  const raw = await kv.get('posts:index');
  let posts = [];
  if (raw) { try { posts = JSON.parse(raw) || []; } catch (e) { posts = []; } }
  if (!Array.isArray(posts)) posts = [];
  const sort = url.searchParams.get('sort') || 'all';
  posts = posts.slice();
  if (sort === 'hot') posts.sort(function (a, b) { return (b.likes || 0) - (a.likes || 0); });
  else posts.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  return json({ posts: posts });
}

function cleanTags(v) {
  const raw = Array.isArray(v) ? v.join(',') : String(v || '');
  const seen = [];
  raw.split(/[,，、;；\s]+/).forEach(function (t) {
    const s = t.trim().slice(0, 20);
    if (s && seen.indexOf(s) < 0 && seen.length < 5) seen.push(s);
  });
  return seen;
}

export async function onRequestPost(context) {
  const kv = context.env.TEAHOUSE_KV;
  if (!kv) return json({ error: 'not_ready' }, 503);

  const sess = await getSession(context);
  if (!sess) return json({ error: 'login_required' }, 401);

  const body = await readJson(context.request);
  const title = String(body.title || '').trim();
  const text = String(body.body || '').trim();
  const tags = cleanTags(body.tags);

  if (title.length < 1 || title.length > 80) {
    return json({ error: 'bad_title', hint: '标题需要 1–80 字' }, 400);
  }
  if (text.length < 1 || text.length > 20000) {
    return json({ error: 'bad_body', hint: '正文需要 1–20000 字' }, 400);
  }

  const now = Date.now();
  const id = now.toString(36) + randomId(4);
  const when = new Date(now).toISOString().slice(0, 10);
  const author = sess.name || sess.login || '茶客';

  const post = {
    id: id, ts: now, when: when,
    title: title, body: text, tags: tags,
    author: author,
    authorLogin: sess.login || '',
    authorSub: sess.sub || '',
    likes: 0, comments: 0
  };
  await kv.put('post:' + id, JSON.stringify(post));

  let index = [];
  try { index = JSON.parse(await kv.get('posts:index')) || []; } catch (e) { index = []; }
  if (!Array.isArray(index)) index = [];
  index.unshift({
    id: id, ts: now, when: when, title: title, tags: tags,
    author: author, excerpt: text.slice(0, 160).replace(/\n+/g, ' '),
    likes: 0, comments: 0
  });
  if (index.length > 200) index = index.slice(0, 200);
  await kv.put('posts:index', JSON.stringify(index));

  return json({ ok: true, id: id });
}

export async function onRequest(context) {
  const m = context.request.method;
  if (m === 'GET') return onRequestGet(context);
  if (m === 'POST') return onRequestPost(context);
  return json({ error: 'method_not_allowed' }, 405);
}
