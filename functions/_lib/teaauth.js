// 茶馆会话库（TEAHOUSE_KV）
//
// 身份来源是「小蓝页 SSO」：小蓝页签发一次性 code，茶馆服务端换回身份后，
// 在 jerryteahouse.pages.dev 自己的域下种 tea_sid 会话 Cookie。
// 跨站 Cookie 无法共享（pages.dev 属公共后缀），所以两边各存各的会话，
// 只有身份（sub = 小蓝页 acct:<id>）是同一个。
//
// KV 键：
//   tsess:<sid>      -> JSON 会话档案（30 天）
//   sso:state:<state> -> JSON {ts} 一次性 state（10 分钟，防 CSRF）
//   ssoseen:<state>  -> '1' 已消费标记（callback 兜底）

export const COOKIE = 'tea_sid';
export const SSO_COOKIE = 'tea_sso';

export function getCookie(req, name) {
  const h = req.headers.get('cookie');
  if (!h) return null;
  const m = h.split(';').map(function (s) { return s.trim(); })
    .find(function (s) { return s.startsWith(name + '='); });
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

export function randomId(bytes) {
  const n = bytes || 24;
  const a = new Uint8Array(n);
  (globalThis.crypto || crypto).getRandomValues(a);
  let s = '';
  for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0');
  return s;
}

export function sessionCookie(sid, maxAge) {
  return COOKIE + '=' + sid + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAge;
}

export function clearSessionCookie() {
  return COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

export function ssoStateCookie(state, maxAge) {
  return SSO_COOKIE + '=' + state + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAge;
}

export function clearSsoStateCookie() {
  return SSO_COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

export function json(obj, status, extraHeaders) {
  const h = Object.assign(
    { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    extraHeaders || {}
  );
  return new Response(JSON.stringify(obj), { status: status || 200, headers: h });
}

// profile: { sub, login, name, avatar_url, isAdmin, provider }
export async function createSession(kv, profile) {
  const sid = randomId(24);
  const rec = Object.assign({ ts: Date.now() }, profile);
  await kv.put('tsess:' + sid, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 30 });
  return sid;
}

export async function getSession(context) {
  const kv = context.env.TEAHOUSE_KV;
  if (!kv) return null;
  const sid = getCookie(context.request, COOKIE);
  if (!sid) return null;
  let raw = null;
  try { raw = await kv.get('tsess:' + sid); } catch (e) { return null; }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

export async function destroySession(context) {
  const kv = context.env.TEAHOUSE_KV;
  const sid = getCookie(context.request, COOKIE);
  if (kv && sid) {
    try { await kv.delete('tsess:' + sid); } catch (e) { /* 忽略 */ }
  }
}

// 当前会话的公开档案（给前端用）
export function sessionProfile(sess) {
  if (!sess) return null;
  return {
    id: sess.sub || null,
    login: sess.login || '',
    name: sess.name || sess.login || '茶客',
    avatar_url: sess.avatar_url || '',
    isAdmin: !!sess.isAdmin,
    provider: sess.provider || 'xiaolan'
  };
}

export async function readJson(req) {
  try {
    const ct = req.headers.get('content-type') || '';
    if (ct.indexOf('application/json') >= 0) return await req.json();
    const fd = await req.formData();
    const o = {};
    fd.forEach(function (v, k) { o[k] = v; });
    return o;
  } catch (e) {
    return {};
  }
}
