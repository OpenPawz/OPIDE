// ── OPIDE Tool Bridge ────────────────────────────────────────────────────────
// Listens for tool requests from the Rust agent engine and responds with
// data from the Monaco editor (diagnostics, selection, open files, etc.).
//
// Flow:
//   Agent calls ide_get_diagnostics → Rust emits "ide-tool-request"
//   → This module receives it → queries Monaco → calls ide_tool_response

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

interface ToolRequest {
  request_id: string
  tool: string
  args: any
}

interface EditReviewRequest {
  request_id: string
  path: string
  original_content: string
  proposed_content: string
  tool_name: string
  description: string
}

// Register the edit review listener immediately at module load — before the
// agent can start — so no review request can arrive before we're listening.
let _editReviewListenerReady: Promise<void> | null = null
let _unlistenEditReview: (() => void) | null = null
let _unlistenToolRequest: (() => void) | null = null


// Track the most recently active terminal ID so agent command output
// can be routed to the terminal panel the user already has open.
let _activeTerminalId: string | null = null

/** Called by the terminal panel whenever a terminal is spawned or focused. */
export function setActiveTerminalId(id: string): void {
  _activeTerminalId = id
}

async function sendReviewResponse(requestId: string, accepted: boolean): Promise<void> {
  try {
    await invoke('ide_edit_review_response', { requestId, accepted })
  } catch (e) {
    console.error('[opide-tool-bridge] Failed to send review response:', e)
  }
}

export function initEditReviewListener(): void {
  if (_editReviewListenerReady) return
  _editReviewListenerReady = listen<EditReviewRequest>('ide-edit-review', async (event) => {
    const req = event.payload
    console.log('[opide-tool-bridge] Edit review request:', req.path, req.request_id)
    try {
      await showEditReview(req)
    } catch (e) {
      console.error('[opide-tool-bridge] Failed to show edit review:', e)
      await sendReviewResponse(req.request_id, false)
    }
  }).then((unlisten) => {
    _unlistenEditReview = unlisten
    console.log('[opide-tool-bridge] Edit review listener registered')
  })

  // Reject all pending reviews if the window closes — prevents 120s hangs on Rust side
  window.addEventListener('beforeunload', () => {
    document.querySelectorAll<HTMLElement>('.opide-review-toolbar[data-request-id]').forEach(toolbar => {
      const requestId = toolbar.dataset.requestId
      if (requestId) {
        invoke('ide_edit_review_response', { requestId, accepted: false }).catch(() => {})
      }
    })
  })
}

export async function initToolBridge(): Promise<void> {
  // Ensure edit review listener is registered (idempotent if already called early)
  initEditReviewListener()

  const unlisten = await listen<ToolRequest>('ide-tool-request', async (event) => {
    const { request_id, tool, args } = event.payload

    try {
      const result = await handleToolRequest(tool, args)
      await invoke('ide_tool_response', {
        response: { request_id, result },
      })
    } catch (e) {
      await invoke('ide_tool_response', {
        response: { request_id, result: { error: String(e) } },
      })
    }
  })
  _unlistenToolRequest = unlisten

  // ── Agent command echo ───────────────────────────────────────────────────
  // When the agent calls ide_run_command the Rust side now executes directly
  // (no PTY bridge) and emits this event so we can display the command and
  // its output in the active terminal panel for user visibility.
  listen<{ command: string; cwd?: string; stdout: string; stderr: string; exit_code: number }>(
    'agent-command-echo',
    async (event) => {
      const { command, cwd: _cwd, stdout, stderr, exit_code } = event.payload
      if (!_activeTerminalId) return

      const output = [
        `\r\n\x1b[36m$ ${command}\x1b[0m\r\n`,
        stdout ? stdout.replace(/\n/g, '\r\n') : '',
        stderr ? `\x1b[33m${stderr.replace(/\n/g, '\r\n')}\x1b[0m` : '',
        `\x1b[90m[exit: ${exit_code}]\x1b[0m\r\n`,
      ].join('')

      // Display-only: emit as terminal-data (renders in xterm.js) NOT terminal_write
      // (which would pipe text into the shell's stdin as if the user typed it)
      try {
        const { emit } = await import('@tauri-apps/api/event')
        await emit('terminal-data', { terminal_id: _activeTerminalId, data: output })
      } catch (e) {
        console.warn('[opide-tool-bridge] agent-command-echo display failed:', e)
      }
    }
  ).catch(e => console.warn('[opide-tool-bridge] agent-command-echo listener failed:', e))

  console.log('[opide-tool-bridge] Frontend tool bridge active')
}

export function disposeToolBridge(): void {
  _unlistenToolRequest?.()
  _unlistenToolRequest = null
  _unlistenEditReview?.()
  _unlistenEditReview = null
  _editReviewListenerReady = null
  _activeTerminalId = null
  console.log('[opide-tool-bridge] Tool bridge disposed')
}

async function handleToolRequest(tool: string, args: any): Promise<any> {
  switch (tool) {
    case 'ide_get_diagnostics':
      return getDiagnostics(args?.path)

    case 'ide_get_selection':
      return getSelection()

    case 'ide_get_open_files':
      return getOpenFiles()

    case 'ide_open_file':
      return openFile(args?.path, args?.line)

    case 'ide_get_terminal_output':
      return getTerminalOutput()

    // ── Terminal execution — runs in the real PTY panel, not a background process.
    // Passwords, interactive prompts, all output visible to the user.
    // The terminal is auto-opened if none currently exists.
    case 'ide_run_command':
      return runCommandInTerminal(args?.command ?? '', args?.cwd)

    default:
      return { error: `Unknown frontend tool: ${tool}` }
  }
}

// ─── Tool Implementations ────────────────────────────────────────────────────

async function getDiagnostics(path?: string): Promise<any> {
  try {
    // Access Monaco's marker service for diagnostics
    const monaco = await import('monaco-editor')
    const models = path
      ? [monaco.editor.getModel(monaco.Uri.file(path))].filter(Boolean)
      : monaco.editor.getModels()

    const diagnostics: any[] = []
    for (const model of models) {
      if (!model) continue
      const markers = monaco.editor.getModelMarkers({ resource: model.uri })
      for (const m of markers) {
        diagnostics.push({
          path: model.uri.fsPath || model.uri.path,
          line: m.startLineNumber,
          column: m.startColumn,
          end_line: m.endLineNumber,
          severity: m.severity === 8 ? 'error' : m.severity === 4 ? 'warning' : 'info',
          message: m.message,
          source: m.source || '',
        })
      }
    }
    return { diagnostics, count: diagnostics.length }
  } catch (e) {
    return { diagnostics: [], count: 0, error: String(e) }
  }
}

async function getSelection(): Promise<any> {
  try {
    const { getService, ICodeEditorService } = await import(
      '@codingame/monaco-vscode-api/services'
    )
    const editorService = (await getService(ICodeEditorService)) as any
    const editor = editorService?.getActiveCodeEditor?.()
    if (!editor) return { text: null, range: null }

    const selection = editor.getSelection?.()
    if (!selection || selection.isEmpty?.()) return { text: null, range: null }

    const model = editor.getModel?.()
    const text = model?.getValueInRange(selection) || ''

    return {
      text,
      path: model?.uri?.fsPath || model?.uri?.path || null,
      range: {
        start_line: selection.startLineNumber,
        start_column: selection.startColumn,
        end_line: selection.endLineNumber,
        end_column: selection.endColumn,
      },
    }
  } catch (e) {
    return { text: null, range: null, error: String(e) }
  }
}

async function getOpenFiles(): Promise<any> {
  try {
    const { getService, ICodeEditorService } = await import(
      '@codingame/monaco-vscode-api/services'
    )
    const editorService = (await getService(ICodeEditorService)) as any
    const editors: any[] = Array.from(editorService?.listCodeEditors?.() || [])

    const files: string[] = []
    for (const ed of editors) {
      const model = ed.getModel?.()
      if (!model) continue
      const uri = model.uri
      if (uri.scheme !== 'file') continue
      const p = uri.fsPath || uri.path
      if (p && !files.includes(p)) files.push(p)
    }

    return { files, count: files.length }
  } catch (e) {
    return { files: [], count: 0, error: String(e) }
  }
}

async function openFile(path: string, line?: number): Promise<any> {
  try {
    const { getService, IEditorService } = await import(
      '@codingame/monaco-vscode-api/services'
    )
    const monaco = await import('monaco-editor')
    const editorService = (await getService(IEditorService)) as any

    const options: any = {}
    if (line) {
      options.selection = {
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: 1,
      }
    }

    await editorService.openEditor({
      resource: monaco.Uri.file(path),
      options,
    })

    return { opened: path, line: line || null }
  } catch (e) {
    return { error: String(e) }
  }
}

// ─── Edit Review (Monaco Diff Editor) ───────────────────────────────────────

async function showEditReview(req: EditReviewRequest): Promise<void> {
  const monaco = await import('monaco-editor')

  const fileName = req.path.split('/').pop() || req.path
  const originalUri = monaco.Uri.parse(`inmemory://review/original/${req.request_id}/${fileName}`)
  const proposedUri = monaco.Uri.parse(`inmemory://review/proposed/${req.request_id}/${fileName}`)

  // Detect language from file extension
  const ext = fileName.split('.').pop() || ''
  const langMap: Record<string, string> = {
    rs: 'rust', ts: 'typescript', tsx: 'typescriptreact', js: 'javascript',
    jsx: 'javascriptreact', css: 'css', html: 'html', json: 'json',
    toml: 'toml', md: 'markdown', py: 'python', go: 'go', yaml: 'yaml', yml: 'yaml',
  }
  const lang = langMap[ext] || ext

  // Create models — inside try/catch so any exception is handled and review still shows
  let originalModel: any
  let proposedModel: any
  try {
    originalModel = monaco.editor.createModel(req.original_content, lang, originalUri)
    proposedModel = monaco.editor.createModel(req.proposed_content, lang, proposedUri)
  } catch (e) {
    console.error('[edit-review] Failed to create diff models:', e)
    sendReviewResponse(req.request_id, false)
    return
  }

  // Try to open via IEditorService (integrates with VS Code workbench tabs)
  try {
    const { getService, IEditorService } = await import('@codingame/monaco-vscode-api/services')
    const editorService = (await getService(IEditorService)) as any

    await editorService.openEditor({
      original: { resource: originalUri },
      modified: { resource: proposedUri },
      label: `Review: ${fileName}`,
      description: req.description,
    })
  } catch (e) {
    console.warn('[edit-review] Could not open diff via IEditorService, using standalone:', e)
    // Fallback: create standalone diff editor in overlay
    try {
      openStandaloneDiffEditor(originalModel, proposedModel, req, fileName)
    } catch (e2) {
      console.error('[edit-review] Standalone diff editor also failed:', e2)
      // Last resort: native browser confirm so the user at least gets a choice
      const accepted = window.confirm(
        `OPIDE wants to write to:\n${req.path}\n\n${req.description}\n\nAccept this change?`
      )
      await sendReviewResponse(req.request_id, accepted)
    }
    return
  }

  // Show floating accept/reject toolbar
  showReviewToolbar(req, originalModel, proposedModel, fileName)
}

function showReviewToolbar(
  req: EditReviewRequest,
  originalModel: any,
  proposedModel: any,
  fileName: string,
): void {
  const toolbar = document.createElement('div')
  toolbar.className = 'opide-review-toolbar'
  toolbar.dataset.requestId = req.request_id
  toolbar.style.cssText = `
    position: fixed; bottom: 48px; left: 50%; transform: translateX(-50%);
    display: flex; gap: 8px; align-items: center;
    padding: 8px 16px; background: #1e1e1e; border: 1px solid #E8B931;
    border-radius: 8px; z-index: 10000; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  `

  const label = document.createElement('span')
  label.style.cssText = 'color: #ccc; font-size: 12px; margin-right: 8px;'
  label.textContent = `Review: ${fileName}`

  const acceptBtn = document.createElement('button')
  acceptBtn.textContent = '✓ Accept'
  acceptBtn.style.cssText = `
    padding: 6px 16px; border: none; border-radius: 4px; cursor: pointer;
    font-size: 12px; font-weight: 600; background: #2ea043; color: #fff;
  `

  const rejectBtn = document.createElement('button')
  rejectBtn.textContent = '✗ Reject'
  rejectBtn.style.cssText = `
    padding: 6px 16px; border: none; border-radius: 4px; cursor: pointer;
    font-size: 12px; font-weight: 600; background: #da3633; color: #fff;
  `

  const cleanup = () => {
    toolbar.remove()
    originalModel.dispose()
    proposedModel.dispose()
  }

  acceptBtn.addEventListener('click', async () => {
    acceptBtn.textContent = 'Applying...'
    acceptBtn.disabled = true
    await invoke('ide_edit_review_response', { requestId: req.request_id, accepted: true })
    cleanup()
  })

  rejectBtn.addEventListener('click', async () => {
    rejectBtn.textContent = 'Rejected'
    rejectBtn.disabled = true
    await invoke('ide_edit_review_response', { requestId: req.request_id, accepted: false })
    cleanup()
  })

  toolbar.appendChild(label)
  toolbar.appendChild(acceptBtn)
  toolbar.appendChild(rejectBtn)
  document.body.appendChild(toolbar)
}

function openStandaloneDiffEditor(
  originalModel: any,
  proposedModel: any,
  req: EditReviewRequest,
  fileName: string,
): void {
  // Fallback: full-screen overlay with standalone diff editor
  const overlay = document.createElement('div')
  overlay.className = 'opide-review-overlay'
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: #1e1e1e; display: flex; flex-direction: column;
  `

  const header = document.createElement('div')
  header.style.cssText = `
    padding: 8px 16px; background: #252526; border-bottom: 1px solid #E8B931;
    display: flex; justify-content: space-between; align-items: center;
  `
  header.innerHTML = `<span style="color:#E8B931;font-size:13px;font-weight:600">Review: ${fileName}</span>`

  const btnRow = document.createElement('div')
  btnRow.style.cssText = 'display:flex;gap:8px;'

  const acceptBtn = document.createElement('button')
  acceptBtn.textContent = '✓ Accept'
  acceptBtn.style.cssText = 'padding:6px 16px;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;background:#2ea043;color:#fff;'

  const rejectBtn = document.createElement('button')
  rejectBtn.textContent = '✗ Reject'
  rejectBtn.style.cssText = 'padding:6px 16px;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;background:#da3633;color:#fff;'

  btnRow.appendChild(acceptBtn)
  btnRow.appendChild(rejectBtn)
  header.appendChild(btnRow)
  overlay.appendChild(header)

  const editorContainer = document.createElement('div')
  editorContainer.style.cssText = 'flex:1;'
  overlay.appendChild(editorContainer)
  document.body.appendChild(overlay)

  const diffEditor = (window as any).monaco?.editor?.createDiffEditor?.(editorContainer, {
    readOnly: true,
    renderSideBySide: true,
    automaticLayout: true,
    theme: 'vs-dark',
  })

  if (diffEditor) {
    diffEditor.setModel({ original: originalModel, modified: proposedModel })
  }

  const cleanup = () => {
    if (diffEditor) diffEditor.dispose()
    originalModel.dispose()
    proposedModel.dispose()
    overlay.remove()
  }

  acceptBtn.addEventListener('click', async () => {
    acceptBtn.textContent = 'Applying...'
    acceptBtn.disabled = true
    await invoke('ide_edit_review_response', { requestId: req.request_id, accepted: true })
    cleanup()
  })

  rejectBtn.addEventListener('click', async () => {
    rejectBtn.textContent = 'Rejected'
    rejectBtn.disabled = true
    await invoke('ide_edit_review_response', { requestId: req.request_id, accepted: false })
    cleanup()
  })
}

// ─── Terminal Command Execution ─────────────────────────────────────────────

/** Strip ANSI escape sequences so the agent gets clean text. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
            .replace(/\x1b[@-Z\\-_]/g, '')
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

/** Create a new terminal panel if none is currently open. */
async function autoOpenTerminal(): Promise<void> {
  try {
    // VS Code terminal service — creates a real PTY-backed panel tab
    const { getService } = await import('@codingame/monaco-vscode-api/services')
    const { ITerminalService } = await import('@codingame/monaco-vscode-terminal-service-override')
    const termService = (await getService(ITerminalService as any)) as any
    await termService?.createTerminal?.({ config: { name: '▶ OPIDE' } })
    // Give the PTY a moment to initialise and setActiveTerminalId to fire
    await new Promise(r => setTimeout(r, 800))
  } catch (e) {
    console.warn('[opide-tool-bridge] Auto-open terminal failed:', e)
  }
}

/**
 * Run a shell command in the visible PTY terminal panel.
 * - Auto-opens a terminal tab if none exists.
 * - Output streams in real time so the user can see it (and type passwords).
 * - Returns { exit_code, stdout } to the agent when done.
 */
async function runCommandInTerminal(command: string, _cwd?: string): Promise<any> {
  if (!command) return { error: 'No command provided', exit_code: -1, stdout: '' }

  // Auto-open a terminal if none is currently active
  if (!_activeTerminalId) {
    await autoOpenTerminal()
  }

  const terminalId = _activeTerminalId
  if (!terminalId) {
    return { error: 'No terminal available — could not open one automatically', exit_code: -1, stdout: '' }
  }

  // Use a unique marker so we can detect when the command finishes
  const marker = `__OPIDE_${Date.now()}_DONE__`

  const outputChunks: string[] = []
  let exitCode = -1
  let done = false

  // Listen to terminal-data events for this terminal
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen<{ terminal_id: string; data: string }>('terminal-data', (event) => {
    if (event.payload.terminal_id !== terminalId) return
    const chunk = event.payload.data
    outputChunks.push(chunk)
    // Detect our exit marker: marker:exitcode
    const match = chunk.match(new RegExp(`${marker}:(\\d+)`))
    if (match) {
      exitCode = parseInt(match[1], 10)
      done = true
    }
  })

  try {
    // Write the command wrapped with an exit-code marker so we know when it's done.
    // The semicolon ensures the marker always runs even if the command fails.
    await invoke('terminal_write', {
      terminalId,
      data: `${command}; echo "${marker}:$?"\n`,
    })

    // Poll until the marker appears or we hit the 5-minute timeout
    const deadline = Date.now() + 300_000
    while (!done && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 150))
    }

    if (!done) {
      return { error: 'Command timed out after 5 minutes', exit_code: -1, stdout: stripAnsi(outputChunks.join('')) }
    }

    // Clean up output: strip ANSI, remove the marker echo line itself
    const raw = stripAnsi(outputChunks.join(''))
    const stdout = raw
      .split('\n')
      .filter(line => !line.includes(marker))
      .join('\n')
      .trim()

    return { exit_code: exitCode, stdout, stderr: '' }
  } finally {
    unlisten()
  }
}

// ─── Terminal Output ────────────────────────────────────────────────────────

async function getTerminalOutput(): Promise<any> {
  try {
    // Import from ide-context which tracks recent terminal output
    const { _recentTerminalOutput } = await import('./ide-context.ts') as any
    return {
      output: _recentTerminalOutput || '(no recent terminal output)',
    }
  } catch {
    return { output: '(terminal output not available)' }
  }
}
