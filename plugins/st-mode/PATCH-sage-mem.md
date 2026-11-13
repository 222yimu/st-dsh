# sage-mem 本地补丁：st-mode 分流

## 为什么要打

sage-mem 默认在每一轮 `system-prompt/assemble` 里按问题检索并注入长期记忆，没有开关。
本补丁让它先读 st-mode 写的 `mode.json`：**被标记为 roleplay 的会话直接跳过注入**，
长期记忆一个字节都不进上下文；normal 会话行为完全不变。

## 改了什么（共 3 处，都在 `lib/index.js`）

1. 加导入：
   ```js
   import { appendFileSync, readFileSync, statSync } from 'node:fs'
   ```
   位置：`import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'` 之后。

2. 加读取辅助（模块顶层，紧跟 import 块之后）：
   `ST_MODE_FILE` / `ST_GATE_LOG` / `stModeState()` / `stModeFor()` / `stGateLog()`
   — 按 `mode.json` 的 mtime 缓存，避免每轮都读盘。

3. 在 `ctx.on('system-prompt/assemble', ...)` 里，取到 `sessionId` 之后插入守卫：
   ```js
   const stMode = stModeFor(sessionId)
   if (stMode === 'roleplay') {
     stGateLog(`skip session=${sessionId || '-'} mode=roleplay`)
     return assembled
   }
   ```

## 生效前提

- `<PLUGINS>\st-mode\data\mode.json` 存在，格式：
  ```json
  { "default": "normal", "sessions": { "<sessionId>": "roleplay" } }
  ```
- 会话在 `sessions` 里有记录时优先；否则用 `default`
- 改完需要重启 DSH（插件模块在启动时加载）

## 怎么确认真的生效

1. 界面点击 pill 切到「扮演」
2. 发一句话
3. 看 `data\gate.log` 里有没有新增 `skip session=... mode=roleplay`

## 已验证的运行时事实（2026-11-13 实测）

- `context.agent.session.id` 的格式是 **`session-<uuid>`（带前缀）**
- 日志时间戳是 **UTC**（`07:59Z` = 本地 `15:59`），不要拿它跟本地时间对不上就以为没触发
- 查表已做三种键容错：原样 / 去掉 `session-` / 补上 `session-`

实测通过的日志：

```
assemble session=session-f5450159-... mode=normal
assemble session=session-f5450159-... mode=roleplay
skip session=session-f5450159-... mode=roleplay      ← 守卫生效
```

验证记录留在 `data\gate.verified.log`；`gate.log` 之后只记 `skip` 行，不会无限增长。

## 回滚

原版完整备份在：`D:\ymLN\_backup\sage-mem-orig-20261113\`
覆盖回去即可：
```powershell
Copy-Item "D:\ymLN\_backup\sage-mem-orig-20261113\*" "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\sage-mem\" -Recurse -Force
```

## 注意

- 这是**本地改动**，sage-mem 升级（pnpm 更新/插件市场更新）会覆盖掉，需要重打
- 生态里已有的 sage-mem 更新提示不会感知这个补丁
