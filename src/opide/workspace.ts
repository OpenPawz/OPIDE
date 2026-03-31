/**
 * OPIDE Workspace Manager
 *
 * Handles "Open Folder" via Tauri's native dialog.
 * Persists the workspace path in the URL hash so it survives reload.
 * Provides the IWorkspaceProvider that VS Code's workbench uses.
 */

import { open } from '@tauri-apps/plugin-dialog'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { initScmProvider } from './scm-provider.ts'
import { registerSearchProviders } from './search-provider.ts'

// ─── Workspace Path ──────────────────────────────────────────────────────────

/**
 * Read the current workspace path from the URL hash.
 * Format: #/path/to/folder
 */
export function getWorkspacePath(): string | null {
  const hash = window.location.hash.slice(1)
  if (!hash) return null
  const decoded = decodeURIComponent(hash)
  return decoded.startsWith('/') ? decoded : null
}

/**
 * Build the workspaceProvider for the @codingame/monaco-vscode-api initialize() call.
 * This tells VS Code what folder to open on boot, and handles "Open Folder" requests.
 */
export function createWorkspaceProvider() {
  const workspacePath = getWorkspacePath()

  return {
    trusted: true,

    // Initial workspace — if we have a path in the hash, open that folder
    workspace: workspacePath
      ? { folderUri: URI.file(workspacePath) }
      : undefined,

    // Called by VS Code when user triggers "Open Folder" / "Open Workspace"
    async open(workspace: unknown, _options?: unknown): Promise<boolean> {
      // If VS Code passes a specific folder, check if it's already open
      if (workspace && typeof workspace === 'object' && 'folderUri' in workspace) {
        const uri = (workspace as { folderUri: URI }).folderUri
        if (uri && uri.path) {
          const currentPath = getWorkspacePath()
          if (uri.path === currentPath) return true

          // Try addFolders first to avoid reload
          try {
            const { getService, IWorkspaceEditingService } = await import(
              '@codingame/monaco-vscode-api/services'
            )
            const editingService = (await getService(IWorkspaceEditingService)) as any
            if (editingService?.addFolders) {
              await editingService.addFolders([{ uri: URI.file(uri.path) }])
              window.location.hash = encodeURIComponent(uri.path)
              // Trigger backend indexing
              const { emit } = await import('@tauri-apps/api/event')
              await emit('open-workspace', { path: uri.path })
              return true
            }
          } catch {
            // addFolders failed — fall through to reload
          }

          window.location.hash = encodeURIComponent(uri.path)
          window.location.reload()
          return true
        }
      }

      // No specific folder passed — show native folder picker
      return await pickAndOpenFolder()
    },
  }
}

/**
 * Show the native Tauri folder picker and open the selected folder.
 */
export async function pickAndOpenFolder(): Promise<boolean> {
  console.log('[opide-workspace] pickAndOpenFolder() called')
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Open Folder',
    })
    console.log('[opide-workspace] dialog returned:', selected)

    if (!selected || typeof selected !== 'string') return false

    // Replace current workspace (remove existing folders, add new one)
    try {
      const { getService, IWorkspaceEditingService, IWorkspaceContextService } = await import(
        '@codingame/monaco-vscode-api/services'
      )
      const editingService = (await getService(IWorkspaceEditingService)) as any
      const ctxService = (await getService(IWorkspaceContextService)) as any
      if (editingService?.addFolders) {
        // Remove existing folders first
        if (ctxService?.getWorkspace?.()?.folders && editingService?.removeFolders) {
          const existing = ctxService.getWorkspace().folders
          if (existing.length > 0) {
            await editingService.removeFolders(existing.map((f: any) => f.uri))
          }
        }
        await editingService.addFolders([{ uri: URI.file(selected) }])
        window.location.hash = encodeURIComponent(selected)
        console.log('[opide-workspace] Workspace replaced with:', selected)

        // Initialize workspace services
        try { await initScmProvider(selected) } catch {}
        try { await registerSearchProviders(selected) } catch {}

        // Notify backend to index the new workspace
        const { emit } = await import('@tauri-apps/api/event')
        await emit('open-workspace', { path: selected })

        return true
      }
    } catch (e) {
      console.warn('[opide-workspace] addFolders failed in picker, falling back to reload:', e)
    }

    // Fallback: reload (only if addFolders is unavailable)
    window.location.hash = encodeURIComponent(selected)
    window.location.reload()
    return true
  } catch (e) {
    console.error('[opide-workspace] folder picker failed:', e)
    return false
  }
}

/**
 * Listen for the agent opening a workspace programmatically.
 * Called after the workbench boots.
 */
export async function listenForWorkspaceOpen(): Promise<void> {
  const { listen } = await import('@tauri-apps/api/event')
  await listen<{ path: string }>('open-workspace', async (event) => {
    const path = event.payload.path
    if (!path) return

    console.log('[opide-workspace] Agent opening workspace:', path)

    try {
      // Use VS Code's IWorkspaceEditingService — REPLACE current workspace, not just add
      const { getService, IWorkspaceEditingService, IWorkspaceContextService } = await import(
        '@codingame/monaco-vscode-api/services'
      )
      const editingService = (await getService(IWorkspaceEditingService)) as any
      const ctxService = (await getService(IWorkspaceContextService)) as any

      if (editingService?.addFolders) {
        // Remove all existing workspace folders first
        if (ctxService?.getWorkspace?.()?.folders && editingService?.removeFolders) {
          const existingFolders = ctxService.getWorkspace().folders
          if (existingFolders.length > 0) {
            await editingService.removeFolders(existingFolders.map((f: any) => f.uri))
            console.log(`[opide-workspace] Removed ${existingFolders.length} existing folder(s)`)
          }
        }

        // Add the new folder
        await editingService.addFolders([{ uri: URI.file(path) }])
        console.log('[opide-workspace] Workspace replaced with:', path)

        // Update hash so it persists across manual reloads
        window.location.hash = encodeURIComponent(path)

        // Initialize workspace services for the new folder
        try {
          await initScmProvider(path)
        } catch (e) {
          console.warn('[opide-workspace] SCM init for new folder:', e)
        }
        try {
          await registerSearchProviders(path)
        } catch (e) {
          console.warn('[opide-workspace] Search init for new folder:', e)
        }

        return
      }
    } catch (e) {
      console.warn('[opide-workspace] addFolders failed, trying enterWorkspace:', e)
    }

    // Fallback: try enterWorkspace
    try {
      const { getService, IWorkspaceEditingService } = await import(
        '@codingame/monaco-vscode-api/services'
      )
      const editingService = (await getService(IWorkspaceEditingService)) as any
      if (editingService?.enterWorkspace) {
        await editingService.enterWorkspace(URI.file(path))
        window.location.hash = encodeURIComponent(path)
        return
      }
    } catch (e) {
      console.warn('[opide-workspace] enterWorkspace failed:', e)
    }

    // Last resort: update hash for next manual reload but DO NOT auto-reload.
    // Reloading destroys chat state, streaming context, and pending tool calls.
    // The workspace will be picked up on the next manual restart.
    console.warn('[opide-workspace] All API methods failed — updated hash but NOT reloading to preserve chat state')
    window.location.hash = encodeURIComponent(path)
  })
}

/**
 * Watch for workspace folder changes (however they happen — VS Code UI, our picker,
 * drag-and-drop, etc.) and emit 'open-workspace' to trigger backend indexing.
 */
export async function watchWorkspaceFolders(): Promise<void> {
  try {
    const { getService, IWorkspaceContextService } = await import(
      '@codingame/monaco-vscode-api/services'
    )
    const ctxService = (await getService(IWorkspaceContextService)) as any
    if (ctxService?.onDidChangeWorkspaceFolders) {
      ctxService.onDidChangeWorkspaceFolders(async (e: any) => {
        const added = e?.added ?? []
        for (const folder of added) {
          const path = folder?.uri?.fsPath || folder?.uri?.path
          if (path) {
            console.log('[opide-workspace] Folder added (detected via onDidChangeWorkspaceFolders):', path)
            window.location.hash = encodeURIComponent(path)
            // Only emit if index isn't already loaded for this workspace
            try {
              const { invoke } = await import('@tauri-apps/api/core')
              const status = await invoke('get_index_status') as any
              if (!status?.has_index) {
                const { emit } = await import('@tauri-apps/api/event')
                await emit('open-workspace', { path })
              } else {
                console.log('[opide-workspace] index already loaded — skipping duplicate emit')
              }
            } catch {
              const { emit } = await import('@tauri-apps/api/event')
              await emit('open-workspace', { path })
            }
            // Initialize services for the new folder
            try { await initScmProvider(path) } catch {}
            try { await registerSearchProviders(path) } catch {}
          }
        }
      })
      console.log('[opide-workspace] watching for workspace folder changes')
    }
  } catch (e) {
    console.warn('[opide-workspace] folder watcher setup failed:', e)
  }
}

/**
 * Initialize workspace-dependent services (SCM, search) if a workspace is open.
 * Called after the workbench boots.
 */
export async function initWorkspaceServices(): Promise<void> {
  const workspace = getWorkspacePath()
  if (!workspace) {
    console.log('[opide-workspace] no workspace open — skipping SCM/search init')
    return
  }

  console.log('[opide-workspace] initializing services for', workspace)

  // Only emit open-workspace if the index isn't already loaded
  // (the backend lib.rs listener may have already indexed on workspace open)
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const status = await invoke('get_index_status') as any
    if (!status?.has_index) {
      const { emit } = await import('@tauri-apps/api/event')
      await emit('open-workspace', { path: workspace })
      console.log('[opide-workspace] emitted open-workspace for indexing:', workspace)
    } else {
      console.log('[opide-workspace] index already loaded — skipping duplicate open-workspace emit')
    }
  } catch (e) {
    // If get_index_status fails, emit anyway as fallback
    try {
      const { emit } = await import('@tauri-apps/api/event')
      await emit('open-workspace', { path: workspace })
    } catch {}
  }

  try {
    await initScmProvider(workspace)
  } catch (e) {
    console.warn('[opide-workspace] SCM init skipped:', e)
  }

  try {
    await registerSearchProviders(workspace)
  } catch (e) {
    console.warn('[opide-workspace] search provider registration failed:', e)
  }
}
