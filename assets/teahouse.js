/* ============================================================
   茶馆 · 共享脚本
   1) 统一登录态：拉 /api/me，渲染所有 [data-tea-auth] 槽位
   2) 门控： [data-tea-gate] 仅未登录显示；[data-tea-only] 仅已登录显示
   3) 主题按钮：若页面有 #themeBtn 且未自带监听，则由本脚本接管
   登录走小蓝页 SSO（/api/sso/start），跨站 Cookie 无法共享，故为独立会话。
   ============================================================ */
(function () {
  'use strict';

  var state = { ready: false, user: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function applyGates() {
    var on = !!state.user;
    document.querySelectorAll('[data-tea-gate]').forEach(function (el) { el.hidden = on; });
    document.querySelectorAll('[data-tea-only]').forEach(function (el) { el.hidden = !on; });
  }

  function render() {
    var on = !!state.user;
    document.querySelectorAll('[data-tea-auth]').forEach(function (el) {
      if (!on) {
        el.innerHTML = '<a href="#" class="tea-auth-link" data-tea-login>登录</a>';
      } else {
        var name = esc(state.user.name || state.user.login || '茶客');
        var t = state.user.login ? ('已通过小蓝页登录：' + esc(state.user.login)) : '已登录';
        el.innerHTML = '<span class="tea-user" title="' + t + '">' +
          '<span class="tea-user-dot" aria-hidden="true"></span>' +
          '<span class="tea-user-name">' + name + '</span>' +
          '<a href="#" class="tea-auth-out" data-tea-logout>退出</a>' +
          '</span>';
      }
    });
    applyGates();
  }

  function notify(msg) {
    var host = document.querySelector('.tea-wrap') || document.body;
    if (!host) return;
    var d = document.createElement('div');
    d.className = 'tea-notice';
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

  // 事件委托：任何位置（含动态渲染）的登录/退出按钮都生效
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('[data-tea-login]');
    if (a) { e.preventDefault(); goLogin(); return; }
    var b = e.target.closest && e.target.closest('[data-tea-logout]');
    if (b) { e.preventDefault(); goLogout(); return; }
  });

  window.TeaAuth = {
    state: state,
    login: goLogin,
    logout: goLogout,
    notify: notify,
    applyGates: applyGates,
    isLoggedIn: function () { return !!state.user; },
    onChange: function (fn) {
      if (state.ready) fn(state.user);
      else document.addEventListener('tea-auth-ready', function () { fn(state.user); });
    }
  };

  var err = readSsoError();
  if (err) notify(err);

  render();

  fetch('/api/me', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      state.user = (d && d.loggedIn && d.user) ? d.user : null;
      state.ready = true;
      render();
      document.dispatchEvent(new CustomEvent('tea-auth-ready', { detail: state.user }));
    })
    .catch(function () { state.ready = true; render(); });
})();
