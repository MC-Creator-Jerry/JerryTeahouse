// 简单滑动窗口限流（KV 最终一致，适合个人站量级）
// 默认单动作每分钟上限；超出返回 { ok:false, retryAfter }，调用方应回 429。
export async function rateLimit(kv, action, key, { limit = 10, windowSec = 60 } = {}) {
  if (!kv || !key) return { ok: true, limit, remaining: limit, retryAfter: 0 };
  const k = 'rate:' + action + ':' + key;
  const now = Date.now();
  let rec = null;
  try {
    const raw = await kv.get(k);
    if (raw) rec = JSON.parse(raw);
  } catch (e) { /* ignore */ }
  if (!rec || typeof rec !== 'object' || !rec.resetAt || now >= rec.resetAt) {
    rec = { count: 0, resetAt: now + windowSec * 1000 };
  }
  if (rec.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
    return { ok: false, retryAfter, limit, remaining: 0 };
  }
  rec.count += 1;
  try {
    await kv.put(k, JSON.stringify(rec), { expirationTtl: windowSec + 10 });
  } catch (e) { /* ignore */ }
  return { ok: true, limit, remaining: limit - rec.count, retryAfter: Math.max(1, Math.ceil((rec.resetAt - now) / 1000)) };
}

// 从请求里取客户端标识：登录用户用 login，否则用 CF 连接 IP（兜底取 socket）。
export function clientKey(context) {
  const login = getLoginSafe(context);
  if (login) return 'u:' + login;
  const cf = context.request.headers.get('cf-connecting-ip');
  if (cf) return 'ip:' + cf;
  const fwd = context.request.headers.get('x-forwarded-for');
  if (fwd) return 'ip:' + String(fwd).split(',')[0].trim();
  return 'ip:unknown';
}
function getLoginSafe(context) {
  try {
    const h = context.request.headers.get('cookie') || '';
    const m = h.split(';').map((s) => s.trim()).find((s) => s.indexOf('gh_user=') === 0);
    return m ? decodeURIComponent(m.slice('gh_user='.length)) : null;
  } catch (e) { return null; }
}
