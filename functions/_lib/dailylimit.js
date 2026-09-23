// 茶馆 · 每日发帖额度（纯逻辑层，便于本地单测）
// 规则：
//   - 普通用户每天 10 篇
//   - 管理员不限
//   - 持有小蓝页「茶馆·发布功能升级」（叠加型权益）额外 +10 → 20
// 计数按 UTC+8 的「自然日」归零（主力用户在中国，用本地日更符合直觉）。
// KV 无原子性：并发下极小概率多算 1~2 篇，个人站量级可接受（与 rate.js 同样的取舍）。
const IDP = 'https://mc-creator-jerry-webpage.pages.dev';

export const BASE_DAILY_LIMIT = 10;
export const PLUS_BONUS = 10;

function num(ts) { return ts == null ? Date.now() : ts; }

// 把时间戳换算成 UTC+8 的 YYYYMMDD 数字，作为「当天」的键
export function utc8Ymd(ts) {
  const d = new Date(num(ts) + 8 * 3600 * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

// 距「下一个 UTC+8 零点」还有多少秒（KV 过期用，保证第二天自动清零）
export function secondsToNextUtc8Midnight(ts) {
  const now = num(ts);
  const dayMs = 86400 * 1000;
  const shifted = now + 8 * 3600 * 1000;
  const nextMid = (Math.floor(shifted / dayMs) + 1) * dayMs - 8 * 3600 * 1000;
  return Math.max(60, Math.ceil((nextMid - now) / 1000));
}

export function dailyKey(login, ts) {
  return 'teaposts:' + login + ':' + utc8Ymd(ts);
}

export async function dailyPostCount(kv, login, ts) {
  if (!kv || !login) return 0;
  const raw = await kv.get(dailyKey(login, ts)).catch(() => null);
  if (!raw) return 0;
  try {
    const rec = JSON.parse(raw);
    return rec && Number.isFinite(rec.count) && rec.count > 0 ? rec.count : 0;
  } catch (e) { return 0; }
}

// 计数 +1，并让记录在次日 UTC+8 零点自动过期
export async function incDailyPost(kv, login, ts) {
  if (!kv || !login) return 0;
  const now = num(ts);
  const n = (await dailyPostCount(kv, login, now)) + 1;
  try {
    await kv.put(dailyKey(login, now), JSON.stringify({ count: n, ts: now }), {
      expirationTtl: secondsToNextUtc8Midnight(now) + 60,
    });
  } catch (e) { /* 计数失败不阻断发帖 */ }
  return n;
}

// 纯函数：管理员不限（Infinity）；否则 10（+10）
export function computeDailyLimit(isAdmin, hasPlus) {
  if (isAdmin) return Infinity;
  return BASE_DAILY_LIMIT + (hasPlus ? PLUS_BONUS : 0);
}

// 查小蓝页是否持有「茶馆·发布功能升级」。
// 任何异常 / 未配置 / 超时一律按「没有」处理 —— 保守，绝不因远端故障而误放行。
export async function hasTeahousePlus(context, login) {
  if (!login) return false;
  const secret = context.env && context.env.SSO_CLIENT_SECRET;
  if (!secret) return false;
  try {
    const r = await fetch(IDP + '/api/sponsor-check?login=' + encodeURIComponent(login), {
      headers: { authorization: 'Bearer ' + secret },
      cache: 'no-store',
    });
    if (!r || !r.ok) return false;
    const j = await r.json();
    const tp = j && j.teahouse_plus;
    if (!tp || !tp.active) return false;
    if (tp.exp && Date.now() > tp.exp) return false;
    return true;
  } catch (e) {
    return false;
  }
}
