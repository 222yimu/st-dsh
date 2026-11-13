# st-temp · 采样温度控制器

给 DSH 加了**真正的 temperature 控制**：不是提示词模拟，是改模型请求里的采样参数。

## 原理（从 DSH 0.2.1-rc.2 内核核实的）

```js
// @deepseek-ai/dsh-llm 的 LlmRuntime
stream(options) { return this.streamWithRegistration(options); }
streamWithRegistration(options, prepared) {
  return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared));
}
```

- `llm/stream` 是 **waterfall**（瀑布式事件），`options` 是闭包共享的请求对象
- 监听器签名是 `(options, next)`（内核自己的插件就这么写：
  `ctx.on('llm/stream', (options, next) => { ...; return next(); })`）
- **就地改 `options` 就影响本次请求**，不需要返回值
- `options.sessionId` 存在 → 可以按会话区分
- 类型定义 `LlmCallControls` 里明确有 `temperature?: number`（还有 `maxTokens` / `stop` / `reasoningEffort`）

对比：`@deepseek-ai/dsh-agent-default-model` 的 Config 只有 `provider / model / reasoningEffort`，
**没有 temperature** —— 所以改 profile 的模型配置是没用的，必须走请求层。

## 配置

`<PLUGINS>\st-lite\data\sampling.json`

```json
{
  "default": null,      // 兜底；null = 不改（沿用内核/提供方默认）
  "normal": null,       // 正常会话
  "roleplay": 0.85,     // 扮演模式会话
  "sessions": { "session-xxxx": 0.5 }   // 指定会话，优先级最高
}
```

优先级：`sessions[会话id]` → `roleplay/normal`（按 st-mode 的 mode.json 判断）→ `default` → 不改。
会话 id 键容错：带不带 `session-` 前缀都认。

## 改值的三条路

1. **面板**：设置 → 角色卡与设定 → 聊天 → 「采样温度」填数字 → 保存温度
2. **接口**：`GET /st-editor?op=sampling` / `POST /st-editor?op=sampling { sampling: { roleplay: 0.85 } }`
3. **直接改文件**：编辑上面的 sampling.json（插件按 mtime 缓存，改完立刻生效，不用重启）

## 数值参考

| 温度 | 体感 |
|---|---|
| 0.5 ~ 0.7 | 很贴设定、照本宣科、偶尔复读 |
| 0.8 ~ 1.0 | 平衡（DeepSeek 默认行为大致在这一带） |
| 1.1 ~ 1.4 | 明显放开，会自己加戏、可能编设定外的细节 |
| > 1.5 | 容易跑偏、语义发散 |

## 生效条件

- **要重启一次 DSH**（插件是启动时加载的）
- 提供方适配器必须转发 `temperature`（DeepSeek 官方 API 支持；某些第三方网关会忽略）
- 只改 `temperature`，provider / model / maxTokens / stop 一概不碰

## 坑（踩过一次）

`Number(null) === 0`、`Number('') === 0`。如果直接把配置值 `Number()` 一遍，
**"不配置"会变成温度 0**（贪心解码，比低温还死板）。`num()` 里必须先挡掉 `null/undefined/''`。

## 测试

```
node test/resolve.test.mjs
→ PASS 8 组：会话优先 / 按模式 / 键容错 / 落 default / null 不改 / 非法值忽略 / 注册监听 / 脏数据不炸
```
