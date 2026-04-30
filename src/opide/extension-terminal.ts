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

interface TermRec { id: string; terminalId?: string }
const _terms = new Map<string, TermRec>()

export async function handle(method: string, params: any): Promise<void> {
  const id = params?.id
  if (!id) return
  switch (method) {
    case 'terminal/create': {
      const rec: TermRec = { id }
      _terms.set(id, rec)
      try {
        // terminal.rs returns { terminal_id, pid }; we keep terminal_id
        // for downstream write/kill calls.
        const result = await invoke<{ terminal_id: string }>('terminal_spawn', {
          request: {
            cwd: params?.cwd,
            shell: params?.shellPath,
            // terminal_spawn doesn't take args; the shell flag applies
            // and the user can sendText() to drive further commands.
            env: params?.env,
          },
        }).catch(() => null)
        rec.terminalId = result?.terminal_id
      } catch (e) {
        console.warn(`[ext-terminal] create ${id} failed:`, e)
      }
      break
    }
    case 'terminal/sendText': {
      const rec = _terms.get(id)
      if (!rec?.terminalId) return
      const text = (params?.text ?? '') + (params?.addNewLine ? '\n' : '')
      await invoke('terminal_write', {
        terminalId: rec.terminalId, data: text,
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
      if (rec?.terminalId) {
        await invoke('terminal_kill', { terminalId: rec.terminalId }).catch(() => {})
      }
      _terms.delete(id)
      break
    }
  }
}
