# SITE.md — live-archive 站点与工具链

> 目录结构、命令、Cloudflare 部署、切场规则、数据 schema。前端交互见 [FRONTEND.md](FRONTEND.md)。
> 主入口与文档地图见 [AGENT.md](../AGENT.md)。

---

## 3. live-archive（最终产物）

### 结构

```
config.toml               本机配置（db 路径、切场阈值、时间窗），不入库
config.example.toml       配置模板：复制成 config.toml 后按机器修改
publish.cmd               一键入口（导出+构建+本地提交）
package.json              Vite 构建依赖（vite 本身）
vite.config.mjs           dev server / dist 构建；启动时自动调 tools/gen_data.py
site/
  index.html              {{TITLE}} {{DESC}} {{STREAMER}} 构建时替换，版本号构建后注入
  assets/app.js           ES module；前端 hash 路由：#/ #/diary #/quotes #/timeline #/archive #/about（#/rhythm 重定向到摘录页整场视图）
  assets/style.css
  brand/                 头像、favicon、氛围底图、首页夜景（--scene 切换）与预模糊远景
  data/profile.json       主播名 / 标题 / 描述
  data/diary.json         直播日记（人工写，最新在最前）
  data/dynamics.json      B 站动态（export_dynamics.py 从 live-capture 导出，**禁止手改**）
  data/quotes.json        摘录（编辑器 / 人工挑，按 session + sel 或 date + t 挂场次）
  data/tags.json          tag 注册表（编辑器写）
  data/overrides.json     逐字稿单行覆盖（编辑器 / 人工写，含 orig / why）
  data/rhythm.json        摘录页「整场」视图数据（tools/gen_rhythm.py 生成；完整逐字稿按原时间顺序，回应段落挂 refs 引用，散装按时间插入）
  data/rhythm_links.json  手工指定的「哪些逐字稿回应哪些 SC / 弹幕」；sc 填 SC id，dm 填手工核对过的 name/text/t（不收翻译弹幕）；lines 可跨段，生成时按连续区间拆开、各自留在原时间位置
  data/sessions/*.json    每场直播一份，脚本导出，**禁止手改**
  data/subs/*.json        双语字幕轨（进 git，随站点发布，按场次分文件）
editor/                   本地编辑器（Electron 壳 + Python 后端 + 页面）
  desktop/main.js         Electron 主进程：起后端、开窗、窗口图标 editor/icon.png
  server.py               本地 HTTP 后端，只监听 127.0.0.1
  index.html / app.js     编辑器界面与交互
.build/                   构建前的数据暂存（gitignore，gen_data.py 生成）
tools/
  common.py               配置、读库、切场、话题分类（TOPICS 关键词表）
  overrides.py            逐行覆盖的读取与套用（export / export_subs 共用）
  export.py               db → site/data/sessions/
  export_dynamics.py      live-capture 的 dynamics 表 → site/data/dynamics.json（默认 ssh 只读手机库）
  gen_rhythm.py           db + 手工映射 → site/data/rhythm.json（逐字稿全量按时间顺序，回应段落挂统一 refs：SC + 手工核对的弹幕；改场次改 KEY）
  gen_data.py             site/data → .build/：data.js、版本哈希、subs、静态资源、rhythm.json
  export_subs.py          db → site/data/subs/（gen_data.py 调用，再复制进 .build/public/subs）
  build.py                调 Vite 构建 dist/（等价于 npm run build）
  publish.py              导出 → 构建 → commit（默认不 push）
dist/                     构建产物，不入库，CI 重新生成
.state/                   日志、截图、临时 dump、config_data.toml（gitignore）
.data/                    枢纽数据库（**未入 git**，见坑 2）
```

### 命令

```bash
cd D:/HibaneHinome/live-archive

# 编辑器（下播整理入口；读 site/data，不会自动从 DB 导出新场次）
npm run editor                            # 起 Electron 壳 + Python 后端
npm run editor:install                    # 首次装 Electron

# 导出（幂等：内容没变不落盘）
python tools/export.py
python tools/export.py --dry-run          # 先看会改什么，「清掉」必须是 0
python tools/export_dynamics.py           # B 站动态：默认 ssh 只读手机 capture 库
python tools/export_dynamics.py --db PATH # 改读本地 capture.db（通常为空，仅调试）

# 把近期 overrides 回写 DB（默认原文+译文；写前自动备份到 .data/backups/）
python tools/writeback_overrides.py --since 2026-11-13 --dry-run
python tools/writeback_overrides.py --since 2026-11-13
python tools/writeback_overrides.py --since 2026-11-13 --translation-only   # 只写译文

# 构建 / 本地预览
npm install                               # 首次或依赖变动后
npm run dev                               # 开发模式：http://localhost:8799/（改 site/data 自动重产并刷新）
npm run build                             # 产物 dist/（等价于 python tools/build.py）
python tools/build.py                     # 页脚「更新于」= 本次构建时刻，自动写入，无需手改
BUILD_TIME="2026.11.10 22:00" python tools/build.py   # 覆盖构建时刻（复现/调试用）
python -m http.server 8799 -d dist        # 固定 8799（预览产物；dev server 也用这个端口，别同时开）

# 发布（review 模式：只到本地提交）
publish.cmd                 # 等价于 python tools/publish.py
publish.cmd --push          # 人工确认之后才推
publish.cmd --force         # 刚下播就想发，跳过「静默 10 分钟」判断
publish.cmd --dry-run
```

`publish.py` 的判断顺序：最后一条记录静默 < `quiet_min`（10 分钟）→ 认为还在播，退出；导出无变化 → 不提交；**默认不推送**。

数据产出由 `vite.config.mjs` 在 dev/build 启动时调用 `tools/gen_data.py` 完成（`data.js`、版本哈希、
subs 都落在 `.build/public/`），Vite 只负责打包与发布，产物路径与版本号规则和旧版一致。

CI：`.github/workflows/pages.yml`，`site/**` / `tools/**` / 构建配置有推送后自动
`npm ci && npm run build` + deploy，约 40 秒生效。CI 无数据库，沿用已入库的 `site/data/subs`。

### Cloudflare Pages（第二部署，2026-11-24 起）

产物是纯静态 + hash 路由 + 全相对路径（`base:'./'`），挂在 `pages.dev` 根路径上不用改任何路径。

- **构建配置**：Build command `npm ci && npm run build`，输出目录 `dist`，框架预设选 None。
  环境变量 `NODE_VERSION=22`、`PYTHON_VERSION=3.12`（仓库根已放 `.node-version` / `runtime.txt` 兜底；
  **`runtime.txt` 里只能写 `3.12`**，Cloudflare 不认 Heroku 的 `python-3.12` 写法）。
  Vite 构建前会调 `tools/gen_data.py`，所以构建机必须有 Python 3.11+，这点和 GitHub Actions 一致。
- **必须关 Rocket Loader**（Speed → Optimization）：它会把 `type="module"` 脚本改为异步加载，
  影响首屏渲染与 `navigator.serviceWorker.register('sw.js')` 的时机，症状是偶发白屏或 PWA 装不上。
  Auto Minify 已被 Cloudflare 下线，无需处理。
- **`site/_headers`**：由 `gen_data.py::copy_static()` 拷进产物根目录，Cloudflare 读取后生效
  （GitHub Pages 会原样当静态文件发布，无人引用，无副作用）。它负责三件事：
  - `/`、`/index.html`、`/sw.js` → `no-cache`，保证新版本能发出去；
  - `/assets/*` → `max-age=31536000, immutable`，因为三个文件 URL 上都带 `?v=<hash>`；
  - `/manifest.webmanifest` → 显式 `application/manifest+json`，避免 Cloudflare 按 octet-stream 返回导致 PWA 不装。
  **注意规则会合并**：同一路径命中多条时 `Cache-Control` 会被逗号拼起来，所以 `/*` 里只放安全头，缓存只写具体路径。
- **体积**：Cloudflare 自动 Brotli；`data.js` 已降到 85 KB（只留索引层），摘录 / 日记正文 / 逐字稿按需加载。
  单文件上限 25 MB、单次部署 2 万文件，当前 111 个文件 7.5 MB（最大是 `brand/avatar.png` 0.57 MB），余量充足。
- **两种发法**：① 连 Git 仓库，push 自动构建（预览分支也给独立 URL）；② 本地构建后
  `npx wrangler pages deploy dist --project-name live-archive`，不依赖构建机的 Node/Python 版本。
- **Service Worker**：`CACHE` 版本号改动要 +1；预缓存从 `index.html` 里读 `assets/*?v=` 的真实地址，
  避免和无版本号的那份各下一遍。

### 切场规则（`common.py`）

- 相邻记录间隔 > 30 分钟 → 新的一场（跨零点不拆）
- 少于 20 条的片段 → 当作误录丢弃
- 开场时间不在 `time_window` 内 → 跳过；`time_window_keep` 里登记的场次例外（见坑 5）
- 话题靠 `TOPICS` 关键词表归类，顺即是优先级；表是照这批直播调的**经验规则**，不是通用分类器
- 版本哈希 = data.js + app.js + style.css 三者，任一改动都会让浏览器重新取

### 读写边界（防止手改被覆写）

| 路径 | 谁写 | 能手改吗 |
|---|---|---|
| `.data/translation_history.db` | LiveTranslate / danmaku-it / 编辑器「拉取手机库」；回写用 `writeback_overrides.py` | 不直接手改；只读查询，靠外部备份 |
| `site/data/sessions/*.json` | `tools/export.py` | **不能**。整份覆盖，且会删除库里切不出来的场次 |
| `site/data/subs/*.json`、`subs/index.json` | `tools/export_subs.py` | **不能**。不在本次 index 里的场次会被删除 |
| `site/data/quotes.json` | 编辑器 / 人工 | 能。编辑器保存时备份到 `.state/editor-backups/` |
| `site/data/overrides.json` | 编辑器 / 人工 | 能。逐行修正，`export.py` / `export_subs.py` 时套用 |
| `site/data/tags.json` | 编辑器 | 能 |
| `site/data/diary.json` | 人工 | 能；编辑器不管日记 |
| `site/data/dynamics.json` | `tools/export_dynamics.py` | **不能**，重新导出会覆盖 |
| `.build/` | `tools/gen_data.py` | **不能**，生成物 |
| `dist/` | Vite | **不能**，生成物 |
| `tools/fixes_data.json` / `tools/asr_fixes.py` | 编辑器 / 人工 | 能；全局修正，下次 export 生效 |

- **`npm run build` 只跑 gen_data + Vite，不跑 export**。在编辑器里改的 `overrides.json` 必须先 `export.py`（或点编辑器「重建站点」）才会进 sessions 和 dist；只 build 的话，页面仍是旧译文。**编辑器保存摘录 / 行内修改本身也不会写 sessions**：摘录写 `quotes.json`，行内修改写 `overrides.json`，sessions 只在 export 时被重写。
- **`export.py` 会删文件**：`site/data/sessions/` 里存在、但这次从 DB 没生成出来的场次会被 `os.remove()`。`export_subs.py` 同理删 subs。「跳过」是时间窗过滤，不等于安全——被跳过且磁盘上有文件的场次也会进「移除」。
- **会让 export 删除历史场次的配置改动**：`source.db` 指错（尤其旧的 C# 库）、`time_window` 改窄、`time_window_keep` 漏掉白天场、`session_gap_min` / `min_records` 改变导致场次文件名变化。动这些之前先 `export.py --dry-run`，确认「清掉 0」。
- **编辑器「重建站点」= export → export_subs → gen_data → Vite**，同样有删除风险；DB 不稳时不要直接点，先手动 dry-run。
- `publish.py` 也会先 export；默认只本地提交 `site/data`、不推送。用 `publish.cmd --dry-run` 先看变更。
- 编辑器写入是原子写 + 备份（quotes / tags / fixes / overrides 都在 `.state/editor-backups/`）；但备份不覆盖 sessions 的删除，**git 才是最后一道保险**：批量操作前先提交，误删的 sessions 可用 `git checkout -- site/data/sessions/<文件>` 恢复。
- `sel` 存的是 records 下标：重新导出后如果场次切分变了，同一个 `t` 的下标可能对不上，`selected_lines()` 会按 `t` 校验并跳过对不上的行，摘录会悄悄变短。改切场配置后要回查摘录。

### 数据文件 schema

`diary.json`（list，**最新在最前**）

```json
{ "date": "11-10", "title": "一句话抓这件最突出的事",
  "tagline": "深夜场 · 美食话题 · 防感冒",
  "body": ["段落1", "段落2"],
  "names": ["观众名A", "观众名B"] }
```

- `names` **可选**：正文里写到的观众 uname 才填，按正文首次出现顺序；只用于前端把名字包成 `.dname` 做轻微字体区分，不改正文文字，也不写进搜索索引的正文。没有具名观众就省略这个字段。

`dynamics.json`（list，由 `tools/export_dynamics.py` 生成，**禁止手改**）

```json
{ "id": "动态 ID", "ts": 1795336374, "date": "2026-11-22", "time": "16:32",
  "month": "2026-11", "type": "DYNAMIC_TYPE_DRAW",
  "jp": "日语原文", "zh": "译文", "pics": [], "url": "https://www.bilibili.com/opus/..." }
```

- 只导 `config.toml [capture] mid` 这位 up 主，按 `pub_ts` 倒序；正文开头的零宽空格由导出脚本去掉。正文、译文和配图都为空的动态（`DYNAMIC_TYPE_LIVE_RCMD` 开播推送）不导出，否则挂进日记会变成空卡片。
- **不在站上单独成页**：gen_data 按日期把动态挂进对应那篇日记的 `diary[].dyn`（同一天两场按时间就近分配，例如 16:32 归 16:33 那场），日记详情页在正文前渲染这一栏；当天没有日记、或那篇没有动态，就都不出现。`DATA.dynamics` 顶层数组已取消，总数仍在 `meta.dynamicCount`。
- capture 本机库通常为空，脚本默认 ssh 到 `v20` 只读查手机库；加 `--db PATH` 才切本地库。重新抓过动态后重跑导出 + 构建。

`quotes.json`（list）

```json
{ "date": "11-22", "session": "2026-11-22_0011", "t": "00:18:27",
  "sel": [{"i": 401, "t": "00:18:27"}, {"i": 402, "t": "00:18:30"}],
  "tag": "劝解", "tags": ["劝解"],
  "title": "想看的时候来看就好",
  "jp": "选段原文快照", "zh": "对应译文快照",
  "note": "一句语境说明，不评价",
  "sc": { "name": "观众名", "text": "观众原文" } }
```

- **编辑器保存的新条目**带 `session` + `sel`：`sel` 是逐字稿 records 的下标 + 时间戳，逐行精确引用；`jp/zh` 只是选段快照，`sel` 失效时用来兜底。正文仍以逐字稿为准，所以改 ASR 只改 `overrides.json` / `FIXES`，摘录自动跟着变。
- **老条目没有 `sel`**：`jp/zh` 继续作为首末句锚点，由 `gen_data.topic_lines()` 按相似度圈段。新收摘录一律在编辑器里勾选，保存后就是 `sel`，不要手拼下标。
- `sc` / `dm` **二选一**：`sc` 是醒目留言，`dm` 是普通弹幕（弹幕也可以作为摘录的引出引用）；两个字段不要同时写。`text` 放观众原文，`name` 按手机库 `uname`，没署名留空。
- `title` 可选：编辑器里填；不填时 `gen_data.quote_title()` 从正文首句自动提炼。`tags` 是数组，`tag` 取第一个，供旧前端 / 旧数据兼容。
- `t` 必须是真实时间戳，`build.py` 靠它把摘录挂到对应场次；有 `session` 时优先按场次定位。挂不上会打印 `!! 找不到对应场次的摘录`
- `tag` **不设白名单**（2026-11-14 用户指定）：按当场内容自由命名。语源、习俗、文字、料理、游戏……遇到新类别就直接新造，2–4 字、名词性、同一类始终用同一个名字；已有标签（`人生` `劝解` `吐槽` `科普` `自嘲` `努力` 等）优先沿用保持连贯，别为单条造一次性标签。摘录页筛选项按条数排序、颜色按标签名自动分配，新增标签不需要改前端代码。

`overrides.json`（dict，编辑器 / 人工写）

```json
{ "2026-11-26_0014": {
    "00:55:21#0": {
      "jp": "修正后的原文", "zh": "修正后的译文",
      "why": "为什么改", "at": "2026-11-26 15:22",
      "orig": { "jp": "原导出文本", "zh": "原译文" } } } }
```

- 键是「场次文件名 + `HH:MM:SS#同秒序号`」；同秒多行必须带 `#n`，只用时间戳会串行。
- 由 `tools/export.py` / `export_subs.py` 在 `asr_fixes` 之后套用，逐字稿、字幕、摘录一起生效；改回原样就等于撤销。

`tags.json`（list，编辑器写）：tag 注册表，前台筛选仍按条数排序。

### 当前规模（2026-11-26）

30 场 / 20805 条记录 / 283 段摘录 / 30 篇日记。
