// 轻量 HTML 净化器（Cloudflare Workers 无 DOM，故用 allowlist 解析器手写）
// 仅允许排版相关标签与受控 style 属性；其余标签/属性（含 on*、script、javascript:）一律丢弃，杜绝 XSS。
// 同时提供 htmlToText() 供违禁词扫描使用（先去标签再扫描）。

const ALLOWED_TAGS = new Set([
  'P', 'DIV', 'BR', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'INS',
  'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'A', 'HR', 'FONT', 'SUB', 'SUP',
  'CODE', 'PRE', 'MARK'
]);

const VOID_TAGS = new Set(['BR', 'HR']);

const ALLOWED_STYLE = {
  color: true, 'background-color': true, background: true,
  'font-family': true, 'font-size': true, 'font-weight': true,
  'font-style': true, 'text-decoration': true, 'text-align': true,
  'line-height': true
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
      for (const [k, v] of attrs) {
        const kl = k.toLowerCase();
        if (kl === 'style') {
          const sv = sanitizeStyle(v);
          if (sv) attrStr += ' style="' + escapeAttr(sv) + '"';
        } else if (kl === 'href' && name === 'A') {
          const lv = v.trim().toLowerCase();
          if (/^(https?:\/\/|mailto:)/.test(lv)) attrStr += ' href="' + escapeAttr(v) + '"';
        }
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
