#!/usr/bin/env node
// ms-python.python wraps a Language Server Protocol (LSP) server.
// OPIDE has native LSP support via lsp.rs — no MCP adapter needed.
// The LSP server should be started directly, not through this extension.
//
// To use: install the language server binary and OPIDE will detect it.
process.stderr.write('[lsp-note] This extension wraps an LSP server. Use OPIDE\'s native LSP support instead.\n');
// Still implement MCP protocol so registration doesn't fail
let buffer = '', contentLength = -1;
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    if (contentLength === -1) { const h = buffer.indexOf('\r\n\r\n'); if (h === -1) return; const m = buffer.slice(0, h).match(/Content-Length:\s*(\d+)/i); if (!m) { buffer = buffer.slice(h + 4); continue; } contentLength = parseInt(m[1], 10); buffer = buffer.slice(h + 4); }
    if (Buffer.byteLength(buffer, 'utf-8') < contentLength) return;
    const body = Buffer.from(buffer, 'utf-8').slice(0, contentLength).toString('utf-8');
    buffer = Buffer.from(buffer, 'utf-8').slice(contentLength).toString('utf-8');
    contentLength = -1;
    try {
      const msg = JSON.parse(body);
      if (msg.method === 'initialize') { const j = JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'lsp-note',version:'1.0.0'}}}); process.stdout.write('Content-Length: '+Buffer.byteLength(j)+'\r\n\r\n'+j); }
      if (msg.method === 'tools/list') { const j = JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{tools:[]}}); process.stdout.write('Content-Length: '+Buffer.byteLength(j)+'\r\n\r\n'+j); }
      if (msg.method === 'shutdown') process.exit(0);
    } catch {}
  }
});
