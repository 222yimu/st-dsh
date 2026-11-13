// check-card.js · 角色卡 / 世界书写完先自查
// 用法：
//   node check-card.js example                       # 查 data/cards/example.json + 它引用的世界书
//   node check-card.js path\to\card.json         # 查指定文件
//   node check-card.js example --json                # 只输出机器可读结果
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname; // 本脚本就在 st-lite 根目录
const CARDS = path.join(ROOT, 'data', 'cards');
const WORLDS = path.join(ROOT, 'data', 'worlds');

// 与 src/server.js 同一套估算：CJK/全角 ≈1 token，其余 4 字符 ≈1 token
function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0, other = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x3000 && cp <= 0x303f)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

const errors = [];
const warns = [];
const notes = [];
let card = null;
let cardFile = null;
let world = null;
let worldFile = null;
let headTokens = 0;
let constantTokens = 0;
let loreCount = 0;
const fieldTokens = {};

const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);

function report() {
  const asJson = process.argv.includes('--json');
  const fixed = headTokens + constantTokens + estimateTokens(card && card.post_history ? card.post_history : '');
  const room = Math.max(0, 6000 - fixed);
  const payload = {
    card: cardFile,
    world: world ? worldFile : null,
    fieldTokens,
    headTokens,
    constantTokens,
    fixed,
    room,
    turnsRoom: Math.floor(room / 60),
    errors,
    warns,
  };
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(errors.length ? 1 : 0);
  }
  console.log(`卡: ${cardFile || '(未解析)'}`);
  console.log(`世界书: ${world ? worldFile : (worldFile || '（未找到）')}`);
  if (card) console.log(`角色: ${card.name || '?'}  (id=${card.id || '?'}, world=${card.world || '-'})`);
  console.log('');
  if (Object.keys(fieldTokens).length) {
    console.log('字段 token: ' + Object.entries(fieldTokens).map(([k, v]) => `${k}=${v}`).join('  '));
  }
  console.log(`固定开销: 卡头 ${headTokens} + 常驻设定 ${constantTokens} = ${fixed}`);
  console.log(`预算 6000 下剩余 ${room} tokens ≈ 还能放 ${Math.floor(room / 60)} 轮历史（按 60/轮粗估）`);
  if (world) {
    const entries = Array.isArray(world.entries) ? world.entries : [];
    console.log(`世界书: ${entries.length} 条（常驻 ${entries.filter((e) => e.constant).length}，关键词 ${loreCount}）`);
  }
  console.log('');
  for (const e of errors) console.log('ERROR  ' + e);
  for (const w of warns) console.log('WARN   ' + w);
  for (const n of notes) console.log('NOTE   ' + n);
  if (!errors.length && !warns.length) console.log('OK  没发现问题');
  else if (!errors.length) console.log('OK  只有提示，可以开演');
  process.exit(errors.length ? 1 : 0);
}

// ---------- 主流程 ----------
const target = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!target) {
  console.error('用法: node check-card.js <卡id 或 json 路径> [--json]');
  process.exit(2);
}

cardFile = target.includes(path.sep) || target.endsWith('.json')
  ? path.resolve(target)
  : path.join(CARDS, target + '.json');

if (!fs.existsSync(cardFile)) {
  err(`角色卡文件不存在: ${cardFile}`);
  report();
}

// 酒馆 V2 卡 → 扁平字段；旧格式原样返回
function unwrapCard(raw, fallbackId) {
  if (raw && (raw.spec === 'chara_card_v2' || raw.data)) {
    const d = raw.data || {};
    const ext = (d.extensions && d.extensions.stlite) || {};
    return Object.assign({}, d, {
      id: ext.id || fallbackId,
      world: ext.world || ext.id || fallbackId,
      system: d.system_prompt || d.system || '',
      post_history: d.post_history_instructions || d.post_history || '',
    });
  }
  return raw;
}

// world info（对象式 entries）或数组式 → 统一数组
function unwrapWorld(raw) {
  const list = Array.isArray(raw && raw.entries) ? raw.entries : Object.values((raw && raw.entries) || {});
  return {
    entries: list.map((e, i) => ({
      id: String(e.stliteId || e.id || 'e' + (i + 1)),
      keys: Array.isArray(e.keys || e.key) ? (e.keys || e.key) : [],
      content: e.content || '',
      constant: !!e.constant,
      disabled: !!(e.disabled || e.disable),
    })),
  };
}

try {
  card = unwrapCard(JSON.parse(fs.readFileSync(cardFile, 'utf8')), path.basename(cardFile, '.json'));
} catch (e) {
  err(`角色卡 JSON 解析失败: ${e.message}`);
  report();
}

// ---- 卡字段 ----
const fileBase = path.basename(cardFile, '.json');
if (!card.id) err('缺少 id');
else if (String(card.id) !== fileBase) warn(`card.id="${card.id}" 与文件名 "${fileBase}.json" 不一致（st_prompt 按 id 找盘，容易找不到）`);
if (!String(card.name || '').trim()) err('缺少 name');
if (!String(card.description || '').trim()) err('缺少 description（外貌/身份主要靠它）');
if (!String(card.system || '').trim()) notes.push('没有 system：会退回内置通用扮演指令（能用，但语气约束弱）');

const headParts = ['system', 'description', 'personality', 'scenario', 'mes_example', 'post_history'];
for (const f of headParts) fieldTokens[f] = estimateTokens(card[f] || '');
headTokens = headParts.reduce((n, f) => n + fieldTokens[f], 0);

if (headTokens > 2500) warn(`卡头部固定开销 ${headTokens} tokens 偏大（建议 ≤1500），会挤压历史预算`);
if (fieldTokens.description > 500) warn(`description ${fieldTokens.description} tokens 偏长，建议压到 200~400`);
if (fieldTokens.mes_example > 400) warn(`mes_example ${fieldTokens.mes_example} tokens 偏长，两条示例够了`);
if (fieldTokens.post_history > 200) warn(`post_history ${fieldTokens.post_history} tokens 偏长，只放「绝不能忘」的`);

// ---- 世界书 ----
const worldRef = String(card.world || card.id || '');
worldFile = path.join(WORLDS, worldRef + '.json');
if (!worldRef) {
  err('卡里没有 world 字段，st_prompt 无法确定世界书');
} else if (!fs.existsSync(worldFile)) {
  err(`世界书不存在: ${worldFile}（卡里 world="${worldRef}"）`);
} else {
  try {
    world = unwrapWorld(JSON.parse(fs.readFileSync(worldFile, 'utf8')));
  } catch (e) {
    err(`世界书 JSON 解析失败: ${e.message}`);
  }
}

if (world) {
  const entries = Array.isArray(world.entries) ? world.entries : [];
  if (!entries.length) warn('世界书是空的');
  const ids = new Set();
  const keyMap = new Map();
  let constantCount = 0;
  for (const entry of entries) {
    const id = String(entry.id || '?');
    if (ids.has(id)) err(`世界书条目 id 重复: ${id}`);
    ids.add(id);
    const content = String(entry.content || '');
    const tokens = estimateTokens(content);
    if (!content.trim()) err(`条目 ${id} content 为空`);
    if (tokens > 200) warn(`条目 ${id} 内容 ${tokens} tokens 偏长（建议 ≤80）`);
    if (entry.constant) {
      constantCount++;
      constantTokens += tokens;
    } else {
      loreCount++;
      const keys = Array.isArray(entry.keys) ? entry.keys : [];
      if (!keys.length) warn(`条目 ${id} 既不是 constant 又没 keys —— 永远不会被注入`);
      for (const k of keys) {
        const key = String(k || '').trim();
        if (!key) { err(`条目 ${id} 有空的 key`); continue; }
        if (key.length < 2) warn(`条目 ${id} 的 key「${key}」太短，容易误命中（建议 2 字以上）`);
        keyMap.set(key, [...(keyMap.get(key) || []), id]);
      }
    }
  }
  for (const [key, owners] of keyMap) {
    if (owners.length > 1) warn(`key「${key}」被多条共用: ${owners.join(', ')}`);
  }
  if (constantCount > 3) warn(`constant 条目 ${constantCount} 条（建议 ≤3）：常驻内容每轮都进上下文`);
  if (constantTokens > 800) warn(`常驻条目合计 ${constantTokens} tokens 偏大（建议 ≤600）`);
}

report();
