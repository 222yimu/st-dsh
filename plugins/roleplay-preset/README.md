# 扮演模式 agent preset

对方要的「扮演模式」：**像酒馆一样运行时读角色卡与世界书**，撑得住长剧情，而且**设定能随剧情长**；但**不碰系统** —— 没有 shell、不读写工作区文件、不联网、不派生 agent。

## 和 st-mode 的分工

| | st-mode（会话级 pill） | 本 preset（agent 级） |
|---|---|---|
| 粒度 | 同一个 agent 内切换 | 新建会话时选「扮演模式」 |
| 工具 | 全套都在，靠注入纪律约束 | **只留 9 个 st-lite 工具**，其余 restrict 隐藏 + guard 执行期全拒 |
| 角色卡 / 世界书 | 运行时 `st_prompt` 组装 | 运行时 `st_prompt` 组装（还能随剧情改） |
| 聊天历史 | st-lite 的 chats | st-lite 的 chats（跨会话续得上） |
| 长期记忆 | sage-mem 按 `mode.json` 跳过 | 插件自动登记 roleplay，sage-mem 同轮跳过 |
| 适合 | 临时演两句 | 长剧情、连续多轮、要完整人设 |

## 白名单（9 个）

| 工具 | 用途 | 读写 |
|---|---|---|
| `st_prompt` | 卡 + 命中世界书 + 最近对话，按 token 预算组装本轮提示词 | 读 |
| `st_history` / `st_cards` / `st_card_get` / `st_world_list` | 翻剧情 / 列卡 / 读卡 / 列世界书 | 读 |
| `st_log` | 每轮存两条：`user` 原话 + `char` 回复（写 chats） | 写历史 |
| `st_card_patch` | **字段级补丁**：只改给出的卡字段，其余保留 | 写设定 |
| `st_world_add` | 追加世界书条目（可带 keys / priority / constant） | 写设定 |
| `st_world_update` | 按 entry id 改已有条目 | 写设定 |

**被挡掉的 100 项**：shell（pwsh/bash）、读写工作区文件（read/write/edit/glob/grep）、`load_workspace_dependencies`、联网（web_search/web_fetch，含 MCP 版）、QQ 桥（36 个 `qq_*`）、subagent/workflow/ralph、jobs、skill、goal、todo、schedule、cordis 检查、`plugin_manager`、`dsh_snapshot/rollback`、purge_*，以及 **`st_card_save`（整卡覆盖）**。

### 为什么封 `st_card_save` 而放开 `st_card_patch`

`save` 是整卡覆盖语义 —— 模型漏一个字段就把人设写残。所以：
- 扮演里只给 `st_card_patch`，服务端做字段级 merge，没给的字段原样保留
- `patch` 幂等：传相同值返回「没有字段变化」，不会白写盘
- 每次写盘前 `backupJson()` 自动存 `<文件>.bak`（卡与世界书各一份），要退回随时能退

## 每轮的循环（persona 里写死）

```
st_prompt(card, userMessage)      → 人设 + 世界书命中 + 历史
      ↓
按提示词演（第一人称、*斜体*动作、简体中文）
      ↓
st_log(user) + st_log(char)
      ↓
剧情有持久变化时（关系/身份/约定/秘密）→ st_world_add 或 st_world_update
自己的性格/说话方式变了            → st_card_patch（只传要改的字段）
```

判定标准写在 persona 里：**纯气氛的事（下雨、吃饭）只进历史，不进设定。**

## 守卫的三件事（`roleplay-guard.mjs`）

1. `ctx.tools.restrict({ deny: [name] })` —— 逐个挡 100 个名字。坑：restrict 的 unknown 校验**整批原子**，一个坏名字会让整批失效 → 必须一次一个 try/catch
2. `ctx.tools.guard(fn)` —— 执行期兜底：白名单 9 个放行，其它（含未知/空名）一律拒
3. `system-prompt/assemble` 钩子里写 `mode.json` 的 `sessions[id] = 'roleplay'` —— sage-mem 是「先 `await next()`、再读 mode.json」，所以**同一轮**就跳过记忆注入，不漏首轮

## 文件

| 文件 | 作用 |
|---|---|
| `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾 `# === 扮演模式 preset BEGIN ===` | `@deepseek-ai/dsh-agent-preset`：id=`roleplay`、name=扮演模式、order=20 |
| `~/.dsh/profiles/desktop/roleplay-guard.mjs` | 守卫插件（真正加载的） |
| `~/.dsh/profiles/desktop/roleplay-guard.allowlist.test.mjs` | 白名单行为测试（9 项） |
| `<PLUGINS>\st-lite\src\server.js` | MCP 服务；新增 `st_card_patch` / `st_world_update`，`backupJson` |
| `<PLUGINS>\st-lite\test\evolve.js` | 设定演进自测（6/6） |
| `<PLUGINS>\roleplay-preset\` | D 盘备份 + 本 README + `build-persona.mjs` |

## 验证

```powershell
node <PLUGINS>\st-lite\test\evolve.js
# PASS 6/6：卡补丁 / 幂等 / 世界书追加 / 更新 / 报错 / 备份（跑完自动还原 data）
node <HOME>\.dsh\profiles\desktop\roleplay-guard.allowlist.test.mjs
# PASS：白名单 9 项放行、restrict 100 项、guard 全拒、assemble 登记 roleplay
node --check <PLUGINS>\st-lite\src\server.js
# YAML：24 条顶层项，prefix 34 行 / 1449 字符，含 card_patch & world_add & world_update
```

## 日常操作

- 改角色卡 / 世界书：直接改 `st-lite\data\cards\example.json` / `data\worlds\example.json`，下一轮 `st_prompt` 生效，不用重启
- 演的时候我自己改：`st_world_add` / `st_world_update` / `st_card_patch`
- 想退回我改之前的版本：把 `data\cards\example.json.bak` / `data\worlds\example.json.bak` 复制回原名
- 改 persona 文案：`node <PLUGINS>\roleplay-preset\build-persona.mjs` → 重启 DSH
- 清空剧情重来：删 `st-lite\data\chats\example.jsonl`

## 生效 / 排查

**重启 DSH**：
- preset 挂载（patch 启动时读）
- st-lite 的 MCP 服务重启后才会暴露新工具 `st_card_patch` / `st_world_update`

下拉没出现「扮演模式」：查 patch 能否被 js-yaml 解析 → `./roleplay-guard.mjs` 按 **profile 目录**解析（0.1.7+ 子行规则）→ 启动日志里 `preset-roleplay` 的报错。

## 回滚

```powershell
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak-20261113-preset" `
          "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Force
```

改法纪律：D 盘那份是备份，真正加载的是 profile 里那份；改完 `Copy-Item profile → <PLUGINS>\roleplay-preset\` 同步。
