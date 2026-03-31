#!/usr/bin/env node
// ── ESLint MCP Adapter ───────────────────────────────────────────────────────
// MCP server that exposes ESLint as tools.
// Same protocol as prettier.mcp.cjs — Content-Length framed JSON-RPC on stdio.

const path = require('path');

// ── JSON-RPC stdio transport ─────────────────────────────────────────────────

let buffer = '';
let contentLength = -1;

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    if (contentLength === -1) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }
      contentLength = parseInt(match[1], 10);
      buffer = buffer.slice(headerEnd + 4);
    }
    if (Buffer.byteLength(buffer, 'utf-8') < contentLength) return;
    const body = Buffer.from(buffer, 'utf-8').slice(0, contentLength).toString('utf-8');
    buffer = Buffer.from(buffer, 'utf-8').slice(contentLength).toString('utf-8');
    contentLength = -1;
    try { handleMessage(JSON.parse(body)); } catch (e) { log(`Parse error: ${e.message}`); }
  }
});

function send(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf-8')}\r\n\r\n${json}`);
}
function sendResult(id, result) { send({ jsonrpc: '2.0', id, result }); }
function sendError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
function log(msg) { process.stderr.write(`[eslint-mcp] ${msg}\n`); }

// ── ESLint resolution ────────────────────────────────────────────────────────

let eslintModule = null;
let workspacePath = process.env.OPIDE_WORKSPACE || process.cwd();
log(`Workspace: ${workspacePath}`);

function resolveESLint() {
  if (eslintModule) return eslintModule;
  const paths = [
    path.join(workspacePath, 'node_modules', 'eslint'),
  ];
  try { paths.push(require.resolve('eslint')); } catch {}

  for (const p of paths) {
    try {
      eslintModule = require(p);
      log(`Resolved eslint from: ${p}`);
      return eslintModule;
    } catch {}
  }
  log('ERROR: eslint not found. Install it: npm install eslint');
  return null;
}

// ── MCP Protocol ─────────────────────────────────────────────────────────────

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    if (params?.rootUri) workspacePath = params.rootUri.replace('file://', '');
    sendResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'eslint', version: '1.0.0' },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    log('MCP initialized');
    resolveESLint();
    return;
  }

  if (method === 'tools/list') {
    sendResult(id, {
      tools: [
        {
          name: 'lint_file',
          description: 'Lint file content using ESLint. Returns diagnostics (errors and warnings).',
          inputSchema: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'File content to lint' },
              file_path: { type: 'string', description: 'File path (used to resolve config)' },
              language: { type: 'string', description: 'Language ID' },
            },
            required: ['content', 'file_path'],
          },
        },
        {
          name: 'fix_file',
          description: 'Auto-fix ESLint issues in file content. Returns fixed content.',
          inputSchema: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'File content to fix' },
              file_path: { type: 'string', description: 'File path' },
            },
            required: ['content', 'file_path'],
          },
        },
      ],
    });
    return;
  }

  if (method === 'tools/call') {
    const { name: toolName, arguments: args } = params || {};
    try {
      const eslint = resolveESLint();
      if (!eslint) {
        sendResult(id, {
          content: [{ type: 'text', text: 'Error: eslint not found. Run: npm install eslint' }],
          isError: true,
        });
        return;
      }

      const ESLint = eslint.ESLint || eslint.default?.ESLint;
      if (!ESLint) {
        sendResult(id, {
          content: [{ type: 'text', text: 'Error: ESLint class not found in module' }],
          isError: true,
        });
        return;
      }

      switch (toolName) {
        case 'lint_file': {
          const linter = new ESLint({ cwd: workspacePath });
          const results = await linter.lintText(args.content, { filePath: args.file_path });
          const messages = results[0]?.messages || [];
          log(`Lint: ${args.file_path} — ${messages.length} issues`);

          const diagnostics = messages.map(m => ({
            line: m.line,
            column: m.column,
            severity: m.severity === 2 ? 'error' : 'warning',
            message: m.message,
            ruleId: m.ruleId,
          }));

          sendResult(id, {
            content: [{ type: 'text', text: JSON.stringify(diagnostics, null, 2) }],
          });
          return;
        }

        case 'fix_file': {
          const linter = new ESLint({ cwd: workspacePath, fix: true });
          const results = await linter.lintText(args.content, { filePath: args.file_path });
          const fixed = results[0]?.output || args.content;
          const fixCount = results[0]?.fixableErrorCount + results[0]?.fixableWarningCount || 0;
          log(`Fix: ${args.file_path} — ${fixCount} fixes applied`);

          sendResult(id, {
            content: [{ type: 'text', text: fixed }],
          });
          return;
        }

        default:
          sendError(id, -32601, `Unknown tool: ${toolName}`);
      }
    } catch (e) {
      log(`Tool error: ${e.message}`);
      sendResult(id, {
        content: [{ type: 'text', text: `Error: ${e.message}` }],
        isError: true,
      });
    }
    return;
  }

  if (method === 'shutdown' || method === 'exit') { process.exit(0); }
  if (id) sendError(id, -32601, `Method not found: ${method}`);
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
log('ESLint MCP adapter starting on stdio');
