// 茶馆 · 当前登录用户
// GET /api/me
// 返回同时兼容两套前端：
//   茶馆自有页（assets/teahouse.js）读 { loggedIn, user }
//   搬到茶馆的小蓝页模板页（帖子中心/详情/发帖）读顶层 { login, isAdmin, name, avatar_url }
// 未登录一律 200（不用 401，前端分支更简单）。
import { getSession, sessionProfile, json } from '../_lib/teaauth.js';

export async function onRequestGet(context) {
  const sess = await getSession(context);
  const user = sessionProfile(sess);
  if (!user) {
    return json({ loggedIn: false, user: null, error: 'unauthorized' });
  }
  return json(Object.assign({ loggedIn: true, user: user }, user));
}
