# AGENT.md — 火羽直播档案三件套

> **这份文件的用途**：工作区被误删 / 上下文丢失 / 换了新对话之后，从这里按文档地图跳转到各专题，即可把整条链路接回来。

---

## 0. 一句话

三个项目，**一个 SQLite 文件**是唯一的枢纽：`live-archive/.data/translation_history.db`。
LiveTranslate 和 danmaku-it 都往这个库里写，live-archive 从里面读，导出成站点。

```
        LiveTranslate                        danmaku-it
   （WASAPI → VAD → ASR → LLM 翻译）      （B站弹幕/SC 旁路采集）
              │  写 TranslationHistory            │  写 sc_message / danmaku / room_event
              └──────────────┬────────────────────┘
                             ▼
        D:/HibaneHinome/live-archive/.data/translation_history.db   ← 唯一数据源
                             │  只读（mode=ro）
                             ▼
                     live-archive/tools/
                export.py → site/data/sessions/*.json
                （人工）  → site/data/diary.json · quotes.json
                build.py  → dist/
                publish.py→ git commit →（人工确认）→ push
                             ▼
             GitHub Pages: https://konohana-saku8.github.io/live-archive/
```

---

## 1. 三个项目

| | 角色 | 路径 | 语言 / 运行环境 | 版本控制 |
|---|---|---|---|---|
| 1 | **最终产物**：B站直播逐字稿档案站点 | `D:/HibaneHinome/live-archive` | Python 3.12+（仅标准库）+ 原生 JS | git，远端 GitHub |
| 2 | **SC / 弹幕收集器**：B站醒目留言旁路采集，用于事后矫正翻译、核对观众发言 | `D:/HibaneHinome/danmaku-it` | Python 3.13（`.venv`）+ PySide6 | **不在 git 里** |
| 3 | **实时翻译**：系统音频 → ASR → LLM 翻译 → 悬浮字幕 | `D:/HibaneHinome/LiveTranslate` | Python 3.11（`.venv`）+ PyTorch + PyQt6 | git |

三者的耦合点只有数据库路径，代码之间**没有任何 import 关系**：

- `LiveTranslate/user_settings.json` → `"history_db_path": "D:/HibaneHinome/live-archive/.data/translation_history.db"`
- `danmaku-it/config.json` → `"database": "D:\\HibaneHinome\\live-archive\\.data\\translation_history.db"`
- `live-archive/.state/config_data.toml` → `db = "D:/HibaneHinome/live-archive/.data/translation_history.db"`（**当前真正生效的那份**，见 [PITFALLS.md](docs/PITFALLS.md) 坑 1）

（`live-archive/config.toml` 里写的还是旧的 C# 库路径，已过期。）

---

## 文档地图

细节已拆到下列小文件，按主题取用，不必通读：

| 文档 | 内容 | 什么时候读 |
|---|---|---|
| [DATABASE.md](docs/DATABASE.md) | 枢纽库表结构、两代翻译器、SC 矫正锚点 | 校译文、查 SC、写 SQL 前 |
| [SITE.md](docs/SITE.md) | 站点目录、命令、Cloudflare、切场、数据 schema | 改导出 / 构建 / 部署 |
| [WRITING-RULES.md](docs/WRITING-RULES.md) | 写作口径 23 条（默认口径，当场指定优先） | 写日记 / 挑摘录前 |
| [EXCERPT_RULES.md](docs/EXCERPT_RULES.md) | 摘录与引用规范（含意译不得冒充原文） | 挑摘录、引用她原话前 |
| [CULTURE.md](docs/CULTURE.md) | 直播间梗、人物、称呼与文化背景 | 校人名 / 判断是不是玩梗 |
| [FRONTEND.md](docs/FRONTEND.md) | 装饰图、性能、话题、搜索、日历、时间轴、各视图 | 改前端交互 |
| [COLLECTORS.md](docs/COLLECTORS.md) | danmaku-it / LiveTranslate 启动与配置 | 开播、调采集或翻译 |
| [WORKFLOW.md](docs/WORKFLOW.md) | 常规工作流与工作区恢复 | 下播整理、环境重建 |
| [PITFALLS.md](docs/PITFALLS.md) | 12 个坑与自查判据 | 动库 / 导出 / 同步前 |
| [OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md) | 待确认的开放项 | 改配置口径前 |

以上是维护文档，不在站点发布。引用其他规范一律写成 markdown 链接（方括号标题接圆括号文件名），不要只留裸文件名。

## 6. 环境

| 用途 | 解释器 |
|---|---|
| live-archive 工具 | 系统 `python`（3.13，只用标准库 `tomllib/json/sqlite3`） |
| danmaku-it | `danmaku-it/.venv/Scripts/python.exe`（3.13.7） |
| LiveTranslate | `LiveTranslate/.venv/Scripts/python.exe`（3.11.9，torch 必须 3.11） |

固定端口：本地预览 `8799`（`dist/` 被它占住，重建前必须先停）。

---
