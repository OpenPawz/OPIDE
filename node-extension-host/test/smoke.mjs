// Extension host smoke test — protects the "run real VS Code extensions
// outside VS Code" core from regressions.
//
// Spawns the REAL dist/bootstrap.js against a throwaway extensions dir
// containing a fixture extension, speaks the actual Content-Length framed
// JSON-RPC protocol over stdio, and asserts the full lifecycle:
//
//   1. scan finds the fixture
//   2. activate() runs (Node entry point, require('vscode') shim)
//   3. contributed command + webview view are reported in extensionHost/ready
//   4. webviewView/resolve round-trips: the provider attaches and the host
//      sends webviewView/setHtml with the fixture's HTML
//   5. calling a stubbed vscode API does NOT crash activation (auto-stub net)
//
// Zero dependencies. Run: npm test  (builds dist first via pretest).

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BOOTSTRAP = join(HERE, '..', 'dist', 'bootstrap.js')
const TIMEOUT_MS = 20_000

// ── Fixture extension ──────────────────────────────────────────────────
const EXT_ID = 'opide-test.smoke-fixture'
const FIXTURE_MANIFEST = {
  name: 'smoke-fixture',
  publisher: 'opide-test',
  displayName: 'OPIDE Smoke Fixture',
  version: '0.0.1',
  engines: { vscode: '^1.90.0' },
  main: './extension.js',
  activationEvents: ['onStartupFinished'],
  contributes: {
    commands: [{ command: 'smokeFixture.hello', title: 'Smoke: Hello' }],
    viewsContainers: {
      activitybar: [{ id: 'smoke-sidebar', title: 'Smoke', icon: 'icon.svg' }],
    },
    views: {
      'smoke-sidebar': [{ type: 'webview', id: 'smokeFixtureView', name: 'Smoke View' }],
    },
  },
}
const FIXTURE_CODE = `
const vscode = require('vscode');
function activate(context) {
  // 1. Normal API surface
  context.subscriptions.push(
    vscode.commands.registerCommand('smokeFixture.hello', () => 'hello'),
  );
  // 2. Webview provider — the exact path Claude Code's panel uses
  vscode.window.registerWebviewViewProvider('smokeFixtureView', {
    resolveWebviewView(view) {
      view.webview.html = '<html><body>SMOKE_OK</body></html>';
    },
  });
  // 3. Deliberately poke APIs the shim does NOT implement. The auto-stub
  //    safety net must absorb these as no-ops instead of crashing activation.
  try { vscode.tasks.registerTaskProvider('smoke', {}); } catch (e) { /* must not throw, but tolerate */ }
  try { vscode.notebooks?.createNotebookController?.('smoke', 'smoke', 'Smoke'); } catch (e) { /* ditto */ }
}
module.exports = { activate, deactivate() {} };
`

// ── Framed JSON-RPC plumbing (mirrors ipc-bridge.ts) ───────────────────
function frame(obj) {
  const json = JSON.stringify(obj)
  return `Content-Length: ${Buffer.byteLength(json, 'utf-8')}\r\n\r\n${json}`
}

function makeParser(onMessage) {
  let buf = Buffer.alloc(0)
  return (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      const headerEnd = buf.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = buf.slice(0, headerEnd).toString('utf-8')
      const m = header.match(/Content-Length:\s*(\d+)/i)
      if (!m) { buf = buf.slice(headerEnd + 4); continue }
      const len = parseInt(m[1], 10)
      const start = headerEnd + 4
      if (buf.length < start + len) return
      const body = buf.slice(start, start + len).toString('utf-8')
      buf = buf.slice(start + len)
      try { onMessage(JSON.parse(body)) } catch { /* skip malformed */ }
    }
  }
}

// ── Test run ───────────────────────────────────────────────────────────
const extRoot = mkdtempSync(join(tmpdir(), 'opide-smoke-ext-'))
const wsRoot = mkdtempSync(join(tmpdir(), 'opide-smoke-ws-'))
const extDir = join(extRoot, EXT_ID)
mkdirSync(extDir, { recursive: true })
writeFileSync(join(extDir, 'package.json'), JSON.stringify(FIXTURE_MANIFEST, null, 2))
writeFileSync(join(extDir, 'extension.js'), FIXTURE_CODE)

const child = spawn(process.execPath, [BOOTSTRAP, '--extensions-path', extRoot, '--workspace-path', wsRoot], {
  stdio: ['pipe', 'pipe', 'pipe'],
})

const stderrLines = []
child.stderr.on('data', (d) => stderrLines.push(d.toString()))

const failures = []
const passes = []
function pass(name) { passes.push(name); console.log(`  ok - ${name}`) }
function fail(name, detail) { failures.push(name); console.error(`  FAIL - ${name}${detail ? `: ${detail}` : ''}`) }

let readyParams = null
let setHtmlSeen = null
let done = false

function finish(code) {
  if (done) return
  done = true
  try { child.kill('SIGKILL') } catch { /* already dead */ }
  rmSync(extRoot, { recursive: true, force: true })
  rmSync(wsRoot, { recursive: true, force: true })
  console.log(`\n${passes.length} passed, ${failures.length} failed`)
  if (failures.length && stderrLines.length) {
    console.error('\n--- sidecar stderr (tail) ---')
    console.error(stderrLines.join('').split('\n').slice(-25).join('\n'))
  }
  process.exit(code)
}

const timer = setTimeout(() => {
  fail('completed within timeout', `no ${readyParams ? 'setHtml' : 'ready'} after ${TIMEOUT_MS}ms`)
  finish(1)
}, TIMEOUT_MS)

child.on('exit', (code) => {
  if (!done) {
    fail('host stays alive', `exited early with code ${code}`)
    finish(1)
  }
})

child.stdout.on('data', makeParser((msg) => {
  if (msg.method === 'extensionHost/ready') {
    readyParams = msg.params
    const ext = (readyParams.extensions || []).find((e) => e.id === EXT_ID)

    if (ext) pass('scan finds fixture extension')
    else fail('scan finds fixture extension', JSON.stringify(readyParams.extensions?.map((e) => e.id)))

    if ((readyParams.activated || []).includes(EXT_ID)) pass('fixture activates (Node entry + vscode shim + stub survival)')
    else fail('fixture activates', `activated=${JSON.stringify(readyParams.activated)}`)

    if (ext?.commands?.includes('smokeFixture.hello')) pass('contributed command reported')
    else fail('contributed command reported', JSON.stringify(ext?.commands))

    const view = (ext?.contributedViews || []).find((v) => v.id === 'smokeFixtureView')
    if (view?.type === 'webview') pass('contributed webview view reported')
    else fail('contributed webview view reported', JSON.stringify(ext?.contributedViews))

    // Phase 2: resolve the webview like the workbench would and expect setHtml
    // back. NOTE: sent as a NOTIFICATION (no id) — the shim only routes
    // `msg.method && !msg.id` to its notification handler; id-carrying
    // unknown methods are silently dropped.
    child.stdin.write(frame({
      jsonrpc: '2.0', method: 'webviewView/resolve', params: { viewId: 'smokeFixtureView' },
    }))
    return
  }
  if (msg.method === 'webviewView/setHtml' && msg.params?.viewId === 'smokeFixtureView') {
    setHtmlSeen = msg.params.html || ''
    if (setHtmlSeen.includes('SMOKE_OK')) pass('webviewView resolve → setHtml round-trip')
    else fail('webviewView resolve → setHtml round-trip', `html=${setHtmlSeen.slice(0, 80)}`)
    clearTimeout(timer)
    finish(failures.length ? 1 : 0)
  }
}))

console.log('# OPIDE extension host smoke test')
