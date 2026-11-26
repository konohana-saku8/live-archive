# WORKFLOW.md — 常规工作流与恢复

> 开播前后流程、手动重译回填、工作区丢失后的恢复顺序。危险操作见 [PITFALLS.md](PITFALLS.md)。
> 主入口与文档地图见 [AGENT.md](../AGENT.md)。

---

## 7. 常规工作流

**开播前**：`run.bat` 起 danmaku-it（或 gui.bat 开悬浮窗）+ 起 LiveTranslate。

**下播后**（一场不落）：

1. `python tools/export.py`
   - 最后一条记录距今不足 10 分钟 → 可能还在播，先别写日记
   - **看输出里多出来哪些场次**，以及「跳过」了哪些（见坑 5）
   - 「清掉」必须是 0，出现「移除」立刻停（见坑 1）
2. 读完整逐字稿（`python -c` 从库里 dump 到 `.state/_dump_MMDD.txt`，再整篇读；别只看片段）
3. 写 `site/data/diary.json`（最新在最前）
4. 挑 `site/data/quotes.json`（行数对齐、`t` 用真实时间戳、`note` 不评价）
5. `python tools/build.py`（或 `npm run build`）
   - 不能有 `!! 找不到对应场次的摘录`
   - 版本哈希要变
6. 起 `python -m http.server 8799 -d dist`，把页面交给用户看，**不截图自查**
7. `git add site/data && git commit`（**不 push**），汇报：时长/条数/日记标题/新增摘录表/ahead 数
8. 用户确认后才 `publish.cmd --push`

**手动重译/回填**：只能改 `TranslationHistory` 的 `TranslatedText`，然后重新 export；不要在 sessions JSON 上手改（历史上 `865a499` 那次回填是直接改 JSON 的，属于例外，别照抄）。

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
