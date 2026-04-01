/**
 * OPIDE Inline Edit — Cmd+K
 *
 * Select code → press Cmd+K → type instruction → agent returns edited code
 * with inline diff preview. Accept or reject.
 *
 * Uses OpenPawz engine_chat_send with the selection as context.
 * Streams via engine-event for real-time feedback.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getService, ICodeEditorService } from '@codingame/monaco-vscode-api/services'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatResponse {
  run_id: string
  session_id: string
}

interface CapturedSelection {
  text: string
  range: any // Monaco IRange
  editor: any // ICodeEditor
  model: any // ITextModel
  filePath: string
  language: string
}

// ─── State ────────────────────────────────────────────────────────────────────

let _overlay: HTMLElement | null = null
let _runId: string | null = null
let _unlisten: UnlistenFn | null = null
let _accum = ''
let _captured: CapturedSelection | null = null

const INLINE_SYSTEM_PROMPT = `You are OPIDE's inline code editor. The user has selected code and wants you to modify it.

Rules:
- Output ONLY the replacement code. No explanations, no markdown fences, no commentary.
- Preserve the original indentation style.
- If the instruction is unclear, make your best guess — the user can reject and retry.
- Never output anything except the replacement code.`

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerInlineEdit(): void {
  // Register as a VS Code command so it can be invoked from the command palette
  // or bound to a keybinding (Cmd+K is handled by VS Code's chord system).
  import('@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands').then(({ CommandsRegistry }) => {
    CommandsRegistry.registerCommand('opide.inlineEdit', () => showInlinePrompt())
  }).catch(console.warn)

  // Also register Cmd+K keybinding directly on the editor
  registerKeybinding().catch(console.warn)

  console.log('[opide-inline] inline edit registered as opide.inlineEdit command')
}

async function registerKeybinding(): Promise<void> {
  try {
    const editorService = await getService(ICodeEditorService)

    // Wire keybinding on each editor that gets created
    const wireEditor = (editor: any) => {
      // Monaco KeyMod.CtrlCmd | KeyCode.KeyK
      editor.addCommand?.(2048 /* CtrlCmd */ | 41 /* KeyK */, () => {
        showInlinePrompt()
      })
    }

    // Wire existing editors
    const existing: any[] = Array.from((editorService as any).listCodeEditors?.() || [])
    for (const ed of existing) wireEditor(ed)

    // Wire future editors
    ;(editorService as any).onCodeEditorAdd?.((editor: any) => wireEditor(editor))
  } catch (e) {
    console.debug('[opide-inline] keybinding registration deferred:', e)
  }
}

// ─── Capture Current Selection ───────────────────────────────────────────────

async function captureSelection(): Promise<CapturedSelection | null> {
  try {
    const editorService = await getService(ICodeEditorService)
    const editor = (editorService as any).getActiveCodeEditor?.()
    if (!editor) return null

    const model = editor.getModel?.()
    if (!model) return null

    const selection = editor.getSelection?.()
    if (!selection || selection.isEmpty?.()) return null

    const text = model.getValueInRange(selection)
    if (!text.trim()) return null

    const uri = model.uri
    const filePath = uri.fsPath || uri.path
    const language = model.getLanguageId?.() ?? 'unknown'

    return { text, range: selection, editor, model, filePath, language }
  } catch (e) {
    console.warn('[opide-inline] captureSelection failed:', e)
    return null
  }
}

// ─── Show Inline Prompt ───────────────────────────────────────────────────────

async function showInlinePrompt(): Promise<void> {
  // Remove any existing overlay
  dismissOverlay()

  // Capture the current editor selection
  _captured = await captureSelection()

  const overlay = document.createElement('div')
  overlay.id = 'opide-inline-edit'
  overlay.style.cssText = [
    'position:fixed',
    'top:50%',
    'left:50%',
    'transform:translate(-50%,-50%)',
    'width:500px',
    'background:var(--vscode-editorWidget-background,#252526)',
    'border:1px solid var(--vscode-editorWidget-border,#454545)',
    'border-radius:8px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.4)',
    'z-index:10000',
    'display:flex',
    'flex-direction:column',
    'overflow:hidden',
  ].join(';')

  // Header
  const header = document.createElement('div')
  header.style.cssText = 'padding:8px 12px;font-size:11px;font-weight:600;color:var(--vscode-foreground);border-bottom:1px solid var(--vscode-widget-border,#333);display:flex;justify-content:space-between;align-items:center'

  const selectionInfo = _captured
    ? `<span style="font-size:10px;opacity:0.7;margin-left:8px">${_captured.filePath.split('/').pop()} · ${_captured.text.split('\n').length} lines</span>`
    : '<span style="font-size:10px;opacity:0.5;margin-left:8px">⚠ No selection — select code first</span>'

  header.innerHTML = `<span>Inline Edit (Cmd+K)${selectionInfo}</span><span style="font-size:10px;opacity:0.5">Esc to dismiss</span>`
  overlay.appendChild(header)

  // Show captured selection preview
  if (_captured) {
    const preview = document.createElement('div')
    preview.style.cssText = 'padding:6px 12px;font-family:var(--vscode-editor-font-family,monospace);font-size:11px;line-height:1.4;white-space:pre-wrap;max-height:120px;overflow-y:auto;background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-foreground);opacity:0.7;border-bottom:1px solid var(--vscode-widget-border,#333)'
    // Show first 10 lines of selection
    const lines = _captured.text.split('\n')
    const truncated = lines.length > 10 ? lines.slice(0, 10).join('\n') + `\n... (${lines.length - 10} more lines)` : _captured.text
    preview.textContent = truncated
    overlay.appendChild(preview)
  }

  // Input
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = _captured ? 'Describe the change…' : 'Select code first, then press Cmd+K'
  input.disabled = !_captured
  input.style.cssText = 'padding:10px 12px;background:var(--vscode-input-background);border:none;outline:none;color:var(--vscode-input-foreground);font-size:13px;font-family:var(--vscode-font-family)'
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const instruction = input.value.trim()
      if (instruction && _captured) {
        executeInlineEdit(instruction, overlay)
      }
    }
    if (e.key === 'Escape') {
      dismissOverlay()
    }
  })
  overlay.appendChild(input)

  // Result area (hidden until response comes in)
  const resultArea = document.createElement('div')
  resultArea.id = 'opide-inline-result'
  resultArea.style.cssText = 'display:none;max-height:300px;overflow-y:auto;padding:8px 12px;font-family:var(--vscode-editor-font-family,monospace);font-size:12px;line-height:1.5;white-space:pre-wrap;color:var(--vscode-foreground)'
  overlay.appendChild(resultArea)

  // Action buttons (hidden until response)
  const actions = document.createElement('div')
  actions.id = 'opide-inline-actions'
  actions.style.cssText = 'display:none;padding:8px 12px;border-top:1px solid var(--vscode-widget-border,#333);gap:6px;justify-content:flex-end'

  const acceptBtn = document.createElement('button')
  acceptBtn.textContent = 'Accept (Enter)'
  acceptBtn.style.cssText = 'background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;padding:4px 12px;font-size:12px;cursor:pointer'
  acceptBtn.addEventListener('click', () => applyAndDismiss())

  const rejectBtn = document.createElement('button')
  rejectBtn.textContent = 'Reject (Esc)'
  rejectBtn.style.cssText = 'background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-widget-border,#333);border-radius:4px;padding:4px 12px;font-size:12px;cursor:pointer'
  rejectBtn.addEventListener('click', dismissOverlay)

  actions.appendChild(rejectBtn)
  actions.appendChild(acceptBtn)
  overlay.appendChild(actions)

  // Global key handler for accept/reject when result is showing
  const keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      dismissOverlay()
      document.removeEventListener('keydown', keyHandler)
    }
    if (e.key === 'Enter' && actions.style.display === 'flex') {
      applyAndDismiss()
      document.removeEventListener('keydown', keyHandler)
    }
  }
  document.addEventListener('keydown', keyHandler)

  document.body.appendChild(overlay)
  _overlay = overlay
  input.focus()
}

// ─── Execute ──────────────────────────────────────────────────────────────────

async function executeInlineEdit(instruction: string, overlay: HTMLElement): Promise<void> {
  const resultArea = overlay.querySelector('#opide-inline-result') as HTMLElement
  const actions = overlay.querySelector('#opide-inline-actions') as HTMLElement
  const input = overlay.querySelector('input') as HTMLInputElement

  if (!resultArea || !actions || !_captured) return

  input.disabled = true
  resultArea.style.display = 'block'
  resultArea.textContent = '⏳ Thinking…'
  _accum = ''

  // Listen for streaming events
  _unlisten = await listen<any>('engine-event', ({ payload }) => {
    if (_runId && payload.run_id !== _runId) return

    if (payload.kind === 'delta') {
      _accum += payload.text
      resultArea.textContent = _accum
      resultArea.scrollTop = resultArea.scrollHeight
    } else if (payload.kind === 'complete') {
      resultArea.textContent = payload.text || _accum
      actions.style.display = 'flex'
      _unlisten?.()
      _unlisten = null
      _runId = null
    }
  })

  // Include actual editor selection as context
  const selectedCode = _captured.text

  try {
    const response = await invoke<ChatResponse>('engine_chat_send', {
      request: {
        message: `[File: ${_captured.filePath}] [Language: ${_captured.language}]\n\n[Selected Code]\n${selectedCode}\n\n[Instruction]\n${instruction}`,
        system_prompt: INLINE_SYSTEM_PROMPT,
        tools_enabled: false,
        auto_approve_all: true,
      },
    })
    _runId = response.run_id
  } catch (err) {
    resultArea.textContent = `Error: ${err}`
    actions.style.display = 'flex'
    _unlisten?.()
    _unlisten = null
  }
}

// ─── Apply Result to Editor ──────────────────────────────────────────────────

async function applyAndDismiss(): Promise<void> {
  if (!_captured || !_overlay) {
    dismissOverlay()
    return
  }

  const resultArea = _overlay.querySelector('#opide-inline-result') as HTMLElement
  const newCode = resultArea?.textContent?.trim()
  if (!newCode || newCode === '⏳ Thinking…') {
    dismissOverlay()
    return
  }

  try {
    const { editor, range, model } = _captured

    // Verify the editor and model are still valid
    if (!editor.getModel?.() || editor.getModel() !== model) {
      console.warn('[opide-inline] editor/model changed since capture — cannot apply')
      dismissOverlay()
      return
    }

    // Apply the edit as an undoable operation
    editor.executeEdits('opide-inline-edit', [{
      range,
      text: newCode,
      forceMoveMarkers: true,
    }])

    // Move cursor to end of inserted text
    const newLines = newCode.split('\n')
    const endLine = range.startLineNumber + newLines.length - 1
    const endCol = newLines.length === 1
      ? range.startColumn + newCode.length
      : newLines[newLines.length - 1].length + 1

    const monaco = await import('monaco-editor')
    editor.setPosition?.(new (monaco as any).Position(endLine, endCol))
    editor.revealPositionInCenter?.(new (monaco as any).Position(endLine, endCol))

    console.log('[opide-inline] edit applied successfully')
  } catch (e) {
    console.warn('[opide-inline] failed to apply edit:', e)
  }

  dismissOverlay()
}

// ─── Dismiss ──────────────────────────────────────────────────────────────────

function dismissOverlay(): void {
  _overlay?.remove()
  _overlay = null
  _unlisten?.()
  _unlisten = null
  _runId = null
  _accum = ''
  _captured = null

  // Return focus to editor
  getService(ICodeEditorService).then((svc: any) => {
    svc.getActiveCodeEditor?.()?.focus?.()
  }).catch(() => {})
}
