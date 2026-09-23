// 投票挂件：渲染 / 投票 / 管理 / 创建
// 依赖：window.JW_AUTH（取登录态）、window.JW_LOGIN（触发登录）
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function myLogin() {
    try { return (window.JW_AUTH && window.JW_AUTH.user && window.JW_AUTH.user.login) || null; } catch (e) { return null; }
  }

  // 把投票数据渲染进 container
  // data: { post, question, options:[{text,count}], total, closed, voted:<idx|null> }
  // opts: { canManage, compact, onUpdated, onDeleted }
  function render(container, data, opts) {
    opts = opts || {};
    container.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'poll' + (opts.compact ? ' compact' : '');

    var q = document.createElement('div');
    q.className = 'poll-q';
    q.textContent = data.question;
    wrap.appendChild(q);

    var showResults = data.voted != null || data.closed;
    var total = data.total || 0;

    var list = document.createElement('div');
    list.className = 'poll-opts';
    (data.options || []).forEach(function (o, i) {
      var pct = total ? Math.round((o.count / total) * 100) : 0;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'poll-opt' + (data.voted === i ? ' chosen' : '') + (showResults ? ' results' : '');
      btn.innerHTML =
        '<span class="po-text">' + esc(o.text) + '</span>' +
        (showResults ? '<span class="po-bar" style="width:' + pct + '%"></span><span class="po-pct">' + pct + '% · ' + o.count + ' 票</span>' : '');
      if (!showResults && !data.closed) {
        btn.addEventListener('click', function () { vote(container, data.post, i, opts); });
      } else {
        btn.disabled = true;
      }
      list.appendChild(btn);
    });
    wrap.appendChild(list);

    var meta = document.createElement('div');
    meta.className = 'poll-meta';
    meta.textContent = total + ' 票' + (data.closed ? ' · 已结束' : '') + (data.voted != null ? ' · 已投票' : ' · 点击选项投票');
    wrap.appendChild(meta);

    if (opts.canManage) {
      var bar = document.createElement('div');
      bar.className = 'poll-manage';
      if (!data.closed) {
        var closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'pa-btn';
        closeBtn.textContent = '结束投票';
        closeBtn.addEventListener('click', function () { manage(container, data.post, 'close', opts); });
        bar.appendChild(closeBtn);
      }
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'pa-btn';
      delBtn.textContent = '删除投票';
      delBtn.addEventListener('click', function () { if (confirm('确定删除该投票？')) manage(container, data.post, 'delete', opts); });
      bar.appendChild(delBtn);
      wrap.appendChild(bar);
    }
    container.appendChild(wrap);
    container.hidden = false;
  }

  function vote(container, postId, option, opts) {
    if (!myLogin()) { if (window.JW_LOGIN) window.JW_LOGIN(); return; }
    fetch('/api/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post: postId, action: 'vote', option: option })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (res.ok) { render(container, Object.assign({}, res.body, { post: postId }), opts); if (opts.onUpdated) opts.onUpdated(); }
        else if (res.body && res.body.error === 'unauthorized') { if (window.JW_LOGIN) window.JW_LOGIN(); }
        else if (res.body && res.body.error === 'closed') { alert('投票已结束'); }
        else { alert('投票失败，请重试'); }
      })
      .catch(function () { alert('网络错误'); });
  }

  function manage(container, postId, action, opts) {
    if (!myLogin()) { if (window.JW_LOGIN) window.JW_LOGIN(); return; }
    fetch('/api/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post: postId, action: action })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (!res.ok) { alert('操作失败'); return; }
        if (action === 'delete') {
          container.innerHTML = '';
          container.hidden = true;
          if (opts.onDeleted) opts.onDeleted();
        } else {
          render(container, Object.assign({}, res.body, { post: postId }), opts);
          if (opts.onUpdated) opts.onUpdated();
        }
      })
      .catch(function () { alert('网络错误'); });
  }

  // 作者创建投票的表单
  function renderComposer(container, postId, onSubmit) {
    container.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'poll-composer';
    wrap.innerHTML =
      '<div class="pc-title">添加投票</div>' +
      '<input class="edit-input pc-q" maxlength="200" placeholder="问题，例如：你最喜欢哪个？">' +
      '<div class="pc-opts"></div>' +
      '<button type="button" class="pc-add">+ 添加选项</button>' +
      '<button type="button" class="post-btn pc-save">创建投票</button>';
    container.appendChild(wrap);

    var optBox = wrap.querySelector('.pc-opts');
    function addOpt() {
      var i = document.createElement('input');
      i.className = 'edit-input pc-o';
      i.maxLength = 80;
      i.placeholder = '选项 ' + (optBox.children.length + 1);
      optBox.appendChild(i);
    }
    addOpt(); addOpt();
    wrap.querySelector('.pc-add').addEventListener('click', function () { if (optBox.children.length < 10) addOpt(); });
    wrap.querySelector('.pc-save').addEventListener('click', function () {
      var q = wrap.querySelector('.pc-q').value.trim();
      var opts = Array.prototype.map.call(optBox.querySelectorAll('.pc-o'), function (e) { return e.value.trim(); }).filter(Boolean);
      if (!q) { alert('请填写问题'); return; }
      if (opts.length < 2) { alert('至少需要两个选项'); return; }
      fetch('/api/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post: postId, action: 'create', question: q, options: opts })
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) {
          if (res.ok) { container.innerHTML = ''; container.hidden = true; if (onSubmit) onSubmit(res.body); }
          else if (res.body && res.body.error === 'forbidden') { alert('含违禁词，请修改'); }
          else if (res.body && res.body.error === 'need_options') { alert('至少两个选项'); }
          else { alert('创建失败'); }
        })
        .catch(function () { alert('网络错误'); });
    });
    container.hidden = false;
  }

  window.XLPoll = { render: render, renderComposer: renderComposer, vote: vote, manage: manage };
})();
