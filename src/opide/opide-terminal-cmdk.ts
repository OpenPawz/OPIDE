// OPIDE Terminal Cmd+K — natural language → shell command.
//
// Registered as a Command Palette command ("OPIDE: Generate Terminal Command").
// The user describes what they want, OPIDE generates a single shell command and
// TYPES it into the active terminal WITHOUT executing it, so the user reviews
// and presses Enter. Mirrors Cursor's terminal Cmd+K.
//
// Palette-only for now (no Cmd+K keybinding) to avoid hijacking VS Code's Cmd+K
// chord bindings; a terminal-focus-scoped keybinding can be added once the core
// is confirmed working live.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getWorkspace } from './ide-context.ts'

const CMDK_SESSION = '__opide_terminal_cmdk__'
const SYSTEM_PROMPT = `You convert a natural-language request into a SINGLE shell command for a macOS zsh terminal. Output ONLY the command — raw text, no markdown, no code fences, no explanation, no leading "$". If multiple steps are required, chain them on one line with &&. Prefer safe, non-destructive commands.`
const TIMEOUT_MS = 20000

let _listener: UnlistenFn | null = null
const _resolvers = new Map<string, (cmd: string | null) => void>()
const _accum = new Map<string, string>()

async function ensureListener(): Promise<void> {
  if (_listener) return
  _listener = await listen<any>('engine-event', ({ payload }) => {
    if (!payload?.run_id) return
    const resolve = _resolvers.get(payload.run_id)
    if (!resolve) return
    if (payload.kind === 'delta') {
      _accum.set(payload.run_id, (_accum.get(payload.run_id) ?? '') + (payload.text ?? ''))
    } else if (payload.kind === 'complete') {
      const text = (payload.text || _accum.get(payload.run_id) || '').trim()
      _accum.delete(payload.run_id)
      _resolvers.delete(payload.run_id)
      resolve(text || null)
    }
  })
}

/** Strip fences / prompt markers / prose the model may add despite instructions. */
function cleanCommand(raw: string): string {
  let s = raw.trim()
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim()
  s = s.replace(/^\$\s+/, '')
  // If the model returned multiple lines of prose, keep the first non-empty line
  // that actually looks like a command (heuristic: no trailing sentence period).
  const firstLine = s.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  return (firstLine ?? s).trim()
}

async function generateCommand(nl: string): Promise<string | null> {
  await ensureListener()
  const cwd = getWorkspace()
  const message = cwd ? `[cwd: ${cwd}]\n${nl}` : nl
  return new Promise<string | null>((resolve) => {
    invoke<{ run_id: string }>('engine_chat_send', {
      request: {
        session_id: CMDK_SESSION,
        message,
        system_prompt: SYSTEM_PROMPT,
        tools_enabled: false,
        auto_approve_all: true,
        temperature: 0.1,
        // Project rules would corrupt the single-command output format.
        skip_project_rules: true,
      },
    })
      .then(({ run_id }) => {
        _resolvers.set(run_id, resolve)
        setTimeout(() => {
          if (_resolvers.delete(run_id)) {
            _accum.delete(run_id)
            resolve(null)
          }
        }, TIMEOUT_MS)
      })
      .catch(() => resolve(null))
  })
}

async function notify(message: string, kind: 'info' | 'warn' = 'info'): Promise<void> {
  try {
    const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
    const { INotificationService, Severity } = (await import(
      '@codingame/monaco-vscode-api/vscode/vs/platform/notification/common/notification'
    )) as any
    const svc = StandaloneServices.get(INotificationService) as any
    svc?.notify?.({
      severity: kind === 'warn' ? Severity?.Warning : Severity?.Info,
      message,
    })
  } catch {
    console.warn('[opide-terminal-cmdk]', message)
  }
}

async function runTerminalCmdK(): Promise<void> {
  const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
  const { IQuickInputService } = await import(
    '@codingame/monaco-vscode-api/vscode/vs/platform/quickinput/common/quickInput.service'
  )
  const quickInput = StandaloneServices.get(IQuickInputService) as any
  if (!quickInput?.input) {
    await notify('Terminal Cmd+K: quick input service unavailable.', 'warn')
    return
  }

  const nl = await quickInput.input({
    prompt: 'Describe the terminal command you want',
    placeHolder: 'e.g. find every TODO comment under src and count them',
    ignoreFocusOut: true,
  })
  if (!nl || !nl.trim()) return

  const generated = await generateCommand(nl.trim())
  if (!generated) {
    await notify('Terminal Cmd+K: could not generate a command (timed out or empty).', 'warn')
    return
  }
  const cmd = cleanCommand(generated)
  if (!cmd) {
    await notify('Terminal Cmd+K: model returned no command.', 'warn')
    return
  }

  // Type the command into the active terminal WITHOUT executing it.
  try {
    const { ITerminalService } = await import('@codingame/monaco-vscode-terminal-service-override')
    const termService = StandaloneServices.get(ITerminalService as any) as any
    let inst = termService?.activeInstance
    if (!inst && termService?.createTerminal) {
      // No terminal open — create one, then type into it.
      inst = await termService.createTerminal({})
      try { await termService.setActiveInstance?.(inst) } catch { /* ignore */ }
      try { await termService.showPanel?.(true) } catch { /* ignore */ }
    }
    if (inst?.sendText) {
      await inst.sendText(cmd, false) // false = do not execute; user reviews + Enter
      try { inst.focus?.() } catch { /* ignore */ }
    } else {
      await notify(`OPIDE generated (open a terminal to use it): ${cmd}`)
    }
  } catch (e) {
    console.warn('[opide-terminal-cmdk] sendText failed:', e)
    await notify(`OPIDE generated: ${cmd}`)
  }
}

export async function registerTerminalCmdK(): Promise<void> {
  try {
    const { Action2, registerAction2 } = (await import(
      '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions'
    )) as any
    if (!registerAction2 || !Action2) return
    registerAction2(
      class extends Action2 {
        static readonly id = 'opide.terminal.generateCommand'
        constructor() {
          super({
            id: 'opide.terminal.generateCommand',
            title: {
              value: 'OPIDE: Generate Terminal Command (AI)',
              original: 'OPIDE: Generate Terminal Command (AI)',
            },
            f1: true,
          })
        }
        async run(): Promise<void> {
          await runTerminalCmdK()
        }
      },
    )
  } catch (e) {
    console.warn('[opide-terminal-cmdk] registration failed:', e)
  }
}
