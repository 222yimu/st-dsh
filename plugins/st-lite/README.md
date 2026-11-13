# st-lite · SillyTavern 的精简内核

> **磁盘格式 = 酒馆原生**（2026-11-13 起）：角色卡是 Character Card V2（`{spec:"chara_card_v2", data:{…}}`），世界书是 SillyTavern world info（`{entries:{"0":{key,content,constant,disable,order,…}}}`）。
> 读取三种都认（旧扁平 / V2 / 数组式 entries），写入一律酒馆格式，可直接与酒馆互拷文件。
> 迁移脚本：`node tools\migrate-to-tavern.mjs`（幂等，`--dry` 预演）；内部 id 存在 `extensions.stlite.id` 与条目的 `stliteId` 上。

把酒馆里**真正值钱的那部分**（角色卡 + 世界书注入 + token 预算裁剪 + 聊天记录）抠出来，做成 DSH 的 MCP 工具。
不装第二个程序、不开端口、不联网、不依赖任何 npm 包。

## 结构

```
<PLUGINS>\st-lite\
  src\server.js         MCP(stdio) 服务器，手写 JSON-RPC，零依赖
  data\cards\*.json     角色卡
  data\worlds\*.json    世界书（keys 命中即注入）
  data\chats\*.jsonl    聊天记录，一轮一行
  test\smoke.js         自测：initialize → tools/list → 各组工具跑一遍
```

## 工具一览

| 工具 | 作用 |
|---|---|
| `st_cards` | 列出所有角色卡（含已存轮数 + `active` 当前卡） |
| `st_active` | 查看/切换「当前角色卡」；切换后 `st_prompt`/`st_log`/`st_history` 省略 `card` 都自动用它 |
| `st_card_get` | 读一张卡的完整内容 |
| `st_card_save` | 新建/更新角色卡（name/description/personality/scenario/first_mes/mes_example/system/post_history/world/tags）—— **整卡覆盖**，扮演模式里不给 |
| `st_card_patch` | 字段级补丁：只改给出的字段，其余原样保留（幂等；写前自动 `.bak`）—— 扮演模式用它微调人设 |
| `st_world_add` | 加世界书条目：命中 keys 任一关键词时注入；`constant: true` 常驻（写前自动 `.bak`，条目带 `created`） |
| `st_world_update` | 按 entry id 改已有条目（只改给出的字段）—— 剧情推翻旧设定时用它 |
| `st_world_list` | 列出世界书 |
| `st_prompt` | **核心**：组装可直接使用的扮演提示词（角色卡 + 命中的设定 + 最近对话 + 作者注，按 token 预算砍最旧历史） |
| `st_log` | 追加一轮对话（role=user / char） |
| `st_history` | 读聊天记录 |
| `st_story` | **故事长档**：读写 `data\chats\<卡>.story.md`（剧情纪要），`st_prompt` 每轮自动带上 |
| `st_turn` | 消息级：`list` / `delete` / `edit` / `truncate` / `regenerate`(标记重说) / `swipe`(翻版本) / `swipe-add` / `drop-last` |
| `st_tokens` | 估算 token（带明细），可传 `knownTokens` 反推 `ST_TOKEN_CALIB` 校准值 |
| `st_branch` | 剧情分支：`list` / `create` / `switch` / `delete`（文件 `<卡>@<分支>.jsonl`） |
| `st_export` | 导出酒馆格式聊天 jsonl 到 `data/exports/` |
| `st_checkpoint` | 快照：`save` / `list` / `restore`（`data/checkpoints/<卡>/`） |
| `st_group` | 群聊：`create` / `list` / `delete`；配合 `st_prompt {group}` 与 `st_log {group,speaker}` |
| `st_png` | PNG 卡：`import` 读 `data/imports/*.png`、`export` 写 `data/exports/<卡>.png` |

## 提示词组装顺序（和酒馆同思路）

```
system（卡内 system，缺省用通用扮演指令）
→ 角色设定 description
→ 性格 personality
→ 场景 scenario
→ 设定库（世界书命中条目，按 priority 排序）
→ 对话示例 mes_example
→ 最近对话（超预算从最旧开始丢）
→ 作者注 post_history
→ 本轮用户输入
```

token 估算：CJK 字符按 1 token、其余按 4 字符 1 token 粗算；预算默认 6000，可用 `st_prompt.budget` 覆盖。

## 典型用法

1. `st_prompt {card:"example", userMessage:"对方今天好累"}` → 拿到拼好的提示词
2. 用它演这一轮（我就是那个角色，不需要第二个模型）
3. `st_log {card:"example", role:"char", text:"..."}` 把回复存进记录
4. 下一轮再 `st_prompt`，历史自动带上

## 已内置

- `data\cards\example.json`：示例角色 DeepSeek（取自 sage-mem 的身份设定）
- `data\worlds\example.json`：对方=你、「米饭」偏好、「胖」为禁用词

## 自测

```
node <PLUGINS>\st-lite\test\smoke.js
```

## 注册位置

`<HOME>\.dsh\profiles\desktop\cordis.patch.yml` 末尾的 `st-lite MCP` 区块（挂在 `@deepseek-ai/dsh-mcp-client` 上，stdio 传输）。
改动后需要重启 DSH 才会挂载工具。
