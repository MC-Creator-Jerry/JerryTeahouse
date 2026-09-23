// 小蓝页 · 帖子的关注 / 屏蔽 / 举报（前端共享模块）
// 用法：<script src="../post-actions.js"></script>
//   window.XLPostActions.getStates([id,...]) -> Promise<{ [id]: {followed,blocked,reported} }>
  //   window.XLPostActions.initBar(container, postId, state, opts)
//       opts: { loggedIn:bool, toast:fn(msg,err), onBlock:fn(postId,blocked), onFollow:fn(postId,followed), authorLogin:str }
//   window.XLPostActions.unblockPost(postId, opts) -> Promise<res>
(function () {
  // 站主账号：其帖子不允许任何人屏蔽（前端不显示屏蔽钮，后端另有硬校验）
  var OWNER = 'MC-Creator-Jerry';

  function apiGet(path) {
    return fetch('/api/' + path)
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; });
  }
  function apiPost(payload) {
    return fetch('/api/post-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.ok ? r.json() : { ok: false }; })
      .catch(function () { return { ok: false }; });
  }

  function getStates(postIds) {
    if (!postIds || !postIds.length) return Promise.resolve({});
    return apiGet('post-actions?posts=' + encodeURIComponent(postIds.join(',')))
      .then(function (d) { return d.states || {}; });
  }

  function mkBtn(label, cls, icon) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pa-btn ' + cls;
    if (icon) {
      var img = document.createElement('img');
      img.className = 'ico';
      img.src = '../../icons/' + icon;
      img.alt = '';
      b.appendChild(img);
    }
    var span = document.createElement('span');
    span.className = 'pa-label';
    span.textContent = label;
    b.appendChild(span);
    return b;
  }

  function currentLogin() {
    return (window.JW_AUTH && window.JW_AUTH.user && window.JW_AUTH.user.login) || null;
  }

  function setLabel(btn, text) {
    var s = btn.querySelector('.pa-label');
    if (s) s.textContent = text; else btn.textContent = text;
  }
  function setIcon(btn, icon) {
    var im = btn.querySelector('img.ico');
    if (im) im.src = '../../icons/' + icon;
  }

  function initBar(container, postId, state, opts) {
    opts = opts || {};
    state = state || {};
    if (!container) return;
    container.innerHTML = '';
    container.className = (container.className || '').replace(/\bpost-actions\b/g, '').trim() + ' post-actions';

    var followBtn = mkBtn(state.followed ? '已关注' : '关注', 'pa-follow' + (state.followed ? ' on' : ''), state.followed ? 'follow-on.svg' : 'plus.svg');
    var favBtn = mkBtn(state.faved ? '已收藏' : '收藏', 'pa-fav' + (state.faved ? ' on' : ''), state.faved ? 'star-on.svg' : 'star.svg');
    var repostBtn = document.createElement('a');
    repostBtn.className = 'pa-btn pa-repost';
    repostBtn.href = '../../post/new/?repost=' + encodeURIComponent(postId);
    repostBtn.setAttribute('aria-label', '转发');
    var rImg = document.createElement('img'); rImg.className = 'ico'; rImg.src = '../../icons/repost.svg'; rImg.alt = '';
    var rSpan = document.createElement('span'); rSpan.className = 'pa-label'; rSpan.textContent = '转发';
    repostBtn.appendChild(rImg); repostBtn.appendChild(rSpan);
    var blockBtn = mkBtn(state.blocked ? '已屏蔽' : '屏蔽', 'pa-block' + (state.blocked ? ' on' : ''), 'ban.svg');
    var reportBtn = mkBtn(state.reported ? '已举报' : '举报', 'pa-report' + (state.reported ? ' on' : ''), 'flag.svg');

    // 自己的帖：关注按钮禁用（不能自己关注自己）
    var isSelf = opts.authorLogin && currentLogin() && opts.authorLogin === currentLogin();
    if (isSelf) {
      followBtn.disabled = true;
      followBtn.classList.add('pa-self');
      var lbl = followBtn.querySelector('.pa-label'); if (lbl) lbl.textContent = '自己的帖';
    }

    // 站主的帖：不提供屏蔽入口（后端也会拒绝）
    var isOwnerPost = !!opts.authorLogin && opts.authorLogin === OWNER;

    followBtn.addEventListener('click', function () { doFollow(postId, followBtn, opts); });
    favBtn.addEventListener('click', function () { doFav(postId, favBtn, opts); });
    if (!isOwnerPost) blockBtn.addEventListener('click', function () { doBlock(postId, blockBtn, opts); });
    reportBtn.addEventListener('click', function () { doReport(postId, reportBtn, opts); });

    container.appendChild(followBtn);
    container.appendChild(favBtn);
    container.appendChild(repostBtn);
    if (!isOwnerPost) container.appendChild(blockBtn);
    container.appendChild(reportBtn);
  }

  function requireLogin(opts) {
    if (!opts.loggedIn) {
      if (opts.toast) opts.toast('请先登录', true);
      if (window.JW_LOGIN) window.JW_LOGIN();
      return false;
    }
    return true;
  }

  function doFollow(postId, btn, opts) {
    if (!requireLogin(opts)) return;
    var me = currentLogin();
    if (opts.authorLogin && me && opts.authorLogin === me) {
      if (opts.toast) opts.toast('不能关注自己的帖子', true);
      return;
    }
    var willFollow = !btn.classList.contains('on');
    apiPost({ post: postId, action: willFollow ? 'follow' : 'unfollow' }).then(function (res) {
      if (res && res.ok) {
        btn.classList.toggle('on', !!res.followed);
        setLabel(btn, res.followed ? '已关注' : '关注');
        setIcon(btn, res.followed ? 'follow-on.svg' : 'plus.svg');
        if (opts.onFollow) opts.onFollow(postId, !!res.followed);
        if (opts.toast) opts.toast(res.followed ? '已关注 ✓' : '已取消关注');
      } else if (opts.toast) opts.toast('操作失败', true);
    });
  }

  var activeBlockMenu = null;
  var blockMenuCleanup = null;

  function closeBlockMenu() {
    if (activeBlockMenu && activeBlockMenu.parentNode) activeBlockMenu.parentNode.removeChild(activeBlockMenu);
    activeBlockMenu = null;
    if (blockMenuCleanup) { blockMenuCleanup(); blockMenuCleanup = null; }
  }

  function onBlockMenuOutside(e) {
    if (activeBlockMenu && !activeBlockMenu.contains(e.target)) closeBlockMenu();
  }

  function openBlockMenu(postId, blockBtn, opts) {
    closeBlockMenu();
    var menu = document.createElement('div');
    menu.className = 'pa-block-menu';
    menu.setAttribute('role', 'menu');

    var head = document.createElement('div');
    head.className = 'pa-block-menu-head';
    head.textContent = '选择屏蔽原因';
    menu.appendChild(head);

    var reasons = ['不喜欢ta的内容', '不想看到该作者', '内容重复 / 已看过'];
    reasons.forEach(function (label) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'pa-block-menu-item';
      item.textContent = label;
      item.addEventListener('click', function (e) {
        e.stopPropagation();
        closeBlockMenu();
        execBlock(postId, blockBtn, opts, label);
      });
      menu.appendChild(item);
    });

    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pa-block-menu-item pa-block-cancel';
    cancel.textContent = '取消';
    cancel.addEventListener('click', function (e) { e.stopPropagation(); closeBlockMenu(); });
    menu.appendChild(cancel);

    document.body.appendChild(menu);
    var rect = blockBtn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 6) + 'px';
    if (menu.offsetLeft + menu.offsetWidth > window.innerWidth - 8) {
      menu.style.left = Math.max(8, window.innerWidth - menu.offsetWidth - 8) + 'px';
    }
    activeBlockMenu = menu;
    document.addEventListener('click', onBlockMenuOutside, true);
    window.addEventListener('scroll', closeBlockMenu, true);
    blockMenuCleanup = function () {
      document.removeEventListener('click', onBlockMenuOutside, true);
      window.removeEventListener('scroll', closeBlockMenu, true);
    };
  }

  function execBlock(postId, btn, opts, reason) {
    apiPost({ post: postId, action: 'block', reason: reason }).then(function (res) {
      if (res && res.ok) {
        btn.classList.add('on');
        setLabel(btn, '已屏蔽');
        if (opts.onBlock) opts.onBlock(postId, true);
        if (opts.toast) opts.toast('我们将不再推送该内容');
      } else if (opts.toast) opts.toast('操作失败', true);
    });
  }

  function doBlock(postId, btn, opts) {
    if (!requireLogin(opts)) return;
    // 硬校验：站主的帖子任何人都不能屏蔽
    if (opts.authorLogin && opts.authorLogin === OWNER) {
      if (opts.toast) opts.toast('站主的帖子不能屏蔽', true);
      return;
    }
    if (btn.classList.contains('on')) {
      // 已屏蔽 -> 直接取消
      apiPost({ post: postId, action: 'unblock' }).then(function (res) {
        if (res && res.ok) {
          btn.classList.remove('on');
          setLabel(btn, '屏蔽');
          if (opts.onBlock) opts.onBlock(postId, false);
          if (opts.toast) opts.toast('已取消屏蔽');
        } else if (opts.toast) opts.toast('操作失败', true);
      });
      return;
    }
    if (activeBlockMenu) { closeBlockMenu(); return; }
    openBlockMenu(postId, btn, opts);
  }

  function doReport(postId, btn, opts) {
    if (!requireLogin(opts)) return;
    if (btn.classList.contains('on')) { if (opts.toast) opts.toast('你已经举报过该帖'); return; }
    var reason = '';
    try { reason = window.prompt('举报理由（可选，最多 200 字）：', '') || ''; } catch (e) { reason = ''; }
    apiPost({ post: postId, action: 'report', reason: reason }).then(function (res) {
      if (res && res.ok) {
        btn.classList.add('on');
        setLabel(btn, '已举报');
        if (opts.toast) opts.toast('举报已提交，感谢反馈');
      }       else if (opts.toast) opts.toast('操作失败', true);
    });
  }

  function doFav(postId, btn, opts) {
    if (!requireLogin(opts)) return;
    var willFav = !btn.classList.contains('on');
    apiPost({ post: postId, action: willFav ? 'fav' : 'unfav' }).then(function (res) {
      if (res && res.ok) {
        btn.classList.toggle('on', !!res.faved);
        setLabel(btn, res.faved ? '已收藏' : '收藏');
        setIcon(btn, res.faved ? 'star-on.svg' : 'star.svg');
        if (opts.toast) opts.toast(res.faved ? '已收藏 ★' : '已取消收藏');
      } else if (opts.toast) opts.toast('操作失败', true);
    });
  }

  function unblockPost(postId, opts) {
    opts = opts || {};
    return apiPost({ post: postId, action: 'unblock' }).then(function (res) {
      if (res && res.ok && opts.toast) opts.toast('已取消屏蔽');
      return res;
    });
  }

  window.XLPostActions = {
    getStates: getStates,
    initBar: initBar,
    unblockPost: unblockPost
  };
})();
