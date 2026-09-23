// Cloudflare Pages Function: /api/comment
// GET  ?post=<id>         -> { comments:[...], count }            (public list for a post, oldest first)
// POST {post,body,replyTo?} -> { ok, comment }                  (login required; forbidden scan; parses @mentions; emits comment notifications)
// DELETE ?post=<id>&id=<cid> -> { ok }                          (author or admin only)
// Storage: KV "cmts:<postId>" (array) + notifications via _lib/notif.js
import { getLogin, isAdminLogin, json } from '../_lib/auth.js';
import { scanTexts } from '../_lib/forbidden.js';
import { parseMentions, knownLogins, pushCommentNotif } from '../_lib/notif.js';
import { isBanned } from '../_lib/ban.js';

const KEY = (post) => 'cmts:' + post;

async function readPost(kv, postId) {
  const raw = await kv.get('posts:list');
  const list = raw ? JSON.parse(raw) : [];
  return Array.isArray(list) ? list.find((p) => p.id === postId) : null;
}
async function readComments(kv, postId) {
  const raw = await kv.get(KEY(postId));
  const a = raw ? JSON.parse(raw) : [];
  return Array.isArray(a) ? a : [];
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const postId = url.searchParams.get('post');
  if (!postId) return json({ error: 'missing_post' }, 400);
  const login = await getLogin(context);
  const arr = await readComments(context.env.TEAHOUSE_KV, postId);
  const out = arr.map((c) => {
    const likes = Array.isArray(c.likes) ? c.likes : [];
    const liked = login ? likes.includes(login) : false;
    // 不把 likes 数组泄漏给前端，只返回计数与当前用户状态
    const { likes: _omit, ...rest } = c;
    return { ...rest, likeCount: likes.length, liked };
  });
  return json({ comments: out, count: out.length });
}

export async function onRequestPost(context) {
  const login = await getLogin(context);
  if (!login) return json({ error: 'unauthorized' }, 401);
  const banned = await isBanned(context, login);
  if (banned) return json({ error: 'banned', until: banned.until }, 403);
  const kv = context.env.TEAHOUSE_KV;
  const body = await context.request.json().catch(() => ({}));
  const postId = String(body.post || '');
  if (!postId) return json({ error: 'missing_post' }, 400);

  // 评论点赞 / 取消点赞
  if (body.action === 'like' || body.action === 'unlike') {
    const cid = String(body.id || '');
    if (!cid) return json({ error: 'missing_comment_id' }, 400);
    const arr = await readComments(kv, postId);
    const c = arr.find((x) => x.id === cid);
    if (!c) return json({ error: 'comment_not_found' }, 404);
    c.likes = Array.isArray(c.likes) ? c.likes : [];
    if (body.action === 'like') {
      if (!c.likes.includes(login)) c.likes.push(login);
    } else {
      c.likes = c.likes.filter((l) => l !== login);
    }
    await kv.put(KEY(postId), JSON.stringify(arr));
    return json({ ok: true, likeCount: c.likes.length, liked: body.action === 'like' });
  }

  const text = String(body.body || '').slice(0, 2000).trim();
  const replyTo = body.replyTo ? String(body.replyTo) : null;
  if (!text) return json({ error: 'empty' }, 400);
  const bad = scanTexts([text]);
  if (bad) return json({ error: 'forbidden', word: bad }, 400);

  const post = await readPost(kv, postId);
  if (!post) return json({ error: 'post_not_found' }, 404);

  // 显示名
  let name = login;
  const profRaw = await kv.get('profile:' + login);
  if (profRaw) { try { const p = JSON.parse(profRaw); if (p && p.name) name = p.name; } catch (e) {} }

  // 解析 @ 并校验是否为已知用户
  const mentions = parseMentions(text);
  const known = mentions.length ? await knownLogins(kv) : new Set();

  const id = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
  const comment = {
    id, ts: Date.now(), postId, login, name,
    body: text, replyTo, mentions,
    likes: [],
  };
  const arr = await readComments(kv, postId);
  arr.push(comment);
  await kv.put(KEY(postId), JSON.stringify(arr));

  // 去重通知目标
  const login0 = login;
  const targets = new Map(); // login -> Set(types)
  function add(tLogin, type) {
    if (!tLogin || tLogin === login0) return;
    const e = targets.get(tLogin) || new Set();
    e.add(type);
    targets.set(tLogin, e);
  }
  if (post.login && post.login !== login) add(post.login, 'comment');
  if (replyTo) {
    const parent = arr.find((c) => c.id === replyTo);
    if (parent && parent.login && parent.login !== login) add(parent.login, 'reply');
  }
  mentions.forEach((m) => { if (known.has(m) && m !== login) add(m, 'mention'); });

  const postTitle = post.title || '（无标题）';
  const snippet = text.slice(0, 120);
  for (const [to, types] of targets) {
    const base = { ts: Date.now(), fromLogin: login, fromName: name, postId, postTitle, commentId: id, text: snippet };
    if (types.has('mention')) {
      await pushCommentNotif(kv, to, { ...base, id: base.ts + '-' + to + '-m', type: 'mention' });
    }
    if (types.has('reply')) {
      await pushCommentNotif(kv, to, { ...base, id: base.ts + '-' + to + '-r', type: 'reply' });
    }
    if (types.has('comment')) {
      await pushCommentNotif(kv, to, { ...base, id: base.ts + '-' + to + '-c', type: 'comment' });
    }
  }

  // 通知"关注该帖"的用户（排除评论者本人与帖主，帖主已单独收到 comment 通知）
  const followersRaw = await kv.get('followers:post:' + postId);
  const followers = followersRaw ? JSON.parse(followersRaw) : [];
  if (Array.isArray(followers) && followers.length) {
    const fBase = { ts: Date.now(), fromLogin: login, fromName: name, postId, postTitle, commentId: id, text: snippet };
    for (const f of followers) {
      if (!f || f === login0 || f === post.login) continue;
      await pushCommentNotif(kv, f, { ...fBase, id: fBase.ts + '-' + f + '-f', type: 'comment', fContext: true });
    }
  }

  return json({ ok: true, comment });
}

export async function onRequestDelete(context) {
  const login = await getLogin(context);
  if (!login) return json({ error: 'unauthorized' }, 401);
  const url = new URL(context.request.url);
  const postId = url.searchParams.get('post');
  const id = url.searchParams.get('id');
  const kv = context.env.TEAHOUSE_KV;
  const arr = await readComments(kv, postId);
  const target = arr.find((c) => c.id === id);
  if (!target) return json({ ok: true });
  if (target.login !== login && !(await isAdminLogin(context, login))) {
    return json({ error: 'forbidden' }, 403);
  }
  const next = arr.filter((c) => c.id !== id);
  await kv.put(KEY(postId), JSON.stringify(next));
  return json({ ok: true });
}
