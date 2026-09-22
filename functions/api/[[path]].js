// JerryTeahouse · catch-all for unknown /api/* routes
// File-based route: functions/api/[[path]].js  ->  matches /api/<anything...>
// Static routes (e.g. functions/api/post.js) are more specific and take
// precedence, so /api/post and /api/comment are unaffected.
//
// Why this exists: without it, an unknown /api/* request falls back to the
// static asset handler and returns index.html (HTML) - the front-end then
// tries res.json() on HTML and fails with a confusing parse error.

export async function onRequest() {
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
