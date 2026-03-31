/**
 * OPIDE Editor Integration
 *
 * Subscribes to Monaco editor events and feeds them into ide-context.ts so the
 * agent always knows: active file, current selection, and open tabs.
 *
 * Also exports `applyCodeToEditor()` so the "Apply" button in the chat panel
 * can write code directly into the active editor — replacing the selection if
 * one exists, or the whole file otherwise.
 */

import { getService, ICodeEditorService } from '@codingame/monaco-vscode-api/services'
import {
  setActiveFile,
  setSelection,
  setOpenTabs,
  setWorkspacePath,
} from './ide-context.ts'
import { getWorkspacePath } from './workspace.ts'
import {
  notifyActiveEditorChanged,
  notifyFileOpened,
  notifyFileChanged,
  notifyFileClosed,
  isExtensionHostRunning,
} from './extension-bridge.ts'

// ─── Module-level service reference (set after init) ─────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _editorService: any = null

// ─── Helpers ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function updateFromEditor(editor: any): void {
  if (!editor) {
    setActiveFile(null, null)
    setSelection(null)
    if (isExtensionHostRunning()) notifyActiveEditorChanged(null)
    return
  }

  const model = editor.getModel?.()
  if (!model) {
    setActiveFile(null, null)
    setSelection(null)
    if (isExtensionHostRunning()) notifyActiveEditorChanged(null)
    return
  }

  const uri = model.uri
  if (uri.scheme !== 'file') {
    setActiveFile(null, null)
    return
  }
  const path: string = uri.fsPath || uri.path
  const lang: string = model.getLanguageId?.() ?? 'unknown'
  setActiveFile(path, lang)

  // Notify extension host sidecar with full content (for sync getText())
  if (isExtensionHostRunning()) {
    const content = model.getValue?.() || ''
    const version = model.getVersionId?.() ?? 1
    const sel = editor.getSelection?.()
    const selection = sel ? {
      anchor: { line: sel.startLineNumber - 1, character: sel.startColumn - 1 },
      active: { line: sel.endLineNumber - 1, character: sel.endColumn - 1 },
    } : undefined
    const opts = editor.getOptions?.()
    const tabSize = opts?.get?.(/* EditorOption.tabSize */ 51) ?? 2
    const insertSpaces = opts?.get?.(/* EditorOption.insertSpaces */ 56) ?? true
    notifyActiveEditorChanged(path, lang, content, version, selection, { tabSize, insertSpaces })
  }

  syncSelection(editor)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function syncSelection(editor: any): void {
  const selection = editor.getSelection?.()
  if (!selection || selection.isEmpty?.()) {
    setSelection(null)
    return
  }
  const model = editor.getModel?.()
  if (!model) return

  const text: string = model.getValueInRange(selection)
  setSelection(text, selection.startLineNumber, selection.endLineNumber)
}

function refreshOpenTabs(): void {
  if (!_editorService) return
  const editors: any[] = Array.from(_editorService.listCodeEditors())
  const paths: string[] = []
  for (const ed of editors) {
    const model = ed.getModel?.()
    if (!model) continue
    const uri = model.uri
    // Only include real disk files (scheme === 'file')
    if (uri.scheme !== 'file') continue
    const p: string = uri.fsPath || uri.path
    if (p && !paths.includes(p)) paths.push(p)
  }
  setOpenTabs(paths)
}

// ─── Registration ─────────────────────────────────────────────────────────────

export async function initEditorIntegration(): Promise<void> {
  try {
    _editorService = await getService(ICodeEditorService)

    // Workspace path from URL hash
    setWorkspacePath(getWorkspacePath())

    // Sync from whatever editor is already active on boot
    updateFromEditor(_editorService.getActiveCodeEditor())
    refreshOpenTabs()

    // Wire events on editors that already exist (created before our listener)
    function wireEditorEvents(editor: any): void {
      editor.onDidChangeModel?.((e: any) => {
        if (editor === _editorService.getActiveCodeEditor()) {
          updateFromEditor(editor)
        }
        refreshOpenTabs()
        if (isExtensionHostRunning()) {
          if (e?.oldModelUrl?.fsPath) notifyFileClosed(e.oldModelUrl.fsPath)
          const newModel = editor.getModel?.()
          if (newModel?.uri?.scheme === 'file') {
            const p = newModel.uri.fsPath || newModel.uri.path
            notifyFileOpened(p, newModel.getLanguageId?.() ?? 'plaintext', newModel.getValue?.() || '')
          }
        }
      })

      editor.onDidChangeModelContent?.(() => {
        if (isExtensionHostRunning() && editor === _editorService.getActiveCodeEditor()) {
          const m = editor.getModel?.()
          if (m?.uri?.scheme === 'file') {
            notifyFileChanged(m.uri.fsPath || m.uri.path, m.getValue?.() || '', m.getVersionId?.() ?? 1)
          }
        }
      })

      editor.onDidFocusEditorWidget?.(() => {
        updateFromEditor(editor)
        const selDisp = editor.onDidChangeCursorSelection?.(() => syncSelection(editor))
        editor.onDidBlurEditorWidget?.(() => selDisp?.dispose())
      })
    }

    // Wire existing editors
    const existingEditors: any[] = Array.from(_editorService.listCodeEditors?.() || [])
    for (const ed of existingEditors) {
      wireEditorEvents(ed)
    }

    // Track each new editor that gets created (file opened in a new tab/pane)
    _editorService.onCodeEditorAdd((editor: any) => {
      refreshOpenTabs()
      wireEditorEvents(editor)
    })

    // When an editor tab is closed
    _editorService.onCodeEditorRemove(() => {
      refreshOpenTabs()
    })

    console.log('[opide-editor] editor integration active')
  } catch (e) {
    console.warn('[opide-editor] init failed:', e)
  }
}

// ─── Apply Code to Editor ─────────────────────────────────────────────────────

/**
 * Apply a code string to the active editor.
 *
 * - If the user has an active selection → replace just that range.
 * - If no selection → replace the entire file content.
 * - Returns true on success, false if no editor is open.
 */
export async function applyCodeToEditor(code: string): Promise<boolean> {
  try {
    if (!_editorService) {
      _editorService = await getService(ICodeEditorService)
    }

    const editor = _editorService.getActiveCodeEditor()
    if (!editor) return false

    const model = editor.getModel?.()
    if (!model) return false

    const selection = editor.getSelection?.()
    const range = selection && !selection.isEmpty?.()
      ? selection
      : model.getFullModelRange()

    editor.executeEdits('opide-apply', [{
      range,
      text: code,
      forceMoveMarkers: true,
    }])

    editor.revealRangeInCenter?.(range)

    return true
  } catch (e) {
    console.warn('[opide-editor] applyCodeToEditor failed:', e)
    return false
  }
}
