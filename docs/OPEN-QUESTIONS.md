# OPEN-QUESTIONS.md — 待确认

> 尚未定稿的开放项。
> 主入口与文档地图见 [AGENT.md](../AGENT.md)。

---

## 10. 待确认

- [ ] `.data/` 要不要纳入 git（8.9 MB，单文件在 100 MB 以内可以；或继续用盘外备份 + 本文件记录路径）
- [ ] `config.toml` 的 `db` 目前是绝对路径；若以后还会移动，考虑改成相对路径 `../.data/translation_history.db`（`load_config` 会按仓库根解析相对路径）
