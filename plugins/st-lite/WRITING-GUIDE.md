# 怎么写角色卡和世界书

写给对方看的最短路径。三种写法，按顺手程度挑。

## 一、三条路

| 写法 | 怎么做 | 适合 |
|---|---|---|
| **口述，我来写**（最省事） | 你说话，我在 normal 模式里用 `st_card_save` / `st_world_add` 写盘 | 懒得碰 JSON |
| **手写 JSON** | 复制模板改字段，改完跑校验 | 想自己控细节 |
| **演着演着长出来** | 扮演中我按剧情用 `st_card_patch` / `st_world_add` 增量改 | 不想一次定死设定 |

模板在这：
- `<PLUGINS>\st-lite\templates\card.template.json`
- `<PLUGINS>\st-lite\templates\world.template.json`

复制到 `data\cards\<你的id>.json` 和 `data\worlds\<同一个id>.json`，**把里面 `id` 和文件名改成一致**（校验会查这条）。

## 二、角色卡：每个字段是干什么的

卡的字段不是随便堆的，位置决定它什么时候进上下文：

| 字段 | 写什么 | 别写什么 | 建议体量 |
|---|---|---|---|
| `system` | 扮演规则：第一人称、不跳出角色、动作怎么标、语言 | 具体人设内容（那是 description 的活） | 50~250 token |
| `description` | **客观是谁**：外貌、身份、和对方的关系 | 行为指令（"她会撒娇"→放 personality） | 200~400 token |
| `personality` | 性格、说话习惯、情绪倾向、小癖好 | 外貌 | 80~200 token |
| `scenario` | 你俩在什么场景相处 | 剧情大纲 | 一句~两句话 |
| `first_mes` | 第一次见面的开场白（带动作） | 后续剧情 | 1 段 |
| `mes_example` | 1~2 组「用户：… / 角色：…」，**用来定语气** | 大段情节 | ≤400 token |
| `post_history` | 作者注：**绝不能忘**的（称呼、禁忌、底线） | 普通设定 | ≤150 token |
| `world` | 指向世界书 id | — | — |
| `tags` | 分类用，不进提示词 | — | — |

一句话记法：**description 管"是什么"，personality 管"怎么反应"，system 管"怎么演"，post_history 管"死也不能忘的"。**

## 三、世界书：keys 是全部关键

世界书的条目只在**命中**时进上下文（`constant: true` 除外），所以条目写得好不好，80% 看 keys。

### keys 三条铁律

1. **长一点、具体一点**：`体重`、`变重`、`重了` 比单个 `重` 安全 —— 单字 `重` 会在"重要""重复""重来"里全命中。
2. **用你说话时真会出现的词**：`你`、`对方`、`晚饭`、`加班`。别用书面词（"饕餮""休憩"）。
3. **一条 2~4 个 key 就够**，多了等于常驻。

### 什么时候用 `constant: true`

- 只有"永远成立、又短"的才常驻：对方是谁、称呼、一两条铁律。
- **建议 ≤3 条、合计 ≤600 token**。常驻内容每轮都烧，多一条就少几轮历史。

### priority

命中多条时按 priority 降序拼。常用：铁律 10、重要关系 8、生活偏好 5、冷知识 1~3。

### 条目 id

用 `e1`、`e2`…（服务端新增时自己按最大号 +1，不会撞）。改条目要用 id 定位，所以别乱改 id。

## 四、写完必跑：校验脚本

```powershell
cd <PLUGINS>\st-lite
node check-card.js example                    # 用 id
node check-card.js D:\path\to\card.json   # 或用文件路径
```

它会告诉你：

- JSON 有没有语法错、`id` 和文件名是否一致、`world` 指向的世界书在不在
- 每个字段各占多少 token、卡头固定开销多少、**还能装几轮历史**
- 世界书：空条目、重复 id、没有 keys 又不 constant 的死条目、单字 key 误命中风险、共用 key、常驻条目数量与体积

输出 `OK` 才算写完；`ERROR` 必须修，`WARN` 是建议。

## 五、写完看效果（不用开演）

```powershell
# 直接看拼出来的提示词长什么样
node -e "..."   # 或者在 normal 模式里让我调 st_prompt 把 prompt 打给你看
```

正常流程：写卡 → `check-card.js` → 让我 `st_prompt {card:"你的id", userMessage:"随便一句话"}` 看拼装结果 → 满意了再去扮演模式开演。

## 六、演起来之后设定会自己长

扮演模式里我有三个受控写入工具：

| 工具 | 什么时候用 |
|---|---|
| `st_world_add` | 剧情出了新事实（新称呼、约定、秘密） |
| `st_world_update` | 旧条目被剧情推翻或要补充 |
| `st_card_patch` | 我的性格/说话方式有持久变化（只传要改的字段） |

**不会**做的事：整卡覆盖（`st_card_save` 在扮演模式里被禁）、往世界书灌日常废话（下雨、吃饭只进历史）。

改坏了随时退回：`data\cards\example.json.bak` / `data\worlds\example.json.bak` 复制回原名即可（服务端每次写盘前自动存一份）。

## 七、常见翻车点

| 现象 | 原因 | 修法 |
|---|---|---|
| 角色不按人设说话 | `description` 太虚，`mes_example` 没有 | 加一组示例对话，语气照它学 |
| 演几轮就忘了前面的设定 | 世界书条目没 keys / keys 太偏 | 补 key，或把关键条改成 constant |
| 每轮都在提某件小事 | 那条被设成 constant 了 | 改成 keys 命中制 |
| 提示词爆预算，历史被裁光 | 卡头 + 常驻条目太大 | `check-card.js` 看数字，压 description / 常驻条目 |
| 说不该说的话（禁忌破了） | 禁忌只写在 description 里 | 挪进 `post_history`，或世界书 constant 一条 |
