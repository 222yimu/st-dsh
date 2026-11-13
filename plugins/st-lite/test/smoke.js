// 自测得：spawn st-lite MCP server，走一遍 initialize / tools/list / tools/call
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
const pending = new Map();
server.stdout.setEncoding('utf8');
server.stdout.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

let seq = 0;
function call(method, params) {
  const id = ++seq;
  return new Promise((resolve) => { pending.set(id, resolve); server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
}

(async () => {
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  console.log('initialize ->', init.result.serverInfo);

  const list = await call('tools/list', {});
  console.log('tools ->', list.result.tools.map((t) => t.name).join(', '));

  const cards = await call('tools/call', { name: 'st_cards', arguments: {} });
  console.log('st_cards ->', cards.result.content[0].text);

  const log = await call('tools/call', { name: 'st_log', arguments: { card: process.env.ST_TEST_CARD || 'example', role: 'user', text: '今天好累，想吃米饭。' } });
  console.log('st_log ->', log.result.content[0].text);

  const prompt = await call('tools/call', { name: 'st_prompt', arguments: { card: process.env.ST_TEST_CARD || 'example', userMessage: '今天好累，想吃米饭。' } });
  const body = JSON.parse(prompt.result.content[0].text);
  console.log('stats ->', JSON.stringify(body.stats));
  console.log('--- prompt ---');
  console.log(body.prompt);

  const hist = await call('tools/call', { name: 'st_history', arguments: { card: process.env.ST_TEST_CARD || 'example', limit: 5 } });
  console.log('st_history ->', hist.result.content[0].text);

  server.stdin.end();
  server.kill();
})();
