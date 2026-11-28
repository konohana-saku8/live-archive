(function () {
  'use strict';

  var D = window.DATA;
  var app = document.getElementById('app');

  /* ---------- 按需数据 ----------
     逐字稿按场次拆进 records/<key>.json；摘录全量在 quotes.json；日记正文在
     diary/<key>.json。data.js 只留场次表、日记索引与首页要用的几句摘录，
     所以首页的体积不随场次 / 摘录条数增长。内容不变时 URL 上的 ?v= 也不变，
     可以放心吃长缓存。 */
  var RC = { sess: {}, inflight: {}, all: null, allInflight: null, onStep: null, done: 0, total: 0 };

  function chunkURL(sid) {
    var s = D.sessions[sid];
    var name = (s && (s.chunk || s.key)) || '';
    var v = (D.meta && D.meta.recVer) || '';
    return 'records/' + encodeURIComponent(name) + '.json' + (v ? '?v=' + v : '');
  }

  // 片内每条是 [t, jp, zh, tp]：s 在单场文件里恒定，键名也是每行重复一遍，
  // 省掉后体积约小四分之一。读进来补回对象形态，后面渲染仍按 r.t / r.jp 取。
  function hydrate(sid, rows) {
    var out = new Array(rows.length);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      out[i] = { s: sid, t: r[0], jp: r[1], zh: r[2], tp: r[3] };
    }
    return out;
  }

  function loadSession(sid) {
    if (RC.sess[sid]) return Promise.resolve(RC.sess[sid]);
    if (RC.inflight[sid]) return RC.inflight[sid];
    var p = fetch(chunkURL(sid), { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (rows) {
        RC.sess[sid] = hydrate(sid, rows || []);
        delete RC.inflight[sid];
        return RC.sess[sid];
      })
      .catch(function (err) {
        delete RC.inflight[sid];
        throw err;
      });
    RC.inflight[sid] = p;
    return p;
  }

  // 全库：按场次并发拉，每完成一片回调一次进度，搜索面板拿它做「边拉边出结果」。
  // 单场失败不拖累整体——结果里少这一场，好过整个面板报错。
  function loadAll(onStep) {
    if (onStep) RC.onStep = onStep;
    if (RC.all) { if (RC.onStep) RC.onStep(1, 1); return Promise.resolve(RC.all); }
    if (RC.allInflight) return RC.allInflight;
    var ids = D.sessions.map(function (s) { return s.id; });
    RC.done = 0;
    RC.total = ids.length;
    RC.allInflight = Promise.all(ids.map(function (sid) {
      // 单场失败按空片处理，顺序仍与 D.sessions 对齐
      return loadSession(sid).catch(function () { return []; }).then(function (rows) {
        RC.done++;
        if (RC.onStep) RC.onStep(RC.done, RC.total);
        return rows;
      });
    })).then(function (groups) {
      var all = [], i, j;
      for (i = 0; i < groups.length; i++) {
        for (j = 0; j < groups[i].length; j++) all.push(groups[i][j]);
      }
      RC.all = all;
      RC.allInflight = null;
      return all;
    });
    return RC.allInflight;
  }

  // 全站搜索是本文件末尾的另一个 IIFE，共用同一份分片缓存与加载器
  RC.load = loadSession;
  RC.loadAll = loadAll;

  /* ---------- 摘录与日记正文 ----------
     这两块不进 data.js：摘录页 / 时间线 / 搜索才要摘录，
     日记详情才要正文。取到后挂回 D.quotes 与日记条目上，后续渲染仍按原字段取。 */
  var AQ = { rows: null, inflight: null, failed: false };
  var AD = { all: false, allInflight: null, inflight: {} };

  function loadQuotes() {
    if (AQ.rows) return Promise.resolve(AQ.rows);
    if (AQ.inflight) return AQ.inflight;
    var v = (D.meta && D.meta.quotesVer) || '';
    AQ.inflight = fetch('quotes.json' + (v ? '?v=' + v : ''), { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (rows) {
        AQ.rows = rows || [];
        // 摘录正文只存 lines（逐字稿原条目）；jp/zh 由它拼出，供搜索、复制、卡片共用
        AQ.rows.forEach(function (q) {
          if (!q.lines) return;
          q.jp = q.lines.map(function (l) { return l.jp; }).join('\n');
          q.zh = q.lines.map(function (l) { return l.zh; }).join('\n');
        });
        AQ.failed = false;
        D.quotes = AQ.rows;
        AQ.inflight = null;
        return AQ.rows;
      })
      .catch(function (err) {
        AQ.failed = true;
        AQ.inflight = null;
        throw err;
      });
    return AQ.inflight;
  }

  // 节奏页：整场逐字稿 + SC + 弹幕按节拍对应，只在打开这一页时取
  var AR = { rows: null, inflight: null, failed: false };
  function loadRhythm() {
    if (AR.rows) return Promise.resolve(AR.rows);
    if (AR.inflight) return AR.inflight;
    var v = (D.meta && D.meta.rhythmVer) || '';
    AR.inflight = fetch('rhythm.json' + (v ? '?v=' + v : ''), { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (blob) {
        AR.rows = blob || null;
        AR.failed = false;
        AR.inflight = null;
        return AR.rows;
      })
      .catch(function (err) {
        AR.failed = true;
        AR.inflight = null;
        throw err;
      });
    return AR.inflight;
  }

  function loadDiaryBody(d) {
    if (!d || d.body) return Promise.resolve(d);
    var key = d.key;
    if (AD.inflight[key]) return AD.inflight[key];
    var v = (D.meta && D.meta.diaryVer) || '';
    AD.inflight[key] = fetch('diary/' + encodeURIComponent(key) + '.json' + (v ? '?v=' + v : ''),
                             { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (blob) {
        d.body = (blob && blob.body) || [];
        d.names = (blob && blob.names) || [];
        d.scNames = (blob && blob.scNames) || [];
        d.dmNames = (blob && blob.dmNames) || [];
        delete AD.inflight[key];
        return d;
      })
      .catch(function (err) {
        delete AD.inflight[key];
        throw err;
      });
    return AD.inflight[key];
  }

  // 搜索要翻正文，只有它需要全部日记；单篇失败按空正文处理，不拖累整体
  function loadAllDiary() {
    if (AD.all) return Promise.resolve();
    if (AD.allInflight) return AD.allInflight;
    AD.allInflight = Promise.all((D.diary || []).map(function (d) {
      return loadDiaryBody(d).catch(function () {});
    })).then(function () {
      AD.all = true;
      AD.allInflight = null;
    });
    return AD.allInflight;
  }

  RC.loadQuotes = loadQuotes;
  RC.loadDiaryBody = loadDiaryBody;
  RC.loadAllDiary = loadAllDiary;
  RC.quotesReady = function () { return !!AQ.rows; };
  RC.quotesFailed = function () { return AQ.failed; };
  RC.diaryReady = function () { return AD.all; };
  window.LARC = RC;

  // 异步页面完成后，若已经换页就不再落地（见各 render 里的 tok 判断）
  var pageTok = 0;

  // 异步页面的占位：标题骨架 + 一行说明，数据到了再整页重画
  function loadingPage(kicker, title, note) {
    app.innerHTML =
      '<section class="hero hero-sm"><div class="hero-copy">' +
        '<div class="kicker">' + kicker + '</div><h1>' + title + '</h1>' +
        '<p class="lead">' + (note || '正在载入…') + '</p>' +
      '</div></section>' +
      '<div class="td-loading">正在载入…</div>';
    setFoot();
  }

  // 懒加载失败时的兜底文案，避免停在占位页
  function failPage(text) {
    app.innerHTML = '<div class="empty">' + text + '</div>';
    setFoot();
  }

  var state = { q: '', hideEmpty: false, scOnly: false, tag: '全部', qs: 'all', qShown: 0, dpage: 1, spage: 1, counted: false,
    tlKind: 'all', learn: false, rhFilter: 'all', rhShown: 6, rh: '' };
  var QBATCH = 12;   // 摘录每次渲染的条数
  var DPAGE = 4;     // 日记每页篇数
  var SPAGE = 6;     // 首页「全部场次」每页场数

  // 时间轴 / 逐字稿的瞬时交互（定时器、滚动监听）挂在同一个对象上，
  // 切场次或换路由时统一 destroy，避免旧定时器操作已经不存在的 DOM。
  var live = { timer: 0, onScroll: 0, reading: null };
  function stopLive() {
    if (live.timer) { clearInterval(live.timer); live.timer = 0; }
    if (live.onScroll) { window.removeEventListener('scroll', live.onScroll); live.onScroll = 0; }
    live.reading = null;
    // 跟稿播放条是 fixed 浮层，只在逐字稿页存在；离开时把预留的底部空间一并撤掉
    document.body.classList.remove('has-player');
    var dock = document.getElementById('playerDock');
    if (dock) dock.innerHTML = '';
  }

  // HH:MM[:SS] → 当天秒数；跨零点场次由调用方用 startH 决定要不要 +86400
  function hmsSec(t) { var p = String(t).split(':'); return (+p[0]) * 3600 + (+p[1]) * 60 + (+(p[2] || 0)); }
  function sessionSec(t, startH) {
    var s = hmsSec(t);
    return (startH >= 12 && s < 12 * 3600) ? s + 86400 : s;
  }
  // 让目标条停在吸顶导航下方，而不是被它盖住
  function topPad() {
    var top = document.querySelector('.top');
    return (top ? top.offsetHeight : 62) + 20;
  }

  /* ---------- utils ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // 日记正文里的观众名只做轻排版：先转义整段，再把名单里的名字包成 .dname。
  // SC 与弹幕分别用 .dname-sc / .dname-dm；旧日记没有分类，继续用中性 .dname。
  function diaryText(text, d) {
    var s = esc(text);
    var byName = {};
    ((d && d.names) || []).forEach(function (n) { if (n) byName[n] = ['', '']; });
    ((d && d.scNames) || []).forEach(function (n) { if (n) byName[n] = [' dname-sc', 'SC']; });
    ((d && d.dmNames) || []).forEach(function (n) { if (n) byName[n] = [' dname-dm', '弹幕']; });
    var names = Object.keys(byName);
    if (!names.length) return s;
    var used = [], spans = [];
    names.sort(function (a, b) { return b.length - a.length; }).forEach(function (name) {
      var needle = esc(name), mark = byName[name];
      if (!needle) return;
      var from = 0, idx;
      while ((idx = s.indexOf(needle, from)) !== -1) {
        var end = idx + needle.length;
        var overlap = used.some(function (r) { return idx < r[1] && end > r[0]; });
        if (!overlap) {
          spans.push([idx, end, needle, mark[0], mark[1]]);
          used.push([idx, end]);
        }
        from = idx + needle.length;
      }
    });
    spans.sort(function (a, b) { return a[0] - b[0]; });
    var out = '', pos = 0;
    spans.forEach(function (sp) {
      var title = sp[4] ? ' title="' + sp[4] + '"' : '';
      out += s.slice(pos, sp[0]) + '<span class="dname' + sp[3] + '"' + title + '>' + sp[2] + '</span>';
      pos = sp[1];
    });
    return out + s.slice(pos);
  }
  function num(n) { return n.toLocaleString('en-US'); }
  function tname(i) { return D.topics[i] ? D.topics[i][0] : '杂聊'; }
  function tcolor(i) { return D.topics[i] ? D.topics[i][1] : '#4a4f5e'; }
  function sess(id) { return D.sessions[id]; }
  function dateLabel(s) { return s.date.replace('-', '.') + ' ' + s.week; }

  // 摘录标签不设白名单，按内容自由增加；颜色从名称做稳定 hash，
  // 同一个标签在任何页面、任何一次构建里都是同一个颜色。
  var TAG_PALETTE = ['#ffa172', '#e8c489', '#f49a8c', '#f0bd8e', '#dd8f6e',
                     '#e5a9a0', '#d9b06a', '#f2a98f', '#c9b28e', '#e6a07a'];
  function tagColor(t) {
    var h = 0, s = String(t || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return TAG_PALETTE[h % TAG_PALETTE.length];
  }
  function tagStyle(t) { return ' style="--tagc:' + tagColor(t) + '"'; }
  // 一条摘录可以挂多个 tag；老数据只有 tag，取一下并集即可。
  function qTags(q) { return q.tags && q.tags.length ? q.tags : [q.tag].filter(Boolean); }

  /* 页脚元信息：built 是这次构建的时刻（由 tools/build.py 写入），generated 是
     数据截止到的那一场结束时间。两者都有就都显示——只写「更新于」容易让人以为
     那一分钟刚开过播。 */
  function setFoot() {
    var m = D.meta;
    var text = '更新于 ' + (m.built || m.generated);
    if (m.built && m.generated && m.built !== m.generated) {
      text += ' · 数据截至 ' + m.generated;
    }
    document.getElementById('footMeta').textContent = text;
  }

  /* ---------- 进场：淡入与数字滚动 ---------- */
  var quiet = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var canObserve = typeof IntersectionObserver === 'function';
  var revealIO = null;

  // 给带 .rv 的元素在进入视口时补 .in（CSS 里负责淡入上移）
  function playReveal() {
    var els = app.querySelectorAll('.rv');
    if (quiet || !canObserve) {
      for (var i = 0; i < els.length; i++) els[i].classList.add('in');
      return;
    }
    if (revealIO) revealIO.disconnect();
    revealIO = new IntersectionObserver(function (list) {
      list.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('in');
        revealIO.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.04 });
    for (var j = 0; j < els.length; j++) revealIO.observe(els[j]);
  }

  // 统计数字从 0 滚到目标值；翻页重渲染时不重复播
  function countUp() {
    var els = app.querySelectorAll('.cv');
    for (var i = 0; i < els.length; i++) {
      (function (el) {
        var to = parseInt(el.getAttribute('data-n'), 10) || 0;
        if (quiet) { el.textContent = num(to); return; }
        var t0 = 0;
        function step(ts) {
          if (!t0) t0 = ts;
          var p = Math.min(1, (ts - t0) / 850);
          var k = 1 - Math.pow(1 - p, 3);          // easeOutCubic
          el.textContent = num(Math.round(to * k));
          if (p < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      })(els[i]);
    }
  }

  // 页码条：第 n 页 / 共 m 页 · 共 total 条
  function pagerHTML(page, pages, total, unit) {
    if (pages <= 1) return '';
    var nums = [];
    for (var i = 1; i <= pages; i++) {
      nums.push('<button data-p="' + i + '"' + (i === page ? ' class="on"' : '') + '>' + i + '</button>');
    }
    return '<div class="pager">' +
      '<button data-p="' + (page - 1) + '"' + (page === 1 ? ' disabled' : '') + '>← 上一页</button>' +
      nums.join('') +
      '<button data-p="' + (page + 1) + '"' + (page === pages ? ' disabled' : '') + '>下一页 →</button>' +
      '<span class="pinfo">第 ' + page + ' / ' + pages + ' 页 · 共 ' + total + ' ' + unit + '</span>' +
    '</div>';
  }

  // 绑定翻页后回到锚点，避免重新渲染把用户甩回页顶
  function bindPager(onPick, anchorId) {
    var pager = app.querySelector('.pager');
    if (!pager) return;
    pager.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || b.disabled) return;
      var n = parseInt(b.getAttribute('data-p'), 10);
      if (!n) return;
      onPick(n);
      var el = document.getElementById(anchorId);
      if (!el) return;
      var y = el.getBoundingClientRect().top + window.pageYOffset - 110;
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    });
  }

  function mark(text, q) {
    var safe = esc(text);
    if (!q) return safe;
    try {
      var re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      return safe.replace(re, '<mark>$1</mark>');
    } catch (e) { return safe; }
  }

  /* ---------- 存档日历索引 ----------
     用 dateLong 建索引：同一天可能开两场（白天场 + 深夜场），不能按日期一对一。
     月份只保留「有场次的月」，翻月就在这些月份之间跳，不会翻出空月。 */
  function dayKey(s) { return s.dateLong.replace(/\./g, '-'); }   // 2026.11.15 → 2026-11-15
  var byDay = {}, dayKeys = [], monthKeys = [];
  D.sessions.forEach(function (s) {
    var k = dayKey(s);
    if (!byDay[k]) { byDay[k] = []; dayKeys.push(k); }
    byDay[k].push(s);
  });
  dayKeys.sort();
  dayKeys.forEach(function (k) {
    var m = k.slice(0, 7);
    if (monthKeys.indexOf(m) < 0) monthKeys.push(m);
  });

  function monthLabel(m) { var p = m.split('-'); return p[0] + ' 年 ' + (+p[1]) + ' 月'; }
  function pad2(n) { return String(n).padStart(2, '0'); }

  /* ---------- router ---------- */
  function parseHash() {
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('?');
    var seg = parts[0].split('/').filter(Boolean);
    var query = {};
    if (parts[1]) {
      parts[1].split('&').forEach(function (kv) {
        var p = kv.split('=');
        query[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
      });
    }
    return {
      view: seg[0] || 'home',
      // 第二段原样保留：存档用数字 id，日记用场次文件名（2026-11-11_0904）
      seg1: seg[1] != null ? decodeURIComponent(seg[1]) : null,
      sid: seg[1] != null ? parseInt(seg[1], 10) : null,
      q: query
    };
  }

  function setNav(view) {
    document.querySelectorAll('.nav a').forEach(function (a) {
      a.classList.toggle('on', a.getAttribute('data-nav') === view);
    });
    // 首页换一张专属夜景，离开首页立刻切回原插画
    document.body.classList.toggle('is-home', view === 'home');
  }

  // 逐字稿页随所选场次的开播时段切场景：凌晨档配夜景，其余用默认插画。
  // 只在存档页生效，离开时由 route 统一清除，避免残留到别的栏目。
  function setNightScene(on) { document.body.classList.toggle('is-night', !!on); }

  function route() {
    pageTok++;                  // 之前的异步载入完成后不再落地到新页面
    stopLive();                 // 清掉上一页的时间轴定时器与滚动监听
    setNightScene(false);
    updateProgress();
    var r = parseHash();
    state.q = '';
    state.hideEmpty = false;
    state.scOnly = false;
    if (r.view === 'quotes') { setNav('quotes'); renderQuotes(); }
    else if (r.view === 'rhythm') { setNav('rhythm'); renderRhythm(); }
    else if (r.view === 'timeline') { setNav('timeline'); renderTimeline(); }
    // 存档只有一个页面：日历选日 → 选场次 → 同页展开逐字稿
    else if (r.view === 'archive') {
      setNav('archive');
      renderArchivePage({
        month: r.q.m || '', day: r.q.d || '', sid: r.sid,
        jumpT: r.q.t, initialQ: r.q.q || ''
      });
    }
    else if (r.view === 'diary') { setNav('diary'); renderDiary(r.seg1); }
    // 旧链接引导到仍存在的栏目，别静悄悄回首页：
    // 动态并进日记，问答并进摘录，主题入口已撤掉。
    else if (r.view === 'dynamics') { location.replace('#/diary'); return; }
    else if (r.view === 'qa') { location.replace('#/quotes'); return; }
    else if (r.view === 'topics') { location.replace('#/'); return; }
    else if (r.view === 'about') { setNav('about'); renderAbout(); }
    else { setNav('home'); renderHome(); }
    window.scrollTo(0, 0);
    playPageIn();
    updateProgress();
  }

  // 换页时整块内容做一次极短的淡入（prefers-reduced-motion 下跳过）
  function playPageIn() {
    if (quiet || !app.animate) return;
    app.classList.remove('page-in');
    void app.offsetWidth;                       // 强制回流，让动画能重新触发
    app.classList.add('page-in');
  }

  // 阅读进度条：整页滚动比例映射到顶端细线的宽度
  var progEl = document.getElementById('readprog');
  function updateProgress() {
    if (!progEl) return;
    var h = document.documentElement.scrollHeight - window.innerHeight;
    var p = h > 0 ? Math.min(1, Math.max(0, window.pageYOffset / h)) : 0;
    progEl.firstElementChild.style.transform = 'scaleX(' + p.toFixed(4) + ')';
    progEl.classList.toggle('on', window.pageYOffset > 40);
  }
  window.addEventListener('scroll', updateProgress, { passive: true });
  window.addEventListener('resize', updateProgress, { passive: true });
  window.addEventListener('hashchange', route);

  window.addEventListener('keydown', function (e) {
    if (e.key !== '/' || e.metaKey || e.ctrlKey) return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|TEXTAREA/.test(tag)) return;
    var el = document.getElementById('q');
    if (el) { e.preventDefault(); el.focus(); }
  });

  /* ---------- home ---------- */
  // 把一场压成一条连续色带：横轴是这一场的时长，颜色是当分钟的话题。
  // 连续同色的分钟先并成一块，否则整条是碎噪点。
  function stripHTML(s) {
    var rb = s.ribbon, n = rb.length;
    if (!n) return '';
    var blocks = [], i = 0;
    while (i < n) {
      var j = i;
      while (j + 1 < n && rb[j + 1] === rb[i]) j++;
      blocks.push({ from: i, to: j, tp: rb[i] });
      i = j + 1;
    }
    return blocks.map(function (b) {
      var left = b.from / n * 100, w = (b.to - b.from + 1) / n * 100;
      var col = b.tp < 0 ? '#1c1815' : tcolor(b.tp);
      return '<i style="left:' + left.toFixed(2) + '%;width:' + w.toFixed(2) + '%;background:' + col +
        '" title="' + (b.tp < 0 ? '无记录' : esc(tname(b.tp))) + '"></i>';
    }).join('');
  }

  // 开播热力图：按周排列的方格，颜色深浅表示那天开了几场。
  // 只画最近 16 周，覆盖当前存档跨度；格子上带标题并链到对应日期的存档页。
  function heatmapHTML() {
    var weeks = 16, cell = 0;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    // 定位到本周周一
    var mon = new Date(today);
    mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
    mon.setDate(mon.getDate() - (weeks - 1) * 7);

    var cols = [];
    for (var w = 0; w < weeks; w++) {
      var days = [];
      for (var d = 0; d < 7; d++) {
        var dt = new Date(mon);
        dt.setDate(mon.getDate() + w * 7 + d);
        var key = dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
        var n = byDay[key] ? byDay[key].length : 0;
        var future = dt > today;
        var lv = n >= 2 ? 3 : n === 1 ? 2 : 0;
        var label = key + ' · ' + (n ? n + ' 场直播' : '没有直播');
        days.push('<a class="hm-cell lv' + lv + (future ? ' future' : '') + '"' +
          (n ? ' href="#/archive?d=' + key + '"' : '') +
          ' title="' + label + '" aria-label="' + label + '"></a>');
        cell++;
      }
      cols.push('<div class="hm-col">' + days.join('') + '</div>');
    }
    var total = D.sessions.length;
    return '<div class="hm">' +
      '<div class="hm-head"><div><b>开播日历</b><span>最近 ' + weeks + ' 周 · 共 ' + total + ' 场</span></div>' +
        '<div class="hm-legend"><i class="lv0"></i><i class="lv1"></i><i class="lv2"></i><i class="lv3"></i><span>少 → 多</span></div></div>' +
      '<div class="hm-grid">' + cols.join('') + '</div>' +
      '<div class="hm-dow"><span>一</span><span>三</span><span>五</span><span>日</span></div>' +
    '</div>';
  }

  function renderHome() {
    var last = D.sessions[D.sessions.length - 1];
    // 首屏只带构建期挑好的几句：最近一场的三条 + 随机引文池，不再筛全量摘录
    var lastQuotes = (D.home && D.home.latest) || [];
    var latestDiary = (D.diary && D.diary.length) ? D.diary[0] : null;

    // 全部场次（新的在前）按每页 SPAGE 场分页
    var allSessions = D.sessions.slice().reverse();
    var spages = Math.max(1, Math.ceil(allSessions.length / SPAGE));
    if (state.spage < 1 || state.spage > spages) state.spage = 1;
    var sfrom = (state.spage - 1) * SPAGE;

    var mini = lastQuotes.map(function (q) {
      // 摘录是整段对话，首页只摘要她自己的那句：去掉开头的观众提问，再截断
      var lines = q.zh.split('\n').filter(function (l, i) {
        return !(i === 0 && l.charAt(0) === '「');
      });
      var txt = lines.join(' ').replace(/^——/, '');
      if (txt.length > 92) txt = txt.slice(0, 92).replace(/[，、]$/, '') + '…';
      return '<a class="qmini" href="#/archive/' + q.s + '?t=' + encodeURIComponent(q.t) + '">' +
        '<p>' + esc(txt) + '</p><span>' + esc(q.t) + ' →</span></a>';
    }).join('');

    // 每次打开随机一句：池子在构建期按时间均匀取样，条数固定，不随摘录总数变重
    var dq = (function () {
      var pool = (D.home && D.home.pool) || [];
      if (!pool.length) return null;
      return pool[Math.floor(Math.random() * pool.length)];
    })();
    // 摘录常按语音停顿断成多行、每行行首带「——」；直接 join 会连出「————」，
    // 这里剥掉行首行尾的破折号，同一处停顿只在行间补回一个
    var dqText = dq ? dq.zh.split('\n')
      .filter(function (l) { return l.charAt(0) !== '「'; })
      .map(function (l) { return l.replace(/^\s*——\s*/, '').replace(/\s*——\s*$/, '').trim(); })
      .filter(Boolean)
      .join('——') : '';

    // 首屏已经滚完数字就不再重播
    function cv(n) { return '<span class="cv" data-n="' + n + '">' + (state.counted ? num(n) : '0') + '</span>'; }

    app.innerHTML =
      '<section class="hero">' +
        // 主播入口放在首屏最上面：想看现场、想核对记录，第一眼就能出去
        // 直播间块用直播封面，主页块用主播头像，不再额外写一行说明
        '<div class="hero-links">' +
          '<a class="hl live" href="https://live.bilibili.com/22748536" target="_blank" rel="noopener">' +
            '<img class="thumb" src="brand/live-cover.jpg" alt="" width="116" height="65" decoding="async">' +
            '<span class="hl-cap"><b><i class="hl-dot" aria-hidden="true"></i>直播间</b>' +
              '<em>live.bilibili.com/22748536</em></span>' +
            '<i class="hl-arrow" aria-hidden="true">↗</i></a>' +
          '<a class="hl" href="https://space.bilibili.com/2094031249" target="_blank" rel="noopener"' +
            ' title="' + esc(D.meta.streamer) + ' · B 站主页">' +
            '<img class="thumb round" src="brand/face.jpg" alt="' + esc(D.meta.streamer) + '"' +
            ' width="52" height="52" decoding="async">' +
            '<span class="hl-cap"><b>主页</b><em>space.bilibili.com/2094031249</em></span>' +
            '<i class="hl-arrow" aria-hidden="true">↗</i></a>' +
        '</div>' +
        '<div class="hero-copy">' +
          '<div class="kicker">LIVE TRANSCRIPT ARCHIVE</div>' +
          '<h1><span class="accent">' + esc(D.meta.streamer) + '</span><span class="thin">的</span>深夜<span class="thin">。</span></h1>' +
          '<p class="lead">' + D.meta.sessionCount + ' 场直播的逐字稿，从 <b>' + D.meta.firstDate + '</b> 到 <b>' + D.meta.lastDate +
          '</b>，共 ' + num(D.meta.total) + ' 条。内容包括夜间杂谈、SC 回应、问答与科普段落；' +
          '全部中日对照，可按场次浏览，也可全文检索。</p>' +
          '<div class="stats">' +
            '<div class="stat"><b>' + cv(D.meta.sessionCount) + '<i>场</i></b><span>直播记录</span></div>' +
            '<div class="stat"><b>' + cv(D.meta.total) + '<i>条</i></b><span>逐字记录</span></div>' +
            '<div class="stat"><b>' + cv(D.meta.quoteCount) + '<i>段</i></b><span>摘录段落</span></div>' +
            '<div class="stat"><b>' + cv(D.topics.length) + '<i>类</i></b><span>话题标签</span></div>' +
          '</div>' +
          '<div class="hero-cta">' +
            '<a class="btn primary" href="#/quotes">读摘录 →</a>' +
            '<a class="btn" href="#/archive">进存档</a>' +
          '</div>' +
        '</div>' +

        // 首屏收在一段大引言上：一进来就能看到一句真正的原话
        (dq && dqText
          ? '<figure class="pull rv">' +
              '<blockquote>' + esc(dqText) + '</blockquote>' +
              '<figcaption>' +
                '<span' + tagStyle(dq.tag) + '>' + esc(dq.tag) + '</span>' +
                '<a href="#/archive/' + dq.s + '?t=' + encodeURIComponent(dq.t) + '">' +
                  esc(dq.date.replace('-', '.')) + ' ' + esc(dq.t) + ' 回原稿 →</a>' +
                '<em>从 ' + D.meta.quoteCount + ' 段摘录里随机一句</em>' +
              '</figcaption>' +
            '</figure>'
          : '') +
      '</section>' +

      '<section class="sec rv">' +
        '<div class="sec-head"><h2><i>01</i>最近一场</h2><a class="more" href="#/archive/' + last.id + '">完整逐字稿 →</a></div>' +
        '<div class="latest">' +
          '<div class="latest-l">' +
            '<div class="date">' + esc(last.dateLong) + ' ' + esc(last.week) + '</div>' +
            '<h3>' + esc(last.start) + ' — ' + esc(last.end) + '</h3>' +
            '<div class="sub">' + (last.dur >= 60 ? '约 ' + (last.dur / 60).toFixed(1) + ' 小时' : '约 ' + last.dur + ' 分钟') +
              ' · ' + (last.start >= '12:00' ? '傍晚特别场' : '深夜档') + '</div>' +
            '<div class="nums">' +
              '<div><b>' + last.count + '</b><span>记录</span></div>' +
              '<div><b>' + Object.keys(last.topics).length + '</b><span>话题</span></div>' +
              '<div><b>' + last.segs.length + '</b><span>段落</span></div>' +
            '</div>' +
            '<a class="btn" href="#/archive/' + last.id + '">打开这一场</a>' +
          '</div>' +
          '<div class="latest-r">' +
            (mini
              ? '<div class="lr-head">这一场说了什么<em>点时间回到原稿</em></div>' + mini
              : '<div class="qmini"><p>这一场暂无摘录。</p></div>') +
          '</div>' +
        '</div>' +
      '</section>' +

      '<section class="sec rv">' +
        '<div class="sec-head"><h2><i>02</i>日记</h2><a class="more" href="#/diary">全部日记 →</a></div>' +
        (latestDiary
          ? '<div class="dgrid">' + latestDiaryCard(latestDiary) +
              '<aside class="dside">' +
                '<div class="ds-head">更早的日记</div>' +
                (D.diary.slice(1, 6).map(function (d) {
                  return '<a class="ds-item" href="' + diaryHref(d) + '">' +
                    '<em>' + esc(d.date.replace('-', '.')) + '</em>' +
                    '<b>' + esc(d.title) + '</b></a>';
                }).join('') || '<span class="ds-empty">这是第一篇。</span>') +
                '<a class="ds-more" href="#/diary">全部 ' + D.diary.length + ' 篇 →</a>' +
              '</aside>' +
            '</div>'
          : '<div class="empty">还没有日记。</div>') +
      '</section>' +
      '<section class="sec rv">' +
        '<div class="sec-head"><h2>开播热力</h2><a class="more" href="#/archive">打开存档 →</a></div>' +
        heatmapHTML() +
      '</section>' +

      '<section class="sec rv" id="allSessions">' +
        '<div class="sec-head"><h2><i>03</i>全部场次</h2><a class="more" href="#/archive">存档 →</a></div>' +
        '<div class="sgrid">' + allSessions.slice(sfrom, sfrom + SPAGE).map(sessionCard).join('') + '</div>' +
        pagerHTML(state.spage, spages, allSessions.length, '场') +
      '</section>';

    bindPager(function (n) { state.spage = n; renderHome(); }, 'allSessions');
    if (!state.counted) { countUp(); state.counted = true; }
    playReveal();

    setFoot();
  }

  /* ---------- diary ---------- */
  function diaryInfo(d) {
    // 摘录条数在构建期算进日记索引，列表页不必为此拉 quotes.json
    var qn = d.qn || 0;
    return esc(d.start) + ' – ' + esc(d.end) + ' · ' + d.dur + ' 分钟 · ' + d.count + ' 条记录' +
      (qn ? ' · ' + qn + ' 段摘录' : '');
  }

  function diaryHref(d) {
    return '#/diary/' + encodeURIComponent(d.key);
  }

  function latestDiaryCard(d) {
    return '<article class="dcard">' +
      '<div class="dhead">' +
        '<div class="ddate">' + esc(d.dateLong) + ' <em>' + esc(d.week) + '</em></div>' +
        '<div class="dinfo">' + diaryInfo(d) + '</div>' +
      '</div>' +
      '<h3 class="dtitle">' + esc(d.title) + '</h3>' +
      (d.tagline ? '<div class="dtag">' + esc(d.tagline) + '</div>' : '') +
      '<p class="dexcerpt">' + esc(d.summary || '') + '</p>' +
      '<div class="dlinks"><a href="' + diaryHref(d) + '">读全文 →</a>' +
        '<a href="#/archive/' + d.s + '">逐字稿 →</a></div>' +
    '</article>';
  }

  function renderDiary(key) {
    var list = D.diary || [];
    var one = key ? list.filter(function (d) { return d.key === key; })[0] : null;
    // 键对不上（旧链接、手改过的地址）就退回列表，别给一个空页面
    if (key && !one) { location.replace('#/diary'); return; }
    if (one) {
      // 正文在 diary/<key>.json：先上占位，取到再画详情
      if (!one.body) {
        var tok = pageTok;
        loadingPage('STREAM DIARY', '正在打开这一篇…', '正文正在载入…');
        loadDiaryBody(one).then(function () {
          if (tok === pageTok) renderDiaryPage(one);
        }).catch(function () {
          if (tok === pageTok) failPage('这篇日记的正文没能加载，请刷新重试。');
        });
        return;
      }
      renderDiaryPage(one); return;
    }

    var pages = Math.max(1, Math.ceil(list.length / DPAGE));
    if (state.dpage < 1 || state.dpage > pages) state.dpage = 1;
    var from = (state.dpage - 1) * DPAGE;
    var cur = list.slice(from, from + DPAGE);

    var html = cur.map(diaryEntry).join('');
    var btns = pagerHTML(state.dpage, pages, list.length, '篇');

    app.innerHTML =
      '<section class="hero hero-sm">' +
        '<div class="hero-copy">' +
          '<div class="kicker">STREAM DIARY</div>' +
          '<h1>今日<span class="thin">，</span>播了<span class="accent">什么</span></h1>' +
          '<p class="lead">按场次记录当晚的话题、观众来信与随口讲到的冷知识。共 ' +
          list.length + ' 篇。</p>' +
        '</div>' +
      '</section>' +
      '<div class="dlist" id="dlist">' + (html || '<div class="empty">还没有日记。</div>') + '</div>' +
      btns;

    bindPager(function (n) { state.dpage = n; renderDiary(); }, 'dlist');

    setFoot();
  }

  // 列表里的一条：日期 / 场次信息 / 标题 / 摘要，点整块进全文
  function diaryEntry(d) {
    var sum = d.summary || '';
    return '<a class="dentry dmini" href="' + diaryHref(d) + '">' +
      '<div class="dhead">' +
        '<div class="ddate">' + esc(d.dateLong) + ' <em>' + esc(d.week) + '</em></div>' +
        '<div class="dinfo">' + diaryInfo(d) + '</div>' +
      '</div>' +
      '<h3 class="dtitle">' + esc(d.title) + '</h3>' +
      (d.tagline ? '<div class="dtag">' + esc(d.tagline) + '</div>' : '') +
      '<p class="dsum">' + esc(sum) + '</p>' +
      '<div class="dlinks"><span class="dmore">读全文 →</span>' +
        '<span class="dcount">' + (d.n || 0) + ' 段</span></div>' +
    '</a>';
  }

  // 详情页：全文 + 场次信息 + 上下篇，正文按段落排
  function renderDiaryPage(d) {
    var i = D.diary.indexOf(d);
    var newer = i > 0 ? D.diary[i - 1] : null;
    var older = i < D.diary.length - 1 ? D.diary[i + 1] : null;

    var body = d.body.map(function (p) { return '<p>' + diaryText(p, d) + '</p>'; }).join('');
    // 开播前后在 B 站发的动态：日记正文常直接引用它，所以放在正文前面当背景资料。
    // 没有动态的那几篇（10 月）就不出这一栏
    var dyns = d.dyn || [];
    var dynBlock = dyns.length
      ? '<section class="dyn-inline">' +
          '<div class="di-head"><b>动态</b><span>' + dyns.length +
            ' 条 · 开播前后在 B 站发的</span></div>' +
          dyns.map(function (x) {
            return '<article class="dyn-card">' +
              '<div class="dyn-side"><b>' + esc(x.time || '') + '</b><span>B 站</span></div>' +
              '<div class="dyn-body">' +
                '<p class="jp">' + esc(x.jp || '') + '</p>' +
                (x.zh ? '<p class="zh">' + esc(x.zh) + '</p>' : '') +
                ((x.pics && x.pics.length)
                  ? '<div class="dyn-pics">' + x.pics.map(function (u) {
                      return '<img src="' + esc(u) + '" referrerpolicy="no-referrer" loading="lazy" alt="动态图片">';
                    }).join('') + '</div>'
                  : '') +
                (x.url
                  ? '<div class="dyn-links"><a class="dyn-src" href="' + esc(x.url) +
                    '" target="_blank" rel="noopener">查看原帖 ↗</a></div>'
                  : '') +
              '</div>' +
            '</article>';
          }).join('') +
        '</section>'
      : '';
    var nav =
      '<nav class="dnav">' +
        (older
          ? '<a class="dnav-i" href="' + diaryHref(older) + '"><em>更早一篇</em><b>' + esc(older.title) + '</b></a>'
          : '<span class="dnav-i dnav-off"></span>') +
        (newer
          ? '<a class="dnav-i dnav-r" href="' + diaryHref(newer) + '"><em>更新一篇</em><b>' + esc(newer.title) + '</b></a>'
          : '<span class="dnav-i dnav-off"></span>') +
      '</nav>';

    app.innerHTML =
      '<section class="hero hero-sm">' +
        '<div class="hero-copy dwrap">' +
          '<a class="back" href="#/diary">← 全部日记</a>' +
          '<div class="kicker">STREAM DIARY</div>' +
          '<h1 class="dtitle-lg">' + esc(d.title) + '</h1>' +
          (d.tagline ? '<p class="lead">' + esc(d.tagline) + '</p>' : '') +
          '<div class="dinfo dmeta-row">' + esc(d.dateLong) + ' <em>' + esc(d.week) + '</em> · ' + diaryInfo(d) + '</div>' +
        '</div>' +
      '</section>' +
      dynBlock +
      '<article class="dfull">' +
        '<div class="dbody">' + body + '</div>' +
        '<div class="dlinks">' +
          '<a href="#/archive/' + d.s + '">这一场的逐字稿 →</a>' +
          '<a href="#/diary">全部日记</a>' +
        '</div>' +
      '</article>' +
      nav;

    setFoot();
  }

  function sessionCard(s) {
    // 按出现次数排序后再取前三，否则每张卡片都只会显示同一组「最早出现」的话题
    var top = Object.keys(s.topics)
      .sort(function (a, b) { return s.topics[b] - s.topics[a]; })
      .slice(0, 3).map(function (k) {
      return '<span style="color:' + tcolor(parseInt(k, 10)) + '">' + esc(tname(parseInt(k, 10))) + '</span>';
    }).join(' · ');
    return '<a class="qcard" href="#/archive/' + s.id + '">' +
      '<div class="tag">' + esc(s.date.replace('-', '.')) + ' ' + esc(s.week) + '</div>' +
      '<p class="zh">' + esc(s.start) + ' — ' + esc(s.end) + '</p>' +
      '<p class="note">' + top + '</p>' +
      // 这一场的话题走向：横轴是时长，颜色是当分钟的话题
      '<span class="hb" title="这一场的话题走向">' + stripHTML(s) + '</span>' +
      '<div class="meta"><span>' + s.count + ' 条 · ' + s.dur + ' 分钟</span><span>阅读 →</span></div>' +
      '</a>';
  }

  /* ---------- quotes ---------- */
  /* ---------- 统一时间线 ----------
     日记、动态、摘录、问答按日期铺在一根竖轴上：想看「这段时间她经历了什么」，
     不用在几个栏目之间来回切。每条都带回到原页面的链接。 */
  function renderTimeline() {
    var tok = pageTok;
    if (!AQ.rows) {   // 摘录 / 问答那两行来自 quotes.json；日记索引已在 data.js
      loadingPage('ONE CONTINUOUS THREAD', '时间线', '正在载入摘录…');
      loadQuotes().then(function () {
        if (tok === pageTok) renderTimeline();
      }).catch(function () {
        if (tok === pageTok) failPage('时间线数据没能加载，请刷新重试。');
      });
      return;
    }
    var kinds = [['all', '全部'], ['diary', '日记'], ['quote', '摘录'], ['qa', '问答'], ['dyn', '动态']];
    var byDay = {};
    function push(date, item) {
      if (!date) return;
      var key = date.length > 5 ? date.slice(5) : date;
      (byDay[key] = byDay[key] || []).push(item);
    }
    D.diary.forEach(function (d) {
      push(d.date, { kind: 'diary', t: d.start, title: d.title, text: d.summary || '', key: d.key });
      (d.dyn || []).forEach(function (x) {
        push(d.date, { kind: 'dyn', t: x.time || '00:00', jp: x.jp || '', zh: x.zh || '', url: x.url });
      });
    });
    D.quotes.forEach(function (q) {
      push(q.date, {
        kind: q.sc ? 'qa' : 'quote', t: q.t, jp: q.jp, zh: q.zh, tag: q.tag,
        id: q.id, ref: quoteRef(q), s: q.s
      });
    });
    var days = Object.keys(byDay).sort().reverse();
    days.forEach(function (k) {
      byDay[k].sort(function (a, b) { return hmsSec(b.t) - hmsSec(a.t); });
    });

    var label = { diary: ['日记', '✎'], quote: ['摘录', '❝'], qa: ['问答', '✦'], dyn: ['动态', '◈'] };
    function clip(s, n) {
      s = String(s || '').replace(/\s+/g, ' ').trim();
      return s.length > n ? s.slice(0, n) + '…' : s;
    }
    function tlRow(it) {
      var m = label[it.kind];
      var body;
      if (it.kind === 'diary') {
        body = '<h4>' + esc(it.title) + '</h4><p class="tl-text">' + esc(clip(it.text, 150)) + '</p>';
      } else if (it.kind === 'dyn') {
        body = '<p class="tl-text">' + esc(clip(it.zh || it.jp, 180)) + '</p>';
      } else {
        var r = it.ref;
        var head = r
          ? '<div class="tl-q"><b>' + esc(r.name || '观众') + '</b>' +
            (r.kind === 'dm' ? '<span class="tl-dm">弹幕</span>' : '') +
            esc(clip(r.text, 90)) + '</div>'
          : '';
        body = head + '<p class="tl-jp">' + esc(clip(it.jp, 130)) + '</p>' +
          '<p class="tl-text">' + esc(clip(it.zh, 170)) + '</p>';
      }
      var href = it.kind === 'diary' ? '#/diary/' + encodeURIComponent(it.key)
        : it.kind === 'dyn' ? it.url
        : '#/quotes?focus=' + encodeURIComponent(it.id);
      var external = it.kind === 'dyn' ? ' target="_blank" rel="noopener"' : '';
      return '<article class="tl-row kind-' + it.kind + '">' +
        '<div class="tl-hour">' + esc(it.t) + '</div>' +
        '<div class="tl-node" aria-hidden="true"></div>' +
        '<div class="tl-card">' +
          '<div class="tl-kicker"><span>' + m[1] + ' ' + m[0] + '</span>' +
            (it.tag ? '<em>' + esc(it.tag) + '</em>' : '') +
            '<a href="' + href + '"' + external + '>查看 →</a></div>' +
          body +
        '</div>' +
      '</article>';
    }
    function paint() {
      var box = document.getElementById('tlDays');
      if (!box) return;
      var totalShown = 0;
      box.innerHTML = days.map(function (k) {
        var rows = byDay[k].filter(function (it) {
          return state.tlKind === 'all' || it.kind === state.tlKind;
        });
        if (!rows.length) return '';
        totalShown += rows.length;
        return '<section class="tl-day"><h3><b>' + esc(k.replace('-', '.')) + '</b>' +
          '<span>' + rows.length + ' 条</span></h3>' + rows.map(tlRow).join('') + '</section>';
      }).join('') || '<div class="empty">这个筛选下还没有内容。</div>';
      var c = document.getElementById('tlCount');
      if (c) c.textContent = '共 ' + totalShown + ' 条 · ' + days.length + ' 天';
    }
    app.innerHTML =
      '<section class="hero hero-sm">' +
        '<div class="hero-copy">' +
          '<div class="kicker">ONE CONTINUOUS THREAD</div>' +
          '<h1>时间线<span class="thin">，</span><span class="accent">' + days.length + '</span> 天</h1>' +
          '<p class="lead">日记、动态、摘录和问答按时间排在一起。' +
          '想找哪一天说过什么，顺着往下翻就行。</p>' +
        '</div>' +
      '</section>' +
      '<div class="filters" id="tlKinds">' + kinds.map(function (x) {
        return '<button class="chip' + (state.tlKind === x[0] ? ' on' : '') + '" data-k="' + x[0] + '">' +
          x[1] + '</button>';
      }).join('') + '</div>' +
      '<div class="tl-count" id="tlCount"></div>' +
      '<div class="tl-days" id="tlDays"></div>';
    document.getElementById('tlKinds').addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      state.tlKind = b.getAttribute('data-k');
      document.querySelectorAll('#tlKinds .chip').forEach(function (c) {
        c.classList.toggle('on', c.getAttribute('data-k') === state.tlKind);
      });
      paint();
    });
    paint();
    setFoot();
  }

  function renderQuotes() {
    var tok = pageTok;
    if (!AQ.rows) {
      loadingPage('TRANSCRIPT EXCERPTS', '摘录', '正在载入摘录…');
      loadQuotes().then(function () {
        if (tok === pageTok) renderQuotes();
      }).catch(function () {
        if (tok === pageTok) failPage('摘录没能加载，请刷新重试。');
      });
      return;
    }
    // 全站搜索跳到某段摘录时，放开筛选并保证目标那一条已经渲染出来
    var focusId = parseHash().q.focus || '';
    var focusQ = focusId ? D.quotes.filter(function (x) { return x.id === focusId; })[0] : null;
    if (focusQ) { state.tag = '全部'; state.qs = 'all'; }
    var tags = ['全部'];
    var counts = {};
    D.quotes.forEach(function (q) {
      qTags(q).forEach(function (t) {
        if (tags.indexOf(t) < 0) tags.push(t);
        counts[t] = (counts[t] || 0) + 1;
      });
    });
    // 标签会随内容增长，按条数降序排（同数按名称），「全部」固定首位
    tags = ['全部'].concat(tags.slice(1).sort(function (a, b) {
      return (counts[b] - counts[a]) || a.localeCompare(b, 'zh');
    }));

    var chips = tags.map(function (t) {
      var n = t === '全部' ? D.quotes.length : counts[t];
      return '<button class="chip' + (t === state.tag ? ' on' : '') + '" data-tag="' + esc(t) + '"' +
        (t === '全部' ? '' : tagStyle(t)) + '>' +
        esc(t) + '<span class="n">' + n + '</span></button>';
    }).join('');

    var sess = D.sessions.filter(function (s) {
      return D.quotes.some(function (q) { return q.s === s.id; });
    }).reverse();
    var schips = '<button class="chip' + (state.qs === 'all' ? ' on' : '') + '" data-s="all">全部<span class="n">' + D.quotes.length + '</span></button>' +
      sess.map(function (s) {
        var n = D.quotes.filter(function (q) { return q.s === s.id; }).length;
        return '<button class="chip' + (state.qs === String(s.id) ? ' on' : '') + '" data-s="' + esc(s.id) + '">' +
          esc(s.date.replace('-', '.')) + '<span class="n">' + n + '</span></button>';
      }).join('');

    app.innerHTML =
      '<section class="hero hero-sm">' +
        '<div class="hero-copy">' +
          '<div class="kicker">TRANSCRIPT EXCERPTS</div>' +
          '<h1>摘录<span class="thin">，</span><span class="accent">' + D.meta.quoteCount + '</span> 段</h1>' +
          '<p class="lead">从 ' + num(D.meta.total) + ' 条记录里挑出的 ' + D.meta.quoteCount + ' 段，' +
          '中日对照，按话题分类。每段都标出引出它的那条 SC，她的话原样保留，措辞不做润色。</p>' +
        '</div>' +
      '</section>' +
      '<div class="filters" id="filters">' + chips + '</div>' +
      '<div class="filters" id="sfilters"><span class="flabel">场次</span>' + schips + '</div>' +
      '<div class="qlist" id="qlist"></div>' +
      '<div class="qmore" id="qmore"></div>';

    document.getElementById('filters').addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      state.tag = b.getAttribute('data-tag');
      document.querySelectorAll('#filters .chip').forEach(function (c) {
        c.classList.toggle('on', c.getAttribute('data-tag') === state.tag);
      });
      renderQuoteList(true);
    });
    document.getElementById('sfilters').addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      state.qs = b.getAttribute('data-s');
      document.querySelectorAll('#sfilters .chip').forEach(function (c) {
        c.classList.toggle('on', c.getAttribute('data-s') === state.qs);
      });
      renderQuoteList(true);
    });
    renderQuoteList(true);
    if (focusQ) {
      state.qShown = Math.max(QBATCH, D.quotes.indexOf(focusQ) + 1);
      renderQuoteList(false);
      // route() 末尾会把页面滚回顶部，等下一帧再落到目标摘录上
      requestAnimationFrame(function () {
        var el = document.getElementById(focusId);
        if (el) { el.classList.add('hit'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      });
    }
    setFoot();
  }

  /* ---------- 节奏：整场逐字稿与 SC 的回应关系 ----------
     有对应关系的 SC 与她的话放在一张卡片里：SC 作被引用评论，她的话缩进成跟帖。
     没有对应的按时间散装。卡片整体按时间顺序排列。 */

  function renderRhythm() {
    var tok = pageTok;
    if (!AR.rows) {
      loadingPage('ONE STREAM, EVERY BEAT', '节奏', '正在载入整场记录…');
      loadRhythm().then(function () {
        if (tok === pageTok) renderRhythm();
      }).catch(function () {
        if (tok === pageTok) failPage('整场记录没能加载，请刷新重试。');
      });
      return;
    }
    var R = AR.rows;
    var beats = R.beats || [];
    if (!beats.length) { failPage('这场还没有节奏数据。'); return; }

    var kinds = [['all', '全部'], ['reply', '有回应'], ['sc', '散装 SC'],
                 ['free', '散装逐字稿'], ['quote', '已摘录']];
    function scRow(s) {
      return '<div class="qsc"><b>' + esc(s.name || '观众') +
        '<span class="rh-price">¥' + (s.price || 0) + '</span></b><p>' + esc(s.text) + '</p></div>';
    }
    function post(l, s) {
      var badge = s ? '<span class="rh-lsc">回应这条 · ' + esc(s.name || '观众') + '</span>' : '';
      return '<div class="qpost">' +
        '<a class="qt" href="#/archive/' + encodeURIComponent(R.session) + '?t=' +
          encodeURIComponent(l.t) + '" title="在原稿中定位">' + esc(l.t) + '</a>' +
        '<div class="qpc">' + badge +
          '<p class="jp">' + esc(l.jp) + '</p>' +
          (l.zh ? '<p class="zh">' + esc(l.zh) + '</p>' : '') +
        '</div></div>';
    }
    function card(c) {
      var hs = c.scs.map(scRow).join('');
      var posts = c.lines.map(function (l) { return post(l, c.kind === 'reply' ? c.scs[0] : null); }).join('');
      var head = (hs ? '<div class="rh-refs">' + hs + '</div>' : '') +
        (c.note ? '<div class="rh-note">' + esc(c.note) + '</div>' : '');
      return '<article class="quote rh-card rh-' + c.kind + '" id="' + c.id + '">' +
        '<div class="qhead">' +
          '<span class="tag"' + tagStyle(c.tag) + '>' + esc(c.tag) + '</span>' +
          '<h3 class="qtitle">' + esc(c.title) + '</h3>' +
          '<span class="rh-range">' + esc(c.t) + ' — ' + esc(c.end) + '</span>' +
        '</div>' +
        '<div class="qbody">' + head +
          (posts ? '<div class="qthread on">' + posts + '</div>' : '') +
        '</div></article>';
    }

    function paint() {
      var box = document.getElementById('rhList');
      if (!box) return;
      var needle = state.rh.trim();
      var list = beats.filter(function (c) {
        if (state.rhFilter === 'reply' && c.kind !== 'reply') return false;
        if (state.rhFilter === 'sc' && c.kind !== 'sc') return false;
        if (state.rhFilter === 'free' && c.kind !== 'free') return false;
        if (state.rhFilter === 'quote' && c.tag === '现场' && c.tag !== '声明') return false;
        if (!needle) return true;
        var hay = [c.title].concat(c.lines.map(function (l) { return l.jp + ' ' + l.zh; }))
          .concat(c.scs.map(function (s) { return s.name + ' ' + s.text; })).join('\n');
        return hay.toLowerCase().indexOf(needle.toLowerCase()) >= 0;
      });
      state.rhList = list;
      var shown = list.slice(0, state.rhShown);
      box.innerHTML = shown.map(card).join('') ||
        '<div class="empty">这个筛选条件下没有内容。</div>';
      var more = document.getElementById('rhMore');
      if (more) {
        more.innerHTML = list.length > state.rhShown
          ? '<button class="morebtn" id="rhMoreBtn">加载更多 ↓</button>' +
            '<span class="mhint">已显示 ' + shown.length + ' / ' + list.length + ' 段 · ' +
            R.total + ' 条逐字稿全部在内</span>'
          : '<span class="mhint">已全部显示 · ' + list.length + ' 段 · ' +
            R.total + ' 条逐字稿全部在内</span>';
      }
      var cnt = document.getElementById('rhCount');
      if (cnt) cnt.textContent = '共 ' + list.length + ' 段';
    }

    app.innerHTML =
      '<section class="hero hero-sm">' +
        '<div class="hero-copy">' +
          '<div class="kicker">ONE STREAM, EVERY BEAT</div>' +
          '<h1>节奏<span class="thin">，</span><span class="accent">' + R.total + '</span> 句</h1>' +
          '<p class="lead">' + esc(R.title) + ' 整场按时间顺序排列。有对应的 SC 与她的回应放在同一张卡片里，' +
          '没有对应的按时间散装；' + R.scCount + ' 条 SC 与 ' + R.total + ' 条逐字稿都在其中。</p>' +
        '</div>' +
      '</section>' +
      '<div class="filters" id="rhKinds">' + kinds.map(function (x) {
        return '<button class="chip' + (state.rhFilter === x[0] ? ' on' : '') +
          '" data-k="' + x[0] + '">' + x[1] + '</button>';
      }).join('') +
        '<input class="rh-search" id="rhSearch" type="search" placeholder="在本场找原句或 SC…" value="' +
        esc(state.rh) + '" aria-label="在本场搜索">' +
        '<span class="rh-count" id="rhCount"></span>' +
      '</div>' +
      '<div class="qlist" id="rhList"></div>' +
      '<div class="qmore" id="rhMore"></div>';

    document.getElementById('rhKinds').addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      state.rhFilter = b.getAttribute('data-k');
      state.rhShown = 6;
      document.querySelectorAll('#rhKinds .chip').forEach(function (c) {
        c.classList.toggle('on', c === b);
      });
      paint();
    });
    document.getElementById('rhSearch').addEventListener('input', function (e) {
      state.rh = e.target.value;
      state.rhShown = 6;
      paint();
    });
    document.getElementById('rhMore').addEventListener('click', function (e) {
      if (!e.target.closest('#rhMoreBtn')) return;
      state.rhShown += 6;
      paint();
    });
    paint();
    setFoot();
  }

  // 摘录的引用块：老条目只有 sc，新条目可能是 dm（弹幕），一条只带一种
  function quoteRef(q) {
    if (q.sc) return { kind: 'sc', name: q.sc.name || '', text: q.sc.text || '' };
    if (q.dm) return { kind: 'dm', name: q.dm.name || '', text: q.dm.text || '' };
    return null;
  }
  function refBlock(q) {
    var r = quoteRef(q);
    if (!r) return '';
    var dm = r.kind === 'dm';
    return '<div class="qsc' + (dm ? ' qdm' : '') + '">' +
      (r.name || dm ? '<b>' + esc(r.name || '观众') + (dm ? '<span class="qk">弹幕</span>' : '') + '</b>' : '') +
      '<p>' + esc(r.text) + '</p>' +
    '</div>';
  }

  function quoteCard(q) {
    // 一条摘录 = 讲同一件事的一组逐字稿条目，正文直接引用逐字稿，
    // 和档案页共用同一份数据。SC / 弹幕作为被引用评论放在块头，校勘说明放块尾。
    var ref = quoteRef(q);
    var sc = refBlock(q);
    var lines = q.lines || [{ t: q.t, jp: q.jp || '', zh: q.zh || '' }];
    var back = '#/archive/' + q.s + '?t=' + encodeURIComponent(q.t);
    var posts = lines.map(function (l) {
      var href = '#/archive/' + q.s + '?t=' + encodeURIComponent(l.t || q.t);
      return '<div class="qpost">' +
        '<a class="qt" href="' + href + '" title="在原稿中定位">' + esc(l.t) + '</a>' +
        '<div class="qpc">' +
          '<p class="jp">' + esc(l.jp) + '</p>' +
          (l.zh ? '<p class="zh">' + esc(l.zh) + '</p>' : '') +
        '</div>' +
      '</div>';
    }).join('');
    // 标题行：圆角标签 + 简短概括；日期放右端。每句自带时间戳，左侧不再重复一个。
    var head = '<div class="qhead">' +
      qTags(q).map(function (t) { return '<span class="tag"' + tagStyle(t) + '>' + esc(t) + '</span>'; }).join('') +
      '<h3 class="qtitle">' + esc(q.title || q.tag) + '</h3>' +
      '<a class="qdate" href="' + back + '">' + esc(q.date.replace('-', '.')) + '</a>' +
      '<div class="qacts">' +
        '<button class="copy" data-id="' + q.id + '">复制</button>' +
        '<button class="mkcard" data-card="' + q.id + '" title="生成图片卡片">卡片</button>' +
      '</div>' +
    '</div>';
    return '<article class="quote" id="' + q.id + '">' +
      head +
      '<div class="qbody">' +
        sc +
        '<div class="qthread' + (ref ? ' on' : '') + '">' + posts + '</div>' +
        (q.note ? '<p class="note">' + esc(q.note) + '</p>' : '') +
      '</div>' +
    '</article>';
  }

  /* ---------- 金句卡片 ----------
     把一条摘录画成竖版 PNG：SC 引用、日文原句、译文、日期与话题。
     图片同源，画完直接下载；不做上传，也不需要服务端。 */
  function wrapLines(ctx, text, maxW) {
    var out = [];
    String(text || '').split('\n').forEach(function (para) {
      var line = '';
      for (var i = 0; i < para.length; i++) {
        var test = line + para[i];
        if (line && ctx.measureText(test).width > maxW) { out.push(line); line = para[i]; }
        else line = test;
      }
      out.push(line);
    });
    return out.length ? out : [''];
  }

  function makeQuoteCard(q, btn) {
    var W = 720, PAD = 64, TW = W - PAD * 2;
    var JP_FONT = '600 35px "Yu Gothic", "Noto Sans JP", "Microsoft YaHei", sans-serif';
    var ZH_FONT = '400 26px "Noto Sans JP", "Microsoft YaHei", sans-serif';
    var m = document.createElement('canvas').getContext('2d');
    // 卡片按「一条逐字稿 = 一段原文 + 一段译文」排，原文和译文交替，不再整块分开。
    var lines = (q.lines && q.lines.length) ? q.lines : [{ jp: q.jp || '', zh: q.zh || '' }];
    var entries = lines.map(function (l) {
      m.font = JP_FONT;
      var jp = wrapLines(m, l.jp || '', TW);
      m.font = ZH_FONT;
      var zh = wrapLines(m, l.zh || '', TW);
      return { jp: jp, zh: zh, hasZh: !!(l.zh && String(l.zh).trim()) };
    });
    var ref = quoteRef(q);
    m.font = '400 22px "Microsoft YaHei", sans-serif';
    var refL = ref ? wrapLines(m, ref.text, TW - 28) : [];
    // 高度按实际排版累加，不设 2400 上限：长摘录整段输出，宁可图长也不截断。
    var bodyH = 0;
    entries.forEach(function (e) {
      bodyH += e.jp.length * 53;
      if (e.hasZh) bodyH += 6 + e.zh.length * 40;
      bodyH += 26;
    });
    var H = Math.max(760, 148 + (ref ? 78 + refL.length * 36 : 0) + bodyH + 120);

    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var x = c.getContext('2d');
    function fill() {
      var g = x.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#20140f'); g.addColorStop(1, '#0e0a09');
      x.fillStyle = g; x.fillRect(0, 0, W, H);
      // 左侧一道火色竖线，和站内的强调色保持一致
      x.fillStyle = '#ff7a45'; x.fillRect(0, 0, 7, H);
    }
    function content() {
      x.textBaseline = 'top';
      x.fillStyle = '#ff9a6a';
      x.font = '600 19px "Microsoft YaHei", sans-serif';
      x.fillText('火羽ひのめ · 直播存档', PAD, 62);
      x.fillStyle = '#8d837d';
      x.font = '500 18px "Microsoft YaHei", sans-serif';
      x.fillText(q.date.replace('-', '.') + '  ' + q.t + '   ·   ' + q.tag, PAD, 94);

      var y = 148;
      if (ref) {
        var isDm = ref.kind === 'dm';
        x.fillStyle = isDm ? 'rgba(150,195,240,.055)' : 'rgba(255,255,255,.045)';
        x.fillRect(PAD - 18, y - 16, TW + 36, refL.length * 36 + 66);
        x.fillStyle = isDm ? '#8fbde4' : '#79a9d6';
        x.font = '600 19px "Microsoft YaHei", sans-serif';
        x.fillText((isDm ? '弹幕 · ' : '') + (ref.name || '观众'), PAD, y);
        y += 32;
        x.fillStyle = '#c9c3be';
        x.font = '400 22px "Microsoft YaHei", sans-serif';
        refL.forEach(function (line) { x.fillText(line, PAD, y); y += 36; });
        y += 46;
      }
      entries.forEach(function (e) {
        x.fillStyle = '#f5efe9';
        x.font = JP_FONT;
        e.jp.forEach(function (line) { x.fillText(line, PAD, y); y += 53; });
        if (e.hasZh) {
          y += 6;
          x.fillStyle = '#aaa09a';
          x.font = ZH_FONT;
          e.zh.forEach(function (line) { x.fillText(line, PAD, y); y += 40; });
        }
        y += 26;
      });

      x.fillStyle = '#5f5752';
      x.font = '400 17px "Microsoft YaHei", sans-serif';
      x.fillText('非官方粉丝整理 · 著作权归主播及原权利人所有', PAD, H - 58);
    }
    function save() {
      try {
        c.toBlob(function (blob) {
          if (!blob) { btn.textContent = '失败'; return; }
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = '火羽ひのめ-' + q.date + '-' + q.t.replace(/:/g, '') + '.png';
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
          btn.textContent = '已保存';
          setTimeout(function () { btn.textContent = '卡片'; }, 1600);
        }, 'image/png');
      } catch (err) {
        btn.textContent = '失败';
        setTimeout(function () { btn.textContent = '卡片'; }, 1600);
      }
    }
    fill();
    var img = new Image();
    img.onload = function () {
      // 底图是 16:9 横图，卡片是竖版：按宽度等比缩放、顶部对齐。
      // 直接用 drawImage(img, 0, 0, W, H) 铺满会把横图横向挤扁。
      var ih = Math.round(W * img.height / img.width);
      var layer = document.createElement('canvas');
      layer.width = W; layer.height = ih;
      var lx = layer.getContext('2d');
      lx.globalAlpha = 0.18;
      lx.drawImage(img, 0, 0, W, ih);
      // 下沿淡出到透明，叠在卡片底色上不会留一条硬边
      lx.globalAlpha = 1;
      lx.globalCompositeOperation = 'destination-out';
      var fadeH = Math.min(160, ih);
      var fade = lx.createLinearGradient(0, ih - fadeH, 0, ih);
      fade.addColorStop(0, 'rgba(0,0,0,0)');
      fade.addColorStop(1, 'rgba(0,0,0,1)');
      lx.fillStyle = fade;
      lx.fillRect(0, ih - fadeH, W, fadeH);
      x.drawImage(layer, 0, 0);
      content(); save();
    };
    img.onerror = function () { content(); save(); };
    img.src = 'brand/scene-girls.webp';
  }

  // reset=true 时回到第一批：切换筛选后从顶部重新铺，避免停在一个空的批次上
  function renderQuoteList(reset) {
    if (reset) state.qShown = QBATCH;
    var list = D.quotes.filter(function (q) {
      return (state.tag === '全部' || qTags(q).indexOf(state.tag) >= 0) &&
             (state.qs === 'all' || String(q.s) === state.qs);
    });
    state.qList = list;
    var shown = list.slice(0, state.qShown);
    var box = document.getElementById('qlist');
    var more = document.getElementById('qmore');
    if (!box || !more) return;

    box.innerHTML = shown.map(quoteCard).join('') ||
      '<div class="empty">这个筛选组合下还没有摘录。</div>';

    if (list.length > state.qShown) {
      more.innerHTML = '<button class="morebtn" id="qloadmore">加载更多 ↓</button>' +
        '<span class="mhint">已显示 ' + shown.length + ' / ' + list.length + ' 段</span>';
      document.getElementById('qloadmore').addEventListener('click', function () {
        state.qShown += QBATCH;
        renderQuoteList(false);
      });
    } else {
      more.innerHTML = list.length ? '<span class="mhint">已全部显示 · 共 ' + list.length + ' 段</span>' : '';
    }
  }

  app.addEventListener('click', function (e) {
    var cardBtn = e.target.closest('.mkcard');
    if (cardBtn) {
      var cq = D.quotes.filter(function (x) { return x.id === cardBtn.getAttribute('data-card'); })[0];
      if (cq && cardBtn.textContent === '卡片') makeQuoteCard(cq, cardBtn);
      return;
    }
    var btn = e.target.closest('.copy');
    if (!btn) return;
    var q = D.quotes.filter(function (x) { return x.id === btn.getAttribute('data-id'); })[0];
    if (!q) return;
    var cr = quoteRef(q);
    var head = cr
      ? (cr.kind === 'dm' ? '【弹幕】' : '') + '「' + (cr.name ? cr.name + '：' : '') + cr.text + '」\n'
      : '';
    var text = head + q.zh + '\n' + q.jp + '\n—— ' + D.meta.streamer + ' ' + q.date + ' ' + q.t;
    var done = function () { btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制'; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (err) {}
      document.body.removeChild(ta); done();
    }
  });

  /* ---------- 存档：年月日选择 → 当日场次 → 逐字稿，全在同一个页面 ----------
     顶部是标准的年 / 月 / 日下拉输入框，下面配一个紧凑的小月历做索引。
     选中日期才在右侧列出当天场次，再选一场就地把逐字稿渲染进同页下方。
     全程不换 hash、不跳路由；外部旧链接 #/archive/<sid> 仍作为「直接选中这一场」的深链。 */
  function renderArchivePage(opts) {
    var month = monthKeys.indexOf(opts.month) >= 0 ? opts.month : monthKeys[monthKeys.length - 1];
    var day = (byDay[opts.day] && opts.day.slice(0, 7) === month) ? opts.day : '';
    var sid = (opts.sid != null && D.sessions[opts.sid]) ? opts.sid : null;
    if (sid != null) {                 // 深链直接打开某场：把日历翻到那一天
      day = dayKey(D.sessions[sid]);
      month = day.slice(0, 7);
    }

    var now = new Date();
    var today = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());

    // 年份只取有场次的年份；月份列出 12 个月，暂无记录的月份禁用；
    // 日期列出当月每一天，只让有直播的日子可选，选项里直接带场数。
    var years = [];
    monthKeys.forEach(function (k) {
      var y = k.slice(0, 4);
      if (years.indexOf(y) < 0) years.push(y);
    });

    function countOf(k) {
      return D.sessions.filter(function (s) { return dayKey(s).slice(0, 7) === k; }).length;
    }
    function monthCount() { return countOf(month); }

    function yearOptions() {
      return years.map(function (y) {
        return '<option value="' + y + '"' + (month.slice(0, 4) === y ? ' selected' : '') +
               '>' + y + ' 年</option>';
      }).join('');
    }
    function monthOptions() {
      var out = '';
      for (var m = 1; m <= 12; m++) {
        var k = month.slice(0, 4) + '-' + pad2(m);
        var n = countOf(k);
        out += '<option value="' + pad2(m) + '"' + (+month.slice(5) === m ? ' selected' : '') +
               (n ? '' : ' disabled') + '>' + m + ' 月' + (n ? ' · ' + n + ' 场' : ' · 暂无') + '</option>';
      }
      return out;
    }
    function dayOptions() {
      var p = month.split('-'), y = +p[0], m = +p[1];
      var days = new Date(y, m, 0).getDate();
      var out = '<option value=""' + (day ? '' : ' selected') + '>选择日期</option>';
      for (var i = 1; i <= days; i++) {
        var k = month + '-' + pad2(i);
        var n = byDay[k] ? byDay[k].length : 0;
        out += '<option value="' + k + '"' + (day === k ? ' selected' : '') +
               (n ? '' : ' disabled') + '>' + i + ' 日' + (n ? ' · ' + n + ' 场' : '') +
               (k === today ? ' · 今天' : '') + '</option>';
      }
      return out;
    }

    function gridHTML() {
      var p = month.split('-'), y = +p[0], m = +p[1];
      var lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;   // 周一开头
      var days = new Date(y, m, 0).getDate();
      var cells = Math.ceil((lead + days) / 7) * 7;
      var out = '';
      for (var i = 0; i < cells; i++) {
        var n = i - lead + 1, inMonth = n >= 1 && n <= days;
        var key = inMonth ? month + '-' + pad2(n) : '';
        var k = key && byDay[key] ? byDay[key].length : 0;
        var cls = 'cal-cell' + (inMonth ? '' : ' cal-out') + (k ? ' has' : '') +
                  (key && key === day ? ' sel' : '') + (key === today ? ' is-today' : '');
        out += '<div class="' + cls + '"' + (key ? ' data-day="' + key + '"' : '') +
               (k ? ' role="button" tabindex="0" aria-label="' + (+key.slice(5, 7)) + ' 月 ' +
                 (+key.slice(8, 10)) + ' 日，' + k + ' 场"' : '') + '>' +
          '<span class="cal-n">' + (inMonth ? n : '') + '</span>' +
          (k ? '<span class="cal-mark"><i></i></span>' : '') +
        '</div>';
      }
      return out;
    }

    function pickerHTML() {
      var mi = monthKeys.indexOf(month);
      var prevM = monthKeys[mi - 1] || '', nextM = monthKeys[mi + 1] || '';
      return '<div class="cal-picker">' +
          '<div class="cal-selects">' +
            '<label class="cal-field"><span>年</span><select id="calYear" aria-label="选择年份">' + yearOptions() + '</select></label>' +
            '<label class="cal-field"><span>月</span><select id="calMonth" aria-label="选择月份">' + monthOptions() + '</select></label>' +
            '<label class="cal-field wide"><span>日</span><select id="calDay" aria-label="选择日期">' + dayOptions() + '</select></label>' +
          '</div>' +
          '<div class="cal-nav">' +
            '<button class="cal-arrow" type="button" data-goto="' + prevM + '"' +
              (prevM ? '' : ' disabled') + ' aria-label="上一场所在月">‹</button>' +
            '<h3>' + monthLabel(month) + '<em>' + monthCount() + ' 场</em></h3>' +
            '<button class="cal-arrow" type="button" data-goto="' + nextM + '"' +
              (nextM ? '' : ' disabled') + ' aria-label="下一场所在月">›</button>' +
          '</div>' +
          '<div class="cal-grid"><div class="cal-dow">' +
            ['一', '二', '三', '四', '五', '六', '日'].map(function (w, idx) {
              return '<span' + (idx >= 5 ? ' class="we"' : '') + '>' + w + '</span>';
            }).join('') +
          '</div><div class="cal-cells">' + gridHTML() + '</div></div>' +
          '<div class="cal-foot">' +
            '<span class="cal-legend"><i></i>有存档</span>' +
            '<button class="cal-jump" type="button" data-goto="latest">回到最新</button>' +
          '</div>' +
        '</div>';
    }

    function sessionCard(s) {
      var d = D.diary.filter(function (x) { return x.key === s.key; })[0];
      var qn = s.qn || 0;
      var mini = s.ribbon.slice(0, 48).map(function (t) {
        return '<i style="background:' + (t < 0 ? '#2a2521' : tcolor(t)) + '"></i>';
      }).join('');
      return '<button class="cs-card' + (s.id === sid ? ' on' : '') + '" type="button" data-sid="' + s.id + '">' +
        '<span class="cs-day">' + esc(s.date.replace('-', '.')) + '<em>' + esc(s.week) + '</em></span>' +
        '<span class="cs-main">' +
          '<span class="cs-time">' + esc(s.start) + ' – ' + esc(s.end) +
            '<span>' + s.dur + ' 分钟 · ' + s.count + ' 条' + (qn ? ' · ' + qn + ' 段摘录' : '') + '</span></span>' +
          (d ? '<span class="cs-title">' + esc(d.title) + '</span>' +
               '<span class="cs-sub">' + esc(d.tagline || '') + '</span>' : '') +
          '<span class="cs-mini">' + mini + '</span>' +
        '</span>' +
        '<span class="cs-go">逐字稿 →</span>' +
      '</button>';
    }

    // 选中日期后，只列出这一天有几场；不选中时右侧留一个提示
    function paintDay() {
      var box = document.getElementById('dayPanel');
      if (!day) {
        box.innerHTML = '<div class="cal-empty"><p>选好年份、月份与日期，<br>这里会列出当天的直播场次。</p></div>';
        return;
      }
      var list = byDay[day] || [];
      box.innerHTML =
        '<section class="cal-day-panel">' +
          '<div class="cal-day-head"><h3>' + (+day.slice(5, 7)) + ' 月 ' + (+day.slice(8, 10)) +
            ' 日 <small>' + esc(list[0] ? list[0].week : '') + '</small></h3>' +
            '<span>' + list.length + ' 场</span></div>' +
          '<div class="cs-list">' + list.map(sessionCard).join('') + '</div>' +
        '</section>';
    }

    function setDay(k) {
      day = k || '';
      sid = null;
      document.getElementById('transcriptBox').innerHTML = '';
      document.querySelectorAll('.cal-cell.sel').forEach(function (c) { c.classList.remove('sel'); });
      if (day) {
        var cell = document.querySelector('.cal-cell[data-day="' + day + '"]');
        if (cell) cell.classList.add('sel');
      }
      var sel = document.getElementById('calDay');
      if (sel) sel.value = day;
      paintDay();
    }

    function chooseSession(id) {
      sid = id;
      paintDay();
      paintTranscript(sid, null, '');   // 后面那个函数声明会提升到这里
      var box = document.getElementById('transcriptBox');
      var y = box.getBoundingClientRect().top + window.pageYOffset - 90;
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }

    app.innerHTML =
      '<section class="cal">' +
        '<div class="cal-head">' +
          '<div class="kicker">ARCHIVE CALENDAR</div>' +
          '<h2 class="cal-title">存档日历</h2>' +
          '<p class="cal-lead">自 ' + esc(D.meta.firstDate) + ' 起的直播逐字稿，按开播日归档。</p>' +
          '<div class="cal-facts">' +
            '<span><b>' + D.sessions.length + '</b> 场</span>' +
            '<span><b>' + dayKeys.length + '</b> 天</span>' +
            '<span><b>' + num(D.meta.total) + '</b> 条记录</span>' +
          '</div>' +
        '</div>' +
        '<div class="cal-top">' +
          '<div id="calBody">' + pickerHTML() + '</div>' +
          '<div id="dayPanel"></div>' +
        '</div>' +
        '<div id="transcriptBox"></div>' +
      '</section>';

    function goMonth(g) {
      if (!g || g === month || monthKeys.indexOf(g) < 0) return;
      month = g; day = ''; sid = null;
      document.getElementById('transcriptBox').innerHTML = '';
      document.getElementById('calBody').innerHTML = pickerHTML();
      paintDay();
    }

    // 「回到最新」不能只翻月份：已经在最新月时 goMonth 会直接 return，
    // 而且翻月后 day 为空，右侧仍是空白。这里直接定位到最新一天的场次并展开最新一场。
    function latestSid() {
      var k = dayKeys[dayKeys.length - 1];
      var list = k ? (byDay[k] || []) : [];
      if (!list.length) return null;
      var s = list.reduce(function (a, b) { return b.start >= a.start ? b : a; }, list[0]);
      var id = D.sessions.indexOf(s);
      return id >= 0 ? id : null;
    }
    function goLatest() {
      var k = dayKeys[dayKeys.length - 1];
      if (!k) return;
      var lm = k.slice(0, 7);
      if (month !== lm) {
        month = lm; day = ''; sid = null;
        document.getElementById('transcriptBox').innerHTML = '';
        document.getElementById('calBody').innerHTML = pickerHTML();
      }
      setDay(k);
      var id = latestSid();
      if (id != null) chooseSession(id);
    }

    var calBody = document.getElementById('calBody');
    calBody.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-goto]');
      if (b && !b.disabled) {
        var g = b.getAttribute('data-goto');
        if (g === 'latest') goLatest();
        else goMonth(g);
        return;
      }
      var cell = e.target.closest('.cal-cell.has');
      if (cell) setDay(cell.getAttribute('data-day'));
    });
    calBody.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var cell = e.target.closest && e.target.closest('.cal-cell.has');
      if (!cell) return;
      e.preventDefault();
      setDay(cell.getAttribute('data-day'));
    });
    // 三个下拉都是页面内状态，换了年月只重绘选择器，不动 hash
    calBody.addEventListener('change', function (e) {
      var t = e.target;
      if (t.id === 'calYear') {
        var ys = monthKeys.filter(function (k) { return k.slice(0, 4) === t.value; });
        goMonth(ys[ys.length - 1]);
      } else if (t.id === 'calMonth') {
        goMonth(month.slice(0, 4) + '-' + t.value);
      } else if (t.id === 'calDay') {
        setDay(t.value);
      }
    });
    document.getElementById('dayPanel').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-sid]');
      if (b) chooseSession(parseInt(b.getAttribute('data-sid'), 10));
    });

    paintDay();
    if (sid != null) paintTranscript(sid, opts.jumpT, opts.initialQ);
    setFoot();
  }

  /* ---------- 逐字稿区块：由存档页就地渲染进 #transcriptBox ---------- */
  // 换场次是异步的：分片还没到时可能已经点到另一场，用令牌只让最后一次的回调落地
  var trSeq = 0;

  function paintTranscript(sid, jumpT, initialQ) {
    if (sid == null || !D.sessions[sid]) return;
    var my = ++trSeq;
    stopLive();   // 同页换场次也要收掉上一场的定时器、滚动监听与播放条
    // 换场次时清掉上一场的检索词与筛选，别把旧状态带过来
    state.q = initialQ || '';
    state.hideEmpty = false;
    state.scOnly = false;
    var cur = sess(sid);
    state.learn = false;
    var startH = parseInt(cur.start.split(':')[0], 10);

    // 本场高频词要等逐字稿分片到位才算得出来：先占位，加载完再填（见 paintHotWords）
    var kwNav = '<div class="kw-slot"></div>';
    // 凌晨档（0 点到日出前）切到夜景，营造「深夜直播」的场景感
    setNightScene(startH < 6 || startH >= 20);

    // 跨零点场次：把 00:xx 视为 24:xx，保证时间比较正确。
    // 秒要算进去——只比到分钟的话，00:49:43 会落到 00:49:00 那条，前后差出十几行。
    function absMin(hms) {
      var p = hms.split(':');
      var m = parseInt(p[0], 10) * 60 + parseInt(p[1], 10) + (parseInt(p[2], 10) || 0) / 60;
      if (startH >= 12 && m < 12 * 60) m += 1440;
      return m;
    }

    // 摘录里记的时间，常常落在「那句话被识别切断的前半句」上：比如 01:09:00 只有
    // 「初めてビリビリと歴史。」，真正那句要到 13 秒后的下一行才有。只按时间落位，
    // 人看到的就是一句对不上的话，会以为跳错了。所以带 ?t= 时先按时间定个大概位置，
    // 再在这一小段里找正文最贴近摘录的那一行。
    function quoteAt(t) {
      // 摘录可能还没载入（首屏不再带全量）：这时只按时间落位，不阻塞跳转
      if (!AQ.rows) return null;
      for (var i = 0; i < AQ.rows.length; i++) {
        if (AQ.rows[i].s === sid && AQ.rows[i].t === t) return AQ.rows[i];
      }
      return null;
    }
    function normJP(s) {
      return s.replace(/[^\w\u3040-\u30ff\u4e00-\u9fff]/g, '');
    }
    function grams(s) {
      var g = {}, i;
      for (i = 0; i < s.length - 1; i++) g[s.slice(i, i + 2)] = 1;
      return g;
    }
    function dice(a, b) {
      var ka = Object.keys(a), kb = Object.keys(b), hit = 0, i;
      for (i = 0; i < ka.length; i++) if (b[ka[i]]) hit++;
      return (ka.length && kb.length) ? 2 * hit / (ka.length + kb.length) : 0;
    }
    // 取摘录正文的第一句（跳过开头的观众提问）当比对键
    function quoteKey(q) {
      if (!q) return '';
      var lines = q.jp.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i].replace(/^[\s—]+/, '').trim();
        if (!l || l.charAt(0) === '「') continue;
        var k = normJP(l);
        if (k.length >= 8) return k.slice(0, 40);
      }
      return '';
    }

    function jump(t, flash) {
      var rows = document.querySelectorAll('#trlist .tr');
      var want = absMin(t), start = -1;
      for (var i = 0; i < rows.length; i++) {
        if (absMin(rows[i].getAttribute('data-t')) >= want) { start = i; break; }
      }
      if (start < 0) return;

      var idx = start;
      var key = quoteKey(quoteAt(t));
      if (key) {
        var qg = grams(key);
        var rowGrams = function (i) { return grams(normJP(rows[i].querySelector('.jp').textContent)); };
        var base = dice(qg, rowGrams(start)), best = 0, scored = [];
        // 窗口卡在前后各 60 行（约一分钟），防止被同一段话说两遍的别处带走
        var from = Math.max(0, start - 60), to = Math.min(rows.length, start + 61);
        for (var j = from; j < to; j++) {
          var sc = dice(qg, rowGrams(j));
          scored.push([sc, j]);
          if (sc > best) best = sc;
        }
        // 阈值兜底：没明显更贴近就仍按时间落位；够像时取最早的命中行
        // （一句话常被切成好几条，落在第一条才像「从这里开始」）
        if (best >= 0.45 && best - base >= 0.12) {
          for (var k = 0; k < scored.length; k++) {
            if (scored[k][0] >= best * 0.85) { idx = scored[k][1]; break; }
          }
        }
      }

      var target = rows[idx];
      // 深链常常要跨几万像素，平滑滚动太久还会被后续布局打断，这里直接落位
      var y = target.getBoundingClientRect().top + window.pageYOffset - topPad();
      window.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
      if (flash) {
        target.classList.add('hit');
        setTimeout(function () { target.classList.remove('hit'); }, 3000);
      }
    }

    var hm = cur.start.split(':');
    var baseMin = parseInt(hm[0], 10) * 60 + parseInt(hm[1], 10);
    var ribbon = cur.ribbon.map(function (t, i) {
      var c = t < 0 ? '#241f1b' : tcolor(t);
      var abs = (baseMin + i) % 1440;
      var clock = String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0');
      return '<i style="background:' + c + '" data-t="' + clock + ':00" role="button" tabindex="0" title="' + clock +
        ' · ' + (t < 0 ? '无记录' : esc(tname(t))) + '" aria-label="跳到 ' + clock +
        ' · ' + (t < 0 ? '无记录' : esc(tname(t))) + '"></i>';
    }).join('');

    var legendSet = {};
    cur.ribbon.forEach(function (t) { if (t >= 0) legendSet[t] = 1; });
    var legend = Object.keys(legendSet).map(function (k) {
      var i = parseInt(k, 10);
      return '<span><i style="background:' + tcolor(i) + '"></i>' + esc(tname(i)) + '</span>';
    }).join('');

    var toc = cur.segs.map(function (g) {
      return '<button data-jump="' + esc(g.time.split('-')[0]) + '"><i style="background:' + tcolor(g.topic) +
        '"></i>' + esc(tname(g.topic)) + '<em>' + esc(g.time) + '</em></button>';
    }).join('');

    var topT = Object.keys(cur.topics)
      .sort(function (a, b) { return cur.topics[b] - cur.topics[a]; })
      .slice(0, 4).map(function (k) {
      var i = parseInt(k, 10);
      return '<span><b style="color:' + tcolor(i) + '">' + esc(tname(i)) + '</b> ' + cur.topics[k] + '</span>';
    }).join('');

    var qn = cur.qn || 0;   // 构建期算好的摘录条数，不用拉 quotes.json

    // 跟稿播放条挂在 #app 之外（见 index.html）：播放时页面会一直滚，
    // 控件必须始终够得到；拖动时只更新滑块，松手才定位，不会边拖边跳。
    document.getElementById('playerDock').innerHTML =
      '<div class="tl" id="tl">' +
        '<span class="tl-tag">' + esc(cur.date.replace('-', '.')) + ' 场</span>' +
        '<button class="tl-play" id="tlPlay" type="button" aria-label="播放逐字稿">' +
          '<span class="tl-ico">▶</span><span class="tl-label">跟稿播放</span></button>' +
        '<button class="tl-speed" id="tlSpeed" type="button" title="切换播放速度">1×</button>' +
        '<span class="tl-now" id="tlNow">' + esc(cur.start) + '</span>' +
        '<div class="tl-track" id="tlTrack" role="slider" tabindex="0" aria-label="时间轴" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
          '<div class="tl-ribbon">' + ribbon + '</div>' +
          '<div class="tl-head" id="tlHead"><i></i></div>' +
        '</div>' +
        '<span class="tl-end">' + esc(cur.end) + '</span>' +
      '</div>';

    document.getElementById('transcriptBox').innerHTML =
      '<section class="arch-single">' +
        '<button class="cal-backtop" type="button" data-backtop="1">↑ 回到日历</button>' +
        '<div class="shead">' +
          '<h2>' + esc(cur.date.replace('-', '.')) + ' <small>' + esc(cur.week) + '</small></h2>' +
          '<div class="meta"><span><b>' + esc(cur.start) + ' – ' + esc(cur.end) + '</b></span>' +
            '<span><b>' + cur.count + '</b> 条记录</span><span>约 <b>' + cur.dur + '</b> 分钟</span>' +
            (qn ? '<span><b>' + qn + '</b> 段摘录</span>' : '') +
            '<span>' + topT + '</span></div>' +
        '</div>' +
        '<div class="arch-note">以下是<b>机器识别 + 机器翻译</b>的记录；11 月 16 日起的场次已逐条人工校对，更早场次未经校对。' +
          '只作检索用——引用前请回原直播核对。</div>' +
        '<div class="ribbon-wrap"><div class="ribbon" id="ribbon">' + ribbon + '</div>' +
          '<div class="ribbon-legend">' + legend + '</div></div>' +
        (toc ? '<div class="toc">' + toc + '</div>' : '') +
        kwNav +
        '<div class="tools">' +
          '<label class="search"><span class="ico">⌕</span><input id="q" placeholder="搜索这一场，或直接全库检索…" autocomplete="off"></label>' +
          '<label class="toggle"><input type="checkbox" id="scOnly">只看 SC</label>' +
          '<label class="toggle"><input type="checkbox" id="hideEmpty">只看有译文</label>' +
          '<label class="toggle"><input type="checkbox" id="learnMode">隐藏译文</label>' +
        '</div>' +
        '<div class="count" id="count"></div>' +
        '<div class="trlist" id="trlist"></div>' +
      '</section>';

    var box = document.getElementById('transcriptBox');
    var input = document.getElementById('q');
    // 全站搜索的「查看全部逐字稿」会带上 ?q=；state.q 已在函数开头设好
    if (initialQ) input.value = initialQ;
    input.addEventListener('input', function () {
      state.q = input.value.trim();
      renderList(sid);
    });
    document.getElementById('hideEmpty').addEventListener('change', function (e) {
      state.hideEmpty = e.target.checked;
      renderList(sid);
    });
    document.getElementById('scOnly').addEventListener('change', function (e) {
      state.scOnly = e.target.checked;
      renderList(sid);
    });
    document.getElementById('learnMode').addEventListener('change', function (e) {
      state.learn = e.target.checked;
      document.getElementById('trlist').classList.toggle('learn', state.learn);
    });
    // 学习模式：译文默认藏起来，点日文那一条才展开，再点收回
    document.getElementById('trlist').addEventListener('click', function (e) {
      if (!state.learn) return;
      var jp = e.target.closest('.jp');
      if (!jp) return;
      var tr = jp.closest('.tr');
      if (tr) tr.classList.toggle('show-zh');
    });
    // 本场高频词由 paintHotWords 在分片到位后渲染，点击处理也绑在那里
    box.querySelector('[data-backtop]').addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    var tocEl = box.querySelector('.toc');
    if (tocEl) tocEl.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (b) jump(b.getAttribute('data-jump'));
    });

    bindTimeline(sid, cur, baseMin, jump);
    document.body.classList.add('has-player');   // 给固定播放条留出底部空间

    // ribbon / 时间轴里的小色块可点：跳到对应分钟
    box.querySelectorAll('.ribbon i[data-t]').forEach(function (i) {
      i.addEventListener('click', function () { jump(i.getAttribute('data-t')); });
      i.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(i.getAttribute('data-t')); }
      });
    });

    // 逐字稿与高频词都依赖分片：骨架先上，数据到了再填
    loadSession(sid).then(function (rows) {
      if (my !== trSeq) return;   // 已经切到别的场次，这次结果作废
      paintHotWords(box.querySelector('.kw-slot'), rows, jump);
      renderList(sid, my);
      syncTimelineRows();   // 行渲染完成后，把当前句引用交给时间轴
      if (jumpT) {
        // route() 末尾还会把页面滚到顶上，所以等它执行完（下一帧）再落位
        requestAnimationFrame(function () { jump(jumpT, true); });
        // 直接从外部链接打开时，浏览器可能在 load 之后再校正一次滚动位置，这里补一次
        window.addEventListener('load', function () {
          var hit = document.querySelector('#trlist .tr.hit');
          if (!hit) return;
          var y = hit.getBoundingClientRect().top + window.pageYOffset - topPad();
          if (Math.abs(window.pageYOffset - y) > 120) jump(jumpT, false);
        }, { once: true });
      }
    }).catch(function () {
      if (my !== trSeq) return;
      var cnt = document.getElementById('count');
      if (cnt) cnt.textContent = '逐字稿加载失败';
      var list = document.getElementById('trlist');
      if (list) list.innerHTML = '<div class="empty">这一场的逐字稿没能加载，请刷新重试。</div>';
    });
    setFoot();
  }

  // 本场高频词：只取日文里的汉字词与片假名，按出现次数排。
  // 与预设话题不同，这里反映的是「这一场她反复在说什么」。
  // 占位块本身变成 .kw-nav，点击跳它第一次出现的那一行。
  var HOT_STOP = {};
  ('こと もの です ます した して する れる ない この その あと から まで でも だけ ' +
   '自分 今日 時間 人 今 思う いう できる くれる ある いる よう とき 本当 ちょっと ' +
   'そう あの これ それ どこ なん まだ また ここ けど いい ください').split(/\s+/)
    .forEach(function (w) { if (w) HOT_STOP[w] = 1; });

  function paintHotWords(slot, rows, jump) {
    if (!slot || !rows) return;
    var wordN = {};
    rows.forEach(function (r) {
      var s = r.jp || '';
      (s.match(/[\u4e00-\u9fff]{2,4}/g) || []).forEach(function (w) {
        if (!HOT_STOP[w]) wordN[w] = (wordN[w] || 0) + 1;
      });
      (s.match(/[ァ-ヶー]{3,8}/g) || []).forEach(function (w) {
        if (!HOT_STOP[w]) wordN[w] = (wordN[w] || 0) + 1;
      });
    });
    var hot = Object.keys(wordN).filter(function (w) { return wordN[w] >= 3; })
      .sort(function (a, b) { return wordN[b] - wordN[a]; }).slice(0, 14);
    if (!hot.length) { slot.parentNode && slot.parentNode.removeChild(slot); return; }

    slot.className = 'kw-nav';
    slot.innerHTML = '<span class="kw-label">本场高频</span>' + hot.map(function (w) {
      return '<button class="kw" type="button" data-w="' + esc(w) + '">' + esc(w) +
        '<i>' + wordN[w] + '</i></button>';
    }).join('');
    slot.addEventListener('click', function (e) {
      var b = e.target.closest('.kw');
      if (!b) return;
      var w = b.getAttribute('data-w'), hit = null;
      for (var i = 0; i < rows.length; i++) {
        if ((rows[i].jp || '').indexOf(w) >= 0) { hit = rows[i]; break; }
      }
      if (!hit) return;
      slot.querySelectorAll('.kw').forEach(function (x) { x.classList.toggle('on', x === b); });
      jump(hit.t, true);
    });
  }

  /* ---------- 文字时间轴 ----------
     当前高亮的句子由「视口中最靠上、且已滚过顶部安全线的那一行」决定，
     与手动滚动、拖动时间轴、跟稿播放共用同一套 update()，不维护多个真相。
     行引用在每次 renderList 后由 syncTimelineRows() 重新采集。 */
  var SPEEDS = [1, 2, 4];
  function bindTimeline(sid, cur, baseMin, jump) {
    var track = document.getElementById('tlTrack');
    var head = document.getElementById('tlHead');
    var now = document.getElementById('tlNow');
    var playBtn = document.getElementById('tlPlay');
    var speedBtn = document.getElementById('tlSpeed');
    if (!track || !head || !playBtn) return;

    var st = {
      sid: sid, cur: cur, baseMin: baseMin, rows: [], idx: 0,
      speed: 0, playing: false, dragging: false, jump: jump,
      track: track, head: head, now: now,
      playBtn: playBtn, speedBtn: speedBtn
    };
    live.reading = st;

    function rowTime(row) { return row ? row.getAttribute('data-t') : ''; }
    function clockAt(frac) {
      var total = (cur.dur || 1) * 60;
      var sec = Math.round(frac * total);
      var abs = (baseMin * 60 + sec) % 86400;
      return String(Math.floor(abs / 3600)).padStart(2, '0') + ':' +
        String(Math.floor(abs / 60) % 60).padStart(2, '0') + ':' +
        String(abs % 60).padStart(2, '0');
    }

    // 把时间轴游标与「当前时刻」文字更新到某一行 / 某个比例
    function paint(frac, t) {
      var f = Math.max(0, Math.min(1, frac));
      head.style.left = (f * 100).toFixed(3) + '%';
      track.setAttribute('aria-valuenow', Math.round(f * 100));
      now.textContent = t || clockAt(f);
    }

    // 找离视口顶部安全线最近的一行，作为「正在读」的那句
    function nearestRow() {
      var rows = st.rows;
      if (!rows.length) return -1;
      var top = topPad();
      var idx = 0;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].getBoundingClientRect().top - top <= 4) idx = i;
        else break;
      }
      return idx;
    }

    function markRow(i) {
      var rows = st.rows;
      if (!rows.length) return;
      for (var j = 0; j < rows.length; j++) rows[j].classList.remove('reading');
      var row = rows[i];
      if (!row) return;
      row.classList.add('reading');
      var sec = sessionSec(rowTime(row), parseInt(cur.start.split(':')[0], 10));
      var frac = (sec - (baseMin * 60)) / ((cur.dur || 1) * 60);
      paint(frac, rowTime(row).slice(0, 5));
    }

    // 滚动时只做读操作 + 写两个 style，rAF 节流，避免高频触发布局
    var ticking = false;
    function onScroll() {
      if (st.playing || st.dragging || ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        if (!live.reading || live.reading !== st) return;
        var i = nearestRow();
        if (i < 0) return;
        st.idx = i;
        markRow(i);
      });
    }
    live.onScroll = onScroll;
    window.addEventListener('scroll', onScroll, { passive: true });

    function fracAt(clientX) {
      var r = track.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    }
    // 拖动 / 点击轨道：比例 → 时间 → 落位
    function seekByX(clientX) {
      var frac = fracAt(clientX);
      paint(frac, null);
      var rows = st.rows;
      if (!rows.length) return;
      var want = baseMin * 60 + frac * (cur.dur || 1) * 60;
      // 映射到本场记录里最接近的那一条（baseMin 已是开场当天的总分钟）
      var sh = parseInt(cur.start.split(':')[0], 10);
      var best = 0, bestD = Infinity;
      for (var i = 0; i < rows.length; i++) {
        var s = sessionSec(rowTime(rows[i]), sh);
        var d = Math.abs(s - want);
        if (d < bestD) { bestD = d; best = i; }
      }
      st.idx = best;
      markRow(best);
      var y = rows[best].getBoundingClientRect().top + window.pageYOffset - topPad();
      window.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
    }
    function down(e) {
      if (e.button != null && e.button !== 0) return;
      st.dragging = true;
      pause();
      // 按下只预览滑块位置：页面不滚动，高亮行不变，才能一口气拖到目标
      var f = fracAt(e.clientX);
      paint(f, clockAt(f));
      track.setPointerCapture && track.setPointerCapture(e.pointerId);
    }
    function move(e) {
      if (!st.dragging) return;
      var f = fracAt(e.clientX);
      paint(f, clockAt(f));   // 拖动中只更新滑块与时间，不定位
    }
    function up(e) {
      if (!st.dragging) return;
      st.dragging = false;
      if (e && e.type !== 'pointercancel') seekByX(e.clientX);  // 松手才跳到那一行
    }
    track.addEventListener('pointerdown', down);
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', up);
    track.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      pause();
      var f = st.idx / Math.max(1, st.rows.length - 1);
      f = Math.max(0, Math.min(1, f + (e.key === 'ArrowRight' ? 0.02 : -0.02)));
      paint(f, null);
      var r = track.getBoundingClientRect();
      seekByX(r.left + f * r.width);
    });

    function setPlayUI() {
      playBtn.classList.toggle('on', st.playing);
      playBtn.querySelector('.tl-ico').textContent = st.playing ? '❚❚' : '▶';
      playBtn.querySelector('.tl-label').textContent = st.playing ? '暂停' : '跟稿播放';
      playBtn.setAttribute('aria-label', st.playing ? '暂停' : '播放逐字稿');
    }
    function pause() {
      if (!st.playing) return;
      st.playing = false;
      if (live.timer) { clearInterval(live.timer); live.timer = 0; }
      setPlayUI();
    }
    st.pause = pause;
    function step() {
      if (!live.reading || live.reading !== st || !st.rows.length) { pause(); return; }
      if (st.idx >= st.rows.length - 1) { pause(); return; }
      st.idx++;
      var row = st.rows[st.idx];
      var y = row.getBoundingClientRect().top + window.pageYOffset - topPad() - 40;
      window.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
      markRow(st.idx);
    }
    function play() {
      if (!st.rows.length) return;
      if (st.idx >= st.rows.length - 1) st.idx = 0;
      st.playing = true;
      setPlayUI();
      step();
      if (live.timer) clearInterval(live.timer);
      live.timer = setInterval(step, 1100 / SPEEDS[st.speed]);
    }
    playBtn.addEventListener('click', function () { st.playing ? pause() : play(); });
    speedBtn.addEventListener('click', function () {
      st.speed = (st.speed + 1) % SPEEDS.length;
      speedBtn.textContent = SPEEDS[st.speed] + '×';
      if (st.playing) { clearInterval(live.timer); live.timer = setInterval(step, 1100 / SPEEDS[st.speed]); }
    });
    setPlayUI();

    // 供 renderList 重渲染后重新采集行；尽量把当前位置按时间落回近似行
    st.resync = function () {
      var keepT = st.rows.length ? rowTime(st.rows[Math.min(st.idx, st.rows.length - 1)]) : '';
      st.rows = [].slice.call(document.querySelectorAll('#trlist .tr'));
      st.idx = 0;
      if (keepT) {
        var sh = parseInt(cur.start.split(':')[0], 10);
        var want = sessionSec(keepT, sh);
        for (var i = 0; i < st.rows.length; i++) {
          if (sessionSec(rowTime(st.rows[i]), sh) >= want) { st.idx = i; break; }
        }
      }
      if (st.playing && !live.timer) {
        live.timer = setInterval(step, 1100 / SPEEDS[st.speed]);
      }
      markRow(st.idx);
    };

    // 先把游标放在开场
    paint(0, cur.start.slice(0, 5));
  }
  function syncTimelineRows() { if (live.reading && live.reading.resync) live.reading.resync(); }

  function rowHTML(r, q, showSession) {
    var s = sess(r.s);
    var prefix = showSession ? esc(s.date.replace('-', '.')) + ' ' : '';
    return '<div class="tr' + (r.zh ? '' : ' nozh') + '" data-t="' + esc(r.t) + '">' +
      '<div class="t">' + prefix + esc(r.t) + '</div>' +
      '<div class="dot" style="background:' + tcolor(r.tp) + '"></div>' +
      '<div><div class="jp">' + mark(r.jp, q) + '</div>' +
      (r.zh ? '<div class="zh">' + mark(r.zh, q) + '</div>' : '') + '</div>' +
    '</div>';
  }

  // 一条 SC 块：观众原文作引用，她的回应缩进成跟帖，保留中日对照与回原稿链接。
  // SC 在逐字稿里没有精确边界，用摘录里带 sc 的条目是最可靠的来源。
  function scBlock(q) {
    var sc = '<div class="qsc">' +
      (q.sc.name ? '<b>' + esc(q.sc.name) + '</b>' : '') +
      '<p>' + esc(q.sc.text) + '</p></div>';
    return '<article class="tr scrow" data-t="' + esc(q.t) + '">' +
      '<div class="t">' + esc(q.t) + '</div>' +
      '<div class="dot" style="background:' + tcolor(0) + '"></div>' +
      '<div><div class="screply">' + sc +
        '<p class="jp">' + esc(q.jp) + '</p>' +
        (q.zh ? '<p class="zh">' + esc(q.zh) + '</p>' : '') +
        '<a class="scback" href="#/archive/' + q.s + '?t=' + encodeURIComponent(q.t) +
          '">在原稿中定位 →</a>' +
      '</div></div>' +
    '</article>';
  }

  // sid 是本场；tok 是 paintTranscript 的竞态令牌（筛选/输入框的回调不传，取当前值）。
  // 无检索词只渲染本场分片；有检索词是「全库检索」，那时才需要把全部分片拉齐。
  function renderList(sid, tok) {
    var box = document.getElementById('trlist');
    var cnt = document.getElementById('count');
    if (!box || !cnt) return;
    if (tok != null && tok !== trSeq) return;
    var q = state.q;
    var here = RC.sess[sid];

    // 「只看 SC」：本场带 sc 的摘录按时间排，先看搜索词能命中哪些再渲染
    if (state.scOnly) {
      // SC 来自摘录，首屏没有；切换到这个视图时才取 quotes.json
      if (!AQ.rows) {
        var stok = trSeq;
        cnt.textContent = '正在载入摘录…';
        box.innerHTML = '<div class="empty">正在载入本场的 SC…</div>';
        loadQuotes().then(function () {
          if (stok === trSeq) renderList(sid, stok);
        }).catch(function () {
          if (stok === trSeq) box.innerHTML = '<div class="empty">SC 数据没能加载，请重试。</div>';
        });
        return;
      }
      var scs = AQ.rows.filter(function (x) {
        return x.s === sid && x.sc &&
          (!q || (x.sc.text + ' ' + x.jp + ' ' + (x.zh || '')).toLowerCase().indexOf(q.toLowerCase()) >= 0);
      }).sort(function (a, b) { return hmsSec(a.t) - hmsSec(b.t); });
      cnt.textContent = '本场 ' + scs.length + ' 条 SC' + (q ? '（含「' + q + '」）' : '');
      box.innerHTML = scs.map(scBlock).join('') ||
        '<div class="empty">本场没有符合条件的 SC。</div>';
      syncTimelineRows();
      return;
    }

    if (!q) {
      if (!here) {
        cnt.textContent = '正在加载…';
        box.innerHTML = '<div class="empty">正在加载本场逐字稿…</div>';
        return;
      }
      var rows = here.filter(function (r) { return !state.hideEmpty || r.zh; });
      cnt.textContent = rows.length + ' 条' + (state.hideEmpty ? '（已隐藏无译文）' : '');
      box.innerHTML = rows.map(function (r) { return rowHTML(r, '', false); }).join('') ||
        '<div class="empty">没有符合条件的记录。</div>';
      syncTimelineRows();
      return;
    }

    // 全库检索要跨场次：分片没齐就先并发拉，边拉边刷新进度
    if (!RC.all) {
      var total = RC.total || D.sessions.length;
      cnt.textContent = '正在载入全库逐字稿 ' + RC.done + '/' + total + '…';
      box.innerHTML = '<div class="empty">检索要遍历全部场次，正在载入逐字稿…</div>';
      loadAll(function (done, n) {
        var c = document.getElementById('count');
        if (c && state.q) c.textContent = '正在载入全库逐字稿 ' + done + '/' + n + '…';
      }).then(function () {
        if (tok != null && tok !== trSeq) return;
        if (state.q) renderList(sid, tok);
      });
      return;
    }

    var ql = q.toLowerCase();
    var hits = [];
    for (var i = RC.all.length - 1; i >= 0; i--) {   // 倒序：新场次先出
      var r = RC.all[i];
      if (state.hideEmpty && !r.zh) continue;
      if (r.jp.toLowerCase().indexOf(ql) >= 0 || (r.zh && r.zh.toLowerCase().indexOf(ql) >= 0)) {
        hits.push(r);
        if (hits.length >= 400) break;
      }
    }
    cnt.textContent = '全库检索「' + q + '」：' + hits.length + (hits.length >= 400 ? '+' : '') + ' 条';
    box.innerHTML = hits.map(function (r) { return rowHTML(r, q, true); }).join('') ||
      '<div class="empty">没有找到包含「' + esc(q) + '」的记录。</div>';
    syncTimelineRows();
  }

  /* ---------- about ---------- */
  function renderAbout() {
    var diaryN = D.meta.diaryCount || (D.diary ? D.diary.length : 0);
    app.innerHTML =
      '<section class="about">' +
        '<div class="kicker">ABOUT THIS ARCHIVE</div>' +
        '<h2>关于<span class="accent">这份存档</span></h2>' +
        '<p class="about-lead">把 <b>' + esc(D.meta.streamer) + '</b> 直播里说过的话留下来：逐字稿、每场日记、' +
          '值得单独记下的段落。中日对照，按场次整理，可全文检索。</p>' +
        '<div class="facts">' +
          '<div><b>' + D.meta.sessionCount + '</b><span>场直播</span></div>' +
          '<div><b>' + num(D.meta.total) + '</b><span>条记录</span></div>' +
          '<div><b>' + D.meta.quoteCount + '</b><span>段摘录</span></div>' +
          '<div><b>' + diaryN + '</b><span>篇日记</span></div>' +
          '<div><b>' + (D.meta.dynamicCount || 0) + '</b><span>条动态</span></div>' +
          '<div class="range">' + D.meta.firstDate + ' — ' + D.meta.lastDate + '</div>' +
        '</div>' +

        '<div class="box"><h3>主播与直播</h3>' +
          '<p>主播 <b>' + esc(D.meta.streamer) + '</b>　B 站主页：' +
            '<a href="https://space.bilibili.com/2094031249" target="_blank" rel="noopener">space.bilibili.com/2094031249</a></p>' +
          '<p>直播间：' +
            '<a href="https://live.bilibili.com/22748536" target="_blank" rel="noopener">live.bilibili.com/22748536</a></p>' +
          '<p>本站是个人维护的非官方记录，与主播本人、B 站官方均无关。</p>' +
        '</div>' +

        '<div class="box"><h3>这里有什么</h3>' +
          '<p><b>逐字稿</b>　按场次排列的中日对照记录，可全文检索。</p>' +
          '<p><b>日记</b>　每场一篇，记当晚的话题、观众来信与随口讲到的小知识。</p>' +
          '<p><b>动态</b>　B 站公开动态的中日对照，附在各自那篇日记开头。</p>' +
          '<p><b>摘录</b>　从各场挑出的完整段落，保留中日原文与语境说明。</p>' +
        '</div>' +

        '<div class="box warn"><h3>引用前请留意</h3>' +
          '<p>逐字稿与译文由自动识别、自动翻译生成；11 月 16 日起的场次已逐条人工校对，更早场次尚未逐条校对，仍可能有误听、断句和专名偏差。' +
            '逐字稿适合当检索索引，不是可靠引文。</p>' +
          '<p>日记与摘录经人工整理，仍可能与原话有出入。要确认她到底说了什么，请回原直播核对。</p>' +
          '<p>直播内容的著作权归主播所有。若主播或相关权利人要求，本站会删除相应内容。</p>' +
        '</div>' +
      '</section>';
    setFoot();
  }

  route();
})();

/* ---------- 首次访问须知 ----------
   原来首页置顶一条常驻声明，现在改成首次访问弹一次：
   「已知晓」只关掉这一次，「不再显示」记进 localStorage，之后不再打扰。
   文案在 index.html 里，这里只管弹与关——改文案不用动脚本。 */
(function () {
  'use strict';
  var KEY = 'la_notice_v1';
  var dlg = document.getElementById('noticeDlg');
  var mask = document.getElementById('noticeMask');
  var ok = document.getElementById('noticeOk');
  var never = document.getElementById('noticeNever');
  if (!dlg || !mask || !ok) return;

  function dismissed() {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  function close(persist) {
    if (persist) { try { localStorage.setItem(KEY, '1'); } catch (e) {} }
    dlg.hidden = true;
    mask.hidden = true;
    document.body.classList.remove('notice-open');
  }
  if (dismissed()) return;

  dlg.hidden = false;
  mask.hidden = false;
  document.body.classList.add('notice-open');
  ok.focus();

  ok.addEventListener('click', function () { close(false); });
  if (never) never.addEventListener('click', function () { close(true); });
  // 正文里的「关于本站 →」是 hash 路由：点之前先把浮层收掉，别挡着目标页
  dlg.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#/"]');
    if (a) close(false);
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !dlg.hidden) close(false);
  });
})();

/* ---------- 氛围视差 / 伪 3D（性能版） ----------
   鼠标位置经一阶低通后，每帧只写几个 fixed 层的 inline transform：
   · 不写 :root 自定义属性 —— 那会让整棵文档树每帧重新计算样式；
   · 光晕用位移而不是改渐变中心 —— 后者每帧都要重绘整屏渐变；
   · 卡片倾斜每 6 帧更新一次（自带 .22s transition，肉眼无差别）；
   · 变换只落在 will-change:transform 的合成层上，不触发布局与重绘。
   精确指针 + 未开启「减少动态效果」时才运行，鼠标停下即停 rAF。 */
(function () {
  'use strict';
  var mq = window.matchMedia ? window.matchMedia.bind(window) : null;
  var reduce = mq && mq('(prefers-reduced-motion: reduce)').matches;
  var fine = mq && mq('(hover: hover) and (pointer: fine)').matches;
  if (reduce || !fine) return;

  var amb = document.querySelector('.ambient');
  if (!amb) return;
  var far = amb.querySelector('.amb-far');
  var scene = amb.querySelector('.amb-scene');
  var light = amb.querySelector('.amb-light');
  var embers = amb.querySelector('.amb-embers');

  // 首页卡片由 hash 路由动态渲染，DOM 换掉后要重新抓引用
  var cards = [];
  function collect() {
    cards = [];
    var a = document.querySelector('.hero-links');
    var b = document.querySelector('.hs-tilt');
    if (a) cards.push({ el: a, k: -0.3 });
    if (b) cards.push({ el: b, k: -0.45 });
  }
  collect();
  var appEl = document.getElementById('app');
  if (appEl && window.MutationObserver) {
    new MutationObserver(collect).observe(appEl, { childList: true });
  } else {
    window.addEventListener('hashchange', collect);
  }

  var W = window.innerWidth, H = window.innerHeight;
  window.addEventListener('resize', function () {
    W = window.innerWidth; H = window.innerHeight;
  }, { passive: true });

  var tx = 0, ty = 0, cx = 0, cy = 0, raf = 0, tick = 0;
  function f(n) { return n.toFixed(2); }

  function apply() {
    var dx = -cx * 16, dy = -cy * 11, rx = -cy * 2.6, ry = cx * 3.4;
    scene.style.transform =
      'perspective(1100px) rotateX(' + f(rx * 0.55) + 'deg) rotateY(' + f(ry * 0.55) + 'deg) ' +
      'translate3d(' + f(dx) + 'px,' + f(dy) + 'px,0) scale(1.08)';
    far.style.transform =
      'perspective(1400px) rotateX(' + f(rx * 0.3) + 'deg) rotateY(' + f(ry * 0.3) + 'deg) ' +
      'translate3d(' + f(dx * 0.32) + 'px,' + f(dy * 0.26) + 'px,0) scale(1.2)';
    embers.style.transform = 'translate3d(' + f(dx * 3) + 'px,' + f(dy * 2) + 'px,0)';
    light.style.transform = 'translate3d(' + f(cx * 0.48 * W) + 'px,' + f(cy * 0.42 * H) + 'px,0)';

    // 卡片降频：约 100ms 一次，中间由 CSS transition 补齐
    if (++tick % 6 === 0) {
      for (var i = 0; i < cards.length; i++) {
        cards[i].el.style.transform =
          'perspective(900px) rotateX(' + f(rx * cards[i].k) + 'deg) rotateY(' + f(ry * cards[i].k) + 'deg)';
      }
    }
  }
  function frame() {
    cx += (tx - cx) * 0.13;
    cy += (ty - cy) * 0.13;
    apply();
    if (Math.abs(tx - cx) > 0.005 || Math.abs(ty - cy) > 0.005) raf = requestAnimationFrame(frame);
    else raf = 0;
  }
  window.addEventListener('pointermove', function (e) {
    tx = (e.clientX / W - 0.5) * 2;
    ty = (e.clientY / H - 0.5) * 2;
    if (!raf) raf = requestAnimationFrame(frame);
  }, { passive: true });
})();

/* ---------- 悬浮背景音乐 ----------
   本地音频 + 自建控件：默认不播放，音量默认很小（30%），可拖动调节。
   折叠状态、音量与循环记在 localStorage；播放状态不记忆，每次进站都是关闭。 */
(function () {
  'use strict';
  var box = document.getElementById('bgm');
  var audio = document.getElementById('bgmAudio');
  if (!box || !audio) return;
  audio.src = 'audio/mata-ashita.m4a';   // preload=none，赋值本身不会发请求
  function $(id) { return document.getElementById(id); }
  var fold = $('bgmFold'), panel = $('bgmPanel'), play = $('bgmPlay'), loop = $('bgmLoop');
  var bar = $('bgmBar'), vol = $('bgmVol'), volNum = $('bgmVolNum'), now = $('bgmNow'), dur = $('bgmDur');
  var KEY = 'hibane-bgm-v1';
  var st = { collapsed: window.innerWidth < 720, vol: 30, loop: true };
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
  if (saved && typeof saved === 'object') {
    if (typeof saved.collapsed === 'boolean') st.collapsed = saved.collapsed;
    if (typeof saved.vol === 'number') st.vol = Math.max(0, Math.min(100, Math.round(saved.vol)));
    if (typeof saved.loop === 'boolean') st.loop = saved.loop;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} }
  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fill(el, ratio) { el.style.setProperty('--p', (ratio * 100).toFixed(2) + '%'); }
  var chev = fold.querySelector('.bgm-chev');
  function paint() {
    box.classList.toggle('is-collapsed', st.collapsed);
    box.classList.toggle('is-playing', !audio.paused);
    fold.setAttribute('aria-expanded', String(!st.collapsed));
    fold.title = st.collapsed ? '展开播放器' : '收起播放器';
    panel.setAttribute('aria-hidden', String(st.collapsed));
    if ('inert' in panel) panel.inert = st.collapsed;
    if (chev) chev.textContent = st.collapsed ? '<' : '>';
    play.setAttribute('aria-label', audio.paused ? '播放背景音乐' : '暂停背景音乐');
    play.setAttribute('aria-pressed', String(!audio.paused));
    loop.classList.toggle('is-on', st.loop);
    loop.setAttribute('aria-pressed', String(st.loop));
    audio.loop = st.loop;
    audio.volume = st.vol / 100;
    vol.value = st.vol;
    volNum.textContent = st.vol;
    fill(vol, st.vol / 100);
  }
  function tick() {
    now.textContent = fmt(audio.currentTime);
    var d = audio.duration;
    if (d && isFinite(d)) {
      dur.textContent = fmt(d);
      bar.value = Math.round(audio.currentTime / d * 1000);
      fill(bar, audio.currentTime / d);
    }
  }
  function start() {
    var p = audio.play();
    if (p && p.catch) p.catch(function () { play.title = '浏览器拦下了播放，请再点一次'; });
  }
  fold.addEventListener('click', function () { st.collapsed = !st.collapsed; save(); paint(); });
  play.addEventListener('click', function () {
    if (audio.paused) start(); else audio.pause();
    paint();
  });
  loop.addEventListener('click', function () { st.loop = !st.loop; save(); paint(); });
  vol.addEventListener('input', function () { st.vol = Number(vol.value); save(); paint(); });
  bar.addEventListener('input', function () {
    var d = audio.duration;
    if (!d || !isFinite(d)) return;
    audio.currentTime = Number(bar.value) / 1000 * d;
    fill(bar, Number(bar.value) / 1000);
    now.textContent = fmt(audio.currentTime);
  });
  audio.addEventListener('timeupdate', tick);
  audio.addEventListener('loadedmetadata', tick);
  audio.addEventListener('play', paint);
  audio.addEventListener('pause', paint);
  paint();
  tick();
  fill(bar, 0);
})();

/* ---------- 全站搜索 ----------
   独立于 hash 路由的浮层：一次遍历 window.DATA，跨逐字稿 / 摘录 / 日记 / 场次
   做不区分大小写的子串匹配。逐字稿一万多条，输入做 120ms 防抖、每组只渲染
   前几条，避免边打字边拼大量 DOM；结果直接跳到对应页面并带上定位参数。 */
(function () {
  'use strict';
  var D = window.DATA;
  var RC = window.LARC;   // 逐字稿分片缓存，由主模块持有
  // 与主模块各在一个 IIFE，这边也要有一份多 tag 兼容函数
  function qTags(q) { return q.tags && q.tags.length ? q.tags : [q.tag].filter(Boolean); }
  var openBtn = document.getElementById('searchOpen');
  var dlg = document.getElementById('searchDlg');
  var mask = document.getElementById('searchMask');
  var input = document.getElementById('searchInput');
  var box = document.getElementById('searchResults');
  var cnt = document.getElementById('searchCount');
  var scope = document.getElementById('searchScope');
  if (!D || !openBtn || !dlg || !mask || !input || !box) return;

  var LIMIT = { rec: 8, quote: 6, diary: 5, session: 4 };
  var items = [], sel = -1, timer = 0;

  function escS(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function markEsc(s, q) {
    var out = '', lower = s.toLowerCase(), ql = q.toLowerCase(), p = 0, i;
    while (ql && (i = lower.indexOf(ql, p)) >= 0) {
      out += s.slice(p, i) + '<mark>' + s.slice(i, i + ql.length) + '</mark>';
      p = i + ql.length;
    }
    return out + s.slice(p);
  }
  function snip(text, q, len) {
    var s = String(text || '').replace(/\s+/g, ' ');
    var i = s.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return s.slice(0, len);
    var from = Math.max(0, i - 22);
    return (from ? '…' : '') + s.slice(from, from + len) + (s.length > from + len ? '…' : '');
  }
  function has(text, ql) { return String(text || '').toLowerCase().indexOf(ql) >= 0; }
  function sessOf(i) { return D.sessions[i] || { date: '', dateLong: '', week: '' }; }
  function dText(d) { return [d.title, d.tagline, d.summary, (d.body || []).join(' ')].join(' '); }

  // 搜索语法：tag:话题  date:11-24  sc:关键词  dm:关键词  jp:日文  zh:译文，
  // 可以混用，剩下的词仍按全文检索。没有前缀时行为和以前完全一样。
  function parseQuery(raw) {
    var f = { tag: '', date: '', sc: '', dm: '', jp: '', zh: '' }, words = [];
    String(raw || '').trim().split(/\s+/).forEach(function (tok) {
      var m = /^(tag|date|sc|dm|jp|zh):(.+)$/i.exec(tok);
      if (m) f[m[1].toLowerCase()] = m[2];
      else if (tok) words.push(tok);
    });
    return { f: f, text: words.join(' ') };
  }

  if (scope) {
    scope.textContent = D.meta.total.toLocaleString('en-US') + ' 条逐字稿 · ' +
      D.meta.quoteCount + ' 段摘录 · ' + D.meta.diaryCount + ' 篇日记';
  }

  function collect(q, ctx) {
    ctx = ctx || parseQuery(q);
    var F = ctx.f, ql = ctx.text.toLowerCase(), term = ctx.text;
    var groups = [], recTotal = 0;
    var quoteOnly = !!(F.tag || F.sc || F.dm);   // tag / sc / dm 是摘录专属字段

    var recPending = false;
    if (!quoteOnly) {
      var recRows = [];
      var src = RC.all;
      // 分片没拉齐时先跳过逐字稿：摘录、日记、场次立刻出结果，正文等加载完再补
      if (!src) recPending = true;
      else for (var i = src.length - 1; i >= 0; i--) {   // 新场次优先
        var r = src[i], s = sessOf(r.s);
        if (F.date && s.date.indexOf(F.date) < 0 && s.dateLong.indexOf(F.date) < 0) continue;
        if (F.jp && !has(r.jp, F.jp)) continue;
        if (F.zh && !has(r.zh, F.zh)) continue;
        if (ql && !has(r.jp, ql) && !has(r.zh, ql)) continue;
        recTotal++;
        if (recRows.length < LIMIT.rec) {
          // 命中日文就主显示日文，命中译文就主显示译文，避免高亮落在看不见的地方
          var main = has(r.zh, term) ? r.zh : (r.jp || r.zh || '');
          var sub = has(r.zh, term) ? (r.jp || '') : (r.zh || '');
          recRows.push({
            label: '逐字稿', meta: s.date + ' ' + r.t,
            text: snip(main, term, 68), sub: sub ? snip(sub, term, 68) : '',
            href: '#/archive/' + r.s + '?t=' + encodeURIComponent(r.t)
          });
        }
      }
      if (recTotal) groups.push({ name: '逐字稿', total: recTotal, rows: recRows });
    }

    var qRows = [], qTotal = 0, quotePending = false;
    // 摘录在 quotes.json：没取到就先跳过这一组，取到后重跑
    if (!RC.quotesReady()) quotePending = !RC.quotesFailed();
    else D.quotes.forEach(function (x) {
      var scText = x.sc ? (x.sc.name + ' ' + x.sc.text) : '';
      var dmText = x.dm ? (x.dm.name + ' ' + x.dm.text) : '';
      var refText = scText + ' ' + dmText;
      if (F.tag && !qTags(x).some(function (t) { return t.toLowerCase().indexOf(F.tag.toLowerCase()) >= 0; })) return;
      if (F.date && x.date.indexOf(F.date) < 0) return;
      if (F.sc && scText.toLowerCase().indexOf(F.sc.toLowerCase()) < 0) return;
      if (F.dm && dmText.toLowerCase().indexOf(F.dm.toLowerCase()) < 0) return;
      if (F.jp && !has(x.jp, F.jp)) return;
      if (F.zh && !has(x.zh, F.zh)) return;
      if (ql && !has(refText + ' ' + x.jp + ' ' + x.zh + ' ' + x.note + ' ' + qTags(x).join(' '), ql)) return;
      qTotal++;
      if (qRows.length < LIMIT.quote) {
        var qmain = has(x.zh, term) ? x.zh : (has(x.jp, term) ? x.jp : x.zh);
        var qsub = qmain === x.zh ? x.jp : x.zh;
        qRows.push({
          label: '摘录 · ' + x.tag, meta: x.date + ' ' + x.t,
          text: snip(qmain, term, 68), sub: snip(qsub, term, 68),
          href: '#/quotes?focus=' + encodeURIComponent(x.id)
        });
      }
    });
    if (qTotal) groups.push({ name: '摘录', total: qTotal, rows: qRows });

    var diaryPending = false;
    if (!quoteOnly && !F.jp && !F.zh) {
      // 正文在 diary/<key>.json：还没拉齐时先按标题 / 摘要出结果，正文到了再补
      if (!RC.diaryReady()) diaryPending = true;
      var dRows = [], dTotal = 0;
      D.diary.forEach(function (d) {
        if (F.date && d.date.indexOf(F.date) < 0 && d.dateLong.indexOf(F.date) < 0) return;
        if (ql && !has(dText(d), ql)) return;
        dTotal++;
        if (dRows.length < LIMIT.diary) dRows.push({
          label: '日记', meta: d.dateLong + ' ' + d.week,
          text: snip(d.title + ' — ' + (d.summary || ''), term, 68),
          sub: '', href: '#/diary/' + encodeURIComponent(d.key)
        });
      });
      if (dTotal) groups.push({ name: '日记', total: dTotal, rows: dRows });

      var sRows = [], sTotal = 0;
      D.sessions.forEach(function (s) {
        if (F.date && s.date.indexOf(F.date) < 0 && s.dateLong.indexOf(F.date) < 0) return;
        if (!F.date && !has(s.date + ' ' + s.dateLong + ' ' + s.week + ' ' + s.start + ' ' + s.end, ql)) return;
        sTotal++;
        if (sRows.length < LIMIT.session) sRows.push({
          label: '场次', meta: s.week,
          text: s.dateLong + ' · ' + s.start + ' – ' + s.end + ' · ' + s.count + ' 条记录',
          sub: '', href: '#/archive/' + s.id
        });
      });
      if (sTotal) groups.push({ name: '场次', total: sTotal, rows: sRows });
    }

    return {
      groups: groups, recTotal: recTotal, term: term,
      recPending: recPending, quotePending: quotePending, diaryPending: diaryPending
    };
  }

  function render(q) {
    items = []; sel = -1;
    if (!q) {
      box.innerHTML = '<div class="sd-empty">输入关键词，检索逐字稿、摘录、日记与场次。</div>';
      if (cnt) cnt.textContent = '输入关键词开始检索';
      return;
    }
    var ctx = parseQuery(q), res = collect(q, ctx), html = '', total = 0;
    res.groups.forEach(function (g) {
      total += g.total;
      html += '<div class="sd-group"><div class="sd-gtitle"><b>' + escS(g.name) + '</b>' +
        '<span>' + g.total + ' 条' + (g.total > g.rows.length ? ' · 显示前 ' + g.rows.length + ' 条' : '') + '</span></div>';
      g.rows.forEach(function (row) {
        var idx = items.length;
        items.push(row);
        html += '<button class="sd-item" data-i="' + idx + '" type="button">' +
          '<div class="si-top"><em>' + escS(row.label) + '</em>' + escS(row.meta) + '</div>' +
          '<div class="si-text">' + markEsc(escS(row.text), ctx.text) + '</div>' +
          (row.sub ? '<div class="si-sub">' + markEsc(escS(row.sub), ctx.text) + '</div>' : '') + '</button>';
      });
      html += '</div>';
    });
    if (res.recTotal > LIMIT.rec) {
      var k = items.length;
      items.push({ href: '#/archive/' + D.sessions[D.sessions.length - 1].id + '?q=' + encodeURIComponent(ctx.text) });
      html += '<div class="sd-group"><button class="sd-item" data-i="' + k + '" type="button">' +
        '<div class="si-text">在逐字稿里查看全部 ' + res.recTotal + ' 条结果 →</div></button></div>';
    }
    var pending = [];
    if (res.quotePending) pending.push('摘录');
    if (res.diaryPending) pending.push('日记正文');
    if (res.recPending) pending.push('逐字稿');
    var hasPending = pending.length > 0;

    if (html) box.innerHTML = html;
    else if (!hasPending) box.innerHTML = '<div class="sd-empty">没有找到「' + escS(q) + '」。</div>';
    else box.innerHTML = '';
    if (cnt) cnt.textContent = '共 ' + total + ' 条结果';

    // 大块数据还在路上：先把已有的组摆出来，后台拉完再自动重跑一遍
    if (hasPending) {
      box.insertAdjacentHTML('beforeend',
        '<div class="sd-group"><div class="sd-note" id="sdProg">正在载入' +
          pending.join(' / ') + '…</div></div>');
      if (cnt) cnt.textContent = (total ? '已找到 ' + total + ' 条，' : '') +
        pending.join('/') + '还在载入…';

      var jobs = [];
      if (res.quotePending) jobs.push(RC.loadQuotes());
      if (res.diaryPending) jobs.push(RC.loadAllDiary());
      if (res.recPending) jobs.push(RC.loadAll(function (done, n) {
        var el = document.getElementById('sdProg');
        if (el) el.textContent = '正在载入逐字稿 ' + done + '/' + n + '…';
      }));
      // 单项失败不重试，避免反复渲染；成功的部分下一次渲染就会补进结果
      Promise.all(jobs.map(function (p) { return p.catch(function () {}); })).then(function () {
        if (!dlg.hidden && input.value.trim() === q) render(q);
      });
    }
  }

  function highlight() {
    var els = box.querySelectorAll('.sd-item');
    for (var i = 0; i < els.length; i++) els[i].classList.toggle('on', i === sel);
    if (sel >= 0 && els[sel]) els[sel].scrollIntoView({ block: 'nearest' });
  }
  function open() {
    dlg.hidden = false; mask.hidden = false;
    document.body.classList.add('search-open');
    input.value = ''; render('');
    setTimeout(function () { input.focus(); }, 0);
  }
  function close() {
    dlg.hidden = true; mask.hidden = true;
    document.body.classList.remove('search-open');
    input.blur();
  }
  function go(it) {
    close();
    location.hash = it.href;
  }

  openBtn.addEventListener('click', open);
  mask.addEventListener('click', close);
  var closeBtn = document.getElementById('searchClose');
  if (closeBtn) closeBtn.addEventListener('click', close);
  input.addEventListener('input', function () {
    clearTimeout(timer);
    var v = input.value.trim();
    timer = setTimeout(function () { render(v); }, 120);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      sel = e.key === 'ArrowDown' ? (sel + 1) % items.length : (sel - 1 + items.length) % items.length;
      highlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      var it = items[sel >= 0 ? sel : 0];
      if (it) go(it);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  box.addEventListener('click', function (e) {
    var b = e.target.closest('.sd-item');
    if (!b) return;
    var it = items[parseInt(b.getAttribute('data-i'), 10)];
    if (it) go(it);
  });
  window.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      dlg.hidden ? open() : close();
      return;
    }
    if (e.key === 'Escape' && !dlg.hidden) { close(); return; }
    if (e.key !== '/' || e.metaKey || e.ctrlKey || !dlg.hidden) return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|TEXTAREA/.test(tag)) return;
    if (document.getElementById('q')) return;   // 存档页有自己的搜索框
    e.preventDefault();
    open();
  });
})();

/* ---------- 回到顶部 ----------
   滚过一屏才出现（首屏不占位），点击回顶；开关状态用 class + aria 同步，
   隐藏时不进 Tab 序列。滚动监听 passive，并合到一次 rAF 里处理。 */
(function () {
  'use strict';
  var btn = document.getElementById('toTop');
  if (!btn) return;
  var quiet = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var THRESHOLD = 480;
  var shown = false, ticking = false;

  function setShown(on) {
    if (on === shown) return;
    shown = on;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-hidden', String(!on));
    btn.tabIndex = on ? 0 : -1;
  }
  function update() {
    ticking = false;
    setShown((window.pageYOffset || document.documentElement.scrollTop) > THRESHOLD);
  }
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  }, { passive: true });

  btn.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: quiet ? 'auto' : 'smooth' });
    btn.blur();   // 回顶后按钮会隐藏，焦点别留在看不见的元素上
  });

  update();
})();

/* ---------- 离线可用 ----------
   manifest 动态注入，避免打包器改写路径；SW 同源注册，失败也不影响站点正常使用。 */
(function () {
  'use strict';
  var link = document.createElement('link');
  link.rel = 'manifest';
  link.href = 'manifest.webmanifest';
  document.head.appendChild(link);
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  });
})();
