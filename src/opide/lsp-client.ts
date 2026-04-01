/**
 * OPIDE LSP Client
 *
 * Bridges between the VS Code editor (via @codingame/monaco-vscode-api) and
 * the Rust LSP process manager (via Tauri IPC).
 *
 * Flow:
 *   1. Frontend detects a file opened → calls lsp_start for that language
 *   2. Frontend sends LSP initialize + textDocument/didOpen via lsp_send
 *   3. Rust reads language server responses → emits lsp-message events
 *   4. Frontend processes responses (diagnostics, completions, hover, etc.)
 *
 * The @codingame/monaco-vscode-api already includes VS Code's full LSP client
 * infrastructure through the language features default extensions. This module
 * provides the transport layer to connect it to our Rust-managed servers.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

// ─── Types ───────────────────────────────────────────────────────────────────

interface LspStartResult {
  server_id: string
  language: string
}

interface LspMessageEvent {
  server_id: string
  message: string
}

interface LspServerState {
  serverId: string
  language: string
  workspacePath: string
  requestId: number
  pendingRequests: Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>
  initialized: boolean
}

// ─── Active Servers ──────────────────────────────────────────────────────────

const servers = new Map<string, LspServerState>()
let unlisten: UnlistenFn | null = null

// ─── Event Listener ──────────────────────────────────────────────────────────

async function ensureListening(): Promise<void> {
  if (unlisten) return

  unlisten = await listen<LspMessageEvent>('lsp-message', ({ payload }) => {
    const server = Array.from(servers.values()).find(
      (s) => s.serverId === payload.server_id,
    )
    if (!server) return

    try {
      const msg = JSON.parse(payload.message)
      handleLspMessage(server, msg)
    } catch (e) {
      console.warn('[opide-lsp] failed to parse message:', e)
    }
  })
}

// ─── Message Handler ─────────────────────────────────────────────────────────

function handleLspMessage(server: LspServerState, msg: any): void {
  // Response to a request we sent
  if ('id' in msg && server.pendingRequests.has(msg.id)) {
    const pending = server.pendingRequests.get(msg.id)!
    server.pendingRequests.delete(msg.id)
    if (msg.error) {
      pending.reject(msg.error)
    } else {
      pending.resolve(msg.result)
    }
    return
  }

  // Server notification (no id)
  if (msg.method) {
    handleNotification(server, msg.method, msg.params)
  }
}

function handleNotification(server: LspServerState, method: string, params: any): void {
  switch (method) {
    case 'textDocument/publishDiagnostics':
      console.log(`[opide-lsp:${server.language}] diagnostics for ${params?.uri}: ${params?.diagnostics?.length ?? 0} issues`)
      publishDiagnosticsToMonaco(params)
      break

    case 'window/logMessage':
    case 'window/showMessage':
      console.log(`[opide-lsp:${server.language}] ${params?.message}`)
      break

    default:
      console.debug(`[opide-lsp:${server.language}] notification: ${method}`)
  }
}

// ─── Diagnostics → Monaco Markers ──────────────────────────────────────────

/** LSP DiagnosticSeverity → Monaco MarkerSeverity */
function lspSeverityToMonaco(severity: number | undefined): number {
  // LSP: 1=Error, 2=Warning, 3=Information, 4=Hint
  // Monaco MarkerSeverity: 1=Hint, 2=Info, 4=Warning, 8=Error
  switch (severity) {
    case 1: return 8  // Error
    case 2: return 4  // Warning
    case 3: return 2  // Info
    case 4: return 1  // Hint
    default: return 2 // Info
  }
}

/**
 * Forward LSP publishDiagnostics to Monaco's marker system so errors/warnings
 * show as squiggly underlines in the editor.
 */
async function publishDiagnosticsToMonaco(params: any): Promise<void> {
  if (!params?.uri) return
  try {
    const monaco = await import('monaco-editor')
    const uri = monaco.Uri.parse(params.uri)
    const model = monaco.editor.getModel(uri)
    if (!model) {
      console.debug('[opide-lsp] no model for URI, skipping diagnostics:', params.uri)
      return
    }

    const markers = (params.diagnostics ?? []).map((d: any) => ({
      severity: lspSeverityToMonaco(d.severity),
      message: d.message || 'Unknown issue',
      source: d.source || 'lsp',
      code: typeof d.code === 'object' ? d.code?.value?.toString() : d.code?.toString(),
      startLineNumber: (d.range?.start?.line ?? 0) + 1,
      startColumn: (d.range?.start?.character ?? 0) + 1,
      endLineNumber: (d.range?.end?.line ?? 0) + 1,
      endColumn: (d.range?.end?.character ?? 0) + 1,
      relatedInformation: d.relatedInformation?.map((ri: any) => ({
        resource: monaco.Uri.parse(ri.location?.uri ?? ''),
        message: ri.message ?? '',
        startLineNumber: (ri.location?.range?.start?.line ?? 0) + 1,
        startColumn: (ri.location?.range?.start?.character ?? 0) + 1,
        endLineNumber: (ri.location?.range?.end?.line ?? 0) + 1,
        endColumn: (ri.location?.range?.end?.character ?? 0) + 1,
      })),
    }))

    monaco.editor.setModelMarkers(model, 'lsp', markers)
    console.debug(`[opide-lsp] set ${markers.length} markers on ${params.uri}`)
  } catch (e) {
    console.warn('[opide-lsp] failed to publish diagnostics to Monaco:', e)
  }
}

// ─── Send Request / Notification ─────────────────────────────────────────────

async function sendRequest(server: LspServerState, method: string, params: any): Promise<any> {
  const id = ++server.requestId
  const message = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params,
  })

  return new Promise((resolve, reject) => {
    server.pendingRequests.set(id, { resolve, reject })
    invoke('lsp_send', { serverId: server.serverId, message }).catch(reject)
  })
}

async function sendNotification(server: LspServerState, method: string, params: any): Promise<void> {
  const message = JSON.stringify({
    jsonrpc: '2.0',
    method,
    params,
  })
  await invoke('lsp_send', { serverId: server.serverId, message })
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Start a language server for the given language and workspace.
 * Sends the LSP initialize handshake automatically.
 */
export async function startLanguageServer(
  language: string,
  workspacePath: string,
): Promise<string> {
  await ensureListening()

  // Don't start duplicate servers for the same language + workspace
  const existing = Array.from(servers.values()).find(
    (s) => s.language === language && s.workspacePath === workspacePath,
  )
  if (existing) return existing.serverId

  // Start the server via Rust
  const result = await invoke<LspStartResult>('lsp_start', {
    request: { language, workspace_path: workspacePath },
  })

  const server: LspServerState = {
    serverId: result.server_id,
    language,
    workspacePath,
    requestId: 0,
    pendingRequests: new Map(),
    initialized: false,
  }

  servers.set(result.server_id, server)

  // Send LSP initialize
  const initResult = await sendRequest(server, 'initialize', {
    processId: null,
    capabilities: {
      textDocument: {
        synchronization: {
          dynamicRegistration: false,
          willSave: false,
          willSaveWaitUntil: false,
          didSave: true,
        },
        completion: {
          dynamicRegistration: false,
          completionItem: {
            snippetSupport: true,
            commitCharactersSupport: true,
            documentationFormat: ['markdown', 'plaintext'],
            resolveSupport: { properties: ['documentation', 'detail'] },
          },
        },
        hover: {
          dynamicRegistration: false,
          contentFormat: ['markdown', 'plaintext'],
        },
        definition: { dynamicRegistration: false },
        references: { dynamicRegistration: false },
        documentSymbol: { dynamicRegistration: false },
        publishDiagnostics: {
          relatedInformation: true,
          versionSupport: true,
          codeDescriptionSupport: true,
        },
      },
      workspace: {
        workspaceFolders: true,
      },
    },
    rootUri: `file://${workspacePath}`,
    workspaceFolders: [
      {
        uri: `file://${workspacePath}`,
        name: workspacePath.split('/').pop() || 'workspace',
      },
    ],
  })

  // Send initialized notification
  await sendNotification(server, 'initialized', {})
  server.initialized = true

  console.log(`[opide-lsp] ${language} server initialized:`, initResult?.capabilities ? 'OK' : 'no capabilities')
  return result.server_id
}

/**
 * Notify the language server that a file was opened.
 */
export async function didOpenFile(
  serverId: string,
  uri: string,
  languageId: string,
  version: number,
  text: string,
): Promise<void> {
  const server = servers.get(serverId)
  if (!server) return

  await sendNotification(server, 'textDocument/didOpen', {
    textDocument: {
      uri,
      languageId,
      version,
      text,
    },
  })
}

/**
 * Notify the language server that a file changed.
 */
export async function didChangeFile(
  serverId: string,
  uri: string,
  version: number,
  text: string,
): Promise<void> {
  const server = servers.get(serverId)
  if (!server) return

  await sendNotification(server, 'textDocument/didChange', {
    textDocument: { uri, version },
    contentChanges: [{ text }],
  })
}

/**
 * Request completions at a position.
 */
export async function getCompletions(
  serverId: string,
  uri: string,
  line: number,
  character: number,
): Promise<any> {
  const server = servers.get(serverId)
  if (!server) return null

  return sendRequest(server, 'textDocument/completion', {
    textDocument: { uri },
    position: { line, character },
  })
}

/**
 * Request hover info at a position.
 */
export async function getHover(
  serverId: string,
  uri: string,
  line: number,
  character: number,
): Promise<any> {
  const server = servers.get(serverId)
  if (!server) return null

  return sendRequest(server, 'textDocument/hover', {
    textDocument: { uri },
    position: { line, character },
  })
}

/**
 * Request go-to-definition at a position.
 */
export async function getDefinition(
  serverId: string,
  uri: string,
  line: number,
  character: number,
): Promise<any> {
  const server = servers.get(serverId)
  if (!server) return null

  return sendRequest(server, 'textDocument/definition', {
    textDocument: { uri },
    position: { line, character },
  })
}

/**
 * Stop a language server.
 */
export async function stopLanguageServer(serverId: string): Promise<void> {
  servers.delete(serverId)
  await invoke('lsp_stop', { serverId })
}

/**
 * Stop all language servers.
 */
export async function stopAllLanguageServers(): Promise<void> {
  for (const [id] of servers) {
    await invoke('lsp_stop', { serverId: id }).catch(() => {})
  }
  servers.clear()
}
