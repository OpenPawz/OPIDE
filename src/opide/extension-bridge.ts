// OPIDE Extension Bridge — connects the VS Code workbench to the Node.js
// extension host sidecar via Tauri IPC.
//
// Message flow:
//   Extension registers command → API shim sends JSON-RPC → stdout
//   → Rust reads, emits 'ext-host-message' Tauri event
//   → This bridge receives it, routes to the right workbench service
//   → Result flows back: bridge → ext_host_send → stdin → API shim → extension
//
// Also handles:
//   - Starting/stopping the sidecar on workspace open/close
//   - Forwarding editor events TO the sidecar (file open, change, save)
//   - Receiving commands/diagnostics FROM the sidecar

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

// ─── Debug logging (visible in Rust terminal) ───────────────────────────────
// Debug logging — console only, no IPC. The Rust-side IPC call on every message
// was a major performance drain (fires on every extension host message).
function debugLog(msg: string): void {
  console.log(`[ext-bridge] ${msg}`)
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface ExtHostMessageEvent {
  message: string
}

interface ExtHostStatusEvent {
  status: string
  detail: string
}

interface ExtensionInfo {
  id: string
  name: string
  version: string
  hasMain: boolean
  activationEvents: string[]
  commands: string[]
}

interface ReadyParams {
  extensions: ExtensionInfo[]
  activated: string[]
}

type StatusCallback = (status: string, detail: string) => void
type ExtensionsReadyCallback = (extensions: ExtensionInfo[]) => void

// ─── Bridge ──────────────────────────────────────────────────────────────────

let _running = false
let _unlistenMessage: UnlistenFn | null = null
let _unlistenStatus: UnlistenFn | null = null
let _extensions: ExtensionInfo[] = []
let _activatedIds: string[] = []
let _statusListeners: StatusCallback[] = []
let _readyListeners: ExtensionsReadyCallback[] = []
let _nextRequestId = 1
const _pendingRequests = new Map<
  number,
  { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>()

// Registered extension commands (from sidecar → can be invoked from workbench)
const _extensionCommands = new Set<string>()

// ─── Public API ──────────────────────────────────────────────────────────────

/** Start the extension host sidecar for the given workspace. */
export async function startExtensionHost(
  workspacePath: string,
  extensionsPath?: string,
): Promise<void> {
  if (_running) {
    console.warn('[ext-bridge] Extension host already running')
    return
  }

  const extPath =
    extensionsPath ||
    `${(globalThis as any).process?.env?.HOME || '/tmp'}/.opide/extensions`

  debugLog(`startExtensionHost called: ws=${workspacePath} ext=${extPath}`)

  // Listen for messages from the sidecar BEFORE starting it
  _unlistenMessage = await listen<ExtHostMessageEvent>('ext-host-message', (event) => {
    debugLog(`ext-host-message received: ${event.payload.message.slice(0, 120)}...`)
    handleSidecarMessage(event.payload.message)
  })

  debugLog('ext-host-message listener registered')

  _unlistenStatus = await listen<ExtHostStatusEvent>('ext-host-status', (event) => {
    const { status, detail } = event.payload
    debugLog(`ext-host-status: ${status} — ${detail}`)
    for (const cb of _statusListeners) {
      cb(status, detail)
    }

    // Auto-restart on crash (with backoff)
    if (status === 'crashed') {
      console.warn('[ext-bridge] Extension host crashed — will restart in 3s')
      _running = false
      setTimeout(() => {
        startExtensionHost(workspacePath, extensionsPath).catch((e) =>
          console.error('[ext-bridge] Restart failed:', e),
        )
      }, 3000)
    }
  })

  // Start the sidecar
  await invoke('ext_host_start', {
    request: {
      extensions_path: extPath,
      workspace_path: workspacePath,
    },
  })

  _running = true
  debugLog('Extension host started, waiting for ready message...')
}

/** Stop the extension host sidecar. */
export async function stopExtensionHost(): Promise<void> {
  if (!_running) return

  await invoke('ext_host_stop').catch(() => {})
  _running = false

  if (_unlistenMessage) {
    _unlistenMessage()
    _unlistenMessage = null
  }
  if (_unlistenStatus) {
    _unlistenStatus()
    _unlistenStatus = null
  }

  _extensions = []
  _activatedIds = []
  _extensionCommands.clear()
  _pendingRequests.clear()

  console.log('[ext-bridge] Extension host stopped')
}

/** Check if the extension host is running. */
export function isExtensionHostRunning(): boolean {
  return _running
}

/** Get the list of loaded extensions. */
export function getLoadedExtensions(): ExtensionInfo[] {
  return _extensions
}

/** Get the list of activated extension IDs. */
export function getActivatedExtensions(): string[] {
  return _activatedIds
}

/** Get all commands registered by extensions. */
export function getExtensionCommands(): string[] {
  return [..._extensionCommands]
}

/** Register a callback for status changes. */
export function onExtensionHostStatus(callback: StatusCallback): () => void {
  _statusListeners.push(callback)
  return () => {
    _statusListeners = _statusListeners.filter((cb) => cb !== callback)
  }
}

/** Register a callback for when extensions are ready. */
export function onExtensionsReady(callback: ExtensionsReadyCallback): () => void {
  _readyListeners.push(callback)
  // If already ready, fire immediately
  if (_extensions.length > 0) {
    callback(_extensions)
  }
  return () => {
    _readyListeners = _readyListeners.filter((cb) => cb !== callback)
  }
}

/** Execute a command registered by an extension. */
export async function executeExtensionCommand(command: string, ...args: any[]): Promise<any> {
  if (!_running) throw new Error('Extension host not running')
  return sendRequest('commands/execute', { command, args })
}

/** Activate a specific extension by ID. */
export async function activateExtension(extensionId: string): Promise<void> {
  if (!_running) throw new Error('Extension host not running')
  await sendRequest('extension/activate', { extensionId })
}

// ─── Notifications TO sidecar (editor events) ───────────────────────────────

/** Notify the sidecar that a file was opened. */
export function notifyFileOpened(filePath: string, languageId: string, content: string): void {
  sendNotification('textDocument/didOpen', {
    uri: filePath,
    languageId,
    version: 1,
    text: content,
  })
}

/** Notify the sidecar that a file was changed. */
export function notifyFileChanged(filePath: string, content: string, version: number): void {
  sendNotification('textDocument/didChange', {
    uri: filePath,
    version,
    contentChanges: [{ text: content }],
  })
}

/** Notify the sidecar that a file was saved. */
export function notifyFileSaved(filePath: string): void {
  sendNotification('textDocument/didSave', { uri: filePath })
}

/** Notify the sidecar that a file was closed. */
export function notifyFileClosed(filePath: string): void {
  sendNotification('textDocument/didClose', { uri: filePath })
}

/** Notify the sidecar that the active editor changed, with full content for sync getText(). */
export function notifyActiveEditorChanged(
  filePath: string | null,
  languageId?: string,
  content?: string,
  version?: number,
  selection?: { anchor: { line: number; character: number }; active: { line: number; character: number } },
  options?: { tabSize: number; insertSpaces: boolean },
): void {
  sendNotification('editor/didChangeActive', {
    uri: filePath,
    languageId,
    text: content,
    version,
    selection,
    options,
  })
}

// ─── Internal: message routing ───────────────────────────────────────────────

function handleSidecarMessage(raw: string): void {
  let msg: any
  try {
    msg = JSON.parse(raw)
  } catch {
    console.warn('[ext-bridge] Failed to parse sidecar message:', raw.slice(0, 200))
    return
  }

  // Handle JSON-RPC responses (to our requests)
  if (msg.id && _pendingRequests.has(msg.id)) {
    const pending = _pendingRequests.get(msg.id)!
    _pendingRequests.delete(msg.id)
    clearTimeout(pending.timer)
    if (msg.error) {
      pending.reject(new Error(msg.error.message || 'Extension host error'))
    } else {
      pending.resolve(msg.result)
    }
    return
  }

  // Handle JSON-RPC notifications (from extensions)
  if (msg.method) {
    routeNotification(msg.method, msg.params, msg.id)
  }
}

function routeNotification(method: string, params: any, id?: number): void {
  switch (method) {
    // ── Extension lifecycle ──────────────────────────────────────
    case 'extensionHost/ready': {
      const ready = params as ReadyParams
      _extensions = ready.extensions
      _activatedIds = ready.activated
      debugLog(
        `READY: ${ready.extensions.length} extensions, ${ready.activated.length} activated`,
      )
      // Collect ALL commands from ALL extensions first
      for (const ext of ready.extensions) {
        for (const cmd of ext.commands) {
          _extensionCommands.add(cmd)
        }
      }
      // Now register the proxy extension with ALL commands at once
      registerAllCommandsInWorkbench()
      for (const cb of _readyListeners) {
        cb(ready.extensions)
      }
      break
    }

    // ── Command registration ─────────────────────────────────────
    case 'commands/register': {
      if (params?.command) {
        _extensionCommands.add(params.command)
        console.log(`[ext-bridge] Command registered: ${params.command}`)
        // Register with the VS Code workbench command registry
        // so it appears in the command palette
        registerCommandInWorkbench(params.command)
      }
      if (id) sendResponse(id, { ok: true })
      break
    }

    // ── Window messages ──────────────────────────────────────────
    case 'window/showMessage': {
      const { type, message, items } = params || {}
      console.log(`[ext-bridge] ${type}: ${message}`)
      // TODO: Show via VS Code notification service
      // For now, just log and respond
      if (id) sendResponse(id, items?.[0] ?? undefined)
      break
    }

    case 'window/showQuickPick': {
      // TODO: Show via VS Code quick pick service
      if (id) sendResponse(id, undefined)
      break
    }

    case 'window/showInputBox': {
      // TODO: Show via VS Code input box service
      if (id) sendResponse(id, undefined)
      break
    }

    case 'window/showOutputChannel': {
      const { name, content } = params || {}
      console.log(`[ext-bridge] Output [${name}]:\n${content}`)
      // TODO: Create/show output channel in VS Code workbench
      if (id) sendResponse(id, null)
      break
    }

    case 'window/statusBarItem': {
      // TODO: Create/update status bar item in VS Code workbench
      if (id) sendResponse(id, null)
      break
    }

    case 'window/showTextDocument': {
      // TODO: Open file in editor via VS Code editor service
      if (id) sendResponse(id, null)
      break
    }

    // ── Formatting / Edit writeback ─────────────────────────────
    case 'textDocument/applyEdits': {
      const { uri: editUri, edits } = params || {}
      if (editUri && edits?.length) {
        debugLog(`applyEdits: ${edits.length} edits for ${editUri}`)
        applyEditsToMonaco(editUri, edits)
      }
      if (id) sendResponse(id, null)
      break
    }

    // ── Diagnostics ──────────────────────────────────────────────
    case 'languages/publishDiagnostics': {
      const { uri, diagnostics } = params || {}
      console.log(`[ext-bridge] Diagnostics for ${uri}: ${diagnostics?.length || 0} issues`)
      // TODO: Forward to VS Code diagnostics service via monaco markers
      if (id) sendResponse(id, null)
      break
    }

    // ── Language providers ────────────────────────────────────────
    case 'languages/registerCompletionProvider':
    case 'languages/registerHoverProvider':
    case 'languages/registerDefinitionProvider':
    case 'languages/registerCodeActionsProvider':
    case 'languages/registerFormattingProvider': {
      console.log(`[ext-bridge] Language provider registered: ${method}`)
      // TODO: Bridge to monaco language features
      if (id) sendResponse(id, null)
      break
    }

    // ── Configuration ────────────────────────────────────────────
    case 'configuration/update': {
      // TODO: Update VS Code workbench configuration
      if (id) sendResponse(id, null)
      break
    }

    // ── Workspace ────────────────────────────────────────────────
    case 'workspace/openTextDocument': {
      const filePath = params?.path || params?.uri
      if (!filePath) { if (id) sendResponse(id, null); break }
      invoke('ide_read_file', { path: filePath }).then((result: any) => {
        // Return { uri, languageId, version, text } to match VS Code TextDocument
        if (id) sendResponse(id, {
          uri: filePath,
          languageId: result?.language || 'plaintext',
          version: 1,
          text: result?.content || '',
        })
      }).catch((e) => {
        debugLog(`openTextDocument failed: ${e}`)
        if (id) sendResponse(id, null)
      })
      break
    }

    case 'workspace/findFiles': {
      const { include } = params || {}
      invoke('search_file_list', { path: '/', pattern: include || '*' })
        .then((result: any) => {
          if (id) sendResponse(id, Array.isArray(result) ? result : [])
        })
        .catch(() => { if (id) sendResponse(id, []) })
      break
    }

    case 'workspace/watchFiles': {
      // Use our existing file watcher
      if (params?.pattern) {
        invoke('fs_watch', { path: params.pattern }).catch(() => {})
      }
      if (id) sendResponse(id, null)
      break
    }

    // ── Filesystem ───────────────────────────────────────────────
    case 'fs/readFile': {
      const readPath = params?.path
      if (!readPath) { if (id) sendResponse(id, null); break }
      invoke('ide_read_file', { path: readPath }).then((result: any) => {
        // Return base64-encoded content (API shim decodes with Buffer.from)
        const content = result?.content || ''
        const b64 = typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(content))) : content
        if (id) sendResponse(id, b64)
      }).catch((e) => {
        debugLog(`fs/readFile failed: ${e}`)
        if (id) sendResponse(id, null)
      })
      break
    }

    case 'fs/writeFile': {
      const writePath = params?.path
      const writeContent = params?.content || ''
      if (!writePath) { if (id) sendResponse(id, null); break }
      // Content comes as base64 from the API shim
      let decoded: string
      try {
        decoded = decodeURIComponent(escape(atob(writeContent)))
      } catch {
        decoded = writeContent // Might already be plain text
      }
      invoke('ide_write_file', { path: writePath, content: decoded }).then(() => {
        if (id) sendResponse(id, null)
      }).catch((e) => {
        debugLog(`fs/writeFile failed: ${e}`)
        if (id) sendResponse(id, null)
      })
      break
    }

    case 'fs/stat': {
      const statPath = params?.path
      if (!statPath) { if (id) sendResponse(id, null); break }
      invoke('ide_read_file', { path: statPath }).then((result: any) => {
        if (id) sendResponse(id, {
          type: 1, // FileType.File
          size: result?.size || 0,
          ctime: Date.now(),
          mtime: Date.now(),
        })
      }).catch(() => {
        // Might be a directory
        invoke('ide_list_dir', { path: statPath }).then(() => {
          if (id) sendResponse(id, { type: 2, size: 0, ctime: Date.now(), mtime: Date.now() }) // FileType.Directory
        }).catch(() => {
          if (id) sendResponse(id, null)
        })
      })
      break
    }

    case 'fs/readDirectory': {
      const dirPath = params?.path
      if (!dirPath) { if (id) sendResponse(id, []); break }
      invoke('ide_list_dir', { path: dirPath }).then((result: any) => {
        const entries = (result?.entries || []).map((e: any) => [
          e.name,
          e.is_dir ? 2 : 1, // FileType.Directory or FileType.File
        ])
        if (id) sendResponse(id, entries)
      }).catch(() => {
        if (id) sendResponse(id, [])
      })
      break
    }

    case 'fs/delete': {
      // TODO: Add ide_delete_file Tauri command
      if (id) sendResponse(id, null)
      break
    }

    case 'fs/createDirectory': {
      // ide_write_file auto-creates parent dirs, so just acknowledge
      if (id) sendResponse(id, null)
      break
    }

    // ── Environment ──────────────────────────────────────────────
    case 'env/clipboardRead':
    case 'env/clipboardWrite':
    case 'env/openExternal': {
      if (id) sendResponse(id, null)
      break
    }

    // ── Secrets ──────────────────────────────────────────────────
    case 'secrets/get':
    case 'secrets/store':
    case 'secrets/delete': {
      if (id) sendResponse(id, null)
      break
    }

    // ── Commands ─────────────────────────────────────────────────
    case 'commands/list': {
      if (id) sendResponse(id, [..._extensionCommands])
      break
    }

    case 'commands/execute': {
      // Extension wants to execute a VS Code built-in command
      // TODO: Forward to VS Code command service
      if (id) sendResponse(id, null)
      break
    }

    default:
      console.log(`[ext-bridge] Unhandled notification: ${method}`)
      if (id) sendResponse(id, null)
      break
  }
}

// ─── Internal: JSON-RPC transport ────────────────────────────────────────────

function sendRequest(method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = _nextRequestId++
    const timer = setTimeout(() => {
      _pendingRequests.delete(id)
      reject(new Error(`Extension host request timeout: ${method}`))
    }, 30_000)

    _pendingRequests.set(id, { resolve, reject, timer })

    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    invoke('ext_host_send', { message: msg }).catch((e) => {
      _pendingRequests.delete(id)
      clearTimeout(timer)
      reject(e)
    })
  })
}

function sendNotification(method: string, params: any): void {
  if (!_running) return
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params })
  invoke('ext_host_send', { message: msg }).catch((e) =>
    console.warn(`[ext-bridge] Failed to send notification ${method}:`, e),
  )
}

// ─── Sidecar extension proxy ─────────────────────────────────────────────────
// Register a virtual extension that proxies ALL sidecar commands to the workbench.
// Called once when extensionHost/ready arrives with the full command list.

async function registerAllCommandsInWorkbench(): Promise<void> {
  const commands = [..._extensionCommands]
  debugLog(`registerAllCommandsInWorkbench: ${commands.length} commands: ${commands.join(', ')}`)
  if (commands.length === 0) return

  try {
    // Use registerAction2 — this both registers the command handler AND adds it
    // to the command palette (f1: true). CommandsRegistry alone doesn't show in palette.
    const actionsModule = await import(
      // @ts-ignore
      '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions'
    ) as any

    const { Action2, registerAction2 } = actionsModule

    if (!registerAction2 || !Action2) {
      debugLog('FAILED: registerAction2 or Action2 not found in actions module')
      return
    }

    for (const cmd of commands) {
      try {
        const prefix = cmd.includes('.') ? cmd.split('.')[0] : ''
        const suffix = cmd
          .replace(/^[^.]+\./, '')
          .replace(/([A-Z])/g, ' $1')
          .replace(/(^|\s)\S/g, (t: string) => t.toUpperCase())
          .trim()
        const title = prefix
          ? `${prefix.charAt(0).toUpperCase() + prefix.slice(1)}: ${suffix}`
          : suffix

        registerAction2(class extends Action2 {
          static readonly id = cmd
          constructor() {
            super({
              id: cmd,
              title: { value: title, original: title },
              f1: true,
            })
          }
          async run(): Promise<void> {
            debugLog(`Action: ${cmd}`)
            await sendRequest('commands/execute', { command: cmd, args: [] })
          }
        })
        debugLog(`palette action: ${cmd} → "${title}"`)
      } catch (cmdErr) {
        debugLog(`skipped ${cmd}: ${cmdErr}`)
      }
    }

    debugLog(`DONE: ${commands.length} sidecar commands registered`)
  } catch (e) {
    debugLog(`FAILED to register commands: ${e}`)
  }
}

/** Register a single late-arriving command (after ready). */
async function registerCommandInWorkbench(_command: string): Promise<void> {
  // Commands arriving after ready are already handled by the proxy extension
  // They just need a handler, not a new contributes entry
  // For now, log it — the proxy covers all commands from the ready message
  console.log(`[ext-bridge] Late command registered: ${_command}`)
}

/** Apply TextEdit[] from the sidecar to the Monaco editor. */
async function applyEditsToMonaco(uri: string, edits: any[]): Promise<void> {
  try {
    const { getService, ICodeEditorService } = await import('@codingame/monaco-vscode-api/services')
    const editorService = await getService(ICodeEditorService) as any
    const editor = editorService?.getActiveCodeEditor?.()
    if (!editor) { debugLog('applyEdits: no active editor'); return }

    const model = editor.getModel?.()
    if (!model) { debugLog('applyEdits: no model'); return }

    // Verify we're editing the right file
    const modelPath = model.uri?.fsPath || model.uri?.path || ''
    if (modelPath !== uri) {
      debugLog(`applyEdits: model path mismatch: ${modelPath} vs ${uri}`)
    }

    // Convert VS Code TextEdit format to Monaco edit operations
    // VS Code uses 0-based lines, Monaco uses 1-based lines
    const monacoEdits = edits.map((edit: any) => ({
      range: {
        startLineNumber: (edit.range?.start?.line ?? 0) + 1,
        startColumn: (edit.range?.start?.character ?? 0) + 1,
        endLineNumber: (edit.range?.end?.line ?? 0) + 1,
        endColumn: (edit.range?.end?.character ?? 0) + 1,
      },
      text: edit.newText ?? '',
      forceMoveMarkers: true,
    }))

    editor.executeEdits('prettier', monacoEdits)
    debugLog(`applyEdits: applied ${monacoEdits.length} edits to ${uri}`)
  } catch (e) {
    debugLog(`applyEdits failed: ${e}`)
  }
}

function sendResponse(id: number, result: any): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result: result ?? null })
  invoke('ext_host_send', { message: msg }).catch((e) =>
    console.warn(`[ext-bridge] Failed to send response:`, e),
  )
}

// ─── Workbench Extension Install Sync ────────────────────────────────────────
// Listen for extension installs from the VS Code workbench UI (Extensions panel)
// and sync them to ~/.opide/extensions/ for the Node.js sidecar.

let _installSyncActive = false

/**
 * Wire up the workbench's extension management service to sync installed
 * extensions to the sidecar. Call this after the workbench is initialized.
 */
export async function initExtensionInstallSync(): Promise<void> {
  if (_installSyncActive) return
  _installSyncActive = true

  try {
    // Access the workbench's extension management service via StandaloneServices
    const { StandaloneServices } = await import(
      '@codingame/monaco-vscode-api/services'
    )

    // Use dynamic import + any cast — these are deep VS Code internals
    // that don't have stable type exports
    let serviceId: any = null
    // Try both import paths — the .service suffix varies by version
    try {
      const mod = await import(
        // @ts-ignore
        '@codingame/monaco-vscode-api/vscode/vs/platform/extensionManagement/common/extensionManagement.service'
      ) as any
      serviceId = mod?.IExtensionManagementService
    } catch {}
    if (!serviceId) {
      try {
        const mod = await import(
          // @ts-ignore
          '@codingame/monaco-vscode-api/vscode/vs/platform/extensionManagement/common/extensionManagement'
        ) as any
        serviceId = mod?.IExtensionManagementService
      } catch {}
    }
    if (!serviceId) {
      debugLog('IExtensionManagementService not found — sidebar sync disabled')
      return
    }

    debugLog('IExtensionManagementService found — connecting...')
    const extMgmt = StandaloneServices.get(serviceId) as any
    if (!extMgmt) {
      debugLog('Extension management service instance not available')
      return
    }
    debugLog(`Extension management service connected. onDidInstallExtensions: ${typeof extMgmt.onDidInstallExtensions}`)

    // Listen for new installs from the Extensions sidebar
    if (typeof extMgmt.onDidInstallExtensions === 'function') {
      extMgmt.onDidInstallExtensions(async (results: any[]) => {
        for (const result of results) {
          if (result.error) continue
          const ext = result.local || result
          const id = ext?.identifier?.id || ext?.id || 'unknown'
          debugLog(`Workbench sidebar installed: ${id}`)

          // Also download to ~/.opide/extensions/ for persistence + MCP adapter
          try {
            const { installExtensionFromOpenVsx } = await import('./extension-mcp.ts')
            await installExtensionFromOpenVsx(id)
          } catch (e) {
            debugLog(`Failed to persist sidebar install ${id}: ${e}`)
          }
        }
      })
    }

    // Listen for uninstalls
    if (typeof extMgmt.onDidUninstallExtension === 'function') {
      extMgmt.onDidUninstallExtension((event: any) => {
        const id = event?.identifier?.id || 'unknown'
        console.log(`[ext-bridge] Workbench uninstalled extension: ${id}`)
        removeExtensionFromSidecar(id)
      })
    }

    debugLog('Extension sidebar install sync active — listening for installs')
  } catch (e) {
    console.warn('[ext-bridge] Failed to init extension install sync:', e)
  }
}

/**
 * Copy an installed extension to ~/.opide/extensions/ and notify the sidecar.
 */
async function _syncExtensionToSidecar(extensionId: string, sourcePath: string): Promise<void> {
  try {
    const targetDir = getExtensionsDir()
    // Use Tauri to copy the extension directory
    await invoke('ide_run_command', {
      command: 'cp',
      args: ['-R', sourcePath, `${targetDir}/${extensionId}`],
      cwd: '/',
    }).catch(() => {
      // Fallback: use shell
      console.warn(`[ext-bridge] Failed to copy extension ${extensionId}, trying shell`)
    })

    // Notify sidecar to activate the new extension
    if (_running) {
      sendNotification('extension/activate', { extensionId })
      console.log(`[ext-bridge] Synced ${extensionId} to sidecar`)
    }
  } catch (e) {
    console.warn(`[ext-bridge] Failed to sync extension ${extensionId}:`, e)
  }
}

/**
 * Remove an extension from ~/.opide/extensions/ and notify the sidecar.
 */
async function removeExtensionFromSidecar(extensionId: string): Promise<void> {
  try {
    const targetDir = getExtensionsDir()
    await invoke('ide_run_command', {
      command: 'rm',
      args: ['-rf', `${targetDir}/${extensionId}`],
      cwd: '/',
    }).catch(() => {})

    // Sidecar will notice on next restart
    console.log(`[ext-bridge] Removed ${extensionId} from sidecar extensions`)
  } catch (e) {
    console.warn(`[ext-bridge] Failed to remove extension ${extensionId}:`, e)
  }
}

/** Get the extensions directory path. */
function getExtensionsDir(): string {
  return `${(globalThis as any).process?.env?.HOME || '/tmp'}/.opide/extensions`
}

/**
 * Install a .vsix file into OPIDE. Extracts to ~/.opide/extensions/ and
 * activates in the sidecar.
 */
export async function installVsixFile(vsixPath: string): Promise<void> {
  console.log(`[ext-bridge] Installing .vsix: ${vsixPath}`)

  try {
    // Try to use the workbench's built-in VSIX installer
    const { StandaloneServices } = await import(
      '@codingame/monaco-vscode-api/services'
    )
    const extMgmtModule = await import(
      // @ts-ignore
      '@codingame/monaco-vscode-api/vscode/vs/platform/extensionManagement/common/extensionManagement'
    ) as any
    const uriModule = await import(
      // @ts-ignore
      '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
    ) as any

    const serviceId = extMgmtModule?.IExtensionManagementService
    const URI = uriModule?.URI
    if (serviceId && URI) {
      const extMgmt = StandaloneServices.get(serviceId) as any
      if (extMgmt?.installVSIX) {
        await extMgmt.installVSIX(URI.file(vsixPath), undefined, {})
        console.log(`[ext-bridge] .vsix installed via workbench service`)
        return
      }
    }
  } catch (e) {
    console.warn('[ext-bridge] Workbench VSIX install failed, falling back to manual:', e)
  }

  // Fallback: extract .vsix manually (it's just a zip)
  // The sidecar can handle this with a dedicated command
  if (_running) {
    await sendRequest('extension/installVsix', { path: vsixPath })
  }
}
