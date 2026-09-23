// /api/react  — 帖子多表情回应（👍❤️😂😮😢🔥）
// GET  ?post=<id>       -> { login, reactions:{emoji:count}, mine:[emoji] }
// GET  ?posts=id1,id2   -> { reacts:{ [id]:{emoji:count} } }   (no per-user mine)
// POST { post, emoji, action? }  (login required; action 'toggle' 默认)
//      toggle: 该 emoji 下存在则移除，否则加入（可同时选多个）
// Storage: reacts:<postId> = { "<emoji>": [login,...], ... }
import { getLogin, isAdminLogin, json } from '../_lib/auth.js';
import { rateLimit } from '../_lib/rate.js';

const ALLOWED = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const reactKey = (id) => 'reacts:' + id;

async function postExists(kv, postId) {
  const raw = await kv.get('posts:list');
  const list = raw ? JSON.parse(raw) : [];
  return Array.isArray(list) ? list.find((p) => p.id === postId) : null;
}
function normalize(obj) {
  const out = {};
  ALLOWED.forEach(function (e) {
    const arr = (obj && obj[e]) || [];
    if (Array.isArray(arr) && arr.length) out[e] = arr.slice();
  });
  return out;
}
function tally(obj) {
  const out = {};
  Object.keys(obj).forEach(function (k) { out[k] = obj[k].length; });
  return out;
}
function mineSet(obj, login) {
  if (!login) return [];
  return ALLOWED.filter(function (e) { return obj[e] && obj[e].includes(login); });
}

export async function onRequestGet(context) {
  const kv = context.env.TEAHOUSE_KV;
  const url = new URL(context.request.url);
  const login = await getLogin(context);
  const multi = url.searchParams.get('posts');
  if (multi) {
    const ids = multi.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
    const reacts = {};
    for (const id of ids) {
      const raw = await kv.get(reactKey(id));
      if (raw) { try { reacts[id] = tally(normalize(JSON.parse(raw))); } catch (e) {} }
    }
    return json({ reacts });
  }
  const postId = url.searchParams.get('post');
  if (!postId) return json({ error: 'missing_post' }, 400);
  const raw = await kv.get(reactKey(postId));
  const obj = raw ? normalize(JSON.parse(raw)) : {};
  return json({ login: login || null, reactions: tally(obj), mine: mineSet(obj, login) });
}

export async function onRequestPost(context) {
  const login = await getLogin(context);
  if (!login) return json({ error: 'unauthorized' }, 401);
  const rl = await rateLimit(context.env.TEAHOUSE_KV, 'react', login, { limit: 40, windowSec: 60 });
  if (!rl.ok) return json({ error: 'rate_limited', retryAfter: rl.retryAfter }, 429);

  const kv = context.env.TEAHOUSE_KV;
  const body = await context.request.json().catch(() => ({}));
  const postId = String(body.post || '');
  const emoji = String(body.emoji || '');
  if (!postId) return json({ error: 'missing_post' }, 400);
  if (ALLOWED.indexOf(emoji) === -1) return json({ error: 'bad_emoji' }, 400);
  if (!(await postExists(kv, postId))) return json({ error: 'post_not_found' }, 404);

  const raw = await kv.get(reactKey(postId));
  const obj = raw ? normalize(JSON.parse(raw)) : {};
  if (!obj[emoji]) obj[emoji] = [];
  const arr = obj[emoji];
  const i = arr.indexOf(login);
  if (i !== -1) arr.splice(i, 1); else arr.push(login);

  const cleaned = normalize(obj);
  if (Object.keys(cleaned).length) await kv.put(reactKey(postId), JSON.stringify(cleaned));
  else await kv.delete(reactKey(postId));

  return json({ ok: true, reactions: tally(cleaned), mine: mineSet(cleaned, login) });
}
