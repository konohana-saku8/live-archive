# COLLECTORS.md — 采集与翻译两端

> danmaku-it（SC / 弹幕采集）与 LiveTranslate（实时 ASR + LLM）的启动与配置。
> 主入口与文档地图见 [AGENT.md](../AGENT.md)。

---

## 4. danmaku-it

```powershell
cd D:/HibaneHinome/danmaku-it
.\.venv\Scripts\python.exe -m collector gui -c config.json    # 悬浮弹幕机（gui.bat）
.\.venv\Scripts\python.exe -m collector run -c config.json    # 命令行常驻（run.bat）
.\.venv\Scripts\python.exe -m collector export --format csv --out exports/sc.csv
.\.venv\Scripts\python.exe -m collector stats
```

- 匿名连接（buvid + WBI 签名），多房间并发，每房间独立重连
- 协议必须收全量弹幕再本地过滤（B站不支持只订阅 SC）
- 房间号填 `0` = 离线回放，从库里读真实 payload 走同一套 `extract_sc()`，不联网不写库
- SC 的官方译文是 `SUPER_CHAT_MESSAGE_JPN` 晚到、按 `id` 回填到 `message_trans`
- 匿名连接下**普通弹幕昵称会被 B站打码**（`青***`），SC 和进场事件是完整的
- 断线期间 B站不补发 SC，重连补不齐

`danmaku-it/data/sc.db` 是老的自定义采集库，已被 `config.json` 改成直接写 `live-archive/.data/` 取代，只剩盘外备份那一份（见 [WORKFLOW.md](WORKFLOW.md)）——里面有 20 条 SC、1640 条弹幕来自 545068（德云色）等三个房间，`.data` 库从来没有过这些数据。

---

## 5. LiveTranslate

```bash
cd D:/HibaneHinome/LiveTranslate
.venv/Scripts/python.exe main.py      # 或 start.bat
```

当前配置（`user_settings.json`）：

| 项 | 值 |
|---|---|
| `asr_engine` | `anime-whisper`（日语动画/直播专用） |
| `asr_device` | `cuda:0` |
| `target_language` | `zh` |
| `active_model` | `hunyuan-mt-chimera-7b`（`context_turns: 3`） |
| `vad_mode` | `silero`，`silence_mode: auto` |
| `history_db_path` | `D:/HibaneHinome/live-archive/.data/translation_history.db` |
| `auto_save_transcript` | `true` |

- 系统提示词已针对「Vtuber 火羽ひのめ 的日常对话」调过，并带 ASR 错读纠正表（`ビリビリ`→b站、`スーぱちゃ`→SC）
- 每次译完一句就往 `TranslationHistory` 追加一行；`history_db.py` 自己会建表，写失败只记一次日志、不影响翻译
- 项目结构/线程模型/UI 细节见仓库里的 `CLAUDE.md`（非常详细，可以直接当参考）

---
