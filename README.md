# st-dsh · 给 DeepSeek Harness 用的「酒馆式角色扮演」套件

把 SillyTavern 那套「角色卡 + 世界书 + 长剧情 + 多分支」搬进 DSH。
**磁盘格式就是酒馆的原生格式**（Character Card V2 / world info / 聊天 jsonl），卡可以直接从酒馆搬过来，也能搬回去。

> 目标不是复刻酒馆的前端，而是把它的**数据与玩法**接到 DSH 的 agent 上：
> 用一份叫「扮演模式」的 agent preset，让模型每轮自己读卡、读世界书、读历史，然后演。

---

## 包含什么

| 部件 | 类型 | 作用 |
|---|---|---|
| **st-lite** | MCP stdio 服务 | 核心：角色卡 / 世界书 / 聊天记录 / 提示词组装，19 个 `st_*` 工具 |
| **st-editor** | DSH 插件（宿主 + 前端） | 设置页「角色卡与设定」面板：图形化写卡、写世界书、管聊天、快照、温度 |
| **st-mode** | DSH 插件（宿主 + 前端） | 「记忆」开关：正常会话用长期记忆，扮演会话只用剧情记忆 |
| **st-temp** | DSH 插件（宿主，无界面） | 采样温度控制：监听 `llm/stream` 注入 `temperature` |
| **roleplay-preset** | preset + 守卫 + persona 生成器 | 扮演模式：只给 11 个 st 工具，`persona` 写死每轮流程 |

合计约 4000 行 JS，**零第三方依赖**（只用 Node 内置模块）。

---

## 能干什么

### 角色卡与设定
- 酒馆 **Character Card V2**（`spec: chara_card_v2`）读写，`data.*` 全字段支持
- 世界书 = 酒馆 **world info**：`key` / `keysecondary`（四档 `selectiveLogic`）/ `constant` / `order` / `position` / `depth` / `probability` / `caseSensitive` / `matchWholeWords` / `excludeRecursion`
- **PNG 卡**：读 `tEXt` 里的 `chara` 段导入，导出内嵌卡的 PNG
- 多开场白 `alternate_greetings`：首轮随机（或指定第几条）

### 剧情
- 聊天记录 jsonl，含 **swipe 多版本**（`swipes[]` + `swipeId` + 每版 `swipeInfo`）
- 消息级操作：改 / 删 / 截断 / 重说（保留旧版）/ 翻版本
- **剧情分支**（`<卡>@<分支>.jsonl`）、**快照**（checkpoint，可回滚）
- 导出酒馆格式聊天 jsonl
- 群聊（多角色同场，记录带 `speaker`）

### 长剧情
- 提示词按 token 预算组装，裁剪顺序固定：**先丢最旧对话 → 再丢召回 → 最后压长档**
- 「故事长档」（`story.md`）：几千轮也记得主线
- **IDF 加权片段召回**：从旧历史里捞和当前输入相关的段落（零依赖的近似语义检索）
- 世界书**一轮递归**：命中条目的正文会再触发别的条目

### 权限
- 扮演模式只放行 11 个工具，其余 100 项 shell / 文件 / 联网 / 派生全封
- 守卫在**执行期**兜底（不只是从 schema 里隐掉）

---

## 快速开始

详见 [INSTALL.md](INSTALL.md)。三步：

1. 把 `plugins/*` 放进 DSH 的 profile（`~/.dsh/profiles/<profile>/`）
2. 按 [examples/cordis.patch.yml.sample](examples/cordis.patch.yml.sample) 改两处配置
3. 重启 DSH → 设置页出现「角色卡与设定」→ 写卡 → 新建会话选「扮演模式」

---

## 工作原理（摘要）

完整版见 [ARCHITECTURE.md](ARCHITECTURE.md)。

```
用户说话
  └─ 模型（扮演 preset 的 persona 规定流程）
       ├─ mcp__st-lite__st_prompt   ← 拿上下文
       │    ├─ 读卡 + 世界书扫描（关键词/次级/概率/递归）
       │    ├─ 故事长档 + 旧历史召回
       │    ├─ 最近对话按预算裁剪
       │    └─ 拼成一段带【小标题】的提示词 + stats
       ├─ 演
       └─ mcp__st-lite__st_log × 2  ← 落盘 user/char 两条
```

和酒馆最大的不同：**酒馆是框架每轮自动拼 messages；我们是模型按规程主动拉上下文**。
换来的是「这一轮到底喂了什么」完全可审计（`st_prompt` 会把 stats 一起返回）。

四个挂载点：

| 挂载 | 用途 |
|---|---|
| `system-prompt/assemble` | st-mode 注入扮演纪律；guard 登记会话为 roleplay |
| `tools.restrict` + `tools.guard` | 扮演模式的工具白名单与执行期兜底 |
| `llm/stream`（waterfall） | st-temp 就地改 `options.temperature` |
| `webServer.register` | st-editor / st-mode 的同源 HTTP 接口 |

---

## 与 SillyTavern 的差异

两份对照文档在 `plugins/st-lite/`：

- `COMPARISON.md` —— 功能对照表（哪些有、哪些没有、哪些是降级实现）
- `ARCHITECTURE-COMPARE.md` —— **代码级**对照（带酒馆 v1.19.0 的 `文件:行号`）

一句话总结：**数据格式全对齐、功能覆盖 RP 主干、运行机制不同**。
三处结构性差异：prompt 形态（结构化 messages vs 一整段文本）、token 预算（逐条扣减 + 真 tokenizer vs 整段估算）、
世界书引擎（状态机多轮 vs 单轮递归）。

---

## 已知限制

- 不是 embedding 语义检索，是 IDF 加权的字符片段匹配
- token 数是加权估算（可用 `st_tokens` 校准）
- 群聊是「一个模型同时演多个」，不像酒馆每轮选一个角色用它的卡
- `active.json` 是全局单值，同一时刻只有一张「当前卡」
- 没有用户 persona、没有正则脚本、没有 slash 命令

---

## 目录

```
st-dsh/
├── README.md                 ← 本文件
├── INSTALL.md                安装与验证
├── ARCHITECTURE.md           工作原理
├── examples/
│   └── cordis.patch.yml.sample
└── plugins/
    ├── st-lite/              MCP 服务 + 数据目录（含示例卡）
    ├── st-editor/            设置页面板
    ├── st-mode/              记忆模式开关
    ├── st-temp/              采样温度
    └── roleplay-preset/      preset 守卫 + persona 生成器
```

## 许可证

MIT。随便改、随便发，出事别找我。
