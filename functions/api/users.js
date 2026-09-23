// Cloudflare Pages Function: /api/users
// GET ?q=term -> { users:[{login,name,bio,avatar}] }  (login required; searches directory "users:index")
import { getLogin, json } from '../_lib/auth.js';

function defaultAvatar(login) {
  return 'https://github.com/' + encodeURIComponent(login) + '.png';
}

export async function onRequestGet(context) {
  const login = await getLogin(context);
  if (!login) return json({ error: 'unauthorized' }, 401);

  const url = new URL(context.request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();

  const idxRaw = await context.env.TEAHOUSE_KV.get('users:index');
  let idx = idxRaw ? JSON.parse(idxRaw) : [];
  if (!Array.isArray(idx)) idx = [];

  if (q) {
    idx = idx.filter(
      (u) =>
        (u.login || '').toLowerCase().includes(q) ||
        (u.name || '').toLowerCase().includes(q) ||
        (u.bio || '').toLowerCase().includes(q)
    );
  }
  idx = idx.slice(0, 50).map((u) => ({
    login: u.login,
    name: u.name || u.login,
    bio: u.bio || '',
    avatar: u.avatar || defaultAvatar(u.login),
  }));
  return json({ users: idx });
}
