// Cloudflare Pages Function: /api/post-actions
// 帖子维度的用户操作：关注(follow) / 屏蔽(block) / 举报(report) / 点赞(like) / 收藏(fav)
// GET  ?post=<id>            -> { login, post, followed, blocked, reported, liked, likeCount, faved, favCount }
// GET  ?posts=id1,id2,...    -> { states: { [id]: {...} } }
// GET  ?favs=1               -> { favs:[postId,...] }   (login required)
// POST { post, action, reason? }
//      action: follow|unfollow|block|unblock|report|like|unlike|fav|unfav
//      -> { ok, followed, blocked, reported, liked, likeCount, faved, favCount }
//
// 所有互动 KV 读写统一经 _lib/engage.js（容错 + 计数快照 + 自愈），
// 不再在本文件裸写 JSON.parse —— 历史上那会让一个坏值把整页点赞数打成 0。
import { getLogin, isAdminLogin, json, OWNER } from '../_lib/auth.js';
import { pushMessage } from '../_lib/notif.js';
import { rateLimit } from '../_lib/rate.js';
import {
  safeJSON, readArr, writeArr,
  likesKey, followersKey, reportsKey, favKey, blockKey, followKey, favCountKey,
  readCounts, patchCounts,
} from '../_lib/engage.js';

const reportsListKey = 'reports:list';

async function postExists(kv, postId) {
  const list = safeJSON(await kv.get('posts:list'), []);
  return Array.isArray(list) ? list.find((p) => p && p.id === postId) : null;
}

export async function onRequestGet(context) {
  const login = await getLogin(context);
  const kv = context.env.TEAHOUSE_KV;
  const url = new URL(context.request.url);
  const multi = url.searchParams.get('posts');

  // 我的收藏列表
  if (url.searchParams.get('favs')) {
    if (!login) return json({ error: 'unauthorized' }, 401);
    const favs = await readArr(kv, favKey(login));
    return json({ favs });
  }

  if (multi) {
    const ids = multi.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
    const states = {};
    let myBlocks = [], myFavs = [];
    if (login) { myBlocks = await readArr(kv, blockKey(login)); myFavs = await readArr(kv, favKey(login)); }
    const myBlockSet = new Set(myBlocks), myFavSet = new Set(myFavs);
    for (const id of ids) {
      // 计数走专用快照：每帖 1 次读（缺快照时自动自愈重建）
      const counts = await readCounts(kv, id);
      let followed = false, reported = false, liked = false;
      if (login) {
        const followers = await readArr(kv, followersKey(id));
        followed = followers.includes(login);
        const reports = await readArr(kv, reportsKey(id));
        reported = reports.some((r) => r && r.reporter === login);
        const likes = await readArr(kv, likesKey(id));
        liked = likes.includes(login);
      }
      states[id] = {
        followed,
        blocked: myBlockSet.has(id),
        reported,
        liked,
        likeCount: counts.like,
        faved: myFavSet.has(id),
        favCount: counts.fav,
      };
    }
    return json({ states });
  }

  const postId = url.searchParams.get('post');
  if (!postId) return json({ error: 'missing_post' }, 400);
  const counts = await readCounts(kv, postId);
  const res = {
    login: login || null,
    post: postId,
    followed: false,
    blocked: false,
    reported: false,
    liked: false,
    likeCount: counts.like,
    faved: false,
    favCount: counts.fav,
  };
  if (login) {
    const followers = await readArr(kv, followersKey(postId));
    const blocks = await readArr(kv, blockKey(login));
    const reports = await readArr(kv, reportsKey(postId));
    const favs = await readArr(kv, favKey(login));
    const likes = await readArr(kv, likesKey(postId));
    res.followed = followers.includes(login);
    res.blocked = blocks.includes(postId);
    res.reported = reports.some((r) => r && r.reporter === login);
    res.liked = likes.includes(login);
    res.faved = favs.includes(postId);
  }
  return json(res);
}

export async function onRequestPost(context) {
  const login = await getLogin(context);
  if (!login) return json({ error: 'unauthorized' }, 401);
  const rl = await rateLimit(context.env.TEAHOUSE_KV, 'act', login, { limit: 60, windowSec: 60 });
  if (!rl.ok) return json({ error: 'rate_limited', retryAfter: rl.retryAfter }, 429);

  const kv = context.env.TEAHOUSE_KV;
  const body = await context.request.json().catch(() => ({}));
  const postId = String(body.post || '');
  const action = String(body.action || '');
  const allowed = ['follow', 'unfollow', 'block', 'unblock', 'report', 'like', 'unlike', 'fav', 'unfav'];
  if (!postId || !allowed.includes(action)) return json({ error: 'bad_request' }, 400);
  const post = await postExists(kv, postId);
  if (!post) return json({ error: 'post_not_found' }, 404);

  if (action === 'follow' || action === 'unfollow') {
    const followers = await readArr(kv, followersKey(postId));
    const fi = followers.indexOf(login);
    if (action === 'follow') { if (fi === -1) followers.push(login); }
    else { if (fi !== -1) followers.splice(fi, 1); }
    await writeArr(kv, followersKey(postId), followers);
    const my = await readArr(kv, followKey(login));
    const mi = my.indexOf(postId);
    if (action === 'follow') { if (mi === -1) my.push(postId); }
    else { if (mi !== -1) my.splice(mi, 1); }
    await writeArr(kv, followKey(login), my);
    await patchCounts(kv, postId, { flw: followers.length });
  } else if (action === 'block' || action === 'unblock') {
    if (action === 'block' && post.login === OWNER) return json({ error: 'block_owner_forbidden' }, 403);
    const blocks = await readArr(kv, blockKey(login));
    const bi = blocks.indexOf(postId);
    if (action === 'block') { if (bi === -1) blocks.push(postId); }
    else { if (bi !== -1) blocks.splice(bi, 1); }
    await writeArr(kv, blockKey(login), blocks);
  } else if (action === 'report') {
    const reason = String(body.reason || '').slice(0, 200);
    const reports = await readArr(kv, reportsKey(postId));
    if (!reports.some((r) => r && r.reporter === login)) {
      reports.unshift({ reporter: login, ts: Date.now(), reason });
      await writeArr(kv, reportsKey(postId), reports);
    }
    // 写入审核后台列表（结构化的举报工单）
    try {
      const list = await readArr(kv, reportsListKey);
      const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      list.unshift({
        id,
        postId,
        reporter: login,
        postLogin: post.login || '',
        title: post.title || '（无标题）',
        ts: Date.now(),
        reason,
        status: 'open',
      });
      if (list.length > 500) list.length = 500;
      await kv.put(reportsListKey, JSON.stringify(list));
    } catch (e) { /* 不影响举报结果 */ }
    try {
      await pushMessage(kv, OWNER, {
        from: login,
        title: '帖子被举报',
        body: '帖子《' + (post.title || '（无标题）') + '》被 @' + login + ' 举报。' + (reason ? ' 理由：' + reason : ''),
        ts: Date.now(),
        postId,
      });
    } catch (e) { /* 通知失败不影响举报结果 */ }
  } else if (action === 'like' || action === 'unlike') {
    const likes = await readArr(kv, likesKey(postId));
    const li = likes.indexOf(login);
    if (action === 'like') { if (li === -1) likes.push(login); }
    else { if (li !== -1) likes.splice(li, 1); }
    await writeArr(kv, likesKey(postId), likes);
    await patchCounts(kv, postId, { like: likes.length });
  } else if (action === 'fav' || action === 'unfav') {
    const favs = await readArr(kv, favKey(login));
    const fi = favs.indexOf(postId);
    const willFav = action === 'fav';
    if (willFav) { if (fi === -1) favs.push(postId); }
    else { if (fi !== -1) favs.splice(fi, 1); }
    await writeArr(kv, favKey(login), favs);
    const cur = await readCounts(kv, postId);
    const fc = Math.max(0, cur.fav + (willFav ? 1 : -1));
    await kv.put(favCountKey(postId), String(fc));
    await patchCounts(kv, postId, { fav: fc });
  }

  // 重新计算状态（全部容错读取：任一处坏值只降级为 0，不会让整页归零）
  const counts = await readCounts(kv, postId);
  const followers = await readArr(kv, followersKey(postId));
  const blocks = await readArr(kv, blockKey(login));
  const reports = await readArr(kv, reportsKey(postId));
  const likes = await readArr(kv, likesKey(postId));
  const favs = await readArr(kv, favKey(login));
  return json({
    ok: true,
    followed: followers.includes(login),
    blocked: blocks.includes(postId),
    reported: reports.some((r) => r && r.reporter === login),
    liked: likes.includes(login),
    likeCount: counts.like,
    faved: favs.includes(postId),
    favCount: counts.fav,
  });
}
