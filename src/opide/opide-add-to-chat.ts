// OPIDE "Add Selection to Chat" — Cursor's Cmd+L workflow.
//
// Select code in the editor and run this (Cmd+L or the Command Palette) to drop
// the selection into the chat input as a fenced, source-referenced block, then
// focus the chat so you can type your question. If nothing is selected, the
// current line is used.

import { getService, ICodeEditorService } from '@codingame/monaco-vscode-api/services'
import { S } from './chat/state.ts'

async function addSelectionToChat(): Promise<void> {
  try {
    const editorService = await getService(ICodeEditorService)
    const editor = (editorService as any).getActiveCodeEditor?.()
    const model = editor?.getModel?.()
    if (!editor || !model) return

    let selection = editor.getSelection?.()
    if (!selection || selection.isEmpty?.()) {
      // No selection — use the whole current line.
      const pos = editor.getPosition?.()
      if (!pos) return
      const monaco = await import('monaco-editor')
      selection = new (monaco as any).Range(
        pos.lineNumber, 1, pos.lineNumber, model.getLineMaxColumn(pos.lineNumber),
      )
    }

    const text = model.getValueInRange(selection)
    if (!text || !text.trim()) return

    const lang = model.getLanguageId?.() || ''
    const file = (model.uri?.fsPath || model.uri?.path || 'file').split('/').pop()
    const block = `\n\`\`\`${lang}\n${text}\n\`\`\`\n(${file}:${selection.startLineNumber}-${selection.endLineNumber})\n`

    // Reveal + focus the OPIDE chat panel.
    try {
      const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
      const { ICommandService } = await import(
        '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands'
      )
      const cs = StandaloneServices.get(ICommandService) as any
      await cs?.executeCommand?.('opide.chat.focus')
    } catch { /* chat focus is best-effort */ }

    const ta = S.textarea
    if (ta) {
      const pos = ta.selectionStart ?? ta.value.length
      ta.value = ta.value.slice(0, pos) + block + ta.value.slice(pos)
      const np = pos + block.length
      ta.setSelectionRange(np, np)
      ta.dispatchEvent(new Event('input'))
      ta.focus()
    }
  } catch (e) {
    console.warn('[opide-add-to-chat] failed:', e)
  }
}

export async function registerAddToChat(): Promise<void> {
  try {
    const { Action2, registerAction2 } = (await import(
      '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions'
    )) as any
    if (!registerAction2 || !Action2) return
    registerAction2(
      class extends Action2 {
        static readonly id = 'opide.addSelectionToChat'
        constructor() {
          super({
            id: 'opide.addSelectionToChat',
            title: {
              value: 'OPIDE: Add Selection to Chat',
              original: 'OPIDE: Add Selection to Chat',
            },
            f1: true,
            // CtrlCmd(2048) | KeyL(42) — the Cursor convention for "add to chat".
            // Overrides VS Code's "expand line selection" on Cmd+L by design.
            keybinding: { primary: 2048 | 42, weight: 1000 },
          })
        }
        async run(): Promise<void> {
          await addSelectionToChat()
        }
      },
    )
  } catch (e) {
    console.warn('[opide-add-to-chat] registration failed:', e)
  }
}
