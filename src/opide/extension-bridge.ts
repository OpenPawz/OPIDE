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

// ─── Debug logging ──────────────────────────────────────────────────────────
//
// The previous comment noted that piping every message log through the Rust
// IPC was too costly because debugLog fires on every ext-host-message. That
// was true when debugLog ran on the hot dispatch path; today the per-message
// log happens elsewhere and `debugLog` is reserved for one-shot lifecycle
// events (registrations, handler errors, extension activation). Piping those
// through ext_host_log gets them into ~/Library/Logs/com.openpawz.opide/
// OPIDE.log so users running `tauri:dev` can `tail -f` the file instead of
// being forced into the dev tools to see why an extension failed.
//
// We still console.log for fast local feedback in dev tools when they're
// open. Both paths are best-effort — failures in the IPC call are swallowed
// so a misconfigured extension can't break the bridge's logging.
/** Verbose-only logs go through `traceLog` — surfaced in the dev console
 * but NOT piped to OPIDE.log. Lifecycle events that matter for support
 * (start, stop, errors) still go through `debugLog` and reach the file.
 *
 * Set window.OPIDE_VERBOSE_BRIDGE = true in DevTools to watch the JSON-RPC
 * firehose live; the default is silent so OPIDE.log stays readable. */
function debugLog(msg: string): void {
  console.log(`[ext-bridge] ${msg}`)
  invoke('ext_host_log', { message: `[ext-bridge] ${msg}` }).catch(() => {})
}
function traceLog(msg: string): void {
  if ((globalThis as any).OPIDE_VERBOSE_BRIDGE) {
    console.log(`[ext-bridge] ${msg}`)
  }
}

// ─── Centralised extensions-dir resolution (B36) ────────────────────────────

let _extensionsDirCache: string | null = null
async function getExtensionsDirAsync(): Promise<string> {
  if (_extensionsDirCache) return _extensionsDirCache
  const { homeDir } = await import('@tauri-apps/api/path')
  const home = (await homeDir()).replace(/[\\/]+$/, '')
  if (!home) throw new Error('Could not determine home directory for extensions')
  _extensionsDirCache = `${home}/.opide/extensions`
  return _extensionsDirCache
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface ExtHostMessageEvent {
  message: string
}

interface ExtHostStatusEvent {
  status: string
  detail: string
}

/** A view container declaration forwarded from the sidecar's
 * package.json scan. Keep the shape in sync with
 * node-extension-host/src/extension-scanner.ts:ContributedViewContainer. */
export interface ExtContributedViewContainer {
  surface: string
  id: string
  title: string
  iconPath?: string
  codiconId?: string
}

/** A view slot declaration. Same sync rule as above. */
export interface ExtContributedView {
  containerId: string
  id: string
  name: string
  type: 'tree' | 'webview'
  when?: string
  visibility?: string
  contextualTitle?: string
}

interface ExtensionInfo {
  id: string
  name: string
  version: string
  hasMain: boolean
  activationEvents: string[]
  commands: string[]
  contributedViewContainers?: ExtContributedViewContainer[]
  contributedViews?: ExtContributedView[]
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

// Cache the args of the most recent successful start so restartExtensionHost
// can re-spawn the sidecar without forcing the caller to remember the
// workspace path. Set inside startExtensionHost; cleared on stop.
let _lastStartArgs: { workspacePath: string; extensionsPath?: string } | null = null

// ─── Public API ──────────────────────────────────────────────────────────────

/** Stop the current sidecar and start a new one with the same args.
 * Used after extension install/uninstall so the new sidecar's scan
 * picks up the freshly-added directory. The bridge's
 * extensionHost/ready handler then re-runs registerAllContributedViews
 * with the new extension list, pre-mounting its views.
 *
 * Idempotent: if no sidecar has been started yet (e.g. user never
 * opened a workspace), this is a no-op. */
export async function restartExtensionHost(): Promise<void> {
  const args = _lastStartArgs
  if (!args) {
    debugLog('restartExtensionHost: no prior start args; skipping')
    return
  }
  debugLog('restartExtensionHost: stopping current sidecar')
  try { await stopExtensionHost() } catch (e) {
    debugLog(`restartExtensionHost: stop threw (continuing): ${e}`)
  }
  // Brief pause so the OS reaps the killed process and Tauri's manager
  // releases its slot before we ask for a new one.
  await new Promise((resolve) => setTimeout(resolve, 200))
  debugLog(`restartExtensionHost: starting fresh sidecar (ws=${args.workspacePath})`)
  await startExtensionHost(args.workspacePath, args.extensionsPath)
}

/** Start the extension host sidecar for the given workspace. */
export async function startExtensionHost(
  workspacePath: string,
  extensionsPath?: string,
): Promise<void> {
  if (_running) {
    console.warn('[ext-bridge] Extension host already running')
    return
  }

  const extPath = extensionsPath || await getExtensionsDirAsync()

  // Cache for restartExtensionHost. We do this on every successful
  // start so the cache always reflects the most recent good args.
  _lastStartArgs = { workspacePath, extensionsPath: extPath }

  debugLog(`startExtensionHost called: ws=${workspacePath} ext=${extPath}`)

  // Listen for messages from the sidecar BEFORE starting it
  _unlistenMessage = await listen<ExtHostMessageEvent>('ext-host-message', (event) => {
    // High-volume — every JSON-RPC message. Demoted to traceLog
    // so OPIDE.log stays readable. Set window.OPIDE_VERBOSE_BRIDGE=true
    // to watch live in DevTools.
    traceLog(`ext-host-message received: ${event.payload.message.slice(0, 120)}...`)
    handleSidecarMessage(event.payload.message)
  })

  debugLog('ext-host-message listener registered')

  _unlistenStatus = await listen<ExtHostStatusEvent>('ext-host-status', (event) => {
    const { status, detail } = event.payload
    // 'log' status mirrors sidecar stderr which already lands in
    // OPIDE.log via the Rust shell. Logging it again at debugLog
    // doubled every line. Demote 'log' to traceLog; lifecycle states
    // (starting / ready / crashed / exited) still go to file.
    if (status === 'log') {
      traceLog(`ext-host-status: log — ${detail}`)
    } else {
      debugLog(`ext-host-status: ${status} — ${detail}`)
    }
    for (const cb of _statusListeners) {
      cb(status, detail)
    }

    // Auto-restart on crash. CRITICAL (B37): clean up the *current* listeners
    // and pending requests before scheduling the restart — otherwise each
    // crash leaves its listeners attached and we get N+1 message handlers
    // after N crashes.
    if (status === 'crashed') {
      console.warn('[ext-bridge] Extension host crashed — will restart in 3s')
      if (_unlistenMessage) { _unlistenMessage(); _unlistenMessage = null }
      if (_unlistenStatus)  { _unlistenStatus();  _unlistenStatus  = null }
      for (const [id, p] of _pendingRequests) {
        clearTimeout(p.timer)
        p.reject(new Error('Extension host crashed'))
        _pendingRequests.delete(id)
      }
      _running = false
      setTimeout(() => {
        startExtensionHost(workspacePath, extensionsPath).catch((e) =>
          console.error('[ext-bridge] Restart failed:', e),
        )
      }, 3000)
    }
  })

  // Start the sidecar. If invoke rejects we want to see it in
  // OPIDE.log, not just dev tools — workbench.ts's caller catches
  // the throw with `.catch(console.warn)` which is invisible to
  // anyone tailing the log file.
  try {
    await invoke('ext_host_start', {
      request: {
        extensions_path: extPath,
        workspace_path: workspacePath,
      },
    })
  } catch (e) {
    debugLog(`ext_host_start FAILED: ${String((e as Error)?.message || e)}`)
    throw e
  }

  _running = true
  debugLog('Extension host started, waiting for ready message...')
}

/** Stop the extension host sidecar. */
export async function stopExtensionHost(): Promise<void> {
  // Always clean up listeners + reject pending — even when !_running, because
  // a previous crash may have left listeners attached (B38).
  if (_unlistenMessage) {
    _unlistenMessage()
    _unlistenMessage = null
  }
  if (_unlistenStatus) {
    _unlistenStatus()
    _unlistenStatus = null
  }
  for (const [id, p] of _pendingRequests) {
    clearTimeout(p.timer)
    p.reject(new Error('Extension host stopped'))
    _pendingRequests.delete(id)
  }
  _extensions = []
  _activatedIds = []
  _extensionCommands.clear()

  // Only call the IPC if we believe the host is still alive.
  if (_running) {
    await invoke('ext_host_stop').catch(() => {})
    _running = false
  }
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

/** Fire-and-forget notification to the sidecar. Exported so feature
 * modules (e.g. extension-scm) can push UI-originated events back to the
 * extension host without re-implementing the JSON-RPC framing. */
export function notifyHost(method: string, params: any): void {
  sendNotification(method, params)
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
  // CC1: lazy `onLanguage:<id>` activation. Fire-and-forget — extension
  // host does the actual activation and matching. We only send when we
  // have a non-empty language id so we don't trigger '*' over-broadly.
  if (languageId && languageId !== 'plaintext') {
    sendNotification('activation/onLanguage', { languageId })
  }
}

/** Trigger lazy `onView:<id>` activation when a workbench view becomes
 * visible. Called by the chat / extension-tree-views modules when their
 * panels are revealed. Cheap to call repeatedly — the sidecar dedupes
 * already-activated extensions. */
export function notifyViewActivated(viewId: string): void {
  if (!viewId) return
  sendNotification('activation/onView', { viewId })
}

/** Trigger `onChat:<participantId>` activation when the user @-mentions
 * a participant in OPIDE chat. Comes paired with the participant
 * dispatch path in extension-chat-participants.ts. */
export function notifyChatActivation(participantId: string): void {
  if (!participantId) return
  sendNotification('activation/onChat', { participantId })
}

/** Trigger `onDebug` / `onDebugResolve:<type>` activation before
 * starting a debug session. Called from extension-debug.startSession. */
export function notifyDebugActivation(type?: string): void {
  sendNotification('activation/onDebug', { type })
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

async function routeNotification(method: string, params: any, id?: number): Promise<void> {
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
      // VS Code's two-phase contribution model: pre-mount activity
      // bar entries and view slots NOW, before any extension's
      // activate() runs. The extension's registerWebviewViewProvider
      // / registerTreeDataProvider call will later attach to the
      // existing slot. Without this, sidebar-based extensions
      // (Continue, Claude Code, Cline, GitLens, Test Explorer) never
      // appear because they activate on `onView:<id>` which only
      // fires when the user clicks a slot that was never mounted.
      void registerAllContributedViews(ready.extensions)
      // Push the real merged configuration so extensions read actual
      // user/workspace settings (and get change notifications) rather
      // than the shim's hardcoded defaults.
      void pushConfigSnapshot()
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
      handleShowMessage(type, message, items).then((picked) => {
        if (id) sendResponse(id, picked)
      })
      break
    }

    case 'window/showQuickPick': {
      handleQuickPick(params).then((picked) => {
        if (id) sendResponse(id, picked)
      })
      break
    }

    case 'window/showInputBox': {
      handleInputBox(params).then((value) => {
        if (id) sendResponse(id, value)
      })
      break
    }

    case 'window/showOutputChannel': {
      handleOutputChannel(params)
      if (id) sendResponse(id, null)
      break
    }

    case 'window/statusBarItem': {
      handleStatusBarItem(params)
      if (id) sendResponse(id, null)
      break
    }

    case 'window/showTextDocument': {
      handleShowTextDocument(params).then(() => {
        if (id) sendResponse(id, null)
      })
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
      handlePublishDiagnostics(params)
      if (id) sendResponse(id, null)
      break
    }

    // ── Language providers ────────────────────────────────────────
    case 'languages/registerCompletionProvider': {
      handleRegisterLanguageProvider('completion', params)
      if (id) sendResponse(id, null)
      break
    }
    case 'languages/registerHoverProvider': {
      handleRegisterLanguageProvider('hover', params)
      if (id) sendResponse(id, null)
      break
    }
    case 'languages/registerDefinitionProvider': {
      handleRegisterLanguageProvider('definition', params)
      if (id) sendResponse(id, null)
      break
    }
    case 'languages/registerCodeActionsProvider': {
      handleRegisterLanguageProvider('codeAction', params)
      if (id) sendResponse(id, null)
      break
    }
    case 'languages/registerFormattingProvider': {
      handleRegisterLanguageProvider('formatting', params)
      if (id) sendResponse(id, null)
      break
    }
    case 'languages/registerReferenceProvider': {
      handleRegisterLanguageProvider('reference', params)
      if (id) sendResponse(id, null)
      break
    }
    case 'languages/registerDocumentSymbolProvider': {
      handleRegisterLanguageProvider('documentSymbol', params)
      if (id) sendResponse(id, null)
      break
    }
    case 'languages/registerRenameProvider': {
      handleRegisterLanguageProvider('rename', params)
      if (id) sendResponse(id, null)
      break
    }
    case 'languages/registerSignatureHelpProvider': {
      handleRegisterLanguageProvider('signatureHelp', params)
      if (id) sendResponse(id, null)
      break
    }

    // P1: inline completions. Carries providerId + languages so the
    // sidecar can route provideInlineCompletionItems back to the
    // matching provider; Monaco's inline-completion provider on this
    // side does the live debounced request loop.
    case 'languages/registerInlineCompletionProvider': {
      handleRegisterInlineCompletion(params)
      if (id) sendResponse(id, null)
      break
    }
    case 'languages/disposeInlineCompletionProvider': {
      handleDisposeInlineCompletion(params)
      if (id) sendResponse(id, null)
      break
    }

    // ── Configuration ────────────────────────────────────────────
    case 'configuration/update': {
      handleConfigurationUpdate(params)
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
      invoke('search_file_list', {
        root: '/',
        maxResults: 10000,
        pattern: include || undefined,
      })
        .then((result: any) => {
          if (id) sendResponse(id, Array.isArray(result) ? result : [])
        })
        .catch(() => { if (id) sendResponse(id, []) })
      break
    }

    case 'workspace/watchFiles': {
      // Use our existing file watcher
      if (params?.pattern) {
        invoke('fs_watch', { path: params.pattern, recursive: true }).catch(() => {})
      }
      if (id) sendResponse(id, null)
      break
    }

    // ── Filesystem ───────────────────────────────────────────────
    case 'fs/readFile': {
      const readPath = params?.path
      if (!readPath) { if (id) sendResponse(id, null); break }
      // Read raw bytes as base64 so binary files (images, wasm, fonts)
      // survive — the shim decodes the base64 to a Uint8Array. The old
      // text path (ide_read_file) corrupted any non-UTF-8 content.
      invoke('ide_read_file_bytes', { path: readPath }).then((b64: any) => {
        if (id) sendResponse(id, b64 || '')
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
      // Content is base64 of the raw bytes from the shim; write bytes
      // directly so binary content isn't mangled by a UTF-8 round-trip.
      invoke('ide_write_file_bytes', { path: writePath, contentBase64: writeContent }).then(() => {
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
      // Real stat: correct FileType (incl. symlink/dir), true size, and
      // actual ctime/mtime — no longer reads the whole file or fakes times.
      invoke('ide_stat', { path: statPath }).then((s: any) => {
        if (id) sendResponse(id, {
          type: s?.type ?? 1,
          size: s?.size ?? 0,
          ctime: s?.ctime ?? 0,
          mtime: s?.mtime ?? 0,
        })
      }).catch(() => {
        if (id) sendResponse(id, null)
      })
      break
    }

    case 'fs/readDirectory': {
      const dirPath = params?.path
      if (!dirPath) { if (id) sendResponse(id, []); break }
      // includeHidden: VS Code's readDirectory must return dotfiles too
      // (.gitignore, .env, .vscode). The agent tools keep the default hide.
      invoke('ide_list_dir', { path: dirPath, includeHidden: true }).then((result: any) => {
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
      // The shim sends `path`; tolerate `uri` too. Previously this only
      // read `uri`, so workspace.fs.delete() (which sends `path`) was a
      // silent no-op — the file was never deleted.
      const delPath = params?.path ?? params?.uri
      const delRecursive = params?.recursive
      if (delPath) {
        invoke('ide_delete_file', { path: delPath, recursive: delRecursive ?? false })
          .then(() => { if (id) sendResponse(id, null) })
          .catch((e: unknown) => { if (id) sendResponse(id, { error: String(e) }) })
      } else if (id) {
        sendResponse(id, null)
      }
      break
    }

    case 'fs/createDirectory': {
      // ide_write_file auto-creates parent dirs, so just acknowledge
      if (id) sendResponse(id, null)
      break
    }

    // ── Environment ──────────────────────────────────────────────
    case 'env/clipboardRead': {
      navigator.clipboard.readText().then((text) => {
        if (id) sendResponse(id, text)
      }).catch(() => {
        if (id) sendResponse(id, '')
      })
      break
    }
    case 'env/clipboardWrite': {
      const text = params?.text || params?.value || ''
      navigator.clipboard.writeText(text).then(() => {
        if (id) sendResponse(id, null)
      }).catch(() => {
        if (id) sendResponse(id, null)
      })
      break
    }
    case 'env/openExternal': {
      const url = params?.uri || params?.url || ''
      if (url) {
        // env/openExternal is the LSP path extensions use for "click to open
        // docs" links. Silent failure means the click did nothing, which
        // looks like a frozen UI. Log so we can diagnose. sendResponse below
        // still fires so the LSP doesn't itself hang waiting for an answer.
        invoke('ide_run_command', { command: `open "${url}"`, cwd: '/' }).catch((e) => {
          console.warn('[extension-bridge] env/openExternal failed:', url, e)
        })
      }
      if (id) sendResponse(id, true)
      break
    }

    // Secrets used to be handled here in an in-memory Map, but the shim
    // now persists them per-extension to disk in the sidecar (Node), so
    // there's no longer a secrets/* RPC to service. See createSecretStorage
    // in node-extension-host/src/api-shim.ts.

    // ── Commands ─────────────────────────────────────────────────
    case 'commands/list': {
      if (id) sendResponse(id, [..._extensionCommands])
      break
    }

    case 'commands/execute': {
      // Extension wants to execute a VS Code built-in command
      handleCommandExecute(params).then((result) => {
        if (id) sendResponse(id, result)
      }).catch(() => {
        if (id) sendResponse(id, null)
      })
      break
    }

    // ── Phase A: webview panels ──────────────────────────────────────
    case 'webview/create': {
      handleWebviewCreate(params).then(() => {
        if (id) sendResponse(id, null)
      }).catch((e) => {
        console.warn('[ext-bridge] webview/create failed:', e)
        if (id) sendResponse(id, null)
      })
      break
    }
    case 'webview/setHtml': {
      handleWebviewSetHtml(params)
      if (id) sendResponse(id, null)
      break
    }
    case 'webview/postMessage': {
      handleWebviewPostMessage(params)
      if (id) sendResponse(id, null)
      break
    }
    case 'webview/reveal': {
      handleWebviewReveal(params)
      if (id) sendResponse(id, null)
      break
    }
    case 'webview/dispose': {
      handleWebviewDispose(params)
      if (id) sendResponse(id, null)
      break
    }

    // ── Phase I: custom editors ──────────────────────────────────────
    case 'customEditor/registerProvider':
    case 'customEditor/disposeProvider':
    case 'fileDecorations/registerProvider': {
      // Phase I v1: registrations tracked in the sidecar; mounting
      // custom editors as Monaco editor inputs lands in v2 via the
      // same path A1's editor-tab refactor takes.
      if (id) sendResponse(id, null)
      break
    }

    // ── Phase D: debug ───────────────────────────────────────────────
    case 'debug/registerAdapterFactory': {
      // Phase D v1: just acknowledge. Adapters are spawned on-demand
      // when startSession fires; the registration is tracked in the
      // sidecar so the factory can be invoked there.
      if (id) sendResponse(id, null)
      break
    }
    case 'debug/resolveLaunchConfig': {
      handleDebugResolveLaunchConfig(params).then((cfg) => {
        if (id) sendResponse(id, cfg)
      }).catch(() => { if (id) sendResponse(id, null) })
      break
    }
    case 'debug/startSession': {
      handleDebugStartSession(params).then((res) => {
        if (id) sendResponse(id, res)
      }).catch(() => { if (id) sendResponse(id, null) })
      break
    }
    case 'debug/stopSession': {
      handleDebugStopSession(params).then(() => {
        if (id) sendResponse(id, null)
      }).catch(() => { if (id) sendResponse(id, null) })
      break
    }
    case 'debug/customRequest': {
      handleDebugCustomRequest(params).then((r) => {
        if (id) sendResponse(id, r)
      }).catch(() => { if (id) sendResponse(id, null) })
      break
    }
    case 'debug/addBreakpoints':
    case 'debug/removeBreakpoints': {
      // Phase D v1: relay to the workbench's debug service. Acknowledge
      // immediately; the workbench fires its own onDidChangeBreakpoints.
      if (id) sendResponse(id, null)
      break
    }
    case 'debug/consoleAppend': {
      // Phase D v1: route to console for now; once the debug console
      // panel is wired we'll target it directly.
      console.log('[ext-debug-console]', params?.value)
      if (id) sendResponse(id, null)
      break
    }

    // ── Phase E.E1: tasks ────────────────────────────────────────────
    case 'tasks/registerProvider': {
      if (id) sendResponse(id, null) // tracked in sidecar; nothing to mount yet
      break
    }
    case 'tasks/execute': {
      handleTaskExecute(params).then((r) => {
        if (id) sendResponse(id, r)
      }).catch(() => { if (id) sendResponse(id, null) })
      break
    }
    case 'tasks/terminate': {
      handleTaskTerminate(params).then(() => { if (id) sendResponse(id, null) }).catch(() => { if (id) sendResponse(id, null) })
      break
    }

    // ── Phase E.E2: terminal ─────────────────────────────────────────
    case 'terminal/create':
    case 'terminal/sendText':
    case 'terminal/show':
    case 'terminal/hide':
    case 'terminal/dispose': {
      handleTerminal(method, params).then(() => { if (id) sendResponse(id, null) }).catch(() => { if (id) sendResponse(id, null) })
      break
    }

    // ── Phase F: scm ─────────────────────────────────────────────────
    case 'scm/createSourceControl':
    case 'scm/createGroup':
    case 'scm/setResourceStates':
    case 'scm/setCount':
    case 'scm/setStatusBar':
    case 'scm/setInputBox':
    case 'scm/setAcceptCommand':
    case 'scm/setGroupHideWhenEmpty':
    case 'scm/disposeGroup':
    case 'scm/disposeSourceControl': {
      handleScm(method, params)
      // statusBarCommands render in the workbench status bar (not the SCM
      // panel), so route those through IStatusbarService here.
      if (method === 'scm/setStatusBar') void handleScmStatusBar(params)
      else if (method === 'scm/disposeSourceControl') disposeScmStatusBar(params?.id)
      if (id) sendResponse(id, null)
      break
    }

    // ── Phase G: tests ───────────────────────────────────────────────
    case 'tests/createController':
    case 'tests/disposeController':
    case 'tests/addItem':
    case 'tests/removeItem':
    case 'tests/replaceItems':
    case 'tests/createRunProfile':
    case 'tests/disposeRunProfile':
    case 'tests/startRun':
    case 'tests/runState':
    case 'tests/runOutput':
    case 'tests/endRun': {
      handleTests(method, params)
      if (id) sendResponse(id, null)
      break
    }

    // ── Phase H: notebooks ───────────────────────────────────────────
    case 'notebooks/createController':
    case 'notebooks/disposeController':
    case 'notebooks/updateController':
    case 'notebooks/registerSerializer':
    case 'notebooks/cellExecStart':
    case 'notebooks/cellExecEnd':
    case 'notebooks/cellClearOutput':
    case 'notebooks/cellReplaceOutput':
    case 'notebooks/cellAppendOutput': {
      handleNotebooks(method, params)
      if (id) sendResponse(id, null)
      break
    }

    // ── Phase C.C1: tree views ───────────────────────────────────────
    case 'tree/registerProvider': {
      handleTreeRegisterProvider(params)
      if (id) sendResponse(id, null)
      break
    }
    case 'tree/disposeProvider': {
      handleTreeDisposeProvider(params)
      if (id) sendResponse(id, null)
      break
    }
    case 'tree/refresh': {
      handleTreeRefresh(params)
      break
    }
    case 'tree/childrenResponse': {
      handleTreeChildrenResponse(params)
      break
    }
    case 'tree/reveal': {
      // Phase C v1: just acknowledge — selection-driven reveal needs
      // tracking of which sidebar slot the view is mounted in. Land in
      // v2 once we hook the workbench's view show/hide signals.
      if (id) sendResponse(id, null)
      break
    }

    // ── Phase C.C2: webview views (sidebar webviews) ────────────────
    case 'webviewView/registerProvider': {
      handleWebviewViewRegisterProvider(params)
      if (id) sendResponse(id, null)
      break
    }
    case 'webviewView/disposeProvider': {
      handleWebviewViewDisposeProvider(params)
      if (id) sendResponse(id, null)
      break
    }
    case 'webviewView/setHtml': {
      handleWebviewViewSetHtml(params)
      if (id) sendResponse(id, null)
      break
    }
    case 'webviewView/postMessage': {
      handleWebviewViewPostMessage(params)
      if (id) sendResponse(id, null)
      break
    }
    case 'webviewView/reveal': {
      handleWebviewViewReveal(params)
      if (id) sendResponse(id, null)
      break
    }

    // ── Phase B.B1: chat participants ────────────────────────────────
    case 'chat/registerParticipant': {
      handleChatRegisterParticipant(params)
      if (id) sendResponse(id, null)
      break
    }
    case 'chat/updateParticipant': {
      handleChatUpdateParticipant(params)
      if (id) sendResponse(id, null)
      break
    }
    case 'chat/disposeParticipant': {
      handleChatDisposeParticipant(params)
      if (id) sendResponse(id, null)
      break
    }
    case 'chat/registerVariableResolver': {
      // Phase B v1: just acknowledge. Variable expansion (#file, #selection)
      // is done client-side in OPIDE chat panel and not yet wired through
      // to extension-provided resolvers. v2 work.
      if (id) sendResponse(id, null)
      break
    }
    case 'chat/streamChunk': {
      handleChatStreamChunk(params)
      // Notifications, no response expected
      break
    }
    case 'chat/dispatchEnd': {
      handleChatDispatchEnd(params)
      break
    }

    // ── Phase B.B2: lm (language model API) ──────────────────────────
    case 'lm/selectModels': {
      handleLmSelectModels(params).then((models) => {
        if (id) sendResponse(id, models)
      }).catch(() => {
        if (id) sendResponse(id, [])
      })
      break
    }
    case 'lm/sendRequest': {
      handleLmSendRequest(params).then((result) => {
        if (id) sendResponse(id, result)
      }).catch((e) => {
        if (id) sendResponse(id, { error: String(e) })
      })
      break
    }
    case 'lm/countTokens': {
      handleLmCountTokens(params).then((r) => {
        if (id) sendResponse(id, r)
      }).catch(() => {
        if (id) sendResponse(id, { count: 0 })
      })
      break
    }

    // ── Phase B.B3: authentication ───────────────────────────────────
    case 'auth/getSession': {
      handleAuthGetSession(params).then((session) => {
        if (id) sendResponse(id, session)
      }).catch(() => {
        if (id) sendResponse(id, null)
      })
      break
    }
    case 'auth/registerProvider': {
      // Built-in providers (GitHub, Microsoft) are wired in extension-auth;
      // this just lets us know an extension has its own provider too.
      if (id) sendResponse(id, null)
      break
    }

    // ── Phase A: text editor decorations ─────────────────────────────
    case 'decorations/createType': {
      handleDecorationCreateType(params)
      if (id) sendResponse(id, null)
      break
    }
    case 'decorations/setDecorations': {
      handleDecorationSet(params)
      if (id) sendResponse(id, null)
      break
    }
    case 'decorations/disposeType': {
      handleDecorationDisposeType(params)
      if (id) sendResponse(id, null)
      break
    }

    default:
      console.log(`[ext-bridge] Unhandled notification: ${method}`)
      if (id) sendResponse(id, null)
      break
  }
}

// ─── Phase A handler imports ───────────────────────────────────────────────
// Lazy-imported on first use so the modules don't load before the workbench
// is ready (circular-import safety).
let _extWebviews: typeof import('./extension-webviews.ts') | null = null
async function getWebviews() {
  if (!_extWebviews) _extWebviews = await import('./extension-webviews.ts')
  return _extWebviews
}
let _extDecorations: typeof import('./extension-decorations.ts') | null = null
async function getDecorations() {
  if (!_extDecorations) _extDecorations = await import('./extension-decorations.ts')
  return _extDecorations
}
let _extChat: typeof import('./extension-chat-participants.ts') | null = null
async function getChat() {
  if (!_extChat) _extChat = await import('./extension-chat-participants.ts')
  return _extChat
}
let _extLm: typeof import('./extension-lm.ts') | null = null
async function getLm() {
  if (!_extLm) _extLm = await import('./extension-lm.ts')
  return _extLm
}
let _extAuth: typeof import('./extension-auth.ts') | null = null
async function getAuth() {
  if (!_extAuth) _extAuth = await import('./extension-auth.ts')
  return _extAuth
}

let _extTreeViews: typeof import('./extension-tree-views.ts') | null = null
async function getTreeViews() {
  if (!_extTreeViews) _extTreeViews = await import('./extension-tree-views.ts')
  return _extTreeViews
}
let _extWebviewViews: typeof import('./extension-webview-views.ts') | null = null
async function getWebviewViews() {
  if (!_extWebviewViews) _extWebviewViews = await import('./extension-webview-views.ts')
  return _extWebviewViews
}
let _extContributedViews: typeof import('./extension-contributed-views.ts') | null = null
async function getContributedViews() {
  if (!_extContributedViews) _extContributedViews = await import('./extension-contributed-views.ts')
  return _extContributedViews
}

/** Walk every extension's contributedViewContainers + contributedViews
 * and pre-mount the activity bar entries / view slots. Idempotent —
 * the contributed-views module dedupes by (extensionId, viewId). */
async function registerAllContributedViews(extensions: ExtensionInfo[]): Promise<void> {
  try {
    const cv = await getContributedViews()
    for (const ext of extensions) {
      const containers = ext.contributedViewContainers || []
      const views = ext.contributedViews || []
      if (containers.length === 0 && views.length === 0) continue
      cv.registerExtensionContributions(ext.id, containers, views, (viewId: string) => {
        // onView:<id> activation trigger. Fires when the user reveals
        // a view; the sidecar matches and activates the owning extension.
        sendNotification('activation/onView', { viewId })
      })
    }
  } catch (e) {
    debugLog(`registerAllContributedViews failed: ${e}`)
  }
}

let _extDebug: typeof import('./extension-debug.ts') | null = null
async function getDebug() { if (!_extDebug) _extDebug = await import('./extension-debug.ts'); return _extDebug }
let _extTasks: typeof import('./extension-tasks.ts') | null = null
async function getTasks() { if (!_extTasks) _extTasks = await import('./extension-tasks.ts'); return _extTasks }
let _extTerminal: typeof import('./extension-terminal.ts') | null = null
async function getTerminal() { if (!_extTerminal) _extTerminal = await import('./extension-terminal.ts'); return _extTerminal }
let _extScm: typeof import('./extension-scm.ts') | null = null
async function getScm() { if (!_extScm) _extScm = await import('./extension-scm.ts'); return _extScm }
let _extTests: typeof import('./extension-tests.ts') | null = null
async function getTests() { if (!_extTests) _extTests = await import('./extension-tests.ts'); return _extTests }
let _extNotebooks: typeof import('./extension-notebooks.ts') | null = null
async function getNotebooks() { if (!_extNotebooks) _extNotebooks = await import('./extension-notebooks.ts'); return _extNotebooks }

// Phase D handlers
async function handleDebugResolveLaunchConfig(params: any): Promise<any> {
  const d = await getDebug()
  return d.resolveLaunchConfig(params?.name)
}
async function handleDebugStartSession(params: any): Promise<any> {
  const d = await getDebug()
  return d.startSession(params?.config, params?.descriptor, (sessionEvent) => {
    sendNotification('debug/sessionEvent', sessionEvent)
  })
}
async function handleDebugStopSession(params: any): Promise<void> {
  const d = await getDebug()
  return d.stopSession(params?.sessionId)
}
async function handleDebugCustomRequest(params: any): Promise<any> {
  const d = await getDebug()
  return d.customRequest(params?.sessionId, params?.command, params?.args)
}

// Phase E handlers
async function handleTaskExecute(params: any): Promise<{ executionId: string } | null> {
  const t = await getTasks()
  // Notify the sidecar when the task's process exits so the extension's
  // vscode.tasks.onDidEndTask / onDidEndTaskProcess fire (common
  // "run task then continue" pattern depends on it).
  return t.executeTask(params, (executionId, exitCode) => {
    sendNotification('tasks/didEnd', { executionId, exitCode })
  })
}
async function handleTaskTerminate(params: any): Promise<void> {
  const t = await getTasks()
  return t.terminateTask(params?.executionId)
}
async function handleTerminal(method: string, params: any): Promise<void> {
  const t = await getTerminal()
  return t.handle(method, params)
}

// Phase F-H handlers
function handleScm(method: string, params: any): void {
  void getScm().then((s) => s.handle(method, params))
}

// SourceControl.statusBarCommands render in the workbench status bar (bottom),
// not the SCM panel. We register each as an IStatusbarService entry keyed by
// the source-control id so re-setting replaces them and disposing the source
// control clears them. Clicking an entry runs the (workbench-registered)
// extension command, with its arguments.
const _scmStatusDisposables = new Map<string, any[]>()

async function handleScmStatusBar(params: any): Promise<void> {
  try {
    const scmId: string | undefined = params?.id
    if (!scmId) return
    // Replace any previous entries for this source control.
    const prev = _scmStatusDisposables.get(scmId)
    if (prev) for (const d of prev) { try { d.dispose() } catch { /* ignore */ } }
    _scmStatusDisposables.set(scmId, [])

    const commands = params?.commands
    if (!Array.isArray(commands) || commands.length === 0) return

    const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
    const { IStatusbarService, StatusbarAlignment } = await import(
      '@codingame/monaco-vscode-api/vscode/vs/workbench/services/statusbar/browser/statusbar'
    )
    if (!IStatusbarService) return
    const statusbar = StandaloneServices.get(IStatusbarService) as any
    if (!statusbar?.addEntry) return

    const list: any[] = []
    commands.forEach((cmd: any, i: number) => {
      if (!cmd) return
      const entryId = `scm:${scmId}:${i}`
      const entry = {
        name: entryId,
        text: cmd.title || cmd.command || '',
        tooltip: cmd.tooltip || cmd.title || '',
        command: cmd.command
          ? { id: cmd.command, title: cmd.title || cmd.command, arguments: cmd.arguments }
          : undefined,
      }
      try {
        list.push(statusbar.addEntry(entry, entryId, StatusbarAlignment?.LEFT ?? 0, 100))
      } catch (e) {
        debugLog(`scm status entry add failed: ${e}`)
      }
    })
    _scmStatusDisposables.set(scmId, list)
  } catch (e) {
    debugLog(`scm setStatusBar failed: ${e}`)
  }
}

function disposeScmStatusBar(scmId?: string): void {
  if (!scmId) return
  const list = _scmStatusDisposables.get(scmId)
  if (list) {
    for (const d of list) { try { d.dispose() } catch { /* ignore */ } }
    _scmStatusDisposables.delete(scmId)
  }
}
function handleTests(method: string, params: any): void {
  void getTests().then((t) => t.handle(method, params))
}
function handleNotebooks(method: string, params: any): void {
  void getNotebooks().then((n) => n.handle(method, params))
}

// Phase C.C1: tree-view lifecycle. The tree module is responsible for
// mounting the sidebar slot and lazily fetching children via the
// callback we pass in (which round-trips through tree/getChildren).
function handleTreeRegisterProvider(params: any): void {
  void getTreeViews().then((tv) => tv.registerTreeProvider(
    params?.viewId,
    (parentNodeId, requestId) => {
      sendNotification('tree/getChildren', {
        viewId: params?.viewId, parentNodeId, requestId,
      })
    },
    (nodeId) => {
      sendNotification('tree/nodeClicked', { viewId: params?.viewId, nodeId })
    },
  ))
}
function handleTreeDisposeProvider(params: any): void {
  void getTreeViews().then((tv) => tv.disposeTreeProvider(params?.viewId))
}
function handleTreeRefresh(params: any): void {
  void getTreeViews().then((tv) => tv.refreshTree(params?.viewId))
}
function handleTreeChildrenResponse(params: any): void {
  void getTreeViews().then((tv) => tv.deliverChildren(params?.requestId, params?.items || []))
}

// Phase C.C2: webview view lifecycle. Reuses the iframe rendering
// helpers from extension-webview-views which mounts in a sidebar slot.
function handleWebviewViewRegisterProvider(params: any): void {
  // Pass the extension's identity through into the options so the
  // webview can scope localResourceRoots to the extension's install
  // directory. The api-shim attaches extensionId/extensionPath next
  // to options before sending the RPC.
  const enrichedOptions = {
    ...(params?.options || {}),
    extensionId: params?.extensionId || params?.options?.extensionId || '',
    extensionPath: params?.extensionPath || params?.options?.extensionPath || '',
  }
  void getWebviewViews().then((wv) => wv.registerWebviewView(params?.viewId, enrichedOptions, () => {
    sendNotification('webviewView/resolve', { viewId: params?.viewId })
  }, (message) => {
    sendNotification('webviewView/messageFromWebview', { viewId: params?.viewId, message })
  }))
}
function handleWebviewViewDisposeProvider(params: any): void {
  void getWebviewViews().then((wv) => wv.disposeWebviewView(params?.viewId))
}
function handleWebviewViewSetHtml(params: any): void {
  void getWebviewViews().then((wv) => wv.setWebviewViewHtml(params?.viewId, params?.html ?? ''))
}
function handleWebviewViewPostMessage(params: any): void {
  void getWebviewViews().then((wv) => wv.postMessageToWebviewView(params?.viewId, params?.message))
}
function handleWebviewViewReveal(params: any): void {
  void getWebviewViews().then((wv) => wv.revealWebviewView(params?.viewId))
}

// Phase B.B1: chat participant lifecycle. The participant module owns
// the chat-panel UI hook (textarea @ detection, message rendering); we
// just plumb the lifecycle events.
function handleChatRegisterParticipant(params: any): void {
  void getChat().then((c) => c.registerParticipant(params?.id, (participantId, prompt, requestId, history) => {
    // When the user types `@<id> ...` in OPIDE chat, this callback fires.
    // We send a chat/dispatch notification down to the sidecar; the
    // api-shim's dispatch case calls the participant's handler with a
    // ChatResponseStream. Streamed chunks come back as chat/streamChunk.
    sendNotification('chat/dispatch', { participantId, prompt, requestId, history })
  }))
}
function handleChatUpdateParticipant(params: any): void {
  void getChat().then((c) => c.updateParticipant(params?.id, params))
}
function handleChatDisposeParticipant(params: any): void {
  void getChat().then((c) => c.disposeParticipant(params?.id))
}
function handleChatStreamChunk(params: any): void {
  void getChat().then((c) => c.deliverStreamChunk(params))
}
function handleChatDispatchEnd(params: any): void {
  void getChat().then((c) => c.endDispatch(params))
}

// Phase B.B2: route LM requests through OPIDE's provider factory. The
// extension lm/selectModels call returns a list of available models;
// lm/sendRequest dispatches to the engine and the engine's tokens
// stream back through lm/streamChunk notifications keyed on requestId.
async function handleLmSelectModels(params: any): Promise<any[]> {
  const lm = await getLm()
  return lm.selectModels(params?.selector || {})
}
async function handleLmSendRequest(params: any): Promise<any> {
  const lm = await getLm()
  return lm.sendRequest(params, (chunk: string) => {
    sendNotification('lm/streamChunk', { requestId: params?.requestId, text: chunk })
  })
}
async function handleLmCountTokens(params: any): Promise<{ count: number }> {
  const lm = await getLm()
  return { count: await lm.countTokens(params?.modelId || '', params?.text || '') }
}

// Phase B.B3: auth sessions. Built-in providers (GitHub, Microsoft)
// implemented in extension-auth.ts; we delegate everything there.
async function handleAuthGetSession(params: any): Promise<any | null> {
  const auth = await getAuth()
  return auth.getSession(params?.providerId, params?.scopes || [], {
    createIfNone: params?.createIfNone,
    forceNewSession: params?.forceNewSession,
    clearSessionPreference: params?.clearSessionPreference,
  })
}

// ─── P1: Inline completion provider registration ─────────────────────────
// Tracks per-provider registrations across (re)activations so we can
// dispose Monaco providers when an extension goes away. Each provider
// can target multiple languages; we register one Monaco provider per
// language (Monaco's API takes a single language id per call).
const _inlineCompletionDisposables = new Map<string, Array<{ dispose(): void }>>()

async function handleRegisterInlineCompletion(params: any): Promise<void> {
  const { providerId, languages } = params || {}
  if (!providerId || !Array.isArray(languages) || languages.length === 0) return

  try {
    const monacoMod = await import('monaco-editor') as any
    const monaco = monacoMod.default || monacoMod

    const disposables: Array<{ dispose(): void }> = []

    for (const lang of languages) {
      const target = lang === '*' ? '*' : lang
      const d = monaco.languages.registerInlineCompletionsProvider(target, {
        provideInlineCompletions: async (model: any, position: any, _context: any, token: any) => {
          if (token?.isCancellationRequested) return undefined
          try {
            const result = await sendRequest('languages/provideInlineCompletionItems', {
              providerId,
              uri: model.uri.fsPath || model.uri.path,
              position: { line: position.lineNumber - 1, character: position.column - 1 },
              languageId: lang,
              context: {
                // Most Copilot/Tabnine-style providers ignore the
                // trigger context; passing the kind is enough.
                triggerKind: 0,
              },
            })
            const items = (result?.items || []).map((it: any) => ({
              insertText: it.insertText || '',
              range: it.range ? {
                startLineNumber: (it.range.start?.line ?? 0) + 1,
                startColumn: (it.range.start?.character ?? 0) + 1,
                endLineNumber: (it.range.end?.line ?? 0) + 1,
                endColumn: (it.range.end?.character ?? 0) + 1,
              } : undefined,
              command: it.command,
            }))
            return { items }
          } catch (e) {
            debugLog(`inline completion request failed: ${e}`)
            return { items: [] }
          }
        },
        freeInlineCompletions: () => { /* nothing to free; we don't keep state */ },
      })
      disposables.push(d)
    }

    _inlineCompletionDisposables.set(providerId, disposables)
    debugLog(`inline completion provider ${providerId} registered for ${languages.join(', ')}`)
  } catch (e) {
    debugLog(`registerInlineCompletionProvider failed: ${e}`)
  }
}

function handleDisposeInlineCompletion(params: any): void {
  const list = _inlineCompletionDisposables.get(params?.providerId) || []
  for (const d of list) { try { d.dispose() } catch { /* ignore */ } }
  _inlineCompletionDisposables.delete(params?.providerId)
}

async function handleWebviewCreate(params: any): Promise<void> {
  const wv = await getWebviews()
  wv.createWebviewPanel(params, (panelId, message) => {
    // Webview → extension. Wire the iframe's outgoing postMessage events
    // back through the JSON-RPC notification stream.
    sendNotification('webview/messageFromWebview', { panelId, message })
  }, (panelId) => {
    sendNotification('webview/didDispose', { panelId })
  }, (panelId, viewState) => {
    sendNotification('webview/didChangeViewState', { panelId, ...viewState })
  })
}
function handleWebviewSetHtml(params: any): void {
  void getWebviews().then((wv) => wv.setWebviewHtml(params?.panelId, params?.html ?? ''))
}
function handleWebviewPostMessage(params: any): void {
  void getWebviews().then((wv) => wv.postMessageToWebview(params?.panelId, params?.message))
}
function handleWebviewReveal(params: any): void {
  void getWebviews().then((wv) => wv.revealWebviewPanel(params?.panelId))
}
function handleWebviewDispose(params: any): void {
  void getWebviews().then((wv) => wv.disposeWebviewPanel(params?.panelId))
}

function handleDecorationCreateType(params: any): void {
  void getDecorations().then((d) => d.createDecorationType(params?.typeId, params?.options))
}
function handleDecorationSet(params: any): void {
  void getDecorations().then((d) =>
    d.setDecorations(params?.uri, params?.typeId, params?.ranges || []),
  )
}
function handleDecorationDisposeType(params: any): void {
  void getDecorations().then((d) => d.disposeDecorationType(params?.typeId))
}

// ─── Registered language providers (for proxying requests back to sidecar) ──

const _languageProviders = new Map<string, Set<string>>() // type → languages

// ─── Output channels ────────────────────────────────────────────────────────

const _outputChannels = new Map<string, string>() // name → accumulated content

// ─── Window API handlers ────────────────────────────────────────────────────

async function handleShowMessage(
  type: string,
  message: string,
  items?: string[],
): Promise<string | undefined> {
  try {
    const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
    const { INotificationService, Severity } = await import(
      '@codingame/monaco-vscode-api/vscode/vs/platform/notification/common/notification'
    )

    const notifService = StandaloneServices.get(INotificationService) as any
    if (!notifService) {
      debugLog(`showMessage (no service): ${type}: ${message}`)
      return items?.[0]
    }

    const severity = type === 'error' ? Severity?.Error
      : type === 'warning' ? Severity?.Warning
      : Severity?.Info ?? 2

    if (items && items.length > 0) {
      // Show with action buttons, return the picked item
      return new Promise<string | undefined>((resolve) => {
        const actions = items.map((label: string) => ({
          label,
          run: () => resolve(label),
        }))
        notifService.prompt(severity, message, actions, {
          onCancel: () => resolve(undefined),
        })
      })
    } else {
      notifService.notify({ severity, message })
      return undefined
    }
  } catch (e) {
    debugLog(`showMessage fallback: ${type}: ${message}`)
    return items?.[0]
  }
}

async function handleQuickPick(params: any): Promise<any> {
  try {
    const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
    const { IQuickInputService } = await import(
      '@codingame/monaco-vscode-api/vscode/vs/platform/quickinput/common/quickInput'
    )

    const quickInput = StandaloneServices.get(IQuickInputService) as any
    if (!quickInput?.pick) return undefined

    const items = (params?.items || []).map((item: any) => {
      if (typeof item === 'string') return { label: item }
      return { label: item.label, description: item.description, detail: item.detail, picked: item.picked }
    })

    const options = {
      placeHolder: params?.placeHolder || '',
      canPickMany: params?.canPickMany || false,
      title: params?.title,
    }

    const result = await quickInput.pick(items, options)
    if (!result) return undefined
    if (Array.isArray(result)) return result.map((r: any) => r.label ?? r)
    return result.label ?? result
  } catch (e) {
    debugLog(`quickPick failed: ${e}`)
    return undefined
  }
}

async function handleInputBox(params: any): Promise<string | undefined> {
  try {
    const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
    const { IQuickInputService } = await import(
      '@codingame/monaco-vscode-api/vscode/vs/platform/quickinput/common/quickInput'
    )

    const quickInput = StandaloneServices.get(IQuickInputService) as any
    if (!quickInput?.input) return undefined

    return await quickInput.input({
      placeHolder: params?.placeHolder || '',
      prompt: params?.prompt || '',
      value: params?.value || '',
      password: params?.password || false,
      title: params?.title,
    })
  } catch (e) {
    debugLog(`inputBox failed: ${e}`)
    return undefined
  }
}

function handleOutputChannel(params: any): void {
  const { name, content, append, show } = params || {}
  if (!name) return

  if (append) {
    _outputChannels.set(name, (_outputChannels.get(name) || '') + (content || ''))
  } else if (content !== undefined) {
    _outputChannels.set(name, content)
  }

  // Log to console with channel prefix for visibility
  if (content) {
    console.log(`[output:${name}] ${content}`)
  }

  // Show in the Output panel if requested
  if (show) {
    showOutputPanel(name).catch(() => {})
  }
}

async function showOutputPanel(channelName: string): Promise<void> {
  try {
    const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
    const { IOutputService } = await import(
      '@codingame/monaco-vscode-api/vscode/vs/workbench/services/output/common/output'
    )

    if (!IOutputService) return
    const outputService = StandaloneServices.get(IOutputService) as any
    if (!outputService) return

    // Try to show the output channel
    const channel = outputService.getChannel?.(channelName)
    if (channel) {
      outputService.showChannel?.(channelName)
    }
  } catch {
    // Output panel service may not be available
  }
}

async function handleStatusBarItem(params: any): Promise<void> {
  try {
    const { id: itemId, text, tooltip, color, command, alignment, priority } = params || {}
    if (!itemId || !text) return

    const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
    const { IStatusbarService, StatusbarAlignment } = await import(
      '@codingame/monaco-vscode-api/vscode/vs/workbench/services/statusbar/browser/statusbar'
    )

    if (!IStatusbarService) return
    const statusbar = StandaloneServices.get(IStatusbarService) as any
    if (!statusbar?.addEntry) return

    const align = alignment === 'right'
      ? StatusbarAlignment?.RIGHT ?? 1
      : StatusbarAlignment?.LEFT ?? 0

    // Remove previous entry with same ID if it exists
    const prev = _statusBarDisposables.get(itemId)
    if (prev) prev.dispose()

    const entry = {
      name: itemId,
      text: text || '',
      tooltip: tooltip || '',
      color: color || undefined,
      command: command || undefined,
    }

    const disposable = statusbar.addEntry(entry, itemId, align, priority ?? 0)
    _statusBarDisposables.set(itemId, disposable)
  } catch (e) {
    debugLog(`statusBarItem failed: ${e}`)
  }
}

const _statusBarDisposables = new Map<string, any>()

async function handleShowTextDocument(params: any): Promise<void> {
  try {
    const filePath = params?.uri || params?.path
    if (!filePath) return

    const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
    const { IEditorService } = await import(
      '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService'
    )

    if (!IEditorService) return
    const editorService = StandaloneServices.get(IEditorService) as any
    if (!editorService?.openEditor) return

    const { URI } = await import(
      '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
    )

    const uri = URI.file(filePath)
    const options: any = {}

    // Support selection/range parameter
    if (params?.selection) {
      options.selection = {
        startLineNumber: (params.selection.start?.line ?? 0) + 1,
        startColumn: (params.selection.start?.character ?? 0) + 1,
        endLineNumber: (params.selection.end?.line ?? params.selection.start?.line ?? 0) + 1,
        endColumn: (params.selection.end?.character ?? params.selection.start?.character ?? 0) + 1,
      }
    }

    await editorService.openEditor({ resource: uri, options })
  } catch (e) {
    debugLog(`showTextDocument failed: ${e}`)
  }
}

// ─── Diagnostics handler ────────────────────────────────────────────────────

async function handlePublishDiagnostics(params: any): Promise<void> {
  try {
    const { uri, diagnostics, name } = params || {}
    // diagnostics may be an empty array (a clear) — only bail on null/undefined.
    if (!uri || !Array.isArray(diagnostics)) return

    const monacoMod = await import('monaco-editor') as any
    const monaco = monacoMod.default || monacoMod
    const models = monaco.editor.getModels()

    // Find the matching model
    const model = models.find((m: any) => {
      const mPath = m.uri.fsPath || m.uri.path
      return mPath === uri || m.uri.toString() === uri
    })

    if (!model) {
      debugLog(`publishDiagnostics: no model for ${uri}`)
      return
    }

    // Map VS Code severity: 0=Error, 1=Warning, 2=Info, 3=Hint
    // Monaco MarkerSeverity: 1=Hint, 2=Info, 4=Warning, 8=Error
    const severityMap: Record<number, number> = { 0: 8, 1: 4, 2: 2, 3: 1 }

    const markers = diagnostics.map((d: any) => ({
      severity: severityMap[d.severity] ?? 8,
      startLineNumber: (d.range?.start?.line ?? 0) + 1,
      startColumn: (d.range?.start?.character ?? 0) + 1,
      endLineNumber: (d.range?.end?.line ?? 0) + 1,
      endColumn: (d.range?.end?.character ?? 0) + 1,
      message: d.message || '',
      source: d.source || 'extension',
      code: d.code != null ? String(d.code) : undefined,
    }))

    // Scope markers to the collection (per-extension owner) so two
    // collections (e.g. ESLint + TS) don't clobber each other's squiggles
    // on the same file. An empty `markers` array clears this owner's
    // markers for the model (delete/clear/dispose on the collection).
    const owner = name ? `ext:${name}` : 'extension-diagnostics'
    monaco.editor.setModelMarkers(model, owner, markers)
    debugLog(`publishDiagnostics: set ${markers.length} markers for ${uri} (owner=${owner})`)
  } catch (e) {
    debugLog(`publishDiagnostics failed: ${e}`)
  }
}

// ─── Language provider registration ─────────────────────────────────────────
// Extensions register language providers in the sidecar. We create Monaco
// provider registrations that proxy requests back through the sidecar.

async function handleRegisterLanguageProvider(
  type: string,
  params: any,
): Promise<void> {
  const { languageId, selector } = params || {}
  const languages = languageId
    ? [languageId]
    : (selector || []).map((s: any) => (typeof s === 'string' ? s : s.language)).filter(Boolean)

  if (languages.length === 0) {
    debugLog(`registerLanguageProvider(${type}): no languages specified`)
    return
  }

  // Track registered providers
  if (!_languageProviders.has(type)) _languageProviders.set(type, new Set())
  for (const lang of languages) _languageProviders.get(type)!.add(lang)

  debugLog(`registerLanguageProvider(${type}): ${languages.join(', ')}`)

  try {
    const monacoMod = await import('monaco-editor') as any
    const monaco = monacoMod.default || monacoMod

    for (const lang of languages) {
      switch (type) {
        case 'completion':
          monaco.languages.registerCompletionItemProvider(lang, {
            provideCompletionItems: async (model: any, position: any) => {
              try {
                const result = await sendRequest('languages/provideCompletionItems', {
                  uri: model.uri.fsPath || model.uri.path,
                  position: { line: position.lineNumber - 1, character: position.column - 1 },
                  languageId: lang,
                })
                if (!result?.items) return { suggestions: [] }
                return {
                  suggestions: result.items.map((item: any) => ({
                    label: item.label || '',
                    kind: item.kind ?? monaco.languages.CompletionItemKind.Text,
                    insertText: item.insertText || item.label || '',
                    // When the extension returned a SnippetString, tell
                    // Monaco to interpret ${1:..} placeholders rather than
                    // inserting them literally. (kind values pass through
                    // unchanged: monaco-editor is aliased to the codingame
                    // build, which uses VS Code's own enum values.)
                    insertTextRules: item.insertTextIsSnippet
                      ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                      : undefined,
                    detail: item.detail,
                    documentation: item.documentation,
                    sortText: item.sortText,
                    filterText: item.filterText,
                    range: item.range ? {
                      startLineNumber: (item.range.start?.line ?? 0) + 1,
                      startColumn: (item.range.start?.character ?? 0) + 1,
                      endLineNumber: (item.range.end?.line ?? 0) + 1,
                      endColumn: (item.range.end?.character ?? 0) + 1,
                    } : undefined,
                  })),
                }
              } catch {
                return { suggestions: [] }
              }
            },
          })
          break

        case 'hover':
          monaco.languages.registerHoverProvider(lang, {
            provideHover: async (model: any, position: any) => {
              try {
                const result = await sendRequest('languages/provideHover', {
                  uri: model.uri.fsPath || model.uri.path,
                  position: { line: position.lineNumber - 1, character: position.column - 1 },
                  languageId: lang,
                })
                if (!result?.contents) return null
                const contents = Array.isArray(result.contents) ? result.contents : [result.contents]
                return {
                  contents: contents.map((c: any) =>
                    typeof c === 'string' ? { value: c } : { value: c.value || '' }
                  ),
                  range: result.range ? {
                    startLineNumber: (result.range.start?.line ?? 0) + 1,
                    startColumn: (result.range.start?.character ?? 0) + 1,
                    endLineNumber: (result.range.end?.line ?? 0) + 1,
                    endColumn: (result.range.end?.character ?? 0) + 1,
                  } : undefined,
                }
              } catch {
                return null
              }
            },
          })
          break

        case 'definition':
          monaco.languages.registerDefinitionProvider(lang, {
            provideDefinition: async (model: any, position: any) => {
              try {
                const result = await sendRequest('languages/provideDefinition', {
                  uri: model.uri.fsPath || model.uri.path,
                  position: { line: position.lineNumber - 1, character: position.column - 1 },
                  languageId: lang,
                })
                if (!result) return null
                const locations = Array.isArray(result) ? result : [result]
                return locations.map((loc: any) => ({
                  uri: monaco.Uri.file(loc.uri || loc.path || ''),
                  range: {
                    startLineNumber: (loc.range?.start?.line ?? 0) + 1,
                    startColumn: (loc.range?.start?.character ?? 0) + 1,
                    endLineNumber: (loc.range?.end?.line ?? 0) + 1,
                    endColumn: (loc.range?.end?.character ?? 0) + 1,
                  },
                }))
              } catch {
                return null
              }
            },
          })
          break

        case 'reference':
          monaco.languages.registerReferenceProvider(lang, {
            provideReferences: async (model: any, position: any, context: any) => {
              try {
                const result = await sendRequest('languages/provideReferences', {
                  uri: model.uri.fsPath || model.uri.path,
                  position: { line: position.lineNumber - 1, character: position.column - 1 },
                  context: { includeDeclaration: context.includeDeclaration },
                  languageId: lang,
                })
                if (!result) return null
                const locations = Array.isArray(result) ? result : [result]
                return locations.map((loc: any) => ({
                  uri: monaco.Uri.file(loc.uri || loc.path || ''),
                  range: {
                    startLineNumber: (loc.range?.start?.line ?? 0) + 1,
                    startColumn: (loc.range?.start?.character ?? 0) + 1,
                    endLineNumber: (loc.range?.end?.line ?? 0) + 1,
                    endColumn: (loc.range?.end?.character ?? 0) + 1,
                  },
                }))
              } catch {
                return null
              }
            },
          })
          break

        case 'documentSymbol':
          monaco.languages.registerDocumentSymbolProvider(lang, {
            provideDocumentSymbols: async (model: any) => {
              try {
                const result = await sendRequest('languages/provideDocumentSymbols', {
                  uri: model.uri.fsPath || model.uri.path,
                  languageId: lang,
                })
                if (!result) return []
                return (Array.isArray(result) ? result : []).map((sym: any) => ({
                  name: sym.name || '',
                  detail: sym.detail || '',
                  kind: sym.kind ?? monaco.languages.SymbolKind.Variable,
                  range: {
                    startLineNumber: (sym.range?.start?.line ?? 0) + 1,
                    startColumn: (sym.range?.start?.character ?? 0) + 1,
                    endLineNumber: (sym.range?.end?.line ?? 0) + 1,
                    endColumn: (sym.range?.end?.character ?? 0) + 1,
                  },
                  selectionRange: {
                    startLineNumber: (sym.selectionRange?.start?.line ?? sym.range?.start?.line ?? 0) + 1,
                    startColumn: (sym.selectionRange?.start?.character ?? sym.range?.start?.character ?? 0) + 1,
                    endLineNumber: (sym.selectionRange?.end?.line ?? sym.range?.end?.line ?? 0) + 1,
                    endColumn: (sym.selectionRange?.end?.character ?? sym.range?.end?.character ?? 0) + 1,
                  },
                  tags: sym.tags || [],
                  children: [],  // Flatten for now
                }))
              } catch {
                return []
              }
            },
          })
          break

        case 'codeAction':
          monaco.languages.registerCodeActionProvider(lang, {
            provideCodeActions: async (model: any, range: any) => {
              try {
                const result = await sendRequest('languages/provideCodeActions', {
                  uri: model.uri.fsPath || model.uri.path,
                  range: {
                    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
                    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
                  },
                  languageId: lang,
                })
                if (!result) return { actions: [], dispose() {} }
                const actions = (Array.isArray(result) ? result : result.actions || []).map((a: any) => ({
                  title: a.title || '',
                  kind: a.kind,
                  isPreferred: a.isPreferred,
                  command: a.command ? {
                    id: a.command.command || a.command.id || '',
                    title: a.command.title || '',
                    arguments: a.command.arguments || [],
                  } : undefined,
                  edit: a.edit ? convertWorkspaceEdit(a.edit, monaco) : undefined,
                }))
                return { actions, dispose() {} }
              } catch {
                return { actions: [], dispose() {} }
              }
            },
          })
          break

        case 'formatting':
          monaco.languages.registerDocumentFormattingEditProvider(lang, {
            provideDocumentFormattingEdits: async (model: any, options: any) => {
              try {
                const result = await sendRequest('languages/provideDocumentFormattingEdits', {
                  uri: model.uri.fsPath || model.uri.path,
                  options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
                  languageId: lang,
                })
                if (!result) return []
                return (Array.isArray(result) ? result : []).map((edit: any) => ({
                  range: {
                    startLineNumber: (edit.range?.start?.line ?? 0) + 1,
                    startColumn: (edit.range?.start?.character ?? 0) + 1,
                    endLineNumber: (edit.range?.end?.line ?? 0) + 1,
                    endColumn: (edit.range?.end?.character ?? 0) + 1,
                  },
                  text: edit.newText ?? '',
                }))
              } catch {
                return []
              }
            },
          })
          break

        case 'rename':
          monaco.languages.registerRenameProvider(lang, {
            provideRenameEdits: async (model: any, position: any, newName: any) => {
              try {
                const result = await sendRequest('languages/provideRenameEdits', {
                  uri: model.uri.fsPath || model.uri.path,
                  position: { line: position.lineNumber - 1, character: position.column - 1 },
                  newName,
                  languageId: lang,
                })
                if (!result) return { edits: [] }
                return convertWorkspaceEdit(result, monaco)
              } catch {
                return { edits: [] }
              }
            },
            resolveRenameLocation: async (model: any, position: any) => {
              try {
                const result = await sendRequest('languages/prepareRename', {
                  uri: model.uri.fsPath || model.uri.path,
                  position: { line: position.lineNumber - 1, character: position.column - 1 },
                  languageId: lang,
                })
                if (!result) return { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: '' }
                return {
                  range: {
                    startLineNumber: (result.range?.start?.line ?? 0) + 1,
                    startColumn: (result.range?.start?.character ?? 0) + 1,
                    endLineNumber: (result.range?.end?.line ?? 0) + 1,
                    endColumn: (result.range?.end?.character ?? 0) + 1,
                  },
                  text: result.placeholder || '',
                }
              } catch {
                return { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: '' }
              }
            },
          })
          break

        case 'signatureHelp':
          monaco.languages.registerSignatureHelpProvider(lang, {
            signatureHelpTriggerCharacters: params?.triggerCharacters || ['(', ','],
            provideSignatureHelp: async (model: any, position: any) => {
              try {
                const result = await sendRequest('languages/provideSignatureHelp', {
                  uri: model.uri.fsPath || model.uri.path,
                  position: { line: position.lineNumber - 1, character: position.column - 1 },
                  languageId: lang,
                })
                if (!result) return null
                return {
                  value: {
                    signatures: (result.signatures || []).map((sig: any) => ({
                      label: sig.label || '',
                      documentation: sig.documentation,
                      parameters: (sig.parameters || []).map((p: any) => ({
                        label: p.label || '',
                        documentation: p.documentation,
                      })),
                    })),
                    activeSignature: result.activeSignature ?? 0,
                    activeParameter: result.activeParameter ?? 0,
                  },
                  dispose() {},
                }
              } catch {
                return null
              }
            },
          })
          break
      }
    }
  } catch (e) {
    debugLog(`registerLanguageProvider(${type}) failed: ${e}`)
  }
}

// ─── WorkspaceEdit conversion helper ────────────────────────────────────────

function convertWorkspaceEdit(edit: any, monaco: any): any {
  const edits: any[] = []
  const changes = edit.changes || {}
  for (const [uri, textEdits] of Object.entries(changes)) {
    for (const te of textEdits as any[]) {
      edits.push({
        resource: monaco.Uri.file(uri),
        textEdit: {
          range: {
            startLineNumber: (te.range?.start?.line ?? 0) + 1,
            startColumn: (te.range?.start?.character ?? 0) + 1,
            endLineNumber: (te.range?.end?.line ?? 0) + 1,
            endColumn: (te.range?.end?.character ?? 0) + 1,
          },
          text: te.newText ?? '',
        },
        versionId: undefined,
      })
    }
  }
  // Also handle documentChanges format
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if (change.textDocument && change.edits) {
        for (const te of change.edits) {
          edits.push({
            resource: monaco.Uri.file(change.textDocument.uri || ''),
            textEdit: {
              range: {
                startLineNumber: (te.range?.start?.line ?? 0) + 1,
                startColumn: (te.range?.start?.character ?? 0) + 1,
                endLineNumber: (te.range?.end?.line ?? 0) + 1,
                endColumn: (te.range?.end?.character ?? 0) + 1,
              },
              text: te.newText ?? '',
            },
            versionId: change.textDocument.version,
          })
        }
      }
    }
  }
  return { edits }
}

// ─── Configuration handler ──────────────────────────────────────────────────

async function handleConfigurationUpdate(params: any): Promise<void> {
  try {
    const { section, key, value, target } = params || {}
    // The shim's getConfiguration(section).update(key, value) sends
    // section + key SEPARATELY. The VS Code config store is keyed by
    // the FULL dotted path (`section.key`). Previously this handler
    // ignored `key` and called updateValue(section, value), which
    // clobbered the entire section with a scalar (e.g.
    // getConfiguration('myExt').update('flag', true) wrote
    // myExt = true instead of myExt.flag = true). Reconstruct the
    // dotted key. Either part may be absent: getConfiguration().update(
    // 'a.b', v) sends only key; getConfiguration('a.b').update('', v)
    // sends only section.
    const fullKey = [section, key].filter((p) => p != null && p !== '').join('.')
    if (!fullKey) return

    const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
    const { IConfigurationService } = await import(
      '@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration'
    )

    if (!IConfigurationService) return
    const configService = StandaloneServices.get(IConfigurationService) as any
    if (!configService?.updateValue) return

    // ConfigurationTarget: 1=Application/Global(User), 2=User, 3=Workspace,
    // 4=WorkspaceFolder. monaco-vscode-api's updateValue takes the target
    // as the 3rd arg; pass it through when the extension specified one so
    // the write lands in the right scope (User vs Workspace).
    if (target != null) {
      await configService.updateValue(fullKey, value, target)
    } else {
      await configService.updateValue(fullKey, value)
    }
    debugLog(`configuration/update: ${fullKey} = ${JSON.stringify(value)}`)
  } catch (e) {
    debugLog(`configuration/update failed: ${e}`)
  }
}

// Push the workbench's full merged configuration tree to the sidecar so
// extensions' getConfiguration().get() reads the user's / workspace's
// REAL settings instead of hardcoded defaults — and fires
// onDidChangeConfiguration when they change. Without this, the sidecar's
// _configSnapshot is empty and every read falls through to a default.
//
// We resolve IConfigurationService and call getValue() with no args,
// which VS Code defines as "the full merged configuration object" (the
// nested { editor: {...}, myExt: {...} } tree the shim walks). On the
// first call we also subscribe to onDidChangeConfiguration to re-push
// (debounced) with the changed keys so the shim can target
// affectsConfiguration precisely.
let _configSnapshotWired = false
let _configPushTimer: ReturnType<typeof setTimeout> | null = null
let _pendingAffectedKeys = new Set<string>()

async function getConfigurationService(): Promise<any | null> {
  try {
    const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
    const { IConfigurationService } = await import(
      '@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration'
    )
    if (!IConfigurationService) return null
    const svc = StandaloneServices.get(IConfigurationService) as any
    return svc ?? null
  } catch {
    return null
  }
}

async function pushConfigSnapshot(): Promise<void> {
  try {
    const configService = await getConfigurationService()
    if (!configService?.getValue) return

    // getValue() with no key returns the full merged config tree.
    const config = configService.getValue()
    sendNotification('configuration/snapshot', { config })
    debugLog('configuration/snapshot pushed')

    if (!_configSnapshotWired && typeof configService.onDidChangeConfiguration === 'function') {
      _configSnapshotWired = true
      configService.onDidChangeConfiguration((e: any) => {
        // Collect changed keys so the shim can answer
        // affectsConfiguration precisely. affectedKeys is a Set in VS
        // Code; tolerate array/iterable/undefined shapes.
        try {
          const keys = e?.affectedKeys
          if (keys) {
            for (const k of keys) _pendingAffectedKeys.add(String(k))
          }
        } catch { /* ignore malformed event */ }
        // Debounce: settings edits often fire a burst of events.
        if (_configPushTimer) clearTimeout(_configPushTimer)
        _configPushTimer = setTimeout(() => {
          _configPushTimer = null
          void pushConfigChange()
        }, 150)
      })
    }
  } catch (e) {
    debugLog(`configuration/snapshot failed: ${e}`)
  }
}

async function pushConfigChange(): Promise<void> {
  try {
    const configService = await getConfigurationService()
    if (!configService?.getValue) return
    const config = configService.getValue()
    const affectedKeys = [..._pendingAffectedKeys]
    _pendingAffectedKeys = new Set<string>()
    sendNotification('configuration/didChange', { config, affectedKeys })
    debugLog(`configuration/didChange pushed (${affectedKeys.length} keys)`)
  } catch (e) {
    debugLog(`configuration/didChange failed: ${e}`)
  }
}

// ─── Command execution handler ──────────────────────────────────────────────

async function handleCommandExecute(params: any): Promise<any> {
  try {
    const { command, args } = params || {}
    if (!command) return null

    // setContext is the canonical way extensions flip context keys
    // that gate view visibility (`when` clauses). VS Code routes it
    // through the command service AND the IContextKeyService; the
    // contributed-views module reads from its own mirror because we
    // don't yet bind monaco-vscode-api's context key service. P0:
    // mirror the value in extension-contributed-views and let the
    // command service path also fire so the workbench's own internal
    // state (file explorer hide/show, etc) sees the change.
    if (command === 'setContext' && Array.isArray(args) && args.length >= 2) {
      try {
        const cv = await import('./extension-contributed-views.ts')
        cv.setContextKey(String(args[0]), args[1])
      } catch { /* ignore */ }
      // Fall through so the command service's setContext also runs;
      // monaco-vscode-api may use it internally.
    }

    const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
    const { ICommandService } = await import(
      '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands'
    )

    if (!ICommandService) return null
    const commandService = StandaloneServices.get(ICommandService) as any
    if (!commandService?.executeCommand) return null

    return await commandService.executeCommand(command, ...(args || []))
  } catch (e) {
    debugLog(`commands/execute failed: ${e}`)
    return null
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

// Track which command ids we've already registered with the workbench
// across the lifetime of THIS frontend page. Required because
// restartExtensionHost re-runs registerAllCommandsInWorkbench but the
// Monaco/codingame action service complains "Cannot register two
// commands with the same id" if we try to register the same id twice.
// We dedupe by id here; first registration wins, subsequent ready
// events skip already-registered ids quietly.
const _workbenchRegisteredCommands = new Set<string>()

async function registerAllCommandsInWorkbench(): Promise<void> {
  const commands = [..._extensionCommands]
  debugLog(`registerAllCommandsInWorkbench: ${commands.length} commands (already-registered: ${_workbenchRegisteredCommands.size})`)
  if (commands.length === 0) return

  try {
    // Use registerAction2 — this both registers the command handler AND adds it
    // to the command palette (f1: true). CommandsRegistry alone doesn't show in palette.
    const actionsModule = await import(
      '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions'
    )

    const { Action2, registerAction2 } = actionsModule

    if (!registerAction2 || !Action2) {
      debugLog('FAILED: registerAction2 or Action2 not found in actions module')
      return
    }

    for (const cmd of commands) {
      // Skip already-registered ids without spamming the log. The
      // sidecar restart path goes through here on every install /
      // uninstall; without this guard each restart logs N "Cannot
      // register two commands with the same id" errors.
      if (_workbenchRegisteredCommands.has(cmd)) continue
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
        _workbenchRegisteredCommands.add(cmd)
        traceLog(`palette action: ${cmd} → "${title}"`)
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
        '@codingame/monaco-vscode-api/vscode/vs/platform/extensionManagement/common/extensionManagement.service'
      )
      serviceId = mod?.IExtensionManagementService
    } catch {}
    if (!serviceId) {
      try {
        const mod = await import(
          '@codingame/monaco-vscode-api/vscode/vs/platform/extensionManagement/common/extensionManagement'
        )
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
 * Remove an extension from ~/.opide/extensions/ and notify the sidecar.
 */
async function removeExtensionFromSidecar(extensionId: string): Promise<void> {
  try {
    const targetDir = await getExtensionsDirAsync()
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

// (was: sync getExtensionsDir() that read process.env.HOME — undefined in
// the WKWebView, fell back to /tmp. Replaced by getExtensionsDirAsync above.)

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
      '@codingame/monaco-vscode-api/vscode/vs/platform/extensionManagement/common/extensionManagement'
    )
    const uriModule = await import(
      '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
    )

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
