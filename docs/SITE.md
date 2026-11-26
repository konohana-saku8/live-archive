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
  assets/app.js           ES module；前端 hash 路由：#/ #/diary #/quotes #/archive #/about
  assets/style.css
  brand/                 头像、favicon、氛围底图、首页夜景（--scene 切换）与预模糊远景
  data/profile.json       主播名 / 标题 / 描述
  data/diary.json         直播日记（人工写，最新在最前）
  data/dynamics.json      B 站动态（export_dynamics.py 从 live-capture 导出，**禁止手改**）
  data/quotes.json        摘录（人工挑，按 date + t 挂场次）
  data/sessions/*.json    每场直播一份，脚本导出，**禁止手改**
  data/subs/*.json        双语字幕轨（进 git，随站点发布，按场次分文件）
.build/                   构建前的数据暂存（gitignore，gen_data.py 生成）
tools/
  common.py               配置、读库、切场、话题分类（TOPICS 关键词表）
  export.py               db → site/data/sessions/
  export_dynamics.py      live-capture 的 dynamics 表 → site/data/dynamics.json（默认 ssh 只读手机库）
  gen_data.py             site/data → .build/：data.js、版本哈希、subs、静态资源
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

# 导出（幂等：内容没变不落盘）
python tools/export.py
python tools/export.py --dry-run          # 先看会改什么，「清掉」必须是 0
python tools/export_dynamics.py           # B 站动态：默认 ssh 只读手机 capture 库
python tools/export_dynamics.py --db PATH # 改读本地 capture.db（通常为空，仅调试）

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
{ "date": "11-10", "t": "01:00:21", "tag": "劝解",
  "jp": "她的原话，一行一句",
  "zh": "对应译文，行数对齐",
  "note": "一句语境说明，不评价",
  "sc": { "name": "观众名", "text": "观众原文" } }
```

- `jp/zh` 写她讲同一件事的那几句（可长），无需逐行对应逐字稿；`gen_data.py` 会按首句 / 末句在逐字稿里圈出同一主题段，生成 `lines:[{t,jp,zh}]` 作为页面正文——**摘录与逐字稿共用同一份数据**，源文件无需维护两次。源末句若把连续两三句并成一行，整行相似度会被稀释而截在半截；`topic_lines()` 会在结尾后 15 秒 / 6 行内找末句尾部小句或 `note` 里补记的原话补齐（`note` 里带引号的日语原话因此会被当锚点，别拿引号写泛泛注释）。
- `t` 必须是真实时间戳，`build.py` 靠它把摘录挂到对应场次；挂不上会打印 `!! 找不到对应场次的摘录`
- `tag` **不设白名单**（2026-11-14 用户指定）：按当场内容自由命名。语源、习俗、文字、料理、游戏……遇到新类别就直接新造，2–4 字、名词性、同一类始终用同一个名字；已有标签（`人生` `劝解` `吐槽` `科普` `自嘲` `努力` 等）优先沿用保持连贯，别为单条造一次性标签。摘录页筛选项按条数排序、颜色按标签名自动分配，新增标签不需要改前端代码。

### 当前规模（2026-11-10）

13 场 / 8202 条记录 / 105 段摘录 / 13 篇日记。
