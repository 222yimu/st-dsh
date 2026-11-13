#!/usr/bin/env node
// st-lite：SillyTavern 的"精简核心"——角色卡 + 世界书注入 + token 预算 + 聊天记录。
// 以 MCP(stdio) 服务器形式暴露给 DSH，不监听端口、不联网、不依赖第三方包。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const DIRS = {
  cards: path.join(DATA, 'cards'),
  worlds: path.join(DATA, 'worlds'),
  chats: path.join(DATA, 'chats'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

// 当前使用的角色卡：data/active.json = { "card": "ymu" }
// st_prompt / st_log / st_history 的 card 参数都可以省略，省略时用它 ——
// 这样「扮演模式」预设不用把某张卡写死，换卡只需在设置页点一下。
const ACTIVE_FILE = path.join(DATA, 'active.json');

// 上下文预算默认值。几千轮的关键不在"存得下"，而在"带得进"：
//   最近对话（historyTurns 条） + 故事长档（story.md） + 旧片段召回（按话题检索）
const DEFAULT_BUDGET = 16000;
const STORY_TOKEN_CAP = 1800;
const RECALL_TOKEN_CAP = 500;

function activeCardId() {
  const state = readJson(ACTIVE_FILE, null);
  const wanted = safeId(state && state.card);
  if (wanted && fs.existsSync(path.join(DIRS.cards, wanted + '.json'))) return wanted;
  try {
    const first = fs.readdirSync(DIRS.cards).filter((f) => f.endsWith('.json')).sort()[0];
    if (first) return safeId(path.basename(first, '.json'));
  } catch { /* ignore */ }
  return '';
}

// ---------- 基础工具 ----------

const TIME = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset() / 60;
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.abs(off))}`;
};

function safeId(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// 写前备份上一版：扮演中改设定是常态，出问题要能一键退回。
// 只保留一份 .bak（每次覆盖），不堆版本；要长历史用 git 或手动另存。
function backupJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const bak = file + '.bak';
    fs.copyFileSync(file, bak);
    return bak;
  } catch {
    return null;
  }
}

// 粗略 token 估算：CJK/全角字符 ≈1 token，其余按 4 字符 ≈1 token
// token 估算：没有 tokenizer 可用时最接近的一版。
//   汉字 0.75 / 全角标点 1.0 / 数字 0.25 / 拉丁 0.25 / 空白 0.1 / 其它 0.5
// 想校准：拿一段已知 token 数的文本跑 st_tokens { text, knownTokens }，
// 把它返回的 suggestedCalib 写进环境变量 ST_TOKEN_CALIB。
const TOKEN_CALIB = Number(process.env.ST_TOKEN_CALIB || 1) || 1;

function tokenStats(text) {
  const s = String(text || '');
  const c = { hanzi: 0, fullPunct: 0, latin: 0, digit: 0, space: 0, other: 0 };
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === 32 || cp === 9 || cp === 10 || cp === 13) c.space++;
    else if (cp >= 0x4e00 && cp <= 0x9fff) c.hanzi++;
    else if ((cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef) ||
             (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x2e80 && cp <= 0x2eff)) c.fullPunct++;
    else if (cp >= 0x30 && cp <= 0x39) c.digit++;
    else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) c.latin++;
    else c.other++;
  }
  const raw = c.hanzi * 0.75 + c.fullPunct * 1.0 + c.digit * 0.25 +
              c.latin * 0.25 + c.space * 0.1 + c.other * 0.5;
  return {
    chars: s.length, ...c,
    tokens: Math.max(1, Math.round(raw * TOKEN_CALIB)),
    calib: TOKEN_CALIB,
  };
}

function estimateTokens(text) {
  if (text === undefined || text === null || text === '') return 0;
  return tokenStats(text).tokens;
}

// ---------- 存储层 ----------

function cardPath(id) { return path.join(DIRS.cards, safeId(id) + '.json'); }
function worldPath(id) { return path.join(DIRS.worlds, safeId(id) + '.json'); }

// 剧情分支：主line = <卡>.jsonl；分支 = <卡>@<branch>.jsonl；当前分支名存 <卡>.branch
function branchFile(id) { return path.join(DIRS.chats, safeId(id) + '.branch'); }

function currentBranch(id) {
  try { return fs.readFileSync(branchFile(id), 'utf8').trim(); } catch { return ''; }
}

function setBranch(id, name) {
  fs.mkdirSync(DIRS.chats, { recursive: true });
  const value = String(name || '').trim();
  if (value) fs.writeFileSync(branchFile(id), value, 'utf8');
  else { try { fs.unlinkSync(branchFile(id)); } catch { /* ignore */ } }
  return value;
}

function branchPath(id, name) {
  const base = safeId(id);
  const b = String(name || '').trim();
  return path.join(DIRS.chats, (b ? base + '@' + safeId(b) : base) + '.jsonl');
}

function chatPath(id) { return branchPath(id, currentBranch(id)); }

function listCards() {
  return fs.readdirSync(DIRS.cards)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readCardFile(path.join(DIRS.cards, f), path.basename(f, '.json')))
    .filter(Boolean)
    .map((c) => ({ id: c.id, name: c.name, tags: c.tags || [], turns: countTurns(c.id), updated: c.updated }));
}

function countTurns(id) {
  try {
    return fs.readFileSync(chatPath(id), 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch { return 0; }
}

// ---------- 酒馆格式适配 ----------
// 磁盘上是**酒馆的原生结构**，内部用扁平字段算：
//   角色卡：Character Card V2（{spec:"chara_card_v2", data:{...}}）
//   世界书：SillyTavern world info（{entries: {"0": {key, content, constant, disable, order, ...}}})
// 读的时候两种都认（旧的扁平 JSON / V2 / 数组式 entries），写的时候一律写酒馆格式，
// 这样 `data/cards/*.json` 和 `data/worlds/*.json` 可以直接跟酒馆互拷。

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
          created: card.created || TIME(),
          updated: card.updated || TIME(),
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
    created: ext.created || data.created || TIME(),
    updated: ext.updated || data.updated || TIME(),
    character_book: data.character_book || null,
  };
}

function readCardFile(file, fallbackId) {
  const raw = readJson(file, null);
  if (!raw) return null;
  if (raw.spec === 'chara_card_v2' || raw.data) return v2ToCard(raw, fallbackId);
  // 旧扁平格式：兜底兼容
  return Object.assign({ world: fallbackId }, raw, { id: safeId(raw.id || fallbackId) });
}

function normalizeEntry(entry, index) {
  const id = String(
    entry.stliteId || entry.id ||
    (entry.uid !== undefined ? 'e' + (Number(entry.uid) + 1) : 'e' + (index + 1)),
  );
  const rawKeys = entry.keys || entry.key || [];
  const keys = (Array.isArray(rawKeys) ? rawKeys : [rawKeys]).map((k) => String(k || '').trim()).filter(Boolean);
  const rawSec = entry.keysecondary || entry.secondaryKeys || [];
  const keysecondary = (Array.isArray(rawSec) ? rawSec : [rawSec]).map((k) => String(k || '').trim()).filter(Boolean);
  return {
    id,
    keys,
    // 次级关键词：primary 命中后还要过这一关（酒馆的 selective / keysecondary）
    keysecondary,
    selective: entry.selective === undefined ? true : !!entry.selective,
    selectiveLogic: Number(entry.selectiveLogic || 0) || 0, // 0=任一 1=非全 2=全不 3=全部
    // 酒馆的三个匹配开关 + 激活概率（对照源码：world-info.js:5030 / :269 / :347）
    useProbability: entry.useProbability === undefined ? true : !!entry.useProbability,
    probability: Number.isFinite(Number(entry.probability)) ? Number(entry.probability) : 100,
    caseSensitive: entry.caseSensitive === undefined || entry.caseSensitive === null ? null : !!entry.caseSensitive,
    matchWholeWords: entry.matchWholeWords === undefined || entry.matchWholeWords === null ? null : !!entry.matchWholeWords,
    // 递归开关（我们只做一轮，见 scanWorld）
    excludeRecursion: !!(entry.excludeRecursion ||
      (entry.extensions && entry.extensions.exclude_recursion)),
    preventRecursion: !!(entry.preventRecursion ||
      (entry.extensions && entry.extensions.prevent_recursion)),
    content: String(entry.content || ''),
    priority: Number(entry.priority !== undefined ? entry.priority : (entry.order || 0)) || 0,
    order: Number(entry.order || 0) || 0,
    constant: !!entry.constant,
    disabled: !!(entry.disabled || entry.disable),
    // 插入位置：0=设定前 1=设定后 2=作者注区 4=@depth（按 depth 从最新消息往上插）
    position: entry.position === undefined ? 0 : Number(entry.position) || 0,
    depth: entry.depth === undefined ? 4 : Number(entry.depth) || 0,
    comment: String(entry.comment || ''),
    created: entry.created || null,
  };
}

function normalizeWorld(raw, id) {
  const worldId = safeId((raw && raw.id) || id);
  const title = (raw && (raw.name || raw.title)) || worldId;
  const list = Array.isArray(raw && raw.entries)
    ? raw.entries
    : Object.values((raw && raw.entries) || {});
  return { id: worldId, name: title, entries: list.map(normalizeEntry) };
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

function loadCard(id) {
  const card = readCardFile(cardPath(id), id);
  if (!card) throw new Error(`角色卡不存在: ${id}（先看 st_cards 有哪些）`);
  return card;
}

function saveCard(input) {
  const id = safeId(input.id || input.name);
  const old = readCardFile(cardPath(id), id) || {};
  const card = {
    id,
    name: input.name ?? old.name ?? id,
    description: input.description ?? old.description ?? '',
    personality: input.personality ?? old.personality ?? '',
    scenario: input.scenario ?? old.scenario ?? '',
    first_mes: input.first_mes ?? old.first_mes ?? '',
    mes_example: input.mes_example ?? old.mes_example ?? '',
    system: input.system ?? old.system ?? '',
    post_history: input.post_history ?? old.post_history ?? '',
    world: safeId(input.world ?? old.world ?? id),
    tags: input.tags ?? old.tags ?? [],
    creator: input.creator ?? old.creator ?? '',
    creator_notes: input.creator_notes ?? old.creator_notes ?? '',
    alternate_greetings: input.alternate_greetings ?? old.alternate_greetings ?? [],
    created: old.created || TIME(),
    updated: TIME(),
  };
  backupJson(cardPath(id));
  writeJson(cardPath(id), cardToV2(card)); // 写盘一律酒馆 V2 格式
  return { ok: true, card };
}

// 从酒馆格式（V2 / 旧扁平）导入一张卡；带 character_book 会顺带落成世界书
function importCard(raw, explicitId) {
  if (!raw || typeof raw !== 'object') throw new Error('不是合法的 JSON 对象');
  const card = v2ToCard(raw, explicitId || safeId(raw.id || (raw.data && raw.data.name)));
  if (explicitId) card.id = safeId(explicitId);
  const saved = saveCard(card).card;
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
    if (entries.length) worldSaved = saveWorld({ id: saved.world || saved.id, name: book.name || saved.world || saved.id, entries });
  }
  return { card: saved, world: worldSaved };
}

// 字段级补丁：只改调用方给出的字段，其余原样保留。
// 为什么要它：profile 的扮演模式只放行 st_card_patch，不放行 st_card_save ——
// save 是整卡覆盖语义，模型漏一个字段就把人设写残；patch 有 merge 保护。
const PATCHABLE_FIELDS = [
  'name', 'description', 'personality', 'scenario', 'first_mes',
  'mes_example', 'system', 'post_history', 'world', 'tags',
];

function patchCard(input) {
  const id = safeId(input.id || input.card || input.name);
  const file = cardPath(id);
  const old = readCardFile(file, id);
  if (!old) throw new Error(`角色卡不存在: ${id}（新建整卡请用 st_card_save，它只在 normal 模式下可用）`);
  const card = { ...old };
  const changed = [];
  for (const field of PATCHABLE_FIELDS) {
    if (input[field] === undefined) continue;
    if (JSON.stringify(card[field]) === JSON.stringify(input[field])) continue;
    card[field] = input[field];
    changed.push(field);
  }
  if (!changed.length) return { ok: true, card, changed, note: '没有字段变化' };
  backupJson(file);
  card.id = old.id || id;
  card.created = old.created || TIME();
  card.updated = TIME();
  writeJson(file, cardToV2(card));
  return { ok: true, card, changed };
}

function loadWorld(id) {
  const raw = readJson(worldPath(id), null);
  if (!raw) return { id: safeId(id), name: id, entries: [] };
  return normalizeWorld(raw, id);
}

function saveWorld(world) {
  writeJson(worldPath(world.id), worldToTavern(world)); // 写盘一律酒馆 world info 格式
  return world;
}

// 条目 id 取「现有最大 eN + 1」。原来的 entries.length+1 在删过条目后会撞号。
function nextEntryId(world) {
  let max = 0;
  for (const entry of world.entries || []) {
    const m = /^e(\d+)$/.exec(String(entry.id || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'e' + (max + 1);
}

// swipe（多版本）：一条消息可以带 swipes[] + swipeId，text 永远等于 swipes[swipeId]
function normalizeTurn(row) {
  const text = String(row && row.text != null ? row.text : '');
  const swipes = Array.isArray(row && row.swipes) && row.swipes.length
    ? row.swipes.map((s) => String(s == null ? '' : s))
    : [text];
  let swipeId = Number.isInteger(row && row.swipeId) ? row.swipeId : 0;
  if (swipeId < 0 || swipeId >= swipes.length) swipeId = 0;
  // 每版独立元数据（酒馆的 swipe_info）：长度与 swipes 对齐
  const rawInfo = Array.isArray(row && row.swipeInfo) ? row.swipeInfo : [];
  const swipeInfo = swipes.map((_, i) => (rawInfo[i] && typeof rawInfo[i] === 'object' ? rawInfo[i] : {}));
  return Object.assign({}, row, { text: swipes[swipeId], swipes, swipeId, swipeInfo });
}

function turnLine(row) {
  const out = { t: row.t, role: row.role, text: row.text };
  if (row.speaker) out.speaker = row.speaker;
  // 只有多版本时才写 swipes / swipeInfo，文件不至于每行重复一遍正文
  if (Array.isArray(row.swipes) && row.swipes.length > 1) {
    out.swipes = row.swipes;
    out.swipeId = row.swipeId || 0;
    out.swipeInfo = Array.isArray(row.swipeInfo) ? row.swipeInfo : [];
  }
  if (row.editedAt) out.editedAt = row.editedAt;
  return JSON.stringify(out);
}

// 「重说」挂起标记：记下要被替换成新版本的是哪一条
function pendingFile(id) { return chatPath(id) + '.pending.json'; }
function readPending(id) { return readJson(pendingFile(id), null); }
function setPending(id, value) {
  if (value) writeJson(pendingFile(id), value);
  else { try { fs.unlinkSync(pendingFile(id)); } catch { /* ignore */ } }
}

function appendTurn(cardId, role, text) {
  fs.mkdirSync(DIRS.chats, { recursive: true });
  const body = String(text == null ? '' : text);
  const normRole = role === 'user' ? 'user' : 'char';
  const pending = readPending(cardId);
  if (normRole === 'char' && pending && Number.isInteger(pending.index)) {
    const rows = readTurns(cardId, 0);
    const target = rows[pending.index];
    if (target && target.role === 'char') {
      const swipes = (target.swipes && target.swipes.length ? target.swipes : [target.text]).concat([body]);
      const infos = (target.swipeInfo && target.swipeInfo.length
        ? target.swipeInfo
        : (target.swipes && target.swipes.length ? target.swipes : [target.text]).map(() => ({}))
      ).concat([{ t: TIME(), source: 'regenerate' }]);
      target.swipes = swipes;
      target.swipeId = swipes.length - 1;
      target.text = body;
      target.swipeInfo = infos;
      writeTurns(cardId, rows);
      setPending(cardId, null);
      return { mode: 'swipe-added', index: pending.index, versions: swipes.length };
    }
    setPending(cardId, null);
  }
  fs.appendFileSync(chatPath(cardId), turnLine({ t: TIME(), role: normRole, text: body }) + '\n', 'utf8');
  return { mode: 'appended' };
}

function readTurns(cardId, limit) {
  try {
    const rows = fs.readFileSync(chatPath(cardId), 'utf8')
      .split('\n').filter((l) => l.trim())
      .map((l) => { try { return normalizeTurn(JSON.parse(l)); } catch { return null; } })
      .filter(Boolean);
    return limit > 0 ? rows.slice(-limit) : rows;
  } catch { return []; }
}

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// 整条聊天记录重写（消息级编辑/删除/截断都走这里），写前自动 .bak
function writeTurns(cardId, rows) {
  const file = chatPath(cardId);
  backupJson(file);
  writeTextAtomic(file, rows.map((r) => turnLine(r)).join('\n') + (rows.length ? '\n' : ''));
  return rows.length;
}

function listBranches(cardId) {
  const base = safeId(cardId);
  const out = [];
  try {
    for (const f of fs.readdirSync(DIRS.chats)) {
      if (!f.endsWith('.jsonl')) continue;
      const name = path.basename(f, '.jsonl');
      if (name === base) out.push({ name: '', turns: countTurnsIn(branchPath(cardId, '')) });
      else if (name.startsWith(base + '@')) {
        out.push({ name: name.slice(base.length + 1), turns: countTurnsIn(branchPath(cardId, name.slice(base.length + 1))) });
      }
    }
  } catch { /* ignore */ }
  return out;
}

function countTurnsIn(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length; } catch { return 0; }
}

// ---------- 故事长档（剧情纪要，撑几千轮的主线记忆）----------
// data/chats/<card>.story.md：扮演时由「我」定期把剧情结论写进去，
// st_prompt 每轮都带上（酒馆里对应 summarization / Author's Note 那套思路）。

function storyPath(id) { return path.join(DIRS.chats, safeId(id) + '.story.md'); }

function readStory(id) {
  try { return fs.readFileSync(storyPath(id), 'utf8'); } catch { return ''; }
}

function writeStory(id, text) {
  fs.mkdirSync(DIRS.chats, { recursive: true });
  const file = storyPath(id);
  backupJson(file);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, String(text == null ? '' : text), 'utf8');
  fs.renameSync(tmp, file);
  return estimateTokens(text);
}

// ---------- 旧片段召回（不依赖 embedding 的轻量检索）----------
// 把最近窗口之外的老记录按 40 条切块，用双字重合度打分，挑最相关的几块带进上下文。

function bigramSet(text) {
  const s = String(text || '').replace(/[\s\p{P}]+/gu, '');
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

// 旧片段召回：IDF 加权 + 覆盖度 + 位置先验（不需要 embedding，但比裸重合度稳）
function pickRecallChunks(older, query, maxChunks) {
  if (!older || !older.length) return [];
  const CHUNK = 40;
  const chunks = [];
  for (let i = 0; i < older.length; i += CHUNK) chunks.push(older.slice(i, i + CHUNK));
  const q = bigramSet(query);
  if (!q.size) return chunks.slice(-2);

  const gramsPerChunk = chunks.map((rows) => bigramSet(rows.map((h) => h.text).join('')));
  const N = chunks.length;
  const df = new Map();
  for (const grams of gramsPerChunk) for (const g of grams) if (q.has(g)) df.set(g, (df.get(g) || 0) + 1);

  const scored = [];
  chunks.forEach((rows, i) => {
    let score = 0;
    let matched = 0;
    for (const g of q) {
      if (!gramsPerChunk[i].has(g)) continue;
      matched += 1;
      const d = df.get(g) || 1;
      score += Math.log(1 + N / d); // 越少见越值钱
    }
    if (!matched) return;
    score *= 1 + matched / Math.max(1, q.size); // 覆盖度
    score += (i / Math.max(1, N - 1)) * 0.3; // 越靠近最近窗口略优先
    scored.push({ rows, score });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxChunks || 2).map((x) => x.rows);
}

function clipTail(text, tokenCap) {
  const tokens = estimateTokens(text);
  if (tokens <= tokenCap) return text;
  const keep = Math.max(80, Math.floor(String(text).length * (tokenCap / tokens)));
  return '…（前半略）\n' + String(text).slice(-keep);
}

// 酒馆卡里的宏：{{char}} / {{user}}（还有 {{char}}的变体大小写）。
// 不替换的话，导入的酒馆卡会把这些原样吐进提示词。
const DEFAULT_USER = process.env.ST_USER_NAME || '你';

function applyMacros(text, card, user) {
  if (text === undefined || text === null) return text;
  return String(text)
    .replace(/\{\{\s*char\s*\}\}/gi, (card && card.name) || '')
    .replace(/\{\{\s*user\s*\}\}/gi, user || DEFAULT_USER);
}

// ---------- PNG 卡（酒馆的 tEXt "chara" 段）----------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  CRC_TABLE = table;
  return table;
}
function crc32(buf) {
  const table = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

// 从 PNG 里取 base64 的 chara JSON（酒馆卡的典型存法）
function readPngCard(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('不是合法的 PNG');
  }
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const start = off + 8;
    const end = start + len;
    if (end > buf.length) break;
    if (type === 'tEXt') {
      const chunk = buf.subarray(start, end);
      const zero = chunk.indexOf(0);
      if (zero > 0) {
        const keyword = chunk.toString('latin1', 0, zero).trim().toLowerCase();
        if (keyword === 'chara') {
          const text = chunk.toString('latin1', zero + 1);
          return JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
        }
      }
    }
    if (type === 'IEND') break;
    off = end + 4;
  }
  throw new Error('PNG 里没有 chara 数据（不是酒馆卡）');
}

// 生成一张 1x1 PNG，把卡塞进 tEXt chara（酒馆/其它工具都能读）
function writePngCard(cardRaw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(Buffer.from([0, 0x52, 0x6a, 0xa8, 0xff]));
  const b64 = Buffer.from(JSON.stringify(cardRaw), 'utf8').toString('base64');
  const textData = Buffer.concat([Buffer.from('chara', 'latin1'), Buffer.from([0]), Buffer.from(b64, 'latin1')]);
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('tEXt', textData),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- checkpoint（剧情快照）----------
const CKPT_DIR = path.join(DATA, 'checkpoints');
function ckptDir(id) { return path.join(CKPT_DIR, safeId(id)); }

function ckptList(id) {
  try {
    return fs.readdirSync(ckptDir(id)).filter((f) => f.endsWith('.jsonl')).sort().reverse()
      .map((f) => ({
        name: f,
        turns: countTurnsIn(path.join(ckptDir(id), f)),
        bytes: fs.statSync(path.join(ckptDir(id), f)).size,
      }));
  } catch { return []; }
}

function ckptSave(id, label) {
  const rows = readTurns(id, 0);
  fs.mkdirSync(ckptDir(id), { recursive: true });
  const stamp = TIME().replace(/[:+ ]/g, '-');
  const name = (label ? safeId(label) + '-' : '') + stamp + '.jsonl';
  writeTextAtomic(path.join(ckptDir(id), name), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  return { name, turns: rows.length, branch: currentBranch(id) };
}

function ckptRestore(id, name) {
  const target = path.join(ckptDir(id), path.basename(String(name || '')));
  if (!fs.existsSync(target)) throw new Error(`快照不存在: ${name}`);
  backupJson(chatPath(id));
  fs.copyFileSync(target, chatPath(id));
  return { restored: path.basename(target), turns: countTurns(id) };
}

// ---------- 群聊（多角色同场）----------
const GROUPS_FILE = path.join(DATA, 'groups.json');

function loadGroups() {
  const raw = readJson(GROUPS_FILE, null);
  return (raw && raw.groups) || {};
}
function saveGroups(groups) { writeJson(GROUPS_FILE, { groups }); }
function groupChatPath(gid) { return path.join(DIRS.chats, 'group-' + safeId(gid) + '.jsonl'); }

function readGroupTurns(gid) {
  try {
    return fs.readFileSync(groupChatPath(gid), 'utf8').split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function appendGroupTurn(gid, role, text, speaker) {
  fs.mkdirSync(DIRS.chats, { recursive: true });
  const line = JSON.stringify({ t: TIME(), role: role === 'user' ? 'user' : 'char', speaker: speaker || '', text: String(text ?? '') });
  fs.appendFileSync(groupChatPath(gid), line + '\n', 'utf8');
}

function assembleGroup({ gid, userMessage, speaker, budget }) {
  const groups = loadGroups();
  const g = groups[safeId(gid)];
  if (!g) throw new Error(`群不存在: ${gid}（用 st_group op=create 建）`);
  const members = (g.cards || []).map((cid) => { try { return loadCard(cid); } catch { return null; } }).filter(Boolean);
  if (!members.length) throw new Error('群里没有有效的角色卡');
  const maxTokens = Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET;
  const rows = readGroupTurns(gid);
  const nameOf = (sid) => ((members.find((m) => m.id === sid) || {}).name) || sid || '某人';
  const macro = (s, card) => applyMacros(s, card, DEFAULT_USER);

  const head = [];
  head.push('这是多角色群聊场景。你要同时扮演下面每个角色：谁开口就按谁的人设与语气；'
    + '一个回复里可以让多个角色先后说话，每条以「角色名：」开头。不要跳出角色，不要解释自己是 AI。');
  for (const m of members) {
    const body = [m.description, m.personality].filter(Boolean).join('\n');
    head.push(`【角色·${m.name}】\n${clipTail(macro(body, m), 400)}`);
  }

  const haystack = [userMessage || '', ...rows.slice(-4).map((r) => r.text)].join('\n');
  const loreMap = new Map();
  for (const m of members) {
    for (const e of matchWorldEntries(loadWorld(m.world || m.id), haystack)) {
      if (!loreMap.has(e.id)) loreMap.set(e.id, e);
    }
  }
  const loreHits = [...loreMap.values()].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  if (loreHits.length) {
    head.push(['【设定库】', ...loreHits.map((e) => `- ${clipTail(applyMacros(e.content, null, DEFAULT_USER), 200)}`)].join('\n'));
  }

  const tail = [];
  if (speaker) tail.push(`【本轮该谁开口】${nameOf(speaker)}（${g.strategy === 'random' ? '随机顺序' : '轮流顺序'}）`);
  if (userMessage) tail.push(`【用户】${userMessage}`);

  let hist = rows.slice(-40);
  const render = () => {
    const parts = [...head];
    const lines = hist.map((r) => `${r.role === 'user' ? '用户' : nameOf(r.speaker)}：${r.text}`);
    if (lines.length) parts.push(`【最近对话】\n${lines.join('\n')}`);
    parts.push(...tail);
    return parts.join('\n\n');
  };
  let prompt = render();
  let dropped = 0;
  while (estimateTokens(prompt) > maxTokens && hist.length > 2) { hist.shift(); dropped++; prompt = render(); }

  return {
    prompt,
    stats: {
      group: safeId(gid),
      members: members.map((m) => m.id),
      speaker: speaker || '',
      tokens: estimateTokens(prompt),
      budget: maxTokens,
      totalTurns: rows.length,
      historyKept: hist.length,
      historyDropped: dropped,
      loreHits: loreHits.map((e) => e.id),
    },
  };
}

// ---------- 提示词组装（ST 的核心逻辑）----------

// 整词匹配：中文没有词边界，直接包含；英文/数字按边界（对照 world-info.js 的 matchWholeWords）
function wholeWordMatch(text, word) {
  if (!/[a-z0-9]/i.test(word)) return text.includes(word);
  const esc = String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp('(^|[^a-z0-9])' + esc + '([^a-z0-9]|$)', 'i').test(text);
  } catch { return text.includes(word); }
}

// 按条目自己的 caseSensitive / matchWholeWords 判断一个 key 是否命中
function keyHit(entry, key, rawText, lowText) {
  const k = String(key || '');
  if (!k) return false;
  const cs = !!entry.caseSensitive;
  const text = cs ? rawText : lowText;
  const needle = cs ? k : k.toLowerCase();
  return entry.matchWholeWords ? wholeWordMatch(text, needle) : text.includes(needle);
}

// 次级关键词判定（酒馆 selectiveLogic）：
//   0 = AND ANY（至少一个命中，默认）· 1 = NOT ALL · 2 = NOT ANY · 3 = AND ALL
function secondaryPass(entry, rawText, lowText) {
  const sec = (entry.keysecondary || []).filter(Boolean);
  if (!sec.length) return true;
  if (entry.selective === false) return true;
  const hits = sec.filter((k) => keyHit(entry, k, rawText, lowText)).length;
  switch (Number(entry.selectiveLogic) || 0) {
    case 3: return hits === sec.length;
    case 2: return hits === 0;
    case 1: return hits < sec.length;
    default: return hits > 0;
  }
}

// 激活概率（对照 world-info.js:5030 的 useProbability / probability）
function probPass(entry) {
  if (entry.constant) return true;
  if (entry.useProbability === false) return true;
  const p = Number(entry.probability);
  if (!Number.isFinite(p) || p >= 100) return true;
  if (p <= 0) return false;
  return Math.random() * 100 < p;
}

// 世界书扫描：酒馆是多轮状态机，我们保守做一轮递归（可用 ST_WI_RECURSION 调整，0=关闭）
const WI_RECURSION = Number.isFinite(Number(process.env.ST_WI_RECURSION))
  ? Math.max(0, Number(process.env.ST_WI_RECURSION))
  : 1;

function scanWorld(world, baseText, options) {
  const steps = options && Number.isFinite(options.recursive) ? options.recursive : WI_RECURSION;
  const entries = (world && world.entries) || [];
  const hits = new Map();
  const feed = [String(baseText || '')];
  let rounds = 0;

  for (let step = 0; step <= steps; step++) {
    rounds = step + 1;
    const rawText = feed.join('\n');
    const lowText = rawText.toLowerCase();
    let added = 0;
    for (const entry of entries) {
      if (!entry || entry.disabled) continue;
      if (hits.has(entry.id)) continue;
      if (step > 0 && entry.excludeRecursion) continue;
      if (!entry.constant) {
        const keys = entry.keys || [];
        if (!keys.length) continue;
        if (!keys.some((k) => keyHit(entry, k, rawText, lowText))) continue;
        if (!secondaryPass(entry, rawText, lowText)) continue;
        if (!probPass(entry)) continue;
      }
      hits.set(entry.id, entry);
      added++;
      // 递归输入：这条的正文能不能触发别人
      if (step < steps && !entry.preventRecursion) feed.push(String(entry.content || ''));
    }
    if (!added) break;
  }

  const list = [...hits.values()].sort((a, b) =>
    (b.priority || 0) - (a.priority || 0) || (a.order || 0) - (b.order || 0));
  return { hits: list, rounds };
}

// 兼容旧调用名（不关心轮数的地方用这个）
function matchWorldEntries(world, haystack) {
  return scanWorld(world, haystack).hits;
}

function assemble({ cardId, userMessage, budget, historyTurns, greeting }) {
  const card = loadCard(cardId || activeCardId());
  const limit = Number.isFinite(historyTurns) ? historyTurns : 200;
  const maxTokens = Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET;

  const all = readTurns(card.id, 0);
  const recent = all.slice(-limit);
  const older = all.slice(0, Math.max(0, all.length - limit));
  // 避免重复：末尾若已记录过同一句 userMessage，就剔掉，不再拼一遍
  if (userMessage) {
    const target = String(userMessage).trim();
    while (recent.length && recent[recent.length - 1].role === 'user' &&
           String(recent[recent.length - 1].text).trim() === target) recent.pop();
  }

  const haystack = [userMessage || '', ...recent.slice(-4).map((h) => h.text)].join('\n');
  const world = loadWorld(card.world || card.id);
  const scan = scanWorld(world, haystack);
  const loreHits = scan.hits;

  // 长档（只留尾部：越靠后越新）
  let storyText = clipTail(readStory(card.id), STORY_TOKEN_CAP);

  // 旧片段：只从「最近窗口之外」找，避免和最近对话重复
  let recall = pickRecallChunks(older, userMessage || '', 2).map((rows) =>
    clipTail(rows.map((h) => `${h.role === 'user' ? '用户' : card.name}：${h.text}`).join('\n'), RECALL_TOKEN_CAP),
  );

  const macro = (s) => applyMacros(s, card, DEFAULT_USER);

  // 世界书按 position 分流：0=设定前 · 1/2/3=设定后 · 4=@depth 插进对话里
  const loreBefore = loreHits.filter((e) => (Number(e.position) || 0) === 0);
  const loreAfter = loreHits.filter((e) => [1, 2, 3].includes(Number(e.position) || 0));
  const loreDepth = loreHits.filter((e) => Number(e.position) === 4);

  const head = [];
  head.push(macro(card.system || `你是「${card.name}」。用第一人称扮演这个角色，保持人设与语气，不要跳出角色，不要解释自己是 AI。动作用 *斜体* 包裹。语言与用户一致。`));
  if (card.description) head.push(`【角色设定】\n${macro(card.description)}`);
  if (card.personality) head.push(`【性格】\n${macro(card.personality)}`);
  if (card.scenario) head.push(`【场景】\n${macro(card.scenario)}`);
  if (loreBefore.length) {
    head.push(['【设定库】', ...loreBefore.map((e) => `- ${macro(e.content)}`)].join('\n'));
  }
  if (card.mes_example) head.push(`【对话示例】\n${macro(card.mes_example)}`);

  // 开场白：只在「还没演过」时出现；first_mes 是第 0 条，alternate_greetings 跟在后面
  const greetings = [card.first_mes, ...(card.alternate_greetings || [])]
    .map((s) => String(s || '').trim()).filter(Boolean);
  let greetingIndex = -1;
  if (!all.length && greetings.length) {
    const want = Number(greeting);
    greetingIndex = Number.isFinite(want) && want >= 0 && want < greetings.length
      ? Math.floor(want)
      : Math.floor(Math.random() * greetings.length);
    head.push(`【开场白】（这是第一轮，用这条作为你的第一句，可微调）\n${macro(greetings[greetingIndex])}`);
  }

  const tailParts = [];
  if (loreAfter.length) {
    tailParts.push(['【设定库·后置】', ...loreAfter.map((e) => `- ${macro(e.content)}`)].join('\n'));
  }
  if (card.post_history) tailParts.push(`【作者注】${macro(card.post_history)}`);
  if (userMessage) tailParts.push(`【用户】${userMessage}`);

  let hist = recent.slice();
  const render = () => {
    const parts = [...head];
    if (storyText) parts.push(`【故事长档】（此前剧情的结论，越靠后越新）\n${storyText}`);
    if (recall.length) parts.push(['【往事片段】（按当前话题从旧记录里翻出来的）', ...recall.map((t) => `— ${t}`)].join('\n'));
    const lines = hist.map((h) => `${h.role === 'user' ? '用户' : card.name}：${h.text}`);
    // @depth 条目：从最新一条往上数 depth 条处插进去
    for (const e of loreDepth) {
      const at = Math.max(0, lines.length - Math.max(0, Number(e.depth) || 0));
      lines.splice(at, 0, `〔设定·${e.id}〕${macro(e.content)}`);
    }
    if (lines.length) parts.push(`【最近对话】\n${lines.join('\n')}`);
    parts.push(...tailParts);
    return parts.join('\n\n');
  };

  // 裁剪顺序：先丢最旧的最近对话 → 再丢往事片段 → 最后压缩长档
  let prompt = render();
  let dropped = 0;
  while (estimateTokens(prompt) > maxTokens && hist.length > 2) {
    hist.shift();
    dropped++;
    prompt = render();
  }
  while (estimateTokens(prompt) > maxTokens && recall.length > 0) {
    recall = recall.slice(1);
    prompt = render();
  }
  if (estimateTokens(prompt) > maxTokens && storyText) {
    storyText = clipTail(storyText, Math.max(200, Math.floor(STORY_TOKEN_CAP / 2)));
    prompt = render();
  }

  return {
    prompt,
    stats: {
      card: card.id,
      char: card.name,
      tokens: estimateTokens(prompt),
      budget: maxTokens,
      totalTurns: all.length,
      historyKept: hist.length,
      historyDropped: dropped,
      storyTokens: estimateTokens(storyText),
      recallSegments: recall.length,
      recallPool: older.length,
      greetingIndex,
      greetingCount: greetings.length,
      loreHits: loreHits.map((e) => e.id || e.keys?.[0] || 'entry'),
      loreByPosition: { before: loreBefore.length, after: loreAfter.length, depth: loreDepth.length },
      recursionRounds: scan.rounds,
      worldEntries: (world.entries || []).length,
    },
  };
}

// ---------- MCP 工具定义 ----------

const TOOLS = [
  {
    name: 'st_cards',
    description: '列出所有角色卡（id、名字、标签、已存轮数）。',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({ active: activeCardId(), cards: listCards() }),
  },
  {
    name: 'st_active',
    description: '查看或切换「当前角色卡」：不传 card 返回当前；传 card 就切换（校验卡存在）。切换后 st_prompt / st_log / st_history 省略 card 都用它，所以新开对话不用指定卡。',
    inputSchema: { type: 'object', properties: { card: { type: 'string' } } },
    run: ({ card }) => {
      if (card) {
        const id = safeId(card);
        if (!id) throw new Error('card 不能为空');
        if (!fs.existsSync(path.join(DIRS.cards, id + '.json'))) {
          throw new Error(`角色卡不存在: ${id}（用 st_cards 看有哪些）`);
        }
        writeJson(ACTIVE_FILE, { card: id, updated: TIME() });
        const active = loadCard(id);
        return { ok: true, active: id, name: active.name, world: active.world || id, switched: true };
      }
      const id = activeCardId();
      if (!id) return { ok: true, active: '', note: '还没有角色卡' };
      const active = loadCard(id);
      return { ok: true, active: id, name: active.name, world: active.world || id };
    },
  },
  {
    name: 'st_card_get',
    description: '读取一张角色卡的完整内容。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: ({ id }) => loadCard(id),
  },
  {
    name: 'st_card_save',
    description: '新建或更新角色卡。字段：id/name/description/personality/scenario/first_mes/mes_example/system/post_history/world/tags。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
        personality: { type: 'string' }, scenario: { type: 'string' }, first_mes: { type: 'string' },
        mes_example: { type: 'string' }, system: { type: 'string' }, post_history: { type: 'string' },
        world: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
      },
    },
    run: (args) => saveCard(args || {}),
  },
  {
    name: 'st_card_patch',
    description: '给已有角色卡打字段补丁：只改你给出的字段，其余字段原样保留（不会把人设写残）。用于剧情推进后微调自己的设定。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
        personality: { type: 'string' }, scenario: { type: 'string' }, first_mes: { type: 'string' },
        mes_example: { type: 'string' }, system: { type: 'string' }, post_history: { type: 'string' },
        world: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
    run: (args) => patchCard(args || {}),
  },
  {
    name: 'st_world_add',
    description: '往世界书加条目：命中 keys 中任意一个词时自动注入。constant=true 表示无条件常驻。',
    inputSchema: {
      type: 'object',
      properties: {
        world: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } },
        keysecondary: { type: 'array', items: { type: 'string' } },
        content: { type: 'string' }, priority: { type: 'number' },
        order: { type: 'number' }, constant: { type: 'boolean' },
        position: { type: 'number' }, depth: { type: 'number' },
        useProbability: { type: 'boolean' }, probability: { type: 'number' },
        caseSensitive: { type: 'boolean' }, matchWholeWords: { type: 'boolean' },
        excludeRecursion: { type: 'boolean' }, preventRecursion: { type: 'boolean' },
      },
      required: ['world', 'content'],
    },
    run: ({ world, keys, keysecondary, content, priority, order, constant,
            position, depth, useProbability, probability,
            caseSensitive, matchWholeWords, excludeRecursion, preventRecursion }) => {
      const w = loadWorld(world);
      if (!String(content || '').trim()) throw new Error('content 不能为空');
      backupJson(worldPath(w.id));
      const id = nextEntryId(w);
      w.entries.push({
        id,
        keys: keys || [],
        keysecondary: keysecondary || [],
        content,
        priority: priority || 0,
        order: order || 0,
        constant: !!constant,
        position: Number.isFinite(Number(position)) ? Number(position) : 0,
        depth: Number.isFinite(Number(depth)) ? Number(depth) : 4,
        useProbability: useProbability === undefined ? true : !!useProbability,
        probability: Number.isFinite(Number(probability)) ? Number(probability) : 100,
        caseSensitive: caseSensitive === undefined ? null : !!caseSensitive,
        matchWholeWords: matchWholeWords === undefined ? null : !!matchWholeWords,
        excludeRecursion: !!excludeRecursion,
        preventRecursion: !!preventRecursion,
        created: TIME(),
      });
      saveWorld(w);
      return { ok: true, world: w.id, entry: id, total: w.entries.length };
    },
  },
  {
    name: 'st_world_update',
    description: '更新世界书里**已有**条目（按 entry id）：只改给出的字段，其余保留。用于剧情推进后修正同一条设定。',
    inputSchema: {
      type: 'object',
      properties: {
        world: { type: 'string' }, entry: { type: 'string' },
        keys: { type: 'array', items: { type: 'string' } },
        keysecondary: { type: 'array', items: { type: 'string' } },
        content: { type: 'string' },
        priority: { type: 'number' }, order: { type: 'number' },
        constant: { type: 'boolean' }, disabled: { type: 'boolean' },
        position: { type: 'number' }, depth: { type: 'number' },
        useProbability: { type: 'boolean' }, probability: { type: 'number' },
        caseSensitive: { type: 'boolean' }, matchWholeWords: { type: 'boolean' },
        excludeRecursion: { type: 'boolean' }, preventRecursion: { type: 'boolean' },
      },
      required: ['world', 'entry'],
    },
    run: ({ world, entry, ...rest }) => {
      const w = loadWorld(world);
      const target = (w.entries || []).find((e) => String(e.id) === String(entry));
      if (!target) throw new Error(`世界书条目不存在: ${entry}（用 st_world_list 查 id）`);
      const changed = [];
      for (const field of ['content', 'keys', 'keysecondary', 'priority', 'order', 'constant', 'disabled',
        'position', 'depth', 'useProbability', 'probability', 'caseSensitive', 'matchWholeWords',
        'excludeRecursion', 'preventRecursion']) {
        if (rest[field] === undefined) continue;
        if (JSON.stringify(target[field]) === JSON.stringify(rest[field])) continue;
        target[field] = rest[field];
        changed.push(field);
      }
      if (!changed.length) return { ok: true, world: w.id, entry: target.id, changed, note: '没有字段变化' };
      if (target.content !== undefined && !String(target.content).trim()) throw new Error('content 不能改成空');
      backupJson(worldPath(w.id));
      target.updated = TIME();
      saveWorld(w);
      return { ok: true, world: w.id, entry: target.id, changed };
    },
  },
  {
    name: 'st_world_list',
    description: '列出世界书条目（可按世界名过滤）。',
    inputSchema: { type: 'object', properties: { world: { type: 'string' } } },
    run: ({ world }) => {
      if (world) return loadWorld(world);
      return {
        worlds: fs.readdirSync(DIRS.worlds).filter((f) => f.endsWith('.json')).map((f) => {
          const w = readJson(path.join(DIRS.worlds, f), null);
          if (!w) return null;
          // 酒馆 world info 没有 id 字段，用文件名兜底
          const wid = safeId(w.id || path.basename(f, '.json'));
          return { id: wid, entries: normalizeWorld(w, wid).entries.length };
        }).filter(Boolean),
      };
    },
  },
  {
    name: 'st_prompt',
    description: '组装一段可直接使用的角色扮演提示词（角色卡 + 命中的世界书条目 + 最近对话 + 长档 + 作者注，按 token 预算裁剪）。card 省略则用当前角色卡；第一轮会自动带上开场白（greeting 可指定第几条，默认随机）。',
    inputSchema: {
      type: 'object',
      properties: {
        card: { type: 'string' }, userMessage: { type: 'string' },
        budget: { type: 'number' }, historyTurns: { type: 'number' }, greeting: { type: 'number' },
        group: { type: 'string' }, speaker: { type: 'string' },
      },
    },
    run: ({ card, group, userMessage, budget, historyTurns, greeting, speaker }) =>
      group
        ? assembleGroup({ gid: group, userMessage, speaker, budget })
        : assemble({ cardId: card, userMessage, budget, historyTurns, greeting }),
  },
  {
    name: 'st_log',
    description: '把一轮对话追加进该角色的聊天记录（role=user 或 char）。',
    inputSchema: {
      type: 'object',
      properties: { card: { type: 'string' }, group: { type: 'string' }, speaker: { type: 'string' }, role: { type: 'string' }, text: { type: 'string' } },
      required: ['role', 'text'],
    },
    run: ({ card, group, speaker, role, text }) => {
      if (group) {
        appendGroupTurn(group, role, text, speaker || '');
        return { ok: true, group: safeId(group), speaker: speaker || '', turns: readGroupTurns(group).length };
      }
      const activeId = card || activeCardId();
      if (!activeId) throw new Error('没有可用角色卡（先 st_card_save 建一张）');
      const res = appendTurn(activeId, role, text);
      return Object.assign({ ok: true, card: safeId(activeId), turns: countTurns(activeId) }, res);
    },
  },
  {
    name: 'st_history',
    description: '读取某角色的聊天记录，默认最近 20 轮；card 省略则用当前角色卡。',
    inputSchema: { type: 'object', properties: { card: { type: 'string' }, limit: { type: 'number' } } },
    run: ({ card, limit }) => {
      const activeId = card || activeCardId();
      if (!activeId) throw new Error('没有可用角色卡');
      return { card: safeId(activeId), turns: readTurns(activeId, Number.isFinite(limit) ? limit : 20) };
    },
  },
  {
    name: 'st_story',
    description: '剧情长档（几千轮也记得住主线）：不传 text 返回当前长档；传 text 覆盖写；append=true 追加。st_prompt 每轮都会把它带上。',
    inputSchema: { type: 'object', properties: { card: { type: 'string' }, text: { type: 'string' }, append: { type: 'boolean' } } },
    run: ({ card, text, append }) => {
      const activeId = card || activeCardId();
      if (!activeId) throw new Error('没有可用角色卡');
      if (text === undefined) {
        const story = readStory(activeId);
        return { ok: true, card: safeId(activeId), tokens: estimateTokens(story), story };
      }
      const next = append ? [readStory(activeId), String(text)].filter((s) => s && s.trim()).join('\n') : String(text);
      const tokens = writeStory(activeId, next);
      return { ok: true, card: safeId(activeId), tokens, preview: next.slice(-300) };
    },
  },
  {
    name: 'st_turn',
    description: '消息级操作：op=list 列最近消息（带 index）/ delete 删第 index 条 / edit 改第 index 条正文 / truncate 删掉第 index 条之后的全部 / regenerate 删掉末尾的角色回复（让我重说）。index 从 0 开始，按当前分支算。',
    inputSchema: {
      type: 'object',
      properties: {
        card: { type: 'string' }, op: { type: 'string' },
        index: { type: 'number' }, text: { type: 'string' }, limit: { type: 'number' },
        to: { type: ['number', 'string'] },
      },
      required: ['op'],
    },
    run: ({ card, op, index, text, limit, to }) => {
      const id = card || activeCardId();
      if (!id) throw new Error('没有可用角色卡');
      const rows = readTurns(id, 0);
      const at = Number(index);
      switch (String(op || 'list')) {
        case 'list': {
          const n = Number.isFinite(limit) && limit > 0 ? limit : 30;
          const start = Math.max(0, rows.length - n);
          return {
            ok: true, card: safeId(id), branch: currentBranch(id), total: rows.length,
            turns: rows.slice(start).map((r, i) => ({
              index: start + i, role: r.role, text: r.text, t: r.t,
              swipeId: r.swipeId || 0, versions: (r.swipes || [r.text]).length,
            })),
          };
        }
        case 'delete': {
          if (!Number.isFinite(at) || at < 0 || at >= rows.length) throw new Error(`index 越界（0~${rows.length - 1}）`);
          const removed = rows.splice(at, 1)[0];
          writeTurns(id, rows);
          return { ok: true, deleted: removed, total: rows.length };
        }
        case 'edit': {
          if (!Number.isFinite(at) || at < 0 || at >= rows.length) throw new Error(`index 越界（0~${rows.length - 1}）`);
          if (typeof text !== 'string') throw new Error('edit 需要 text');
          rows[at] = Object.assign({}, rows[at], { text, editedAt: TIME() });
          writeTurns(id, rows);
          return { ok: true, turn: rows[at], total: rows.length };
        }
        case 'truncate': {
          if (!Number.isFinite(at) || at < 0 || at >= rows.length) throw new Error(`index 越界（0~${rows.length - 1}）`);
          const kept = rows.slice(0, at + 1);
          writeTurns(id, kept);
          return { ok: true, kept: kept.length, removed: rows.length - kept.length };
        }
        case 'regenerate': {
          // 酒馆的 swipe：不删记录，而是把这一条标记成"等待新版本"
          const last = rows.length - 1;
          if (last < 0 || rows[last].role !== 'char') throw new Error('末尾不是角色回复，没法重说');
          const cur = rows[last];
          if (!Array.isArray(cur.swipes) || !cur.swipes.length) cur.swipes = [cur.text];
          rows[last] = cur;
          writeTurns(id, rows);
          setPending(id, { index: last, at: TIME() });
          return {
            ok: true, pendingIndex: last, versions: cur.swipes.length,
            hint: '现在调 st_prompt 重新演；演完用 st_log { role:"char", text } 会成为这条的第 ' + (cur.swipes.length + 1) + ' 版（旧版保留，可 swipe 翻回来）',
          };
        }
        case 'swipe': {
          if (!Number.isFinite(at) || at < 0 || at >= rows.length) throw new Error(`index 越界（0~${rows.length - 1}）`);
          const row = rows[at];
          const swipes = row.swipes && row.swipes.length ? row.swipes : [row.text];
          let target;
          if (to === 'next') target = (row.swipeId + 1) % swipes.length;
          else if (to === 'prev') target = (row.swipeId - 1 + swipes.length) % swipes.length;
          else target = Number(to);
          if (!Number.isFinite(target) || target < 0 || target >= swipes.length) {
            throw new Error(`版本越界（0~${swipes.length - 1}）`);
          }
          row.swipes = swipes;
          row.swipeId = target;
          row.text = swipes[target];
          writeTurns(id, rows);
          return { ok: true, index: at, swipeId: target, versions: swipes.length, text: row.text };
        }
        case 'swipe-add': {
          if (!Number.isFinite(at) || at < 0 || at >= rows.length) throw new Error(`index 越界（0~${rows.length - 1}）`);
          if (typeof text !== 'string') throw new Error('swipe-add 需要 text');
          const row = rows[at];
          const base = row.swipes && row.swipes.length ? row.swipes : [row.text];
          const infos = (row.swipeInfo && row.swipeInfo.length ? row.swipeInfo : base.map(() => ({})))
            .concat([{ t: TIME(), source: 'manual' }]);
          row.swipes = base.concat([text]);
          row.swipeId = row.swipes.length - 1;
          row.text = text;
          row.swipeInfo = infos;
          writeTurns(id, rows);
          return { ok: true, index: at, swipeId: row.swipeId, versions: row.swipes.length };
        }
        case 'drop-last': {
          if (!rows.length) throw new Error('没有消息可删');
          const removed = rows.pop();
          writeTurns(id, rows);
          return { ok: true, removed: removed.text, total: rows.length };
        }
        default: throw new Error(`未知 op: ${op}（list/delete/edit/truncate/regenerate/swipe/swipe-add/drop-last）`);
      }
    },
  },
  {
    name: 'st_branch',
    description: '剧情分支：op=list 列分支 / create 从当前记录复制出新分支并切过去 / switch 切分支（name 留空=主线）/ delete 删分支。',
    inputSchema: { type: 'object', properties: { card: { type: 'string' }, op: { type: 'string' }, name: { type: 'string' } }, required: ['op'] },
    run: ({ card, op, name }) => {
      const id = card || activeCardId();
      if (!id) throw new Error('没有可用角色卡');
      const nm = String(name || '').trim();
      switch (String(op || 'list')) {
        case 'list':
          return { ok: true, card: safeId(id), current: currentBranch(id), branches: listBranches(id) };
        case 'create': {
          if (!nm) throw new Error('create 需要 name');
          const target = branchPath(id, nm);
          if (fs.existsSync(target)) throw new Error(`分支已存在: ${nm}`);
          const rows = readTurns(id, 0);
          backupJson(target);
          writeTextAtomic(target, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
          setBranch(id, nm);
          return { ok: true, branch: nm, turns: rows.length, current: nm };
        }
        case 'switch': {
          if (nm && !fs.existsSync(branchPath(id, nm))) throw new Error(`分支不存在: ${nm}`);
          setBranch(id, nm);
          return { ok: true, current: nm, turns: countTurns(id) };
        }
        case 'delete': {
          if (!nm) throw new Error('delete 需要 name（主线不能删）');
          const target = branchPath(id, nm);
          if (!fs.existsSync(target)) throw new Error(`分支不存在: ${nm}`);
          if (currentBranch(id) === nm) setBranch(id, '');
          fs.unlinkSync(target);
          return { ok: true, deleted: nm, current: currentBranch(id) };
        }
        default:
          throw new Error(`未知 op: ${op}（list/create/switch/delete）`);
      }
    },
  },
  {
    name: 'st_export',
    description: '把当前角色（当前分支）的聊天导出成酒馆格式 jsonl，写到 data/exports/，返回文件路径与条数。',
    inputSchema: { type: 'object', properties: { card: { type: 'string' } } },
    run: ({ card }) => {
      const id = card || activeCardId();
      if (!id) throw new Error('没有可用角色卡');
      const active = loadCard(id);
      const rows = readTurns(id, 0);
      const out = rows.map((r) => ({
        name: r.role === 'user' ? DEFAULT_USER : (active.name || safeId(id)),
        is_user: r.role === 'user',
        mes: r.text,
        send_date: r.t || TIME(),
      }));
      const dir = path.join(DATA, 'exports');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = TIME().replace(/[:+ ]/g, '-');
      const file = path.join(dir, `${safeId(id)}-${stamp}.jsonl`);
      writeTextAtomic(file, out.map((r) => JSON.stringify(r)).join('\n') + (out.length ? '\n' : ''));
      return { ok: true, card: safeId(id), branch: currentBranch(id), turns: out.length, file };
    },
  },
  {
    name: 'st_checkpoint',
    description: '剧情快照：op=list 列快照 / save 存当前分支（可带 label）/ restore 恢复（传 name）。存在 data/checkpoints/<卡>/。',
    inputSchema: { type: 'object', properties: { card: { type: 'string' }, op: { type: 'string' }, label: { type: 'string' }, name: { type: 'string' } }, required: ['op'] },
    run: ({ card, op, label, name }) => {
      const id = card || activeCardId();
      if (!id) throw new Error('没有可用角色卡');
      switch (String(op || 'list')) {
        case 'list': return { ok: true, card: safeId(id), checkpoints: ckptList(id) };
        case 'save': {
          const saved = ckptSave(id, label);
          return { ok: true, card: safeId(id), checkpoint: saved.name, turns: saved.turns };
        }
        case 'restore': {
          if (!name) throw new Error('restore 需要 name（先 op=list 看有哪些）');
          const out = ckptRestore(id, name);
          return { ok: true, card: safeId(id), restored: out.restored, turns: out.turns };
        }
        default: throw new Error(`未知 op: ${op}（list/save/restore）`);
      }
    },
  },
  {
    name: 'st_group',
    description: '群聊（多角色同场）：op=list 列群 / create 建群（id + cards 数组 + strategy=seq|random）/ delete。建好后用 st_prompt { group } 演、st_log { group, speaker, role, text } 记。',
    inputSchema: {
      type: 'object',
      properties: { op: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' }, cards: { type: 'array', items: { type: 'string' } }, strategy: { type: 'string' } },
      required: ['op'],
    },
    run: ({ op, id, name, cards, strategy }) => {
      const groups = loadGroups();
      switch (String(op || 'list')) {
        case 'list':
          return {
            ok: true,
            groups: Object.entries(groups).map(([gid, g]) => ({
              id: gid, name: g.name || gid, cards: g.cards || [], strategy: g.strategy || 'seq',
              turns: readGroupTurns(gid).length,
            })),
          };
        case 'create': {
          const gid = safeId(id || name);
          if (!gid) throw new Error('需要 id');
          const list = (Array.isArray(cards) ? cards : []).map(safeId).filter(Boolean);
          if (!list.length) throw new Error('cards 不能为空（卡 id 数组）');
          for (const cid of list) if (!fs.existsSync(path.join(DIRS.cards, cid + '.json'))) throw new Error(`角色卡不存在: ${cid}`);
          groups[gid] = { name: String(name || gid), cards: list, strategy: strategy === 'random' ? 'random' : 'seq' };
          saveGroups(groups);
          return { ok: true, group: gid, cards: list, strategy: groups[gid].strategy };
        }
        case 'delete': {
          const gid = safeId(id);
          if (!groups[gid]) throw new Error(`群不存在: ${gid}`);
          delete groups[gid];
          saveGroups(groups);
          return { ok: true, deleted: gid };
        }
        default: throw new Error(`未知 op: ${op}（list/create/delete）`);
      }
    },
  },
  {
    name: 'st_png',
    description: 'PNG 酒馆卡：op=import 读 data/imports/*.png（带 tEXt chara）落成卡；op=export 把卡写成 data/exports/<id>.png（内嵌 chara，可给酒馆用）。',
    inputSchema: { type: 'object', properties: { op: { type: 'string' }, card: { type: 'string' }, file: { type: 'string' } }, required: ['op'] },
    run: ({ op, card, file }) => {
      if (op === 'import') {
        const dir = path.join(DATA, 'imports');
        fs.mkdirSync(dir, { recursive: true });
        const files = file ? [file] : fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png'));
        if (!files.length) throw new Error(`把 PNG 卡放进 ${dir} 再试`);
        const imported = [];
        for (const f of files.slice(0, 20)) {
          const buf = fs.readFileSync(path.join(dir, f));
          const raw = readPngCard(buf);
          const out = importCard(raw, path.basename(f, '.png'));
          imported.push({ file: f, id: out.card.id, name: out.card.name, book: !!out.world });
        }
        return { ok: true, imported };
      }
      if (op === 'export') {
        const id = card || activeCardId();
        if (!id) throw new Error('没有可用角色卡');
        const loaded = loadCard(id);
        const png = writePngCard(cardToV2(loaded));
        const dir = path.join(DATA, 'exports');
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, safeId(loaded.id) + '.png');
        fs.writeFileSync(target, png);
        return { ok: true, file: target, bytes: png.length };
      }
      throw new Error('op 只能是 import / export');
    },
  },
  {
    name: 'st_tokens',
    description: '估算 token（带明细：汉字/全角/拉丁/数字/空白各多少）。校准用：传 knownTokens（这段文本在某处的真实 token 数），返回建议的 ST_TOKEN_CALIB。',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, knownTokens: { type: 'number' } }, required: ['text'] },
    run: ({ text, knownTokens }) => {
      const s = tokenStats(text);
      const out = Object.assign({ ok: true }, s);
      if (Number.isFinite(knownTokens) && knownTokens > 0) {
        out.suggestedCalib = Math.round((knownTokens / Math.max(1, s.tokens)) * s.calib * 1000) / 1000;
        out.note = '把这个值写进环境变量 ST_TOKEN_CALIB 再重启，估算就贴近实际';
      }
      return out;
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));
const SERVER_INFO = { name: 'st-lite', version: '0.1.0' };

// ---------- MCP(stdio) 协议 ----------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg || {};
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case 'tools/call': {
      const tool = TOOL_MAP.get(params?.name);
      if (!tool) return fail(id, -32601, `未知工具: ${params?.name}`);
      try {
        const out = await tool.run(params?.arguments || {});
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      } catch (err) {
        return reply(id, {
          content: [{ type: 'text', text: `错误: ${err && err.message ? err.message : String(err)}` }],
          isError: true,
        });
      }
    }
    default:
      if (id !== undefined) return fail(id, -32601, `不支持的方法: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  handle(msg).catch((e) => {
    if (msg && msg.id !== undefined) fail(msg.id, -32000, e && e.message ? e.message : String(e));
  });
});
