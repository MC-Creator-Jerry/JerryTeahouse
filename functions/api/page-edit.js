// Cloudflare Pages Function: /api/page-edit
// 站点内容覆盖（站主在「更改当前页面布局」模式下保存的修改）
//   · legacy：对现有元素的文字 / 图片覆盖（按 CSS 选择器定位）
//   · blocks：站主新建的内容块（文本框 / 图片 / 视频 / 文件附件），对所有访客渲染
//     —— 每个块可带 w / h（px，0 = 自动），由编辑器拖拽手柄写入
//   —— 所有读写都按 id 去重，防止重复块被反复落库 / 渲染
//
// GET  ?path=<normalized>  -> { edits: {...}, blocks: [...] }                 （公开）
// POST { path, edits, blocks } -> { ok, count, path }                        （仅站主可写）
//
// 存储：pageedit:<path> = { edits, blocks, ts }
import { json, getLogin, isAdminLogin } from '../_lib/auth.js';
import { rateLimit } from '../_lib/rate.js';
import { sanitizeHtml } from '../_lib/sanitize.js';

const PFX = 'pageedit:';
const MAX_KEYS = 300;
const MAX_TEXT = 2000;
const MAX_VAL = 4000;
const MAX_HTML = 20000;
const MAX_BLOCKS = 100;
const IMG_RE = /^(https?:\/\/|data:image\/|\/)/i;
const SEL_RE = /^[A-Za-z0-9_:#.\-\[\]=\(\)\*\s>:~]+$/;
const BLOCK_TYPES = new Set(['textbox', 'image', 'video', 'file']);
// 内容块尺寸（px）：0 表示自动（不限制）
const MAX_SIZE = 4000;
function clampSize(v) {
  const n = Math.round(Number(v));
  if (!isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_SIZE, n);
}
// 按 id 去重（保留第一份）。
// 必要性：早期客户端在 exitEdit 时重复 append 内容块，且保存时从 DOM 全量收集，
// 导致同一批块被反复写回 KV（每次保存翻倍）。这里做读取侧兜底，
// 让已经污染的旧数据立刻恢复正常显示，无需站主手工重存。
function dedupeBlocks(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const b of arr) {
    if (!b || typeof b !== 'object') continue;
    const id = typeof b.id === 'string' ? b.id : '';
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(b);
  }
  return out;
}

function normPath(p) {
  if (!p) return '/';
  try { p = decodeURIComponent(p); } catch (e) {}
  p = p.replace(/[?#].*$/, '');           // 去掉查询/哈希
  p = p.replace(/\\/g, '/');
  p = p.replace(/\.\.+/g, '');            // 去掉路径穿越
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 200) p = p.slice(0, 200);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

function genId() {
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 仅放行内容块整体 style 上的安全属性 + 安全取值，杜绝注入
function safeBoxStyle(css) {
  if (typeof css !== 'string') return '';
  const parts = css.split(';').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const m = p.match(/^([\w\-]+)\s*:\s*(.+)$/);
    if (!m) continue;
    const prop = m[1].toLowerCase();
    const val = m[2].trim();
    if (prop === 'color' || prop === 'background-color') {
      if (!/^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|transparent)$/i.test(val)) continue;
    } else if (prop === 'font-family') {
      if (!/^[\w\- ,'"()]+$/.test(val) || val.length > 120) continue;
    } else if (prop === 'font-size') {
      if (!/^\d+(?:\.\d+)?(px|em|rem|%)$/.test(val)) continue;
    } else if (prop === 'text-align') {
      if (!/^(left|center|right|justify)$/.test(val)) continue;
    } else if (prop === 'font-weight') {
      if (!/^(normal|bold|[1-9]00)$/.test(val)) continue;
    } else if (prop === 'font-style') {
      if (!/^(normal|italic|oblique)$/.test(val)) continue;
    } else if (prop === 'text-decoration') {
      if (!/^(none|underline|line-through|overline)$/.test(val)) continue;
    } else if (prop === 'line-height') {
      if (!/^[\d.]+(px|em|rem|%)?$/.test(val)) continue;
    } else {
      continue;
    }
    out.push(prop + ': ' + val);
  }
  return out.join('; ').slice(0, 500);
}

function validateEdits(edits) {
  if (!edits || typeof edits !== 'object' || Array.isArray(edits)) return { ok: false, error: 'bad_shape' };
  const keys = Object.keys(edits);
  if (keys.length > MAX_KEYS) return { ok: false, error: 'too_many' };
  const out = {};
  for (const sel of keys) {
    if (typeof sel !== 'string' || sel.length > 300 || !SEL_RE.test(sel)) return { ok: false, error: 'bad_selector' };
    const e = edits[sel];
    if (!e || (e.type !== 'text' && e.type !== 'img')) return { ok: false, error: 'bad_type' };
    const v = typeof e.value === 'string' ? e.value : '';
    if (e.type === 'img' && !IMG_RE.test(v)) return { ok: false, error: 'bad_img' };
    out[sel] = { type: e.type, value: v.slice(0, e.type === 'img' ? MAX_VAL : MAX_TEXT) };
  }
  return { ok: true, edits: out };
}

function validateBlocks(blocks) {
  if (!Array.isArray(blocks)) return { ok: false, error: 'bad_blocks' };
  if (blocks.length > MAX_BLOCKS) return { ok: false, error: 'too_many_blocks' };
  const out = [];
  const seen = new Set();
  for (const b of blocks) {
    if (!b || !b.type || !BLOCK_TYPES.has(b.type)) return { ok: false, error: 'bad_block_type' };
    const id = (typeof b.id === 'string' && /^[A-Za-z0-9_\-]{1,40}$/.test(b.id)) ? b.id : genId();
    if (seen.has(id)) continue;   // 同 id 只保留第一份，杜绝重复块再次落库
    seen.add(id);
    const w = clampSize(b.w);
    const h = clampSize(b.h);
    if (b.type === 'textbox') {
      const html = typeof b.html === 'string' ? sanitizeHtml(b.html) : '';
      const style = safeBoxStyle(b.style);
      out.push({ id, type: 'textbox', html: html.slice(0, MAX_HTML), style, w, h });
    } else if (b.type === 'image') {
      let src = typeof b.src === 'string' ? b.src.trim() : '';
      if (!IMG_RE.test(src)) return { ok: false, error: 'bad_img' };
      const alt = typeof b.alt === 'string' ? b.alt.slice(0, 200) : '';
      out.push({ id, type: 'image', src: src.slice(0, MAX_VAL), alt, w, h });
    } else if (b.type === 'video') {
      let url = typeof b.url === 'string' ? b.url.trim() : '';
      if (!/^https?:\/\//i.test(url) && !/^\//.test(url)) return { ok: false, error: 'bad_video' };
      out.push({ id, type: 'video', url: url.slice(0, MAX_VAL), w, h });
    } else if (b.type === 'file') {
      let url = typeof b.url === 'string' ? b.url.trim() : '';
      if (!/^https?:\/\//i.test(url) && !/^\//.test(url)) return { ok: false, error: 'bad_file' };
      const name = typeof b.name === 'string' ? b.name.slice(0, 200) : '';
      out.push({ id, type: 'file', url: url.slice(0, MAX_VAL), name, w, h });
    }
  }
  return { ok: true, blocks: out };
}

async function readAll(kv, path) {
  const raw = await kv.get(PFX + path);
  if (!raw) return { edits: {}, blocks: [] };
  try {
    const o = JSON.parse(raw);
    return {
      edits: (o && o.edits) || {},
      // 读取侧去重：历史上被写坏的重复块在这里就被吃掉
      blocks: dedupeBlocks(o && o.blocks),
    };
  } catch (e) {
    return { edits: {}, blocks: [] };
  }
}

export async function onRequestGet(context) {
  const kv = context.env.TEAHOUSE_KV;
  const url = new URL(context.request.url);
  const path = normPath(url.searchParams.get('path') || (url.pathname.replace(/^\/api\/page-edit/, '') || '/'));
  const { edits, blocks } = await readAll(kv, path);
  return json({ edits, blocks });
}

export async function onRequestPost(context) {
  const kv = context.env.TEAHOUSE_KV;
  const login = await getLogin(context);
  if (!login) return json({ error: 'unauthorized' }, 401);
  const isAdmin = await isAdminLogin(context, login);
  if (!isAdmin) return json({ error: 'forbidden' }, 403);

  const rl = await rateLimit(kv, 'pageedit', login, { limit: 30, windowSec: 60 });
  if (!rl.ok) return json({ error: 'rate_limited', retryAfter: rl.retryAfter }, 429);

  const body = await context.request.json().catch(() => ({}));
  const path = normPath(body.path || '/');
  const validE = validateEdits(body.edits || {});
  if (!validE.ok) return json({ error: validE.error }, 400);
  const validB = validateBlocks(body.blocks || []);
  if (!validB.ok) return json({ error: validB.error }, 400);

  await kv.put(PFX + path, JSON.stringify({ edits: validE.edits, blocks: validB.blocks, ts: Date.now() }));
  return json({ ok: true, count: Object.keys(validE.edits).length + validB.blocks.length, path });
}
