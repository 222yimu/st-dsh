// st-editor 宿主路由测试：用 ST_LITE_DATA 指向临时目录，完全不碰真实 data
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync, writeFileSync, existsSync , readdirSync} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const SRC = 'D:\\ymLN\\dsh-plugins\\st-lite\\data';
const tmp = mkdtempSync(join(tmpdir(), 'st-editor-'));
mkdirSync(join(tmp, 'cards'), { recursive: true });
mkdirSync(join(tmp, 'worlds'), { recursive: true });
mkdirSync(join(tmp, 'chats'), { recursive: true });
// 拿真实卡做样本（只读源文件，不动它）
const cardDir = join(SRC, 'cards');
const firstCard = readdirSync(cardDir).filter((f) => f.endsWith('.json')).sort()[0];
const CARD_ID = firstCard.replace(/\.json$/, '');
const cardSrc = join(cardDir, firstCard);
if (!existsSync(cardSrc)) throw new Error('样板卡不存在: ' + cardSrc);
copyFileSync(cardSrc, join(tmp, 'cards', firstCard));
try { copyFileSync(join(SRC, 'worlds', firstCard), join(tmp, 'worlds', firstCard)); } catch { /* 世界书可选 */ }
process.env.ST_LITE_DATA = tmp;

const mod = await import('file:///D:/ymLN/dsh-plugins/st-editor/lib/index.js');

let handler = null;
const ctx = {
  inject: (deps, cb) =>
    cb({
      effect: (fn) => fn(),
      webServer: {
        register: (route) => {
          handler = route.handler;
          return () => {};
        },
      },
    }),
};
mod.apply(ctx);
assert.ok(handler, '应当注册一个 HTTP handler');

function makeReq(method, url, body) {
  const listeners = { data: [], end: [] };
  const req = {
    method,
    url,
    on(event, fn) {
      (listeners[event] = listeners[event] || []).push(fn);
      return req;
    },
    destroy() {},
  };
  process.nextTick(() => {
    if (body !== undefined) for (const fn of listeners.data) fn(Buffer.from(JSON.stringify(body), 'utf8'));
    for (const fn of listeners.end) fn();
  });
  return req;
}

function makeRes() {
  const state = { code: 0, text: '' };
  return {
    writeHead(code) { state.code = code; },
    end(text) { state.text = text || ''; },
    get code() { return state.code; },
    get json() { return JSON.parse(state.text || '{}'); },
  };
}

async function call(method, query, body) {
  const res = makeRes();
  await handler(makeReq(method, '/st-editor?' + query, body), res);
  return { code: res.code, json: res.json };
}

try {
  // 1) list
  const list = await call('GET', 'op=list');
  assert.strictEqual(list.code, 200);
  assert.ok(list.json.cards.some((c) => c.id === CARD_ID), 'list 应含 ymu');
  assert.ok(list.json.worlds.some((w) => w.id === CARD_ID), 'list 应含世界书 ymu');

  // 2) 读卡
  const got = await call('GET', 'op=card&id=ymu');
  assert.strictEqual(got.code, 200);
  assert.strictEqual(got.json.card.name, 'DeepSeek');
  assert.ok(got.json.stats.head > 0, '应返回 token 统计');
  assert.strictEqual(got.json.world.entries.length, 4, '世界书应有 4 条');

  // 3) 存卡（改 personality）
  const card = got.json.card;
  card.personality = card.personality + '（编辑器测试标记）';
  const saved = await call('POST', 'op=card', { card });
  assert.strictEqual(saved.code, 200);
  assert.ok(saved.json.card.personality.includes('编辑器测试标记'), '保存应生效');
  const reread = JSON.parse(readFileSync(join(tmp, 'cards', firstCard), 'utf8'));
  const rereadData = reread.data || reread;
  assert.strictEqual(reread.spec, 'chara_card_v2', '落盘应是 Character Card V2');
  assert.ok(rereadData.personality.includes('编辑器测试标记'), '落盘应生效');
  assert.ok(rereadData.system_prompt, 'system 应写成 system_prompt');
  assert.strictEqual(rereadData.extensions.stlite.id, CARD_ID, '应记住 stlite.id');
  assert.ok(existsSync(join(tmp, 'cards', 'ymu.json.bak')), '应生成 .bak');

  // 4) 校验：description 空 → 400
  const badCard = Object.assign({}, card, { description: '   ' });
  const bad = await call('POST', 'op=card', { card: badCard });
  assert.strictEqual(bad.code, 400, '空 description 应被拒');
  assert.ok(String(bad.json.error).includes('description'), '错误信息应指出字段');

  // 5) 世界书：改一条 + 加一条
  const world = got.json.world;
  world.entries[0].content = world.entries[0].content + '（测试）';
  world.entries.push({ id: 'e9', keys: ['测试词'], content: '编辑器加的条目', priority: 3, constant: false });
  const savedWorld = await call('POST', 'op=world', { world });
  assert.strictEqual(savedWorld.code, 200);
  assert.strictEqual(savedWorld.json.world.entries.length, 5);

  // 6) 校验：非 constant 又没 keys → 400
  const badWorld = { id: CARD_ID, name: CARD_ID, entries: [{ id: 'e1', keys: [], content: 'x', constant: false }] };
  const badW = await call('POST', 'op=world', { world: badWorld });
  assert.strictEqual(badW.code, 400, '无 keys 的非常驻条目应被拒');

  // 7) 条目 id 重复 → 400
  const dupWorld = { id: CARD_ID, name: CARD_ID, entries: [
    { id: 'e1', keys: ['a'], content: 'a', constant: false },
    { id: 'e1', keys: ['b'], content: 'b', constant: false },
  ] };
  const dup = await call('POST', 'op=world', { world: dupWorld });
  assert.strictEqual(dup.code, 400, '重复 id 应被拒');

  // 7) 导出：卡是 V2，世界书是 world info（对象式 entries）
  const expCard = await call('GET', 'op=export-card&id=ymu');
  assert.strictEqual(expCard.code, 200);
  assert.strictEqual(expCard.json.file.spec, 'chara_card_v2', '导出卡应是 chara_card_v2');
  assert.ok(expCard.json.file.data.name === 'DeepSeek', '导出卡应有 data.name');
  const expWorld = await call('GET', 'op=export-world&id=ymu');
  assert.strictEqual(expWorld.code, 200);
  assert.ok(!Array.isArray(expWorld.json.file.entries), '导出世界书应是对象式 entries（酒馆格式）');
  assert.ok(expWorld.json.file.entries['0'].key.length > 0, '条目应有 key 数组');

  // 8) 导入：把导出的卡换 id 再导进来（模拟从酒馆拿卡）
  const incoming = JSON.parse(JSON.stringify(expCard.json.file));
  incoming.data.name = '导入测试角色';
  incoming.data.description = '从酒馆导入的卡';
  const imported = await call('POST', 'op=import-card', { raw: incoming, id: 'imported-test' });
  assert.strictEqual(imported.code, 200, '导入应成功：' + JSON.stringify(imported.json));
  assert.strictEqual(imported.json.id, 'imported-test');
  assert.ok(existsSync(join(tmp, 'cards', 'imported-test.json')), '导入卡应落盘');

  // 9) 导入带内嵌 character_book 的卡 → 顺带生成世界书
  const withBook = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '带书卡',
      description: '有内嵌世界书',
      system_prompt: '',
      character_book: {
        name: 'book-of-test',
        entries: [
          { keys: ['海', '浪'], content: '她喜欢听浪声。', insertion_order: 6, enabled: true, constant: false },
        ],
      },
      extensions: { stlite: { id: 'book-card', world: 'book-world' } },
    },
  };
  const importedBook = await call('POST', 'op=import-card', { raw: withBook });
  assert.strictEqual(importedBook.code, 200);
  assert.ok(importedBook.json.importedBook, '应识别内嵌 character_book');
  assert.ok(existsSync(join(tmp, 'worlds', 'book-world.json')), '内嵌书应落成世界书文件');
  const bookFile = JSON.parse(readFileSync(join(tmp, 'worlds', 'book-world.json'), 'utf8'));
  assert.strictEqual(Object.keys(bookFile.entries).length, 1, '内嵌书应有 1 条');
  assert.ok(bookFile.entries['0'].key.includes('浪'), '内嵌书条目应保留 keys');

  console.log('PASS 9/9：list / 读卡+统计 / 存卡(V2+.bak) / 空字段校验 / 世界书存 / 无 keys 校验 / 导出 V2+lorebook / 导入卡 / 内嵌书导入');
} finally {
  rmSync(tmp, { recursive: true, force: true });
  console.log('临时目录已清理（真实 data 未被触碰）');
}
