// 通知 / 评论存储与解析辅助（KV: USER_PREFS）
// 三类通知：
//   system  系统通知（广播，管理员发布）   -> notices:list / notices:seen:<login>
//   message 消息通知（定向给某用户）       -> msg:<login> / msg:seen:<login>
//   comment 评论通知（评论/回复/@提及）     -> cnotif:<login> / cnotif:seen:<login>

export const CNOTIF_KEY = (l) => 'cnotif:' + l;
export const CNOTIF_SEEN = (l) => 'cnotif:seen:' + l;
export const MSG_KEY = (l) => 'msg:' + l;
export const MSG_SEEN = (l) => 'msg:seen:' + l;

async function readArr(kv, key) {
  const raw = await kv.get(key);
  const a = raw ? JSON.parse(raw) : [];
  return Array.isArray(a) ? a : [];
}
async function pushArr(kv, key, item, cap = 200) {
  const a = await readArr(kv, key);
  a.unshift(item);
  if (a.length > cap) a.length = cap;
  await kv.put(key, JSON.stringify(a));
}

// 从文本解析 @login（GitHub 登录名允许字母数字与连字符）
export function parseMentions(text) {
  if (!text) return [];
  const re = /@([A-Za-z0-9-]{1,39})/g;
  const set = new Set();
  let m;
  while ((m = re.exec(text)) !== null) set.add(m[1]);
  return Array.from(set);
}

// 已知用户集合（来自用户目录 users:index）
export async function knownLogins(kv) {
  const raw = await kv.get('users:index');
  const idx = raw ? JSON.parse(raw) : [];
  const s = new Set();
  if (Array.isArray(idx)) idx.forEach((u) => { if (u.login) s.add(u.login); });
  return s;
}

export async function pushCommentNotif(kv, toLogin, payload) {
  if (!toLogin) return;
  await pushArr(kv, CNOTIF_KEY(toLogin), payload);
}
export async function pushMessage(kv, toLogin, payload) {
  if (!toLogin) return;
  await pushArr(kv, MSG_KEY(toLogin), payload);
}
export async function getCommentNotifs(kv, login) { return readArr(kv, CNOTIF_KEY(login)); }
export async function getMessages(kv, login) { return readArr(kv, MSG_KEY(login)); }
