/**
 * OPIDE Workbench Initialization
 *
 * Boots the full VS Code workbench shell using @codingame/monaco-vscode-api v28.
 * All 55+ service overrides are registered to match the full VS Code experience.
 */

// ─── OPIDE Design System ─────────────────────────────────────────────────────
import './styles/opide-tokens.css'
import './styles/opide-overrides.css'

// ─── Default Extensions (must import before anything else) ──────────────────
// This imports ALL built-in VS Code extensions: language grammars (JS, TS, Python,
// Rust, Go, CSS, HTML, JSON, Markdown, etc.), themes, language features, git-base,
// emmet, search-result, merge-conflict, and more.
import '@codingame/monaco-vscode-all-default-extensions'

// ─── Worker setup (must be before any monaco/vscode imports) ────────────────
declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorkerUrl(_moduleId: string, label: string): string | undefined
      getWorkerOptions(_moduleId: string, label: string): WorkerOptions | undefined
    }
  }
}

const workerUrls: Record<string, string> = {
  extensionHostWorkerMain: new URL(
    '@codingame/monaco-vscode-api/workers/extensionHost.worker',
    import.meta.url,
  ).toString(),
  editorWorkerService: new URL(
    'monaco-editor/esm/vs/editor/editor.worker.js',
    import.meta.url,
  ).toString(),
}

window.MonacoEnvironment = {
  getWorkerUrl(_moduleId: string, label: string) {
    return workerUrls[label] ?? workerUrls['editorWorkerService']
  },
  getWorkerOptions(_moduleId: string, _label: string) {
    return { type: 'module' }
  },
}

// ─── Service Override Imports ────────────────────────────────────────────────
import { initialize } from '@codingame/monaco-vscode-api'


// Core platform
import getBaseServiceOverride from '@codingame/monaco-vscode-base-service-override'
import getHostServiceOverride from '@codingame/monaco-vscode-host-service-override'
import getEnvironmentServiceOverride from '@codingame/monaco-vscode-environment-service-override'
import getLogServiceOverride from '@codingame/monaco-vscode-log-service-override'
import getLifecycleServiceOverride from '@codingame/monaco-vscode-lifecycle-service-override'
// Removed (Phase 8e Tier 2): remote-agent (VS Code Remote SSH — OPIDE is local-only)

// Files, models, working copy (the editor pipeline)
import getFilesServiceOverride, { registerFileSystemOverlay } from '@codingame/monaco-vscode-files-service-override'
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override'
import getWorkingCopyServiceOverride from '@codingame/monaco-vscode-working-copy-service-override'
import getEditorServiceOverride from '@codingame/monaco-vscode-editor-service-override'

// Extensions
import getExtensionsServiceOverride from '@codingame/monaco-vscode-extensions-service-override'
import getExtensionGalleryServiceOverride from '@codingame/monaco-vscode-extension-gallery-service-override'

// Theme, language, syntax
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override'
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override'
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override'
import getLanguageDetectionWorkerServiceOverride from '@codingame/monaco-vscode-language-detection-worker-service-override'
import getSnippetsServiceOverride from '@codingame/monaco-vscode-snippets-service-override'
import getEmmetServiceOverride from '@codingame/monaco-vscode-emmet-service-override'

// Configuration, keybindings, preferences
import getConfigurationServiceOverride, { updateUserConfiguration } from '@codingame/monaco-vscode-configuration-service-override'
import getKeybindingsServiceOverride from '@codingame/monaco-vscode-keybindings-service-override'
import getPreferencesServiceOverride from '@codingame/monaco-vscode-preferences-service-override'

// UI services
import getMarkersServiceOverride from '@codingame/monaco-vscode-markers-service-override'
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override'
import getNotificationsServiceOverride from '@codingame/monaco-vscode-notifications-service-override'
import getDialogsServiceOverride from '@codingame/monaco-vscode-dialogs-service-override'
import getOutputServiceOverride from '@codingame/monaco-vscode-output-service-override'
import getAccessibilityServiceOverride from '@codingame/monaco-vscode-accessibility-service-override'

// Views — Explorer, Search, Source Control, Outline, Timeline
import getExplorerServiceOverride from '@codingame/monaco-vscode-explorer-service-override'
import getSearchServiceOverride from '@codingame/monaco-vscode-search-service-override'
import getScmServiceOverride from '@codingame/monaco-vscode-scm-service-override'
import getOutlineServiceOverride from '@codingame/monaco-vscode-outline-service-override'
import getTimelineServiceOverride from '@codingame/monaco-vscode-timeline-service-override'
// Removed (Phase 8e Tier 2): comments (PR review — needs extension, OPIDE doesn't use)

// Terminal
import getTerminalServiceOverride from '@codingame/monaco-vscode-terminal-service-override'

// Storage, workspace trust, user data
import getStorageServiceOverride from '@codingame/monaco-vscode-storage-service-override'
import getWorkspaceTrustServiceOverride from '@codingame/monaco-vscode-workspace-trust-service-override'
import getSecretStorageServiceOverride from '@codingame/monaco-vscode-secret-storage-service-override'
import getAuthenticationServiceOverride from '@codingame/monaco-vscode-authentication-service-override'
// Removed (Phase 8e Tier 2): user-data-sync (VS Code Settings Sync — no server configured)
import getUserDataProfileServiceOverride from '@codingame/monaco-vscode-user-data-profile-service-override'

// Debug, testing, tasks
import getDebugServiceOverride from '@codingame/monaco-vscode-debug-service-override'
import getTestingServiceOverride from '@codingame/monaco-vscode-testing-service-override'
import getTaskServiceOverride from '@codingame/monaco-vscode-task-service-override'

// Multi-diff, performance, localization
import getMultiDiffEditorServiceOverride from '@codingame/monaco-vscode-multi-diff-editor-service-override'
import getPerformanceServiceOverride from '@codingame/monaco-vscode-performance-service-override'
import getLocalizationServiceOverride from '@codingame/monaco-vscode-localization-service-override'
// Removed (Phase 8d): Notebook, Interactive, Speech, Relauncher
// Removed (Phase 8e Tier 1): Chat (5.5MB — OPIDE has own chat), Telemetry (sends to Microsoft),
//   Welcome (startupEditor:'none'), Update (Tauri handles), EditSessions (cloud feature)

// Full workbench shell — manages activity bar, sidebar, editor, panel, status bar
import getWorkbenchServiceOverride from '@codingame/monaco-vscode-workbench-service-override'

// ─── OPIDE custom modules ───────────────────────────────────────────────────
import { TauriFileSystemProvider } from './tauri-fs-provider.ts'
import { OpideTerminalBackend } from './opide/terminal-backend.ts'
import { createWorkspaceProvider } from './opide/workspace.ts'
import { registerOpideSettingsPane } from './opide/opide-provider-settings.ts'
import { registerOpideChat } from './opide/chat/index.ts'
import { registerInlineEdit } from './opide/opide-inline.ts'
import { registerGhostCompletions } from './opide/opide-completions.ts'
import { registerOpideExtensions } from './opide/opide-extensions.ts'
import { registerMemoryPalace } from './opide/opide-memory-palace.ts'
import { registerActivityFeed } from './opide/opide-activity-feed.ts'
import { initEditorIntegration } from './opide/opide-editor.ts'

// ─── Workbench initialization ─────────────────────────────────────────────────

function setLoadingStatus(msg: string) {
  const el = document.getElementById('opide-load-status')
  if (el) el.textContent = msg
  else console.log('[opide-boot]', msg)
}

export async function initializeWorkbench(): Promise<void> {
  const container = document.getElementById('workbench-shell')!

  // Inject a visible status line into the loading screen
  const loading = document.getElementById('workbench-loading')
  if (loading) {
    const statusEl = document.createElement('div')
    statusEl.id = 'opide-load-status'
    statusEl.style.cssText = 'margin-top:12px;font-size:11px;color:#888;font-family:monospace'
    statusEl.textContent = 'Waiting for IPC...'
    loading.querySelector('.loading-inner')?.appendChild(statusEl)
  }

  // ─── Wait for Tauri IPC bridge to be ready ────────────────────────────────
  setLoadingStatus('Waiting for Tauri IPC...')
  let ipcWaitMs = 0
  await new Promise<void>((resolve) => {
    const check = () => {
      if ((window as any).__TAURI_INTERNALS__?.invoke) {
        resolve()
      } else {
        ipcWaitMs += 10
        if (ipcWaitMs % 1000 === 0) setLoadingStatus(`Waiting for Tauri IPC... ${ipcWaitMs/1000}s`)
        if (ipcWaitMs > 10000) {
          // IPC never came — proceed anyway (browser mode / stale binary)
          console.warn('[opide] Tauri IPC not available after 10s, proceeding without it')
          resolve()
          return
        }
        setTimeout(check, 10)
      }
    }
    check()
  })

  // ─── Register FS provider BEFORE initialize() ─────────────────────────────
  setLoadingStatus('Registering file system...')
  registerFileSystemOverlay(1, new TauriFileSystemProvider())

  setLoadingStatus('Initializing VS Code workbench...')
  await initialize(
    {
      // ── Core platform ──────────────────────────────────────────────────
      ...getBaseServiceOverride(),
      ...getHostServiceOverride(),
      ...getEnvironmentServiceOverride(),
      ...getLogServiceOverride(),
      ...getLifecycleServiceOverride(),
      // remote-agent removed (Phase 8e Tier 2)

      // ── Files → Models → Working Copy → Editor (the pipeline) ──────────
      ...getFilesServiceOverride(),
      ...getModelServiceOverride(),
      ...getWorkingCopyServiceOverride(),
      ...getEditorServiceOverride(async (_resource, _options, _sideBySide) => {
        return false
      }),

      // ── Extensions ─────────────────────────────────────────────────────
      ...getExtensionsServiceOverride({
        enableWorkerExtensionHost: true,
      }),
      ...getExtensionGalleryServiceOverride({ webOnly: false }),

      // ── Theme, language, syntax ────────────────────────────────────────
      ...getThemeServiceOverride(),
      ...getTextmateServiceOverride(),
      ...getLanguagesServiceOverride(),
      ...getLanguageDetectionWorkerServiceOverride(),
      ...getSnippetsServiceOverride(),
      ...getEmmetServiceOverride(),

      // ── Configuration, keybindings, preferences ────────────────────────
      ...getConfigurationServiceOverride(),
      ...getKeybindingsServiceOverride(),
      ...getPreferencesServiceOverride(),

      // ── UI services ────────────────────────────────────────────────────
      ...getMarkersServiceOverride(),
      ...getQuickAccessServiceOverride(),
      ...getNotificationsServiceOverride(),
      ...getDialogsServiceOverride(),
      ...getOutputServiceOverride(),
      ...getAccessibilityServiceOverride(),

      // ── Views ──────────────────────────────────────────────────────────
      ...getExplorerServiceOverride(),
      ...getSearchServiceOverride(),
      ...getScmServiceOverride(),
      ...getOutlineServiceOverride(),
      ...getTimelineServiceOverride(),
      // comments removed (Phase 8e Tier 2)

      // ── Terminal ───────────────────────────────────────────────────────
      ...getTerminalServiceOverride(new OpideTerminalBackend()),

      // ── Storage, trust, auth, user data ────────────────────────────────
      ...getStorageServiceOverride(),
      ...getWorkspaceTrustServiceOverride(),
      ...getSecretStorageServiceOverride(),
      ...getAuthenticationServiceOverride(),
      ...getUserDataProfileServiceOverride(),

      // ── Debug, testing, tasks ──────────────────────────────────────────
      ...getDebugServiceOverride(),
      ...getTestingServiceOverride(),
      ...getTaskServiceOverride(),

      // ── Editor features ────────────────────────────────────────────────
      ...getMultiDiffEditorServiceOverride(),
      ...getPerformanceServiceOverride(),
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — works at runtime with 0 args
      ...getLocalizationServiceOverride(),

      // ── Full workbench shell (must be last) ────────────────────────────
      ...getWorkbenchServiceOverride(),
    },
    container,
    {
      productConfiguration: {
        nameShort: 'OPIDE',
        nameLong: 'OPIDE — Agent Workspace',
        applicationName: 'opide',
        dataFolderName: '.opide',
        // Must match a real VS Code version so extensions pass engines.vscode check.
        // @codingame/monaco-vscode-api v28 ≈ VS Code 1.96.x
        version: '1.96.0',
        // Open VSX — the open extension registry (not Microsoft Marketplace)
        extensionsGallery: {
          serviceUrl: 'https://open-vsx.org/vscode/gallery',
          extensionUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
          resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
          controlUrl: '',
          nlsBaseUrl: '',
        },
      },

      workspaceProvider: createWorkspaceProvider(),

      configurationDefaults: {
        'workbench.colorTheme': 'Default Dark Modern',
        'editor.fontFamily': "'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace",
        'editor.fontSize': 13,
        'editor.tabSize': 2,
        'editor.renderWhitespace': 'selection',
        'editor.minimap.enabled': false,
        'workbench.startupEditor': 'none',
        'window.menuBarVisibility': 'hidden',
        'workbench.activityBar.location': 'default',
        // Prevent command palette from closing on spurious focus loss in Tauri WKWebView.
        'workbench.quickOpen.closeOnFocusLost': false,
        // Enable Prettier extension (it defaults to disabled if config returns undefined)
        'prettier.enable': true,
        // File icon theme — Seti gives proper per-type icons (COBOL, JS, etc.)
        'workbench.iconTheme': 'vs-seti',
        // Merge single-child folders into one row to keep the tree compact
        'explorer.compactFolders': true,
      },
    },
  )

  // Core workbench initialized — loading screen can now be removed.
  // Everything below runs in initializeDeferredFeatures() AFTER the UI is visible.
}

/**
 * Phase 2: Deferred features — runs AFTER the loading screen is removed.
 * AI features, extensions, MCP servers, workspace services, indexing.
 * The user sees the IDE immediately while these initialize in the background.
 */
export async function initializeDeferredFeatures(): Promise<void> {
  console.log('[opide] Starting deferred features...')

  // ─── Start OpenPawz Engine Event Bus (must be before any views load) ────
  try {
    const { pawEngine } = await import('@openpawz/engine')
    await pawEngine.startListening()
    console.log('[opide] OpenPawz engine event bus started')
  } catch (e) {
    console.warn('[opide] Engine event bus failed:', e)
  }

  // ─── OPIDE AI Features ──────────────────────────────────────────────────
  // Each feature in its own try/catch so one failure doesn't kill the rest
  try { registerOpideSettingsPane() } catch (e) { console.warn('[opide] settings pane failed:', e) }
  try { registerOpideChat() } catch (e) { console.warn('[opide] chat failed:', e) }
  try { registerInlineEdit() } catch (e) { console.warn('[opide] inline edit failed:', e) }
  try { registerGhostCompletions() } catch (e) { console.warn('[opide] completions failed:', e) }
  try { registerOpideExtensions() } catch (e) { console.warn('[opide] extensions panel failed:', e) }
  try { registerMemoryPalace() } catch (e) { console.warn('[opide] memory palace failed:', e) }
  try { registerActivityFeed() } catch (e) { console.warn('[opide] activity feed failed:', e) }
  initEditorIntegration().catch(e => console.warn('[opide] editor integration failed:', e))

  // Register edit review listener immediately — before agent can start
  import('./opide/opide-tool-bridge.ts').then(({ initEditReviewListener, initToolBridge }) => {
    initEditReviewListener()
    initToolBridge().catch(e => console.warn('[opide] tool bridge failed:', e))
  })
  console.log('[opide] AI features registered')

  // ─── Register Open Folder command in command palette ────────────────────
  const { CommandsRegistry } = await import('@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands')
  const { pickAndOpenFolder } = await import('./opide/workspace.ts')

  CommandsRegistry.registerCommand('opide.openFolder', () => pickAndOpenFolder())
  CommandsRegistry.registerCommand('workbench.action.files.openFolder', () => pickAndOpenFolder())

  // ─── Register Extension MCP Adapters ─────────────────────────────────────
  try {
    const {
      registerExtensionAdapters, registerFormatCommand,
      registerInstallCommand, scanAndRegisterInstalledExtensions,
    } = await import('./opide/extension-mcp.ts')
    await registerFormatCommand()
    await registerInstallCommand()
    // Register known adapters + scan installed extensions after MCP registry initializes
    setTimeout(async () => {
      await registerExtensionAdapters().catch((e) =>
        console.warn('[opide] Extension adapter registration failed:', e),
      )
      await scanAndRegisterInstalledExtensions().catch((e) =>
        console.warn('[opide] Extension scan failed:', e),
      )
    }, 2000)
  } catch (e) {
    console.warn('[opide] Extension MCP setup failed:', e)
  }


  // ─── Load installed extensions into the workbench ──────────────────────────
  // Registers themes, grammars, icon packs, snippets, keybindings, etc.
  // Runs on requestIdleCallback so it never blocks folder open or UI.
  try {
    const { loadAllInstalledExtensions } = await import('./opide/extension-loader.ts')
    const startLoader = () => {
      loadAllInstalledExtensions().catch((e) =>
        console.warn('[opide] Extension loader failed:', e),
      )
    }
    // Use idle callback if available, otherwise a long delay
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(startLoader, { timeout: 15000 })
    } else {
      setTimeout(startLoader, 10000)
    }
  } catch (e) {
    console.warn('[opide] Extension loader setup failed:', e)
  }

  // ─── Hide VS Code Extensions icon (we have our own Extensions panel) ─────────
  // Hide VS Code's built-in Extensions icon (aria includes keyboard shortcut ⇧⌘X)
  // Ours has aria="Extensions", theirs has aria="Extensions (⇧⌘X)"
  function hideVscodeExtensions() {
    document.querySelectorAll('.activitybar .action-item').forEach(el => {
      const label = el.querySelector('.action-label')
      const aria = label?.getAttribute('aria-label') || ''
      if (aria.includes('Extensions') && aria.includes('⇧⌘X')) {
        ;(el as HTMLElement).style.display = 'none'
      }
    })
  }
  setTimeout(hideVscodeExtensions, 1500)
  setTimeout(hideVscodeExtensions, 3000)

  // ─── Watermark patcher — replaces VS Code icon with OPIDE paw ───────────────
  function patchWatermark() {
    const letterpress = document.querySelector<HTMLElement>(
      '.monaco-workbench .editor-group-watermark .letterpress, .monaco-workbench .editor-group-watermark > .letterpress'
    )
    if (letterpress) {
      letterpress.style.cssText += ';background:url("/brand-paw.png") center/contain no-repeat!important;width:180px!important;height:180px!important;font-size:0!important;color:transparent!important;opacity:1!important;filter:none!important'
      Array.from(letterpress.children).forEach(c => { (c as HTMLElement).style.display = 'none' })
    }
  }
  // Run patchWatermark a few times on startup then stop.
  // Do NOT use a MutationObserver on document.body — it fires on every DOM
  // change (including streaming chat updates) and causes focus stealing.
  patchWatermark()
  setTimeout(patchWatermark, 500)
  setTimeout(patchWatermark, 1500)
  setTimeout(patchWatermark, 3000)
  setTimeout(patchWatermark, 6000)

  // ─── Start Extension Host (Node.js sidecar for full extension support) ─────
  try {
    const { startExtensionHost, onExtensionsReady, initExtensionInstallSync } = await import('./opide/extension-bridge.ts')
    const { getWorkspace } = await import('./opide/ide-context.ts')

    // Sync workbench extension installs to the Node.js sidecar
    initExtensionInstallSync().catch((e) =>
      console.warn('[opide] Extension install sync failed:', e),
    )

    onExtensionsReady(async (extensions) => {
      console.log(`[opide] Extension host ready: ${extensions.length} extensions loaded`)
      extensions.forEach((ext) => {
        console.log(`[opide]   ${ext.id} (${ext.commands.length} commands)`)
      })

      // Send the current active editor to the sidecar now that it's ready
      try {
        const { getService: getSvc, ICodeEditorService: ICodeEdSvc } = await import('@codingame/monaco-vscode-api/services')
        const edSvc = await getSvc(ICodeEdSvc) as any
        const ed = edSvc?.getActiveCodeEditor?.()
        const model = ed?.getModel?.()
        if (model?.uri?.scheme === 'file') {
          const { notifyActiveEditorChanged } = await import('./opide/extension-bridge.ts')
          const path = model.uri.fsPath || model.uri.path
          const lang = model.getLanguageId?.() ?? 'plaintext'
          const content = model.getValue?.() || ''
          notifyActiveEditorChanged(path, lang, content, model.getVersionId?.() ?? 1)
        }
      } catch { /* no active editor yet, that's fine */ }
    })

    // Kill any orphaned sidecar before starting a new one (Bug #3: page reload orphans)
    const { stopExtensionHost } = await import('./opide/extension-bridge.ts')
    await stopExtensionHost().catch(() => {})

    // Clean up sidecar on page unload (folder open triggers reload)
    window.addEventListener('beforeunload', () => {
      stopExtensionHost().catch(() => {})
    })

    // Start the extension host if we have a workspace
    const ws = getWorkspace()
    console.log('[opide] Extension host: workspace =', ws)
    if (ws) {
      // Resolve extensions path from workspace path (Bug #1: echo $HOME was wrong)
      let extDir: string | undefined

      // Extract home dir from workspace path — reliable on macOS/Linux
      if (ws.startsWith('/Users/')) {
        const username = ws.split('/')[2]
        if (username) extDir = `/Users/${username}/.opide/extensions`
      } else if (ws.startsWith('/home/')) {
        const username = ws.split('/')[2]
        if (username) extDir = `/home/${username}/.opide/extensions`
      }

      // Final fallback: try Tauri shell command
      if (!extDir) {
        try {
          const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
          const homeResult = await tauriInvoke('ide_run_command', {
            command: 'echo $HOME',
            cwd: '/',
          }) as any
          const home = (homeResult?.stdout || '').trim()
          if (home) extDir = `${home}/.opide/extensions`
        } catch (e2) {
          console.warn('[opide] Could not resolve home dir:', e2)
        }
      }

      console.log('[opide] Extension host: extDir =', extDir)
      startExtensionHost(ws, extDir).catch((e) => {
        console.warn('[opide] Extension host failed to start:', e)
      })
    } else {
      console.log('[opide] Extension host: no workspace, skipping')
    }
  } catch (e) {
    console.warn('[opide] Extension bridge setup failed:', e)
  }

  // ─── Listen for agent-triggered workspace open ────────────────────────────
  try {
    const { listenForWorkspaceOpen, watchWorkspaceFolders, initWorkspaceServices } = await import('./opide/workspace.ts')
    await listenForWorkspaceOpen()
    await watchWorkspaceFolders()
    await initWorkspaceServices()
  } catch (e) {
    console.warn('[opide] Workspace listener setup failed:', e)
  }

  // ─── Apply OPIDE theme colors ─────────────────────────────────────────────
  await updateUserConfiguration(JSON.stringify({
    'workbench.colorCustomizations': {
      'activityBar.background': '#111111',
      'activityBar.activeBorder': '#E8B931',
      'activityBar.foreground': '#cccccc',
      'activityBar.inactiveForeground': '#555555',
      'activityBarBadge.background': '#E8B931',
      'activityBarBadge.foreground': '#ffffff',
      'statusBar.background': '#C49A1D',
      'statusBar.foreground': '#ffffff',
      'statusBar.noFolderBackground': '#333333',
      'sideBar.background': '#161616',
      'sideBarSectionHeader.background': '#111111',
      'editorGroupHeader.tabsBackground': '#131313',
      'tab.activeBackground': '#1a1a1a',
      'tab.inactiveBackground': '#131313',
      'tab.border': '#111111',
      'panel.background': '#161616',
      'panel.border': '#222222',
      'panelTitle.activeBorder': '#E8B931',
      'focusBorder': '#E8B931',
      'button.background': '#E8B931',
      'button.hoverBackground': '#F0CC50',
      'list.activeSelectionBackground': '#292312',
      'list.activeSelectionForeground': '#E8B931',
      'list.inactiveSelectionBackground': '#1e1b0e',
      'list.focusBackground': '#292312',
      'list.hoverBackground': '#1a1a1a',
      'list.focusOutline': '#E8B931',
      'progressBar.background': '#E8B931',
      'titleBar.activeBackground': '#111111',
      // Git decorations — keep them subtle, never red
      'gitDecoration.modifiedResourceForeground': '#E8B931',
      'gitDecoration.untrackedResourceForeground': '#7ec8a0',
      'gitDecoration.ignoredResourceForeground': '#444444',
      'gitDecoration.deletedResourceForeground': '#888888',
      'gitDecoration.renamedResourceForeground': '#7ec8a0',
      'gitDecoration.stageModifiedResourceForeground': '#E8B931',
      'gitDecoration.conflictingResourceForeground': '#E8B931',
    },
  }))
}
