// Cloudflare Pages Function: /api/topics
// GET            -> { topics: [{ name, count }] }  热门话题（按帖子数降序）
// GET ?post=<id> -> { topics: [name,...] }         单条帖子的话题
// 数据现算自 posts:list，不额外占用 KV。
import { json } from '../_lib/auth.js';
import { countTopics, topicsForPost } from '../_lib/topics.js';
import { htmlToText } from '../_lib/sanitize.js';

const KEY = 'posts:list';

async function readList(kv) {
  const raw = await kv.get(KEY);
  const list = raw ? JSON.parse(raw) : [];
  return Array.isArray(list) ? list : [];
}

export async function onRequestGet(context) {
  const kv = context.env.TEAHOUSE_KV;
  const url = new URL(context.request.url);
  const postId = url.searchParams.get('post');

  // 单条帖子的话题
  if (postId) {
    const list = await readList(kv);
    const p = list.find((x) => x && x.id === postId);
    if (!p) return json({ topics: [] });
    const topics = Array.isArray(p.topics) ? p.topics : topicsForPost(p.title, htmlToText(p.body || ''));
    return json({ topics });
  }

  // 全站热门话题：历史帖没有 topics 字段时按同一规则现算
  const list = await readList(kv);
  const normalized = list.map((p) => {
    if (!p) return p;
    if (Array.isArray(p.topics)) return p;
    return { ...p, topics: topicsForPost(p.title, htmlToText(p.body || '')) };
  });
  return json({ topics: countTopics(normalized, 50) });
}
