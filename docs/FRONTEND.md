# FRONTEND.md — 站点前端交互与视觉

> 装饰插图、氛围层性能、话题分类、搜索、存档日历、时间轴与各类视图。数据侧见 [SITE.md](SITE.md)。
> 主入口与文档地图见 [AGENT.md](../AGENT.md)。

---

### 装饰插图（2026-11-14 起）

`site/brand/` 的装饰图由 `tools/prepare_art.py <场景图> <白底立绘图>` 从原图生成；另有 `python tools/prepare_art.py --far` 从 `home-night.webp` 预渲染远景层。不要直接改产物：

| 文件 | 用途 |
|---|---|
| `scene-girls.webp` | 非首页栏目的氛围底图（`.amb-scene`，压暗 + 视差），1024px 宽 / WebP q72，约 85 KB；关于页头图已下线（2026-11-15 用户指定，避免和背景重复） |
| `home-night.webp` | 首页专属夜景，由 `body.is-home` 切换 `--scene`，左侧留白给文字；1280px 宽 / q72，约 17 KB |
| `home-night-far.webp` | 首页远景层（`.amb-far`），`blur(7px)` / `brightness(.82)` / `saturate(.85)` 已烘进图，约 6 KB |

**右下角立绘已下线**（2026-11-15 用户指定）：`character-full.webp` 连同 `.amb-char` 层、呼吸动画、`body.scrolled` 与 `--rot` 变量一并移除，站点不再发布这张图。`prepare_art.py` 仍保留白底立绘的处理能力备用，但产物不要放回 `site/brand/`；若要恢复立绘，白底必须按**边缘连通域**抠，不能按「接近白色」整体抠——衣服上的白花、眼白、皮肤高光也是浅色，会被一起吃掉。

鼠标视差写在 `index.html` 的氛围层 + `style.css` + `app.js` 末尾那个独立 IIFE 里，`prefers-reduced-motion` 与触屏会自动降级成静态。

### 氛围层性能口径（2026-11-15 优化掉帧后定下）

改氛围层时别把下面几条改回去，否则鼠标一动就掉帧：

- **不写 `:root` 自定义属性做逐帧视差**。JS 每帧只改 `.amb-far` / `.amb-scene` / `.amb-embers` / `.amb-light` 这几个层的 inline `transform`；原来写在 `document.documentElement` 上的 `--dx/--dy/--rx/--ry/--lx/--ly` 会让整棵文档树每帧重算样式。卡片（`.hero-links` / `.hs-tilt`）倾斜每 6 帧更新一次，靠 `.22s transition` 补中间帧；首页是动态渲染的，用 `MutationObserver` 重新抓这两个元素。
- **光晕用位移不用改渐变中心**。`.amb-light` 是固定 1120px 的渐变圆，靠 `translate3d` 跟随鼠标；若改回 `radial-gradient(... at var(--lx) var(--ly))`，每帧都要重绘整屏渐变。
- **运行时不做大面积 blur / backdrop-filter**。远景模糊预烘进 `home-night-far.webp`；sticky header 与音乐面板不用 `backdrop-filter`（背景每帧在动，会强制逐帧重采样），改用接近不透明的实色。
- 各层带 `will-change:transform` 固定在合成层上；`grain` 用 `translateZ(0)` 单独提升，避免跟着背景重绘。低通系数 `0.13`、收敛阈值 `0.005`，鼠标停下即停 rAF。

### 话题分类（2026-11-15 扩充到 23 类）

- `tools/common.py` 的 `TOPICS` 是关键词表，`classify()` **按表顺序取第一个命中的正则**，都不中就落 `日常杂聊`。新增的 7 类（宠物/动物、音乐/唱歌、文字/词源、应援/比赛、周年/纪念、开播/收尾、中日文化）一律排在原有类别之后，避免抢走既有分类；正则要足够具体，别用「とり」「歌」这种会吃掉大量无关记录的宽词。
- **改表后必须重跑 `python tools/export.py`**：每条记录的 `tp` 和每场的 `topics` / `ribbon` / `segs` 都是导出时算好写进 `site/data/sessions/*.json` 的。只改表不重导出，新类别永远 0 命中，而且 `OTHER_ID` 后移会让旧 `tp` 语义错位。重导出是幂等的，场次与记录正文不变，不要手改 sessions 文件。
- 前端 `D.topics` 由 `common.TOPIC_NAMES` 生成，首页「话题标签」数字就是它的长度。
- **首页「话题分布」统计条已撤掉**（2026-11-24 用户定稿）：23 类里「日常杂聊」占 72.5%（14081/19424），关键词逐行分类救不回来——换 17 类仍是 70%，加上下文滑窗虽能压到 29%，但数字变成「段落」语义且打赏/SC 会膨胀到 18%。`records[].tp` 仍用于逐字稿 ribbon 色带、legend、场次话题计数，**不要删 TOPICS 表或改导出流程**。

### 全站搜索与页脚（2026-11-15）

- 搜索是 `index.html` 里**独立于 hash 路由**的浮层（`.sd`）+ `app.js` 末尾独立 IIFE，数据全来自 `window.DATA`，分逐字稿 / 摘录 / 日记 / 场次四组。输入 120ms 防抖、每组限量；一万多条逐字稿每次全量扫一遍但只渲染前 8 条。命中日文就主显示日文、命中译文就主显示译文，两行都高亮。
- 入口：导航右侧按钮、`Ctrl/Cmd+K`；非存档页按 `/` 也打开（存档页的 `/` 仍聚焦它自己的 `#q`）。↑↓ 选择、回车打开、Esc / 点遮罩关闭。
- 跳转参数：逐字稿 `#/archive/<sid>?t=<时间>`，摘录 `#/quotes?focus=<qid>`（`quoteCard` 带 DOM id，`renderQuotes` 放开筛选、渲染到目标并加 `.hit` 描边），日记 `#/diary/<key>`，场次 `#/archive/<sid>`；「查看全部逐字稿」走 `#/archive/<sid>?q=<关键词>`，`renderArchive` 预填 `#q` 并跑一次全库检索。
- 页脚：GitHub 仓库 `konohana-saku8/live-archive` 是必须项，另有主播主页 / 直播间、著作权与准确性提示、更新信息。**不标注整理者 / 作者姓名**（用户 2026-11-15 要求，避免蹭热度嫌疑），**不写备案 / 登记类信息**，也不要把实现细节搬回页脚（写作口径第 11 条）。
- 站内提到主播时统一写全名 **火羽ひのめ**（`profile.json` 的 `streamer` / `title` / `desc` 是唯一来源）；「主页」「主播主页」这类链接文字本身保持原样，不要改成名字。观众 SC 原文与逐字稿里的「火羽」是原始内容，不改。

### 存档日历（2026-11-15，用户第三轮定稿：紧凑年月日选择器）

- **存档只有一个页面** `renderArchivePage()`：`#/archive` 出日期选择器 → 选日期在 `#dayPanel` 列出当天场次 → 点场次由 `paintTranscript()` 把原来的逐字稿就地渲染进 `#transcriptBox`。选日、选场、翻月都是页面内状态，**不换 hash、不跳路由**；不要再加侧栏场次列表 `.slist`，也不要「当月全部 · N 场」这种整月列表。
- **标准输入框 + 小月历**：左侧 `.cal-picker` 顶部是 `#calYear` / `#calMonth` / `#calDay` 三个 `<select>`（年 → 月 → 日联动，`change` 事件委托在 `#calBody` 上），下面配一个周一起始的紧凑 7 列日历，格内只有日期数字和一颗「有存档」圆点（`.cal-mark`），不放场次链接；右侧是当天的场次清单。整页宽 940px，给右下悬浮音乐抽屉留空档。
- 年份下拉只列有场次的年份；月份列 1–12 月，**没有记录的月份 disabled**（选项里带场数）；日期列当月每一天，只有有直播的日子可选，选项带场数与「今天」。切年/月会清空已选日期与逐字稿（`goMonth()` 只接受 `monthKeys` 里的月份）。
- 外部旧链接仍要能用：`#/archive/<sid>`、`?t=`、`?q=` 走同一个页面，只是把日历翻到那天并直接选中该场（搜索/摘录/日记/首页的深链都依赖它）。`?m=YYYY-MM`、`?d=YYYY-MM-DD` 可深链到指定月份/日期。
- 同一天可能有两场（白天场 + 深夜场），必须按 `dayKey(s) = dateLong.replace(/\./g,'-')` 聚合，不能按 `date`（`MM-DD` 无年份）或一对一映射。
- **不要展示「最长连续开播 N 天」**：那是用户自己记录的连续性，火羽本来就每天直播，写在这里没有意义（用户 2026-11-15 明确要求删掉，相关的 UTC 日序号工具也一并移除了）。
- 换场次时 `paintTranscript()` 要重置 `state.q` / `state.hideEmpty` / `state.scOnly`，否则上一场的检索词与筛选会带进新场。`?t=` 的摘录校准落位逻辑（`quoteAt` / `dice` / `jump`）原样保留。

### 逐字稿时间轴 / SC 视图 / 热力图（2026-11-24）

- **文字时间轴**（`bindTimeline()`，`app.js`）：每条 `.tr` 带 `data-t`，游标位置由「视口里已滚过吸顶安全线的最后一行」决定，手动滚动、拖轨道、点 ribbon、跟稿播放共用 `markRow()` 一套更新。`syncTimelineRows()` 在每次 `renderList()` 后重新采集行引用（搜索/筛选会重建 DOM）。播放按钮按 `SPEEDS=[1,2,4]` 切速、逐行 scrollTo + 加 `.reading` 高亮；定时器与滚动监听统一挂在 `live` 对象上，`stopLive()` 在换路由时清理。
- **播放条固定 + 拖动口径**（2026-11-24 用户指定）：播放/倍速/时间/轨道做成**底部固定播放条**（类网易云网页版），播放时页面一直滚，控件始终够得到。拖动时 `pointerdown`/`pointermove` 只更新滑块与时间字（`paint(f, clockAt(f))`），**松手 `pointerup` 才 `seekByX()` 滚动定位**——边拖边跳会让滑块跟着页面跑掉。窄屏把音乐抽屉与回顶按钮抬到播放条上方；`body.has-player` 预留底部留白。
- **背景音乐**（2026-11-25 用户指定）：默认关闭、音量默认 30%（可调并记在 localStorage），`preload="none"`，只有点播放键才取音频。用 `site/audio/mata-ashita.m4a`（64 kbps AAC，约 1.2 MB）+ `app.js` 自建 `<audio>` 控件；**不要再换回网易云外链 iframe**——它的音量写死在跨域 iframe 内部（初始化 0.8），父页面既不能用参数也不能用消息调整。`copy_static()` 负责把 `audio/` 带进产物，`_headers` 给 `/audio/*` 缓存规则。
- **播放条的 fixed 陷阱**：`index.html` 的 `<div id="playerDock">` 必须挂在 `<main id="app">` **之外**。`playPageIn()` 给 main 加的 `.page-in` 动画带 `transform`，会创建 fixed 包含块；播放条若放在 main 内会被定位到文档底部（实测 `getBoundingClientRect().top ≈ 43000`）而不是视口。`stopLive()` 清空 dock 与 `.has-player`，`paintTranscript()` 开头也调它，换场次同样清理。
- **时间映射**：`baseMin` 已是开播当天的总分钟，`want = baseMin*60 + frac*dur*60`；跨零点场次（开播 ≥12 点）用 `sessionSec()` 给 00:xx 的行 +86400。别在 `want` 里再额外加开播小时，会重复。
- **只看 SC**：逐字稿里**没有**精确的 SC 边界（话题 0 只是「打赏/SC」关键词分类，她的回应散落在后续行）。所以 `scBlock()` 用本场 `D.quotes` 里带 `sc` 字段的摘录当 SC 单元：观众原文作引用、她的 `jp/zh` 作跟帖，附「在原稿中定位」深链。数据来源可靠、不靠猜边界。
- **凌晨场夜景**：`paintTranscript()` 按开播小时 `<6 || >=20` 调 `setNightScene()` 给 body 加 `.is-night`（复用 `home-night.webp`），换路由由 `route()` 统一清除。
- **首页开播热力图** `heatmapHTML()`：最近 16 周方格，`byDay` 取每天场数定深浅，有直播的格子链到 `#/archive?d=YYYY-MM-DD`。不写「最长连续开播 N 天」（口径同上）。
- **换页淡入 / 阅读进度**：`playPageIn()` 给 `#app` 加 `.page-in`（`prefers-reduced-motion` 下跳过）；`updateProgress()` 把滚动比例写到 `#readprog` 的 `scaleX`。两者都在 `index.html` / `style.css` 里有对应节点与样式。
- 自检脚本 `.state/verify_ui.js`（headless Chrome + CDP）覆盖以上交互与 390 窄屏溢出，改动这部分前端后可跑一遍；`.state/` 不入库。

### 问答 / 时间线 / 摘录话题贴 / 学习模式 / 卡片 / 搜索语法 / PWA（2026-11-24）

- **主题页与问答页已撤掉**（2026-11-26 用户定稿）：导航、首页入口、独立路由与 CSS 全部移除；旧的 `#/topics` / `#/qa` 链接分别回到首页与摘录页。带 SC 的摘录仍留在摘录页与时间线里，问答只是时间线的一种内容类型，不再有独立页面。`site/data/themes.json` 保留作源数据，但 `gen_data.py` 不再把它算进 `data.js` 的首屏数据。
- **统一时间线** `#/timeline`：按日期把日记、动态、摘录、问答混排在一根竖轴上。注意**顶层 `D` 没有 dynamics**——动态在 `D.diary[].dyn` 里，从那里取。五种筛选写死在 `renderTimeline()` 的 `kinds` 表里；问答条目也跳到 `#/quotes?focus=<id>`；每条都带回到原页的链接。
- **摘录 = 逐条话题贴**（2026-11-26 用户定稿）：一条摘录就是「讲同一件事的一组逐字稿条目」，正文与档案页**共用同一份逐字稿数据**。`gen_data` 把选段输出为 `lines:[{t,jp,zh}]`：有 `sel` 时按行号精确取行，老条目由 `topic_lines()` 按首末句圈段；前端 `loadQuotes()` 再从 `lines` 拼出 `jp/zh` 供搜索 / 复制 / 卡片 / 首页共用。`quoteCard()` 把每条渲染成 `.qpost`（时间戳 + 日文 + 中文），**SC / 弹幕引用（二选一）**放正文开头、校勘说明放正文末尾；引用块 `.qsc` 默认是 SC 暖色胶囊，`.qsc.qdm` 是弹幕冷色胶囊 +「弹幕」角标，数据侧 `sc` / `dm` 字段见 [EXCERPT_RULES.md](EXCERPT_RULES.md)。块的**标题行** `.qhead` 放圆角 tag + 简短概括 `title` + 日期 + 复制/卡片按钮：左边不再有独立的日期时间栏，因为每句 `.qpost` 自带时间戳。`title` 优先读源文件手写的 `title`，没有就由 `gen_data.quote_title()` 从正文首句提炼（跳过「嗯/那个」与感谢 SC 的开头）；要改标题在源摘录里写 `title` 字段，别改前端。**沉浸阅读功能已整个删除**（按钮、状态、浮层、CSS、自检断言），不要再放回。行距按阅读密度收紧：`.qpost` / `.tr` 的 padding 和 line-height 都刻意压小，不要改回展示柜式的大间距。
- **金句卡片** `makeQuoteCard()`：纯 canvas 画竖版 PNG（720 宽，高度按行数算），底图 `brand/scene-girls.webp` 同源，`toBlob` + 对象 URL 下载。底图是 16:9 横图，**按卡片宽度等比缩放、顶部对齐**（下沿淡出），不要 `drawImage(img,0,0,W,H)` 铺满整张竖版，否则横向会被挤扁。文案、配色都写死在函数里；改版式只需改这一处，不要引第三方库。
- **本场高频词** `paintTranscript()`：对本场 `r.jp` 提 2–4 字汉字词与 3–8 字片假名词，过滤 `stopW` 后取频次前 14。点击跳到该词第一次出现的行（用 `jump(hit.t, true)` 的高亮，不另造机制）。它反映「这一场反复说什么」，与预设话题表是两套粒度。
- **日语学习模式**：`state.learn` + `#learnMode` 开关，`renderList()` 不动 DOM 结构，靠 `.trlist.learn .tr .zh{display:none}` 隐藏译文；点 `.jp` 给该行加 `.show-zh` 展开。SC 块同属 `.tr`，自然生效。
- **搜索语法**：`parseQuery()` 支持 `tag:` `date:` `sc:` `jp:` `zh:` 前缀，可混用。高亮词取 `ctx.text`（parseQuery 的字段），**不是 `ctx.term`**——`term` 是 `collect()` 的返回字段，写错会让 `markEsc()` 收到 undefined 并抛错。
- **PWA**：`site/sw.js` + `site/manifest.webmanifest` 没有被 index.html 引用，靠 `gen_data.py::copy_static()` 手拷进 `.build/public/` 才会进 dist。manifest 由 `app.js` 末尾动态注入 `<link>`（避免 Vite 改写路径），SW 在 load 后同源注册。缓存名 `CACHE='live-archive-v3'`，**改 sw.js 内容时把版本号 +1**，否则旧缓存不会被清。SW 只在 HTTPS/localhost 生效；缓存失败不影响站点。
