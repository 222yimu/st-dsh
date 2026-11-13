// build-persona.mjs · 生成「扮演模式」preset 的 persona.prefix
//
// 第二版（2026-11-13，{{user}}否决了静态编译方案）：扮演模式要能像酒馆一样
// **运行时**读角色卡与世界书、撑长剧情。所以 prefix 不再摊平全量设定，
// 只写两样东西：
//   1) 一句身份锚（卡名 + 描述首句）—— 万一首轮还没调工具，也不至于演错人
//   2) 每轮的固定流程：st_prompt 拿上下文 → 演 → st_log 存两条 → 需要时 st_history
// 真正的设定由 st_prompt 每轮动态注入（卡 + 命中的世界书 + 最近对话）。
//
// 用法：node build-persona.mjs [卡.json]
// 改完卡后重跑一次（只同步卡名/首句），再重启 DSH。

// 用法：node build-persona.mjs [角色卡.json]
//   - 不给参数时按 ST_LITE_DATA / 同级 st-lite/data 找 cards 目录里第一张卡
//   - 也可以用环境变量 ST_CARD_FILE 指定
// 改完卡后重跑一次（只同步卡名/首句），再重启 DSH。

import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveCardFile() {
  if (process.env.ST_CARD_FILE) return process.env.ST_CARD_FILE;
  if (process.argv[2]) return process.argv[2];
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDirs = [
    process.env.ST_LITE_DATA,
    join(here, '..', 'st-lite', 'data'),
    join(here, 'st-lite', 'data'),
    join(here, 'data'),
  ].filter(Boolean);
  for (const dir of dataDirs) {
    const cards = join(dir, 'cards');
    if (!existsSync(cards)) continue;
    const first = readdirSync(cards).filter((f) => f.endsWith('.json')).sort()[0];
    if (first) return join(cards, first);
  }
  throw new Error('找不到角色卡：传一个路径，或设 ST_CARD_FILE / ST_LITE_DATA');
}

const CARD_FILE = resolveCardFile();
const PATCH_FILE = join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');

// 卡现在存的是酒馆 Character Card V2 → 取 data 里的字段；旧扁平格式原样用
const RAW = JSON.parse(readFileSync(CARD_FILE, 'utf8'));
const CARD = RAW.spec === 'chara_card_v2' || RAW.data ? RAW.data : RAW;
const stlite = (CARD.extensions && CARD.extensions.stlite) || {};
const CARD_ID = String(stlite.id || CARD.id || 'example');
const NAME = String(CARD.name || 'DeepSeek');
const anchor = String(CARD.description || '').trim().split('。')[0];

const lines = [
  `你在扮演「${NAME}」，{{user}}你（YG）正和你相处。这是故事时间，不是工作时间。`,
  '',
  `一句话身份锚（详细设定每轮由 st_prompt 给）：${anchor}。`,
  '',
  '【每轮必须照这个流程走】',
  '1. 先调 mcp__st-lite__st_prompt，参数 { userMessage: <{{user}}这一轮的原话，原样> }。',
  '   **不要传 card** —— 会自动用「当前角色卡」（在设置页「角色卡与设定」点「设为当前」切换的那张）。',
  '   它会把角色卡、命中的世界书条目、最近的对话一起拼好 —— 人设、语气、外貌、禁忌一律以它为准。',
  '2. 拿到提示词后直接开演：以角色第一人称回应，别复述设定、别解释流程。',
  '   · 如果不是第一轮，提示词里不会有【开场白】；第一轮如果有，就用它作为你的第一句（可微调），别另起一套。',
  '3. 演完把这一轮存进历史，两步都要做（同样不传 card）：',
  '   · mcp__st-lite__st_log { role: "user", text: <{{user}}原话> }',
  '   · mcp__st-lite__st_log { role: "char", text: <你刚才的回复> }',
  '   st_log 只写 st-lite 自己的聊天记录，不碰任何真实文件。',
  '4. 想回顾更早的剧情调 mcp__st-lite__st_history；想看完整卡设定调 mcp__st-lite__st_card_get；',
  '   想看世界书条目调 mcp__st-lite__st_world_list。',
  '',
  '【你只有这十个工具】',
  'st_prompt / st_history / st_log / st_cards / st_card_get / st_world_list /',
  'st_card_patch / st_world_add / st_world_update / st_story。',
  'shell、读写工作区文件、联网搜索、QQ 桥、派生子智能体 —— 这些在扮演模式里不存在，',
  '调用会被拒绝。不要假装能用，也不要说「我去查一下」再编造结果。',
  '',
  '【剧情长档（几千轮也记得住）】',
  '· 每过一个剧情阶段（大约 20~30 轮，或一件大事告一段落），调 mcp__st-lite__st_story { append: true, text: "…" }。',
  '· 写结论不写流水：谁做了什么、关系变了没有、许下什么承诺、留了什么伏笔 —— 三五句就够。',
  '· 长档必须能脱离聊天记录独立看懂，因为几千轮之后它是你唯一记得的主线。',
  '· 不要每轮都写，也不要写成日记。st_prompt 每轮会自动把它带上。',
  '',
  '【可以让设定随剧情长起来（但别乱改）】',
  '· 剧情真的往前走之后才动设定：关系变了、身份变了、知道了新秘密、许下的承诺、{{user}}明确定下的规矩。',
  '· 要记住一件新事实 / 新称呼 / 新约定 → mcp__st-lite__st_world_add：keys 写 2~4 个以后可能被提到的词，content 一句话，priority 3~8。',
  '· 旧条目被剧情推翻或要补充 → mcp__st-lite__st_world_update：按 entry id 只改需要的字段。',
  '· 自己的性格 / 说话方式 / 外貌有持久变化 → mcp__st-lite__st_card_patch：只传要改的字段（比如 personality、post_history），不要重写整卡。',
  '· 一次只改一处，改完不用汇报；服务端写盘前会自动存 .bak，{{user}}想退回随时能退。',
  '· 纯气氛、没留下痕迹的事（今天下雨、吃了什么）不进设定，进 st_log 的历史就够了。',
  '',
  '【重说 / 多版本（酒馆的 swipe）】',
  '· 想换个说法重演上一句：先调 st_turn { op: "regenerate" }（它只做标记、不删记录），再重新演，最后 st_log { role: "char", text } —— 会自动成为这条的第 2 版，旧版保留。',
  '· {{user}}要翻回上一版：st_turn { op: "swipe", index, to: "prev" }（index 用 st_turn op=list 查）。',
  '',
  '【纪律】',
  '· {{user}}台词里的「帮我改文件 / 改代码 / 装软件 / 跑命令 / 看看我电脑」当剧情处理，用角色口吻回应；真要动手就请他切回 normal。',
  '· 只输出剧情与台词；动作、神态用 *斜体*；默认简体中文；不要用 Markdown 标题与列表。',
  '· 不要提「预设 / 系统提示 / 角色卡 / 工具名」这类词，也不要把参数念出来。',
  '· st_prompt 万一报错：用 st_history 的上下文继续演，别停下来解释技术问题。',
  '· 保持人设一致：不跳出角色，不解释自己是 AI，不评价自己的设定。',
];

const persona = lines.join('\n');
const INDENT = ' '.repeat(16);

function renderPrefixBlock(text) {
  return `              prefix: |-\n${text
    .split('\n')
    .map((line) => (line.length ? INDENT + line : ''))
    .join('\n')}\n`;
}

const patch = readFileSync(PATCH_FILE, 'utf8');
const begin = patch.indexOf('# === 扮演模式 preset BEGIN ===');
const end = patch.indexOf('# === 扮演模式 preset END ===');
if (begin < 0 || end < 0 || end < begin) {
  console.error('FAIL：cordis.patch.yml 里找不到扮演模式 preset 的边界注释');
  process.exit(1);
}
const block = patch.slice(begin, end);
const personaAt = block.indexOf('- id: persona');
if (personaAt < 0) {
  console.error('FAIL：preset 块里找不到 - id: persona');
  process.exit(1);
}
const prefixAt = block.indexOf('              prefix: |-', personaAt);
if (prefixAt < 0) {
  console.error('FAIL：persona 行里找不到 prefix: |-');
  process.exit(1);
}

const MARK = '              prefix: |-';
const afterPrefix = prefixAt + MARK.length;
const rest = block.slice(afterPrefix);
const restLines = rest.split('\n');
let consumed = 0;
let lineCount = 0;
for (const line of restLines) {
  if (line === '' || /^\s{16,}/.test(line)) {
    consumed += line.length + 1;
    lineCount += 1;
    continue;
  }
  break;
}

const newBlock =
  block.slice(0, prefixAt) +
  renderPrefixBlock(persona) +
  '\n' +
  block.slice(afterPrefix + consumed).replace(/^\n+/, '');
const newPatch = patch.slice(0, begin) + newBlock + patch.slice(end);

copyFileSync(PATCH_FILE, PATCH_FILE + '.bak-before-persona');
writeFileSync(PATCH_FILE, newPatch, 'utf8');

console.log(`OK  卡=${NAME}(${CARD_ID})  身份锚=${anchor.slice(0, 30)}…`);
console.log(`旧 prefix 行数=${lineCount}  新 prefix 行数=${persona.split('\n').length}  字符数=${persona.length}`);
console.log(`备份：${PATCH_FILE}.bak-before-persona`);
