/* ============================================================
   茶馆 · 发帖输入框的「仿 M365」块编辑能力
   ------------------------------------------------------------
   把 小蓝页「更改当前页面布局」(editbar.js) 的那套交互搬到发帖正文编辑器：
     · 插入组：图片 / 视频 / 音频 / 文件（任意格式）/ 文本框 / 链接
     · 块组  ：复制 / 上移 / 下移 / 删除
     · 尺寸组：实时显示 宽 × 高、重置；图片·视频按比例拖角缩放
     · 选中块：单击即选中（虚线高亮 + 右下角拖拽手柄）
   与 editbar.js 的分工：editbar 管「整页版式」（存 pageedit:<path>），
   本文件管「帖子正文」（随帖子一起存进 posts:list），互不干扰。
   ============================================================ */
(function () {
  'use strict';

  var body = document.getElementById('pBody');
  var toolbar = document.getElementById('rtToolbar');
  if (!body || !toolbar) return;   // 非发帖页

  var MAX_FILE = 20 * 1024 * 1024;
  var sel = null;                  // 当前选中的块
  var picker = null;               // 复用的隐藏 file input

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fileUrl(key) { return '/api/file?key=' + encodeURIComponent(key); }

  function toast(msg, isErr) {
    if (window.xlToast) { window.xlToast(msg, isErr); return; }
    if (window.TeaAuth && window.TeaAuth.notify) { window.TeaAuth.notify(msg); return; }
    var el = document.getElementById('toast');
    if (el) {
      el.textContent = msg;
      el.className = 'toast show' + (isErr ? ' err' : '');
      setTimeout(function () { el.className = 'toast' + (isErr ? ' err' : ''); }, 2600);
    }
  }

  /* ---------------- 上传 ---------------- */
  function upload(file) {
    return new Promise(function (resolve, reject) {
      var fd = new FormData();
      fd.append('file', file, file.name);
      fetch('/api/upload', { method: 'POST', body: fd })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) {
          if (res.ok && res.body && res.body.ok) resolve(res.body);
          else reject(new Error((res.body && res.body.error) || 'upload_failed'));
        })
        .catch(function () { reject(new Error('network')); });
    });
  }

  function grabFile(accept) {
    return new Promise(function (resolve) {
      if (!picker) {
        picker = document.createElement('input');
        picker.type = 'file';
        picker.hidden = true;
        document.body.appendChild(picker);
      }
      picker.value = '';
      picker.accept = accept || '';
      picker.onchange = function () {
        var f = picker.files && picker.files[0];
        resolve(f || null);
      };
      picker.click();
    });
  }

  /* ---------------- 在光标处插入 HTML ---------------- */
  function insertHtml(html) {
    body.focus();
    var done = false;
    try { done = document.execCommand('insertHTML', false, html); } catch (e) { done = false; }
    if (!done) {
      var wrap = document.createElement('div');
      wrap.innerHTML = html;
      while (wrap.firstChild) body.appendChild(wrap.firstChild);
    }
    body.dispatchEvent(new Event('input'));   // 让字数统计刷新
  }

  /* ---------------- 块元素构造 ---------------- */
  function blockHtml(type, meta) {
    if (type === 'image') {
      return '<img class="m365-block m365-image" src="' + esc(meta.url) + '" alt="' + esc(meta.name || '') + '" />';
    }
    if (type === 'video') {
      return '<video class="m365-block m365-video" src="' + esc(meta.url) + '" controls playsinline preload="metadata"></video>';
    }
    if (type === 'audio') {
      return '<audio class="m365-block m365-audio" src="' + esc(meta.url) + '" controls preload="metadata"></audio>';
    }
    if (type === 'file') {
      var ext = (String(meta.name || 'FILE').split('.').pop() || 'FILE').toUpperCase().slice(0, 6);
      return '<a class="m365-block m365-file" href="' + esc(meta.url) + '" download="' + esc(meta.name || 'file') + '">' +
        '<span class="m365-file-ext">' + esc(ext) + '</span>' +
        '<span class="m365-file-name">' + esc(meta.name || 'file') + '</span></a>';
    }
    if (type === 'textbox') {
      return '<div class="m365-block m365-textbox" contenteditable="true">在此输入文字…</div>';
    }
    return '';
  }

  /* ---------------- 插入流程 ---------------- */
  function byType(file) {
    var t = file.type || '';
    if (/^image\//.test(t)) return 'image';
    if (/^video\//.test(t)) return 'video';
    if (/^audio\//.test(t)) return 'audio';
    return 'file';
  }

  function doInsert(kind, asUrl) {
    if (asUrl) {
      var url = window.prompt('填入地址（http/https 或以 / 开头的站内路径）：', 'https://');
      if (!url) return;
      if (!/^https?:\/\//i.test(url) && !/^\//.test(url)) { toast('地址不合法（只支持 http/https 或站内路径）', true); return; }
      var nameGuess = decodeURIComponent((url.split('?')[0].split('/').pop() || 'file'));
      insertHtml(blockHtml(kind, { url: url, name: nameGuess }));
      return;
    }
    var accept = kind === 'image' ? 'image/*' : (kind === 'video' ? 'video/*' : (kind === 'audio' ? 'audio/*' : ''));
    grabFile(accept).then(function (f) {
      if (!f) return;
      if (f.size > MAX_FILE) { toast('文件「' + f.name + '」超过 20MB 上限', true); return; }
      var t = kind === 'file' ? byType(f) : kind;   // 「文件」按钮：按真实类型智能落块
      toast('上传中：' + f.name);
      return upload(f).then(function (meta) {
        insertHtml(blockHtml(t, { url: fileUrl(meta.key), name: meta.name || f.name }));
        toast('已插入：' + (meta.name || f.name));
      }).catch(function (err) {
        toast(err && err.message === 'too_large' ? '文件过大（上限 20MB）' : '上传失败，请重试', true);
      });
    });
  }

  /* ---------------- 选中 / 尺寸手柄 ---------------- */
  var mini = null, badge = null, handle = null;

  function ensureUI() {
    if (mini) return;
    mini = document.createElement('div');
    mini.className = 'm365-mini';
    mini.innerHTML = '' +
      '<button type="button" data-blk="copy" title="复制块">⧉</button>' +
      '<button type="button" data-blk="up" title="上移">↑</button>' +
      '<button type="button" data-blk="down" title="下移">↓</button>' +
      '<button type="button" data-blk="del" title="删除块">🗑</button>';
    mini.hidden = true;
    document.body.appendChild(mini);

    badge = document.createElement('div');
    badge.className = 'm365-badge';
    badge.innerHTML = '<span class="m365-badge-size">--</span><button type="button" data-blk="reset" title="重置尺寸">⤢</button>';
    badge.hidden = true;
    document.body.appendChild(badge);

    handle = document.createElement('div');
    handle.className = 'm365-handle';
    handle.title = '拖拽调整大小（图片 / 视频按比例）';
    handle.hidden = true;
    document.body.appendChild(handle);

    handle.addEventListener('mousedown', startResize);
    document.addEventListener('click', onDocClick, true);
    window.addEventListener('scroll', placeUI, true);
    window.addEventListener('resize', placeUI);
  }

  function placeUI() {
    if (!sel || !document.body.contains(sel)) { hideUI(); return; }
    var r = sel.getBoundingClientRect();
    mini.hidden = false; badge.hidden = false; handle.hidden = false;
    var top = Math.max(6, r.top - 40);
    mini.style.top = top + 'px';
    mini.style.left = Math.max(6, Math.min(r.left, window.innerWidth - 172)) + 'px';
    badge.style.top = top + 'px';
    badge.style.left = Math.min(r.left + 178, window.innerWidth - 132) + 'px';
    handle.style.top = (r.bottom - 12) + 'px';
    handle.style.left = (r.right - 12) + 'px';
    var size = badge.querySelector('.m365-badge-size');
    if (size) size.textContent = Math.round(r.width) + ' × ' + Math.round(r.height);
  }

  function hideUI() {
    if (!mini) return;
    mini.hidden = true; badge.hidden = true; handle.hidden = true;
  }

  function select(el) {
    ensureUI();
    if (sel && sel !== el) sel.classList.remove('is-selected');
    sel = el;
    sel.classList.add('is-selected');
    placeUI();
  }

  function clearSel() {
    if (sel) sel.classList.remove('is-selected');
    sel = null;
    hideUI();
  }

  // 单击块 -> 选中；点空白 -> 取消；文本框内点击不抢选中（要能打字）
  function onDocClick(e) {
    if (!mini) return;
    if (e.target.closest && e.target.closest('.m365-mini,.m365-badge,.m365-handle,.editor-toolbar')) return;
    var blk = e.target.closest && e.target.closest('.m365-block');
    if (!blk) { clearSel(); return; }
    if (blk.classList.contains('m365-textbox') && !blk.classList.contains('is-selected')) return;
    if (e.target.classList && e.target.classList.contains('m365-file-name')) return; // 让文件链接可点开
    if (blk !== sel) select(blk);
  }

  /* ---------------- 拖角缩放 ---------------- */
  function startResize(e) {
    if (!sel) return;
    e.preventDefault();
    var el = sel;
    var keepRatio = el.tagName === 'IMG' || el.tagName === 'VIDEO';
    var r0 = el.getBoundingClientRect();
    var sx = e.clientX, sy = e.clientY;
    var w0 = r0.width, h0 = r0.height;
    el.classList.add('is-resizing');
    document.body.style.userSelect = 'none';

    function move(ev) {
      var dw = ev.clientX - sx;
      var dh = ev.clientY - sy;
      var w = Math.max(40, Math.round(w0 + dw));
      var h = Math.max(24, Math.round(h0 + dh));
      if (keepRatio && w0 > 0) {
        h = Math.max(24, Math.round(w * (h0 / w0)));
      }
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      placeUI();
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
      el.classList.remove('is-resizing');
      body.dispatchEvent(new Event('input'));
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  /* ---------------- 块操作 ---------------- */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-blk]');
    if (!btn) return;
    if (!sel) return;
    e.preventDefault();
    var act = btn.getAttribute('data-blk');
    if (act === 'del') {
      var n = sel;
      clearSel();
      n.remove();
    } else if (act === 'copy') {
      var c = sel.cloneNode(true);
      c.classList.remove('is-selected');
      sel.parentNode.insertBefore(c, sel.nextSibling);
      select(c);
    } else if (act === 'up') {
      var prev = sel.previousElementSibling;
      if (prev) { sel.parentNode.insertBefore(sel, prev); placeUI(); }
      else toast('已经在最上面了');
    } else if (act === 'down') {
      var next = sel.nextElementSibling;
      if (next) { sel.parentNode.insertBefore(next, sel); placeUI(); }
      else toast('已经在最下面了');
    } else if (act === 'reset') {
      sel.style.width = '';
      sel.style.height = '';
      placeUI();
    }
    body.dispatchEvent(new Event('input'));
  });

  /* ---------------- 工具栏「插入 / 块」组 ---------------- */
  (function buildRibbon() {
    var sep = document.createElement('span');
    sep.className = 'tb-sep';
    var grp = document.createElement('span');
    grp.className = 'rt-group';
    // 注意：按钮用 .m365-tb 而不是模板的 .rt-btn —— 模板工具栏的 click 处理器只认 [data-cmd]，
    // 这样加组可以做到「不改动搬来的发帖模板脚本」。
    grp.innerHTML = '' +
      '<button type="button" class="m365-tb" data-ins="image" title="插入图片（上传或填地址）">🖼</button>' +
      '<button type="button" class="m365-tb" data-ins="video" title="插入视频">🎬</button>' +
      '<button type="button" class="m365-tb" data-ins="audio" title="插入音频">🎵</button>' +
      '<button type="button" class="m365-tb" data-ins="file" title="插入文件（任意格式：压缩包/文档/程序…）">📎</button>' +
      '<button type="button" class="m365-tb" data-ins="textbox" title="插入文本框">▭T</button>';

    var menu = document.createElement('div');
    menu.className = 'rt-menu';
    menu.hidden = true;
    menu.innerHTML = '<button type="button" class="rt-menu-item" data-mode="upload">从本机上传</button>' +
      '<button type="button" class="rt-menu-item" data-mode="url">填入网址</button>';

    var clearBtn = toolbar.querySelector('[data-cmd="removeFormat"]');
    toolbar.insertBefore(sep, clearBtn || null);
    toolbar.insertBefore(grp, clearBtn || null);
    toolbar.appendChild(menu);

    grp.addEventListener('click', function (e) {
      var b = e.target.closest('[data-ins]');
      if (!b) return;
      e.preventDefault();
      var kind = b.getAttribute('data-ins');
      if (kind === 'textbox') { insertHtml(blockHtml('textbox', {})); return; }
      // 弹出「上传 / 网址」二选一
      var r = b.getBoundingClientRect();
      menu.hidden = false;
      menu.style.position = 'fixed';
      menu.style.top = (r.bottom + 6) + 'px';
      menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 160)) + 'px';
      menu.setAttribute('data-kind', kind);
    });

    menu.addEventListener('click', function (e) {
      var it = e.target.closest('[data-mode]');
      if (!it) return;
      e.preventDefault();
      var kind = menu.getAttribute('data-kind');
      var mode = it.getAttribute('data-mode');
      menu.hidden = true;
      doInsert(kind, mode === 'url');
    });

    document.addEventListener('click', function (e) {
      if (!menu.hidden && !e.target.closest('.rt-menu,.rt-group')) menu.hidden = true;
    });
  })();

  /* ---------------- 贴前清理：去掉编辑痕迹，保留块 ---------------- */
  // 块本身在 #pBody 内，手柄/迷你条挂在 body 上，不会进正文；
  // 只需在「发布/存草稿」被点击前取消选中（否则 .is-selected 会随 innerHTML 一起提交）。
  // 用捕获阶段：先于模板自己的按钮监听执行，从而无需改动搬来的模板脚本。
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest('#postBtn,#draftBtn')) clearSel();
  }, true);
  window.__m365Clean = function (html) {
    return String(html || '').replace(/\s(?:is-selected|is-resizing)/g, '');
  };

  ensureUI();
  hideUI();
})();
