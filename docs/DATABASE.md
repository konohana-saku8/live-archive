# DATABASE.md — 枢纽数据库

> SQLite 枢纽库的表结构、两代翻译器、SC 矫正锚点。
> 主入口与文档地图见 [AGENT.md](../AGENT.md)。

---

## 2. 枢纽数据库

**路径**：`D:/HibaneHinome/live-archive/.data/translation_history.db`（约 8.9 MB，WAL 模式）

这一个文件里同时躺着两套表，因为 LiveTranslate / C# 端和 danmaku-it 各自 `CREATE TABLE IF NOT EXISTS` 到同一个文件：

| 表 | 行数（11-10 快照） | 写入方 | 用途 |
|---|---|---|---|
| `TranslationHistory` | 9850 | LiveTranslate / LiveCaptions-Translator | 逐字稿本体：日文原文 + 中文译文 |
| `sc_message` | 324 | danmaku-it | SC 留言原文、金额、发送者、B站官方译文 |
| `danmaku` | 45978 | danmaku-it | 普通弹幕（房间 42062 / 22748536） |
| `room_event` | 2471 | danmaku-it | 进场 / 礼物 / 上舰 / SC 删除 |
| `collect_room` | 2 | danmaku-it | 采集过的房间信息 |
| `sc_deletion` | 0 | danmaku-it | 被删的 SC |

### TranslationHistory

```sql
Id INTEGER PRIMARY KEY AUTOINCREMENT,
Timestamp TEXT,          -- Unix 秒（字符串！），本地时区 GMT+8
SourceText TEXT,         -- 日语 ASR 原文
TranslatedText TEXT,     -- 机器译文（可能为空 / N/A / Translation Failed）
TargetLanguage TEXT,     -- BCP-47，如 zh-CN
ApiUsed TEXT             -- 见下
```

- **`Timestamp` 是 TEXT，比较时必须 `CAST(Timestamp AS INTEGER)`**，否则字符串比较会算错。
- `ApiUsed` 分布：`LiveTranslate:hunyuan-mt-chimera-7b` 5129 / `OpenAI` 4524 / `LogOnly` 197。
  → 早期用的是 C# 端 + OpenAI，2026-11 起换成 LiveTranslate + 腾讯混元 MT。同一份逐字稿是**两代翻译器混着的**。
- 数据范围：2026-10-23 23:58 → 2026-11-10 01:03。

### sc_message（翻译矫正的锚点）

```sql
sc_id TEXT PRIMARY KEY,  -- B站 SC id，去重键
room_id, uid, uname, price,
message TEXT,            -- 留言原文（日文/中文都有，观众写的）
message_trans TEXT,      -- B站官方译文（来自 SUPER_CHAT_MESSAGE_JPN，可空）
start_time INTEGER,      -- B站 Unix 秒 = 录播时间轴，权威
received_at INTEGER,     -- 本地墙钟毫秒，比 start_time 晚约 0.7s
guard_level, medal_*,
raw_json TEXT            -- 整条原始 payload
```

**这两个库为什么放在一起**：ASR + LLM 的译文会错，而 SC 是观众手写的原文 + B站官方译文，是同一时段里**唯一可信的人工对照**。人工校摘录 / 核译文时，就是拿 `sc_message.message` 去对 `TranslationHistory` 里同一时刻附近那条记录。历史提交能看到这个用法：

- `b85c915` 「11-08 摘录原文校对——8 段观众发言行改为 SC 原话」
- `521ac3f` 「11-09 深夜场收尾（日记+12段摘录，**SC表核对新库导出**）」

---
