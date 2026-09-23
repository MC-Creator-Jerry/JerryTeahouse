// 话题（#hashtag）提取与统计
// 规则：
//   - 以 # 起头，后紧跟 1~30 个非分隔符字符
//   - 支持中文/英文/数字/下划线，支持「#话题#」这种闭合写法（结尾 # 自动截断）
//   - # 前若是字母/数字/下划线/斜杠，视为 URL 锚点或普通文本，不识别为话题
//   - 去重（忽略大小写）、最多取 limit 个
const STOP = /[\s#,.!?;:，。！？；：、)\]【】{}（）「」『』"'“”‘’《》<>|\\/~^$&*+=`]/;
const WORDISH = /[A-Za-z0-9_\/]/;
const TRAILING = /[.,!?;:，。！？；：、]+$/;
const MAX_LEN = 30;

export function normalizeTopic(name) {
  return String(name || '').trim().toLowerCase();
}

export function extractTopics(text, limit = 10) {
  if (!text) return [];
  const s = String(text);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '#') continue;
    const prev = i > 0 ? s[i - 1] : '';
    if (prev && WORDISH.test(prev)) continue; // URL 锚点 / 单词中的 #
    let j = i + 1;
    let name = '';
    while (j < s.length && name.length < MAX_LEN) {
      const ch = s[j];
      if (STOP.test(ch)) break;
      name += ch;
      j++;
    }
    name = name.replace(TRAILING, '');
    if (!name) continue;
    const key = normalizeTopic(name);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(name);
      if (out.length >= limit) break;
    }
    i = j - 1;
  }
  return out;
}

// 从帖子列表统计话题热度：{ name, count } 按 count 降序、同频次按名称升序
export function countTopics(posts, limit = 50) {
  const map = new Map();
  (posts || []).forEach(function (p) {
    const list = Array.isArray(p && p.topics) ? p.topics : [];
    list.forEach(function (t) {
      if (!t) return;
      const key = normalizeTopic(t);
      if (!key) return;
      const cur = map.get(key);
      if (cur) cur.count += 1;
      else map.set(key, { name: t, count: 1 });
    });
  });
  return Array.from(map.values())
    .sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name); })
    .slice(0, limit);
}

// 为单条帖子补齐/重算 topics（用于历史帖与新帖落库）
export function topicsForPost(title, bodyText, limit = 10) {
  return extractTopics(String(title || '') + '\n' + String(bodyText || ''), limit);
}
