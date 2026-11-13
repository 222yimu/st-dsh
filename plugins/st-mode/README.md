# st-mode · 会话记忆模式开关

> ⚠️ **2026-11-13 起前端 pill 已停用**（对方要求「不要胶囊，preset 里直接就是扮演」）。
> 做法：`package.json` 里删掉 `dsh.client` 段 → 只剩宿主桥。状态仍然写在 `data\mode.json`，
> 由「扮演模式」preset 的 roleplay-guard 自动登记 roleplay；sage-mem 补丁照旧按它分流。
> 备份：`package.json.bak-20261113-nopill`。要恢复 pill：把 `dsh.client` 段加回去并重启。

贴在输入框左侧那个 **记忆** pill：`正常` / `扮演`，按会话 id 记住（`data\mode.json`）。

## 两个职责

1. **HTTP 桥**：`GET/POST /st-mode/mode`，挂在 DSH 自己的 webServer 上（同源，不额外开端口）
2. **扮演模式注入**：roleplay 会话里往 system prompt 追加 `st-mode:roleplay-discipline`
   —— 扮演期间**不调工具、不读写真实文件、不跑命令**，只出剧情

> 注意：扮演时 sage-mem 的长期记忆整段跳过，所以纪律必须由本插件注入，不能只写进记忆库。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主侧：状态读写 + HTTP 路由 + `system-prompt/assemble` 注入 |
| `client.js` | 前端 pill |
| `data\mode.json` | `{ default, sessions { "<sessionId>": "roleplay" } }` |
| `data\gate.log` | 分流日志（**UTC** 时间戳，比本地早 8 小时） |

## 测试

```
node test\roleplay-discipline.test.cjs      # 扮演纪律注入（会临时改 mode.json，finally 还原）
node test\gate-logic.test.cjs               # 基础分流逻辑
```

## 生效与回滚

- 宿主侧改动**重启 DSH** 才生效
- 语法自检：`node --check lib/index.js`
- 备份：`lib\index.js.bak-20261113`
- 同步：D 盘源目录 `<PLUGINS>\st-mode\` → profile 的 `node_modules\st-mode\`（实体副本，不是链接，改完必须复制）
