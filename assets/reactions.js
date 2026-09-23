// 多表情回应挂件：渲染 / 切换（👍❤️😂😮😢🔥）
// 依赖：window.JW_AUTH（登录态）、window.JW_LOGIN（触发登录）
// 渲染：window.XLReactions.render(container, data, opts)
//   data: { post, reactions:{emoji:count}, mine:[emoji] }
//   opts: { compact, onUpdated }
// 批量：window.XLReactions.renderAll(postsEl, map)   map={ [postId]:{reactions,mine} }
(function () {
  var EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function myLogin() {
    try { return (window.JW_AUTH && window.JW_AUTH.user && window.JW_AUTH.user.login) || null; } catch (e) { return null; }
  }

  function build(container, data, opts) {
    var wrap = document.createElement('div');
    wrap.className = 'reacts' + (opts && opts.compact ? ' compact' : '');
    var reactions = data.reactions || {};
    var mine = data.mine || [];
    EMOJIS.forEach(function (e) {
      var count = reactions[e] || 0;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'react-btn' + (mine.indexOf(e) !== -1 ? ' on' : '') + (count ? ' has' : '');
      btn.setAttribute('aria-label', '回应 ' + e);
      btn.innerHTML = '<span class="r-emoji">' + e + '</span>' + (count ? '<span class="r-cnt">' + count + '</span>' : '');
      btn.addEventListener('click', function () { toggle(container, data.post, e, opts); });
      wrap.appendChild(btn);
    });
    container.appendChild(wrap);
    container.hidden = false;
  }

  function render(container, data, opts) {
    if (!container) return;
    container.innerHTML = '';
    build(container, data || {}, opts || {});
  }

  function toggle(container, postId, emoji, opts) {
    if (!myLogin()) { if (window.JW_LOGIN) window.JW_LOGIN(); return; }
    fetch('/api/react', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post: postId, emoji: emoji })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (res.ok) {
          render(container, Object.assign({}, res.body, { post: postId }), opts);
          if (opts && opts.onUpdated) opts.onUpdated();
        } else if (res.body && res.body.error === 'unauthorized') { if (window.JW_LOGIN) window.JW_LOGIN(); }
        else { alert('操作失败，请重试'); }
      })
      .catch(function () { alert('网络错误'); });
  }

  // 批量渲染：map = { [postId]: {reactions, mine} }
  function renderAll(postsEl, map) {
    if (!postsEl || !map) return;
    Object.keys(map).forEach(function (id) {
      var box = postsEl.querySelector('.att-react[id="react-' + id + '"]');
      if (box && window.XLReactions) {
        render(box, Object.assign({}, map[id], { post: id }), { compact: true });
      }
    });
  }

  window.XLReactions = { render: render, renderAll: renderAll, EMOJIS: EMOJIS };
})();
