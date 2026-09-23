// Cloudflare Pages Function: /api/post
// GET  (no param)            -> { posts:[...] }            (public list, published only, newest first)
// GET  ?id=<id>              -> { ...post }                (single; drafts only for author/admin)
// GET  ?ids=id1,id2          -> { posts:[...] }            (batch; published only, for favorites)
// GET  ?drafts=1             -> { posts:[...] }            (login required; only requester's drafts)
// POST {title,body,files?}   -> { ok, post }              (login required; forbidden scan; status=published)
// PATCH {id,title,body,files?,status?} -> { ok, post }    (author/admin; status: draft|published)
// DELETE ?id=                -> { ok }                     (author or admin only)
// Storage: KV "posts:list" (array, newest first)
import { getLogin, isAdminLogin, json } from '../_lib/auth.js';
import { scanTexts } from '../_lib/forbidden.js';
import { sanitizeHtml, htmlToText } from '../_lib/sanitize.js';
import { topicsForPost } from '../_lib/topics.js';
import { rateLimit } from '../_lib/rate.js';
import { isBanned } from '../_lib/ban.js';

const KEY = 'posts:list';
const MAX = 200;
const BODY_MAX = 20000;

async function readList(kv) {
  const raw = await kv.get(KEY);
  let list = raw ? JSON.parse(raw) : [];
  return Array.isArray(list) ? list : [];
}

function publicView(p, all) {
  if (!p) return p;
  const body = typeof p.body === 'string' ? sanitizeHtml(p.body) : p.body;
  const topics = Array.isArray(p.topics) ? p.topics : topicsForPost(p.title, htmlToText(body || ''));
  const v = { ...p, body, topics };
  if (p.repostOf && all && Array.isArray(all)) {
    const orig = all.find((x) => x.id === p.repostOf);
    if (orig) { v.repostLogin = orig.login; v.repostTitle = orig.title; }
  }
  return v;
}

export async function onRequestGet(context) {
  const kv = context.env.TEAHOUSE_KV;
  const url = new URL(context.request.url);
  const id = url.searchParams.get('id');
  const ids = url.searchParams.get('ids');
  const drafts = url.searchParams.get('drafts');
  const login = await getLogin(context);
  const list = await readList(kv);

  // 单帖
  if (id) {
    const p = list.find((x) => x.id === id);
    if (!p) return json({ error: 'not_found' }, 404);
    const isOwnerOrAdmin = login && (p.login === login || (await isAdminLogin(context, login)));
    if (p.status === 'draft' && !isOwnerOrAdmin) return json({ error: 'not_found' }, 404);
    return json(publicView(p, list));
  }
  // 批量（收藏页用）
  if (ids) {
    const want = ids.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
    const map = {};
    list.forEach((p) => { if (want.includes(p.id)) map[p.id] = p; });
    const out = want.map((id) => {
      const p = map[id];
      if (!p || p.status === 'draft') return null; // 批量只返回公开帖
      return { id: p.id, login: p.login, title: p.title, ts: p.ts, topics: p.topics || [] };
    }).filter(Boolean);
    return json({ posts: out });
  }
  // 我的草稿
  if (drafts) {
    if (!login) return json({ error: 'unauthorized' }, 401);
    const out = list.filter((p) => p.login === login && p.status === 'draft').map((p) => publicView(p, list));
    return json({ posts: out });
  }
  // 公开列表（仅已发布）：置顶帖排最前，其余按时间倒序
  const safe = list
    .filter((p) => p.status !== 'draft')
    .map((p) => publicView(p, list))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.ts || 0) - (a.ts || 0));
  return json({ posts: safe });
}

export async function onRequestPost(context) {
  const login = await getLogin(context);
  if (!login) return json({ error: 'unauthorized' }, 401);
  const banned = await isBanned(context, login);
  if (banned) return json({ error: 'banned', until: banned.until }, 403);
  const rl = await rateLimit(context.env.TEAHOUSE_KV, 'post', login, { limit: 10, windowSec: 60 });
  if (!rl.ok) return json({ error: 'rate_limited', retryAfter: rl.retryAfter }, 429);

  const body = await context.request.json().catch(() => ({}));
  const title = String(body.title || '').slice(0, 200);
  const raw = String(body.body || '').slice(0, BODY_MAX);
  const text = htmlToText(raw);
  if (!title.trim() && !text.trim()) return json({ error: 'empty' }, 400);
  const bad = scanTexts([title, text]);
  if (bad) return json({ error: 'forbidden', word: bad }, 400);

  const kv = context.env.TEAHOUSE_KV;
  const list = await readList(kv);
  const clean = sanitizeHtml(raw);

  let files = [];
  if (Array.isArray(body.files)) {
    files = body.files
      .filter(function (f) { return f && typeof f.key === 'string' && /^[A-Za-z0-9-]+$/.test(f.key); })
      .slice(0, 20)
      .map(function (f) {
        return {
          key: f.key,
          name: String(f.name || 'file').slice(0, 200),
          type: String(f.type || 'application/octet-stream').slice(0, 200),
          size: (typeof f.size === 'number' && f.size >= 0) ? f.size : 0,
        };
      });
  }

  const topics = topicsForPost(title, text);
  let repostOf = '';
  if (typeof body.repostOf === 'string') {
    const rid = body.repostOf.trim();
    if (rid && list.some((x) => x.id === rid)) repostOf = rid;
  }
  const post = { id: String(Date.now()), ts: Date.now(), login, title, body: clean, files, topics, status: 'published', repostOf };
  list.unshift(post);
  if (list.length > MAX) list.length = MAX;
  await kv.put(KEY, JSON.stringify(list));
  return json({ ok: true, post: { id: post.id, status: post.status } });
}

export async function onRequestPatch(context) {
  const login = await getLogin(context);
  if (!login) return json({ error: 'unauthorized' }, 401);
  const rl = await rateLimit(context.env.TEAHOUSE_KV, 'edit', login, { limit: 20, windowSec: 60 });
  if (!rl.ok) return json({ error: 'rate_limited', retryAfter: rl.retryAfter }, 429);

  const kv = context.env.TEAHOUSE_KV;
  const body = await context.request.json().catch(() => ({}));
  const id = String(body.id || '');
  const list = await readList(kv);
  const idx = list.findIndex((p) => p.id === id);
  if (idx === -1) return json({ error: 'not_found' }, 404);
  const target = list[idx];
  if (target.login !== login && !(await isAdminLogin(context, login))) return json({ error: 'forbidden' }, 403);

  const title = typeof body.title === 'string' ? body.title.slice(0, 200) : target.title;
  const raw = typeof body.body === 'string' ? body.body.slice(0, BODY_MAX) : target.body;
  const text = htmlToText(raw);
  if (!title.trim() && !text.trim()) return json({ error: 'empty' }, 400);
  const bad = scanTexts([title, text]);
  if (bad) return json({ error: 'forbidden', word: bad }, 400);

  const clean = sanitizeHtml(raw);
  let files = target.files;
  if (Array.isArray(body.files)) {
    files = body.files
      .filter(function (f) { return f && typeof f.key === 'string' && /^[A-Za-z0-9-]+$/.test(f.key); })
      .slice(0, 20)
      .map(function (f) {
        return {
          key: f.key,
          name: String(f.name || 'file').slice(0, 200),
          type: String(f.type || 'application/octet-stream').slice(0, 200),
          size: (typeof f.size === 'number' && f.size >= 0) ? f.size : 0,
        };
      });
  }
  const topics = topicsForPost(title, text);
  const status = body.status === 'draft' ? 'draft' : 'published';
  const updated = { ...target, title, body: clean, files, topics, status, editedTs: Date.now() };
  list[idx] = updated;
  await kv.put(KEY, JSON.stringify(list));
  return json({ ok: true, post: { id: updated.id, status: updated.status } });
}

export async function onRequestDelete(context) {
  const login = await getLogin(context);
  if (!login) return json({ error: 'unauthorized' }, 401);
  const url = new URL(context.request.url);
  const id = url.searchParams.get('id');
  const kv = context.env.TEAHOUSE_KV;
  const list = await readList(kv);
  const target = list.find((p) => p.id === id);
  if (!target) return json({ ok: true });
  if (target.login !== login && !(await isAdminLogin(context, login))) {
    return json({ error: 'forbidden' }, 403);
  }
  if (target.files && Array.isArray(target.files)) {
    for (const f of target.files) {
      if (f && f.key) { try { await kv.delete('file:' + f.key); } catch (e) {} }
    }
  }
  const next = list.filter((p) => p.id !== id);
  await kv.put(KEY, JSON.stringify(next));
  return json({ ok: true });
}
