#!/usr/bin/env node
// ── TODO Highlight MCP Adapter ─────────────────────────────────────────────
// Standalone MCP server that exposes TODO Highlight as tools.
// Speaks Content-Length framed JSON-RPC over stdio — same protocol as
// OpenPawz MCP transport (transport.rs) and our extension host sidecar.
//
// No MCP SDK needed. The protocol is simple JSON-RPC with two methods:
//   - initialize → handshake
//   - tools/list → advertise capabilities
//   - tools/call → execute a tool
//
// Usage: node todohighlight.mcp.js
// Registered in OPIDE via the MCP registry as a stdio server.

const path = require('path');
const fs = require('fs');

// ── JSON-RPC over stdio (Content-Length framing) ─────────────────────────────

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
    try {
      handleMessage(JSON.parse(body));
    } catch (e) {
      log(`Parse error: ${e.message}`);
    }
  }
});

function send(msg) {
  const json = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(json, 'utf-8')}\r\n\r\n`;
  process.stdout.write(header + json);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function log(msg) {
  process.stderr.write(`[todohighlight-mcp] ${msg}\n`);
}

// ── TODO Highlight resolution ──────────────────────────────────────────────

let todoHighlightModule = null;
let workspacePath = process.env.OPIDE_WORKSPACE || process.cwd();
log(`Workspace: ${workspacePath}`);

// Try to resolve todo-highlight from the workspace, then globally
function resolveTodoHighlight() {
  if (todoHighlightModule) return todoHighlightModule;

  // Try workspace node_modules first
  const paths = [
    path.join(workspacePath, 'node_modules', 'vscode-todo-highlight'),
    path.join(workspacePath, 'node_modules', '.pnpm', 'vscode-todo-highlight'),
  ];

  // Also try global
  try {
    paths.push(require.resolve('vscode-todo-highlight'));
  } catch {}

  for (const p of paths) {
    try {
      todoHighlightModule = require(p);
      log(`Resolved vscode-todo-highlight from: ${p}`);
      return todoHighlightModule;
    } catch {}
  }

  log('ERROR: vscode-todo-highlight not found. Install it: npm install vscode-todo-highlight');
  return null;
}

// ── Parser mapping ─────────────────

const tools = {
  'todohighlight.list': async (params, id) => {
    if (!todoHighlightModule) {
      todoHighlightModule = resolveTodoHighlight();
      if (!todoHighlightModule) {
        sendError(id, -32603, 'TODO Highlight not found');
        return;
      }
    }

    try {
      const annotations = await todoHighlightModule.listAnnotations(params);
      sendResult(id, annotations);
    } catch (e) {
      sendError(id, -32603, `Error listing annotations: ${e.message}`);
    }
  },
  'todohighlight.toggleHighlight': async (params, id) => {
    if (!todoHighlightModule) {
      todoHighlightModule = resolveTodoHighlight();
      if (!todoHighlightModule) {
        sendError(id, -32603, 'TODO Highlight not found');
        return;
      }
    }

    try {
      await todoHighlightModule.toggleHighlight(params);
      sendResult(id, true);
    } catch (e) {
      sendError(id, -32603, `Error toggling highlight: ${e.message}`);
    }
  },
};

// ── MCP methods ─────────────────────────────────────────────────────────────

async function handleMessage(msg) {
  if (!msg.jsonrpc || msg.jsonrpc !== '2.0') {
    sendError(null, -32600, 'Invalid JSON-RPC request');
    return;
  }

  const { method, params, id } = msg;

  switch (method) {
    case 'initialize':
      sendResult(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'wayou.vscode-todo-highlight', version: '1.0.0' } });
      break;
    case 'tools/list':
      sendResult(id, { tools: Object.keys(tools).map(name => ({ name, description: name, inputSchema: { type: 'object', properties: { content: { type: 'string' }, file_path: { type: 'string' } } } })) });
      break;
    case 'tools/call':
      if (!tools[method]) {
        sendError(id, -32601, `Method not found: ${method}`);
        return;
      }
      tools[method](params, id);
      break;
    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

// ── Shutdown handling ───────────────────────────────────────────────────────

process.on('SIGINT', () => {
  log('Shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Shutting down...');
  process.exit(0);
});
