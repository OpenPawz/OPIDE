/**
 * OPIDE Workspace Manager
 *
 * Handles "Open Folder" via Tauri's native dialog.
 * Persists the workspace path in the URL hash so it survives reload.
 * Provides the IWorkspaceProvider that VS Code's workbench uses.
 */

import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { initScmProvider } from './scm-provider.ts'
import { registerSearchProviders } from './search-provider.ts'

/**
 * B197: tell the engine which folder is now active so its host_api.rs and
 * system-prompt builder can scope agent operations accordingly. Best-effort
 * — failure to update the engine shouldn't block opening the folder.
 */
async function notifyEngineWorkspace(path: string | null): Promise<void> {
  try {
    await invoke('engine_set_active_workspace', { path })
  } catch (e) {
    console.warn('[opide-workspace] engine_set_active_workspace failed:', e)
  }
}

// ─── Deduplication guards ───────────────────────────────────────────────────

const _initializedPaths = new Set<string>()
const _openWorkspaceEmitted = new Set<string>()
const MAX_TRACKED_PATHS = 32

/** Add to a tracking set, evicting the oldest entry if we exceed the cap. */
function trackPath(s: Set<string>, path: string): void {
  if (s.has(path)) return
  s.add(path)
  if (s.size > MAX_TRACKED_PATHS) {
    const first = s.values().next().value
    if (first) s.delete(first)
  }
}

async function ensureServicesForPath(path: string): Promise<void> {
  const tlog = (m: string) => {
    console.log(m)
    try { invoke('ext_host_log', { message: `[open-folder-trace] ${m}` }).catch(() => {}) } catch { /* ignore */ }
  }
  if (_initializedPaths.has(path)) {
    tlog(`ensureServicesForPath: already initialized for ${path} — skipping`)
    return
  }
  trackPath(_initializedPaths, path)
  tlog(`ensureServicesForPath: initializing SCM + search for ${path}`)
  tlog('  initScmProvider start')
  try { await initScmProvider(path) } catch (e) {
    tlog(`  initScmProvider threw: ${(e as Error)?.message || e}`)
  }
  tlog('  initScmProvider done; registerSearchProviders start')
  try { await registerSearchProviders(path) } catch (e) {
    tlog(`  registerSearchProviders threw: ${(e as Error)?.message || e}`)
  }
  tlog('  registerSearchProviders done')
}

async function emitOpenWorkspaceOnce(path: string): Promise<void> {
  // B197: always tell the engine, even if the indexer event was already
  // emitted earlier in this session. The engine state is process-local
  // (vs. the indexer's per-file caching) and missing it here means
  // host_api treats every write as off-workspace.
  await notifyEngineWorkspace(path)

  if (_openWorkspaceEmitted.has(path)) {
    console.log('[opide-workspace] open-workspace already emitted for', path, '— skipping')
    return
  }
  trackPath(_openWorkspaceEmitted, path)
  const { emit } = await import('@tauri-apps/api/event')
  await emit('open-workspace', { path })
  console.log('[opide-workspace] emitted open-workspace for:', path)
}

// ─── Workspace Path ──────────────────────────────────────────────────────────

/**
 * Read the current workspace path from the URL hash.
 * Format: #/path/to/folder (Unix) or #C:/path or #C:\path (Windows) or #\\\\server\share (UNC).
 */
export function getWorkspacePath(): string | null {
  const hash = window.location.hash.slice(1)
  if (!hash) return null
  const decoded = decodeURIComponent(hash)
  // Accept Unix-style /…, UNC \\…, and Windows drive letters X:\… or X:/… (B58).
  if (decoded.startsWith('/') || decoded.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(decoded)) {
    return decoded
  }
  return null
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
              // Trigger backend indexing (guarded)
              await emitOpenWorkspaceOnce(uri.path)
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
  console.log('[opide-workspace] [step 1] pickAndOpenFolder() called')
  // Pipe to OPIDE.log so we can see it without DevTools.
  const tlog = (m: string) => {
    console.log(m)
    try { invoke('ext_host_log', { message: `[open-folder-trace] ${m}` }).catch(() => {}) } catch { /* ignore */ }
  }
  try {
    tlog('[step 2] awaiting open() dialog')
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Open Folder',
    })
    tlog(`[step 3] dialog returned: ${selected}`)

    if (!selected || typeof selected !== 'string') return false

    // Replace current workspace (remove existing folders, add new one)
    try {
      tlog('[step 4] importing services')
      const { getService, IWorkspaceEditingService, IWorkspaceContextService } = await import(
        '@codingame/monaco-vscode-api/services'
      )
      tlog('[step 5] resolving IWorkspaceEditingService')
      const editingService = (await getService(IWorkspaceEditingService)) as any
      tlog('[step 6] resolving IWorkspaceContextService')
      const ctxService = (await getService(IWorkspaceContextService)) as any

      // Hot-path detection: if there's no current workspace folder,
      // monaco-vscode-api's addFolders throws "unsupported" (it can
      // only add to an EXISTING workspace, not bootstrap one). Skip
      // straight to the hash+reload path so the bootstrap reads the
      // new folder from window.location.hash. Going through the throw
      // looked like a hang because the reload happens AFTER the catch
      // block runs synchronous fallback work.
      const existing0 = ctxService?.getWorkspace?.()?.folders ?? []
      if (existing0.length === 0) {
        tlog(`[step 7-bypass] no current workspace — skipping addFolders, using hash+reload`)
        window.location.hash = encodeURIComponent(selected)
        window.location.reload()
        return true
      }

      if (editingService?.addFolders) {
        // Remove existing folders first
        if (existing0.length > 0 && editingService?.removeFolders) {
          tlog(`[step 7] removeFolders count=${existing0.length}`)
          await editingService.removeFolders(existing0.map((f: any) => f.uri))
          tlog('[step 8] removeFolders done')
        }
        tlog('[step 9] addFolders')
        await editingService.addFolders([{ uri: URI.file(selected) }])
        tlog('[step 10] addFolders done')
        window.location.hash = encodeURIComponent(selected)
        tlog(`[step 11] Workspace replaced with: ${selected}`)

        // Initialize workspace services (guarded — only runs once per path)
        tlog('[step 12] ensureServicesForPath start')
        await ensureServicesForPath(selected)
        tlog('[step 13] ensureServicesForPath done')

        // Notify backend to index the new workspace (guarded)
        tlog('[step 14] emitOpenWorkspaceOnce start')
        await emitOpenWorkspaceOnce(selected)
        tlog('[step 15] emitOpenWorkspaceOnce done — returning true')

        return true
      }
    } catch (e) {
      console.warn('[opide-workspace] addFolders failed in picker, falling back to reload:', e)
      tlog(`[step ERR] addFolders flow threw: ${(e as Error)?.message || e}`)
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

    // If this workspace is already open, do nothing — this event was likely
    // emitted by emitOpenWorkspaceOnce() to trigger backend indexing, not to
    // switch workspaces. Without this guard, the listener tries to remove and
    // re-add the same folder, causing page flashing or a full reload loop.
    const currentPath = getWorkspacePath()
    if (currentPath === path) {
      console.log('[opide-workspace] open-workspace received for already-open path:', path, '— ignoring')
      return
    }

    console.log('[opide-workspace] Agent opening workspace:', path)

    let opened = false

    // Attempt 1: Use VS Code's IWorkspaceEditingService.addFolders
    try {
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

        await editingService.addFolders([{ uri: URI.file(path) }])

        // Wait for the folder change to propagate via the workspace event
        // rather than guessing with setTimeout(100) (B62). Bail out after 2s
        // as a safety net; falls through to the next addFolders strategy.
        const folderAdded: boolean = await new Promise<boolean>((resolve) => {
          const safety = setTimeout(() => { try { sub?.dispose?.() } catch {}; resolve(false) }, 2000)
          // If it's already there (synchronous addFolders), resolve immediately.
          const initial = ctxService?.getWorkspace?.()?.folders ?? []
          if (initial.some((f: any) => f.uri?.path === path || f.uri?.fsPath === path)) {
            clearTimeout(safety)
            resolve(true)
            return
          }
          let sub: { dispose(): void } | null = null
          sub = ctxService?.onDidChangeWorkspaceFolders?.((e: any) => {
            const added: any[] = e?.added ?? []
            if (added.some((f: any) => f?.uri?.path === path || f?.uri?.fsPath === path)) {
              clearTimeout(safety)
              try { sub?.dispose?.() } catch {}
              resolve(true)
            }
          }) ?? null
          if (!sub) {
            // No event API — best-effort short wait + recheck.
            setTimeout(() => {
              const folders = ctxService?.getWorkspace?.()?.folders ?? []
              clearTimeout(safety)
              resolve(folders.some((f: any) => f.uri?.path === path))
            }, 200)
          }
        })

        if (folderAdded) {
          console.log('[opide-workspace] Workspace replaced with:', path)
          window.location.hash = encodeURIComponent(path)

          // Initialize workspace services (guarded — only runs once per path)
          await ensureServicesForPath(path)
          opened = true
        } else {
          console.warn('[opide-workspace] addFolders returned but folder not in workspace — falling through')
        }
      }
    } catch (e) {
      console.warn('[opide-workspace] addFolders failed:', e)
    }

    // Attempt 2: try enterWorkspace
    if (!opened) {
      try {
        const { getService, IWorkspaceEditingService } = await import(
          '@codingame/monaco-vscode-api/services'
        )
        const editingService = (await getService(IWorkspaceEditingService)) as any
        if (editingService?.enterWorkspace) {
          await editingService.enterWorkspace(URI.file(path))
          window.location.hash = encodeURIComponent(path)
          opened = true
        }
      } catch (e) {
        console.warn('[opide-workspace] enterWorkspace failed:', e)
      }
    }

    // Attempt 3: reload the page with the new workspace in the hash.
    // This destroys chat state but is the only reliable way to open a new
    // workspace when the Monaco API methods silently fail.
    if (!opened) {
      console.warn('[opide-workspace] API methods failed — reloading to open workspace')
      window.location.hash = encodeURIComponent(path)
      window.location.reload()
    }
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
            // Skip if this is the workspace that was already open at boot —
            // initWorkspaceServices handles it without the event bus.
            if (_openWorkspaceEmitted.has(path) || _initializedPaths.has(path)) {
              console.log('[opide-workspace] Folder change for already-known path:', path, '— skipping')
              continue
            }
            console.log('[opide-workspace] Folder added (detected via onDidChangeWorkspaceFolders):', path)
            window.location.hash = encodeURIComponent(path)
            // Emit + init services (both guarded — only runs once per path)
            await emitOpenWorkspaceOnce(path)
            await ensureServicesForPath(path)
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
 *
 * IMPORTANT: This does NOT emit 'open-workspace' to avoid triggering
 * listenForWorkspaceOpen() which would try to re-add the folder and
 * potentially reload the page. Instead, it tells the Rust indexer
 * directly via invoke(), and initializes SCM + search in the background
 * without blocking the UI.
 */
export async function initWorkspaceServices(): Promise<void> {
  const workspace = getWorkspacePath()
  if (!workspace) {
    console.log('[opide-workspace] no workspace open — skipping SCM/search init')
    return
  }

  console.log('[opide-workspace] initializing services for', workspace)

  // Mark this path as emitted so if watchWorkspaceFolders fires later,
  // it won't emit a duplicate open-workspace event.
  _openWorkspaceEmitted.add(workspace)

  // Tell the Rust indexer directly — no event bus, no listener feedback loop.
  // The Rust side will index in a background Tokio task (non-blocking).
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    invoke('trigger_reindex', { workspace }).catch((reindexErr) => {
      // trigger_reindex may not exist on older builds — fall back to event.
      // Both paths failing means the workspace opens but indexing never
      // starts; log so the silent state is debuggable.
      import('@tauri-apps/api/event').then(({ emit }) => {
        emit('open-workspace', { path: workspace })
      }).catch((emitErr) => {
        console.warn(
          '[opide-workspace] indexing failed to start: trigger_reindex and open-workspace event both failed',
          { reindexErr, emitErr },
        )
      })
    })
  } catch {
    // Last resort: emit the event (guarded by _openWorkspaceEmitted won't double-fire)
    await emitOpenWorkspaceOnce(workspace)
  }

  // Initialize SCM + search in the background — don't block the UI.
  // These are guarded so they only run once per path.
  ensureServicesForPath(workspace).catch((e) => {
    console.warn('[opide-workspace] background service init failed:', e)
  })
}
