// st-temp · 采样温度控制器（宿主侧）
//
// 原理（本次从 DSH 内核核实的）：
//   dsh-llm 的 `LlmRuntime.streamWithRegistration` 走
//     this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared))
//   —— options 是闭包共享的请求对象，监听器签名 `(options, next)`，**就地改 options 即可影响本次请求**。
//   请求里带 `options.sessionId`，所以可以按会话/模式给不同温度。
//   `LlmCallControls` 里明确有 `temperature?: number`（内核 schema）。
//
// 配置：<st-lite>/data/sampling.json
//   {
//     "default": null,        // 兜底（null/缺省 = 不改）
//     "normal": null,         // 正常会话
//     "roleplay": 0.9,        // 扮演模式会话
//     "sessions": { "session-xxx": 0.5 }   // 指定会话优先
//   }
//
// 只改 temperature 一个字段，别的（provider/model/maxTokens/stop）一概不碰。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 数据目录解析（可移植）：ST_LITE_DATA 优先；否则按并排安装布局找 st-lite/data。
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
const SAMPLING_FILE = path.join(DATA, 'sampling.json');
const MODE_FILE = path.join(DATA, 'mode.json');

let cache = { sampling: { mtime: -1, value: null }, mode: { mtime: -1, value: null } };

function readCached(file, key) {
  try {
    const st = fs.statSync(file);
    if (cache[key].mtime === st.mtimeMs) return cache[key].value;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache[key] = { mtime: st.mtimeMs, value };
    return value;
  } catch {
    cache[key] = { mtime: -1, value: null };
    return null;
  }
}

function num(value) {
  // 注意：Number(null) === 0、Number('') === 0 —— 必须先挡掉，否则"不配置"会变成温度 0（贪心解码）
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 决定本次请求该用多少温度；返回 null 表示"不动"（沿用内核/提供方默认）。 */
export function resolveTemperature(sessionId, opts) {
  const sampling = (opts && opts.sampling) || readCached(SAMPLING_FILE, 'sampling');
  if (!sampling) return null;

  const id = String(sessionId || '');
  if (id && sampling.sessions && sampling.sessions[id] !== undefined) {
    const t = num(sampling.sessions[id]);
    if (t !== null) return t;
  }

  const mode = (opts && opts.mode) || readCached(MODE_FILE, 'mode') || { default: 'normal', sessions: {} };
  const sessions = (mode && mode.sessions) || {};
  const bare = id.replace(/^session-/, '');
  const modeOf = sessions[id] || (bare && sessions[bare]) || (bare && sessions['session-' + bare]) || mode.default || 'normal';
  const isRoleplay = modeOf === 'roleplay';

  const keyed = num(isRoleplay ? sampling.roleplay : sampling.normal);
  if (keyed !== null) return keyed;
  return num(sampling.default);
}

export const name = 'st-temp';

export function apply(ctx) {
  if (typeof ctx.on !== 'function') return;
  try {
    ctx.on('llm/stream', (options, next) => {
      try {
        if (options && typeof options === 'object') {
          const t = resolveTemperature(options.sessionId);
          if (t !== null) options.temperature = t;
        }
      } catch (error) {
        console.error('[st-temp] 注入温度失败:', error && error.message ? error.message : error);
      }
      return next();
    });
  } catch (error) {
    console.error('[st-temp] 注册 llm/stream 监听失败:', error && error.message ? error.message : error);
  }
}
