/**
 * OPIDE SCM Provider
 *
 * Registers a VS Code Source Control provider backed by Rust git2.
 * Polls git status and feeds changed files into the SCM panel.
 * Uses the @codingame/monaco-vscode-api extension registration pattern.
 */

import { invoke } from '@tauri-apps/api/core'
import { registerExtension } from '@codingame/monaco-vscode-api/extensions'
import { ExtensionHostKind } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/extensions/common/extensionHostKind'

// ─── Types (matching Rust structs) ───────────────────────────────────────────

interface GitFileStatus {
  path: string
  status: string
  staged: boolean
}

interface GitStatusResult {
  repo_root: string
  branch: string | null
  files: GitFileStatus[]
  ahead: number
  behind: number
}

// ─── SCM Registration ────────────────────────────────────────────────────────

export async function initScmProvider(workspacePath: string): Promise<void> {
  // Check if this is a git repo first
  let status: GitStatusResult
  try {
    status = await invoke<GitStatusResult>('git_status', { repoPath: workspacePath })
  } catch {
    console.log('[opide-scm] not a git repository, skipping SCM init')
    return
  }

  const repoRoot = status.repo_root || workspacePath

  // Register as an extension to get the vscode API
  const ext = registerExtension({
    name: 'opide-git',
    publisher: 'opide',
    version: '0.1.0',
    engines: { vscode: '*' },
  }, ExtensionHostKind.LocalProcess)

  const vscode = await ext.getApi()

  // Create SCM provider
  const scm = vscode.scm.createSourceControl('opide-git', 'Git', vscode.Uri.file(repoRoot))
  scm.acceptInputCommand = {
    command: 'opide.git.commit',
    title: 'Commit',
  }

  // Create resource groups
  const stagedGroup = scm.createResourceGroup('staged', 'Staged Changes')
  stagedGroup.hideWhenEmpty = true

  const changesGroup = scm.createResourceGroup('changes', 'Changes')
  changesGroup.hideWhenEmpty = false

  // Register commands
  vscode.commands.registerCommand('opide.git.commit', async () => {
    const message = scm.inputBox.value.trim()
    if (!message) {
      vscode.window.showWarningMessage('Please enter a commit message')
      return
    }
    try {
      const oid = await invoke<string>('git_commit', {
        request: { message, repo_path: repoRoot },
      })
      scm.inputBox.value = ''
      vscode.window.showInformationMessage(`Committed: ${oid.slice(0, 7)}`)
      await refreshStatus()
    } catch (e) {
      vscode.window.showErrorMessage(`Commit failed: ${e}`)
    }
  })

  vscode.commands.registerCommand('opide.git.stageAll', async () => {
    try {
      await invoke('git_stage_all', { repoPath: repoRoot })
      await refreshStatus()
    } catch (e) {
      vscode.window.showErrorMessage(`Stage all failed: ${e}`)
    }
  })

  // ── Status Refresh ────────────────────────────────────────────────────────

  async function refreshStatus(): Promise<void> {
    try {
      const st = await invoke<GitStatusResult>('git_status', { repoPath: repoRoot })

      // Branch label in status bar
      const branchLabel = st.branch ?? 'detached'
      const syncLabel = st.ahead || st.behind ? ` ${st.ahead}↑ ${st.behind}↓` : ''
      scm.statusBarCommands = [{
        command: '',
        title: `$(git-branch) ${branchLabel}${syncLabel}`,
        tooltip: `Branch: ${branchLabel}`,
      }]

      // Separate staged and unstaged
      const staged: typeof stagedGroup.resourceStates = []
      const changes: typeof changesGroup.resourceStates = []

      for (const file of st.files) {
        const uri = vscode.Uri.file(`${repoRoot}${file.path.startsWith('/') ? '' : '/'}${file.path}`)
        const deco = statusDecoration(file.status)

        const resource = {
          resourceUri: uri,
          decorations: {
            strikeThrough: file.status === 'deleted',
            tooltip: `${file.status} — ${file.path}`,
            ...deco,
          },
          command: {
            command: 'vscode.open',
            title: 'Open File',
            arguments: [uri],
          },
        }

        if (file.staged) {
          staged.push(resource)
        } else {
          changes.push(resource)
        }
      }

      stagedGroup.resourceStates = staged
      changesGroup.resourceStates = changes
      scm.count = st.files.length
    } catch (e) {
      console.warn('[opide-scm] status refresh failed:', e)
    }
  }

  // Initial refresh + file-watcher-driven updates only.
  // No polling — the Rust file watcher emits events on changes,
  // and refreshStatus is called from the watcher listener.
  await refreshStatus()

  // Listen for file system changes from the Rust watcher to trigger refresh
  const { listen } = await import('@tauri-apps/api/event')
  let _refreshTimer: ReturnType<typeof setTimeout> | null = null
  await listen('fs-change', () => {
    // Debounce: wait 500ms after last change before refreshing
    if (_refreshTimer) clearTimeout(_refreshTimer)
    _refreshTimer = setTimeout(refreshStatus, 500)
  })

  console.log('[opide-scm] initialized for', repoRoot, 'branch:', status.branch)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusDecoration(status: string): { letter?: string; color?: unknown } {
  switch (status) {
    case 'modified':
      return { letter: 'M' }
    case 'added':
      return { letter: 'A' }
    case 'deleted':
      return { letter: 'D' }
    case 'renamed':
      return { letter: 'R' }
    case 'untracked':
      return { letter: 'U' }
    case 'conflicted':
      return { letter: 'C' }
    default:
      return {}
  }
}
