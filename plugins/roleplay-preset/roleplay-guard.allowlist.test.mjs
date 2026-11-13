// 扮演模式白名单测试（第三版：只读 + 受控写入，共 9 个 st-lite 工具）
// 跑法：node <PROFILE>\roleplay-guard.allowlist.test.mjs
// 不碰真实 mode.json：ST_MODE_FILE 指向临时文件
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const dir = mkdtempSync(join(tmpdir(), 'roleplay-guard-'));
const modeFile = join(dir, 'mode.json');
process.env.ST_MODE_FILE = modeFile;
writeFileSync(modeFile, JSON.stringify({ default: 'normal', sessions: {} }, null, 2), 'utf8');

const mod = await import('file:///C:/Users/ymLN/.dsh/profiles/desktop/roleplay-guard.mjs');

const restricted = [];
const guards = [];
const handlers = [];
const ctx = {
  tools: {
    restrict: ({ deny }) => restricted.push(deny[0]),
    guard: (fn) => guards.push(fn),
  },
  on: (event, fn) => {
    if (event === 'system-prompt/assemble') handlers.push(fn);
  },
};

mod.apply(ctx);

// ── 1) 白名单：7 个只读 + 3 个受控写入 + 长档 ───────────────────────────
const READ_ONLY = ['st_prompt', 'st_history', 'st_log', 'st_cards', 'st_card_get', 'st_world_list'];
const WRITABLE = ['st_card_patch', 'st_world_add', 'st_world_update', 'st_story', 'st_turn'];

assert.strictEqual(mod.ALLOWED_TOOLS.length, 11, '白名单应恰好 11 个');
for (const name of [...READ_ONLY, ...WRITABLE]) {
  assert.ok(mod.ALLOWED_TOOLS.includes(`mcp__st-lite__${name}`), `白名单应含 ${name}`);
}
// 整卡覆盖的 save 必须留在外面
assert.ok(!mod.ALLOWED_TOOLS.includes('mcp__st-lite__st_card_save'), 'st_card_save 不能进白名单');

// ── 2) restrict：白名单不挡，其余照挡 ─────────────────────────────────
for (const name of mod.ALLOWED_TOOLS) {
  assert.ok(!restricted.includes(name), `${name} 不能被 restrict`);
}
assert.ok(restricted.includes('mcp__st-lite__st_card_save'), '整卡覆盖必须被挡');
assert.ok(restricted.includes('pwsh'), 'shell 必须被挡');
assert.ok(restricted.includes('write'), '写工作区文件必须被挡');
assert.ok(restricted.includes('read'), '读工作区文件必须被挡');
assert.ok(restricted.includes('web_search'), '联网必须被挡');
assert.ok(restricted.includes('subagent'), '派生 agent 必须被挡');
assert.ok(restricted.includes('mcp__snowluma__qq_send_message'), 'QQ 桥必须被挡');

// ── 3) guard：白名单放行，其它全拒 ────────────────────────────────────
assert.strictEqual(guards.length, 1, '应当注册一个执行期守卫');
const guard = guards[0];
for (const name of mod.ALLOWED_TOOLS) {
  assert.strictEqual(guard({ name }), undefined, `${name} 应放行`);
}
for (const bad of ['pwsh', 'read', 'write', 'web_search', 'mcp__snowluma__qq_reply', 'mcp__st-lite__st_card_save', 'anything']) {
  assert.strictEqual(typeof guard({ name: bad }), 'string', `${bad} 应被拒绝`);
}
assert.strictEqual(typeof guard(undefined), 'string', '空工具名也应拒');

// ── 4) assemble：登记 roleplay ────────────────────────────────────────
assert.strictEqual(handlers.length, 1, '应当注册一个 assemble 钩子');
await handlers[0]({}, { agent: { session: { id: 'session-rp-001' } } }, async () => ({ contexts: [] }));
await handlers[0]({}, { agent: { session: { id: 'session-rp-001' } } }, async () => ({ contexts: [] }));
const state = JSON.parse(readFileSync(modeFile, 'utf8'));
assert.strictEqual(state.sessions['session-rp-001'], 'roleplay', '会话应登记为 roleplay');
assert.strictEqual(state.default, 'normal', 'default 不能被改');
assert.strictEqual(Object.keys(state.sessions).length, 1, '重复调用不应重复登记');
await handlers[0]({}, {}, async () => ({ contexts: [] }));

rmSync(dir, { recursive: true, force: true });
console.log(`PASS：白名单 9 项（6 只读 + 3 受控写入）放行、restrict ${restricted.length} 项、guard 全拒、assemble 登记 roleplay`);
