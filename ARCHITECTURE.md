# 工作原理

写给想改它的人。读完应该能回答三个问题：**一次对话里发生了什么**、**提示词是怎么拼出来的**、**权限是怎么卡住的**。

---

## 一、总体结构

```
┌─────────────────────────── DSH 宿主 ───────────────────────────┐
│                                                                │
│  agent（本次会话）                                              │
│    ├─ persona（preset 注入）─── 规定每轮流程                  │
│    ├─ roleplay-guard ──────── 工具白名单 + 执行期兜底          │
│    └─ 工具层                                                    │
│         ├─ 内建工具（shell / fs / web …）← 扮演模式被 restrict  │
│         └─ MCP 客户端 ──stdio──► st-lite（19 个 st_* 工具）    │
│                                                                │
│  webServer                                                     │
│    ├─ /st-editor    ◄── st-editor（Host 半）                   │
│    └─ /st-mode/mode ◄── st-mode（Host 半）                     │
│                                                                │
│  llm 服务                                                      │
│    └─ waterfall 'llm/stream' ◄── st-temp（改 temperature）     │
│                                                                │
│  设置页 slots['settings.section'] ◄── st-editor 前端半         │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    st-lite/data/（唯一真相）
                      cards/  worlds/  chats/
                      active.json  sampling.json  mode.json
```

**关键设计**：`st-lite` 是个**独立的 MCP 进程**，数据全在它自己的 `data/` 目录。
`st-editor` / `st-mode` / `st-temp` 都只是"读写这些文件 + 暴露接口"，谁挂了都不影响别人。

---

## 二、一次对话里发生了什么

### 扮演模式

```
1. 用户：「今天好累啊」
2. 模型（按 persona 流程）调用
     st_prompt { userMessage: "今天好累啊" }
3. st-lite 组装提示词（见第三节），返回
     { prompt: "……", stats: { tokens, loreHits, recursionRounds, greetingIndex, … } }
4. 模型按这段提示词演 → 输出回复
5. 模型调用
     st_log { role: "user", text: "今天好累啊" }
     st_log { role: "char", text: "（正文）" }
6. 下一轮重复
```

**这就是和酒馆的根本区别**：酒馆是框架在发请求前自动拼 `messages`；
这里是**模型自己按规程去拉上下文**。代价是多一次工具往返，收益是 `stats` 让"喂了什么"完全透明。

### 重说（swipe）

```
st_turn { op: "regenerate" }   ← 只标记"这条正在重说"，旧版本进 swipes[]，不删
st_prompt …                    ← 重新演
st_log { role: "char", … }     ← 检测到 pending 标记 → 追加为新版本，旧版保留
st_turn { op: "swipe", index, to: "prev" }  ← 翻回去
```

`<chat>.pending.json` 就是那个标记，`st_log` 读到它就走"追加版本"分支。

---

## 三、提示词组装算法（st-lite `assemble()`）

### 3.1 素材

| 来源 | 取什么 |
|---|---|
| 角色卡 | `system` / `description` / `personality` / `scenario` / `mes_example` / `post_history` |
| 开场白 | `first_mes` + `alternate_greetings`（**只在还没有历史时**放，随机或指定） |
| 世界书 | 按关键词命中 + 位置分档 |
| 故事长档 | `chats/<卡>.story.md`，截尾到 1800 token |
| 旧历史召回 | 从"更早的历史"里按 IDF 相似度捞 2 段，每段 ≤500 token |
| 最近对话 | 最多 200 条，按预算裁剪 |
| 用户本轮输入 | 原样放在最后 |

### 3.2 世界书扫描（`scanWorld`）

```
第一轮：用 [本轮输入 + 最近 4 条] 去匹配每个条目
  ├─ constant 条目：无条件命中
  └─ 普通条目：primary 命中 → 过 secondary（四档 selectiveLogic）
                → 过 probability 骰子
第二轮（若启用递归）：把已命中条目的正文拼进扫描文本，再扫一遍找新命中
  ├─ excludeRecursion 的条目跳过
  └─ preventRecursion 的条目只在第一轮算，且不喂正文
```

匹配细节：
- `caseSensitive`：决定拿原文还是小写文本比
- `matchWholeWords`：英文/数字走词边界正则，中文直接 `includes`（中文没有空格词边界）

### 3.3 位置分档

| `position` | 落点 |
|---|---|
| `0` | 【设定库】—— 角色设定之前 |
| `1/2/3` | 【设定库·后置】—— 角色设定之后 |
| `4` | 按 `depth` 从最新消息往上数，**splice 进【最近对话】内部** |

### 3.4 裁剪顺序（重要）

预算超了之后，**严格按这个顺序丢**：

```
1. 先丢最旧的对话（保留至少 2 条）
2. 还超 → 丢掉旧历史召回
3. 还超 → 压缩故事长档（保留结尾）
```

所以长对话里"主线"永远活到最后，先死的是细节。

### 3.5 输出形状

```
【系统】怎么演
【角色】名字 + 描述 + 性格 + 场景
【设定库】命中的世界书（前置）
【设定库·后置】
【示例】mes_example
【开场白】                    ← 仅首轮
【故事长档】主线纪要
【往事片段】召回的历史
【最近对话】角色：…… / 用户：……
              ↑ @depth 条目插在这里
【作者注】post_history
【用户】本轮输入
```

---

## 四、数据结构

### 角色卡（磁盘就是酒馆 V2）

```json
{ "spec": "chara_card_v2", "spec_version": "2.0",
  "data": { "name": "…", "description": "…", "personality": "…",
            "first_mes": "…", "mes_example": "…",
            "system_prompt": "…", "post_history_instructions": "…",
            "alternate_greetings": ["…"],
            "character_book": { "entries": [] },
            "extensions": { "stlite": { "id": "…", "world": "…" } } } }
```

内部 id / 世界书绑定存在 `data.extensions.stlite`，酒馆会忽略这个未知字段。

### 世界书（酒馆 world info）

```json
{ "entries": { "0": { "key": [], "keysecondary": [], "content": "…",
                      "constant": false, "disable": false, "order": 100,
                      "position": 0, "depth": 4, "selective": true,
                      "selectiveLogic": 0, "probability": 100,
                      "caseSensitive": null, "matchWholeWords": null,
                      "excludeRecursion": false, "preventRecursion": false } } }
```

`selectiveLogic` 四档与酒馆 `world_info_logic` **逐值一致**：`0=AND ANY / 1=NOT ALL / 2=NOT ANY / 3=AND ALL`。

### 聊天记录（一行一条）

```json
{"t":"2026-11-13 21:11:49+08","role":"char","text":"当前版本正文",
 "swipes":["第一版","第二版"],"swipeId":1,
 "swipeInfo":[{"t":"…","source":"regenerate"},{"t":"…","source":"manual"}]}
```

`text` 永远等于 `swipes[swipeId]`；只有多版本时才写 `swipes`（省空间）。
群聊记录多一个 `speaker` 字段。

### 分支与快照

```
data/chats/<卡>.jsonl              主线
data/chats/<卡>@<分支>.jsonl       分支
data/chats/<卡>.branch             当前在哪个分支（不存在 = 主线）
data/checkpoints/<卡>/<标签>-<时间>.jsonl   快照
```

---

## 五、权限模型

扮演模式 = **11 个工具**，其余 100 项全封。

```js
// 两道闸
ctx.tools.restrict({ deny: [name] })   // ① 从 schema 里隐掉（模型看不见）
ctx.tools.guard((call) => allowed(call))  // ② 执行期兜底（模型乱调也拒）
```

放行的 11 个：

| 只读 6 | `st_prompt` `st_history` `st_cards` `st_card_get` `st_world_list` `st_active` |
|---|---|
| 受控写 5 | `st_log` `st_card_patch`（字段级 merge） `st_world_add` `st_world_update` `st_story` `st_turn` |

**为什么不给 `st_card_save`**：它是整卡覆盖语义，模型漏一个字段就把人设写残；
`st_card_patch` 是服务端 merge，只改传过来的字段，且幂等 + 写前 `.bak`。

被挡掉的还包括：shell、fs 读写、glob/grep、web 搜索抓取、subagent/workflow、
QQ 桥、jobs、skill、goal、todo、schedule、plugin_manager……

> 注意一个坑：`tools.restrict` 对未知工具名是**整批原子校验**的 ——
> 一次传 100 个名字，只要有一个不存在，整批静默失败。
> 所以必须逐个 `try { restrict({deny:[name]}) } catch {}`。

---

## 六、记忆分流（st-mode + sage-mem 补丁）

```
system-prompt/assemble 事件
   ├─ sage-mem：先 await next() 拿到组装结果，再读 mode.json
   │             → 若该会话是 roleplay，直接返回原结果（不注入长期记忆）
   ├─ st-mode：注入【扮演纪律】context（order 900）
   └─ roleplay-guard：把本会话写进 mode.json（roleplay），供上面的 sage-mem 读
```

**时序要点**：guard 在**本轮** assemble 里就写入 `mode.json`，sage-mem 同一轮就能读到，不漏首轮。

---

## 七、采样温度（st-temp）

DSH 内核的 LLM 调用是一个 waterfall：

```js
// @deepseek-ai/dsh-llm
streamWithRegistration(options, prepared) {
  return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared));
}
```

`options` 是闭包共享的请求对象，监听器签名 `(options, next)`，**就地改就生效**：

```js
ctx.on('llm/stream', (options, next) => {
  const t = resolveTemperature(options.sessionId);   // sampling.json 三级优先级
  if (t !== null) options.temperature = t;
  return next();
});
```

`options.sessionId` 让"按会话/按模式"分档成为可能。
只改 `temperature`，`provider/model/maxTokens/stop` 一概不碰。

> 踩坑记录：`Number(null) === 0`、`Number('') === 0`。
> 直接把配置值 `Number()` 一遍，会让"不配置"变成温度 **0**（等价贪心解码，比低温更死板）。
> 解析函数必须先挡掉 `null/undefined/''`。

---

## 八、可移植性

每个插件启动时按这个顺序找数据目录：

```
1. 环境变量 ST_LITE_DATA（/ ST_MODE_FILE 用于 mode.json）
2. ../st-lite/data          （插件并排放在 node_modules 或 plugins 下）
3. ../../st-lite/data
4. 自己包内 ../data
```

所以**整套目录搬到任何位置都能跑**，不需要改代码里的路径。

---

## 九、扩展点

想加功能的话，改这些地方最省事：

| 想加什么 | 改哪 |
|---|---|
| 新工具 | `st-lite/src/server.js` 的 `TOOLS` 数组 + 记得同步 `roleplay-guard.mjs` 的白名单 |
| 新卡字段 | `cardToV2` / `v2ToCard` / `st_card_save` 的 schema |
| 新世界书语义 | `normalizeEntry`（读写两边）+ `scanWorld`（匹配）+ `worldToTavern`（回写） |
| 面板新页面 | `st-editor/client.js` 加一个 tab + `lib/index.js` 加一个 op 分支 |
| 新 hook | 宿主事件名在 DSH 文档里查（`system-prompt/assemble`、`tools/pre-execute`、`llm/stream` 等） |

**改 `worldToTavern` 时特别小心**：它是"内部扁平 → 酒馆格式"的映射函数，
里面有一堆字段。**同一个键不要出现两次** —— 对象字面量重复键不报错，只有最后一个生效，
表现就是"我明明写了新值，怎么没生效"。（这个坑实际发生过一次。）
`st-lite` 和 `st-editor` 各有一份 `worldToTavern`，改的时候两边都要改。
