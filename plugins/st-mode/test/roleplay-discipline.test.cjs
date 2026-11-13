// 扮演模式硬规则测试：roleplay 会话必须注入纪律段，normal 会话必须不注入。
// 用法：node D:\ymLN\dsh-plugins\st-mode\test\roleplay-discipline.test.cjs
// 会临时改 mode.json，finally 里写回原样。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const MODE_FILE = 'D:\\ymLN\\dsh-plugins\\st-mode\\data\\mode.json';
const RULE_NAME = 'st-mode:roleplay-discipline';
const ROLEPLAY_SESSION = 'session-test-roleplay-0001';
const NORMAL_SESSION = 'session-test-normal-0001';

const original = fs.existsSync(MODE_FILE) ? fs.readFileSync(MODE_FILE, 'utf8') : null;

function sandboxAssembly() {
  return { contexts: [{ name: 'base', order: 1, text: 'base context' }] };
}

(async () => {
  try {
    const state = original ? JSON.parse(original) : { default: 'normal', sessions: {} };
    state.default = 'normal';
    state.sessions = { ...(state.sessions || {}), [ROLEPLAY_SESSION]: 'roleplay', [NORMAL_SESSION]: 'normal' };
    fs.writeFileSync(MODE_FILE, JSON.stringify(state, null, 2), 'utf8');

    const mod = await import('file:///D:/ymLN/dsh-plugins/st-mode/lib/index.js');
    const handlers = [];
    const ctx = { on: (event, fn) => { if (event === 'system-prompt/assemble') handlers.push(fn); } };
    mod.apply(ctx);

    assert.strictEqual(handlers.length, 1, '应当注册一个 assemble 监听器');
    const handler = handlers[0];
    const next = async () => sandboxAssembly();

    // 1) roleplay：注入
    const rp = await handler(sandboxAssembly(), { agent: { session: { id: ROLEPLAY_SESSION } } }, next);
    const rule = rp.contexts.find((c) => c.name === RULE_NAME);
    assert.ok(rule, 'roleplay 会话必须注入纪律段');
    assert.ok(rule.text.includes('禁止调用任何工具'), '规则正文要含禁止调用工具');
    assert.ok(rp.contexts.some((c) => c.name === 'base'), '不能冲掉已有 context');

    // 2) 去重：同一轮重复调用只加一条
    const twice = await handler(rp, { agent: { session: { id: ROLEPLAY_SESSION } } }, next);
    assert.strictEqual(twice.contexts.filter((c) => c.name === RULE_NAME).length, 1, '不得重复注入');

    // 3) normal：不注入
    const nm = await handler(sandboxAssembly(), { agent: { session: { id: NORMAL_SESSION } } }, next);
    assert.ok(!nm.contexts.some((c) => c.name === RULE_NAME), 'normal 会话不得注入');

    // 4) 未知会话走 default（normal）→ 不注入
    const unk = await handler(sandboxAssembly(), { agent: { session: { id: 'session-unknown-0002' } } }, next);
    assert.ok(!unk.contexts.some((c) => c.name === RULE_NAME), 'default=normal 时不得注入');

    // 5) 键容错：会话 id 不带 session- 前缀也能匹配
    const bare = await handler(sandboxAssembly(), { agent: { session: { id: 'test-roleplay-0001' } } }, next);
    assert.ok(bare.contexts.some((c) => c.name === RULE_NAME), '去前缀键也要命中');

    console.log('PASS 4/4：roleplay 注入、去重、normal 不注入、键容错');
  } finally {
    if (original !== null) fs.writeFileSync(MODE_FILE, original, 'utf8');
    console.log('mode.json 已还原');
  }
})().catch((err) => {
  console.error('FAIL', err && err.message ? err.message : err);
  process.exit(1);
});
