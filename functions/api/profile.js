// Cloudflare Pages Function: /api/profile
// 茶馆个人资料（独立于小蓝页：这里存的是「茶馆里的我」——昵称 / 简介 / 头像 / 个人站点）
//
// GET                     -> 自己的完整档案（需登录；未登录 401）
// GET  ?user=<login>      -> 任意用户公开档案 + 统计（公开）
// POST {name,bio,avatar,site} -> 更新自己的档案（需登录；写 uprofile:<login> 并同步 users:index）
//
// 存储：
//   uprofile:<login> = { login, name, bio, avatar, site, joined, ts }
//   users:index      = [{login,name,bio,avatar}]（帖子/评论/@提及 显示用，写后同步）
import { getLogin, isAdminLogin, json } from '../_lib/auth.js';
import { scanTexts } from '../_lib/forbidden.js';
import { rateLimit } from '../_lib/rate.js';

const PFX = 'uprofile:';
const NAME_MAX = 24;
const BIO_MAX = 200;
const SITE_MAX = 200;
const AVATAR_MAX = 500;

function defaultAvatar(login) {
  return login ? 'https://github.com/' + encodeURIComponent(login) + '.png' : '';
}

function cleanAvatar(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (!/^(https?:\/\/|\/)/i.test(s)) return '';
  if (s.length > AVATAR_MAX) return '';
  if (/^\/\//.test(s)) return '';
  return s;
}

function cleanSite(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) return '';
  return s.slice(0, SITE_MAX);
}

async function readIndex(kv) {
  const raw = await kv.get('users:index');
  let idx = raw ? JSON.parse(raw) : [];
  return Array.isArray(idx) ? idx : [];
}

async function syncIndex(kv, rec) {
  try {
    const idx = await readIndex(kv);
    const i = idx.findIndex((x) => x && x.login === rec.login);
    const merged = { login: rec.login, name: rec.name, bio: rec.bio, avatar: rec.avatar };
    if (i >= 0) idx[i] = Object.assign({}, idx[i], merged); else idx.unshift(merged);
    if (idx.length > 300) idx.length = 300;
    await kv.put('users:index', JSON.stringify(idx));
  } catch (e) { /* 目录同步失败不影响资料保存 */ }
}

// 统计：帖子数 / 评论数 / 获赞数（按自己最近 30 帖逐帖读取，控制 KV 读次数）
async function statsFor(kv, login) {
  let list = [];
  try {
    const raw = await kv.get('posts:list');
    const all = raw ? JSON.parse(raw) : [];
    list = Array.isArray(all) ? all : [];
  } catch (e) { list = []; }

  const mine = list.filter((p) => p && p.login === login);
  const published = mine.filter((p) => p.status !== 'draft');
  const sample = mine.slice(0, 30);

  let comments = 0, likes = 0;
  for (const p of sample) {
    try {
      const cRaw = await kv.get('cmts:' + p.id);
      const arr = cRaw ? JSON.parse(cRaw) : [];
      if (Array.isArray(arr)) comments += arr.filter((c) => c && c.login === login).length;
    } catch (e) { /* 忽略 */ }
    try {
      const rRaw = await kv.get('reacts:' + p.id);
      const obj = rRaw ? JSON.parse(rRaw) : {};
      if (obj && typeof obj === 'object') {
        Object.keys(obj).forEach((k) => { if (Array.isArray(obj[k])) likes += obj[k].length; });
      }
    } catch (e) { /* 忽略 */ }
  }
  return { posts: published.length, drafts: mine.length - published.length, comments, likes };
}

export async function onRequestGet(context) {
  const kv = context.env.TEAHOUSE_KV;
  const me = await getLogin(context);
  const url = new URL(context.request.url);
  const want = (url.searchParams.get('user') || '').trim();

  // 自己的完整档案
  if (!want) {
    if (!me) return json({ error: 'unauthorized' }, 401);
    let rec = null;
    try { rec = await kv.get(PFX + me, { type: 'json' }); } catch (e) { rec = null; }
    const idx = await readIndex(kv);
    const fromIdx = idx.find((u) => u && u.login === me) || {};
    const profile = {
      login: me,
      name: (rec && rec.name) || fromIdx.name || me,
      bio: (rec && rec.bio) || fromIdx.bio || '',
      avatar: (rec && rec.avatar) || fromIdx.avatar || defaultAvatar(me),
      site: (rec && rec.site) || '',
      joined: (rec && rec.joined) || null,
      ts: (rec && rec.ts) || null
    };
    const isAdmin = await isAdminLogin(context, me);
    return json({ ok: true, profile, isMe: true, isAdmin, stats: await statsFor(kv, me) });
  }

  // 任意用户公开档案
  let rec = null;
  try { rec = await kv.get(PFX + want, { type: 'json' }); } catch (e) { rec = null; }
  const idx = await readIndex(kv);
  const fromIdx = idx.find((u) => u && u.login === want) || null;
  if (!rec && !fromIdx) {
    let known = false;
    try {
      const raw = await kv.get('posts:list');
      const all = raw ? JSON.parse(raw) : [];
      known = Array.isArray(all) && all.some((p) => p && p.login === want);
    } catch (e) { known = false; }
    if (!known) return json({ error: 'not_found' }, 404);
  }
  const profile = {
    login: want,
    name: (rec && rec.name) || (fromIdx && fromIdx.name) || want,
    bio: (rec && rec.bio) || (fromIdx && fromIdx.bio) || '',
    avatar: (rec && rec.avatar) || (fromIdx && fromIdx.avatar) || defaultAvatar(want),
    site: (rec && rec.site) || '',
    joined: (rec && rec.joined) || null,
    ts: (rec && rec.ts) || null
  };
  const isAdmin = await isAdminLogin(context, want);
  const canAdmin = me ? await isAdminLogin(context, me) : false;
  return json({ ok: true, profile, isMe: me === want, isAdmin, canAdmin, stats: await statsFor(kv, want) });
}

export async function onRequestPost(context) {
  const kv = context.env.TEAHOUSE_KV;
  const me = await getLogin(context);
  if (!me) return json({ error: 'unauthorized' }, 401);

  const rl = await rateLimit(kv, 'profile', me, { limit: 20, windowSec: 60 });
  if (!rl.ok) return json({ error: 'rate_limited', retryAfter: rl.retryAfter }, 429);

  const body = await context.request.json().catch(() => ({}));
  const name = String(body.name == null ? '' : body.name).trim().slice(0, NAME_MAX);
  const bio = String(body.bio == null ? '' : body.bio).trim().slice(0, BIO_MAX);
  const avatar = cleanAvatar(body.avatar);
  const site = cleanSite(body.site);

  if (!name) return json({ error: 'empty_name' }, 400);
  if (/[<>\r\n]/.test(name)) return json({ error: 'bad_name' }, 400);
  const bad = scanTexts([name, bio]);
  if (bad) return json({ error: 'forbidden', word: bad }, 400);
  if (String(body.avatar || '').trim() && !avatar) return json({ error: 'bad_avatar' }, 400);
  if (String(body.site || '').trim() && !site) return json({ error: 'bad_site' }, 400);

  let prev = null;
  try { prev = await kv.get(PFX + me, { type: 'json' }); } catch (e) { prev = null; }

  const rec = {
    login: me,
    name,
    bio,
    avatar,
    site,
    joined: (prev && prev.joined) || Date.now(),
    ts: Date.now()
  };
  await kv.put(PFX + me, JSON.stringify(rec));
  await syncIndex(kv, rec);
  return json({ ok: true, profile: rec });
}
