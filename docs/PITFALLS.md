# PITFALLS.md — 坑（按危险程度排）

> 坑与自查判据，动库 / 导出 / 同步前先读。
> 主入口与文档地图见 [AGENT.md](../AGENT.md)。

---

## 8. 坑（按危险程度排）

### 1. `export.py` 会删掉库里不存在的场次

`export.py` 的设计行为是「以库为准」，库里切不出来的场次文件会被 `os.remove()`。所以 **db 路径指错 = 删数据**。

旧的 C# 库**别指回去**，指错就会删场次。

`config.toml` 的 `db` 指向 `.data` 那份，`.state/config_data.toml` 是它的完整副本（用 `cp config.toml .state/config_data.toml` 同步），所以**不加 `--config` 也是对的**，`publish.cmd` 也安全了。

自查判据：`python tools/export.py --dry-run` 应当出现 **「清掉 0」**；出现「移除」就说明库指错了，停下来别提交。

### 2. 手改 sessions JSON 的译文会被导出覆盖

`export.py` 以数据库为准、**整份覆盖**场次 JSON。手改过的译文会在下次导出时被打回空白，所以**永远不要手改 `site/data/sessions/*.json`**。要改译文就改数据库，要改结构就改 `tools/export.py`——手改的东西下次导出必然蒸发。

另一个副作用：重新导出历史场次会让**话题分类**漂移（`common.py` 的 `TOPICS` 关键词表调过时，比如「ありがとう」现在归「问候/感谢」而不再落到「日常杂聊」）。这是修正，不是损坏，但 commit 里会看到 `topics` / `ribbon` / `segs` 一起变。

### 3. `.data/` 不在 git 里 ⚠️

`.gitignore` 没显式排除它，但 `git status` 显示 `?? .data/`——数据库从未入库。**这是全链路唯一不可再生的东西**（直播不会重播，弹幕服务器不补发），工作区被删 = 逐字稿全丢。

盘外备份在：

```
D:/MyDocument/live-archive-backup/
  translation_history_<日期>.db         枢纽库
  sc_collector_legacy_<日期>.db         老采集库
                                         ⚠️ 源文件 data/sc.db 已删除，这是唯一副本
```

备份用 SQLite 的 `backup()` API 而不是直接复制文件——WAL 模式下直接 copy 可能漏掉未 checkpoint 的数据：

```python
import sqlite3
s = sqlite3.connect('live-archive/.data/translation_history.db')
d = sqlite3.connect('D:/MyDocument/live-archive-backup/translation_history_YYYY-MM-DD.db')
s.backup(d)
```

`.data/` 里不要再堆 `.bak_*`（会越积越大），备份一律走上面那条盘外路径，文件名带日期。

### 4. `danmaku-it` 已有版本控制

仓库**没有 remote**，只是本地版本管理。

`.gitignore` 刻意挡掉四类东西，提交前别用 `git add -f` 绕过：

| 排除项 | 原因 |
|---|---|
| `account.csv` | Netscape 格式的 B 站 cookie，19 行含登录态，泄露等于账号被接管 |
| `config.json` | 含 `sessdata` / `dede_user_id` / cookie 绝对路径 / 窗口坐标 |
| `.venv/` | 237 MB |
| `data/`、`logs/`、`exports/` | 数据库不可再生，走盘外备份；后两者是运行时产物 |

副作用：`config.json` 不入库，clone 下来跑不起来，得照 README 复制一份并填路径。

### 5. 白天场已由时间窗挡掉

`.data` 库里能切出 16 段，站点只收 13 段。多出来的 3 段是白天的游戏实况：

| 场次 | 条数 | 内容 |
|---|---|---|
| 11-06 09:23–10:29 | 894 | 游戏实况（日文） |
| 11-06 11:34–12:20 | 543 | 游戏实况（日文） |
| 11-07 11:18–11:33 | 208 | 游戏实况（日文） |

原先 `export.py` 无条件收录，每次导出都要手删。现在 `config.toml` 里有：

```toml
time_window = "23:30-01:30"
time_window_keep = ["2026-11-02_1815"]
```

- 只收**开场时间**落在窗口内的场次，窗口支持跨零点（23:30 → 次日 01:30）；上面 3 段自动跳过，输出里会打印「跳过 …」
- 傍晚/下午开播的正式场次列进 `time_window_keep`，按场次名 `YYYY-MM-DD_HHMM` 登记（`2026-11-02_1815` 就是这种情况，它有日记和摘录，不能被挡）
- 留空字符串 `time_window = ""` = 关掉过滤
- 过滤作用在「场次」粒度，不切记录：跨零点场次（10-23 23:58 开播）靠窗口左端 23:30 兜住



### 6. `dist/` 被 8799 端口占住

`build.py` 开头 `shutil.rmtree(dist)`，服务没停会报删目录失败。重建前先停服务。

### 7. CRLF / LF

`build.py` 以 LF 写出 html/js/css，算版本哈希时也先把 app.js / style.css 按 LF 归一化再算——所以 Windows 工作区（style.css 实际是 CRLF）与 CI 的版本号现在一致，可以直接拿 `v=` 对照线上是否已更新。

反过来说：以前哈希读的是原始字节，本地 `v=` 永远对不上线上，别再用它判断「部署没生效」；要判断就看页脚「更新于」的时间。

### 8. 跨零点的场次

`date` 是开场日，`end` 可能是次日。算结束时间用 `start + dur*60`，不要用「当天 24:00」。

### 9. `live-archive-daily` skill 里的库路径

任何笔记 / skill / 脚本里的库路径都先核对再跑——旧 C# 库还在 `D:/forDesktop/`，指错就会删场次（见坑 1）。

### 10. 弹幕 / SC 有整段空档

`danmaku`、`sc_message` 会整段缺数据，而 `TranslationHistory` 是完整的。最常见的原因是**当时正在开发 / 重启 `danmaku-it`**，采集端没在跑，跟库和导出都没关系。

11-11 那场的实例：`sc_message` 00:24:45 → 00:44:30 一条都没有，`danmaku` 00:33:30 → 00:44:27 也是空的；同期逐字稿里她确实在读 SC（「幸福さん」那条就没入库）。

判断与处理：

- 先按时间轴数空档，别把邻近的 SC 当成观众原话，**宁可只用她口播的复述作引子**。
- 日记里照常写这场发生了什么，不必解释采集；摘录的 `note` 里一句话说明「这条 SC 没入库 / 引子用的是口播」即可。
- 想确认是谁发的，`danmaku` 的 `uname` 能反查同一场里名字相近的观众，但**不能当成证据**。

### 11. 同一天两场，日记会绑到错误场次

`build.py` 原先只按 `date` 找场次（`next(s for s in sess_out if s['date'] == d['date'])`），同一天有两场时会**永远命中当天第一场**。11-11 就是这样：凌晨场 `2026-11-11_0016`（00:16–01:05 / 688 条）和上午场 `2026-11-11_0904`（09:04–11:24 / 1795 条），两篇日记的时长、条数、「逐字稿 →」链接全指向凌晨场。

现在日记支持可选字段 `session`，写场次文件名（不含 `.json`）即可精确绑定：

```json
{ "date": "11-11", "session": "2026-11-11_0904", "title": "…", "body": ["…"] }
```

没写 `session` 时回退到原来的按 date 匹配。**一天里出现第二场时，两篇日记都要显式写上 `session`**，否则先写的那篇会默默指错。

自查：`python -c` 读 `dist/assets/data.js`，把 `diary` 的 `start/end/count` 和标题对一遍——两场同一天时数字应当不同。

### 12. 录播字幕轨（subs/）的时间 0 是第一句翻译，不是开播整点

字幕数据由 `tools/export_subs.py` 生成，**直接读 `.data/translation_history.db` 全量**（12k+ 行 → 18 场），不经 `export.py` 的时段过滤——所以站点没收的白天场（11-06_0923 / 11-06_1134 / 11-07_1118）这里照样有字幕。

关键约定：

- `dist/subs/<场次>.json` 里 `[起, 止, 中文, 日文]` 的秒数，**0 = 本场第一句话开口的时刻**。如果下游要按视频时间轴对齐，偏移在消费端补，不要在数据端硬凑。
- 场次 key 与 `site/data/sessions/` 文件名同一套规则（`2026-11-11_0904`），两边能对上；但同一个 key 下**两边的秒数轴不同**（站点版从 `HH:MM:00` 起算，字幕版从第一句起算），别混用。
- 碎句合并（间隔 <1.6s、≤42 字）与 ASR 重述去重（后句是前句超集则替换）都在导出时做完，消费端只做二分查找。
- 稿件绑定：`site/data/videos.json`（`{"BV...": "场次key"}`）或简介里写 `HBS:<场次key>`。
- **时间戳锚点**（2026-11-11 晚，两轮修正后的最终结论）：db 里 `Timestamp` 是翻译**回来**的时刻，它锚在说话的**结束**上——说完到入库中位 0.75s（VAD 静音 + 翻译往返），而**开口**到入库中位 4.3s，差值正好是句子本身的时长。所以老数据拿 Timestamp 当字幕起点平均晚 4.3s，且长句比短句晚得更多，**常数对时救不回来**。修正：老场次（无 SpeechStart）按 `结束 − 0.75s − 估时长` 反推开口，估时长用日文字数 ÷ 5.88 字/秒（全库实测中位）；实测对 3690 句验证，偏离真实开口从中位 4.32s 降到 0.68s（ unbiased −0.09s）。统计与验证脚本在 `.state/anchor_stats.py`、`.state/anchor_gain.py`、`.state/dur_est.py`。LiveTranslate 新版直接写 `SpeechStart`/`Duration`/`LagMs` 三列（旧行 NULL），有精确值就逐句用；index/单场里的 `precise` 标记这场是哪种。字幕轨对老场次**不再默认偏移**（修正已在导出端做掉），下游按「时间为估算（误差约 0.7 秒）」提示即可。**别给老数据统一平移**——晚的量随句长变化，常数修正会被 0 点吸收。
