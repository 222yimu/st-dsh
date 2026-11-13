# st-editor · 角色卡 / 世界书编辑器（酒馆格式）

入口是 **DSH 设置页里的「角色卡与设定」分区**（和 sage-mem 的「记忆管理」并列）→ 左选卡 → 右填表 → 保存。磁盘上存的就是酒馆的原生格式。

> 关键：前端插件的挂载点是 `ctx.slots.inject("settings.section")`。
> 之前挂在 `"shell.overlay"` 上 —— 那个 slot 在本版 DSH 不生效，注册不报错、界面什么都没有，
> 这正是「后端全好但一直看不到 UI」的真因。

## 三个要点

1. **磁盘格式 = 酒馆**
   - 角色卡：Character Card V2 → `{ "spec": "chara_card_v2", "data": { name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, alternate_greetings, character_book, tags, creator_notes, extensions: { stlite: { id, world, created, updated } } } }`
   - 世界书：SillyTavern world info → `{ "entries": { "0": { uid, stliteId, key: [], content, constant, disable, order, probability, depth, … } } }`
   - 所以 `data/cards/*.json`、`data/worlds/*.json` 可以**直接跟酒馆互拷**
2. **导入 / 导出**（面板顶部四个按钮）
   - 导入卡：吃 Character Card V2 JSON（也兼容旧扁平 JSON）；卡里带 `character_book` 会顺带落成世界书
   - 导出卡：输出 V2 JSON（`.card.json`）
   - 导入书 / 导出书：吃/吐 world info JSON（`.lorebook.json`）
   - PNG 内嵌卡暂不支持（需要 tEXt chunk 与底图，JSON 两头通就够了）
3. **token 用量**：底栏常驻显示「固定开销 / 常驻条数 / 还能装几轮历史」，跟着编辑实时变

## 面板

```
┌─ 设定编辑 ── 新建卡 导入卡 导出卡 导入书 导出书 刷新 关闭 ─┐
│ 卡列表        │ [角色卡] [世界书]                        │
│ ○ DeepSeek   │  id / 名字 / 身份与外貌 / 性格 /           │
│   0 轮 · example │  场景 / 开场白 / 对话示例 / 扮演规则 /     │
│              │  作者注 / 世界书id / 标签（每栏带灰字提示） │
├──────────────┴──────────────────────────────────────────┤
│ [保存]  固定开销 634 token · 常驻 2 条 · 剩余 ≈ 89 轮      │
└─────────────────────────────────────────────────────────┘
```

世界书页每条可改 `keys`（逗号分隔）/ 内容 / 优先级 / 常驻 / 停用 / 删除，可新增。

## 后端接口（同源）

| 方法 | URL | 作用 |
|---|---|---|
| GET | `/st-editor?op=list` | 列卡与世界书 |
| GET | `/st-editor?op=card&id=` | 读卡 + 世界书 + token 统计 |
| POST | `/st-editor?op=card` | 存卡（写 V2） |
| GET | `/st-editor?op=world&id=` | 读世界书 |
| POST | `/st-editor?op=world` | 存世界书（写 world info） |
| GET | `/st-editor?op=export-card&id=` | 导出 V2 |
| GET | `/st-editor?op=export-world&id=` | 导出 lorebook |
| POST | `/st-editor?op=import-card` | 导入卡（body `{raw, id?}`） |
| POST | `/st-editor?op=import-world` | 导入世界书（body `{raw, id}`） |

读写 `<PLUGINS>\st-lite\data`（`ST_LITE_DATA` 可覆盖，测试就靠它）。写前 `cp <文件> <文件>.bak`，原子写。

## 校验（保存时）

- 卡：`id` 合法、`name` 非空、`description` 非空
- 世界书：`id` 非空、`entry id` 不重复、`content` 非空、**非 constant 必须有关键词**

## 什么时候能用

**常驻**。重启 DSH 后进「设置」→ 分区里多一项 **「角色卡与设定」**，随时点开就能改；
不跟记忆模式、agent 预设挂钩。

就这一个入口（2026-11-13 对方要求删掉浏览器兜底）：
早先那套 `?op=ui` 内联页、`standalone.mjs` 独立服务、`启动设定编辑器.cmd` 都已移除。


## 测试

```
node test\route.test.mjs
# PASS 9/9：list / 读卡+统计 / 存卡(V2+.bak) / 空字段校验 / 世界书存 / 无 keys 校验
#             / 导出 V2+lorebook / 导入卡 / 内嵌 character_book 导入
```

## 安装

| 位置 | 说明 |
|---|---|
| `<PLUGINS>\st-editor\` | 源 |
| `%USERPROFILE%\.dsh\profiles\desktop\node_modules\st-editor\` | 实际加载副本（改完同步，哈希已对齐） |
| profile `package.json` 的 `dsh.profile.bundles` | 含 `st-editor` |

## 生效 / 排查

**重启 DSH**（前端 + 宿主都要重载）。没出现按钮时：
1. 先确认当前会话是**扮演**模式（normal 下它本来就该消失）
2. 浏览器 console 搜 `[st-editor]`
3. `http://127.0.0.1:52337/st-editor?op=list` 能不能返回 JSON

## 回滚

```powershell
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json.bak-20261113-steditor" `
          "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Force
Remove-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\st-editor" -Recurse -Force
```
