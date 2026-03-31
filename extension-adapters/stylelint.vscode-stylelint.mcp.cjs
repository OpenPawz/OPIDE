#!/usr/bin/env node
// Auto-generated MCP adapter for stylelint.vscode-stylelint (linter: stylelint)
const path = require('path');
let buffer = '', contentLength = -1;
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    if (contentLength === -1) {
      const h = buffer.indexOf('\r\n\r\n');
      if (h === -1) return;
      const m = buffer.slice(0, h).match(/Content-Length:\s*(\d+)/i);
      if (!m) { buffer = buffer.slice(h + 4); continue; }
      contentLength = parseInt(m[1], 10);
      buffer = buffer.slice(h + 4);
    }
    if (Buffer.byteLength(buffer, 'utf-8') < contentLength) return;
    const body = Buffer.from(buffer, 'utf-8').slice(0, contentLength).toString('utf-8');
    buffer = Buffer.from(buffer, 'utf-8').slice(contentLength).toString('utf-8');
    contentLength = -1;
    try { handleMessage(JSON.parse(body)); } catch (e) { log('Parse error: ' + e.message); }
  }
});
function send(msg) { const j = JSON.stringify(msg); process.stdout.write('Content-Length: ' + Buffer.byteLength(j, 'utf-8') + '\r\n\r\n' + j); }
function sendResult(id, r) { send({ jsonrpc: '2.0', id, result: r }); }
function sendError(id, c, m) { send({ jsonrpc: '2.0', id, error: { code: c, message: m } }); }
function log(m) { process.stderr.write('[stylelint-mcp] ' + m + '\n'); }

let linter = null;
const ws = process.env.OPIDE_WORKSPACE || process.cwd();

function resolveLib() {
  if (linter) return linter;
  try { linter = require(path.join(ws, 'node_modules', 'stylelint')); return linter; } catch {}
  try { linter = require('stylelint'); return linter; } catch {}
  return null;
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') { sendResult(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stylelint', version: '1.0.0' } }); return; }
  if (method === 'notifications/initialized') { resolveLib(); return; }
  if (method === 'tools/list') {
    sendResult(id, { tools: [
      { name: 'lint_file', description: 'Lint file using stylelint', inputSchema: { type: 'object', properties: { content: { type: 'string' }, file_path: { type: 'string' } }, required: ['content', 'file_path'] } },
      { name: 'fix_file', description: 'Auto-fix issues using stylelint', inputSchema: { type: 'object', properties: { content: { type: 'string' }, file_path: { type: 'string' } }, required: ['content', 'file_path'] } },
    ] });
    return;
  }
  if (method === 'tools/call') {
    const { name, arguments: a } = params || {};
    const mod = resolveLib();
    if (!mod) { sendResult(id, { content: [{ type: 'text', text: 'Error: stylelint not found' }], isError: true }); return; }
    try {
      const ESLint = mod.ESLint || mod.default?.ESLint || mod;
      const engine = new ESLint({ cwd: ws, fix: name === 'fix_file' });
      const results = await engine.lintText(a.content, { filePath: a.file_path });
      if (name === 'fix_file') {
        sendResult(id, { content: [{ type: 'text', text: results[0]?.output || a.content }] });
      } else {
        const diags = (results[0]?.messages || []).map(m => ({ line: m.line, column: m.column, severity: m.severity === 2 ? 'error' : 'warning', message: m.message, ruleId: m.ruleId }));
        sendResult(id, { content: [{ type: 'text', text: JSON.stringify(diags, null, 2) }] });
      }
    } catch (e) {
      sendResult(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
    }
    return;
  }
  if (method === 'shutdown' || method === 'exit') process.exit(0);
  if (id) sendError(id, -32601, 'Method not found: ' + method);
}
log('stylelint MCP adapter starting');
