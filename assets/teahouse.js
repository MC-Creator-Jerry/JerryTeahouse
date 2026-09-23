/* ============================================================
   茶馆 · 共享脚本
   1) 统一登录态：拉 /api/me，渲染所有 [data-tea-auth] 槽位
   2) 门控： [data-tea-gate] 仅未登录显示；[data-tea-only] 仅已登录显示
   3) 仿 M365 页面编辑器：全站预载 assets/editbar.js（应用站主已保存的页面改动），
      站主额外得到浮动「更改当前页面布局」按钮（与 小蓝页 行为一致）
   4) 主题按钮：若页面有 #themeBtn 且未自带监听，则由本脚本接管
   登录走小蓝页 SSO（/api/sso/start），跨站 Cookie 无法共享，故为独立会话。
   ============================================================ */
(function () {
  'use strict';

  var state = { ready: false, user: null };
  var OWNER = 'MC-Creator-Jerry';
  var EDITBAR_VER = '20260923a';   // 改 assets/editbar.js 后同步 bump

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function isAdmin() {
    var u = state.user;
    return !!(u && (u.isAdmin || u.login === OWNER));
  }

  function applyGates() {
    var on = !!state.user;
    document.querySelectorAll('[data-tea-gate]').forEach(function (el) { el.hidden = on; });
    document.querySelectorAll('[data-tea-only]').forEach(function (el) { el.hidden = !on; });
    document.querySelectorAll('[data-tea-admin]').forEach(function (el) { el.hidden = !isAdmin(); });
  }

  function avatarHtml(u) {
    var url = u.avatar_url || '';
    var name = esc(u.name || u.login || '茶客');
    var initial = esc(String(u.name || u.login || '茶').slice(0, 1));
    if (/^(https?:\/\/|\/)/.test(url)) {
      return '<img class="tea-user-avatar" src="' + esc(url) + '" alt="' + name + '" />';
    }
    return '<span class="tea-user-avatar" aria-hidden="true">' + initial + '</span>';
  }

  function render() {
    var on = !!state.user;
    document.querySelectorAll('[data-tea-auth]').forEach(function (el) {
      if (!on) {
        el.innerHTML = '<a href="#" class="tea-auth-link" data-tea-login>登录</a>';
        return;
      }
      var u = state.user;
      var name = esc(u.name || u.login || '茶客');
      var t = u.login ? ('已通过小蓝页登录：' + esc(u.login)) : '已登录';
      el.innerHTML = '' +
        '<span class="tea-user-wrap" id="teaUserWrap">' +
          '<button type="button" class="tea-user-btn" data-tea-menu-toggle title="' + t + '">' +
            avatarHtml(u) +
            '<span class="tea-user-name">' + name + '</span>' +
            '<span class="tea-user-caret">▾</span>' +
          '</button>' +
          '<span class="tea-user-menu">' +
            '<a href="/profile/">👤 个人主页</a>' +
            '<a href="/settings/">⚙️ 设置</a>' +
            (isAdmin() ? '<a href="/admin/">🛡️ 管理台<span class="badge-admin">管理员</span></a>' : '') +
            '<span class="sep"></span>' +
            '<a href="#" class="danger" data-tea-logout>↩ 退出登录</a>' +
          '</span>' +
        '</span>';
    });
    applyGates();
    document.dispatchEvent(new CustomEvent('tea-auth-change', { detail: state.user }));
  }

  function notify(msg, kind) {
    var host = document.querySelector('.tea-wrap') || document.body;
    if (!host) return;
    var d = document.createElement('div');
    d.className = 'tea-notice' + (kind ? ' is-' + kind : '');
    d.innerHTML = '<span>' + esc(msg) + '</span><button type="button" aria-label="关闭">×</button>';
    d.querySelector('button').addEventListener('click', function () { d.remove(); });
    host.insertBefore(d, host.firstChild);
  }

  function readSsoError() {
    var q = new URLSearchParams(location.search);
    var v = q.get('sso');
    if (!v || v === 'ok') return null;
    var map = {
      bad_params: '登录回调参数不完整，请重试。',
      bad_state: '登录状态校验失败（可能是页面停留过久），请重新点登录。',
      not_ready: '茶馆后端尚未就绪，请联系站长。',
      not_configured: '单点登录尚未在服务端配置完成。',
      token_failed: '换取登录凭据失败，请重试；若持续失败请检查小蓝页登录状态。'
    };
    return map[v] || '登录未完成，请重试。';
  }

  function goLogin() {
    var next = location.pathname + location.search;
    location.href = '/api/sso/start?next=' + encodeURIComponent(next);
  }

  function goLogout() {
    fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
      .catch(function () {})
      .then(function () {
        state.user = null;
        render();
      });
  }

  /* ---------- 明暗主题（全站统一：页面只放 #themeBtn，逻辑在这里） ---------- */
  function syncThemeIcon() {
    var btn = document.getElementById('themeBtn');
    if (!btn) return;
    btn.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
  }
  function bindTheme() {
    var btn = document.getElementById('themeBtn');
    if (!btn || btn.getAttribute('data-tea-theme-own') === '1' || btn.getAttribute('data-tea-bound') === '1') return;
    btn.setAttribute('data-tea-bound', '1');
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('tea_theme', next); } catch (err) { /* 忽略 */ }
      syncThemeIcon();
    });
    syncThemeIcon();
  }

  /* ---------- 仿 M365 页面编辑器（editbar.js） ---------- */
  function floatHost() {
    var el = document.querySelector('.tea-float');
    if (!el) {
      el = document.createElement('div');
      el.className = 'tea-float';
      document.body.appendChild(el);
    }
    return el;
  }

  function loadEditbar() {
    if (document.querySelector('script[data-tea-editbar]')) return;
    var s = document.createElement('script');
    s.src = '/assets/editbar.js?v=' + EDITBAR_VER;
    s.async = true;
    s.setAttribute('data-tea-editbar', '1');
    s.onload = function () { injectLayoutBtn(); };
    document.head.appendChild(s);
  }

  function injectLayoutBtn() {
    if (!isAdmin()) return;
    var host = floatHost();
    if (host.querySelector('#teaLayoutBtn')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'teaLayoutBtn';
    b.className = 'is-primary';
    b.innerHTML = '✎ 更改当前页面布局';
    b.title = '进入仿 M365 编辑模式：改文字/换图/插入块（文本框·图片·视频·文件）';
    b.addEventListener('click', function () {
      if (window.XLEdit && typeof window.XLEdit.open === 'function') window.XLEdit.open();
      else notify('编辑器还在加载，请稍后重试。', 'warn');
    });
    host.appendChild(b);
  }

  /* ---------- 事件委托 ---------- */
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    var a = t.closest('[data-tea-login]');
    if (a) { e.preventDefault(); goLogin(); return; }

    var b = t.closest('[data-tea-logout]');
    if (b) { e.preventDefault(); goLogout(); return; }

    var toggle = t.closest('[data-tea-menu-toggle]');
    var wrap = document.getElementById('teaUserWrap');
    if (toggle && wrap) {
      e.preventDefault();
      wrap.classList.toggle('open');
      return;
    }
    if (wrap && wrap.classList.contains('open') && !t.closest('#teaUserWrap')) {
      wrap.classList.remove('open');
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var wrap = document.getElementById('teaUserWrap');
      if (wrap) wrap.classList.remove('open');
    }
  });

  window.TeaAuth = {
    state: state,
    user: function () { return state.user; },
    isAdmin: isAdmin,
    isOwner: function () { return !!(state.user && state.user.login === OWNER); },
    login: goLogin,
    logout: goLogout,
    notify: notify,
    applyGates: applyGates,
    refresh: function () { return reload(); },
    isLoggedIn: function () { return !!state.user; },
    onChange: function (fn) {
      if (state.ready) fn(state.user);
      else document.addEventListener('tea-auth-ready', function () { fn(state.user); });
    }
  };

  var err = readSsoError();
  if (err) notify(err);

  render();

  function reload() {
    return fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        // /api/me 同时兼容两套结构：茶馆自有页 (loggedIn/user) 与搬来的模板页 (顶层字段)
        state.user = (d && (d.loggedIn || d.login)) ? (d.user || d) : null;
        state.ready = true;
        render();
        injectLayoutBtn();
        document.dispatchEvent(new CustomEvent('tea-auth-ready', { detail: state.user }));
        return state.user;
      })
      .catch(function () { state.ready = true; render(); return null; });
  }

  // 全站预载编辑器：所有访客都要应用站主已保存的页面改动，不只是站主
  if (document.readyState === 'complete') loadEditbar();
  else window.addEventListener('load', loadEditbar);

  bindTheme();
  reload();
})();
