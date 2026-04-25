/**
 * OPIDE Terminal Backend
 *
 * Bridges @codingame/monaco-vscode-terminal-service-override to
 * the Rust PTY manager via Tauri IPC.
 *
 * - SimpleTerminalBackend → spawns terminals via `terminal_spawn`
 * - TauriTerminalProcess → pipes I/O via `terminal_write` + `terminal-data` events
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  type ITerminalChildProcess,
  SimpleTerminalBackend,
  SimpleTerminalProcess,
} from '@codingame/monaco-vscode-terminal-service-override'
import { Emitter } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import { setActiveTerminalId } from './opide-tool-bridge'

// ─── Types matching Rust structs ─────────────────────────────────────────────

interface TerminalSpawnResult {
  terminal_id: string
  pid: number
}

interface TerminalDataEvent {
  terminal_id: string
  data: string
}

interface TerminalExitEvent {
  terminal_id: string
  exit_code: number | null
}

// ─── Terminal Process ────────────────────────────────────────────────────────

class TauriTerminalProcess extends SimpleTerminalProcess {
  private readonly terminalId: string
  private unlistenData: UnlistenFn | null = null
  private unlistenExit: UnlistenFn | null = null
  private readonly dataEmitter: Emitter<string>

  constructor(
    id: number,
    pid: number,
    cwd: string,
    terminalId: string,
    dataEmitter: Emitter<string>,
  ) {
    super(id, pid, cwd, dataEmitter.event)
    this.terminalId = terminalId
    this.dataEmitter = dataEmitter
  }

  async start(): Promise<undefined> {
    // Listen for PTY output from Rust
    this.unlistenData = await listen<TerminalDataEvent>('terminal-data', ({ payload }) => {
      if (payload.terminal_id === this.terminalId) {
        this.dataEmitter.fire(payload.data)
      }
    })

    // Listen for PTY exit from Rust
    this.unlistenExit = await listen<TerminalExitEvent>('terminal-exit', ({ payload }) => {
      if (payload.terminal_id === this.terminalId) {
        this.fireExit(payload.exit_code ?? 0)
        this.cleanup()
      }
    })

    return undefined
  }

  shutdown(_immediate: boolean): void {
    invoke('terminal_kill', { terminalId: this.terminalId }).catch((e) => {
      console.warn('[opide-terminal] kill failed:', e)
    })
    this.cleanup()
  }

  input(data: string): void {
    invoke('terminal_write', { terminalId: this.terminalId, data }).catch((e) => {
      console.warn('[opide-terminal] write failed:', e)
    })
  }

  resize(cols: number, rows: number): void {
    invoke('terminal_resize', { terminalId: this.terminalId, cols, rows }).catch((e) => {
      console.warn('[opide-terminal] resize failed:', e)
    })
  }

  clearBuffer(): void {
    // Intentionally a no-op (B41).
    // The previous implementation wrote ANSI escape codes to the PTY's stdin —
    // which the running shell saw as user input. For TUI programs (vim/htop)
    // this corrupted state. Monaco's terminal layer routes "Clear" via xterm
    // separately; we don't need to touch the PTY here.
  }

  sendSignal(_signal: string): void {
    // Could map to specific signals in the future
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private fireExit(code: number): void {
    // B42: SimpleTerminalProcess's exit signal isn't directly exposed via a
    // public emitter we can fire — the message-only path here just renders
    // text in xterm. End-to-end exit reporting requires the Rust-side
    // terminal.rs to emit real exit codes (B111, queued for the opide-shell
    // pass). For now this is best-effort.
    this.dataEmitter.fire(`\r\n[Process exited with code ${code}]\r\n`)
  }

  private cleanup(): void {
    this.unlistenData?.()
    this.unlistenData = null
    this.unlistenExit?.()
    this.unlistenExit = null
  }
}

// ─── Terminal Backend ────────────────────────────────────────────────────────

let processCounter = 0

export class OpideTerminalBackend extends SimpleTerminalBackend {
  override getDefaultSystemShell = async (): Promise<string> => {
    // Return the user's default shell — Rust will resolve this too,
    // but the frontend needs a display value
    return navigator.platform.includes('Win') ? 'cmd.exe' : '/bin/zsh'
  }

  override createProcess = async (
    _shellLaunchConfig: unknown,
    _cwd: string,
    cols: number,
    rows: number,
  ): Promise<ITerminalChildProcess> => {
    const cwd = typeof _cwd === 'string' ? _cwd : undefined

    // Spawn PTY via Rust
    const result = await invoke<TerminalSpawnResult>('terminal_spawn', {
      request: {
        cwd,
        cols,
        rows,
      },
    })

    // Track this terminal as the active target for agent ide_run_command output
    setActiveTerminalId(result.terminal_id)

    const id = ++processCounter
    const dataEmitter = new Emitter<string>()

    return new TauriTerminalProcess(
      id,
      result.pid,
      cwd ?? '/Users',
      result.terminal_id,
      dataEmitter,
    )
  }
}
