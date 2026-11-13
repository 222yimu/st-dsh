# 安装指南

目标：在一个已经能正常运行的 DSH 上，把这套东西装好并验证通过。

全程大约 10 分钟。**建议先备份 profile 的两个配置文件**（`package.json`、`cordis.patch.yml`）。

---

## 0. 前置

| 项 | 要求 |
|---|---|
| DSH | 0.2.x（本文按 0.2.1-rc.2 写；更低版本可能没有 `llm/stream` waterfall） |
| Node.js | ≥ 18（只用到内置模块，无需 `npm install`） |
| 系统 | Windows / macOS / Linux 都行（路径用各自的写法） |

先找到你的 profile 目录：

```
Windows:  C:\Users\<你>\.dsh\profiles\<profile名>\
macOS/Linux:  ~/.dsh/profiles/<profile名>/
```

下文用 `<PROFILE>` 表示它。确认里面至少有 `package.json` 和 `cordis.patch.yml`。

---

## 1. 放插件

把 `plugins/` 下的 5 个目录整个复制进 `<PROFILE>/node_modules/`：

```
<PROFILE>/node_modules/
├── st-lite/
├── st-editor/
├── st-mode/
├── st-temp/
└── roleplay-preset/       ← 这个不是插件包，是被 preset 引用的守卫脚本，
                             也可以放在 <PROFILE>/ 根目录
```

> **为什么能并排放**：每个插件启动时会自己找数据目录 ——
> 先看环境变量 `ST_LITE_DATA`，再找 `../st-lite/data`（并排布局），最后才退回自己包内 `data/`。
> 所以只要 5 个目录挨着放，不用改任何路径。

---

## 2. 注册进 profile

编辑 `<PROFILE>/package.json`，在 `dsh.profile.bundles` 数组末尾加四项：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "……原有的……",
        "st-mode",
        "st-editor",
        "st-temp"
      ]
    }
  }
}
```

> `st-lite` 不进 bundles —— 它是 MCP 服务，在第 3 步里用 MCP 客户端挂载。
> `roleplay-preset` 也不进 —— 它被 agent preset 直接引用。

---

## 3. 改 cordis.patch.yml

编辑 `<PROFILE>/cordis.patch.yml`，**追加**下面这些段落（完整可抄版本见 `examples/cordis.patch.yml.sample`）。

### 3.1 挂 st-lite 这个 MCP 服务

```yaml
- id: mcp-st-lite
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: st-lite
    transport: stdio
    command: node
    args:
      - '<PROFILE>/node_modules/st-lite/src/server.js'
    env:
      ST_USER_NAME: '你希望角色怎么称呼你'
```

> `args` 必须是**绝对路径**。
> `ST_USER_NAME` 会替换提示词里的 `{{user}}`，不填默认「主人」。

### 3.2 声明扮演模式 preset

```yaml
- id: preset-roleplay
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: roleplay
    name: 扮演模式
    order: 20
    plugins:
      - '@deepseek-ai/dsh-persona'
      - './roleplay-preset/roleplay-guard.mjs'
      - '@deepseek-ai/dsh-compaction'
```

> `plugins` 里的 `./` 路径是相对 `<PROFILE>/` 的。守卫脚本放哪就写哪。

### 3.3 persona（扮演模式的灵魂）

persona 的内容由 `build-persona.mjs` 生成：

```bash
cd <PROFILE>/node_modules/roleplay-preset
node build-persona.mjs                                    # 自动找 st-lite/data/cards 里第一张卡
node build-persona.mjs ../st-lite/data/cards/example.json  # 或指定卡
```

它会往 `cordis.patch.yml` 里写入（或更新）`@deepseek-ai/dsh-persona` 的 `config.prefix`。
**跑之前它会自动备份** `cordis.patch.yml`。

---

## 4. 重启并验证

重启 DSH，然后按顺序检查：

| # | 检查 | 期望 |
|---|---|---|
| 1 | 设置页有没有多出「角色卡与设定」 | 有，里面有 3 个标签：角色卡 / 世界书 / 聊天 |
| 2 | 左栏有没有 `example` 这张卡 | 有，前面带 ● |
| 3 | 点开「聊天」标签 | 能看到分支下拉、采样温度输入框、快照按钮 |
| 4 | 新建会话时能不能选「扮演模式」 | 能 |
| 5 | 进扮演模式说一句话 | 角色按卡演，并且**不会**去读写你的文件 |
| 6 | 回到正常会话，问它「我电脑上有什么文件」 | 它能正常用工具（说明只有扮演被限制） |

命令行也能验（不用开界面）：

```bash
# MCP 服务本身
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node <PROFILE>/node_modules/st-lite/src/server.js

# 面板接口（DSH 运行时，端口看 DSH 的 web 地址）
curl "http://127.0.0.1:<端口>/st-editor?op=list"
curl "http://127.0.0.1:<端口>/st-mode/mode"
curl "http://127.0.0.1:<端口>/st-editor?op=sampling"
```

自测脚本（不需要 DSH 运行，直接跑）：

```bash
cd <PROFILE>/node_modules/st-lite  && node test/evolve.js       # 期望 PASS 7/7
cd <PROFILE>/node_modules/st-editor && node test/route.test.mjs # 期望 PASS 9/9
cd <PROFILE>/node_modules/st-temp  && node test/resolve.test.mjs # 期望 PASS 8 组
cd <PROFILE>/roleplay-preset       && node roleplay-guard.allowlist.test.mjs
```

---

## 5. 写你自己的卡

三条路，任选：

1. **面板写**：设置 → 角色卡与设定 → 新建卡 → 填字段 → 保存 → 「设为当前」
2. **导入酒馆的卡**：把 `.json`（V2）或 `.png`（内嵌卡）放进 `st-lite/data/imports/`，或直接点面板「导入卡」
3. **手写 JSON**：复制 `st-lite/templates/card.template.json`，改 `id` 与文件名保持一致

写卡建议看 `st-lite/WRITING-GUIDE.md`（字段分工、keys 怎么选、常驻条目的代价）。
写完跑一次校验：

```bash
node <PROFILE>/node_modules/st-lite/check-card.js <卡id>
```

---

## 采样温度（可选）

默认是关的（`sampling.json` 里全是 `null` = 不改内核默认）。想开：

- **面板**：设置 → 角色卡与设定 → 聊天 → 「采样温度」填数字 → 保存温度
- 或直接改 `st-lite/data/sampling.json`：

```json
{
  "default": null,
  "normal": null,
  "roleplay": 0.85,
  "sessions": {}
}
```

`roleplay` 只影响扮演模式。数值参考：`0.6~0.8` 很贴设定、`1.0` 平衡、`1.2+` 明显放飞。
改文件立即生效（按 mtime 缓存），改插件代码才需要重启。

---

## 卸载 / 回滚

1. 从 `package.json` 的 `bundles` 里删掉新加的三项
2. 从 `cordis.patch.yml` 里删掉三段（MCP 客户端 / preset / persona）
3. 删掉 `<PROFILE>/node_modules/` 下那 5 个目录
4. 重启

你的卡和聊天记录都在 `st-lite/data/` 里，删插件目录前记得先拷出来。

---

## 常见问题

**Q：设置页看不到「角色卡与设定」**
前端插件的挂载点是 `ctx.slots.inject('settings.section')`，`label` 是标题。如果后端接口通（`curl op=list` 返回 200）但界面没有，通常是前端包没被加载：检查 `package.json` 的 `bundles` 里有没有 `st-editor`，以及浏览器 console 有没有报错。

**Q：扮演模式里模型调不到 `st_prompt`**
MCP 服务没起来。检查 `args` 里的绝对路径对不对、`node` 在 PATH 里、以及 DSH 启动日志有没有 `mcp` 相关错误。

**Q：模型不用工具，直接瞎演**
persona 没生效。跑一次 `build-persona.mjs` 并确认 `cordis.patch.yml` 里 `@deepseek-ai/dsh-persona` 的 `config.prefix` 有内容。

**Q：温度设了没感觉**
1. `sampling.json` 里的值是不是 `null`；
2. `st-temp` 在不在 `bundles` 里；
3. 你用的 provider 网关是否转发 `temperature`（有些第三方网关会直接丢掉）。

**Q：世界书不生效**
用的是 `key` 匹配 —— 说的词里得真的出现关键词。面板里勾「常驻」可以无条件注入（但每轮都烧 token）。
`st_prompt` 返回的 `stats.loreHits` / `stats.recursionRounds` 能看出到底命中了什么。
