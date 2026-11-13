// migrate-to-tavern.mjs · 一次性：把 data 目录里的扁平格式改成酒馆原生结构
//
// 角色卡 → Character Card V2：{ spec:"chara_card_v2", data:{ ... , extensions.stlite } }
// 世界书 → SillyTavern world info：{ entries: { "0": { uid, key, content, constant, disable, order, ... } } }
//
// 用法：node tools\migrate-to-tavern.mjs [--dry]
// 原件备份：<文件>.bak-flat-<日期>
// 幂等：已经是酒馆格式的文件会被跳过。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const DATA = path.join(ROOT, 'data');
const DIRS = { cards: path.join(DATA, 'cards'), worlds: path.join(DATA, 'worlds') };
const DRY = process.argv.includes('--dry');
const STAMP = 'flat-20261113';

const safeId = (v) => String(v || '').trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'untitled';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function backup(file) {
  const bak = `${file}.bak-${STAMP}`;
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  return bak;
}

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
      extensions: {
        stlite: {
          id: card.id,
          world: card.world || card.id,
          created: card.created || '',
          updated: card.updated || '',
        },
      },
    },
  };
}

function worldToTavern(world) {
  const entries = {};
  (world.entries || []).forEach((entry, index) => {
    const keys = Array.isArray(entry.keys || entry.key) ? (entry.keys || entry.key) : [];
    entries[String(index)] = {
      uid: index,
      stliteId: entry.id || entry.stliteId || `e${index + 1}`,
      key: keys.map(String).filter(Boolean),
      keysecondary: [],
      comment: entry.comment || '',
      content: entry.content || '',
      constant: !!entry.constant,
      selective: true,
      selectiveLogic: 0,
      order: Number(entry.order || entry.priority || 100),
      position: 0,
      disable: !!(entry.disabled || entry.disable),
      excludeRecursion: false,
      preventRecursion: false,
      delayUntilRecursion: false,
      probability: 100,
      useProbability: true,
      depth: 4,
      group: '',
      groupOverride: false,
      groupWeight: 100,
      scanDepth: null,
      caseSensitive: null,
      matchWholeWords: null,
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

let cardsDone = 0, cardsSkipped = 0, worldsDone = 0, worldsSkipped = 0;

for (const file of fs.readdirSync(DIRS.cards).filter((f) => f.endsWith('.json'))) {
  const full = path.join(DIRS.cards, file);
  const raw = readJson(full);
  if (!raw) { console.log('跳过（解析失败）', file); continue; }
  if (raw.spec === 'chara_card_v2' || raw.data) { cardsSkipped++; continue; }
  const card = Object.assign({ id: safeId(raw.id || path.basename(file, '.json')) }, raw);
  if (DRY) { console.log('将迁移卡:', file); cardsDone++; continue; }
  const bak = backup(full);
  fs.writeFileSync(full, JSON.stringify(cardToV2(card), null, 2), 'utf8');
  console.log('迁移卡:', file, '备份→', path.basename(bak));
  cardsDone++;
}

for (const file of fs.readdirSync(DIRS.worlds).filter((f) => f.endsWith('.json'))) {
  const full = path.join(DIRS.worlds, file);
  const raw = readJson(full);
  if (!raw) { console.log('跳过（解析失败）', file); continue; }
  const isTavern = raw.entries && !Array.isArray(raw.entries);
  if (isTavern) { worldsSkipped++; continue; }
  const world = Object.assign({ id: safeId(raw.id || path.basename(file, '.json')) }, raw);
  if (DRY) { console.log('将迁移世界书:', file); worldsDone++; continue; }
  const bak = backup(full);
  fs.writeFileSync(full, JSON.stringify(worldToTavern(world), null, 2), 'utf8');
  console.log('迁移世界书:', file, '备份→', path.basename(bak));
  worldsDone++;
}

console.log(`\n完成：卡 ${cardsDone} 迁移 / ${cardsSkipped} 已是新格式；世界书 ${worldsDone} 迁移 / ${worldsSkipped} 已是新格式`);
if (DRY) console.log('（--dry：没有写盘）');
