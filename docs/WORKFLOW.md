# WORKFLOW.md — 常规工作流与恢复

> 开播前后流程、手动重译回填、工作区丢失后的恢复顺序。危险操作见 [PITFALLS.md](PITFALLS.md)。
> 主入口与文档地图见 [AGENT.md](../AGENT.md)。

---

## 7. 常规工作流

**开播前**：`run.bat` 起 danmaku-it（或 gui.bat 开悬浮窗）+ 起 LiveTranslate。

**下播后**（一场不落，编辑器为主）：

1. **导出新场次**：`python tools/export.py`
   - 建议先 `python tools/export.py --dry-run`：只打印同样的报告，不写文件、不删文件。
   - 最后一条记录距今不足 10 分钟 → 可能还在播，先别写日记
   - **输出怎么读**：`写入 xxx.json N 条` = 新增或有变化的场次（今天的新场次应出现在这里）；`未变` = 内容没变、不落盘；`跳过 …（不在时间窗 … 内）` = 被配置的时间窗过滤掉的场次（白天场等，正常）；`移除 xxx.json` = 磁盘上原本有这个场次，但这次从 DB 没生成出来，脚本会**直接删除它**。
   - 末行 `场次 N · 新增/更新 W · 未变 U · 清掉 R · 记录 T 条` 是汇总，`清掉` 就是 `移除` 的文件数。**R 必须是 0**；一旦出现「移除」，立刻停，先查 DB 路径 / 时间窗 / 场次切分，别继续构建或提交（见坑 1、坑 5）。
   - `移除` 的常见原因：配置指到了旧的 / 空的 DB；库被替换或截断；`time_window` 改窄把已导出的场次挡掉；`session_gap_min` 改变导致场次文件名变了。已提交的文件可以用 `git checkout -- site/data/sessions/<文件>` 恢复。
   - **编辑器只读 `site/data/sessions/*.json`，不会自己从 DB 导出**；不跑这一步，编辑器左栏永远看不到今天的场次。
2. **开编辑器**：`npm run editor`（已在运行时刷新窗口）。
   - 手机端刚采集完的话，先在右侧上下文抽屉点「⇣ 拉取手机库」，把新 SC / 弹幕追加到本机 DB（手机需在线；只追加，重复点不会翻倍）。
   - 左栏选场次 → 中间栏勾选逐字稿行 → 右侧填 title / tag / note → 保存
   - 引用块可挂**多条** SC / 弹幕（混排也行），上下文抽屉里点对应行会追加一条；已有空行就填进那一行
   - 需要逐行校勘时用行内铅笔（必填「为什么改」，写 `site/data/overrides.json`）；系统性替换用「全局修正」页
   - 「本场摘录」和「摘录库」都可以回载已有条目继续改
3. **写日记**：`site/data/diary.json`（最新在最前）；编辑器目前不编辑日记，仍手写。
4. **重建站点**：编辑器右上角「重建站点」（export → export_subs → gen_data → vite build），或手动 `npm run build`
   - 不能有 `!! 找不到对应场次的摘录`
   - 版本哈希要变
5. 起本地预览（`python -m http.server 8799 -d dist`），把页面交给用户看，**不截图自查**
6. `git add site/data && git commit`（**不 push**），汇报：时长/条数/日记标题/新增摘录表/ahead 数
7. 用户确认后才 `publish.cmd --push`

**手动兜底**：不启动编辑器时，摘录仍可直接改 `site/data/quotes.json`（`jp/zh` 作锚点，或写 `sel` 精确选段），逐字稿修正写 `site/data/overrides.json`；链路与编辑器完全相同。

**手动重译/回填**：

- 平时校逐字稿只改 `site/data/overrides.json`（编辑器行内铅笔），export 时套用，不动 DB。
- 需要把**近期**的 overrides 回写 `TranslationHistory`：

  ```bash
  python tools/writeback_overrides.py --since 2026-11-13 --dry-run
  python tools/writeback_overrides.py --since 2026-11-13
  ```

  默认同时写 `SourceText` + `TranslatedText`；只写译文加 `--translation-only`。写前自动备份到 `.data/backups/`，只改 `orig` 与当前库一致的条目，单事务写入。
- 回写后 `overrides.json` **保留**作审计；再跑 `export.py` 时正文文本不变，但 `topics` / `ribbon` / `segs` 可能变——因为分类是按回写后的 `SourceText` 算的，这是预期。
- 不要在 sessions JSON 上手改（历史上 `865a499` 那次回填是直接改 JSON 的，属于例外，别照抄）。

---

## 9. 工作区又没了怎么办

| 能恢复 | 怎么恢复 |
|---|---|
| `live-archive` 的站点、工具、场次 JSON、日记、摘录 | `git clone`（远端 GitHub 有全量历史） |
| `LiveTranslate` | `git clone`（开源仓库）+ 手动补 `user_settings.json`（API key、模型、`history_db_path`） |
| `danmaku-it` | **只能靠外部备份**（无 git） |
| `.data/translation_history.db` | **只能靠外部备份**（未入库，8.9 MB）。现成的一份在 `D:/MyDocument/live-archive-backup/` |
| `account.csv`（B站 cookie） | 只能靠外部备份 |

所以最小备份集就三样：**`live-archive/.data/translation_history.db`、`danmaku-it/`、`LiveTranslate/user_settings.json`**。

重建顺序：

1. `git clone` live-archive → 恢复站点、工具、历史逐字稿；`config.toml` 现在已经是正确路径，clone 直接可用
2. 把备份的 `translation_history_YYYY-MM-DD.db` 放回 `live-archive/.data/`，改名为 `translation_history.db`
3. 恢复 `danmaku-it/`（含 `.venv`，或重新 `python -m venv .venv && .venv\Scripts\pip install -r requirements.txt`），确认 `config.json` 的 `database` 指回 `.data` 库
4. 恢复 LiveTranslate 的 `user_settings.json`，确认 `history_db_path` 指向 `.data` 库
5. 验证：`python tools/export.py --dry-run` 应当输出「场次 13 · 清掉 0」，并打印 3 条「跳过 …」（白天场）——**绝不能出现「移除」**；然后 `python tools/build.py` 应产出 13 场 / 8202 条
