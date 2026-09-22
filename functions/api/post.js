// Cloudflare Pages Function: /api/post
// 一期只读：列表 / 单篇。写操作待接入小蓝页 SSO 后开放。
// KV（绑定名 TEAHOUSE_KV，尚未创建时优雅降级为空）：
//   posts:index      -> JSON 数组 [{id,title,excerpt,author,tags,likes,comments,ts}]
//   post:<id>        -> JSON {id,title,excerpt,body,author,tags,likes,comments,ts}

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
  const id = url.searchParams.get('id');

  // 单篇
  if (id) {
    if (!kv) return json({ error: 'not_ready' }, 503);
    const raw = await kv.get('post:' + id);
    if (!raw) return json({ error: 'not_found' }, 404);
    let post = null;
    try { post = JSON.parse(raw); } catch (e) { post = null; }
    if (!post) return json({ error: 'bad_data' }, 500);
    return json({ post: post });
  }

  // 列表
  if (!kv) return json({ posts: [] });
  const raw = await kv.get('posts:index');
  let posts = [];
  if (raw) { try { posts = JSON.parse(raw) || []; } catch (e) { posts = []; } }
  const sort = url.searchParams.get('sort') || 'all';
  posts = posts.slice();
  if (sort === 'hot') posts.sort(function (a, b) { return (b.likes || 0) - (a.likes || 0); });
  else posts.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  return json({ posts: posts });
}
