# 与 SillyTavern 的功能对照（2026-11-13）

> 说明：这次**没能抓到酒馆源码** —— `raw.githubusercontent.com`、`docs.sillytavern.app`、`github.com`
> 三个入口分别报「解析到非公网 IP」和「内网地址已阻止」，是被网络层拦的。
> 所以下表按 **SillyTavern 公认的核心功能集**逐项比对，并**实测核对我们自己的代码**（不只 grep 字段，
> 还看逻辑是否真的读取）。标注 `字段有但逻辑不生效` 的项就是踩过的那种坑。

图例：✅ 对齐 · ⚠️ 降级实现 · ❌ 缺 · ➖ 不归我们这层

## A. 角色卡

| 能力 | 酒馆 | 我们 | 状态 |
|---|---|---|---|
| 卡的增删改查 | ✅ | `st_card_save` / `st_card_patch` / `st_card_get` / `st_cards` | ✅ |
| Character Card V2 导入/导出 | ✅ | 导入导出都是 V2，`.card.json` | ✅ |
| PNG 内嵌卡（tEXt chunk） | ✅ | ✅ `st_png op=import/export`：读 PN 的 `chara` 段；导出 1×1 PNG 内嵌卡 | ✅（今天补的） |
| 卡内嵌 `character_book` | ✅ | 导入时自动落成世界书 | ✅ |
| `alternate_greetings` 多开场白 | ✅ 随机挑一条 | ✅ 第一轮随机挑（`greeting` 可指定第几条），只在没历史时出现 | ✅（今天补的） |
| 字段级编辑（不冲掉其他字段） | ✅ | `st_card_patch` 服务端 merge | ✅ |
| 宏 `{{char}}` / `{{user}}` | ✅ | 组装时替换（`{{user}}` 默认「对方」，`ST_USER_NAME` 可改） | ✅（今天补的） |

## B. 世界书 / Lorebook

| 能力 | 酒馆 | 我们 | 状态 |
|---|---|---|---|
| 条目增删改查 | ✅ | `st_world_add` / `st_world_update` / `st_world_list` | ✅ |
| primary keys 命中注入 | ✅ | `matchWorldEntries` | ✅ |
| secondary keys（AND 逻辑） | ✅ | ✅ `secondaryPass`：0=任一 / 1=非全 / 2=全不 / 3=全部 | ✅（今天补的） |
| `constant` 常驻 | ✅ | ✅ | ✅ |
| 插入位置 `position` / `depth` | ✅ before/after char、@depth 插入 | ✅ 0=设定前 · 1/2/3=设定后 · 4=按 depth 插进最近对话 | ✅（今天补的） |
| 递归扫描 / exclude / prevent | ✅ | 写死 false，不读 | ❌ |
| 概率激活 / 分组评分 | ✅ | 写死 100 / 不读 | ❌ |
| scan depth（拿多少上下文去匹配） | ✅ 可配 | 固定「本轮输入 + 最近 4 条」 | ⚠️ |
| 全局世界书 + 卡绑定世界书 | ✅ 两层 | 只有卡绑定（`world` 字段） | ⚠️ |
| 真·世界书文件互拷 | ✅ | 磁盘就是 world info 格式，可直接互拷 | ✅ |

## C. 上下文与长期记忆（长剧情的关键）

| 能力 | 酒馆 | 我们 | 状态 |
|---|---|---|---|
| 上下文窗口可调 | ✅ context size | `st_prompt { budget, historyTurns }`，默认 16000 / 200 条 | ✅ |
| 超预算裁剪策略 | ✅ 多种 | 先丢最旧对话 → 再丢召回片段 → 最后压缩长档 | ✅（方向对） |
| 聊天记录持久化 | ✅ | `data\chats\<卡>.jsonl` | ✅ |
| 对话总结（summarize） | ✅ 一键总结注入 | `st_story` 长档，我来写（20~30 轮一次） | ⚠️ 半自动 |
| 向量检索 / Data Bank | ✅ embedding RAG | ⚠️ IDF 加权 + 覆盖度 + 位置先验的片段召回（无 embedding，但比裸重合度稳） | ⚠️ 降级 |
| 剧情快照（checkpoint） | ✅ | ✅ `st_checkpoint` save/list/restore（`data/checkpoints/<卡>/`） | ✅（今天补的） |
| Author's Note | ✅ | `post_history`（作者注） | ✅ |
| 场景/示例/性格分段 | ✅ | ✅ | ✅ |

## D. 交互与聊天管理

| 能力 | 酒馆 | 我们 | 状态 |
|---|---|---|---|
| 多会话 / 分支 / checkpoint | ✅ | ✅ 分支：`st_branch` + 面板下拉切换（`<卡>@<分支>.jsonl`） | ✅（今天补的） |
| 消息编辑 / 删除 / 重生成（swipe） | ✅ | ✅ `st_turn`：list/delete/edit/truncate/regenerate；面板「聊天」页每行都有按钮 | ✅（今天补的） |
| 聊天导出 | ✅ | ✅ `st_export` + `op=export-chat`，输出酒馆 jsonl（name/is_user/mes/send_date） | ✅（今天补的） |
| 图形编辑界面 | ✅ | 设置页「角色卡与设定」（左列表 + 表单 + token 预算） | ✅（子集） |
| token 用量显示 | ✅ | 面板底栏 + `stats` | ✅ |

## E. 多角色 / 用户

| 能力 | 酒馆 | 我们 | 状态 |
|---|---|---|---|
| 群聊（多角色同场、发言顺序） | ✅ | ✅ `st_group` + `st_prompt { group }` + `st_log { group, speaker }`（记录带 speaker，世界书按成员合并） | ✅（今天补的） |
| 用户 persona（多身份切换） | ✅ | 只有「对方」一个称呼 | ❌ |

## F. 其它

| 能力 | 酒馆 | 我们 | 状态 |
|---|---|---|---|
| 模型接入 / 采样参数 | ✅ | 由 DSH 提供 | ➖ |
| 正则 / 扩展脚本 | ✅ | 无 | ❌ |
| TTS / 出图 / 表情 | ✅ | DSH 另有插件 | ➖ |
| 每卡独立人设与世界书 | ✅ | ✅（`world` 字段） | ✅ |

## 结论

**核心 RP 闭环是成立的**：卡 → 世界书命中 → 上下文预算 → 历史持久 → 长档续命 → 设定随剧情演进。
日常"演几千轮、主线不断"这条线能跑通。

**没实现的主要是两类：**

1. **交互层**（酒馆里人天天用的）：分支、swipe 重生成、单条消息编辑/删除、聊天导出。
   这些在 DSH 里属于"消息层"能力，得靠前端插件做，不是 st-lite 的事。
2. **高级世界书语义**：secondary keys、position/depth、递归、概率。
   **危险点**：从酒馆导入带这些设置的卡，我们只当"普通条目"处理 —— 不报错，但行为不同。

## 建议优先级

| 优先级 | 事项 | 理由 |
|---|---|---|
| P0 | `alternate_greetings` 真的用起来（随机/指定开场白） | 酒馆卡大量使用，现在完全被忽略 |
| P0 | `secondary keys` 与 `position/depth` 至少**读**（不读也比现在误当普通条目好） | 兼容性，导入了行为不对 |
| P1 | 聊天导出 / 删除某条 / 重生成 | 日常修剧情必需 |
| P2 | 分支与 checkpoint | 长剧情试错成本高 |
| P3 | 向量检索（接 embedding）、群聊、用户 persona | 大工程，按需 |
