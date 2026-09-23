// 轻量 HTML 净化器（Cloudflare Workers 无 DOM，故用 allowlist 解析器手写）
// 仅允许排版相关标签与受控 style 属性；其余标签/属性（含 on*、script、javascript:）一律丢弃，杜绝 XSS。
// 同时提供 htmlToText() 供违禁词扫描使用（先去标签再扫描）。
//
// 2026-09-23 扩展：发帖（仿 M365 块编辑器）需要正文内联媒体与附件，
// 因此放行 IMG / VIDEO / AUDIO / SOURCE / FIGURE / FIGCAPTION，
// 但 src 仍严格限制为「https / 站内 / 图片 data:」三类，video 不给 autoplay。

const ALLOWED_TAGS = new Set([
  'P', 'DIV', 'BR', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'INS',
  'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'A', 'HR', 'FONT', 'SUB', 'SUP',
  'CODE', 'PRE', 'MARK',
  // 媒体块（仿 M365 编辑器插入的 图片 / 视频 / 音频）
  'IMG', 'VIDEO', 'AUDIO', 'SOURCE', 'FIGURE', 'FIGCAPTION'
]);

const VOID_TAGS = new Set(['BR', 'HR', 'IMG', 'SOURCE']);

// 类名白名单：只放行本站在用的一套前缀，避免 style 注入 / 撞车
const CLASS_RE = /^(?:m365-|att-|topic-|xl-)[a-z0-9_\- ]{1,60}$/i;

const ALLOWED_STYLE = {
  color: true, 'background-color': true, background: true,
  'font-family': true, 'font-size': true, 'font-weight': true,
  'font-style': true, 'text-decoration': true, 'text-align': true,
  'line-height': true,
  // 块尺寸（媒体块拖拽缩放用）
  width: true, height: true, 'max-width': true
};

function escapeText(t) {
  return String(t).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(t) {
  return String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeColor(v) {
  v = v.trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{8})$/i.test(v)) return v;
  if (/^rgba?\(/i.test(v)) {
    if (/^rgba?\(\s*-?\d+(\.\d+)?%?\s*,\s*-?\d+(\.\d+)?%?\s*,\s*-?\d+(\.\d+)?%?\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/i.test(v)) return v;
    return null;
  }
  if (/^(transparent|red|blue|green|black|white|gray|grey|yellow|orange|purple|pink|brown|teal|navy|maroon|olive|lime|cyan|magenta|silver|gold|darkred|darkblue|lightblue|lightgray|lightgrey|darkgray|darkgrey)$/i.test(v)) return v;
  return null;
}
function safeFontFamily(v) {
  const parts = v.split(',').map((s) => s.trim());
  for (const p of parts) {
    if (!p) return null;
    if (/^".*"$/.test(p) || /^'.*'$/.test(p)) continue;
    if (!/^[a-z][a-z0-9 ]*$/i.test(p)) return null;
  }
  return v;
}
function safeFontWeight(v) {
  v = v.trim().toLowerCase();
  if (/^(normal|bold|bolder|lighter|[1-9]00)$/.test(v)) return v;
  return null;
}
function safeFontSize(v) {
  v = v.trim().toLowerCase();
  if (/^(\d+(\.\d+)?)(px|em|rem|%)$/.test(v)) return v;
  return null;
}
function safeTextAlign(v) {
  v = v.trim().toLowerCase();
  return /^(left|center|right|justify)$/.test(v) ? v : null;
}
function safeLineHeight(v) {
  v = v.trim().toLowerCase();
  if (/^(\d+(\.\d+)?)(px)?$/.test(v)) return v;
  if (v === 'normal') return v;
  return null;
}
function safeTextDeco(v) {
  v = v.trim().toLowerCase();
  return /^(none|underline|line-through|overline)$/.test(v) ? v : null;
}
function safeFontStyle(v) {
  v = v.trim().toLowerCase();
  return /^(normal|italic|oblique)$/.test(v) ? v : null;
}

// 尺寸：只放行 px / % / auto，且做上限保护（防止超巨块撑爆页面）
function safeSize(v) {
  v = String(v).trim().toLowerCase();
  if (v === 'auto') return 'auto';
  const m = /^(\d+(?:\.\d+)?)(px|%)$/.exec(v);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!isFinite(num) || num < 0) return null;
  if (m[2] === 'px' && num > 2400) return null;
  if (m[2] === '%' && num > 100) return null;
  return m[1] + m[2];
}

// 媒体 / 附件地址：站内相对路径、https、data:image，其余（javascript: 等）一律拒绝
function safeMediaUrl(v) {
  const s = String(v || '').trim();
  if (!s || s.length > 1200) return null;
  if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=]+$/i.test(s)) return s;
  if (/^https:\/\//i.test(s)) return s;
  if (s[0] === '/' && s[1] !== '/' && s[1] !== '\\') return s;
  return null;
}

// 站内链接地址（比媒体宽松一点：允许 #锚点 与 mailto:）
function safeLinkUrl(v) {
  const s = String(v || '').trim();
  if (!s || s.length > 1200) return null;
  if (/^javascript:/i.test(s) || /^data:/i.test(s)) return null;
  if (/^(https?:\/\/|mailto:)/i.test(s)) return s;
  if (s[0] === '#' || (s[0] === '/' && s[1] !== '/' && s[1] !== '\\')) return s;
  return null;
}

function sanitizeStyle(input) {
  const decls = String(input).split(';');
  const out = [];
  for (let d of decls) {
    d = d.trim();
    if (!d) continue;
    const idx = d.indexOf(':');
    if (idx === -1) continue;
    const prop = d.slice(0, idx).trim().toLowerCase();
    const val = d.slice(idx + 1).trim();
    if (!ALLOWED_STYLE[prop]) continue;
    let ok = null;
    if (prop === 'color' || prop === 'background-color' || prop === 'background') ok = safeColor(val);
    else if (prop === 'font-family') ok = safeFontFamily(val);
    else if (prop === 'font-size') ok = safeFontSize(val);
    else if (prop === 'font-weight') ok = safeFontWeight(val);
    else if (prop === 'font-style') ok = safeFontStyle(val);
    else if (prop === 'text-decoration') ok = safeTextDeco(val);
    else if (prop === 'text-align') ok = safeTextAlign(val);
    else if (prop === 'line-height') ok = safeLineHeight(val);
    else if (prop === 'width' || prop === 'height' || prop === 'max-width') ok = safeSize(val);
    if (ok !== null) out.push(prop + ':' + ok);
  }
  return out.join('; ');
}

function parseAttrs(s) {
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    let name = '';
    while (i < n && /[a-zA-Z0-9_-]/.test(s[i])) { name += s[i]; i++; }
    if (!name) { i++; continue; }
    while (i < n && /\s/.test(s[i])) i++;
    if (s[i] === '=') {
      i++;
      while (i < n && /\s/.test(s[i])) i++;
      let val = '';
      if (s[i] === '"' || s[i] === "'") {
        const q = s[i]; i++;
        while (i < n && s[i] !== q) { val += s[i]; i++; }
        i++;
      } else {
        while (i < n && !/\s|>/.test(s[i])) { val += s[i]; i++; }
      }
      out.push([name, val]);
    } else {
      out.push([name, '']);
    }
  }
  return out;
}

// 把 FONT 标签的 face/color/size 转成 style（兼容旧浏览器 execCommand 输出）
function fontTagStyle(attrs) {
  const style = [];
  for (const [k, v] of attrs) {
    const kl = k.toLowerCase();
    if (kl === 'face') { const f = safeFontFamily(v); if (f) style.push('font-family:' + f); }
    else if (kl === 'color') { const c = safeColor(v); if (c) style.push('color:' + c); }
    else if (kl === 'size') { const n = parseInt(v, 10); if (!isNaN(n)) { const px = [10, 13, 16, 18, 24, 32, 40][Math.min(6, Math.max(0, n - 1))] || 16; style.push('font-size:' + px + 'px'); } }
  }
  return style.join('; ');
}

export function sanitizeHtml(html) {
  if (!html) return '';
  let out = '';
  let i = 0;
  const n = html.length;
  const stack = [];
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { out += escapeText(html.slice(i)); break; }
    out += escapeText(html.slice(i, lt));
    // 注释 / 声明：丢弃
    if (html[lt + 1] === '!') {
      const end = html.indexOf('>', lt);
      if (end === -1) { i = n; break; }
      i = end + 1;
      continue;
    }
    // 闭合标签
    if (html[lt + 1] === '/') {
      const end = html.indexOf('>', lt);
      if (end === -1) { i = n; break; }
      const name = html.slice(lt + 2, end).trim().toUpperCase();
      let found = -1;
      for (let s = stack.length - 1; s >= 0; s--) { if (stack[s] === name) { found = s; break; } }
      if (found !== -1) {
        for (let s = stack.length - 1; s > found; s--) out += '</' + stack[s].toLowerCase() + '>';
        out += '</' + name.toLowerCase() + '>';
        stack.length = found;
      }
      i = end + 1;
      continue;
    }
    // 开标签
    const end = html.indexOf('>', lt);
    if (end === -1) { out += escapeText(html.slice(lt)); i = n; break; }
    const tagContent = html.slice(lt + 1, end);
    const m = tagContent.match(/^([a-zA-Z0-9]+)/);
    if (!m) { out += escapeText(html.slice(lt, end + 1)); i = end + 1; continue; }
    const name = m[1].toUpperCase();
    if (!ALLOWED_TAGS.has(name)) { i = end + 1; continue; }
    const attrs = parseAttrs(tagContent.slice(m[1].length));
    let attrStr = '';
    if (name === 'FONT') {
      const st = fontTagStyle(attrs);
      if (st) attrStr += ' style="' + escapeAttr(st) + '"';
    } else {
      const seen = new Set();
      for (const [k, v] of attrs) {
        const kl = k.toLowerCase();
        if (seen.has(kl)) continue;
        let piece = null;
        if (kl === 'style') {
          const sv = sanitizeStyle(v);
          if (sv) piece = 'style="' + escapeAttr(sv) + '"';
        } else if (kl === 'class') {
          const cv = v.trim();
          if (CLASS_RE.test(cv)) piece = 'class="' + escapeAttr(cv) + '"';
        } else if (kl === 'href' && name === 'A') {
          const lv = safeLinkUrl(v);
          if (lv) piece = 'href="' + escapeAttr(lv) + '"';
        } else if (kl === 'src' && (name === 'IMG' || name === 'VIDEO' || name === 'AUDIO' || name === 'SOURCE')) {
          const sv = safeMediaUrl(v);
          if (sv) piece = 'src="' + escapeAttr(sv) + '"';
        } else if (kl === 'alt' && name === 'IMG') {
          piece = 'alt="' + escapeAttr(String(v).slice(0, 200)) + '"';
        } else if ((kl === 'width' || kl === 'height') && (name === 'IMG' || name === 'VIDEO')) {
          // 属性形式只收裸数字（HTML 规范里 width="300" 就等于 300px）
          const raw = String(v).trim();
          const sv = /^\d{1,4}$/.test(raw) ? raw : safeSize(raw);
          if (sv && sv !== 'auto') piece = kl + '="' + escapeAttr(sv) + '"';
        } else if (kl === 'type' && name === 'SOURCE') {
          const sv = String(v).trim().slice(0, 100);
          if (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(sv)) piece = 'type="' + escapeAttr(sv) + '"';
        } else if (kl === 'poster' && name === 'VIDEO') {
          const sv = safeMediaUrl(v);
          if (sv) piece = 'poster="' + escapeAttr(sv) + '"';
        } else if (kl === 'controls' && (name === 'VIDEO' || name === 'AUDIO')) {
          piece = 'controls';
        } else if (kl === 'playsinline' && name === 'VIDEO') {
          piece = 'playsinline';
        } else if (kl === 'loop' && (name === 'VIDEO' || name === 'AUDIO')) {
          piece = 'loop';
        } else if (kl === 'muted' && (name === 'VIDEO' || name === 'AUDIO')) {
          piece = 'muted';
        } else if (kl === 'preload' && (name === 'VIDEO' || name === 'AUDIO')) {
          if (/^(none|metadata|auto)$/i.test(String(v).trim())) piece = 'preload="' + escapeAttr(String(v).trim().toLowerCase()) + '"';
        } else if (kl === 'download' && name === 'A') {
          if (v) piece = 'download="' + escapeAttr(String(v).slice(0, 200)) + '"';
          else piece = 'download';
        } else if (kl === 'title' && name === 'A') {
          piece = 'title="' + escapeAttr(String(v).slice(0, 200)) + '"';
        } else if (kl === 'target' && name === 'A') {
          if (String(v).trim() === '_blank') piece = 'target="_blank"';
        } else if (kl === 'rel' && name === 'A') {
          if (/^noopener( noreferrer)?$/i.test(String(v).trim())) piece = 'rel="' + escapeAttr(String(v).trim().toLowerCase()) + '"';
        } else if (kl === 'colspan' || kl === 'rowspan') {
          // 预留：表格未开放，忽略
          continue;
        } else {
          continue;
        }
        if (piece) { attrStr += ' ' + piece; seen.add(kl); }
      }
    }
    out += '<' + name.toLowerCase() + attrStr + '>';
    if (!VOID_TAGS.has(name)) stack.push(name);
    i = end + 1;
  }
  while (stack.length) out += '</' + stack.pop().toLowerCase() + '>';
  return out;
}

export function htmlToText(html) {
  if (!html) return '';
  return String(html).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
