// roleplay-guard · 扮演模式 preset 的硬边界
//
// 设计目标（第二版，取代静态编译方案）：
//   扮演模式要能像酒馆那样**运行时**读角色卡与世界书，撑得住长剧情；
//   但仍然不许碰系统：没有 shell、不读写工作区文件、不联网、不派生 agent。
//
// 所以边界从「零工具」改成「只留 st-lite 的只读/剧情工具」：
//   ✅ 允许：st_prompt / st_history / st_log / st_cards / st_card_get / st_world_list
//   ❌ 拒绝：除此之外的一切（shell、fs、glob/grep、web、jobs、skill、goal、todo、
//            subagent、workflow、QQ 桥、web-search-safe、以及 st_card_save / st_world_add 这类写操作）
//
// 做法：
//   1) tools.restrict 把非白名单工具从 schema 里隐掉（逐个 deny，名字不存在会抛错，
//      restrict 的 unknown 校验是整批原子性的，所以必须一次一个 try/catch）
//   2) tools.guard 执行期兜底（白名单之外一律拒）
//   3) 把这个会话登记进 st-mode 的 mode.json（roleplay），sage-mem 的补丁随后跳过
//      长期记忆注入 —— 长剧情靠 st-lite 的 chats，不靠 sage-mem。
//
// 时序要点：sage-mem 是「先 await next()、再读 mode.json」，这里在本轮 assemble
// 里写入，同一轮就生效，不漏首轮。

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 状态文件位置（可移植）：ST_MODE_FILE > ST_LITE_DATA/mode.json > 并排安装的 st-lite|st-mode/data > 自己包内 data
function resolveModeFile() {
  if (process.env.ST_MODE_FILE) return process.env.ST_MODE_FILE;
  const here = dirname(fileURLToPath(import.meta.url));
  const dirs = [
    process.env.ST_LITE_DATA,
    join(here, 'st-lite', 'data'),
    join(here, '..', 'st-lite', 'data'),
    join(here, '..', '..', 'st-lite', 'data'),
    join(here, 'st-mode', 'data'),
    join(here, '..', 'st-mode', 'data'),
    join(here, 'data'),
  ].filter(Boolean);
  for (const dir of dirs) {
    try { if (statSync(dir).isDirectory()) return join(dir, 'mode.json'); } catch { /* 继续找 */ }
  }
  return join(here, 'data', 'mode.json');
}

const MODE_FILE = resolveModeFile();

// ── 白名单：扮演所需的最小集 ────────────────────────────────────────────
// 全部是 mcp__st-lite__ 前缀，纯本地文本（角色卡 / 世界书 / 聊天记录），
// 不碰工作区文件、不执行命令、不联网。
export const ALLOWED_TOOLS = Object.freeze([
  'mcp__st-lite__st_prompt', // 组装本轮提示词：卡 + 世界书命中 + 最近对话
  'mcp__st-lite__st_history', // 读历史
  'mcp__st-lite__st_log', // 追加一轮对话
  'mcp__st-lite__st_cards', // 列卡
  'mcp__st-lite__st_card_get', // 读一张卡
  'mcp__st-lite__st_world_list', // 列世界书
  // ── 剧情驱动的设定演进（受控写入：字段级补丁 + 追加/更新条目，写前自动 .bak）──
  'mcp__st-lite__st_card_patch', // 只改给出的卡字段，其余保留
  'mcp__st-lite__st_world_add', // 追加世界书条目
  'mcp__st-lite__st_world_update', // 改已有条目
  'mcp__st-lite__st_story', // 剧情长档（撑几千轮的主线记忆）
  'mcp__st-lite__st_turn', // 消息级：删除/编辑/截断/重生成（酒馆的 swipe）
]);

const ALLOWED = new Set(ALLOWED_TOOLS);

// ── 要隐藏的工具（除白名单外）──────────────────────────────────────────
const LOCAL_TOOLS = [
  'pwsh', 'bash', 'pwsh_persistent', 'bash_persistent',
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  'glob', 'grep',
  'load_workspace_dependencies',
  // 联网（DSH 自带 tool-web 注册的裸名；MCP 版的 mcp__web-search-safe__* 在下面）
  'web_search', 'web_fetch', 'fetch',
  // 派生 / 编排（都能间接拿到 shell）
  'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code',
  'list_subagent_models', 'send_message', 'interrupt_agent', 'list_agents',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'workflow', 'ralph',
  // 会话 / 交付 / 任务面
  'present', 'skill', 'ask_user_question', 'todo_write', 'exit_plan_mode',
  'job_list', 'job_output', 'job_kill',
  'get_goal', 'create_goal', 'update_goal',
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // 宿主运行期 / 插件装载 / 快照回滚
  'cordis_inspect_list', 'cordis_inspect_query',
  'plugin_manager', 'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  'purge_apply', 'purge_revert', 'purge_status',
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
  // 全局层默认启用的 MCP 资源接口
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  // st-lite 里**整卡覆盖**的 st_card_save：扮演不给（要改用 st_card_patch，
  // 它有字段级 merge 保护，不会因为漏字段把人设写残）。
  // st_world_add / st_world_update / st_card_patch 已在白名单，故不在此列。
  'mcp__st-lite__st_card_save',
];

// 其它 MCP 命名空间（QQ 桥 / 宿主探活 / 联网搜索）：扮演用不到
const OTHER_MCP_TOOLS = [
  ...[
    'qq_collect_sticker', 'qq_get_active_members', 'qq_get_forward_msg', 'qq_get_group_history',
    'qq_get_group_members', 'qq_get_message_detail', 'qq_get_message_images',
    'qq_get_my_recent_messages', 'qq_get_prompt', 'qq_get_recent_messages', 'qq_get_self_image',
    'qq_get_sticker_image', 'qq_get_unread_messages', 'qq_list_groups', 'qq_list_stickers',
    'qq_mark_read', 'qq_memory_append', 'qq_memory_clear', 'qq_memory_query', 'qq_memory_remove',
    'qq_reply', 'qq_report_feedback', 'qq_send_burst', 'qq_send_group_message', 'qq_send_message',
    'qq_send_poke', 'qq_send_private_message', 'qq_send_sticker', 'qq_set_sticker_remark',
    'qq_set_wake_config', 'qq_slang_query', 'qq_slang_submit', 'qq_social_state', 'qq_status',
    'qq_sticker_note', 'qq_wait_for_messages',
  ].map((n) => `mcp__snowluma__${n}`),
  'mcp__snowluma-host__snowluma_status',
  ...['web_search', 'web_fetch'].map((n) => `mcp__web-search-safe__${n}`),
];

export const RESTRICTED_TOOL_NAMES = Object.freeze(
  [...LOCAL_TOOLS, ...OTHER_MCP_TOOLS].filter((toolName) => !ALLOWED.has(toolName)),
);

const GUARD_REASON =
  '扮演模式只允许 st-lite 的读卡/剧情工具（st_prompt、st_history、st_log、st_cards、st_card_get、st_world_list）；' +
  '这个工具在扮演模式下不存在。要真动手，请切回 normal 预设。';

// ── st-mode 登记：让 sage-mem 别注入长期记忆 ───────────────────────────
function readState() {
  try {
    const parsed = JSON.parse(readFileSync(MODE_FILE, 'utf8'));
    return {
      default: parsed.default === 'roleplay' ? 'roleplay' : 'normal',
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
    };
  } catch {
    return { default: 'normal', sessions: {} };
  }
}

function markRoleplay(sessionId) {
  const id = String(sessionId || '');
  if (!id) return;
  const state = readState();
  if (state.sessions[id] === 'roleplay') return; // 已登记，省一次写盘
  state.sessions[id] = 'roleplay';
  try {
    mkdirSync(dirname(MODE_FILE), { recursive: true });
    const tmp = `${MODE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, MODE_FILE);
  } catch (error) {
    console.error(`[roleplay-guard] 写 mode.json 失败：${error?.message ?? error}`);
  }
}

export const name = 'roleplay-guard';

export const inject = ['tools'];

export function apply(ctx) {
  // 1) schema 层：隐藏非白名单工具
  for (const toolName of RESTRICTED_TOOL_NAMES) {
    try {
      ctx.tools.restrict({ deny: [toolName] });
    } catch {
      // 这个名字在当前 DSH 版本里不存在 —— 跳过，执行期白名单照样兜底
    }
  }

  // 2) 执行期：只放行白名单
  ctx.tools.guard((exec) => {
    const execName = exec?.name;
    if (typeof execName === 'string' && ALLOWED.has(execName)) return;
    return GUARD_REASON;
  });

  // 3) 让 sage-mem 在这一轮就停止注入
  try {
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const assembled = await next();
      try {
        markRoleplay(context?.agent?.session?.id ?? '');
      } catch {
        /* 登记失败不影响本轮 */
      }
      return assembled;
    });
  } catch {
    // 宿主版本不支持该事件时不影响 preset 挂载
  }
}
