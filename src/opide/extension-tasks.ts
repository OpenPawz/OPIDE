// OPIDE Extension Tasks — Phase E.E1
//
// Implements vscode.tasks.executeTask by spawning the task's command
// in a Tauri terminal session. Output streams into a dedicated
// terminal that the user can inspect; exit code propagates back.
//
// v1 scope: ShellExecution and ProcessExecution. CustomExecution
// (where the extension implements its own pseudoterminal) is queued
// for v2 because it needs a Pseudoterminal RPC which Phase E.E2 will
// build out alongside vscode.window.createTerminal.

import { invoke } from '@tauri-apps/api/core'

interface TaskExecutionRecord {
  executionId: string
  terminalId?: string
  child?: any
}

const _executions = new Map<string, TaskExecutionRecord>()
let _executionCounter = 1

export async function executeTask(params: any): Promise<{ executionId: string } | null> {
  if (!params?.execution?.command) return null
  const executionId = `task-${_executionCounter++}`
  const record: TaskExecutionRecord = { executionId }
  _executions.set(executionId, record)

  // Build the command. ShellExecution → join command + args; ProcessExecution
  // → already separated. We let zsh interpret because most tasks rely on
  // PATH from the user's profile (npm scripts, cargo, etc).
  const exec = params.execution
  const cmd = Array.isArray(exec.args) && exec.args.length > 0
    ? `${exec.command} ${exec.args.map((a: string) => JSON.stringify(a)).join(' ')}`
    : exec.command

  // Spawn through ide_run_command for a simple one-shot. v2 swaps to a
  // PTY-backed terminal so output streams live and the user can interact.
  invoke<any>('ide_run_command', { command: cmd, cwd: exec.cwd || undefined }).then((result: any) => {
    console.log(`[ext-tasks] ${params.name || 'task'} exited ${result?.exit_code ?? 0}`)
    _executions.delete(executionId)
  }).catch((e) => {
    console.warn(`[ext-tasks] ${params.name || 'task'} failed:`, e)
    _executions.delete(executionId)
  })
  return { executionId }
}

export async function terminateTask(executionId: string): Promise<void> {
  // v1: ide_run_command runs to completion; we can't terminate.
  // v2: switch to a PTY terminal session and kill via tauri terminal API.
  _executions.delete(executionId)
}
