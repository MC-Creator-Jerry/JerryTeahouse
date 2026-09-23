// Cloudflare Pages Function: /api/admin
// 茶馆管理台（仅管理员：站主 MC-Creator-Jerry / SSO 标记的 isAdmin / admin:list 内账号）
//
// GET  -> { ok, me, stats, posts[], comments[], users[], bans[], admins[] }
// POST { action, ... } -> { ok, ... }
//   action = delPost   { id }                 删除帖子（连附件一起清）
//          = pinPost   { id, pinned:true|false } 置顶 / 取消置顶
//          = setStatus { id, status:'draft'|'published' }
//          = delComment{ post, id }           删除某帖下的一条评论
//          = ban       { login, hours, reason } 封禁（小时；0 = 永久）
//          = unban     { login }
//          = addAdmin  { login }              授予管理员
//          = removeAdmin { login }            收回管理员
//
// 存储：admin:list = [login,...]；封禁沿用 _lib/ban.js 的 ban:<login> + ban:index
import { getLogin, isAdminLogin, json, OWNER } from '../_lib/auth.js';
import { banUser, unbanUser, listBans } from '../_lib/ban.js';

const POSTS = 'posts:list';
const ADMINS = 'admin:list';

async function readList(kv) {
  const raw = await kv.get(POSTS);
  const list = raw ? JSON.parse(raw) : [];
  return Array.isArray(list) ? list : [];
}

async function readAdmins(kv) {
  const raw = await kv.get(ADMINS);
  let list = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(list)) list = [];
  return list.filter((x) => typeof x === 'string' && x);
}

async function guard(context) {
  const me = await getLogin(context);
  if (!me) return { error: json({ error: 'unauthorized' }, 401) };
  if (!(await isAdminLogin(context, me))) return { error: json({ error: 'forbidden' }, 403) };
  return { me };
}

export async function onRequestGet(context) {
  const g = await guard(context);
  if (g.error) return g.error;
  const kv = context.env.TEAHOUSE_KV;
  const posts = await readList(kv);

  // 评论：按帖子聚合（最多扫描 40 帖，够管理用）
  const comments = [];
  for (const p of posts.slice(0, 40)) {
    try {
      const raw = await kv.get('cmts:' + p.id);
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) {
        arr.forEach((c) => {
          if (c && c.id) comments.push({ post: p.id, postTitle: p.title || '', id: c.id, login: c.login, body: String(c.body || '').slice(0, 200), ts: c.ts || 0 });
        });
      }
    } catch (e) { /* 忽略单帖失败 */ }
  }
  comments.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  // 用户目录 + 发帖数
  let users = [];
  try {
    const raw = await kv.get('users:index');
    const idx = raw ? JSON.parse(raw) : [];
    users = (Array.isArray(idx) ? idx : []).map((u) => ({
      login: u.login,
      name: u.name || u.login,
      avatar: u.avatar || '',
      posts: posts.filter((p) => p.login === u.login).length
    }));
  } catch (e) { users = []; }

  const bans = await listBans(context);
  const admins = await readAdmins(kv);

  return json({
    ok: true,
    me: { login: g.me, isOwner: g.me === OWNER },
    owner: OWNER,
    stats: {
      posts: posts.filter((p) => p.status !== 'draft').length,
      drafts: posts.filter((p) => p.status === 'draft').length,
      pinned: posts.filter((p) => p.pinned).length,
      comments: comments.length,
      users: users.length,
      banned: bans.length
    },
    posts: posts.map((p) => ({
      id: p.id, title: p.title || '', login: p.login, ts: p.ts || 0,
      status: p.status === 'draft' ? 'draft' : 'published',
      pinned: !!p.pinned,
      topics: Array.isArray(p.topics) ? p.topics : []
    })),
    comments: comments.slice(0, 60),
    users,
    bans,
    admins
  });
}

export async function onRequestPost(context) {
  const g = await guard(context);
  if (g.error) return g.error;
  const me = g.me;
  const kv = context.env.TEAHOUSE_KV;
  const body = await context.request.json().catch(() => ({}));
  const action = String(body.action || '');

  if (action === 'delPost') {
    const id = String(body.id || '');
    const list = await readList(kv);
    const target = list.find((p) => p.id === id);
    if (!target) return json({ ok: true, note: 'already_gone' });
    if (Array.isArray(target.files)) {
      for (const f of target.files) {
        if (f && f.key) { try { await kv.delete('file:' + f.key); } catch (e) { /* 忽略 */ } }
      }
    }
    try { await kv.delete('cmts:' + id); } catch (e) { /* 忽略 */ }
    try { await kv.delete('reacts:' + id); } catch (e) { /* 忽略 */ }
    await kv.put(POSTS, JSON.stringify(list.filter((p) => p.id !== id)));
    return json({ ok: true, removed: id });
  }

  if (action === 'pinPost') {
    const id = String(body.id || '');
    const pinned = !!body.pinned;
    const list = await readList(kv);
    const i = list.findIndex((p) => p.id === id);
    if (i === -1) return json({ error: 'not_found' }, 404);
    list[i] = Object.assign({}, list[i], { pinned });
    await kv.put(POSTS, JSON.stringify(list));
    return json({ ok: true, id, pinned });
  }

  if (action === 'setStatus') {
    const id = String(body.id || '');
    const status = body.status === 'draft' ? 'draft' : 'published';
    const list = await readList(kv);
    const i = list.findIndex((p) => p.id === id);
    if (i === -1) return json({ error: 'not_found' }, 404);
    list[i] = Object.assign({}, list[i], { status });
    await kv.put(POSTS, JSON.stringify(list));
    return json({ ok: true, id, status });
  }

  if (action === 'delComment') {
    const post = String(body.post || '');
    const id = String(body.id || '');
    if (!post || !id) return json({ error: 'bad_params' }, 400);
    let arr = [];
    try {
      const raw = await kv.get('cmts:' + post);
      arr = raw ? JSON.parse(raw) : [];
    } catch (e) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    const next = arr.filter((c) => !(c && c.id === id));
    await kv.put('cmts:' + post, JSON.stringify(next));
    return json({ ok: true, removed: id, left: next.length });
  }

  if (action === 'ban') {
    const login = String(body.login || '').trim();
    if (!login) return json({ error: 'bad_params' }, 400);
    if (login === OWNER || login === me) return json({ error: 'cannot_ban_self_or_owner' }, 400);
    if (await isAdminLogin(context, login)) return json({ error: 'cannot_ban_admin' }, 400);
    const hours = Number(body.hours);
    const durs = hours > 0 ? hours * 3600 * 1000 : 0;
    const rec = await banUser(context, login, String(body.reason || '').slice(0, 200), durs);
    return json({ ok: true, ban: rec });
  }

  if (action === 'unban') {
    const login = String(body.login || '').trim();
    if (!login) return json({ error: 'bad_params' }, 400);
    await unbanUser(context, login);
    return json({ ok: true, login });
  }

  if (action === 'addAdmin' || action === 'removeAdmin') {
    const login = String(body.login || '').trim();
    if (!login) return json({ error: 'bad_params' }, 400);
    if (login === OWNER) return json({ error: 'owner_always_admin' }, 400);
    let list = await readAdmins(kv);
    if (action === 'addAdmin') {
      if (!list.includes(login)) list.push(login);
    } else {
      if (login === me) return json({ error: 'cannot_demote_self' }, 400);
      list = list.filter((x) => x !== login);
    }
    await kv.put(ADMINS, JSON.stringify(list));
    return json({ ok: true, admins: list });
  }

  return json({ error: 'unknown_action' }, 400);
}
