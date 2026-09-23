/* ============ 帖子附件渲染（视频/音频/图片/其他），video-only 自动预览 ============ */
window.XLMedia = (function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function humanSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function url(key) { return '/api/file?key=' + encodeURIComponent(key); }

  function isVideoOnly(files, hasText) {
    return !!(files && files.length === 1 && /^video\//.test(files[0].type || '') && !hasText);
  }

  function build(files, opts) {
    opts = opts || {};
    if (!files || !files.length) return '';
    if (opts.videoOnly) {
      var f = files[0];
      return '<div class="att att-video-only">' +
        '<video class="att-video-auto" src="' + url(f.key) + '" autoplay muted loop playsinline controls preload="metadata"></video>' +
        '</div>';
    }
    var tiles = files.map(function (f) {
      var u = url(f.key);
      var t = f.type || '';
      if (/^image\//.test(t)) {
        return '<a class="att-tile att-img" href="' + u + '" target="_blank" rel="noopener">' +
          '<img src="' + u + '" alt="' + esc(f.name) + '" loading="lazy"></a>';
      }
      if (/^video\//.test(t)) {
        return '<video class="att-tile att-video" src="' + u + '" controls playsinline preload="metadata"></video>';
      }
      if (/^audio\//.test(t)) {
        return '<div class="att-tile att-audio"><audio controls src="' + u + '"></audio></div>';
      }
      var ext = (String(f.name).split('.').pop() || 'FILE').toUpperCase().slice(0, 5);
      return '<a class="att-tile att-file" href="' + u + '" download="' + esc(f.name) + '">' +
        '<span class="att-ext">' + esc(ext) + '</span>' +
        '<span class="att-meta"><span class="att-name">' + esc(f.name) + '</span>' +
        '<span class="att-size">' + humanSize(f.size) + '</span></span></a>';
    }).join('');
    return '<div class="att att-grid count-' + Math.min(files.length, 4) + '">' + tiles + '</div>';
  }

  return { url: url, isVideoOnly: isVideoOnly, build: build };
})();

/* ============ 话题（#hashtag）：把正文里的 #话题 渲染成可点击标签 ============ */
window.XLTopics = (function () {
  var STOP = /[\s#,.!?;:，。！？；：、)\]【】{}（）「」『』"'“”‘’《》<>|\\/~^$&*+=`]/;
  var WORDISH = /[A-Za-z0-9_\/]/;
  var TRAILING = /[.,!?;:，。！？；：、]+$/;
  var MAX_LEN = 30;

  function basePrefix() { return '/'; }

  function extract(text, limit) {
    limit = limit || 10;
    var s = String(text || '');
    var out = [], seen = {};
    for (var i = 0; i < s.length; i++) {
      if (s[i] !== '#') continue;
      var prev = i > 0 ? s[i - 1] : '';
      if (prev && WORDISH.test(prev)) continue; // URL 锚点等
      var j = i + 1, name = '';
      while (j < s.length && name.length < MAX_LEN) {
        if (STOP.test(s[j])) break;
        name += s[j]; j++;
      }
      name = name.replace(TRAILING, '');
      if (!name) continue;
      var key = name.toLowerCase();
      if (!seen[key]) {
        seen[key] = 1;
        out.push(name);
        if (out.length >= limit) break;
      }
      i = j - 1;
    }
    return out;
  }

  function topicHref(name) {
    return basePrefix() + 'posts/?topic=' + encodeURIComponent(name);
  }

  function makeLink(name) {
    var a = document.createElement('a');
    a.className = 'topic-link';
    a.href = topicHref(name);
    a.textContent = '#' + name;
    return a;
  }

  function replaceInTextNode(node) {
    var s = node.nodeValue || '';
    var frag = document.createDocumentFragment();
    var last = 0, changed = false;
    for (var i = 0; i < s.length; i++) {
      if (s[i] !== '#') continue;
      var prev = i > 0 ? s[i - 1] : '';
      if (prev && WORDISH.test(prev)) continue;
      var j = i + 1, name = '';
      while (j < s.length && name.length < MAX_LEN) {
        if (STOP.test(s[j])) break;
        name += s[j]; j++;
      }
      name = name.replace(TRAILING, '');
      if (!name) continue;
      if (last < i) frag.appendChild(document.createTextNode(s.slice(last, i)));
      frag.appendChild(makeLink(name));
      last = j; changed = true;
      i = j - 1;
    }
    if (!changed) return;
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }

  // 遍历文本节点做替换（用 DOM API 构造，天然防 XSS）
  function linkify(root) {
    if (!root || !document.createTreeWalker) return;
    var targets = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
      var node = walker.currentNode;
      if (node.nodeValue.indexOf('#') === -1) continue;
      var p = node.parentElement;
      if (!p) continue;
      if (p.className && String(p.className).indexOf('topic-link') !== -1) continue;
      if (p.closest && p.closest('a, code, pre, script, style, textarea')) continue;
      targets.push(node);
    }
    targets.forEach(replaceInTextNode);
  }

  return { extract: extract, linkify: linkify, href: topicHref };
})();

/* ============================================================
   茶馆适配层：补上小蓝页模板依赖的全局符号
   （模板页面从 post/center · post/detail · post/new 原样搬来，
     这里把 auth/prefs/common 提供的能力映射到茶馆的 SSO 登录态）
   ============================================================ */
(function () {
  'use strict';

  function toast(msg, isErr) {
    if (window.TeaAuth && typeof window.TeaAuth.notify === 'function') {
      try { window.TeaAuth.notify(msg); return; } catch (e) { /* 退回自绘 */ }
    }
    try {
      var d = document.createElement('div');
      d.textContent = String(msg == null ? '' : msg);
      d.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;' +
        'padding:10px 18px;border-radius:999px;font-size:14px;max-width:82vw;text-align:center;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.18);backdrop-filter:blur(6px);' +
        (isErr ? 'background:#b4503f;color:#fff;' : 'background:#3a2f26;color:#f7f2ea;');
      document.body.appendChild(d);
      setTimeout(function () { d.remove(); }, 2400);
    } catch (e) { /* 忽略 */ }
  }

  function login() {
    if (window.TeaAuth && typeof window.TeaAuth.login === 'function') window.TeaAuth.login();
    else location.href = '/api/sso/start?next=' + encodeURIComponent(location.pathname + location.search);
  }
  function logout() {
    if (window.TeaAuth && typeof window.TeaAuth.logout === 'function') window.TeaAuth.logout();
    else location.href = '/api/logout';
  }

  window.xlToast = window.xlToast || toast;
  window.JW_LOGIN = window.JW_LOGIN || login;
  window.JW_LOGOUT = window.JW_LOGOUT || logout;
  window.JW_AUTH = window.JW_AUTH || {
    login: login,
    logout: logout,
    loginWithGitHub: login,   // 茶模板沿用旧名：一律走小蓝页 SSO
    isLoggedIn: function () { return !!(window.TeaAuth && window.TeaAuth.isLoggedIn && window.TeaAuth.isLoggedIn()); }
  };
  window.onAuthState = window.onAuthState || function (cb) {
    if (window.TeaAuth && window.TeaAuth.onChange) window.TeaAuth.onChange(cb);
    else document.addEventListener('tea-auth-ready', function (e) { cb(e.detail || null); });
  };
  window.applyAll = window.applyAll || function () { /* 茶馆不做 i18n 全站替换 */ };
  window.__xlNavStart = window.__xlNavStart || function () { /* 茶馆无过场动画 */ };
  window.saveUserPrefs = window.saveUserPrefs || function () { /* 茶馆偏好由设置页自己存 */ };
})();
