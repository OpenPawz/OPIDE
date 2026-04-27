/**
 * OPIDE Ghost Completions
 *
 * Suggests code as ghost text (dimmed) after the cursor.
 * Tab to accept, Esc to dismiss.
 *
 * Uses OpenPawz engine with a lightweight completion prompt.
 * Debounced — only triggers after the user pauses typing.
 *
 * Registers as a Monaco InlineCompletionsProvider so suggestions
 * appear as native ghost text in the editor.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getService, ICodeEditorService } from '@codingame/monaco-vscode-api/services'

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_CONTEXT_LINES = 50 // Send at most 50 lines of context

// Hidden persistent session id used for completion requests so we don't create
// an orphan session per keystroke. Filtered out of the session selector (B49).
const COMPLETION_SESSION_ID = '__opide_completions__'

/** Read enable state from VS Code config. Default: enabled. */
async function isCompletionsEnabled(): Promise<boolean> {
  try {
    const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
    const { IConfigurationService } = await import(
      '@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration'
    )
    const cfg = StandaloneServices.get(IConfigurationService) as any
    const v = cfg?.getValue?.('opide.completions.enabled')
    return v !== false
  } catch {
    return true
  }
}

const COMPLETION_SYSTEM_PROMPT = `You are a code completion engine. Given code context up to the cursor position, output ONLY the next 1-5 lines of code that should follow. Rules:
- Output raw code only — no markdown, no explanations, no fences.
- Match the existing style, indentation, and patterns.
- If unsure, output nothing (empty string).
- Be conservative — only suggest when you're confident.`

// ─── State ────────────────────────────────────────────────────────────────────

let _lastSuggestion: string | null = null
let _providerDisposable: any = null

// Single shared listener for all completion runs. Each in-flight request
// registers itself in `_completionResolvers` keyed by run_id, so events route
// to the right caller without stacking listeners (B50).
let _completionListener: UnlistenFn | null = null
const _completionResolvers = new Map<string, (suggestion: string | null) => void>()
const _completionAccum = new Map<string, string>()

async function ensureCompletionListener(): Promise<void> {
  if (_completionListener) return
  _completionListener = await listen<any>('engine-event', ({ payload }) => {
    if (!payload?.run_id) return
    const resolve = _completionResolvers.get(payload.run_id)
    if (!resolve) return
    if (payload.kind === 'delta') {
      const cur = _completionAccum.get(payload.run_id) ?? ''
      _completionAccum.set(payload.run_id, cur + payload.text)
    } else if (payload.kind === 'complete') {
      const text = (payload.text || _completionAccum.get(payload.run_id) || '').trim()
      _completionAccum.delete(payload.run_id)
      _completionResolvers.delete(payload.run_id)
      _lastSuggestion = text || null
      resolve(_lastSuggestion)
    }
  })
}

// ─── Registration ─────────────────────────────────────────────────────────────

export async function registerGhostCompletions(): Promise<void> {
  if (!await isCompletionsEnabled()) {
    console.log('[opide-completions] disabled via opide.completions.enabled — not registering')
    return
  }

  // We need to wait for the editor service to be available, then register
  // our inline completion provider on all languages.
  registerInlineProvider().catch((e) => {
    console.warn('[opide-completions] initial registration deferred, retrying in 3s:', e)
    setTimeout(() => registerInlineProvider().catch(console.warn), 3000)
  })

  console.log('[opide-completions] ghost completion engine registered')
}

async function registerInlineProvider(): Promise<void> {
  const monaco = await import('monaco-editor')
  const editorService = await getService(ICodeEditorService)

  // Dispose previous registration if re-registering
  _providerDisposable?.dispose()

  // Register for all languages (wildcard).
  // Monaco already debounces provideInlineCompletions and supplies a
  // CancellationToken — drop the in-handler debounce (B51).
  _providerDisposable = monaco.languages.registerInlineCompletionsProvider(
    { pattern: '**' },
    {
      provideInlineCompletions: async (model: any, position: any, _context: any, token: any) => {
        const activeEditor = (editorService as any).getActiveCodeEditor?.()
        if (!activeEditor || activeEditor.getModel?.() !== model) {
          return { items: [] }
        }
        if (token.isCancellationRequested) return { items: [] }

        const range = new (monaco as any).Range(1, 1, position.lineNumber, position.column)
        const codeBeforeCursor = model.getValueInRange(range)
        const language = model.getLanguageId()
        const filePath = model.uri.fsPath || model.uri.path

        // Note: cancellation propagates by abandoning the result if the token
        // fires before requestCompletion resolves.
        let cancelled = false
        token.onCancellationRequested?.(() => { cancelled = true })

        const suggestion = await requestCompletion(codeBeforeCursor, filePath, language)
        if (cancelled || !suggestion) return { items: [] }

        return {
          items: [{
            insertText: suggestion,
            range: new (monaco as any).Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column,
            ),
          }],
        }
      },

      freeInlineCompletions: () => {
        // Nothing to clean up
      },
    },
  )

  console.log('[opide-completions] inline completion provider registered on all languages')
}

// ─── Completion Functions ───────────────────────────────────────────────────

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
  // Trim context to last N lines
  const lines = codeBeforeCursor.split('\n')
  const context = lines.slice(-MAX_CONTEXT_LINES).join('\n')

  await ensureCompletionListener()

  return new Promise((resolve) => {
    // Pin to a hidden persistent session so we don't create an orphan session
    // per keystroke (B49).
    invoke<{ run_id: string; session_id: string }>('engine_chat_send', {
      request: {
        session_id: COMPLETION_SESSION_ID,
        message: `[File: ${filePath}] [Language: ${language}]\n\n${context}`,
        system_prompt: COMPLETION_SYSTEM_PROMPT,
        tools_enabled: false,
        auto_approve_all: true,
        temperature: 0.2,
      },
    })
      .then((response) => {
        _completionResolvers.set(response.run_id, resolve)
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
  _lastSuggestion = null
  // Resolve all pending resolvers as null and drop their accumulators.
  for (const [, resolve] of _completionResolvers) {
    try { resolve(null) } catch {}
  }
  _completionResolvers.clear()
  _completionAccum.clear()
}

/**
 * Get the last suggestion (for applying with Tab).
 */
export function getLastSuggestion(): string | null {
  return _lastSuggestion
}

// (was: debouncedCompletion + module-level _debounceTimer / DEBOUNCE_MS — dead
// in OSS, replaced by Monaco's built-in inline-completion debounce + the
// CancellationToken-aware path in registerInlineProvider.)
