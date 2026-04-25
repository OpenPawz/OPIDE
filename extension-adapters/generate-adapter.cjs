#!/usr/bin/env node
// ── MCP Adapter Generator ────────────────────────────────────────────────────
// Reads an extension's package.json, matches it to a template or generates
// an MCP adapter via AI. Outputs a .mcp.cjs file.
//
// Usage: node generate-adapter.cjs <extension-dir> [--api-key KEY] [--api-url URL] [--model MODEL]
//
// Flow:
//   1. Read package.json from extension directory
//   2. Analyze: what does this extension do? (formatter, linter, LSP, etc.)
//   3. Try template match → output immediately
//   4. If no template: call AI to generate adapter
//   5. Validate: spawn adapter, check tools/list
//   6. Output to stdout (caller saves to file)

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const extDir = args[0];
// B65: prefer env vars (passed by extension-mcp.ts) over argv so the API key
// doesn't appear in the host's process table. argv is kept as a fallback for
// legacy callers and manual CLI use.
const apiKey = process.env.OPIDE_API_KEY || getArg('--api-key') || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const apiUrl = process.env.OPIDE_API_URL || getArg('--api-url') || 'https://api.openai.com/v1/chat/completions';
const model = process.env.OPIDE_MODEL || getArg('--model') || 'gpt-4o-mini';
const workspacePath = process.env.OPIDE_WORKSPACE || getArg('--workspace') || process.cwd();

function getArg(name) {
  const idx = args.indexOf(name);
  return idx > -1 && args[idx + 1] ? args[idx + 1] : null;
}

function log(msg) { process.stderr.write(`[adapter-gen] ${msg}\n`); }

if (!extDir) {
  log('Usage: node generate-adapter.cjs <extension-dir> [--api-key KEY]');
  process.exit(1);
}

// ─── Read extension manifest ─────────────────────────────────────────────────

const manifestPath = path.join(extDir, 'package.json');
if (!fs.existsSync(manifestPath)) {
  log(`No package.json found at ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
const extId = `${manifest.publisher || 'unknown'}.${manifest.name}`;
const commands = (manifest.contributes?.commands || []).map(c => c.command);
const languages = (manifest.contributes?.languages || []).map(l => l.id);
const deps = Object.keys(manifest.dependencies || {});
const activationEvents = manifest.activationEvents || [];

log(`Extension: ${extId} (${manifest.displayName || manifest.name})`);
log(`Commands: ${commands.join(', ') || 'none'}`);
log(`Dependencies: ${deps.join(', ') || 'none'}`);
log(`Languages: ${languages.join(', ') || 'none'}`);

// ─── Template matching ───────────────────────────────────────────────────────

// Known formatter libraries
const FORMATTERS = {
  'prettier': { parser: 'babel', name: 'prettier' },
  'biome': { parser: null, name: '@biomejs/biome' },
  'black': { parser: null, name: 'black' },
};

// Known linter libraries
const LINTERS = {
  'eslint': { name: 'eslint' },
  'stylelint': { name: 'stylelint' },
  'markdownlint': { name: 'markdownlint' },
};

function tryTemplateMatch() {
  // Check if it's a formatter
  for (const [lib, config] of Object.entries(FORMATTERS)) {
    if (deps.includes(lib) || commands.some(c => c.includes('format'))) {
      if (deps.includes(lib) || manifest.name?.includes(lib)) {
        log(`Template match: FORMATTER (${lib})`);
        return generateFormatterAdapter(lib, config);
      }
    }
  }

  // Check if it's a linter
  for (const [lib, config] of Object.entries(LINTERS)) {
    if (deps.includes(lib) || manifest.name?.includes(lib)) {
      log(`Template match: LINTER (${lib})`);
      return generateLinterAdapter(lib, config);
    }
  }

  // Check if it wraps an LSP server
  if (deps.includes('vscode-languageclient') || deps.includes('vscode-languageserver')) {
    log('Template match: LSP WRAPPER — adapter not needed (use lsp.rs directly)');
    return generateLspNoteAdapter();
  }

  log('No template match — will try AI generation');
  return null;
}

// ─── Formatter template ──────────────────────────────────────────────────────

function generateFormatterAdapter(lib, config) {
  return `#!/usr/bin/env node
// Auto-generated MCP adapter for ${extId} (formatter: ${lib})
const path = require('path');
let buffer = '', contentLength = -1;
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    if (contentLength === -1) {
      const h = buffer.indexOf('\\r\\n\\r\\n');
      if (h === -1) return;
      const m = buffer.slice(0, h).match(/Content-Length:\\s*(\\d+)/i);
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
function send(msg) { const j = JSON.stringify(msg); process.stdout.write('Content-Length: ' + Buffer.byteLength(j, 'utf-8') + '\\r\\n\\r\\n' + j); }
function sendResult(id, r) { send({ jsonrpc: '2.0', id, result: r }); }
function sendError(id, c, m) { send({ jsonrpc: '2.0', id, error: { code: c, message: m } }); }
function log(m) { process.stderr.write('[${lib}-mcp] ' + m + '\\n'); }

let lib = null;
const ws = process.env.OPIDE_WORKSPACE || process.cwd();
log('Workspace: ' + ws);

function resolveLib() {
  if (lib) return lib;
  try { lib = require(path.join(ws, 'node_modules', '${lib}')); log('Resolved ${lib}'); return lib; } catch {}
  try { lib = require('${lib}'); log('Resolved ${lib} (global)'); return lib; } catch {}
  log('ERROR: ${lib} not found');
  return null;
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') { sendResult(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: '${lib}', version: '1.0.0' } }); return; }
  if (method === 'notifications/initialized') { resolveLib(); return; }
  if (method === 'tools/list') {
    sendResult(id, { tools: [
      { name: 'format_document', description: 'Format file using ${lib}', inputSchema: { type: 'object', properties: { content: { type: 'string' }, file_path: { type: 'string' }, language: { type: 'string' } }, required: ['content'] } },
    ] });
    return;
  }
  if (method === 'tools/call') {
    const { name, arguments: a } = params || {};
    if (name === 'format_document') {
      const fmt = resolveLib();
      if (!fmt) { sendResult(id, { content: [{ type: 'text', text: 'Error: ${lib} not found' }], isError: true }); return; }
      try {
        const formatted = await fmt.format(a.content, { filepath: a.file_path });
        sendResult(id, { content: [{ type: 'text', text: formatted }] });
      } catch (e) {
        sendResult(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
      }
      return;
    }
    sendError(id, -32601, 'Unknown tool: ' + name);
    return;
  }
  if (method === 'shutdown' || method === 'exit') process.exit(0);
  if (id) sendError(id, -32601, 'Method not found: ' + method);
}
log('${lib} MCP adapter starting');
`;
}

// ─── Linter template ─────────────────────────────────────────────────────────

function generateLinterAdapter(lib, config) {
  return `#!/usr/bin/env node
// Auto-generated MCP adapter for ${extId} (linter: ${lib})
const path = require('path');
let buffer = '', contentLength = -1;
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    if (contentLength === -1) {
      const h = buffer.indexOf('\\r\\n\\r\\n');
      if (h === -1) return;
      const m = buffer.slice(0, h).match(/Content-Length:\\s*(\\d+)/i);
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
function send(msg) { const j = JSON.stringify(msg); process.stdout.write('Content-Length: ' + Buffer.byteLength(j, 'utf-8') + '\\r\\n\\r\\n' + j); }
function sendResult(id, r) { send({ jsonrpc: '2.0', id, result: r }); }
function sendError(id, c, m) { send({ jsonrpc: '2.0', id, error: { code: c, message: m } }); }
function log(m) { process.stderr.write('[${lib}-mcp] ' + m + '\\n'); }

let linter = null;
const ws = process.env.OPIDE_WORKSPACE || process.cwd();

function resolveLib() {
  if (linter) return linter;
  try { linter = require(path.join(ws, 'node_modules', '${lib}')); return linter; } catch {}
  try { linter = require('${lib}'); return linter; } catch {}
  return null;
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') { sendResult(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: '${lib}', version: '1.0.0' } }); return; }
  if (method === 'notifications/initialized') { resolveLib(); return; }
  if (method === 'tools/list') {
    sendResult(id, { tools: [
      { name: 'lint_file', description: 'Lint file using ${lib}', inputSchema: { type: 'object', properties: { content: { type: 'string' }, file_path: { type: 'string' } }, required: ['content', 'file_path'] } },
      { name: 'fix_file', description: 'Auto-fix issues using ${lib}', inputSchema: { type: 'object', properties: { content: { type: 'string' }, file_path: { type: 'string' } }, required: ['content', 'file_path'] } },
    ] });
    return;
  }
  if (method === 'tools/call') {
    const { name, arguments: a } = params || {};
    const mod = resolveLib();
    if (!mod) { sendResult(id, { content: [{ type: 'text', text: 'Error: ${lib} not found' }], isError: true }); return; }
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
log('${lib} MCP adapter starting');
`;
}

// ─── LSP note (no adapter needed) ────────────────────────────────────────────

function generateLspNoteAdapter() {
  return `#!/usr/bin/env node
// ${extId} wraps a Language Server Protocol (LSP) server.
// OPIDE has native LSP support via lsp.rs — no MCP adapter needed.
// The LSP server should be started directly, not through this extension.
//
// To use: install the language server binary and OPIDE will detect it.
process.stderr.write('[lsp-note] This extension wraps an LSP server. Use OPIDE\\'s native LSP support instead.\\n');
// Still implement MCP protocol so registration doesn't fail
let buffer = '', contentLength = -1;
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    if (contentLength === -1) { const h = buffer.indexOf('\\r\\n\\r\\n'); if (h === -1) return; const m = buffer.slice(0, h).match(/Content-Length:\\s*(\\d+)/i); if (!m) { buffer = buffer.slice(h + 4); continue; } contentLength = parseInt(m[1], 10); buffer = buffer.slice(h + 4); }
    if (Buffer.byteLength(buffer, 'utf-8') < contentLength) return;
    const body = Buffer.from(buffer, 'utf-8').slice(0, contentLength).toString('utf-8');
    buffer = Buffer.from(buffer, 'utf-8').slice(contentLength).toString('utf-8');
    contentLength = -1;
    try {
      const msg = JSON.parse(body);
      if (msg.method === 'initialize') { const j = JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'lsp-note',version:'1.0.0'}}}); process.stdout.write('Content-Length: '+Buffer.byteLength(j)+'\\r\\n\\r\\n'+j); }
      if (msg.method === 'tools/list') { const j = JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{tools:[]}}); process.stdout.write('Content-Length: '+Buffer.byteLength(j)+'\\r\\n\\r\\n'+j); }
      if (msg.method === 'shutdown') process.exit(0);
    } catch {}
  }
});
`;
}

// ─── AI generation ───────────────────────────────────────────────────────────

function buildPrompt() {
  return `You are a code generator. Generate a Node.js MCP (Model Context Protocol) server adapter for a VS Code extension.

The adapter must:
1. Use Content-Length framed JSON-RPC over stdin/stdout (no MCP SDK)
2. Implement: initialize, tools/list, tools/call, shutdown
3. Expose the extension's core functionality as MCP tools
4. Resolve the underlying library from the workspace's node_modules/
5. Use process.env.OPIDE_WORKSPACE for the workspace path

Extension manifest:
- ID: ${extId}
- Name: ${manifest.displayName || manifest.name}
- Commands: ${JSON.stringify(commands)}
- Dependencies: ${JSON.stringify(deps)}
- Languages: ${JSON.stringify(languages)}
- Activation: ${JSON.stringify(activationEvents)}

Here is an example adapter (Prettier) for reference:
${fs.readFileSync(path.join(__dirname, 'prettier.mcp.cjs'), 'utf-8').slice(0, 3000)}

Generate ONLY the JavaScript code for the adapter. No markdown, no explanation. The code must be valid CommonJS (require, module.exports). Start with #!/usr/bin/env node`;
}

async function tryOllama() {
  // Check if Ollama is running
  try {
    const check = execSync('curl -s http://localhost:11434/api/tags', { encoding: 'utf-8', timeout: 3000 });
    const tags = JSON.parse(check);
    const models = (tags.models || []).map(m => m.name);
    if (models.length === 0) {
      log('Ollama running but no models pulled');
      return null;
    }

    // Pick the best available model for code generation
    const preferred = ['qwen2.5-coder:7b', 'codellama:7b', 'deepseek-coder:6.7b', 'llama3.1:8b', 'qwen2.5:7b', 'mistral:7b'];
    let useModel = models[0]; // default to first available
    for (const pref of preferred) {
      if (models.some(m => m.startsWith(pref.split(':')[0]))) {
        useModel = models.find(m => m.startsWith(pref.split(':')[0]));
        break;
      }
    }

    log(`Using Ollama model: ${useModel} (${models.length} models available)`);

    const prompt = buildPrompt();
    const body = JSON.stringify({
      model: useModel,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: { temperature: 0, num_predict: 4096 },
    });

    // Write body to temp file to avoid shell escaping issues
    const tmpBody = `/tmp/opide-ollama-req-${Date.now()}.json`;
    fs.writeFileSync(tmpBody, body);

    log('Calling Ollama (this may take 30-60 seconds for a local model)...');
    const result = execSync(
      `curl -sL -X POST http://localhost:11434/api/chat -H "Content-Type: application/json" -d @"${tmpBody}"`,
      { encoding: 'utf-8', timeout: 120000 }
    );
    fs.unlinkSync(tmpBody);

    const response = JSON.parse(result);
    let code = response.message?.content || '';

    // Strip markdown code fences
    code = code.replace(/^```(?:javascript|js|cjs)?\n?/m, '').replace(/\n?```$/m, '').trim();

    if (!code.includes('tools/list') || !code.includes('tools/call')) {
      log('Ollama output missing required MCP methods — discarding');
      return null;
    }

    log(`Ollama generated ${code.length} chars of adapter code`);
    return code;
  } catch (e) {
    log(`Ollama not available: ${e.message?.slice(0, 100)}`);
    return null;
  }
}

async function generateWithAI() {
  // Try cloud API first (fast, ~3-5 seconds)
  if (apiKey) {
    log(`Trying cloud AI (${model})...`);
    const cloudResult = await tryCloudApi();
    if (cloudResult) return cloudResult;
    log('Cloud API failed, falling back to Ollama...');
  }

  // Fall back to Ollama (free, local, ~30-60 seconds)
  const ollamaResult = await tryOllama();
  if (ollamaResult) return ollamaResult;

  if (!apiKey) {
    log('No API key and Ollama not available. Cannot generate adapter.');
  }
  return null;
}

async function tryCloudApi() {
  log(`Generating adapter via cloud AI (${model})...`);

  const prompt = buildPrompt();

  try {
    const isAnthropic = apiUrl.includes('anthropic') || apiKey.startsWith('sk-ant-');

    let body, headers;
    if (isAnthropic) {
      headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
      body = JSON.stringify({
        model: model.includes('claude') ? model : 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });
    } else {
      headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
      const isKimi = apiUrl.includes('kimi') || apiUrl.includes('moonshot') || model.includes('kimi') || model.includes('moonshot');
      body = JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
        // Kimi/Moonshot only accepts temperature=1
        ...(isKimi ? {} : { temperature: 0 }),
      });
    }

    // Write body to temp file to avoid shell escaping issues
    const tmpBody = `/tmp/opide-cloud-req-${Date.now()}.json`;
    fs.writeFileSync(tmpBody, body);

    const headerArgs = Object.entries(headers).map(([k, v]) => `-H "${k}: ${v}"`).join(' ');
    const url = isAnthropic ? 'https://api.anthropic.com/v1/messages' : apiUrl;
    const cmd = `curl -sL ${headerArgs} -d @"${tmpBody}" "${url}"`;

    const result = execSync(cmd, { encoding: 'utf-8', timeout: 60000 });
    try { fs.unlinkSync(tmpBody); } catch {}
    const response = JSON.parse(result);

    let code;
    if (isAnthropic) {
      code = response.content?.[0]?.text || '';
    } else {
      code = response.choices?.[0]?.message?.content || '';
    }

    // Strip markdown code fences if present
    code = code.replace(/^```(?:javascript|js|cjs)?\n?/m, '').replace(/\n?```$/m, '').trim();

    if (!code.includes('tools/list') || !code.includes('tools/call')) {
      log('AI output does not contain required MCP methods');
      return null;
    }

    log(`AI generated ${code.length} chars of adapter code`);
    return code;
  } catch (e) {
    log(`AI generation failed: ${e.message}`);
    return null;
  }
}

// ─── Validate adapter ────────────────────────────────────────────────────────

function validateAdapter(code) {
  const tmpFile = `/tmp/opide-adapter-validate-${Date.now()}.cjs`;
  fs.writeFileSync(tmpFile, code);

  try {
    const child = spawn('node', [tmpFile], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OPIDE_WORKSPACE: workspacePath },
    });

    return new Promise((resolve) => {
      let stdout = '';
      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => { /* ignore stderr during validation */ });

      // Send initialize
      const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(init)}\r\n\r\n${init}`);

      // Send tools/list after short delay
      setTimeout(() => {
        const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        child.stdin.write(`Content-Length: ${Buffer.byteLength(list)}\r\n\r\n${list}`);
      }, 500);

      // Check result after 2 seconds
      setTimeout(() => {
        child.kill();
        fs.unlinkSync(tmpFile);
        const valid = stdout.includes('"tools"') && stdout.includes('"result"');
        log(`Validation: ${valid ? 'PASSED' : 'FAILED'}`);
        resolve(valid);
      }, 2000);
    });
  } catch (e) {
    log(`Validation error: ${e.message}`);
    try { fs.unlinkSync(tmpFile); } catch {}
    return false;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

// ─── Post-generation fixup ───────────────────────────────────────────────────
// AI-generated code often gets the MCP protocol details slightly wrong.
// Fix known issues automatically.

function fixupAdapter(code) {
  // Fix 1: initialize must return protocolVersion
  if (code.includes("'initialize'") && !code.includes('protocolVersion')) {
    log('Fixup: adding protocolVersion to initialize response');
    code = code.replace(
      /sendResult\s*\(\s*id\s*,\s*\{\s*\}\s*\)/g,
      "sendResult(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: '" + extId + "', version: '1.0.0' } })"
    );
  }

  // Fix 2: tools/list must return { tools: [...] } not just keys
  if (code.includes("'tools/list'") && code.includes('Object.keys(tools)')) {
    log('Fixup: fixing tools/list response format');
    code = code.replace(
      /sendResult\s*\(\s*id\s*,\s*Object\.keys\(tools\)\s*\)/g,
      "sendResult(id, { tools: Object.keys(tools).map(name => ({ name, description: name, inputSchema: { type: 'object', properties: { content: { type: 'string' }, file_path: { type: 'string' } } } })) })"
    );
  }

  // Fix 3: Ensure protocolVersion exists somewhere in initialize
  if (!code.includes('protocolVersion') && code.includes('initialize')) {
    log('Fixup: injecting protocolVersion into initialize handler');
    code = code.replace(
      /(case\s+['"]initialize['"].*?sendResult\s*\(\s*id\s*,\s*)\{/,
      "$1{ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: '" + extId + "', version: '1.0.0' },"
    );
  }

  return code;
}

async function main() {
  // Step 1: Try template match
  let code = tryTemplateMatch();

  // Step 2: Try AI generation
  if (!code) {
    code = await generateWithAI();
  }

  if (!code) {
    log('Could not generate adapter. Extension installed but no adapter available.');
    process.exit(1);
  }

  // Step 2.5: Apply fixups for common AI mistakes
  code = fixupAdapter(code);

  // Step 3: Validate
  const valid = await validateAdapter(code);
  if (!valid) {
    log('Generated adapter failed validation. Outputting anyway for manual review.');
  }

  // Step 4: Output to stdout
  process.stdout.write(code);
  log('Adapter generated successfully');
}

main().catch(e => {
  log(`Fatal: ${e.message}`);
  process.exit(1);
});
