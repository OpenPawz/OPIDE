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

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatResponse {
  run_id: string
  session_id: string
}

// EngineEvent typed inline in listen() callback below

// ─── State ────────────────────────────────────────────────────────────────────

let _overlay: HTMLElement | null = null
let _runId: string | null = null
let _unlisten: UnlistenFn | null = null
let _accum = ''

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
  console.log('[opide-inline] inline edit registered as opide.inlineEdit command')
}

// ─── Show Inline Prompt ───────────────────────────────────────────────────────

function showInlinePrompt(): void {
  // Remove any existing overlay
  dismissOverlay()

  // Get selection info from the active editor
  // TODO: Wire to actual monaco editor selection when editor integration is complete
  // For now, create the UI structure — it will work once files can be opened

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
  header.innerHTML = '<span>Inline Edit (Cmd+K)</span><span style="font-size:10px;opacity:0.5">Esc to dismiss</span>'
  overlay.appendChild(header)

  // Input
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'Describe the change…'
  input.style.cssText = 'padding:10px 12px;background:var(--vscode-input-background);border:none;outline:none;color:var(--vscode-input-foreground);font-size:13px;font-family:var(--vscode-font-family)'
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const instruction = input.value.trim()
      if (instruction) {
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
  acceptBtn.textContent = 'Accept'
  acceptBtn.style.cssText = 'background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;padding:4px 12px;font-size:12px;cursor:pointer'
  acceptBtn.addEventListener('click', () => {
    // TODO: Apply the result to the editor selection
    dismissOverlay()
  })

  const rejectBtn = document.createElement('button')
  rejectBtn.textContent = 'Reject'
  rejectBtn.style.cssText = 'background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-widget-border,#333);border-radius:4px;padding:4px 12px;font-size:12px;cursor:pointer'
  rejectBtn.addEventListener('click', dismissOverlay)

  actions.appendChild(rejectBtn)
  actions.appendChild(acceptBtn)
  overlay.appendChild(actions)

  // Global escape handler
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      dismissOverlay()
      document.removeEventListener('keydown', escHandler)
    }
  }
  document.addEventListener('keydown', escHandler)

  document.body.appendChild(overlay)
  _overlay = overlay
  input.focus()
}

// ─── Execute ──────────────────────────────────────────────────────────────────

async function executeInlineEdit(instruction: string, overlay: HTMLElement): Promise<void> {
  const resultArea = overlay.querySelector('#opide-inline-result') as HTMLElement
  const actions = overlay.querySelector('#opide-inline-actions') as HTMLElement
  const input = overlay.querySelector('input') as HTMLInputElement

  if (!resultArea || !actions) return

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

  // TODO: Include actual editor selection as context
  const selectedCode = '// (no selection — open a file and select code first)'

  try {
    const response = await invoke<ChatResponse>('engine_chat_send', {
      request: {
        message: `[Selected Code]\n${selectedCode}\n\n[Instruction]\n${instruction}`,
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

// ─── Dismiss ──────────────────────────────────────────────────────────────────

function dismissOverlay(): void {
  _overlay?.remove()
  _overlay = null
  _unlisten?.()
  _unlisten = null
  _runId = null
  _accum = ''
}
