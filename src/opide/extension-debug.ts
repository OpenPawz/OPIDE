// OPIDE Extension Debug — Phase D
//
// Bridges vscode.debug calls onto OPIDE's existing dap.rs infrastructure.
// dap.rs already manages adapter spawning + Content-Length framed DAP
// transport; we add the session lifecycle and customRequest plumbing
// extensions need.
//
// v1 behaviour
//   - resolveLaunchConfig: read .vscode/launch.json from the workspace
//     and return the matching configuration by name. Without launch.json
//     this returns null (extensions can still pass an inline config).
//   - startSession: spawn the matching adapter via dap_start. Forward
//     subsequent messages with dap_send. Listen for dap-message events
//     and emit lightweight session events to the sidecar.
//   - stopSession / customRequest: thin wrappers over dap.rs.
//
// What's NOT in v1:
//   - Reverse-direction protocol parsing (we don't translate every DAP
//     event into vscode.debug.onDidReceiveDebugSessionCustomEvent).
//     Adapters that use customEvent will reach extensions in raw form
//     for now; richer translation is v2.
//   - Inline implementation adapters (DebugAdapterInlineImplementation)
//     would let an extension provide its own JS adapter; deferred.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getWorkspace } from './ide-context.ts'
import { notifyDebugActivation } from './extension-bridge.ts'

interface SessionRecord {
  sessionId: string
  adapterId: string
  type: string
  unlisten?: UnlistenFn
  pendingResponses: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>
  nextSeq: number
}

const _sessions = new Map<string, SessionRecord>()
let _sessionCounter = 1

export async function resolveLaunchConfig(name: string): Promise<any | null> {
  // Read .vscode/launch.json. This is best-effort; if no workspace or
  // file we return null so the extension can pass an inline config.
  try {
    const ws = getWorkspace()
    if (!ws) return null
    const path = `${ws}/.vscode/launch.json`
    const result = await invoke<any>('ide_read_file', { path }).catch(() => null)
    if (!result?.content) return null
    // Strip JSONC comments before parsing
    const cleaned = result.content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const parsed = JSON.parse(cleaned)
    const configs: any[] = parsed?.configurations || []
    return configs.find((c) => c?.name === name) || null
  } catch {
    return null
  }
}

export async function startSession(
  config: any,
  descriptor: any,
  onEvent: (event: any) => void,
): Promise<{ sessionId: string } | null> {
  if (!config?.type) return null
  // CC1: trigger onDebug + onDebugResolve:<type> activation in the
  // sidecar before we ask for the adapter descriptor. This gives
  // debugger-providing extensions a chance to register their factory.
  notifyDebugActivation(config.type)
  const sessionId = `dbg-${_sessionCounter++}`

  // Decide adapter spawn args. Prefer the descriptor the extension
  // provided (its DebugAdapterExecutable / Server / Pipe); otherwise
  // fall back to the type → preset mapping in dap.rs.
  let adapterType = config.type
  let adapterPath: string | undefined
  if (descriptor?.kind === 'executable' && descriptor.command) {
    adapterPath = descriptor.command
  }

  const start = await invoke<any>('dap_start', {
    request: {
      adapter_type: adapterType,
      cwd: config.cwd,
      adapter_path: adapterPath,
    },
  }).catch((e) => {
    console.warn('[ext-debug] dap_start failed:', e)
    return null
  })
  if (!start?.adapter_id) return null

  const rec: SessionRecord = {
    sessionId,
    adapterId: start.adapter_id,
    type: adapterType,
    pendingResponses: new Map(),
    nextSeq: 1,
  }
  _sessions.set(sessionId, rec)

  // Listen for messages from the adapter and forward selected events
  // to the sidecar so the extension can subscribe via vscode.debug.
  rec.unlisten = await listen<any>('dap-message', (e) => {
    const payload: any = e.payload || {}
    if (payload?.adapter_id !== rec.adapterId) return
    let msg: any
    try { msg = JSON.parse(payload.message) } catch { return }
    if (msg.type === 'event') {
      onEvent({
        kind: 'customEvent',
        sessionId,
        body: msg.body,
        event: msg.event,
      })
    } else if (msg.type === 'response') {
      const pending = rec.pendingResponses.get(msg.request_seq)
      if (pending) {
        rec.pendingResponses.delete(msg.request_seq)
        if (msg.success) pending.resolve(msg.body)
        else pending.reject(new Error(msg.message || 'DAP request failed'))
      }
    }
  })

  // Send 'initialize' + 'launch' (or 'attach') automatically. Most
  // extensions expect VS Code to drive this; we mimic the behaviour.
  await sendDap(rec, 'initialize', {
    clientID: 'opide',
    clientName: 'OPIDE',
    adapterID: adapterType,
    locale: 'en',
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: 'path',
    supportsVariableType: true,
    supportsRunInTerminalRequest: true,
  }).catch(() => {})
  const launchOrAttach = config?.request === 'attach' ? 'attach' : 'launch'
  await sendDap(rec, launchOrAttach, config).catch((e) => {
    console.warn(`[ext-debug] ${launchOrAttach} failed:`, e)
  })

  return { sessionId }
}

async function sendDap(rec: SessionRecord, command: string, args: any): Promise<any> {
  const seq = rec.nextSeq++
  const msg = JSON.stringify({ seq, type: 'request', command, arguments: args })
  await invoke('dap_send', {
    adapter_id: rec.adapterId,
    message: msg,
  })
  return new Promise((resolve, reject) => {
    rec.pendingResponses.set(seq, { resolve, reject })
    setTimeout(() => {
      if (rec.pendingResponses.has(seq)) {
        rec.pendingResponses.delete(seq)
        reject(new Error(`DAP timeout: ${command}`))
      }
    }, 30_000)
  })
}

export async function stopSession(sessionId: string): Promise<void> {
  const rec = _sessions.get(sessionId)
  if (!rec) return
  try { await sendDap(rec, 'disconnect', { restart: false, terminateDebuggee: true }) } catch { /* ignore */ }
  try { rec.unlisten?.() } catch { /* ignore */ }
  await invoke('dap_stop', { adapter_id: rec.adapterId }).catch(() => {})
  _sessions.delete(sessionId)
}

export async function customRequest(
  sessionId: string,
  command: string,
  args: any,
): Promise<any> {
  const rec = _sessions.get(sessionId)
  if (!rec) return null
  return sendDap(rec, command, args || {})
}
