/**
 * OPIDE Ghost Completions
 *
 * Suggests code as ghost text (dimmed) after the cursor.
 * Tab to accept, Esc to dismiss.
 *
 * Uses OpenPawz engine with a lightweight completion prompt.
 * Debounced — only triggers after the user pauses typing.
 *
 * This module registers the completion infrastructure.
 * Actual editor integration (inline suggestions API) will be wired
 * when the editor pipeline is fully functional.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

// ─── Config ───────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 800      // Wait 800ms after typing stops
const MAX_CONTEXT_LINES = 50 // Send at most 50 lines of context
const ENABLED = true          // Can be toggled via settings

const COMPLETION_SYSTEM_PROMPT = `You are a code completion engine. Given code context up to the cursor position, output ONLY the next 1-5 lines of code that should follow. Rules:
- Output raw code only — no markdown, no explanations, no fences.
- Match the existing style, indentation, and patterns.
- If unsure, output nothing (empty string).
- Be conservative — only suggest when you're confident.`

// ─── State ────────────────────────────────────────────────────────────────────

let _debounceTimer: ReturnType<typeof setTimeout> | null = null
let _currentRunId: string | null = null
let _unlisten: UnlistenFn | null = null
let _lastSuggestion: string | null = null

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerGhostCompletions(): void {
  if (!ENABLED) return

  // TODO: When editor integration is complete, hook into:
  //   - monaco.editor.onDidChangeModelContent → trigger debounced completion
  //   - monaco.languages.registerInlineCompletionsProvider → show ghost text
  //   - Tab key → accept suggestion
  //   - Esc / any other key → dismiss
  //
  // For now, the infrastructure is ready. The functions below handle
  // the LLM communication. They'll be wired to the editor in a follow-up.

  console.log('[opide-completions] ghost completion engine registered (awaiting editor integration)')
}

// ─── Completion Functions (ready for editor wiring) ──────────────────────────

/**
 * Trigger a ghost completion request. Called when the user pauses typing.
 * @param codeBeforeCursor — the code in the current file up to the cursor
 * @param filePath — the file being edited
 * @param language — the language ID (e.g., "typescript", "rust")
 */
export async function requestCompletion(
  codeBeforeCursor: string,
  filePath: string,
  language: string,
): Promise<string | null> {
  // Cancel any in-flight request
  cancelCompletion()

  // Trim context to last N lines
  const lines = codeBeforeCursor.split('\n')
  const context = lines.slice(-MAX_CONTEXT_LINES).join('\n')

  return new Promise((resolve) => {
    let accum = ''

    // Listen for response
    listen<any>('engine-event', ({ payload }) => {
      if (_currentRunId && payload.run_id !== _currentRunId) return

      if (payload.kind === 'delta') {
        accum += payload.text
      } else if (payload.kind === 'complete') {
        _currentRunId = null
        const suggestion = (payload.text || accum).trim()
        _lastSuggestion = suggestion || null
        resolve(_lastSuggestion)
        _unlisten?.()
        _unlisten = null
      }
    }).then((ul) => {
      _unlisten = ul
    })

    // Send the completion request
    invoke<{ run_id: string; session_id: string }>('engine_chat_send', {
      request: {
        message: `[File: ${filePath}] [Language: ${language}]\n\n${context}`,
        system_prompt: COMPLETION_SYSTEM_PROMPT,
        tools_enabled: false,
        auto_approve_all: true,
        temperature: 0.2, // Low temperature for predictable completions
      },
    })
      .then((response) => {
        _currentRunId = response.run_id
      })
      .catch(() => {
        resolve(null)
      })
  })
}

/**
 * Cancel any in-flight completion request.
 */
export function cancelCompletion(): void {
  _currentRunId = null
  _lastSuggestion = null
  _unlisten?.()
  _unlisten = null
}

/**
 * Get the last suggestion (for applying with Tab).
 */
export function getLastSuggestion(): string | null {
  return _lastSuggestion
}

/**
 * Create a debounced completion trigger.
 * Call this on every keystroke — it only fires after DEBOUNCE_MS of silence.
 */
export function debouncedCompletion(
  codeBeforeCursor: string,
  filePath: string,
  language: string,
  onSuggestion: (suggestion: string | null) => void,
): void {
  if (_debounceTimer) clearTimeout(_debounceTimer)

  _debounceTimer = setTimeout(async () => {
    const suggestion = await requestCompletion(codeBeforeCursor, filePath, language)
    onSuggestion(suggestion)
  }, DEBOUNCE_MS)
}
