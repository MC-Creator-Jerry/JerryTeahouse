// Cloudflare Pages Function: /api/comment/counts
// GET ?posts=id1,id2,id3 -> { counts: { id1: 2, id2: 0 } }   (public)
import { json } from '../../_lib/auth.js';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const raw = url.searchParams.get('posts') || '';
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
  const kv = context.env.TEAHOUSE_KV;
  const counts = {};
  await Promise.all(
    ids.map(async (id) => {
      const r = await kv.get('cmts:' + id);
      let n = 0;
      if (r) { try { const a = JSON.parse(r); if (Array.isArray(a)) n = a.length; } catch (e) {} }
      counts[id] = n;
    })
  );
  return json({ counts });
}
