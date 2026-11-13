# 与 SillyTavern 的代码级对照（v1.19.0 实测源码）

> **这次是真代码**。通过系统代理（`127.0.0.1:12450`）直连 `raw.githubusercontent.com` 成功，
> 下载到 `<SILLYTAVERN_SRC>`：
>
> | 文件 | 大小 | 作用 |
> |---|---|---|
> | `script.js` | 497,669 B | 主流程：Generate、saveChat、swipe、上下文预算 |
> | `world-info.js` | 265,081 B | 世界书：扫描状态机、递归、预算、position |
> | `openai.js` | 307,267 B | Chat Completion 的 prompt 组装与 tokenBudget |
> | `group-chats.js` | 88,784 B | 群聊：激活策略、队列 |
> | `tokenizers.js` | 42,875 B | 真 tokenizer（GPT2 / Llama2 / Llama3 / NerdStash） |
> | `power-user.js` | 172,896 B | 全局设置 |
>
> 表里"酒馆"一列都带 `文件:行号`，可直接回去查；"我们"一列是逐行核对本机代码。

---

## 一、最根本的结构差异：prompt 是"结构化数组" vs "一整段文本"

**酒馆**（`openai.js:1367-1403`，`preparePromptsForChatCompletion`）：
```js
const systemPrompts = [
  { role:'system', content: main,               identifier:'main' },
  { role:'system', content: formatWorldInfo(worldInfoBefore), identifier:'worldInfoBefore' },
  { role:'system', content: formatWorldInfo(worldInfoAfter),  identifier:'worldInfoAfter' },
  { role:'system', content: charDescription,    identifier:'charDescription' },
  { role:'system', content: charPersonality,    identifier:'charPersonality' },
  { role:'system', content: scenario,           identifier:'scenario' },
  { role: getPromptRole(authorsNote.role), content: authorsNote.value,
    identifier:'authorsNote', position: getPromptPosition(authorsNote.position) },
];
```
- 每条有 **identifier / role / position / depth**，按 `injection_depth` 分层插入（`openai.js:821-833`）
- 对话示例走的是**真正的多轮 user/assistant**（`populateDialogueExamples`，`openai.js:1101`）
- 历史消息本身就是 messages 里的 assistant 角色

**我们**（`src/server.js:assemble()`）：全部拼成一整段字符串，历史渲染成 `角色：xxx` 的行。
→ 模型看到的"自己说过的话"是转述，不是它自己的 assistant 消息。

---

## 二、token 预算：逐条扣减 vs 整段裁剪

**酒馆**（`openai.js:3961-4093`）：`ChatCompletion` 类维护 `this.tokenBudget = context - response`，
每加入一条就 `tokenBudget -= message.getTokens()`，`checkBudget()` 决定还能不能放；
生成前还会反复检查（`script.js:4560-4635` 的 `this_max_context`、`script.js:5107` 的 `thisPromptContextSize > this_max_context`）。

**我们**：`estimateTokens(prompt)` 整段估算，然后循环丢最旧对话/丢召回/压缩长档。
→ 方向一致，但没有"逐条预算账本"，也说不清某一条具体占多少。

**token 计数**：酒馆有真 tokenizer（`tokenizers.js`：`GPT2 / Llama2 / Llama3 / NerdStash`，`countTokensOpenAI(messages)`）；
我们只有分类加权估算（`tokenStats`）+ `ST_TOKEN_CALIB` 校准。

---

## 三、swipe：我们少了一个关键字段

**酒馆**（`script.js:2569-2655, 6833-6933, 9359-9412, 10342-10410`）：
```js
mes.swipes[]        // 各版本正文
mes.swipe_id        // 当前版本
mes.swipe_info[]    // ★ 每版独立元数据（model / api / 时间 / token 等）
```
- `formatSwipeCounter(swipe_id + 1, swipes.length)` → UI 的 `2/3`
- 切版本 `loadFromSwipeId` + `SWIPE_DIRECTION.LEFT/RIGHT`，越界钳制并 toastr 警告
- 编辑时同步更新 `swipes[swipe_id]` 与 `swipe_info[swipe_id]`

**我们**：有 `swipes[]` + `swipeId`，**没有 `swipe_info`**（每版没有独立元数据），也没有方向枚举/越界告警。
→ 结构上差一个数组：能翻，但记不住"这版什么时候、用什么生成的"。

---

## 四、世界书：扫描是一台状态机

**酒馆**（`world-info.js`）：
- 扫描状态：`scan_state = { INITIAL, RECURSION, MIN_ACTIVATIONS }`（`:43`）
- 递归：`world_info_max_recursion_steps`（`:4768`）、`successfulNewEntriesForRecursion`（`:5097`）
- 预算：`world_info_budget`（占上下文百分比）+ `world_info_budget_cap`（硬上限）+ `token_budget_overflowed`（`:4738, :5021`），条目还能 `ignoreBudget`
- 位置：`world_info_position` = `before / after / EMTop / EMBottom / ANTop / ANBottom / atDepth / outlet`（`:1593-1599, :5213-5248`）—— **8 种**，`atDepth` 还带 `role`（`:3439`）
- 逻辑：`world_info_logic` = `AND_ANY / NOT_ALL / NOT_ANY / AND_ALL`（`:4955-4972`）
- 其他开关：`useProbability`（`:5030`）、`groupWeight` 分组加权（`:5452-5458`）、`caseSensitive`（`:269`）、`matchWholeWords`（`:347`）、per-entry `scanDepth`（`:280`）

**我们**（`normalizeEntry` / `matchWorldEntries`）：
- 单轮扫描，固定"本轮输入 + 最近 4 条"
- `position` 只认 0（设定前）/ 1,2,3（设定后）/ 4（@depth 插进最近对话），**没有 EMTop/EMBottom/outlet**
- `selectiveLogic` 四档**完全对齐** ✅（`secondaryPass`）
- 已实现：`position`(0/1/2/3/4) + `depth`、`selectiveLogic` 四档、`probability` / `useProbability`、`caseSensitive`、`matchWholeWords`、`excludeRecursion` / `preventRecursion`
- **递归扫描**：做了一轮（`scanWorld`，`ST_WI_RECURSION` 可调 0~N），命中条目的正文会喂回扫描；常量条目也参与
- 仍缺：多轮状态机（`MIN_ACTIVATIONS`）、`world_info_budget` 百分比与 `budget_cap`、`ignoreBudget`、`groupWeight` 分组评分、per-entry `scanDepth`、EM/outlet 位置

---

## 五、上下文与生成

| 项 | 酒馆（源码） | 我们 |
|---|---|---|
| 上下文默认值 | `max_context = 2048`（`script.js:617`），按模型/预设改 | `DEFAULT_BUDGET = 16000` 固定 |
| 生成前预算检查 | `getMaxPromptTokens()` / `this_max_context` 多层递减（`script.js:4560-4635`） | 一次性估算 |
| 作者注位置 | `chat_metadata[position/depth/role]`（`script.js:3219`） | `post_history` 固定尾部 |
| 聊天保存 | `saveChat({chatName, withMetadata, mesId})`（`script.js:7395`），可只存一条 | `writeTurns` 整文件原子写 |
| 群聊激活 | `activation_strategy` = `NATURAL / LIST / POOLED / MANUAL`（`group-chats.js:1002-1029`） | `seq / random`（近似 LIST） |

---

## 六、数据字段对照（一行聊天）

酒馆（`script.js:2575, 2649`）：
```json
{"name":"…","is_user":false,"mes":"…","send_date":"…",
 "swipes":["…","…"],"swipe_id":1,"swipe_info":[{},{}],
 "extra":{"model":"…","api":"…"}}
```
我们：
```json
{"t":"2026-11-13 17:02:15+08","role":"char","text":"…","swipes":["…","…"],"swipeId":1}
```
差异：`swipe_info` 缺失；`send_date` 是本地时间字符串；没有 `extra` 元数据。

---

## 七、做对 / 更强的地方（核过源码依然成立）

| 项 | 说明 |
|---|---|
| `selectiveLogic` 四档 | 与 `world_info_logic` **逐值对齐**（`secondaryPass`） |
| 卡 / 世界书格式 | V2 与 world info 双向兼容，能互拷 |
| 组装可审计 | 一次 `st_prompt` 还你完整 prompt + `stats`；酒馆是黑箱 messages |
| 裁剪顺序显式 | 先丢最旧对话 → 再丢召回 → 最后压长档 |
| 长档 + IDF 召回 | 酒馆要装 Summarize / Vector Storage 扩展 |
| 零依赖 | 纯 Node 内置模块；酒馆是大型前端工程 |

---

## 八、差距清单（按值不值得做）

| 优先级 | 差距 | 成本 | 影响 |
|---|---|---|---|
| ~~**P0**~~ | ~~`swipe_info`（每版元数据）~~ | ✅ 已补（2026-11-13）：行内 `swipeInfo[]`，`regenerate` / `swipe-add` 都会写 |
| ~~**P0**~~ | ~~`probability` + `caseSensitive` + `matchWholeWords`~~ | ✅ 已补：`probPass` + `keyHit`，面板有对应输入 |
| ~~P1~~ | ~~世界书递归扫描~~ | ✅ 已补一轮（`scanWorld`），`ST_WI_RECURSION` 可调 |
| P1 | 真 tokenizer（接 tiktoken 或内置 GPT2 词表） | 中 | 预算精确 |
| P1 | prompt 结构化（拆成带 identifier 的段落数组） | 中 | 能"只改某段"、按 depth 注入 |
| P2 | `groupWeight` / `min_activations` / `budget%` | 中大 | 高级 lorebook 玩法 |
| P2 | `position` 的 EM / outlet | 中 | 少数卡依赖 |
| P3 | 群聊 NATURAL / POOLED | 中 | 现在 seq/random 够日常 |

---

## 九、结论

**数据层**：卡 V2、world info、聊天 jsonl 都对齐了，能互读互写。
**功能层**：RP 主干（卡/世界书/上下文/长档/历史/分支/快照/群聊/swipe/导出）齐了。
**代码层**，三处结构性差异：

1. **prompt 形态** —— 结构化 messages（带 identifier/role/depth）vs 一整段文本
2. **token 预算模型** —— 逐条扣减 + 真 tokenizer vs 整段估算
3. **世界书扫描引擎** —— 状态机 + 递归 + 8 种位置 vs 单轮 + 三类位置

这三条不是补个函数能追平的：它们绑在运行架构上（酒馆是前端驱动的完整应用，我们是模型驱动 + 工具调用）。
**但在同样的架构约束下，`swipe_info`、`probability/caseSensitive/matchWholeWords`、递归扫描这三样成本不高、收益直接。**
