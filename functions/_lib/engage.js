// 小蓝页 · 互动数据统一层（点赞 / 收藏 / 关注 / 举报）
//
// 【为什么需要这个模块】
// 互动数据此前散落在 6 组互不相干的 KV key 上，且每个 api 各自裸写
// `JSON.parse(...)`。任意一处值异常，整个批量接口就会抛错返回 500，
// 而前端 post-actions.js 的 apiGet 是「失败就返回 {}」，
// 于是整页所有帖子的点赞数会一起变成 0 —— 这就是「点赞又没了」的结构性原因。
//
// 本模块是互动 KV 的唯一入口，保证三件事：
//   1) 所有读取都容错：任何异常值都降级为 0 / []，绝不抛错；
//   2) 帖子维度的计数快照写入专用 key `engage:<postId>`，作为展示权威源；
//   3) 快照缺失或损坏时，按用户列表惰性重建（自愈，无需手工迁移脚本）。
//
// 【存储布局】KV namespace 绑定 USER_PREFS
//   likes:post:<id>      -> [login,...]          点赞用户（状态权威源）
//   followers:post:<id>  -> [login,...]          关注该帖的用户（状态权威源）
//   fav:<login>          -> [postId,...]         用户收藏夹（状态权威源）
//   favcount:<id>        -> "N"                  收藏计数（历史遗留，自愈时回填用）
//   reports:post:<id>    -> [{reporter,ts,reason}]
//   engage:<id>          -> {like,fav,flw,ts}    ★计数快照：列表/详情展示唯一来源

export const ENGAGE_PREFIX = 'engage:';

export const likesKey = (id) => 'likes:post:' + id;
export const followersKey = (id) => 'followers:post:' + id;
export const reportsKey = (id) => 'reports:post:' + id;
export const favCountKey = (id) => 'favcount:' + id;
export const favKey = (login) => 'fav:' + login;
export const blockKey = (login) => 'block:' + login;
export const followKey = (login) => 'follow:' + login;
export const engageKey = (id) => ENGAGE_PREFIX + id;

function num(v) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** 容错 JSON 解析：任何异常（缺值 / 坏 JSON / 类型不符）都返回 fallback，绝不抛错。 */
export function safeJSON(raw, fallback) {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

export async function readArr(kv, key) {
  const v = safeJSON(await kv.get(key), []);
  return Array.isArray(v) ? v : [];
}

export async function readNum(kv, key) {
  return num(safeJSON(await kv.get(key), 0));
}

export async function writeArr(kv, key, arr) {
  await kv.put(key, JSON.stringify(Array.isArray(arr) ? arr : []));
}

/** 把计数快照整体写回 engage:<id>（失败不抛错，展示层有自愈兜底）。 */
export async function putCounts(kv, postId, counts) {
  const payload = {
    like: num(counts && counts.like),
    fav: num(counts && counts.fav),
    flw: num(counts && counts.flw),
    ts: Date.now(),
  };
  try {
    await kv.put(engageKey(postId), JSON.stringify(payload));
  } catch (e) { /* 快照写失败不影响权威用户列表 */ }
  return payload;
}

/**
 * 按权威用户列表重建计数快照（自愈路径）。
 * 仅在快照缺失/损坏，或显式 force 时调用。
 */
export async function rebuildCounts(kv, postId) {
  const [likes, followers, favCount] = await Promise.all([
    readArr(kv, likesKey(postId)),
    readArr(kv, followersKey(postId)),
    readNum(kv, favCountKey(postId)),
  ]);
  return putCounts(kv, postId, { like: likes.length, fav: favCount, flw: followers.length });
}

/**
 * 读取某帖计数快照；缺失/损坏则自愈重建。
 * @returns {Promise<{like:number,fav:number,flw:number}>}
 */
export async function readCounts(kv, postId, opts) {
  if (!(opts && opts.force)) {
    const snap = safeJSON(await kv.get(engageKey(postId)), null);
    if (snap && typeof snap === 'object') {
      return { like: num(snap.like), fav: num(snap.fav), flw: num(snap.flw) };
    }
  }
  return rebuildCounts(kv, postId);
}

/**
 * 局部更新计数快照。快照不存在时先自愈重建（保证未 patch 的字段不会被打成 0），
 * 再写入 patch 里的权威值。
 * @param {object} patch 形如 { like: 3 } / { fav: 5 } / { flw: 2 }
 */
export async function patchCounts(kv, postId, patch) {
  const snap = safeJSON(await kv.get(engageKey(postId)), null);
  const base = snap && typeof snap === 'object'
    ? { like: num(snap.like), fav: num(snap.fav), flw: num(snap.flw) }
    : await rebuildCounts(kv, postId).then((c) => ({ like: c.like, fav: c.fav, flw: c.flw }));
  const merged = { like: base.like, fav: base.fav, flw: base.flw };
  if (patch && typeof patch === 'object') {
    for (const k of Object.keys(patch)) merged[k] = num(patch[k]);
  }
  return putCounts(kv, postId, merged);
}

/**
 * 读取一批帖子的计数快照，供列表页一次取齐。
 * 每帖 1 次 KV 读（快照存在时），明显优于以前「每帖 4~5 次」的散读。
 */
export async function readCountsBatch(kv, postIds) {
  const out = {};
  const ids = Array.isArray(postIds) ? postIds : [];
  for (const id of ids) {
    out[id] = await readCounts(kv, id);
  }
  return out;
}
