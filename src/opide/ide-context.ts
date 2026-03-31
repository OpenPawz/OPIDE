/**
 * OPIDE IDE Context Gatherer
 *
 * Collects current IDE state and formats it for injection into agent messages.
 * Called before every chat message to give the agent awareness of what the
 * user is looking at.
 *
 * Context is injected as a [IDE Context] prefix in the message, which the
 * ContextBuilder on the Rust side incorporates at priority 1 (nearly never dropped).
 */

import { invoke } from '@tauri-apps/api/core'

// ─── Types ────────────────────────────────────────────────────────────────────

interface GitStatusResult {
  repo_root: string
  branch: string | null
  files: { path: string; status: string; staged: boolean }[]
  ahead: number
  behind: number
}

// ─── State (updated by editor events) ─────────────────────────────────────────

let _activeFilePath: string | null = null
let _activeFileLanguage: string | null = null
let _selection: string | null = null
let _selectionRange: { startLine: number; endLine: number } | null = null
let _openTabs: string[] = []
let _workspacePath: string | null = null
let _recentTerminalOutput: string | null = null

// ─── Public Setters (called by editor integration) ────────────────────────────

export function setActiveFile(path: string | null, language: string | null): void {
  _activeFilePath = path
  _activeFileLanguage = language
}

export function setSelection(text: string | null, startLine?: number, endLine?: number): void {
  _selection = text
  _selectionRange = text && startLine != null && endLine != null
    ? { startLine, endLine }
    : null
}

export function setOpenTabs(tabs: string[]): void {
  _openTabs = tabs
}

export function setWorkspacePath(path: string | null): void {
  _workspacePath = path
}

export function setRecentTerminalOutput(output: string | null): void {
  _recentTerminalOutput = output
}

// ─── Context Builder ──────────────────────────────────────────────────────────

/**
 * Gather current IDE context and format it for injection into agent messages.
 * Returns empty string if no meaningful context is available.
 */
export async function gatherIdeContext(): Promise<string> {
  const parts: string[] = []

  // Workspace
  if (_workspacePath) {
    parts.push(`Workspace: ${_workspacePath}`)
  }

  // Active file + content snippet
  if (_activeFilePath) {
    parts.push(`Active file: ${_activeFilePath} (${_activeFileLanguage || 'unknown'})`)

    // Include first 100 lines of the active file so the agent sees what the user sees
    try {
      const fileResult = await invoke<{ content: string }>('ide_read_file', { path: _activeFilePath })
      if (fileResult?.content) {
        const lines = fileResult.content.split('\n')
        const snippet = lines.slice(0, 100).join('\n')
        const truncated = lines.length > 100 ? `\n... (${lines.length - 100} more lines)` : ''
        parts.push(`File content (first 100 lines):\n\`\`\`${_activeFileLanguage || ''}\n${snippet}${truncated}\n\`\`\``)
      }
    } catch { /* file read failed, skip content */ }
  }

  // Selection
  if (_selection && _selectionRange) {
    parts.push(`Selection (lines ${_selectionRange.startLine}-${_selectionRange.endLine}):\n\`\`\`\n${_selection}\n\`\`\``)
  }

  // Diagnostics from the active file
  try {
    const monaco = await import('monaco-editor')
    const models = _activeFilePath
      ? [monaco.editor.getModel(monaco.Uri.file(_activeFilePath))].filter(Boolean)
      : monaco.editor.getModels()

    const errors: string[] = []
    for (const model of models) {
      if (!model) continue
      const markers = monaco.editor.getModelMarkers({ resource: model.uri })
      for (const m of markers) {
        if (m.severity >= 4) { // warning or error
          const sev = m.severity === 8 ? 'ERROR' : 'WARN'
          const path = model.uri.fsPath || model.uri.path
          const shortPath = path.split('/').slice(-2).join('/')
          errors.push(`  ${sev}: ${shortPath}:${m.startLineNumber}: ${m.message}`)
        }
      }
    }
    if (errors.length > 0) {
      parts.push(`Diagnostics:\n${errors.slice(0, 20).join('\n')}${errors.length > 20 ? `\n  ... and ${errors.length - 20} more` : ''}`)
    }
  } catch { /* diagnostics not available */ }

  // Open tabs
  if (_openTabs.length > 0) {
    parts.push(`Open tabs: ${_openTabs.join(', ')}`)
  }

  // Git state
  if (_workspacePath) {
    try {
      const git = await invoke<GitStatusResult>('ide_get_git_status', { repoPath: _workspacePath })
      if (git.branch) {
        const modified = git.files.filter(f => !f.staged).length
        const staged = git.files.filter(f => f.staged).length
        let gitLine = `Git: branch=${git.branch}`
        if (modified) gitLine += `, ${modified} modified`
        if (staged) gitLine += `, ${staged} staged`
        if (git.ahead) gitLine += `, ${git.ahead} ahead`
        if (git.behind) gitLine += `, ${git.behind} behind`
        if (git.files.length > 0) {
          gitLine += '\n  Changed: ' + git.files.slice(0, 10).map(f => `${f.status} ${f.path}`).join(', ')
          if (git.files.length > 10) gitLine += `, ... +${git.files.length - 10} more`
        }
        parts.push(gitLine)
      }
    } catch { /* not a git repo */ }
  }

  // Recent terminal output
  if (_recentTerminalOutput) {
    const trimmed = _recentTerminalOutput.slice(-500)
    parts.push(`Recent terminal:\n\`\`\`\n${trimmed}\n\`\`\``)
  }

  // Codebase index context (project overview + symbol table)
  try {
    const codebaseContext = await invoke<string>('ide_get_codebase_context')
    if (codebaseContext && codebaseContext.length > 0) {
      parts.push(`Codebase:\n${codebaseContext}`)
    }
  } catch { /* indexer not ready yet */ }

  if (parts.length === 0) return ''
  return parts.join('\n')
}

/**
 * Get just the workspace path (for tool routing).
 */
export function getWorkspace(): string | null {
  return _workspacePath
}

/** Get the currently active file path. */
export function getActiveFile(): string | null {
  return _activeFilePath
}

/** Get the current selection range (if any). */
export function getSelectionRange(): { startLine: number; endLine: number } | null {
  return _selectionRange
}
