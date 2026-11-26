/* 火羽直播档案 · 编辑器前端（无框架，直接调本地后端） */
(function () {
  'use strict';

  var B = {};
  var state = { sessions: [], key: '', recs: [], quotes: [], sel: {}, tags: [], edit: null,
                reveal: false, ov: {}, ovEdit: -1, refKind: '' };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  }); }
  function api(path, opts) {
    return fetch(path, opts).then(function (r) { return r.json().then(function (j) {
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    }); });
  }
  function post(path, data) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                       body: JSON.stringify(data || {}) });
  }
  var toastTimer;
  function toast(msg, bad) {
    var el = $('toast');
    el.textContent = msg;
    el.style.borderColor = bad ? 'var(--bad)' : 'var(--fire)';
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }

  // ---- 自绘确认框 ----
  // 不用 window.confirm / prompt：Electron 里原生对话框关闭后 webContents
  // 拿不回键盘焦点，窗口看着是激活的，输入框却打不进字（删除摘录后必然出现）。
  // ask(msg) -> Promise<boolean>；askText(title, value) -> Promise<string|null>
  var askReq = null;

  function askOpen(opt) {
    // 已经有框在等回复时（连点两次）直接当取消，别把上一个 Promise 悬在那儿
    if (askReq) return Promise.resolve(null);
    var prev = document.activeElement;
    var inp = $('askInput');
    var hasInput = opt.value != null;
    $('askTitle').textContent = opt.title || '确认';
    $('askMsg').textContent = opt.msg || '';
    $('askMsg').hidden = !opt.msg;
    inp.hidden = !hasInput;
    inp.value = hasInput ? opt.value : '';
    $('askOk').textContent = opt.ok || '确定';
    $('askModal').hidden = false;
    askReq = { prev: prev, resolve: null };
    // 等一帧再聚焦，否则刚显示的元素 focus 会被浏览器忽略
    setTimeout(function () {
      if (hasInput) { inp.focus(); inp.select(); } else { $('askOk').focus(); }
    }, 0);
    return new Promise(function (res) { askReq.resolve = res; });
  }

  function closeAsk(v) {
    if (!askReq) return;
    var req = askReq;
    askReq = null;
    $('askModal').hidden = true;
    var prev = req.prev;
    // 原来的焦点还在、还看得见就还回去；删除后按钮已隐藏，就不硬塞
    if (prev && document.contains(prev) && prev.offsetParent) {
      try { prev.focus(); } catch (e) { /* 元素可能刚被移除 */ }
    }
    req.resolve(v);
  }

  function ask(msg, ok) { return askOpen({ msg: msg, ok: ok }); }
  function askText(title, value, ok) { return askOpen({ title: title, value: value, ok: ok }); }

  function showView(name) {
    ['quote', 'lib', 'fix', 'tag'].forEach(function (v) {
      $('view-' + v).hidden = v !== name;
      $('tab-' + v).classList.toggle('on', v === name);
    });
    if (name === 'lib') renderLib();
    if (name === 'fix') renderFixes();
    if (name === 'tag') renderTags();
  }

  function boot() {
    api('/api/bootstrap').then(function (d) {
      B = d;
      state.sessions = d.sessions;
      state.tags = d.tags;
      $('sessionCount').textContent = d.sessions.length + ' 场';
      $('topMeta').textContent = '本地运行 · 数据 ' + (d.sessions.length ? d.sessions[0].date : '-') +
        ' 起 · 已加载 ' + d.builtFixes + ' 条校勘';
      renderSessions();
      renderTagPicks();
      renderFixes();     // 直链直接落在「全局修正」时，规则列表要等 bootstrap 回来才能填
      if (d.sessions.length) loadSession(d.sessions[0].key);
    }).catch(function (e) { toast(e.message, true); });
  }

  // ---- 左栏分节：场次 / 本场摘录，照 VSCode 资源管理器那样点头部折叠 ----
  var PANE_CLOSED = 'lc-pane-closed';
  var paneClosed = {};
  try { paneClosed = JSON.parse(localStorage.getItem(PANE_CLOSED) || '{}') || {}; } catch (e) { paneClosed = {}; }

  function applyPanes() {
    Array.prototype.forEach.call(document.querySelectorAll('.pane'), function (el) {
      var k = el.id === 'pane-sess' ? 'sess' : 'quote';
      el.classList.toggle('collapsed', !!paneClosed[k]);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.pane-head'), function (h) {
    h.addEventListener('click', function (e) {
      if (e.target.closest('button')) return;    // 头部右侧的图标按钮不触发折叠
      var k = h.getAttribute('data-pane');
      if (paneClosed[k]) delete paneClosed[k]; else paneClosed[k] = true;
      localStorage.setItem(PANE_CLOSED, JSON.stringify(paneClosed));
      applyPanes();
    });
  });
  applyPanes();

  // ---- 场次树：年 / 月 / 日 / 场次，像 VSCode 的资源管理器 ----
  // 每层都单独占一行，不做单链合并：即使某个月只有一天，也照样
  // 「年 → 月 → 日 → 场次」层层展开，层级关系始终一致，不随数据变形。
  // 不合并之后 path 的语义变了（2026/10 现在是「月份」而不是「年/月并成的一行」），
  // 折叠状态换个 key，避免把旧的压缩路径当成本层路径用。
  var SESS_CLOSED = 'lc-sess-closed-v2';
  var closed = {};
  try { closed = JSON.parse(localStorage.getItem(SESS_CLOSED) || '{}') || {}; } catch (e) { closed = {}; }

  function treeNode(label, path) {
    return { label: label, path: path, children: [], isFolder: true, session: null };
  }

  function sessTree() {
    var root = treeNode('', '');
    state.sessions.forEach(function (s) {
      var p = String(s.dateLong || '').split('.');
      var y = p[0] || '?', m = p[1] || '?', d = p[2] || '?';
      var ny = findOrAdd(root, y, y);
      var nm = findOrAdd(ny, m, y + '/' + m);
      var nd = findOrAdd(nm, d, y + '/' + m + '/' + d);
      nd.children.push({
        label: (s.start || '').slice(0, 5), path: y + '/' + m + '/' + d + '/' + s.key,
        children: [], isFolder: false, session: s
      });
    });
    sortTree(root);
    return root;
  }

  function findOrAdd(node, label, path) {
    for (var i = 0; i < node.children.length; i++) {
      if (node.children[i].isFolder && node.children[i].label === label) return node.children[i];
    }
    var n = treeNode(label, path);
    node.children.push(n);
    return n;
  }

  // path 里年份、月份、日期都是定宽或可直接比大小，按字符串排就是时间序
  function sortTree(node) {
    node.children.sort(function (a, b) {
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    node.children.forEach(function (c) { if (c.isFolder) sortTree(c); });
  }

  // 图标只用内联 SVG，不引字体：随主题 currentColor 走，缩放不糊
  var SVG_CHEV = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 3.6 10.6 8l-4.4 4.4"/></svg>';
  var SVG_FOLDER = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" ' +
    'stroke-linejoin="round"><path d="M1.9 4.3h4.2l1.3 1.5h6.7v6.9a1 1 0 0 1-1 1H2.9a1 1 0 0 1-1-1z"/></svg>';
  var SVG_CLOCK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" ' +
    'stroke-linecap="round"><circle cx="8" cy="8" r="5.7"/><path d="M8 4.9v3.3l2.1 1.3"/></svg>';

  // 每层一个 .ind，纵向参考线画在它里面，缩进层级才看得出来
  function indentHtml(depth) {
    var s = '';
    for (var i = 0; i < depth; i++) s += '<span class="ind"></span>';
    return s;
  }

  // 打开某场次时把它上面几层展开，否则选中的行藏在折叠目录里
  function revealAncestors(node, key) {
    if (!node.isFolder) return !!node.session && node.session.key === key;
    var hit = false;
    node.children.forEach(function (c) { if (revealAncestors(c, key)) hit = true; });
    if (hit && node.path) delete closed[node.path];
    return hit;
  }

  function renderSessions() {
    var box = $('sessionList');
    var keep = box.scrollTop;
    var root = sessTree();
    // 只有刚切场次时才自动展开它的上层目录；否则「全部收起」会被立刻顶开
    if (state.key && state.reveal) { revealAncestors(root, state.key); state.reveal = false; }
    var out = [];

    function row(node, depth) {
      var guides = indentHtml(depth);
      if (node.isFolder) {
        var shut = !!closed[node.path];
        out.push('<div class="trow folder' + (shut ? '' : ' open') + '" data-path="' + esc(node.path) + '"' +
          ' title="' + esc(node.label) + '">' + guides +
          '<span class="chev">' + SVG_CHEV + '</span>' +
          '<span class="ico">' + SVG_FOLDER + '</span>' +
          '<span class="tl">' + esc(node.label) + '</span>' +
          '<span class="badge">' + countLeaves(node) + '</span></div>');
        if (!shut) node.children.forEach(function (c) { row(c, depth + 1); });
      } else {
        var s = node.session;
        out.push('<div class="trow session' + (s.key === state.key ? ' sel' : '') + '" data-key="' + esc(s.key) + '"' +
          ' title="' + esc(s.dateLong + ' ' + (s.week || '') + ' · ' + s.count + ' 条逐字稿') + '">' + guides +
          '<span class="chev"></span>' +
          '<span class="ico">' + SVG_CLOCK + '</span>' +
          '<span class="tl">' + esc(node.label) + '</span>' +
          '<span class="badge">' + esc(s.count) + '</span></div>');
      }
    }
    root.children.forEach(function (c) { row(c, 0); });

    box.innerHTML = out.join('');
    box.scrollTop = keep;

    Array.prototype.forEach.call(box.querySelectorAll('.trow.folder'), function (el) {
      el.addEventListener('click', function () {
        var p = el.getAttribute('data-path');
        if (closed[p]) delete closed[p]; else closed[p] = true;
        localStorage.setItem(SESS_CLOSED, JSON.stringify(closed));
        renderSessions();
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('.trow.session'), function (el) {
      el.addEventListener('click', function () { loadSession(el.getAttribute('data-key')); });
    });
    var cur = box.querySelector('.trow.session.sel');
    if (cur && !keep) cur.scrollIntoView({ block: 'nearest' });
  }

  function countLeaves(node) {
    if (!node.isFolder) return 1;
    return node.children.reduce(function (n, c) { return n + countLeaves(c); }, 0);
  }

  function loadSession(key, done) {
    // 换场次后旧关键词没有意义，查找条跟着收起来（quiet：下面紧接着就要重画列表）
    if (find.open) closeFind(true);
    state.key = key;
    state.reveal = true;
    state.edit = null;
    state.sel = {};
    ctx.data = null; ctx.key = ''; ctx.from = 0;   // 换场次重新拉上下文
    ctx.q = '';
    if ($('ctxSearch')) $('ctxSearch').value = '';
    api('/api/session?key=' + encodeURIComponent(key)).then(function (d) {
      state.recs = d.records;
      state.quotes = d.quotes;
      state.ov = d.overrides || {};
      $('transTitle').textContent = (state.sessions.filter(function (s) { return s.key === key; })[0] || {}).dateLong +
        ' · ' + d.records.length + ' 条 · 本场 ' + d.quotes.length + ' 摘录';
      renderRecs();
      newQuote();
      renderSessions();
      if (ctx.open) openCtx();
      if (done) done();
    }).catch(function (e) { toast(e.message, true); });
  }

  // ---- 逐字稿内搜索（照 VSCode 的查找条）----
  // 不过滤行，只高亮 + 上下跳：搜索时还能照常勾选，位置感也不会丢
  var find = { open: false, q: '', case: false, regex: false, re: null, rows: [], cur: -1, bad: false };

  function findSpans(text) {
    text = String(text == null ? '' : text);
    if (!find.q || !find.re) return null;
    var out = [], m, guard = 0;
    find.re.lastIndex = 0;
    while ((m = find.re.exec(text)) !== null && guard++ < 400) {
      if (!m[0]) { find.re.lastIndex++; continue; }   // 空匹配会让 exec 原地打转
      out.push([m.index, m.index + m[0].length]);
    }
    return out.length ? out : null;
  }

  function findBuild() {
    find.q = $('findInput').value;
    find.bad = false;
    find.re = null;
    if (!find.q) return;
    var src = find.regex ? find.q : find.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { find.re = new RegExp(src, find.case ? 'g' : 'gi'); }
    catch (e) { find.bad = true; }
  }

  function findStat() {
    var el = $('findStat');
    el.classList.toggle('bad', !!find.bad || (!!find.q && !find.rows.length));
    if (!find.q) el.textContent = '';
    else if (find.bad) el.textContent = '正则错误';
    else if (!find.rows.length) el.textContent = '无结果';
    else el.textContent = (find.cur + 1) + '/' + find.rows.length;
    var none = !find.rows.length;
    $('findPrev').disabled = none;
    $('findNext').disabled = none;
  }

  function findRun(keep) {
    findBuild();
    var rows = [];
    if (find.re) {
      // 原文和译文都搜：改译文时也常常是按原句定位的
      state.recs.forEach(function (r, i) {
        if (findSpans(r[1]) || findSpans(r[2])) rows.push(i);
      });
    }
    find.rows = rows;
    if (!rows.length) find.cur = -1;
    else if (keep && find.cur >= 0) find.cur = Math.min(find.cur, rows.length - 1);
    else find.cur = 0;
    renderRecs();
    findStat();
    if (find.cur >= 0) {
      var el = $('recList').querySelector('.rec[data-i="' + rows[find.cur] + '"]');
      if (el) el.scrollIntoView({ block: 'center' });
    }
  }

  function findMove(step) {
    if (!find.rows.length) return;
    find.cur = (find.cur + step + find.rows.length) % find.rows.length;
    Array.prototype.forEach.call($('recList').querySelectorAll('.rec.cur'), function (el) {
      el.classList.remove('cur');
    });
    var el = $('recList').querySelector('.rec[data-i="' + find.rows[find.cur] + '"]');
    if (el) { el.classList.add('cur'); el.scrollIntoView({ block: 'center' }); }
    findStat();
  }

  function openFind() {
    find.open = true;
    $('findBar').hidden = false;
    var inp = $('findInput');
    inp.focus();
    inp.select();
    if (inp.value) findRun(true);
  }

  // quiet：换场次时只清状态，列表紧接着会被重画，不必多刷一遍
  function closeFind(quiet) {
    find.open = false;
    $('findBar').hidden = true;
    find.q = ''; find.re = null; find.rows = []; find.cur = -1; find.bad = false;
    $('findInput').value = '';
    if (!quiet) renderRecs();
    findStat();
  }

  function renderRecs() {
    var keep = $('recList').scrollTop;   // 勾选一行会重画整个列表，别把滚动位置丢掉
    var marked = {};
    state.quotes.forEach(function (q) {
      (q.sel || []).forEach(function (x) { marked[x.i] = q.tag; });
    });
    function paint(text) {
      var spans = find.q ? findSpans(text) : null;
      return spans ? hlSpans(text, spans) : esc(text);
    }
    $('recList').innerHTML = state.recs.map(function (r, i) {
      var ov = state.ov && state.ov[i];
      var cur = find.cur >= 0 && find.rows[find.cur] === i;
      return '<label class="rec' + (state.sel[i] ? ' on' : '') + (ov ? ' edited' : '') + (cur ? ' cur' : '') +
        '" data-i="' + i + '">' +
        '<input type="checkbox" ' + (state.sel[i] ? 'checked' : '') + '>' +
        '<span class="t">' + esc(r[0]) + '</span>' +
        '<span>' + (ov ? '<div class="ovwhy" title="' + esc(ov.why) + '">已改 · ' + esc(ov.why) + '</div>' : '') +
        '<div class="jp">' + paint(r[1]) + '</div>' +
        (r[2] ? '<div class="zh">' + paint(r[2]) + '</div>' : '') +
        (marked[i] ? '<span class="marked">已有摘录 · ' + esc(marked[i]) + '</span>' : '') +
        '</span>' +
        '<span class="racts">' +
        '<button class="rbtn rcopy" data-copy="' + i + '" title="复制这一条（原文 + 译文）" aria-label="复制这一条">' +
        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">' +
        '<rect x="5.6" y="5.6" width="7.8" height="7.8" rx="1.3"/>' +
        '<path d="M10.4 5.6V3.9c0-.8-.6-1.4-1.4-1.4H3.9c-.8 0-1.4.6-1.4 1.4v5.1c0 .8.6 1.4 1.4 1.4h1.7"/></svg>' +
        '</button>' +
        '<button class="rbtn redit" data-edit="' + i + '" title="改这一行的原文 / 译文">✎</button>' +
        '</span></label>';
    }).join('');
    $('recList').scrollTop = keep;
    syncCopyBtn();
    Array.prototype.forEach.call($('recList').querySelectorAll('.rec'), function (el) {
      var i = Number(el.getAttribute('data-i'));
      el.querySelector('input').addEventListener('change', function (e) {
        if (e.target.checked) state.sel[i] = true; else delete state.sel[i];
        el.classList.toggle('on', !!state.sel[i]);
        syncCopyBtn();
        renderPreview();
        if (ctx.open) renderCtx(true);
      });
    });
    Array.prototype.forEach.call($('recList').querySelectorAll('.rcopy'), function (b) {
      b.addEventListener('click', function (e) {
        // 同样在 label 里，不拦住这一下就会把这行勾选翻掉
        e.preventDefault();
        e.stopPropagation();
        copyLine(Number(b.getAttribute('data-copy')));
      });
    });
    Array.prototype.forEach.call($('recList').querySelectorAll('.redit'), function (b) {
      b.addEventListener('click', function (e) {
        // 在 label 里，不拦下来会顺手把这一行的勾选翻掉
        e.preventDefault();
        e.stopPropagation();
        openOverride(Number(b.getAttribute('data-edit')));
      });
    });
    renderPreview();
  }

  // ---- 单行覆盖：改原文/译文，并留一条「为什么改」 ----
  function openOverride(i) {
    var r = state.recs[i];
    if (!r) return;
    var ov = (state.ov && state.ov[i]) || null;
    state.ovEdit = i;
    $('ovMeta').textContent = r[0] + (ov ? ' · 已改于 ' + (ov.at || '') : '');
    $('ov-jp').value = r[1] || '';
    $('ov-zh').value = r[2] || '';
    $('ov-why').value = ov ? (ov.why || '') : '';
    $('ov-revert').hidden = !ov;
    $('ovModal').hidden = false;
    $('ov-jp').focus();
  }
  function closeOverride() {
    $('ovModal').hidden = true;
    state.ovEdit = -1;
  }
  function applyOverrideResult(d) {
    state.recs = d.records;
    state.ov = d.overrides || {};
    // 改完文本命中位置会变，搜索开着就重算一遍（也顺带重画列表）
    if (find.open) findRun(true); else renderRecs();
    if (ctx.open) renderCtx(true);
    closeOverride();
    toast('已保存 · 重建后站点生效');
  }
  function saveOverride() {
    var i = state.ovEdit;
    if (i < 0) return;
    post('/api/override', {
      session: state.key, i: i,
      jp: $('ov-jp').value, zh: $('ov-zh').value, why: $('ov-why').value,
    }).then(applyOverrideResult).catch(function (e) { toast(e.message, true); });
  }

  function selIndices() {
    return Object.keys(state.sel).map(Number).sort(function (a, b) { return a - b; });
  }

  // ---- 复制逐字稿 ----
  // 两种入口：行内按钮复制一条，顶部按钮复制勾选的所有行。
  // 格式：[时间] 原文 / 换行译文 —— 这样粘到笔记里还能对回录音。
  function lineText(i) {
    var r = state.recs[i];
    if (!r) return '';
    var head = '[' + (r[0] || '') + '] ' + (r[1] || '');
    var zh = (r[2] || '').trim();
    return zh ? head + '\n' + zh : head;
  }

  // 剪贴板 API 在非安全上下文会被禁用，退回 execCommand 兜底（Electron 里通常轮不到）
  function copyRaw(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function writeClipboard(text, okMsg) {
    function fallback() {
      if (copyRaw(text)) toast(okMsg); else toast('复制失败：剪贴板不可写', true);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, fallback);
    } else fallback();
  }

  function copyLine(i) {
    var text = lineText(i);
    if (!text) return;
    writeClipboard(text, '已复制这一条');
  }

  function copySelected() {
    var idx = selIndices();
    if (!idx.length) return toast('先勾选要复制的逐字稿', true);
    var text = idx.map(lineText).filter(Boolean).join('\n\n');
    if (!text) return toast('没有可复制的行', true);
    writeClipboard(text, '已复制选中的 ' + idx.length + ' 条');
  }

  // 按钮跟着勾选数走，点之前就知道会复制几条；没勾选时禁用
  function syncCopyBtn() {
    var b = $('btn-copy');
    if (!b) return;
    var n = selIndices().length;
    b.disabled = !n;
    b.textContent = n ? '复制选中 ' + n : '复制选中';
    b.title = n ? '复制勾选的 ' + n + ' 条逐字稿（原文 + 译文，带时间戳）'
                : '先在逐字稿里勾选要复制的行';
  }

  // ---- 引用块：一条摘录可以挂一条 SC 或一条弹幕（二选一） ----
  // 两个输入框沿用 f-sc* 的 id，内部只按 state.refKind 决定写 sc 还是 dm 字段。
  function setRefKind(k) {
    state.refKind = k === 'dm' ? 'dm' : 'sc';
    Array.prototype.forEach.call($('refKinds').children, function (b) {
      b.classList.toggle('on', b.getAttribute('data-k') === state.refKind);
    });
    $('f-sctext').placeholder = state.refKind === 'dm'
      ? '弹幕原文，可多行；框会随内容长高'
      : 'SC 原文，可多行；框会随内容长高';
  }

  function refValue() {
    return {
      kind: state.refKind === 'dm' ? 'dm' : 'sc',
      name: $('f-scname').value.trim(),
      text: $('f-sctext').value.trim()
    };
  }

  // 文本框随内容长高，SC 常有多行，别让它缩在一条里横向滚
  function fitArea(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight + 2, 220) + 'px';
  }

  function renderPreview() {
    var idx = selIndices();
    $('selInfo').textContent = idx.length ? idx.length + ' 行 · ' +
      state.recs[idx[0]][0] + '–' + state.recs[idx[idx.length - 1]][0] : '未勾选';

    var ref = refValue();
    var out = '';
    // 引用（SC / 弹幕）也是摘录的一部分，预览里必须看得到，否则会以为没填进去
    if (ref.name || ref.text) {
      var dm = ref.kind === 'dm';
      out += '<div class="psc' + (dm ? ' pdm' : '') + '">' +
        '<span class="psc-k">' + (dm ? '弹幕' : 'SC') + '</span>' +
        (ref.name ? '<b class="psc-n">' + esc(ref.name) + '</b>' : '<b class="psc-n dim">匿名</b>') +
        (ref.text ? '<span class="psc-t">' + esc(ref.text).replace(/\r?\n/g, '<br>') + '</span>' : '') +
        '</div>';
    }

    if (idx.length) {
      out += idx.map(function (i) {
        var r = state.recs[i];
        return '<div class="pl"><span class="t">' + esc(r[0]) + '</span>' + esc(r[1]) +
          (r[2] ? '<span class="z">' + esc(r[2]) + '</span>' : '') + '</div>';
      }).join('');
    } else if (!out) {
      out = '在中间勾选逐字稿行';
    } else {
      out += '<div class="pnone">还没勾选逐字稿</div>';
    }
    $('prevBody').innerHTML = out;
  }

  // ---- 上下文抽屉：本场全部 SC + 弹幕，按选中的逐字稿行定位 ----
  var CTX_PAGE = 200;
  var ctx = { open: false, data: null, key: '', filter: 'all', q: '', from: 0 };

  function ctxItems() {
    var all = (ctx.data && ctx.data.items) || [];
    var list = ctx.filter === 'all' ? all : all.filter(function (x) { return x.k === ctx.filter; });
    var q = ctx.q.trim().toLowerCase();
    if (!q) return list;
    return list.filter(function (x) {
      return String(x.text || '').toLowerCase().indexOf(q) >= 0 ||
             String(x.name || '').toLowerCase().indexOf(q) >= 0 ||
             String(x.trans || '').toLowerCase().indexOf(q) >= 0;
    });
  }

  // 命中处套 <mark>；逐段转义，别让弹幕里的尖括号变成标签
  function hl(text, q) {
    text = String(text == null ? '' : text);
    q = (q || '').trim();
    if (!q) return esc(text);
    var low = text.toLowerCase(), ql = q.toLowerCase(), out = '', i = 0;
    while (i <= text.length) {
      var k = low.indexOf(ql, i);
      if (k < 0) { out += esc(text.slice(i)); break; }
      out += esc(text.slice(i, k)) + '<mark>' + esc(text.slice(k, k + ql.length)) + '</mark>';
      i = k + ql.length;
    }
    return out;
  }

  function ctxAnchorTs() {
    var idx = selIndices();
    if (!idx.length || !ctx.data || !ctx.data.recTs) return null;
    var v = ctx.data.recTs[idx[0]];
    return typeof v === 'number' ? v : null;
  }

  function nearestIndex(list, ts) {
    if (!list.length) return 0;
    if (ts == null) return 0;
    var lo = 0, hi = list.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (list[mid].ts < ts) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(list[lo - 1].ts - ts) <= Math.abs(list[lo].ts - ts)) lo -= 1;
    return lo;
  }

  function hhmmss(ts) {
    var d = new Date(ts * 1000);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function offLabel(d) {
    if (d == null) return '';
    if (!d) return '±0s';
    var s = Math.abs(d), txt = s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + (s % 60 ? (s % 60) + 's' : '');
    return (d > 0 ? '+' : '−') + txt;
  }

  function renderCtx(recenter) {
    var box = $('ctxList');
    if (!ctx.data) { box.innerHTML = '<div class="cempty">载入中…</div>'; return; }
    if (ctx.data.error) { box.innerHTML = '<div class="cempty">' + esc(ctx.data.error) + '</div>'; return; }

    var list = ctxItems();
    var meta = $('ctxMeta');
    var c = ctx.data.counts || { sc: 0, dm: 0 };
    var q = ctx.q.trim();
    var total = ctx.filter === 'all' ? c.sc + c.dm
      : (ctx.filter === 'sc' ? c.sc : c.dm);
    meta.textContent = list.length
      ? (q ? '命中 ' + list.length + ' / ' + total : 'SC ' + c.sc + ' · 弹幕 ' + c.dm +
         (ctx.filter === 'all' ? ' · 共 ' + list.length : ' · 筛出 ' + list.length))
      : (q ? '命中 0 / ' + total : '');

    if (!list.length) {
      box.innerHTML = '<div class="cempty">' +
        esc(q ? '没有匹配「' + q + '」的 SC 或弹幕'
          : (ctx.data.hint || (ctx.filter === 'all' ? '这场没有 SC 也没有弹幕记录'
            : '这场没有' + (ctx.filter === 'sc' ? ' SC' : '弹幕') + '记录'))) + '</div>';
      $('ctxRange').textContent = '';
      $('ctxPrev').disabled = $('ctxNext').disabled = true;
      return;
    }

    var anchor = ctxAnchorTs();
    var near = q ? -1 : nearestIndex(list, anchor);
    if (recenter || ctx.from == null) ctx.from = q ? 0 : Math.max(0, near - 40);
    ctx.from = Math.max(0, Math.min(ctx.from, Math.max(0, list.length - CTX_PAGE)));
    var slice = list.slice(ctx.from, ctx.from + CTX_PAGE);

    box.innerHTML = slice.map(function (x, i) {
      var d = anchor == null ? null : x.ts - anchor;
      var cls = 'ctxrow ' + x.k + (ctx.from + i === near ? ' near' : '');
      return '<div class="' + cls + '" data-k="' + x.k + '">' +
        '<span class="ct">' + hhmmss(x.ts) + '</span>' +
        '<span class="coff">' + esc(offLabel(d)) + '</span>' +
        '<span class="cbody"><b>' + hl(x.name || '匿名', q) + '</b>' +
        (x.k === 'sc' ? '<span class="cbadge">SC</span>' : '') +
        (x.medal ? '<span class="cmedal">' + esc(x.medal) + '</span>' : '') +
        '<span class="ctext">' + hl(x.text, q) + '</span>' +
        (x.trans ? '<span class="ctrans">' + hl(x.trans, q) + '</span>' : '') +
        '</span></div>';
    }).join('');
    // 点 SC / 弹幕行直接填进右侧表单的引用字段，省得手抄
    Array.prototype.forEach.call(box.querySelectorAll('.ctxrow'), function (row, i) {
      var it = slice[i];
      if (it.k !== 'sc' && it.k !== 'dm') return;
      var isDm = it.k === 'dm';
      row.title = isDm ? '点击填入摘录的弹幕引用' : '点击填入摘录的 SC 引用';
      row.style.cursor = 'pointer';
      row.onclick = function () {
        setRefKind(isDm ? 'dm' : 'sc');
        $('f-scname').value = it.name || '';
        $('f-sctext').value = it.text || '';
        fitArea($('f-sctext'));
        renderPreview();
        toast('已填入' + (isDm ? '弹幕：' : ' SC：') + (it.name || '匿名') +
              ' · ' + it.text.slice(0, 24));
      };
    });

    $('ctxRange').textContent = (ctx.from + 1) + '–' + (ctx.from + slice.length) + ' / ' + list.length;
    $('ctxPrev').disabled = ctx.from <= 0;
    $('ctxNext').disabled = ctx.from + CTX_PAGE >= list.length;

    var hit = box.querySelector('.ctxrow.near');
    if (hit) hit.scrollIntoView({ block: 'center' });
    else box.scrollTop = 0;
  }

  function openCtx() {
    $('ctxDrawer').hidden = false;
    document.body.classList.add('ctx-open');
    ctx.open = true;
    layout();   // 让出抽屉宽度后重新夹一次栏宽
    if (ctx.key !== state.key || !ctx.data) {
      ctx.key = state.key; ctx.data = null; ctx.from = 0;
      renderCtx(true);
      api('/api/ctx?key=' + encodeURIComponent(state.key))
        .then(function (d) { ctx.data = d; renderCtx(true); })
        .catch(function (e) { ctx.data = { error: e.message }; renderCtx(true); });
    } else {
      renderCtx(true);
    }
  }

  function closeCtx() {
    $('ctxDrawer').hidden = true;
    document.body.classList.remove('ctx-open');
    ctx.open = false;
    layout();
  }

  // 本场已生成的摘录，点一条载入表单继续编辑
  function renderQuoteList() {
    var cur = state.edit ? state.edit._i : -1;
    $('qCount').textContent = state.quotes.length ? String(state.quotes.length) : '';
    $('qList').innerHTML = state.quotes.length ? state.quotes.map(function (q) {
      var title = q.title || (q.jp || '').split('\n')[0] || '(未命名)';
      return '<div class="qitem' + (q._i === cur ? ' on' : '') + '" data-i="' + q._i + '">' +
        '<span class="qt">' + esc((q.t || '').slice(0, 5)) + '</span>' +
        '<span class="qi" title="' + esc(title) + '">' + esc(title) + '</span>' +
        '<span class="qg">' + esc(q.tag) + '</span></div>';
    }).join('') : '<div class="qempty">本场还没有摘录</div>';
    Array.prototype.forEach.call($('qList').querySelectorAll('.qitem'), function (el) {
      el.addEventListener('click', function () {
        var i = Number(el.getAttribute('data-i'));
        var q = state.quotes.filter(function (x) { return x._i === i; })[0];
        if (q) editQuote(q);
      });
    });
    applyQuoteH();   // 换场次后条数变了，自适应高度要跟着重算
  }

  function renderTagPicks() {
    $('tagPicks').innerHTML = state.tags.map(function (t) {
      return '<span class="pick" data-t="' + esc(t) + '">' + esc(t) + '</span>';
    }).join('');
    Array.prototype.forEach.call($('tagPicks').children, function (el) {
      el.addEventListener('click', function () { toggleTag(el.getAttribute('data-t')); });
    });
  }
  function currentTags() {
    return $('f-tags').value.split(/[,，、\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function toggleTag(t) {
    var tags = currentTags();
    var i = tags.indexOf(t);
    if (i >= 0) tags.splice(i, 1); else tags.push(t);
    $('f-tags').value = tags.join(', ');
    syncPicks();
  }
  function syncPicks() {
    var cur = currentTags();
    Array.prototype.forEach.call($('tagPicks').children, function (el) {
      el.classList.toggle('on', cur.indexOf(el.getAttribute('data-t')) >= 0);
    });
  }

  function newQuote() {
    state.edit = null;
    state.sel = {};
    $('f-title').value = '';
    $('f-tags').value = '';
    $('f-scname').value = '';
    $('f-sctext').value = '';
    fitArea($('f-sctext'));
    setRefKind('sc');
    $('f-note').value = '';
    $('btn-delete').hidden = true;
    $('editStatus').textContent = '新建';
    Array.prototype.forEach.call($('recList').querySelectorAll('input'), function (c) { c.checked = false; });
    Array.prototype.forEach.call($('recList').querySelectorAll('.rec'), function (el) { el.classList.remove('on'); });
    syncPicks();
    renderPreview();
    renderQuoteList();
    syncCopyBtn();
  }

  function editQuote(q) {
    state.edit = q;
    state.sel = {};
    // 老条目没有 sel，用后端按时间戳推测出的 selDraft 先把勾选画出来；
    // 只有用户点保存才会落成真正的 sel
    var picked = (q.sel && q.sel.length) ? q.sel : (q.selDraft || []);
    picked.forEach(function (x) { state.sel[x.i] = true; });
    $('f-title').value = q.title || '';
    $('f-tags').value = (q.tags || [q.tag]).join(', ');
    // 老条目只有 sc；新条目可能是 dm。两者都读，回填时切到对应类型
    var ref = q.sc || q.dm || null;
    setRefKind(q.dm && !q.sc ? 'dm' : 'sc');
    $('f-scname').value = (ref && ref.name) || '';
    $('f-sctext').value = (ref && ref.text) || '';
    fitArea($('f-sctext'));
    $('f-note').value = q.note || '';
    $('btn-delete').hidden = false;
    var n = 0;
    state.quotes.forEach(function (x, k) { if (x._i === q._i) n = k + 1; });
    $('editStatus').textContent = '编辑 ' + (n || '?') + '/' + state.quotes.length +
      (picked === q.selDraft ? ' · 推测选段' : '');
    Array.prototype.forEach.call($('recList').querySelectorAll('.rec'), function (el) {
      var on = !!state.sel[Number(el.getAttribute('data-i'))];
      el.querySelector('input').checked = on;
      el.classList.toggle('on', on);
    });
    syncPicks();
    renderPreview();
    renderQuoteList();
    syncCopyBtn();
    // 载入一条已有摘录后，把逐字稿滚到选段首行，免得用户找不到勾在哪
    var first = Object.keys(state.sel).map(Number).sort(function (a, b) { return a - b; })[0];
    var row = first != null && $('recList').querySelector('[data-i="' + first + '"]');
    if (row) row.scrollIntoView({ block: 'center' });
  }

  function saveQuote() {
    var idx = selIndices();
    if (!idx.length) return toast('至少勾选一行', true);
    var tags = currentTags();
    if (!tags.length) return toast('至少填一个 tag', true);
    var data = {
      session: state.key, i: state.edit ? state.edit._i : null,
      title: $('f-title').value.trim(), tags: tags, note: $('f-note').value.trim(),
      sel: idx.map(function (i) { return { i: i, t: state.recs[i][0] }; })
    };
    // 引用只写当前选中的那种：从 SC 改成弹幕时，旧的 sc 字段会随整条 entry 重建而消失
    var ref = refValue();
    if (ref.name || ref.text) data[ref.kind] = { name: ref.name, text: ref.text };
    post('/api/quote', data).then(function (r) {
      toast('已保存，记得点「重建站点」才会进页面');
      // 后端回的是写入下标，新建和更新都用它定位，别猜「最后一条」
      return api('/api/session?key=' + encodeURIComponent(state.key)).then(function (d) {
        return { d: d, i: r.i };
      });
    }).then(function (res) {
      state.quotes = res.d.quotes;
      state.allQuotes = null;   // 库缓存作废，下次进摘录库重新拉
      renderRecs();
      var q = res.d.quotes.filter(function (x) { return x._i === res.i; })[0];
      if (q) editQuote(q); else newQuote();
      $('editStatus').textContent = '已保存 #' + (res.i + 1);
    }).catch(function (e) { toast(e.message, true); });
  }

  function loadExistingSelection() {
    if (!state.quotes.length) return toast('本场还没有摘录', true);
    editQuote(state.quotes[0]);
    toast('已载入第一条摘录的勾选');
  }

  // ---- 摘录库：全库浏览与跨场跳转 ----
  function renderLib() {
    var all = state.allQuotes || [];
    var f = ($('libSearch').value || '').trim().toLowerCase();
    var list = f ? all.filter(function (q) {
      var hay = [q.title, q.jp, q.zh, q.note, q.tag, (q.tags || []).join(' '), q.date].join(' ');
      return hay.toLowerCase().indexOf(f) >= 0;
    }) : all;
    list = list.slice().sort(function (a, b) {
      return (String(b.date || '') + String(b.t || '')).localeCompare(String(a.date || '') + String(a.t || ''));
    });
    $('libCount').textContent = list.length + ' / ' + all.length + ' 条';
    $('libList').innerHTML = list.map(function (q) {
      var title = q.title || (q.jp || '').split('\n')[0] || '(未命名)';
      return '<div class="librow" data-i="' + q._i + '">' +
        '<span class="ld">' + esc(q.date || '') + '</span>' +
        '<span class="lt">' + esc((q.t || '').slice(0, 5)) + '</span>' +
        '<span class="li" title="' + esc(title) + '">' + esc(title) + '</span>' +
        '<span class="lg">' + esc((q.tags || [q.tag]).filter(Boolean).join(' · ')) + '</span></div>';
    }).join('') || '<div class="qempty">没有匹配的摘录</div>';
    Array.prototype.forEach.call($('libList').querySelectorAll('.librow'), function (el) {
      el.addEventListener('click', function () {
        var i = Number(el.getAttribute('data-i'));
        var q = (state.allQuotes || []).filter(function (x) { return x._i === i; })[0];
        if (q) openQuote(q);
      });
    });
  }

  // 从库里点开一条：切到它所属场次，再载入表单
  function openQuote(q) {
    if (!q.session) return toast('这条摘录没匹配到任何场次，检查时间戳', true);
    showView('quote');
    var reveal = function () {
      var target = state.quotes.filter(function (x) { return x._i === q._i; })[0];
      if (target) editQuote(target);
      else toast('这条摘录不在该场次的范围内', true);
    };
    if (state.key === q.session) reveal();
    else loadSession(q.session, reveal);
  }

  // ---- 全局修正：全库搜索替换 ----
  // 命中列表里的「应用 / 全部替换」写的是 overrides.json（精确到某场某行）；
  // 页面下方「已存全局规则」才是 fixes_data.json，对所有场次包括以后的新场次生效。
  var sr = { q: '', repl: '', regex: false, case: false, scope: 'both', data: null,
             seq: 0, timer: null, sig: '', done: {} };

  function hlSpans(text, spans) {
    text = String(text == null ? '' : text);
    if (!spans || !spans.length) return esc(text);
    var out = '', p = 0;
    spans.forEach(function (s) {
      var a = Math.max(0, Math.min(s[0], text.length));
      var b = Math.max(a, Math.min(s[1], text.length));
      out += esc(text.slice(p, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>';
      p = b;
    });
    return out + esc(text.slice(p));
  }

  function srWhy() {
    var q = (sr.q || '').trim(), r = sr.repl || '';
    return '全库搜索替换：' + q + (r ? ' → ' + r : '（删除）');
  }

  function srRowHtml(r) {
    var done = !!sr.done[r.session + '#' + r.i];
    var parts = [];
    if (r.marks.jp && r.marks.jp.length) {
      parts.push('<span class="srline"><i class="srk">原</i>' + hlSpans(r.jp, r.marks.jp) + '</span>');
      parts.push('<span class="srline after"><i class="srk">改</i>' + esc(r.jp_after) + '</span>');
    }
    if (r.marks.zh && r.marks.zh.length) {
      parts.push('<span class="srline"><i class="srk alt">译</i>' + hlSpans(r.zh, r.marks.zh) + '</span>');
      parts.push('<span class="srline after"><i class="srk alt">改</i>' + esc(r.zh_after) + '</span>');
    }
    return '<div class="srrow' + (done ? ' done' : '') + '" data-s="' + esc(r.session) + '" data-i="' + r.i + '">' +
      '<span class="srpos">' + esc(String(r.t || '').slice(0, 8)) + '</span>' +
      '<span class="srbody">' + parts.join('') + '</span>' +
      '<button class="srapply"' + (done ? ' disabled' : '') + '>' + (done ? '已应用' : '应用') + '</button></div>';
  }

  function srRender() {
    var d = sr.data, stat = $('srStat'), box = $('srList'), all = $('sr-all');
    if (!d) {
      stat.textContent = '输入关键词开始搜索';
      stat.classList.remove('bad');
      box.innerHTML = '';
      all.disabled = true;
      all.textContent = '全部替换';
      return;
    }
    if (d.error) {
      stat.textContent = d.error;
      stat.classList.add('bad');
      box.innerHTML = '';
      all.disabled = true;
      return;
    }
    stat.classList.remove('bad');
    if (!d.rows_total) {
      stat.textContent = '没有命中';
      box.innerHTML = '<div class="cempty">没有匹配「' + esc(sr.q) + '」的逐字稿</div>';
      all.disabled = true;
      return;
    }
    stat.textContent = d.rows_total + ' 行 · ' + d.hits + ' 处 · ' + d.sessions + ' 场' +
      (d.truncated ? '（列表只给前 ' + d.rows.length + ' 行）' : '');
    all.disabled = false;
    all.textContent = d.truncated ? '替换前 ' + d.rows.length + ' 行' : '全部替换';

    var groups = [], cur = null;
    d.rows.forEach(function (r) {
      if (!cur || cur.key !== r.session) {
        cur = { key: r.session, date: r.date, start: r.start, rows: [] };
        groups.push(cur);
      }
      cur.rows.push(r);
    });
    box.innerHTML = groups.map(function (g) {
      return '<div class="srgrp"><span>' + esc(g.date || '') + ' · ' + esc(String(g.start || '').slice(0, 5)) +
        '</span><span>' + g.rows.length + ' 行</span></div>' +
        g.rows.map(srRowHtml).join('');
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('.srrow'), function (el) {
      var s = el.getAttribute('data-s'), i = Number(el.getAttribute('data-i'));
      var row = d.rows.filter(function (r) { return r.session === s && r.i === i; })[0];
      if (!row) return;
      el.querySelector('.srapply').onclick = function () { srApply([row], el.querySelector('.srapply')); };
    });
  }

  function srRun() {
    var q = $('sr-q').value || '';
    sr.repl = $('sr-r').value || '';
    sr.q = q;
    // 换搜索条件就是新任务，之前那轮的「已应用」标记作废
    var sig = [q, sr.repl, sr.regex ? 1 : 0, sr.case ? 1 : 0, sr.scope].join('\u0001');
    if (sig !== sr.sig) { sr.sig = sig; sr.done = {}; }
    if (!q.trim()) {
      sr.data = null;
      sr.seq += 1;
      srRender();
      return;
    }
    var seq = ++sr.seq;
    var keep = $('srList').scrollTop;
    post('/api/search', { q: q, repl: sr.repl, regex: sr.regex, case: sr.case, scope: sr.scope })
      .then(function (d) {
        if (seq !== sr.seq) return;      // 打字快时丢掉旧响应
        sr.data = d;
        srRender();
        $('srList').scrollTop = keep;
      })
      .catch(function (e) {
        if (seq !== sr.seq) return;
        sr.data = { error: e.message };
        srRender();
      });
  }

  function srDebounce() {
    clearTimeout(sr.timer);
    sr.timer = setTimeout(srRun, 320);
  }

  function srApply(rows, btn) {
    if (!rows.length) return;
    var old = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = '写入…'; }
    var items = rows.map(function (r) {
      return { session: r.session, i: r.i, jp: r.jp_after, zh: r.zh_after, why: srWhy() };
    });
    return post('/api/apply', { items: items }).then(function (d) {
      var done = d.applied || [];
      toast(done.length ? '已写入 ' + done.length + ' 行' + (d.skipped ? '，跳过 ' + d.skipped : '') : '没有变化');
      // 当前场次的逐字稿就地更新，勾选状态不用重新载入
      var mine = done.filter(function (a) { return a.session === state.key; });
      mine.forEach(function (a) {
        if (state.recs[a.i]) {
          state.recs[a.i][1] = a.entry.jp;
          state.recs[a.i][2] = a.entry.zh;
        }
        state.ov[a.i] = a.entry;
      });
      if (mine.length) renderRecs();
      rows.forEach(function (r) { sr.done[r.session + '#' + r.i] = 1; });
      srRun();
    }).catch(function (e) {
      toast(e.message, true);
      if (btn) { btn.disabled = false; btn.textContent = old; }
      throw e;
    });
  }

  async function srApplyAll() {
    var d = sr.data;
    if (!d || !d.rows || !d.rows.length) return;
    var todo = d.rows.filter(function (r) { return !sr.done[r.session + '#' + r.i]; });
    if (!todo.length) return toast('列表里的命中都已应用过');
    var msg = (sr.repl ? '把 ' : '删掉 ') + todo.length + ' 行里的命中处' +
      (sr.repl ? '替换成「' + sr.repl + '」' : '内容') + '？';
    if (d.truncated) msg += '\n\n结果超过上限，本次只处理列出的行；缩小范围再处理其余。';
    msg += '\n\n写入 site/data/overrides.json（逐行可还原），不动原始 DB。';
    if (!(await ask(msg, sr.repl ? '替换' : '删除'))) return;
    var btn = $('sr-all');
    btn.disabled = true;
    var txt = btn.textContent;
    btn.textContent = '替换中…';
    srApply(todo, null).then(function () {
      btn.disabled = false;
      btn.textContent = txt;
    }, function () {
      btn.disabled = false;
      btn.textContent = txt;
    });
  }

  // 已存的全局规则（fixes_data.json）
  function renderFixes() {
    $('fixCount').textContent = (B.fixes || []).length + ' 条';
    $('fixList').innerHTML = (B.fixes || []).map(function (f, i) {
      return '<div class="fixrow"><div class="body">' +
        '<div>' + esc(f.jp_bad || f.zh_bad) + ' → <b>' + esc(f.jp_good || f.zh_good) + '</b></div>' +
        '<div class="why">' + esc(f.why || '未写依据') + ' · ' + esc(f.session || '') + ' ' + esc(f.t || '') + '</div>' +
        '</div><button data-i="' + i + '">删除</button></div>';
    }).join('') || '<div class="fixrow">还没有编辑器新增的规则</div>';
    Array.prototype.forEach.call($('fixList').querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () {
        post('/api/fix', { action: 'delete', i: Number(b.getAttribute('data-i')) })
          .then(function (d) { B.fixes = d.fixes; renderFixes(); srRun(); toast('已删除'); })
          .catch(function (e) { toast(e.message, true); });
      });
    });
  }

  // ---- tag 管理 ----
  function renderTags() {
    var counts = {};
    (state.allQuotes || []).forEach(function (q) {
      (q.tags || [q.tag]).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    $('tagCount').textContent = state.tags.length + ' 个';
    $('tagList').innerHTML = state.tags.map(function (t) {
      return '<div class="tagrow"><b>' + esc(t) + '</b><span class="n">' + (counts[t] || 0) + ' 条</span>' +
        '<span class="ops"><button data-a="rename" data-t="' + esc(t) + '">改名</button>' +
        '<button data-a="merge" data-t="' + esc(t) + '">合并</button>' +
        '<button data-a="delete" data-t="' + esc(t) + '">删除</button></span></div>';
    }).join('');
    Array.prototype.forEach.call($('tagList').querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () { tagAction(b.getAttribute('data-a'), b.getAttribute('data-t')); });
    });
  }
  async function tagAction(act, old) {
    var val, action = act;
    if (act === 'merge') {
      var other = await askText('合并到哪个 tag？（填已有名称）',
        state.tags.filter(function (t) { return t !== old; })[0] || '', '合并');
      if (!other) return;
      action = 'merge'; val = other;
    } else if (act === 'rename') {
      val = await askText('改成什么名字？', old, '改名');
      if (!val) return;
    } else {
      // 前端先算引用数，让用户知道影响面再确认
      var used = (state.allQuotes || []).filter(function (q) {
        return (q.tags || [q.tag]).indexOf(old) >= 0;
      }).length;
      var msg = '删除 tag「' + old + '」？';
      if (used) msg += '\n有 ' + used + ' 条摘录在用它，这些摘录会摘掉这个标签。';
      if (!(await ask(msg, '删除'))) return;
      return post('/api/tag', { action: 'delete', name: old, force: true }).then(function (d) {
        state.tags = d.tags; renderTagPicks(); renderTags(); toast('已删除');
      }).catch(function (e) { toast(e.message, true); });
    }
    var body = { action: action, old: old, new: val };
    post('/api/tag', body).then(function (d) {
      state.tags = d.tags;
      renderTagPicks();
      renderTags();
      toast('已更新');
    }).catch(function (e) { toast(e.message, true); });
  }

  // 从手机增量拉 SC / 弹幕：手机端只读，本机只追加，重复执行不会翻倍
  function pullFromPhone() {
    var btn = $('ctxPull');
    if (btn.disabled) return;
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '拉取中…';
    post('/api/pull', {}).then(function (d) {
      toast('新增弹幕 ' + d.danmaku + ' 条 · SC ' + d.sc + ' 条（' + d.seconds + 's）');
      ctx.data = null;
      if (ctx.open) openCtx();
    }).catch(function (e) { toast(e.message, true); })
      .then(function () { btn.disabled = false; btn.textContent = label; });
  }

  // ---- 事件绑定 ----
  $('sess-expand').onclick = function () {
    closed = {};
    localStorage.setItem(SESS_CLOSED, '{}');
    renderSessions();
  };
  $('sess-collapse').onclick = function () {
    closed = {};
    (function walk(n) {
      n.children.forEach(function (c) { if (c.isFolder) { closed[c.path] = true; walk(c); } });
    })(sessTree());
    localStorage.setItem(SESS_CLOSED, JSON.stringify(closed));
    renderSessions();
  };
  $('q-new').onclick = newQuote;
  $('tab-quote').onclick = function () { showView('quote'); };
  $('tab-fix').onclick = function () { showView('fix'); };
  $('sr-q').oninput = srDebounce;
  $('sr-r').oninput = srDebounce;
  $('sr-q').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.isComposing) { clearTimeout(sr.timer); srRun(); }
  });
  $('sr-r').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.isComposing) { clearTimeout(sr.timer); srRun(); }
  });
  $('sr-case').onclick = function () {
    sr.case = !sr.case;
    this.classList.toggle('on', sr.case);
    if ($('sr-q').value.trim()) srRun();
  };
  $('sr-regex').onclick = function () {
    sr.regex = !sr.regex;
    this.classList.toggle('on', sr.regex);
    $('sr-r').placeholder = sr.regex ? '替换为…（正则，可用 $1 引用分组）' : '替换为…（字面量）';
    if ($('sr-q').value.trim()) srRun();
  };
  $('sr-scope').onchange = function () {
    sr.scope = this.value;
    if ($('sr-q').value.trim()) srRun();
  };
  $('sr-all').onclick = srApplyAll;
  $('tab-lib').onclick = function () {
    showView('lib');
    api('/api/quotes').then(function (d) { state.allQuotes = d.quotes; renderLib(); })
      .catch(function (e) { toast(e.message, true); });
  };
  $('libSearch').oninput = renderLib;
  $('tab-tag').onclick = function () {
    api('/api/quotes').then(function (d) {
      state.allQuotes = d.quotes;
      showView('tag');
    }).catch(function (e) { toast(e.message, true); });
  };
  $('btn-rebuild').onclick = async function () {
    if (!(await ask('重建会重跑导出与构建，覆盖 dist/。继续？', '重建'))) return;
    $('olog').textContent = '运行中…';
    $('overlay').hidden = false;
    post('/api/rebuild').then(function (d) { $('olog').textContent = d.log; })
      .catch(function (e) { $('olog').textContent = '失败：' + e.message; });
  };
  $('overlay').onclick = function () { $('overlay').hidden = true; };
  $('sel-all').onclick = function () {
    state.recs.forEach(function (_, i) { state.sel[i] = true; }); renderRecs();
    if (ctx.open) renderCtx(true);
  };
  $('sel-none').onclick = function () {
    state.sel = {}; renderRecs();
    if (ctx.open) renderCtx(true);
  };
  $('sel-existing').onclick = loadExistingSelection;
  $('btn-copy').onclick = copySelected;
  $('btn-find').onclick = openFind;
  $('findClose').onclick = function () { closeFind(); };
  var findTimer;
  $('findInput').oninput = function () {
    clearTimeout(findTimer);
    findTimer = setTimeout(function () { findRun(false); }, 120);
  };
  $('findInput').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // 词还没落定（防抖未到点）就先跑一遍停在第一处；词没变才是「跳下一个」
    if ($('findInput').value !== find.q) { findRun(false); return; }
    findMove(e.shiftKey ? -1 : 1);
  });
  $('findCase').onclick = function () {
    find.case = !find.case;
    this.classList.toggle('on', find.case);
    if (find.open) findRun(true);
  };
  $('findRegex').onclick = function () {
    find.regex = !find.regex;
    this.classList.toggle('on', find.regex);
    if (find.open) findRun(true);
  };
  $('findPrev').onclick = function () { findMove(-1); };
  $('findNext').onclick = function () { findMove(1); };
  $('f-tags').addEventListener('input', syncPicks);
  // SC / 弹幕两个字段随时同步到选段预览，改完就能在下面核对
  ['f-scname', 'f-sctext'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      if (id === 'f-sctext') fitArea(this);
      renderPreview();
    });
  });
  Array.prototype.forEach.call($('refKinds').children, function (b) {
    b.onclick = function () {
      setRefKind(b.getAttribute('data-k'));
      renderPreview();
    };
  });
  $('btn-save').onclick = saveQuote;
  $('btn-new').onclick = newQuote;
  $('btn-delete').onclick = async function () {
    if (!state.edit) return;
    var i = state.edit._i;    // 确认框开着时 state.edit 可能被改，先记住下标
    if (!(await ask('删除这条摘录？', '删除'))) return;
    // 连点两下会删掉相邻的两条，删一次就把按钮关掉等结果
    $('btn-delete').hidden = true;
    post('/api/quote/delete', { i: i }).then(function () {
      toast('已删除'); return loadSession(state.key);
    }).catch(function (e) { $('btn-delete').hidden = false; toast(e.message, true); });
  };
  $('btn-ctx').onclick = function () { ctx.open ? closeCtx() : openCtx(); };
  $('ctxSearch').oninput = function () {
    ctx.q = this.value || '';
    ctx.from = 0;
    renderCtx(true);
  };
  $('ctxPull').onclick = pullFromPhone;
  $('ov-save').onclick = saveOverride;
  $('ov-cancel').onclick = closeOverride;
  $('ovModal').onclick = function (e) { if (e.target === $('ovModal')) closeOverride(); };
  $('askOk').onclick = function () {
    var inp = $('askInput');
    if (inp.hidden) return closeAsk(true);
    var v = inp.value.trim();
    closeAsk(v || null);   // 空串按取消处理，跟原来的 prompt 口径一致
  };
  $('askCancel').onclick = function () { closeAsk(null); };
  $('askModal').onclick = function (e) { if (e.target === $('askModal')) closeAsk(null); };
  $('askInput').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    $('askOk').click();
  });
  $('ov-revert').onclick = function () {
    var i = state.ovEdit;
    if (i < 0) return;
    post('/api/override/delete', { session: state.key, i: i })
      .then(applyOverrideResult).catch(function (e) { toast(e.message, true); });
  };
  $('ctxClose').onclick = closeCtx;
  $('ctxJump').onclick = function () { renderCtx(true); };
  $('ctxPrev').onclick = function () { ctx.from -= CTX_PAGE; renderCtx(false); };
  $('ctxNext').onclick = function () { ctx.from += CTX_PAGE; renderCtx(false); };
  Array.prototype.forEach.call(document.querySelectorAll('.ctxseg button'), function (b) {
    b.onclick = function () {
      ctx.filter = b.getAttribute('data-k');
      Array.prototype.forEach.call(document.querySelectorAll('.ctxseg button'), function (o) {
        o.classList.toggle('on', o === b);
      });
      renderCtx(true);
    };
  });
  // Ctrl/Cmd+F：在逐字稿里搜索。焦点在别的输入框（标题、tag、抽屉搜索）时不抢，
  // 免得把用户正在写的字打断
  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (String(e.key).toLowerCase() !== 'f') return;
    if ($('view-quote').hidden) return;
    var t = e.target;
    if (t && t.id !== 'findInput' &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    openFind();
  });

  document.addEventListener('keydown', function (e) {
    if (!$('askModal').hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeAsk(null); }
      return;
    }
    if (e.key !== 'Escape') return;
    // 在查找框里按 Esc：先退搜索；在别处按 Esc：抽屉优先
    if (find.open && document.activeElement === $('findInput')) { closeFind(); return; }
    if (!$('ovModal').hidden) return closeOverride();
    if (ctx.open) closeCtx();
    else if (find.open) closeFind();
  });

  $('x-preview').onclick = function () {
    var bad = $('x-jpbad').value.trim() || $('x-zhbad').value.trim();
    if (!bad) return toast('先填原文', true);
    post('/api/fix/preview', { bad: bad }).then(function (d) {
      $('x-result').textContent = '命中 ' + d.hits + ' 处，涉及 ' + d.sessions + ' 场';
    }).catch(function (e) { $('x-result').textContent = e.message; });
  };
  $('x-save').onclick = function () {
    post('/api/fix', {
      jp_bad: $('x-jpbad').value.trim(), jp_good: $('x-jpgood').value.trim(),
      zh_bad: $('x-zhbad').value.trim(), zh_good: $('x-zhgood').value.trim(),
      why: $('x-why').value.trim(), session: state.key,
      t: selIndices().length ? state.recs[selIndices()[0]][0] : ''
    }).then(function (d) {
      B.fixes = d.fixes;
      ['x-jpbad', 'x-jpgood', 'x-zhbad', 'x-zhgood', 'x-why'].forEach(function (id) { $(id).value = ''; });
      $('x-result').textContent = '已保存，重建后生效';
      renderFixes();
    }).catch(function (e) { toast(e.message, true); });
  };
  $('t-add').onclick = function () {
    var name = $('t-new').value.trim();
    if (!name) return;
    post('/api/tag', { action: 'add', name: name }).then(function (d) {
      state.tags = d.tags; $('t-new').value = ''; renderTagPicks(); renderTags(); toast('已新增');
    }).catch(function (e) { toast(e.message, true); });
  };

  // 直链：#fix?q=神社&r=… 直接落到某个视图（顺手用来复现某一处）
  function applyRoute() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    if (!h) return;
    var parts = h.split('?'), view = parts[0], qs = {};
    (parts[1] || '').split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i > 0) qs[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
    });
    if (view === 'fix') {
      showView('fix');
      if (qs.r) $('sr-r').value = qs.r;
      if (qs.q) { $('sr-q').value = qs.q; srRun(); }
    } else if (view === 'lib' || view === 'tag' || view === 'quote') {
      showView(view);
    }
  }

  // ---- 栏宽可拖：写 CSS 变量，宽度存 localStorage ----
  // 只存「用户想要的宽度」，显示时再按窗口大小夹一遍；窗口变小时不覆盖用户的选择
  var COLW_KEY = 'lc-col-w';
  var colW = { side: 272, editor: 360, ctx: 460 };
  try {
    var savedW = JSON.parse(localStorage.getItem(COLW_KEY) || '{}') || {};
    ['side', 'editor', 'ctx'].forEach(function (k) {
      if (typeof savedW[k] === 'number' && savedW[k] > 0) colW[k] = savedW[k];
    });
  } catch (e) { /* 存坏了就用默认值 */ }

  var COL_MIN = { side: 180, editor: 300, ctx: 320 };
  var COL_MAX = { side: 560, editor: 760, ctx: 1100 };
  var TRANS_MIN = 240;   // 中间逐字稿永远至少留这么宽

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function layout() {
    var vq = $('view-quote');
    var avail = vq.clientWidth || document.documentElement.clientWidth;
    var ctxMax = Math.max(COL_MIN.ctx, window.innerWidth - 520);
    document.documentElement.style.setProperty('--ctx-w',
      clamp(colW.ctx, COL_MIN.ctx, Math.min(COL_MAX.ctx, ctxMax)) + 'px');

    var side = clamp(colW.side, COL_MIN.side, COL_MAX.side);
    side = Math.min(side, Math.max(COL_MIN.side, avail - COL_MIN.editor - TRANS_MIN));
    var ed = clamp(colW.editor, COL_MIN.editor, COL_MAX.editor);
    ed = Math.min(ed, Math.max(COL_MIN.editor, avail - side - TRANS_MIN));
    vq.style.setProperty('--side-w', side + 'px');
    vq.style.setProperty('--editor-w', ed + 'px');
    applyQuoteH();   // 右栏变矮时摘录面板跟着收，别把编辑表单挤没
  }

  function saveColW() {
    try { localStorage.setItem(COLW_KEY, JSON.stringify(colW)); } catch (e) {}
  }

  function bindRz(el, which) {
    var drag = null;
    // 用 pointer + setPointerCapture：鼠标拖到窗口外再松手也能收到 up，不会卡在拖动状态
    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var box = which === 'ctx' ? $('ctxDrawer')
        : which === 'side' ? document.querySelector('.side') : document.querySelector('.editor');
      drag = { x: e.clientX, w: box.getBoundingClientRect().width };
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器没有就算了 */ }
      el.classList.add('on');
      document.body.classList.add('rz-drag');
    });

    el.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x;
      var avail = $('view-quote').clientWidth || document.documentElement.clientWidth;
      if (which === 'ctx') {
        colW.ctx = clamp(drag.w - dx, COL_MIN.ctx,
          Math.min(COL_MAX.ctx, Math.max(COL_MIN.ctx, window.innerWidth - 520)));
      } else if (which === 'side') {
        colW.side = clamp(drag.w + dx, COL_MIN.side,
          Math.min(COL_MAX.side, Math.max(COL_MIN.side, avail - colW.editor - TRANS_MIN)));
      } else {
        colW.editor = clamp(drag.w - dx, COL_MIN.editor,
          Math.min(COL_MAX.editor, Math.max(COL_MIN.editor, avail - colW.side - TRANS_MIN)));
      }
      layout();
    });

    function endDrag() {
      if (!drag) return;
      drag = null;
      el.classList.remove('on');
      document.body.classList.remove('rz-drag');
      saveColW();
    }
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('lostpointercapture', endDrag);

    // 双击回到默认宽度
    el.addEventListener('dblclick', function () {
      colW[which] = which === 'editor' ? 360 : which === 'ctx' ? 460 : 272;
      layout();
      saveColW();
    });
  }

  // ---- 右栏「本场摘录」面板的高度：上下拖，存 lc-quote-h ----
  // null = 还没手动调过，按条数自适应；拖过之后就按用户的高度来
  var QH_KEY = 'lc-quote-h';
  var quoteH = null;
  try {
    var qhSaved = Number(localStorage.getItem(QH_KEY));
    if (qhSaved > 0) quoteH = qhSaved;
  } catch (e) { /* 存坏了用自适应 */ }

  // 上限：给下面的编辑表单留 240px，窗口矮的时候按实际高度算
  function quoteMax() {
    return Math.max(90, (document.querySelector('.editor').clientHeight || 600) - 240);
  }

  // 按内容估高度：标题行 + 每条 26px 左右，最多 420
  function quoteFit() {
    var head = document.querySelector('#pane-quote .pane-head');
    var hh = head ? head.offsetHeight : 24;
    var list = $('qList');
    var rows = list ? list.children.length : 0;
    if (!rows) return hh + 34;
    var rh = list.firstElementChild ? list.firstElementChild.offsetHeight : 27;
    return clamp(hh + rows * rh + 2, 90, Math.min(420, quoteMax()));
  }

  function applyQuoteH() {
    var h = quoteH == null ? quoteFit() : clamp(quoteH, 90, Math.min(quoteMax(), 640));
    document.querySelector('.editor').style.setProperty('--quote-h', h + 'px');
  }

  function bindRzV(el) {
    var drag = null;
    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      drag = { y: e.clientY, h: $('pane-quote').getBoundingClientRect().height };
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 没有就算了 */ }
      el.classList.add('on');
      document.body.classList.add('rz-drag-h');
    });
    el.addEventListener('pointermove', function (e) {
      if (!drag) return;
      // 往下拖就是变高；只改显示值，不动编辑区
      quoteH = clamp(drag.h + (e.clientY - drag.y), 90, Math.min(quoteMax(), 640));
      applyQuoteH();
    });
    function endDrag() {
      if (!drag) return;
      drag = null;
      el.classList.remove('on');
      document.body.classList.remove('rz-drag-h');
      try { localStorage.setItem(QH_KEY, String(Math.round(quoteH))); } catch (e) {}
    }
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('lostpointercapture', endDrag);
    // 双击忘掉手动高度，回到按内容自适应
    el.addEventListener('dblclick', function () {
      quoteH = null;
      try { localStorage.removeItem(QH_KEY); } catch (e) {}
      applyQuoteH();
    });
  }

  bindRz(document.querySelector('.rz[data-rz="side"]'), 'side');
  bindRz(document.querySelector('.rz[data-rz="editor"]'), 'editor');
  bindRz($('ctxRz'), 'ctx');
  bindRzV($('qRz'));
  layout();
  window.addEventListener('resize', layout);

  srRender();
  applyRoute();
  boot();
})();
