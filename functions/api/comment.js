// Cloudflare Pages Function: /api/comment
// 一期只读：按帖子取评论。写操作待接入小蓝页 SSO 后开放。
// KV（TEAHOUSE_KV）：comments:<postId> -> JSON [{author, text, ts}]

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

export async function onRequestGet(context) {
  const kv = context.env.TEAHOUSE_KV;
  const url = new URL(context.request.url);
  const postId = url.searchParams.get('post');
  if (!postId) return json({ error: 'missing_post' }, 400);
  if (!kv) return json({ comments: [] });
  const raw = await kv.get('comments:' + postId);
  let comments = [];
  if (raw) { try { comments = JSON.parse(raw) || []; } catch (e) { comments = []; } }
  return json({ comments: comments });
}
