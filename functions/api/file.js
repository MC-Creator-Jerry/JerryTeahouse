// Cloudflare Pages Function: /api/file?key=<uuid>
// 公开读取 KV 中的附件（file:<uuid>），按 Content-Type 返回；
// 支持 HTTP Range（206），保证视频可拖动进度。无需登录（帖子附件即公开）。
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const key = url.searchParams.get('key');
  if (!key || !/^[A-Za-z0-9-]+$/.test(key)) {
    return new Response('bad key', { status: 400 });
  }

  const rangeHeader = context.request.headers.get('range') || '';
  let range = undefined;
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (m) {
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? parseInt(m[2], 10) : undefined;
    range = { offset: start };
    if (end !== undefined) range.length = end - start + 1;
  }

  let obj;
  try {
    obj = await context.env.TEAHOUSE_KV.get('file:' + key, { type: 'arrayBuffer', range });
  } catch (e) {
    return new Response('error', { status: 500 });
  }
  if (!obj || obj.value === null) {
    return new Response('not found', { status: 404 });
  }

  const meta = obj.metadata || {};
  const headers = new Headers();
  headers.set('Content-Type', meta.type || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Accept-Ranges', 'bytes');
  if (meta.name) {
    headers.set('Content-Disposition', 'inline; filename="' + encodeURIComponent(String(meta.name)) + '"');
  }

  // 计算内容长度
  let len = 0;
  if (obj.value && obj.value.byteLength !== undefined) len = obj.value.byteLength;
  else if (typeof obj.value === 'string') len = obj.value.length;

  if (range && obj.range) {
    // 带范围请求 -> 206
    headers.set('Content-Range', obj.range);
    headers.set('Content-Length', String(len));
    return new Response(obj.value, { status: 206, headers });
  }
  headers.set('Content-Length', String(len));
  return new Response(obj.value, { status: 200, headers });
}
