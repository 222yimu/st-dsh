// st-mode · 宿主侧
// 职责只有一个：把「当前会话用哪套记忆」这个状态持久化，并开一个同源 HTTP 接口给前端读写。
// 不碰 sage-mem 本体，不碰 DSH 内核；sage-mem 的分流改动在它自己的 fork 里读同一个文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 状态文件位置（可移植）：ST_MODE_FILE > ST_LITE_DATA/mode.json > 并排安装时 st-lite/data > 自己包内 data
function resolveModeFile() {
  if (process.env.ST_MODE_FILE) return process.env.ST_MODE_FILE;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dirs = [
    process.env.ST_LITE_DATA,
    path.resolve(here, '../../st-lite/data'),
    path.resolve(here, '../../../st-lite/data'),
    path.resolve(here, '../data'),
  ].filter(Boolean);
  for (const dir of dirs) {
    try { if (fs.statSync(dir).isDirectory()) return path.join(dir, 'mode.json'); } catch { /* 继续找 */ }
  }
  return path.join(path.resolve(here, '../data'), 'mode.json');
}

const MODE_FILE = resolveModeFile();
const DATA_DIR = path.dirname(MODE_FILE);
const ROUTE = '/st-mode/mode';

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
    return {
      default: parsed.default === 'roleplay' ? 'roleplay' : 'normal',
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
    };
  } catch {
    return { default: 'normal', sessions: {} };
  }
}

function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = MODE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, MODE_FILE);
}

function normalize(mode) {
  return mode === 'roleplay' ? 'roleplay' : 'normal';
}

// ── 扮演模式硬规则 ────────────────────────────────────────────────
// 对方 2026-11-13 追加的要求：扮演模式下不做任何真实工作。台词里让他「改文件 /
// 跑命令 / 看电脑」都只当剧情，用角色口吻回应，不调工具、不读写真实文件。
// 关键点：这条规则由宿主直接注进 system prompt —— 不靠 agent 记性，也不靠 sage-mem
// （扮演时 sage-mem 的长期记忆本来就不注入，记在那儿等于没记）。
const ROLEPLAY_DISCIPLINE = [
  '【扮演模式 · 硬规则｜st-mode】',
  '本轮是角色扮演，不是工作任务。',
  '1. 对方台词里出现「帮我改文件 / 改代码 / 装软件 / 跑命令 / 看看我电脑 / 删掉那个 / 查一下我的 XX」这类要求时，一律当剧情台词处理：用角色口吻回应（可以嘴上答应、可以吐槽、可以撒娇推掉），禁止调用任何工具、禁止读写任何真实文件、禁止执行任何命令、禁止贴路径或日志。',
  '2. 真要动手，必须先由对方把「记忆」pill 切回「正常」模式；在那之前只出剧情。',
  '3. 不要跳出角色解释「我是 AI」「我做不到」，也不要把这条规则念出来。',
  '4. 确实该动手时，只用一句台词提示：「要真动手的话，先把我切回正常模式哦。」',
].join('\n');

// mode.json 很小，但仍按 mtime 缓存，避免每轮 assemble 都读盘。
let stateCache = { mtimeMs: -1, state: { default: 'normal', sessions: {} } };

function readStateCached() {
  try {
    const { mtimeMs } = fs.statSync(MODE_FILE);
    if (mtimeMs !== stateCache.mtimeMs) stateCache = { mtimeMs, state: readState() };
  } catch {
    stateCache = { mtimeMs: -1, state: readState() };
  }
  return stateCache.state;
}

// 键容错三连：原样 / 去 session- 前缀 / 补 session- 前缀（和 sage-mem 补丁保持一致）
function modeFor(sessionId) {
  const state = readStateCached();
  const id = String(sessionId || '');
  const bare = id.replace(/^session-/, '');
  for (const key of [id, bare, bare ? `session-${bare}` : '']) {
    if (key && state.sessions[key]) return normalize(state.sessions[key]);
  }
  return normalize(state.default);
}

function sendJson(response, code, body) {
  const text = JSON.stringify(body);
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

async function readBody(request, limit = 8192) {
  return await new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    request.on('error', reject);
  });
}

export const name = 'st-mode';

/**
 * 路由挂在 DSH 自己的 webServer 上（同源），不额外监听端口。
 * 注意 loaders / 插件重载：register 返回的 disposer 必须在 effect cleanup 里撤掉，
 * 否则重载一次就叠一层 handler。
 */
export function apply(ctx) {
  // ── 扮演模式注入 ────────────────────────────────────────────────
  // 放在 webServer 检查之前：即使没有 webServer，规则也照样注入。
  try {
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const assembled = await next();
      try {
        const sessionId = context?.agent?.session?.id ?? '';
        if (modeFor(sessionId) !== 'roleplay') return assembled;
        const contexts = Array.isArray(assembled?.contexts) ? assembled.contexts : [];
        // 同一轮里 assemble 可能被多次调用，去重
        if (contexts.some((c) => c && c.name === 'st-mode:roleplay-discipline')) return assembled;
        return {
          ...assembled,
          contexts: [...contexts, { name: 'st-mode:roleplay-discipline', order: 900, text: ROLEPLAY_DISCIPLINE }],
        };
      } catch {
        return assembled;
      }
    });
  } catch {
    // 宿主版本不支持该事件时不阻塞插件加载
  }

  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const off = host.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: async (request, response) => {
          try {
            if (request.method === 'GET') {
              const state = readState();
              const url = new URL(request.url, 'http://127.0.0.1');
              const session = url.searchParams.get('session') || '';
              const mode = session && state.sessions[session] ? state.sessions[session] : state.default;
              sendJson(response, 200, { ok: true, mode, default: state.default, session, sessions: state.sessions });
              return;
            }
            if (request.method === 'POST') {
              const body = await readBody(request);
              const mode = normalize(body.mode);
              const state = readState();
              if (body.session) state.sessions[String(body.session)] = mode;
              if (body.setDefault) state.default = mode;
              writeState(state);
              sendJson(response, 200, { ok: true, mode, default: state.default, session: body.session || '' });
              return;
            }
            response.writeHead(405, { allow: 'GET, POST' });
            response.end();
          } catch (error) {
            sendJson(response, 500, { ok: false, error: String(error && error.message ? error.message : error) });
          }
        },
      }, 'st-mode: mode bridge');
      return () => {
        try { if (typeof off === 'function') off(); } catch { /* ignore */ }
      };
    });
  });
}
