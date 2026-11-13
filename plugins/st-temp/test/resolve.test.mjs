// st-temp 单元测试：温度解析优先级 + waterfall 注入行为（不碰真实 data 文件）
import assert from 'node:assert';
import { resolveTemperature, apply } from '../lib/index.js';

const sampling = {
  default: 1.0, normal: 0.7, roleplay: 1.3,
  sessions: { 'session-abc': 0.5 },
};
const mode = { default: 'normal', sessions: { 'session-xyz': 'roleplay' } };

// 1) 会话级优先
assert.strictEqual(resolveTemperature('session-abc', { sampling, mode }), 0.5, '会话级应最优先');

// 2) 按模式取值
assert.strictEqual(resolveTemperature('session-xyz', { sampling, mode }), 1.3, 'roleplay 会话取 roleplay 值');
assert.strictEqual(resolveTemperature('session-other', { sampling, mode }), 0.7, '普通会话取 normal 值');

// 3) 模式键容错（去前缀 / 补前缀）
assert.strictEqual(resolveTemperature('xyz', { sampling, mode }), 1.3, '不带前缀也要认出来');
assert.strictEqual(resolveTemperature('session-xyz', { sampling, mode: { sessions: { xyz: 'roleplay' } } }), 1.3);

// 4) 没配模式值 → 落 default
assert.strictEqual(resolveTemperature('s1', { sampling: { default: 0.8 }, mode }), 0.8);

// 5) 全 null → null（不改）
assert.strictEqual(resolveTemperature('s1', { sampling: { default: null }, mode }), null);
assert.strictEqual(resolveTemperature('s1', { sampling: {}, mode }), null);

// 6) 非法值当没配
assert.strictEqual(resolveTemperature('s1', { sampling: { default: 'abc' }, mode }), null);
assert.strictEqual(resolveTemperature('s1', { sampling: { default: -1 }, mode }), null);
assert.strictEqual(resolveTemperature('s1', { sampling: { default: '0.6' }, mode }), 0.6, '数字字符串要认');

// 7) apply 注册 llm/stream 且能改 options
let listener = null;
const ctx = { on: (name, fn) => { if (name === 'llm/stream') listener = fn; } };
apply(ctx);
assert.ok(typeof listener === 'function', '应注册 llm/stream 监听');

// 用真实文件路径不可控，这里只验证"不该改时不改"和"next 一定被调用"
let nextCalled = 0;
const options = { provider: 'x', model: 'y', sessionId: 'session-none' };
listener(options, () => { nextCalled++; });
assert.strictEqual(nextCalled, 1, 'next() 必须被调用');
assert.ok(!('temperature' in options) || options.temperature === undefined, '空配置时不该注入温度');

// 8) options 为脏数据也不炸
nextCalled = 0;
listener(null, () => { nextCalled++; });
assert.strictEqual(nextCalled, 1, 'options 为 null 时仍要 next()');

console.log('PASS 8 组：会话优先 / 按模式 / 键容错 / 落 default / null 不改 / 非法值忽略 / 注册监听 / 脏数据不炸');
