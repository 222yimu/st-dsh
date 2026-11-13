// 验证补丁里的 stModeState / stModeFor 逻辑（把补丁中的函数原样搬出来跑）
'use strict';
const { readFileSync, statSync, appendFileSync } = require('node:fs');

const ST_MODE_FILE = 'D:\\ymLN\\dsh-plugins\\st-mode\\data\\mode.json';
const ST_GATE_LOG = 'D:\\ymLN\\dsh-plugins\\st-mode\\data\\gate.log';
let stModeCache = { mtimeMs: -1, state: { default: 'normal', sessions: {} } };

function stModeState() {
  try {
    const stat = statSync(ST_MODE_FILE);
    if (stat.mtimeMs !== stModeCache.mtimeMs) {
      const parsed = JSON.parse(readFileSync(ST_MODE_FILE, 'utf8'));
      stModeCache = {
        mtimeMs: stat.mtimeMs,
        state: {
          default: parsed && parsed.default === 'roleplay' ? 'roleplay' : 'normal',
          sessions: parsed && parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
        },
      };
    }
  } catch {
    /* fallback */
  }
  return stModeCache.state;
}

function stModeFor(sessionId) {
  const state = stModeState();
  if (sessionId && state.sessions && state.sessions[sessionId]) return state.sessions[sessionId];
  return state.default;
}

const cases = [
  ['a502308b-c93e-4e17-b379-23e7b6ab3189', 'roleplay', '显式标了 roleplay 的会话'],
  ['test-session-001', 'normal', '显式标了 normal 的会话'],
  ['never-seen-session', 'normal', '未记录的会话 → 回落 default(normal)'],
  ['', 'normal', '无 sessionId → 回落 default'],
];

let pass = 0;
for (const [sid, want, label] of cases) {
  const got = stModeFor(sid);
  const ok = got === want;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  sid=${sid || '-'}  got=${got}  want=${want}`);
}
console.log(`\n${pass}/${cases.length} 通过`);
process.exit(pass === cases.length ? 0 : 1);
