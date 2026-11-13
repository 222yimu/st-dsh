// 剧情驱动的设定演进自测：st_card_patch / st_world_add / st_world_update
// 盘上是酒馆格式（卡 = Character Card V2，世界书 = world info），跑完把 data 原样还原。
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// 自动发现第一张卡（你的卡叫什么都能跑）
const CARD_DIR = path.join(ROOT, 'data', 'cards');
const FIRST_CARD = fs.readdirSync(CARD_DIR).filter((f) => f.endsWith('.json')).sort()[0];
if (!FIRST_CARD) { console.error('data/cards 里没有卡，先放一张'); process.exit(1); }
const CARD_ID = path.basename(FIRST_CARD, '.json');
const CARD = path.join(CARD_DIR, FIRST_CARD);
const WORLD = path.join(ROOT, 'data', 'worlds', CARD_ID + '.json');
const snap = { card: fs.readFileSync(CARD, 'utf8'), world: fs.readFileSync(WORLD, 'utf8') };

// 把酒馆 V2 卡拍平成内部字段（与 server 的 v2ToCard 同语义）
function readCardFlat() {
  const raw = JSON.parse(fs.readFileSync(CARD, 'utf8'));
  const d = raw.data || raw;
  return {
    raw,
    name: d.name,
    description: d.description,
    personality: d.personality,
    system: d.system_prompt,
    post_history: d.post_history_instructions,
    tags: d.tags,
  };
}
function readWorldEntries() {
  const raw = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
  const list = Array.isArray(raw.entries) ? raw.entries : Object.values(raw.entries || {});
  return { raw, list };
}

const server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
server.stdout.setEncoding('utf8');
server.stdout.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

let seq = 0;
function call(method, params) {
  const id = ++seq;
  return new Promise((resolve) => { pending.set(id, resolve); server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
}
async function tool(name, args) {
  const res = await call('tools/call', { name, arguments: args });
  const text = res.result.content[0].text;
  if (res.result.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}
function ok(cond, msg) { if (!cond) throw new Error('断言失败: ' + msg); }

(async () => {
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'evolve', version: '0' } });

    const list = await call('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    ok(names.includes('st_card_patch') && names.includes('st_world_update'), '应注册 patch/update');
    console.log('tools ->', names.join(', '));

    const before = readCardFlat();
    ok(before.raw.spec === 'chara_card_v2', '磁盘上卡应是 Character Card V2');

    const patched = await tool('st_card_patch', { id: CARD_ID, post_history: before.post_history + ' 剧情：开始用「对方」以外的方式撒娇。' });
    ok(patched.ok && patched.changed.includes('post_history'), 'patch 应改到 post_history');
    const after = readCardFlat();
    ok(after.description === before.description, 'description 不能被改');
    ok(after.system === before.system, 'system_prompt 不能被改');
    ok(after.post_history !== before.post_history, 'post_history 应变化');
    console.log('st_card_patch -> changed:', patched.changed.join(','));

    const same = await tool('st_card_patch', { id: CARD_ID, post_history: after.post_history });
    ok(same.note === '没有字段变化', '同值应报没有变化');
    console.log('st_card_patch(幂等) ->', same.note);

    const added = await tool('st_world_add', { world: CARD_ID, keys: ['雨', '窗'], content: '测试条目：下雨时她会把窗帘拉开一点。', priority: 3 });
const expectedId = added.entry;   // 不预测编号，用服务端返回的
    ok(/^e\d+$/.test(String(added.entry)), `应返回形如 eN 的条目 id，实际 ${added.entry}`);
    const baseTotal = added.total;   // 以实际条数为基准
ok(Number.isFinite(baseTotal) && baseTotal > 0, `条目数应大于 0，实际 ${baseTotal}`);
    const afterAdd = readWorldEntries();
    const e5 = afterAdd.list.find((e) => e.stliteId === expectedId);
    ok(e5, `world info 里应有 stliteId=${expectedId} 的条目`);
    ok(Array.isArray(e5.key) && e5.key.includes('雨'), '酒馆字段 key 应是数组且含「雨」');
    console.log('st_world_add ->', added.entry, '| 酒馆条目 uid', e5.uid, 'key', JSON.stringify(e5.key));

    const updated = await tool('st_world_update', { world: CARD_ID, entry: expectedId, content: '测试条目（改）：下雨时她会把窗帘拉开一点，等对方回家。' });
    ok(updated.changed.includes('content'), '应改到 content');
    const afterUpd = readWorldEntries();
    const e5b = afterUpd.list.find((e) => e.stliteId === expectedId);
    ok(String(e5b.content).includes('等对方回家'), '内容应已更新（酒馆格式落盘）');
    console.log('st_world_update -> changed:', updated.changed.join(','));

    let threw = false;
    try { await tool('st_world_update', { world: CARD_ID, entry: 'e999', content: 'x' }); } catch { threw = true; }
    ok(threw, '不存在的条目应报错');
    console.log('st_world_update(不存在) -> 正确报错');

    ok(fs.existsSync(CARD + '.bak') && fs.existsSync(WORLD + '.bak'), '应有 .bak');
    console.log('backup -> .bak 都在');

    const prompt = await tool('st_prompt', { card: CARD_ID, userMessage: '今天下雨了' });
    const cardName = JSON.parse(fs.readFileSync(CARD, 'utf8'));
const NAME = (cardName.data && cardName.data.name) || cardName.name;
ok(prompt.prompt.includes(NAME), `提示词应含角色名「${NAME}」`);
    ok(prompt.stats.worldEntries === baseTotal, `统计应看到 ${baseTotal} 条世界书，实际 ${prompt.stats.worldEntries}`);
    console.log('st_prompt -> tokens', prompt.stats.tokens, '| loreHits', JSON.stringify(prompt.stats.loreHits));

    console.log('PASS 7/7：V2 卡落盘 / 补丁 / 幂等 / world info 追加 / 更新 / 报错 / 组装未坏');
  } finally {
    fs.writeFileSync(CARD, snap.card, 'utf8');
    fs.writeFileSync(WORLD, snap.world, 'utf8');
    fs.rmSync(CARD + '.bak', { force: true });
    fs.rmSync(WORLD + '.bak', { force: true });
    console.log('data 已还原，.bak 已清理');
    server.stdin.end();
    server.kill();
  }
})().catch((err) => {
  console.error('FAIL', err.message);
  process.exit(1);
});
