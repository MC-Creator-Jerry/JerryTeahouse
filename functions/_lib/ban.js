// 小黑屋（封禁）数据层：以茶馆自有 KV（TEAHOUSE_KV）存储。
// 关键：所有时间计算均使用服务器 Date.now()（Cloudflare Worker 运行时时钟），
// 绝不使用任何客户端/设备时间，保证「到期自动解除」以网上时间为准。
// 结构：
//   ban:index          -> JSON 数组，当前被封禁的 login 列表（用于列表/管理）
//   ban:<login>        -> JSON 明细 { login, reason, bannedAt, until }
import { getLogin } from './auth.js';

const PREFIX = 'ban:';
const INDEX = 'ban:index';

// 查询某用户是否处于封禁期（已过期则顺手清理并返回 null）
export async function isBanned(context, login) {
  if (!login) return null;
  const kv = context.env.TEAHOUSE_KV;
  const raw = await kv.get(PREFIX + login).catch(() => null);
  if (!raw) return null;
  let rec;
  try { rec = JSON.parse(raw); } catch (e) { return null; }
  const now = Date.now();
  if (rec.until && now > rec.until) {
    // 自动到期：清理明细与索引
    try { await kv.delete(PREFIX + login); } catch (e) {}
    try {
      const idxRaw = await kv.get(INDEX).catch(() => null);
      let idx = idxRaw ? JSON.parse(idxRaw) : [];
      if (Array.isArray(idx)) {
        idx = idx.filter((l) => l !== login);
        await kv.put(INDEX, JSON.stringify(idx));
      }
    } catch (e) {}
    return null;
  }
  return rec;
}

// 封禁某用户：写入明细 + 加入索引。until 由服务器时间推算。
export async function banUser(context, login, reason, durationMs) {
  const kv = context.env.TEAHOUSE_KV;
  const until = Date.now() + durationMs;
  const rec = { login, reason: reason || '', bannedAt: Date.now(), until };
  await kv.put(PREFIX + login, JSON.stringify(rec));
  let idx = [];
  const idxRaw = await kv.get(INDEX).catch(() => null);
  if (idxRaw) { try { idx = JSON.parse(idxRaw); } catch (e) {} }
  if (!Array.isArray(idx)) idx = [];
  if (!idx.includes(login)) idx.push(login);
  await kv.put(INDEX, JSON.stringify(idx));
  return rec;
}

// 手动解除封禁：删除明细 + 从索引移除
export async function unbanUser(context, login) {
  const kv = context.env.TEAHOUSE_KV;
  await kv.delete(PREFIX + login).catch(() => {});
  const idxRaw = await kv.get(INDEX).catch(() => null);
  let idx = idxRaw ? JSON.parse(idxRaw) : [];
  if (Array.isArray(idx)) {
    idx = idx.filter((l) => l !== login);
    await kv.put(INDEX, JSON.stringify(idx));
  }
}

// 列出当前封禁（清理已过期项；返回按封禁时间倒序的明细数组）
export async function listBans(context) {
  const kv = context.env.TEAHOUSE_KV;
  const idxRaw = await kv.get(INDEX).catch(() => null);
  let idx = idxRaw ? JSON.parse(idxRaw) : [];
  if (!Array.isArray(idx)) idx = [];
  const now = Date.now();
  const out = [];
  const stillBanned = [];
  for (const login of idx) {
    const raw = await kv.get(PREFIX + login).catch(() => null);
    if (!raw) continue;
    let rec;
    try { rec = JSON.parse(raw); } catch (e) { continue; }
    if (rec.until && now > rec.until) {
      try { await kv.delete(PREFIX + login); } catch (e) {}
      continue;
    }
    out.push(rec);
    stillBanned.push(login);
  }
  // 同步索引（移除已过期项）
  if (stillBanned.length !== idx.length) {
    await kv.put(INDEX, JSON.stringify(stillBanned)).catch(() => {});
  }
  out.sort((a, b) => (b.bannedAt || 0) - (a.bannedAt || 0));
  return out;
}
