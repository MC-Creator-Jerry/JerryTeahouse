// /api/poll
// GET  ?post=<id>       -> { login, voted:<idx|null>, question, options:[{text,count}], total, closed }
// GET  ?posts=id1,id2   -> { polls:{ [id]:{question,options,total,closed} } }  (no per-user voted)
// POST { post, action, question?, options?, option? }
//      action:
//        create -> author/admin only; {question, options:[2..10 strings]}
//        vote   -> logged in; {option:<idx>} single choice (replaces prior vote)
//        close  -> author/admin only; freeze results
//        delete -> author/admin only; remove poll
// Storage: poll:<postId> = { question, options:[str], votes:{ "<idx>":[login,...] }, closed, ts, login }
import { getLogin, isAdminLogin, json, OWNER } from '../_lib/auth.js';
import { scanTexts } from '../_lib/forbidden.js';
import { rateLimit } from '../_lib/rate.js';

const pollKey = (id) => 'poll:' + id;

async function readList(kv) {
  const raw = await kv.get('posts:list');
  let list = raw ? JSON.parse(raw) : [];
  return Array.isArray(list) ? list : [];
}
async function postAuthor(kv, postId) {
  const list = await readList(kv);
  const p = list.find((x) => x.id === postId);
  return p ? p.login : null;
}
async function readPoll(kv, id) {
  const raw = await kv.get(pollKey(id));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return p && Array.isArray(p.options) && p.options.length ? p : null;
  } catch (e) { return null; }
}
function tally(poll) {
  let total = 0;
  const options = (poll.options || []).map(function (text, i) {
    const voters = (poll.votes && poll.votes[String(i)]) || [];
    total += voters.length;
    return { text: text, count: voters.length };
  });
  return { question: poll.question, options: options, total: total, closed: !!poll.closed };
}
function votedIndex(poll, login) {
  if (!login || !poll.votes) return null;
  for (const k in poll.votes) {
    if (poll.votes[k].includes(login)) return Number(k);
  }
  return null;
}

export async function onRequestGet(context) {
  const kv = context.env.TEAHOUSE_KV;
  const url = new URL(context.request.url);
  const postId = url.searchParams.get('post');
  const multi = url.searchParams.get('posts');
  const login = await getLogin(context);

  if (multi) {
    const ids = multi.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
    const polls = {};
    for (const id of ids) {
      const p = await readPoll(kv, id);
      if (p) polls[id] = tally(p);
    }
    return json({ polls });
  }

  if (!postId) return json({ error: 'missing_post' }, 400);
  const p = await readPoll(kv, postId);
  if (!p) return json({ error: 'not_found' }, 404);
  const out = tally(p);
  out.voted = votedIndex(p, login);
  return json({ login: login || null, ...out });
}

export async function onRequestPost(context) {
  const login = await getLogin(context);
  if (!login) return json({ error: 'unauthorized' }, 401);
  const rl = await rateLimit(context.env.TEAHOUSE_KV, 'poll', login, { limit: 30, windowSec: 60 });
  if (!rl.ok) return json({ error: 'rate_limited', retryAfter: rl.retryAfter }, 429);

  const kv = context.env.TEAHOUSE_KV;
  const body = await context.request.json().catch(() => ({}));
  const postId = String(body.post || '');
  const action = String(body.action || '');
  if (!postId) return json({ error: 'missing_post' }, 400);

  const author = await postAuthor(kv, postId);
  if (author == null) return json({ error: 'post_not_found' }, 404);

  if (action === 'vote') {
    const option = Number(body.option);
    const poll = await readPoll(kv, postId);
    if (!poll) return json({ error: 'no_poll' }, 404);
    if (poll.closed) return json({ error: 'closed' }, 400);
    if (!Number.isInteger(option) || option < 0 || option >= poll.options.length) return json({ error: 'bad_option' }, 400);
    poll.votes = poll.votes || {};
    for (const k in poll.votes) {
      const arr = poll.votes[k];
      const i = arr.indexOf(login);
      if (i !== -1) arr.splice(i, 1);
    }
    if (!poll.votes[String(option)]) poll.votes[String(option)] = [];
    poll.votes[String(option)].push(login);
    await kv.put(pollKey(postId), JSON.stringify(poll));
    const out = tally(poll);
    out.voted = option;
    return json({ ok: true, ...out });
  }

  // 以下操作需作者或管理员
  const isOwner = login === author || (await isAdminLogin(context, login));
  if (!isOwner) return json({ error: 'forbidden' }, 403);

  if (action === 'create') {
    const existing = await readPoll(kv, postId);
    if (existing) return json({ error: 'exists' }, 400);
    const question = String(body.question || '').slice(0, 200).trim();
    let options = Array.isArray(body.options)
      ? body.options.map((o) => String(o || '').slice(0, 80).trim()).filter(Boolean)
      : [];
    options = options.slice(0, 10);
    if (!question) return json({ error: 'empty_question' }, 400);
    if (options.length < 2) return json({ error: 'need_options' }, 400);
    const bad = scanTexts([question].concat(options));
    if (bad) return json({ error: 'forbidden', word: bad }, 400);
    const poll = { question, options, votes: {}, closed: false, ts: Date.now(), login: author };
    await kv.put(pollKey(postId), JSON.stringify(poll));
    const out = tally(poll);
    out.voted = null;
    return json({ ok: true, ...out });
  }
  if (action === 'close') {
    const poll = await readPoll(kv, postId);
    if (!poll) return json({ error: 'no_poll' }, 404);
    poll.closed = true;
    await kv.put(pollKey(postId), JSON.stringify(poll));
    return json({ ok: true, ...tally(poll) });
  }
  if (action === 'delete') {
    await kv.delete(pollKey(postId));
    return json({ ok: true });
  }
  return json({ error: 'bad_action' }, 400);
}
