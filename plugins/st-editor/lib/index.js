// st-editor · 宿主侧
// 给设置页「角色卡与设定」面板提供 HTTP 接口，直接读写 st-lite 的 data 目录。
// **磁盘格式与酒馆一致**：角色卡 = Character Card V2，世界书 = SillyTavern world info。
// 写前自动备份 <文件>.bak，原子写（tmp + rename）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 数据目录解析（可移植）：ST_LITE_DATA 优先；否则按"插件并排安装"的常见布局找 st-lite/data。
// 支持三种放法：node_modules/st-editor + node_modules/st-lite、plugins/st-editor + plugins/st-lite、包内自带 data。
function resolveDataDir() {
  if (process.env.ST_LITE_DATA) return process.env.ST_LITE_DATA;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../st-lite/data'),
    path.resolve(here, '../../../st-lite/data'),
    path.resolve(here, '../data'),
  ];
  for (const dir of candidates) {
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* 继续找 */ }
  }
  return path.resolve(here, '../data');
}

const DATA = resolveDataDir();
const CARDS = path.join(DATA, 'cards');
const WORLDS = path.join(DATA, 'worlds');
const CHATS = path.join(DATA, 'chats');
const ACTIVE_FILE = path.join(DATA, 'active.json');
const ROUTE = '/st-editor';

// 当前使用的角色卡（与 st-lite 共用同一个 active.json）
function activeCardId() {
  const state = readJson(ACTIVE_FILE, null);
  const wanted = safeId(state && state.card);
  if (wanted && fs.existsSync(path.join(CARDS, wanted + '.json'))) return wanted;
  try {
    const first = fs.readdirSync(CARDS).filter((f) => f.endsWith('.json')).sort()[0];
    if (first) return safeId(path.basename(first, '.json'));
  } catch { /* ignore */ }
  return '';
}

function setActiveCard(id) {
  const cardId = safeId(id);
  if (!cardId) throw new Error('id 不能为空');
  if (!fs.existsSync(path.join(CARDS, cardId + '.json'))) throw new Error(`角色卡不存在: ${cardId}`);
  writeAtomic(ACTIVE_FILE, { card: cardId, updated: now() });
  return cardId;
}

const CARD_FIELDS = [
  'name', 'description', 'personality', 'scenario', 'first_mes',
  'mes_example', 'system', 'post_history', 'world',
];

function safeId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '') || '';
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function backup(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const bak = file + '.bak';
    fs.copyFileSync(file, bak);
    return bak;
  } catch { return null; }
}

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset() / 60;
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.abs(off))}`;
}

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

// 剧情分支：主line = <卡>.jsonl；分支 = <卡>@<branch>.jsonl；当前分支名存 <卡>.branch
function branchFile(id) { return path.join(CHATS, safeId(id) + '.branch'); }
function currentBranch(id) {
  try { return fs.readFileSync(branchFile(id), 'utf8').trim(); } catch { return ''; }
}
function setBranch(id, name) {
  fs.mkdirSync(CHATS, { recursive: true });
  const value = String(name || '').trim();
  if (value) fs.writeFileSync(branchFile(id), value, 'utf8');
  else { try { fs.unlinkSync(branchFile(id)); } catch { /* ignore */ } }
  return value;
}
function branchPath(id, name) {
  const base = safeId(id);
  const b = String(name || '').trim();
  return path.join(CHATS, (b ? base + '@' + safeId(b) : base) + '.jsonl');
}
function chatPath(id) { return branchPath(id, currentBranch(id)); }

function countTurnsIn(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length; } catch { return 0; }
}

function countTurns(id) { return countTurnsIn(chatPath(id)); }

function readTurns(id, limit) {
  try {
    const rows = fs.readFileSync(chatPath(id), 'utf8')
      .split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    return limit > 0 ? rows.slice(-limit) : rows;
  } catch { return []; }
}

function writeTurns(id, rows) {
  const file = chatPath(id);
  backup(file);
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, file);
  return rows.length;
}

function listBranches(id) {
  const base = safeId(id);
  const out = [];
  try {
    for (const f of fs.readdirSync(CHATS)) {
      if (!f.endsWith('.jsonl')) continue;
      const name = path.basename(f, '.jsonl');
      if (name === base) out.push({ name: '', turns: countTurnsIn(branchPath(id, '')) });
      else if (name.startsWith(base + '@')) {
        const b = name.slice(base.length + 1);
        out.push({ name: b, turns: countTurnsIn(branchPath(id, b)) });
      }
    }
  } catch { /* ignore */ }
  return out;
}

// ---------- 酒馆格式 <-> 内部扁平 ----------

function cardToV2(card) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: card.name || '',
      description: card.description || '',
      personality: card.personality || '',
      scenario: card.scenario || '',
      first_mes: card.first_mes || '',
      mes_example: card.mes_example || '',
      creator_notes: card.creator_notes || '',
      system_prompt: card.system || '',
      post_history_instructions: card.post_history || '',
      alternate_greetings: Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [],
      tags: Array.isArray(card.tags) ? card.tags : [],
      creator: card.creator || '',
      character_version: card.character_version || '',
      extensions: Object.assign({}, card.extensions || {}, {
        stlite: {
          id: card.id,
          world: card.world || card.id,
          created: card.created || now(),
          updated: card.updated || now(),
        },
      }),
    },
  };
}

function v2ToCard(raw, fallbackId) {
  const data = raw.data || raw;
  const ext = (data.extensions && data.extensions.stlite) || {};
  return {
    id: safeId(ext.id || data.id || fallbackId || data.name),
    name: data.name || '',
    description: data.description || '',
    personality: data.personality || '',
    scenario: data.scenario || '',
    first_mes: data.first_mes || '',
    mes_example: data.mes_example || '',
    system: data.system_prompt || data.system || '',
    post_history: data.post_history_instructions || data.post_history || '',
    world: safeId(ext.world || data.world || ext.id || fallbackId || data.name),
    tags: Array.isArray(data.tags) ? data.tags : [],
    creator: data.creator || '',
    creator_notes: data.creator_notes || '',
    alternate_greetings: Array.isArray(data.alternate_greetings) ? data.alternate_greetings : [],
    created: ext.created || data.created || now(),
    updated: ext.updated || data.updated || now(),
    character_book: data.character_book || null,
  };
}

function readCardFile(file, fallbackId) {
  const raw = readJson(file, null);
  if (!raw) return null;
  if (raw.spec === 'chara_card_v2' || raw.data) return v2ToCard(raw, fallbackId);
  return Object.assign({ world: fallbackId }, raw, { id: safeId(raw.id || fallbackId) });
}

function normalizeEntry(entry, index) {
  const id = String(entry.stliteId || entry.id ||
    (entry.uid !== undefined ? 'e' + (Number(entry.uid) + 1) : 'e' + (index + 1)));
  const rawKeys = entry.keys || entry.key || [];
  const rawSec = entry.keysecondary || entry.secondaryKeys || [];
  return {
    id,
    keys: (Array.isArray(rawKeys) ? rawKeys : [rawKeys]).map((k) => String(k || '').trim()).filter(Boolean),
    keysecondary: (Array.isArray(rawSec) ? rawSec : [rawSec]).map((k) => String(k || '').trim()).filter(Boolean),
    selective: entry.selective === undefined ? true : !!entry.selective,
    selectiveLogic: Number(entry.selectiveLogic || 0) || 0,
    useProbability: entry.useProbability === undefined ? true : !!entry.useProbability,
    probability: Number.isFinite(Number(entry.probability)) ? Number(entry.probability) : 100,
    caseSensitive: entry.caseSensitive === undefined || entry.caseSensitive === null ? null : !!entry.caseSensitive,
    matchWholeWords: entry.matchWholeWords === undefined || entry.matchWholeWords === null ? null : !!entry.matchWholeWords,
    excludeRecursion: !!(entry.excludeRecursion || (entry.extensions && entry.extensions.exclude_recursion)),
    preventRecursion: !!(entry.preventRecursion || (entry.extensions && entry.extensions.prevent_recursion)),
    content: String(entry.content || ''),
    priority: Number(entry.priority !== undefined ? entry.priority : (entry.order || 0)) || 0,
    order: Number(entry.order || 0) || 0,
    constant: !!entry.constant,
    disabled: !!(entry.disabled || entry.disable),
    position: entry.position === undefined ? 0 : Number(entry.position) || 0,
    depth: entry.depth === undefined ? 4 : Number(entry.depth) || 0,
    comment: String(entry.comment || ''),
    created: entry.created || null,
  };
}

function normalizeWorld(raw, id) {
  const worldId = safeId((raw && raw.id) || id);
  const list = Array.isArray(raw && raw.entries) ? raw.entries : Object.values((raw && raw.entries) || {});
  return { id: worldId, name: (raw && (raw.name || raw.title)) || worldId, entries: list.map(normalizeEntry) };
}

function worldToTavern(world) {
  const entries = {};
  (world.entries || []).forEach((entry, index) => {
    entries[String(index)] = {
      uid: index,
      stliteId: entry.id,
      key: Array.isArray(entry.keys) ? entry.keys : [],
      keysecondary: Array.isArray(entry.keysecondary) ? entry.keysecondary : [],
      comment: entry.comment || '',
      content: entry.content || '',
      constant: !!entry.constant,
      selective: entry.selective === undefined ? true : !!entry.selective,
      selectiveLogic: Number(entry.selectiveLogic || 0) || 0,
      useProbability: entry.useProbability === undefined ? true : !!entry.useProbability,
      probability: Number.isFinite(Number(entry.probability)) ? Number(entry.probability) : 100,
      caseSensitive: entry.caseSensitive === undefined ? null : entry.caseSensitive,
      matchWholeWords: entry.matchWholeWords === undefined ? null : entry.matchWholeWords,
      excludeRecursion: !!entry.excludeRecursion,
      preventRecursion: !!entry.preventRecursion,
      order: Number(entry.order || entry.priority || 100),
      position: entry.position === undefined ? 0 : Number(entry.position) || 0,
      disable: !!entry.disabled,
      delayUntilRecursion: false,
      depth: entry.depth === undefined ? 4 : Number(entry.depth) || 0,
      group: '',
      groupOverride: false,
      groupWeight: 100,
      scanDepth: null,
      useGroupScoring: null,
      automationId: '',
      role: null,
      vectorized: false,
      priority: Number(entry.priority || 0),
      created: entry.created || undefined,
    };
  });
  return { entries };
}

// ---------- 卡 ----------

function listCards() {
  try {
    return fs.readdirSync(CARDS)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readCardFile(path.join(CARDS, f), path.basename(f, '.json')))
      .filter(Boolean)
      .map((c) => ({ id: c.id, name: c.name, world: c.world || c.id, turns: countTurns(c.id), updated: c.updated }));
  } catch { return []; }
}

function getCard(id) {
  const card = readCardFile(path.join(CARDS, safeId(id) + '.json'), id);
  if (!card) throw new Error(`角色卡不存在: ${id}`);
  return card;
}

function validateCard(input) {
  const id = safeId(input.id);
  if (!id) throw new Error('id 不能为空（只允许字母/数字/下划线/连字符）');
  if (!String(input.name || '').trim()) throw new Error('name 不能为空');
  if (!String(input.description || '').trim()) throw new Error('description 不能为空（外貌与身份主要靠它）');
  const card = { id };
  for (const field of CARD_FIELDS) card[field] = input[field] === undefined ? '' : String(input[field]);
  card.world = safeId(input.world) || id;
  card.tags = Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  card.creator = input.creator ? String(input.creator) : '';
  card.creator_notes = input.creator_notes ? String(input.creator_notes) : '';
  card.alternate_greetings = Array.isArray(input.alternate_greetings) ? input.alternate_greetings : [];
  return card;
}

function saveCard(input) {
  const card = validateCard(input);
  const file = path.join(CARDS, card.id + '.json');
  const old = readCardFile(file, card.id);
  card.created = (old && old.created) || now();
  card.updated = now();
  backup(file);
  writeAtomic(file, cardToV2(card));
  return card;
}

// ---------- 世界书 ----------

function getWorld(id) {
  const raw = readJson(path.join(WORLDS, safeId(id) + '.json'), null);
  if (!raw) return { id: safeId(id), name: id, entries: [] };
  return normalizeWorld(raw, id);
}

function validateWorld(input) {
  const id = safeId(input.id);
  if (!id) throw new Error('世界书 id 不能为空');
  const raw = Array.isArray(input.entries) ? input.entries : [];
  const seen = new Set();
  const entries = raw.map((entry, index) => {
    const entryId = String(entry.id || '').trim() || `e${index + 1}`;
    if (seen.has(entryId)) throw new Error(`条目 id 重复: ${entryId}`);
    seen.add(entryId);
    const content = String(entry.content || '').trim();
    if (!content) throw new Error(`条目 ${entryId} 的 content 不能为空`);
    const keys = Array.isArray(entry.keys)
      ? entry.keys.map((k) => String(k).trim()).filter(Boolean)
      : String(entry.keys || '').split(/[,，\n]/).map((k) => k.trim()).filter(Boolean);
    if (!entry.constant && !keys.length) throw new Error(`条目 ${entryId}：不是常驻就必须至少一个关键词`);
    const out = {
      id: entryId,
      keys,
      keysecondary: Array.isArray(entry.keysecondary) ? entry.keysecondary.map((k) => String(k).trim()).filter(Boolean) : [],
      selective: entry.selective === undefined ? true : !!entry.selective,
      selectiveLogic: Number(entry.selectiveLogic || 0) || 0,
      content,
      priority: Number.isFinite(Number(entry.priority)) ? Number(entry.priority) : 0,
      order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : index,
      constant: !!entry.constant,
      position: Number.isFinite(Number(entry.position)) ? Number(entry.position) : 0,
      depth: Number.isFinite(Number(entry.depth)) ? Number(entry.depth) : 4,
      comment: String(entry.comment || ''),
    };
    if (entry.disabled) out.disabled = true;
    if (entry.created) out.created = entry.created;
    return out;
  });
  return { id, name: String(input.name || id).trim() || id, entries };
}

function saveWorld(input) {
  const world = validateWorld(input);
  const file = path.join(WORLDS, world.id + '.json');
  backup(file);
  writeAtomic(file, worldToTavern(world));
  return world;
}

// ---------- 导入 / 导出 ----------

function importCard(raw, explicitId) {
  if (!raw || typeof raw !== 'object') throw new Error('不是合法的 JSON 对象');
  const card = v2ToCard(raw, explicitId || safeId(raw.id || (raw.data && raw.data.name)));
  if (explicitId) card.id = safeId(explicitId);
  const saved = saveCard(card);
  let worldSaved = null;
  const book = card.character_book;
  if (book && Array.isArray(book.entries) && book.entries.length) {
    const entries = book.entries.map((entry, index) => ({
      id: 'e' + (index + 1),
      keys: (entry.keys || entry.key || []).map(String),
      content: entry.content || '',
      priority: Number(entry.insertion_order !== undefined ? entry.insertion_order : (entry.order || 0)) || 0,
      order: index,
      constant: !!entry.constant,
      disabled: entry.enabled === false || !!entry.disable,
      comment: entry.comment || '',
    })).filter((e) => String(e.content).trim());
    if (entries.length) worldSaved = saveWorld({ id: saved.world, name: book.name || saved.world, entries });
  }
  return { card: saved, world: worldSaved };
}

function importWorld(raw, explicitId) {
  if (!raw || typeof raw !== 'object') throw new Error('不是合法的 JSON 对象');
  const world = normalizeWorld(raw, explicitId);
  if (explicitId) world.id = safeId(explicitId);
  if (!world.id) throw new Error('世界书 id 不能为空');
  return saveWorld(world);
}

// ---------- 聊天（消息级操作 / 分支 / 导出）----------

function chatPayload(cardId, pageSize) {
  const rows = readTurns(cardId, 0);
  const n = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 50;
  const start = Math.max(0, rows.length - n);
  return {
    ok: true,
    card: safeId(cardId),
    branch: currentBranch(cardId),
    total: rows.length,
    branches: listBranches(cardId),
    turns: rows.slice(start).map((r, i) => ({
      index: start + i, role: r.role, text: r.text, t: r.t,
      swipeId: r.swipeId || 0, versions: (r.swipes || [r.text]).length,
    })),
  };
}

function applyChatAction(cardId, action, body) {
  const rows = readTurns(cardId, 0);
  const at = Number(body.index);
  const need = () => {
    if (!Number.isFinite(at) || at < 0 || at >= rows.length) throw new Error(`index 越界（0~${rows.length - 1}）`);
  };
  switch (action) {
    case 'delete': {
      need();
      rows.splice(at, 1);
      writeTurns(cardId, rows);
      break;
    }
    case 'edit': {
      need();
      if (typeof body.text !== 'string') throw new Error('edit 需要 text');
      rows[at] = Object.assign({}, rows[at], { text: body.text, editedAt: now() });
      writeTurns(cardId, rows);
      break;
    }
    case 'truncate': {
      need();
      writeTurns(cardId, rows.slice(0, at + 1));
      break;
    }
    case 'regenerate': {
      const last = rows.length - 1;
      if (last < 0 || rows[last].role !== 'char') throw new Error('末尾不是角色回复');
      const cur = rows[last];
      if (!Array.isArray(cur.swipes) || !cur.swipes.length) cur.swipes = [cur.text];
      writeTurns(cardId, rows);
      break;
    }
    case 'swipe': {
      need();
      const row = rows[at];
      const swipes = row.swipes && row.swipes.length ? row.swipes : [row.text];
      let target;
      if (body.to === 'next') target = (row.swipeId + 1) % swipes.length;
      else if (body.to === 'prev') target = (row.swipeId - 1 + swipes.length) % swipes.length;
      else target = Number(body.to);
      if (!Number.isFinite(target) || target < 0 || target >= swipes.length) throw new Error('版本越界');
      row.swipes = swipes;
      row.swipeId = target;
      row.text = swipes[target];
      writeTurns(cardId, rows);
      break;
    }
    case 'swipe-add': {
      need();
      if (typeof body.text !== 'string') throw new Error('swipe-add 需要 text');
      const row = rows[at];
      const swipes = (row.swipes && row.swipes.length ? row.swipes : [row.text]).concat([body.text]);
      row.swipes = swipes;
      row.swipeId = swipes.length - 1;
      row.text = body.text;
      writeTurns(cardId, rows);
      break;
    }
    case 'drop-last': {
      if (!rows.length) throw new Error('没有消息可删');
      rows.pop();
      writeTurns(cardId, rows);
      break;
    }
    case 'branch-create': {
      const nm = String(body.name || '').trim();
      if (!nm) throw new Error('需要分支名');
      const target = branchPath(cardId, nm);
      if (fs.existsSync(target)) throw new Error(`分支已存在: ${nm}`);
      backup(target);
      const tmp = target + '.tmp';
      fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
      fs.renameSync(tmp, target);
      setBranch(cardId, nm);
      break;
    }
    case 'branch-switch': {
      const nm = String(body.name || '').trim();
      if (nm && !fs.existsSync(branchPath(cardId, nm))) throw new Error(`分支不存在: ${nm}`);
      setBranch(cardId, nm);
      break;
    }
    case 'branch-delete': {
      const nm = String(body.name || '').trim();
      if (!nm) throw new Error('需要分支名（主线不能删）');
      const target = branchPath(cardId, nm);
      if (!fs.existsSync(target)) throw new Error(`分支不存在: ${nm}`);
      if (currentBranch(cardId) === nm) setBranch(cardId, '');
      fs.unlinkSync(target);
      break;
    }
    default:
      throw new Error(`未知 action: ${action}`);
  }
  return chatPayload(cardId);
}

// ---------- checkpoint（剧情快照）----------
const CKPT_DIR = path.join(DATA, 'checkpoints');
function ckptDir(id) { return path.join(CKPT_DIR, safeId(id)); }

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function ckptList(id) {
  try {
    return fs.readdirSync(ckptDir(id)).filter((f) => f.endsWith('.jsonl')).sort().reverse()
      .map((f) => ({ name: f, turns: countTurnsIn(path.join(ckptDir(id), f)), bytes: fs.statSync(path.join(ckptDir(id), f)).size }));
  } catch { return []; }
}

function ckptSave(id, label) {
  const rows = readTurns(id, 0);
  fs.mkdirSync(ckptDir(id), { recursive: true });
  const stamp = now().replace(/[:+ ]/g, '-');
  const name = (label ? safeId(label) + '-' : '') + stamp + '.jsonl';
  writeText(path.join(ckptDir(id), name), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  return { name, turns: rows.length, branch: currentBranch(id) };
}

function ckptRestore(id, name) {
  const target = path.join(ckptDir(id), path.basename(String(name || '')));
  if (!fs.existsSync(target)) throw new Error(`快照不存在: ${name}`);
  backup(chatPath(id));
  fs.copyFileSync(target, chatPath(id));
  return { restored: path.basename(target), turns: countTurns(id) };
}

// ---------- 统计 ----------

function stats(card, world) {
  const headParts = ['system', 'description', 'personality', 'scenario', 'mes_example', 'post_history'];
  const fieldTokens = {};
  for (const f of headParts) fieldTokens[f] = estimateTokens(card ? card[f] : '');
  const head = headParts.reduce((n, f) => n + fieldTokens[f], 0);
  const entries = (world && world.entries) || [];
  const constant = entries.filter((e) => e.constant).reduce((n, e) => n + estimateTokens(e.content), 0);
  const fixed = head + constant;
  return {
    fieldTokens,
    head,
    constant,
    entries: entries.length,
    constantEntries: entries.filter((e) => e.constant).length,
    budget: 6000,
    room: Math.max(0, 6000 - fixed),
    turnsRoom: Math.floor(Math.max(0, 6000 - fixed) / 60),
  };
}

// ---------- HTTP ----------

function send(response, code, body) {
  const text = JSON.stringify(body);
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

async function readBody(request, limit = 512 * 1024) {
  return await new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('请求体过大'));
        try { request.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    request.on('error', reject);
  });
}

export async function handleRoute(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const op = url.searchParams.get('op') || '';
  const id = url.searchParams.get('id') || '';

  try {
    if (request.method === 'GET') {
      if (op === 'active') return send(response, 200, { ok: true, active: activeCardId() });
      if (op === 'chat') return send(response, 200, chatPayload(id || activeCardId()));
      if (op === 'checkpoint') {
        const cardId = id || activeCardId();
        return send(response, 200, { ok: true, card: safeId(cardId), checkpoints: ckptList(cardId), branch: currentBranch(cardId) });
      }
      if (op === 'sampling') {
        const file = path.join(DATA, 'sampling.json');
        const sampling = fs.existsSync(file)
          ? JSON.parse(fs.readFileSync(file, 'utf8'))
          : { default: null, normal: null, roleplay: null, sessions: {} };
        return send(response, 200, { ok: true, sampling, file });
      }
      if (op === 'export-chat') {
        const cardId = id || activeCardId();
        const card2 = readCardFile(path.join(CARDS, safeId(cardId) + '.json'), cardId);
        const rows = readTurns(cardId, 0);
        const text = rows.map((r) => JSON.stringify({
          name: r.role === 'user' ? (process.env.ST_USER_NAME || '你') : ((card2 && card2.name) || safeId(cardId)),
          is_user: r.role === 'user',
          mes: r.text,
          send_date: r.t || now(),
        })).join('\n') + (rows.length ? '\n' : '');
        return send(response, 200, { ok: true, filename: safeId(cardId) + '.chat.jsonl', turns: rows.length, text });
      }
      if (op === 'list') {
        const cards = listCards();
        const worlds = fs.existsSync(WORLDS)
          ? fs.readdirSync(WORLDS).filter((f) => f.endsWith('.json')).map((f) => {
            const w = readJson(path.join(WORLDS, f), null);
            if (!w) return null;
            const wid = safeId(w.id || path.basename(f, '.json'));
            const count = Array.isArray(w.entries) ? w.entries.length : Object.keys(w.entries || {}).length;
            return { id: wid, name: w.name || wid, entries: count };
          }).filter(Boolean)
          : [];
        return send(response, 200, { ok: true, cards, worlds, active: activeCardId(), dataDir: DATA });
      }
      if (op === 'card') {
        const card = getCard(id);
        const world = getWorld(card.world || card.id);
        return send(response, 200, { ok: true, card, world, stats: stats(card, world) });
      }
      if (op === 'world') {
        const world = getWorld(id);
        const card = readCardFile(path.join(CARDS, safeId(id) + '.json'), id);
        return send(response, 200, { ok: true, world, stats: stats(card, world) });
      }
      if (op === 'export-card') {
        const card = getCard(id);
        return send(response, 200, { ok: true, file: cardToV2(card), filename: (card.id || 'card') + '.card.json' });
      }
      if (op === 'export-world') {
        const world = getWorld(id);
        return send(response, 200, { ok: true, file: worldToTavern(world), filename: (world.id || 'world') + '.lorebook.json' });
      }
      return send(response, 400, { ok: false, error: '未知 op: ' + op });
    }

    if (request.method === 'POST') {
      const body = await readBody(request);
      if (op === 'active') {
        const activeId = setActiveCard(body.id || body.card);
        return send(response, 200, { ok: true, active: activeId });
      }
      if (op === 'chat') {
        const cardId = body.card || activeCardId();
        if (!cardId) throw new Error('没有可用角色卡');
        return send(response, 200, applyChatAction(cardId, String(body.action || ''), body));
      }
      if (op === 'sampling') {
        const file = path.join(DATA, 'sampling.json');
        const body2 = body.sampling || {};
        const clean = (v) => {
          if (v === null || v === undefined || v === '') return null;
          const n = Number(v);
          return Number.isFinite(n) && n >= 0 && n <= 5 ? n : null;
        };
        const next = {
          _说明: '采样温度。null = 不改（沿用内核默认）。建议 0 ~ 2。',
          default: clean(body2.default),
          normal: clean(body2.normal),
          roleplay: clean(body2.roleplay),
          sessions: body2.sessions && typeof body2.sessions === 'object' ? body2.sessions : {},
        };
        backup(file);
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
        return send(response, 200, { ok: true, sampling: next });
      }
      if (op === 'checkpoint') {
        const cardId = body.card || activeCardId();
        if (!cardId) throw new Error('没有可用角色卡');
        const action = String(body.action || 'list');
        if (action === 'save') {
          const saved = ckptSave(cardId, body.label);
          return send(response, 200, { ok: true, saved: saved.name, turns: saved.turns, checkpoints: ckptList(cardId) });
        }
        if (action === 'restore') {
          const out = ckptRestore(cardId, body.name);
          return send(response, 200, Object.assign({ ok: true, checkpoints: ckptList(cardId) }, out, chatPayload(cardId)));
        }
        return send(response, 200, { ok: true, card: safeId(cardId), checkpoints: ckptList(cardId) });
      }
      if (op === 'card') {
        const card = saveCard(body.card || body);
        const world = getWorld(card.world);
        return send(response, 200, { ok: true, card, stats: stats(card, world) });
      }
      if (op === 'world') {
        const world = saveWorld(body.world || body);
        const card = readCardFile(path.join(CARDS, safeId(world.id) + '.json'), world.id);
        return send(response, 200, { ok: true, world, stats: stats(card, world) });
      }
      if (op === 'import-card') {
        const out = importCard(body.raw || body.card || body, body.id);
        return send(response, 200, {
          ok: true,
          id: out.card.id,
          card: out.card,
          world: out.world,
          importedBook: !!out.world,
          stats: stats(out.card, out.world || getWorld(out.card.world)),
        });
      }
      if (op === 'import-world') {
        const world = importWorld(body.raw || body.world || body, body.id || id);
        const card = readCardFile(path.join(CARDS, safeId(world.id) + '.json'), world.id);
        return send(response, 200, { ok: true, world, stats: stats(card, world) });
      }
      return send(response, 400, { ok: false, error: '未知 op: ' + op });
    }

    response.writeHead(405, { allow: 'GET, POST' });
    response.end();
  } catch (error) {
    send(response, 400, { ok: false, error: String(error && error.message ? error.message : error) });
  }
}

export const name = 'st-editor';

export function apply(ctx) {
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const off = host.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: handleRoute,
      }, 'st-editor: card & world editor');
      return () => {
        try { if (typeof off === 'function') off(); } catch { /* ignore */ }
      };
    });
  });
}
