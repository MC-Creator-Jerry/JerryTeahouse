// 茶馆 · 退出登录
// GET/POST /api/logout -> 销毁服务端会话并清 Cookie
import { destroySession, clearSessionCookie, json } from '../_lib/teaauth.js';

export async function onRequest(context) {
  const m = context.request.method;
  if (m !== 'GET' && m !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  await destroySession(context);
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
}
