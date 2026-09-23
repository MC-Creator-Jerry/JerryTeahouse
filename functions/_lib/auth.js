// 茶馆鉴权层：把「小蓝页 auth.js 的导出面」用茶馆自己的 SSO 会话实现。
// 保持与小蓝页同名同签名（getLogin / isAdminLogin / json / OWNER），
// 这样从帖子系统搬过来的接口代码可以原样工作。
// 差异：小蓝页 getLogin 读 gh_user cookie（同步）；茶馆要查 KV 会话，故为 async，
//       搬运过来的调用点已被改为 await getLogin(context)。
import { getSession } from './teaauth.js';

export const OWNER = 'MC-Creator-Jerry';

export function getCookie(req, name) {
  const h = req.headers.get('cookie');
  if (!h) return null;
  const m = h.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

// 当前登录者的 login（未登录 -> null）
export async function getLogin(context) {
  const s = await getSession(context);
  return s && s.login ? s.login : null;
}

// 当前会话档案（含 isAdmin）
export async function getSessionProfile(context) {
  return await getSession(context);
}

// 管理员 = 站主 / 小蓝页 SSO 标记的 isAdmin / 茶馆 admin:list 里的账号
export async function isAdminLogin(context, login) {
  if (!login) return false;
  if (login === OWNER) return true;
  const s = await getSession(context);
  if (s && s.login === login && s.isAdmin) return true;
  try {
    const raw = await context.env.TEAHOUSE_KV.get('admin:list');
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.includes(login)) return true;
    }
  } catch (e) { /* 忽略 */ }
  return false;
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
