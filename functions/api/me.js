// 茶馆 · 当前登录用户
// GET /api/me -> { loggedIn, user }
// 未登录返回 200 + loggedIn:false（前端判断更简单，不用处理 401 分支）
import { getSession, sessionProfile, json } from '../_lib/teaauth.js';

export async function onRequestGet(context) {
  const sess = await getSession(context);
  const user = sessionProfile(sess);
  return json({ loggedIn: !!user, user: user });
}
