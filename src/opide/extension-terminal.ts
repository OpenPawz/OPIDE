// OPIDE Extension Terminal — Phase E.E2
//
// Bridges vscode.window.createTerminal to OPIDE's terminal infrastructure
// (terminal.rs / TerminalState). Each extension-created terminal maps to
// a real PTY session so the user can interact with it the same way as
// terminals they create themselves.
//
// v1 scope
//   create / sendText / show / hide / dispose all dispatch to the
//   relevant Tauri commands. Where OPIDE doesn't yet expose a command
//   for show/hide we log instead of failing — the terminal still exists
//   and the user can toggle its visibility from the bottom panel.
//
// What's NOT in v1:
//   - Pseudoterminal API (extensions provide their own terminal
//     implementation). Comes alongside CustomExecution in tasks v2.
//   - Reverse direction (terminal → extension via onDidWriteTerminalData)
//     until we add a streaming-output Tauri event.

import { invoke } from '@tauri-apps/api/core'

interface TermRec { id: string; sessionId?: string }
const _terms = new Map<string, TermRec>()

export async function handle(method: string, params: any): Promise<void> {
  const id = params?.id
  if (!id) return
  switch (method) {
    case 'terminal/create': {
      const rec: TermRec = { id }
      _terms.set(id, rec)
      try {
        const session = await invoke<any>('terminal_create', {
          cwd: params?.cwd,
          shell: params?.shellPath,
          args: params?.shellArgs,
          env: params?.env,
        }).catch(() => null)
        rec.sessionId = session?.sessionId || session?.id || session
      } catch (e) {
        console.warn(`[ext-terminal] create ${id} failed:`, e)
      }
      break
    }
    case 'terminal/sendText': {
      const rec = _terms.get(id)
      if (!rec?.sessionId) return
      const text = (params?.text ?? '') + (params?.addNewLine ? '\n' : '')
      await invoke('terminal_write', {
        sessionId: rec.sessionId, data: text,
      }).catch((e) => console.warn(`[ext-terminal] sendText ${id} failed:`, e))
      break
    }
    case 'terminal/show':
    case 'terminal/hide': {
      // Best-effort: terminal panel show/hide isn't exposed yet. v2.
      break
    }
    case 'terminal/dispose': {
      const rec = _terms.get(id)
      if (rec?.sessionId) {
        await invoke('terminal_close', { sessionId: rec.sessionId }).catch(() => {})
      }
      _terms.delete(id)
      break
    }
  }
}
