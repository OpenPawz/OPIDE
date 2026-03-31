#!/usr/bin/env node
// ── Prettier MCP Adapter ─────────────────────────────────────────────────────
// Standalone MCP server that exposes Prettier as tools.
// Speaks Content-Length framed JSON-RPC over stdio — same protocol as
// OpenPawz MCP transport (transport.rs) and our extension host sidecar.
//
// No MCP SDK needed. The protocol is simple JSON-RPC with two methods:
//   - initialize → handshake
//   - tools/list → advertise capabilities
//   - tools/call → execute a tool
//
// Usage: node prettier.mcp.js
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
  process.stderr.write(`[prettier-mcp] ${msg}\n`);
}

// ── Prettier resolution ──────────────────────────────────────────────────────

let prettierModule = null;
let workspacePath = process.env.OPIDE_WORKSPACE || process.cwd();
log(`Workspace: ${workspacePath}`);

// Try to resolve prettier from the workspace, then globally
function resolvePrettier() {
  if (prettierModule) return prettierModule;

  // Try workspace node_modules first
  const paths = [
    path.join(workspacePath, 'node_modules', 'prettier'),
    path.join(workspacePath, 'node_modules', '.pnpm', 'prettier'),
  ];

  // Also try global
  try {
    paths.push(require.resolve('prettier'));
  } catch {}

  for (const p of paths) {
    try {
      prettierModule = require(p);
      log(`Resolved prettier from: ${p}`);
      return prettierModule;
    } catch {}
  }

  log('ERROR: prettier not found. Install it: npm install prettier');
  return null;
}

// ── Parser mapping ───────────────────────────────────────────────────────────

function getParser(language, filePath) {
  // By language ID
  const langMap = {
    javascript: 'babel', javascriptreact: 'babel',
    typescript: 'typescript', typescriptreact: 'typescript',
    css: 'css', scss: 'scss', less: 'less',
    html: 'html', vue: 'vue', svelte: 'svelte',
    json: 'json', jsonc: 'json',
    markdown: 'markdown', mdx: 'mdx',
    yaml: 'yaml', yml: 'yaml',
    graphql: 'graphql',
    xml: 'xml',
  };
  if (language && langMap[language]) return langMap[language];

  // By file extension
  if (filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const extMap = {
      '.js': 'babel', '.jsx': 'babel', '.mjs': 'babel', '.cjs': 'babel',
      '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript',
      '.css': 'css', '.scss': 'scss', '.less': 'less',
      '.html': 'html', '.htm': 'html', '.vue': 'vue', '.svelte': 'svelte',
      '.json': 'json',
      '.md': 'markdown', '.mdx': 'mdx',
      '.yaml': 'yaml', '.yml': 'yaml',
      '.graphql': 'graphql', '.gql': 'graphql',
      '.xml': 'xml', '.svg': 'xml',
    };
    if (extMap[ext]) return extMap[ext];
  }

  return 'babel'; // default
}

// ── MCP Protocol handlers ────────────────────────────────────────────────────

async function handleMessage(msg) {
  const { id, method, params } = msg;

  // ── Initialize handshake ───────────────────────────────────────────
  if (method === 'initialize') {
    // Set workspace path from client info if available
    if (params?.rootUri) {
      workspacePath = params.rootUri.replace('file://', '');
    }

    sendResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'prettier',
        version: '1.0.0',
      },
    });
    return;
  }

  // ── Initialized notification (no response needed) ──────────────────
  if (method === 'notifications/initialized') {
    log('MCP initialized — ready for tool calls');
    resolvePrettier(); // Pre-resolve on connect
    return;
  }

  // ── List available tools ───────────────────────────────────────────
  if (method === 'tools/list') {
    sendResult(id, {
      tools: [
        {
          name: 'format_document',
          description: 'Format file content using Prettier. Supports JavaScript, TypeScript, CSS, HTML, JSON, Markdown, YAML, and more.',
          inputSchema: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: 'The file content to format',
              },
              file_path: {
                type: 'string',
                description: 'File path (used to detect language and resolve config)',
              },
              language: {
                type: 'string',
                description: 'Language ID (javascript, typescript, css, html, json, markdown, etc.)',
              },
            },
            required: ['content'],
          },
        },
        {
          name: 'check_format',
          description: 'Check if a file is already formatted (returns true/false)',
          inputSchema: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'File content to check' },
              file_path: { type: 'string', description: 'File path' },
              language: { type: 'string', description: 'Language ID' },
            },
            required: ['content'],
          },
        },
        {
          name: 'get_supported_languages',
          description: 'List all languages/parsers Prettier supports',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
    return;
  }

  // ── Execute a tool ─────────────────────────────────────────────────
  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};

    try {
      switch (toolName) {
        case 'format_document': {
          const prettier = resolvePrettier();
          if (!prettier) {
            sendResult(id, {
              content: [{ type: 'text', text: 'Error: prettier not found. Run: npm install prettier' }],
              isError: true,
            });
            return;
          }

          const parser = getParser(args.language, args.file_path);
          log(`Formatting: ${args.file_path || 'unknown'} (parser: ${parser})`);

          // Resolve prettier config from the file's directory
          let config = {};
          if (args.file_path) {
            try {
              const resolved = await prettier.resolveConfig(args.file_path);
              if (resolved) config = resolved;
            } catch {}
          }

          const formatted = await prettier.format(args.content, {
            ...config,
            parser,
            filepath: args.file_path,
          });

          const changed = formatted !== args.content;
          log(`Format complete: ${changed ? 'changed' : 'no changes'} (${formatted.length} chars)`);

          sendResult(id, {
            content: [{ type: 'text', text: formatted }],
          });
          return;
        }

        case 'check_format': {
          const prettier = resolvePrettier();
          if (!prettier) {
            sendResult(id, { content: [{ type: 'text', text: 'false' }], isError: true });
            return;
          }
          const parser = getParser(args.language, args.file_path);
          const isFormatted = await prettier.check(args.content, { parser, filepath: args.file_path });
          sendResult(id, {
            content: [{ type: 'text', text: String(isFormatted) }],
          });
          return;
        }

        case 'get_supported_languages': {
          const prettier = resolvePrettier();
          if (!prettier) {
            sendResult(id, { content: [{ type: 'text', text: '[]' }] });
            return;
          }
          const info = await prettier.getSupportInfo();
          const langs = info.languages.map(l => ({
            name: l.name,
            extensions: l.extensions,
            parsers: l.parsers,
          }));
          sendResult(id, {
            content: [{ type: 'text', text: JSON.stringify(langs, null, 2) }],
          });
          return;
        }

        default:
          sendError(id, -32601, `Unknown tool: ${toolName}`);
          return;
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

  // ── Shutdown ───────────────────────────────────────────────────────
  if (method === 'shutdown' || method === 'exit') {
    log('Shutting down');
    process.exit(0);
  }

  // ── Unknown method ─────────────────────────────────────────────────
  if (id) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

// ── Keep alive ───────────────────────────────────────────────────────────────
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
log('Prettier MCP adapter starting on stdio');
