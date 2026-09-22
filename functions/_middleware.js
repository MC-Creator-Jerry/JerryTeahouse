// JerryTeahouse · root middleware
// Runs BEFORE static assets for every request to this Pages project.
//
// Purpose: hide build/config files that Cloudflare Pages forces to live in the
// deploy root. wrangler Pages requires wrangler.toml to sit in the directory it
// deploys (that is exactly what keeps us off xiaolan's root config), and Pages
// does not support .assetsignore, so the file would otherwise be downloadable.
// _redirects cannot block an existing asset, but Functions run first - so the
// block happens here.
//
// Contents of these files are non-secret (project name + KV namespace id), this
// is hygiene only. Keep this handler trivial: it runs on every request.

const BLOCKED = new Set(['/wrangler.toml', '/wrangler.json', '/wrangler.jsonc', '/.assetsignore']);

export async function onRequest(context) {
  try {
    const path = new URL(context.request.url).pathname.toLowerCase();
    if (BLOCKED.has(path)) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
      });
    }
  } catch (e) {
    // Never let the guard take the site down.
  }
  return context.next();
}
