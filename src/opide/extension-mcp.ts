// ── Extension MCP Bridge ─────────────────────────────────────────────────────
// Registers extension MCP adapters in the OpenPawz MCP registry and wires
// their tools to the command palette + editor actions.
//
// Each adapter is a standalone Node.js MCP server (stdio transport).
// The existing OpenPawz MCP infrastructure handles all protocol details,
// tool discovery, execution routing, security, and lifecycle.

import { invoke } from '@tauri-apps/api/core'

// ─── Types ───────────────────────────────────────────────────────────────────

interface McpServerConfig {
  id: string
  name: string
  transport: string // 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
  url: string
  enabled: boolean
}

interface AdapterInfo {
  id: string
  name: string
  adapterPath: string
  languages?: string[]
}

// ─── Track registered servers to prevent double-spawn ───────────────────────

const _registeredServers = new Set<string>()

// ─── Known adapters ──────────────────────────────────────────────────────────

const ADAPTERS: AdapterInfo[] = [
  {
    id: 'ext-prettier',
    name: 'Prettier',
    adapterPath: 'extension-adapters/prettier.mcp.cjs',
    languages: ['javascript', 'typescript', 'css', 'html', 'json', 'markdown', 'yaml'],
  },
  // Future: eslint, tailwind, etc.
]

// ─── Resolve adapter path ────────────────────────────────────────────────────

async function resolveAdapterPath(relativePath: string): Promise<string> {
  // The extension host bootstrap resolves via Rust using a path like:
  //   .../src-tauri/target/debug/../../../node-extension-host/dist/bootstrap.js
  // The ../../.. from the binary = the project root.
  // We use the same trick: ask Rust where the binary is, go up 3 dirs.
  try {
    const result = await invoke('ide_run_command', {
      command: 'cd "$(dirname "$(ps -o comm= $$)")/../../.." 2>/dev/null && pwd',
      cwd: '/',
    }) as any
    const root = (result?.stdout || '').trim()
    if (root && root.length > 3) return `${root}/${relativePath}`
  } catch {}

  // Fallback: derive from home directory
  const home = await getHomeDir()
  return `${home}/Desktop/OPIDE/${relativePath}`
}

// ─── Register all adapters ───────────────────────────────────────────────────

export async function registerExtensionAdapters(workspacePath?: string): Promise<void> {
  // Get workspace path for the adapters to resolve packages from
  let wsPath = workspacePath
  if (!wsPath) {
    try {
      const { getWorkspace } = await import('./ide-context.ts')
      wsPath = getWorkspace() || undefined
    } catch {}
  }

  for (const adapter of ADAPTERS) {
    if (_registeredServers.has(adapter.id)) {
      console.log(`[ext-mcp] Skipping ${adapter.name} — already registered`)
      continue
    }
    try {
      const adapterFullPath = await resolveAdapterPath(adapter.adapterPath)

      const config: McpServerConfig = {
        id: adapter.id,
        name: adapter.name,
        transport: 'stdio',
        command: 'node',
        args: [adapterFullPath],
        env: wsPath ? { OPIDE_WORKSPACE: wsPath } : {},
        url: '',
        enabled: true,
      }

      // Save the server config
      await invoke('engine_mcp_save_server', { server: config })

      // Connect to it (spawns the process, performs handshake, discovers tools)
      await invoke('engine_mcp_connect', { id: adapter.id })

      _registeredServers.add(adapter.id)
      console.log(`[ext-mcp] Registered adapter: ${adapter.name} (${adapter.id})`)
    } catch (e) {
      console.warn(`[ext-mcp] Failed to register ${adapter.name}:`, e)
    }
  }
}

// ─── Format Document via MCP ─────────────────────────────────────────────────

export async function formatDocumentViaMcp(
  filePath: string,
  language: string,
  content: string,
): Promise<string | null> {
  try {
    // Find the right adapter for this language
    const adapter = ADAPTERS.find(a =>
      a.languages?.includes(language)
    )

    if (!adapter) {
      console.log(`[ext-mcp] No formatter adapter for language: ${language}`)
      return null
    }

    invoke('ext_host_log', { message: `formatDocumentViaMcp: calling MCP tool for ${adapter.id}` }).catch(() => {})

    const result = await invoke('engine_mcp_execute_tool', {
      serverId: adapter.id,
      toolName: 'format_document',
      arguments: JSON.stringify({
        content,
        file_path: filePath,
        language,
      }),
    }) as any

    // Parse the MCP result
    if (result?.content?.[0]?.text) {
      return result.content[0].text
    }

    // Result might be a string directly
    if (typeof result === 'string') {
      try {
        const parsed = JSON.parse(result)
        if (parsed?.content?.[0]?.text) return parsed.content[0].text
      } catch {
        return result
      }
    }

    console.warn('[ext-mcp] Unexpected format result:', result)
    return null
  } catch (e) {
    console.warn(`[ext-mcp] Format failed:`, e)
    return null
  }
}

// ─── Register Format Document command ────────────────────────────────────────

export async function registerFormatCommand(): Promise<void> {
  try {
    const actionsModule = await import(
      '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions'
    )

    const { Action2, registerAction2 } = actionsModule
    if (!registerAction2 || !Action2) return

    registerAction2(class extends Action2 {
      static readonly id = 'opide.formatDocument'
      constructor() {
        super({
          id: 'opide.formatDocument',
          title: { value: 'Format Document (MCP)', original: 'Format Document (MCP)' },
          f1: true,
        })
      }
      async run(): Promise<void> {
        invoke('ext_host_log', { message: 'Format Document (MCP) triggered' }).catch(() => {})
        try {
          const { getService, ICodeEditorService } = await import(
            '@codingame/monaco-vscode-api/services'
          )
          const editorService = await getService(ICodeEditorService) as any
          const editor = editorService?.getActiveCodeEditor?.()
          const model = editor?.getModel?.()
          if (!model) {
            invoke('ext_host_log', { message: 'Format: no active model' }).catch(() => {})
            return
          }

          const uri = model.uri
          if (uri.scheme !== 'file') {
            invoke('ext_host_log', { message: `Format: not a file scheme: ${uri.scheme}` }).catch(() => {})
            return
          }

          const filePath = uri.fsPath || uri.path
          const language = model.getLanguageId?.() ?? 'plaintext'
          const content = model.getValue?.() ?? ''
          invoke('ext_host_log', { message: `Format: ${filePath} (${language}, ${content.length} chars)` }).catch(() => {})

          const formatted = await formatDocumentViaMcp(filePath, language, content)
          invoke('ext_host_log', { message: `Format result: ${formatted ? formatted.length + ' chars' : 'null'}` }).catch(() => {})

          if (formatted && formatted !== content) {
            const fullRange = model.getFullModelRange()
            editor.executeEdits('prettier-mcp', [{
              range: fullRange,
              text: formatted,
              forceMoveMarkers: true,
            }])
            invoke('ext_host_log', {
              message: `Formatted ${filePath} (${content.length} → ${formatted.length} chars)`,
            }).catch(() => {})
          } else {
            invoke('ext_host_log', { message: 'Format: no changes or null result' }).catch(() => {})
          }
        } catch (e) {
          invoke('ext_host_log', { message: `Format FAILED: ${e}` }).catch(() => {})
        }
      }
    })

    console.log('[ext-mcp] Format Document command registered')
  } catch (e) {
    console.warn('[ext-mcp] Failed to register format command:', e)
  }
}

// ─── Install Extension from Open VSX ─────────────────────────────────────────

/**
 * Download and install a VS Code extension from Open VSX.
 * Extracts to ~/.opide/extensions/{publisher}.{name}/
 * Then checks for a matching MCP adapter and registers it.
 */
/**
 * Validate an extension id (`publisher.name`) before letting it anywhere
 * near a URL or filesystem path. Refuses anything outside the canonical
 * shape — including `..`, slashes, and empty segments — which closes the
 * shell-injection vector that B63 documented.
 */
function validateExtensionId(id: string): { publisher: string; name: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) {
    throw new Error(`Invalid extension id: '${id}' (expected publisher.name with [A-Za-z0-9_.-])`)
  }
  if (id.includes('..') || id.includes('/') || id.includes('\\')) {
    throw new Error(`Invalid extension id: '${id}' (path-like characters refused)`)
  }
  const dot = id.indexOf('.')
  return { publisher: id.slice(0, dot), name: id.slice(dot + 1) }
}

export async function installExtensionFromOpenVsx(extensionId: string): Promise<boolean> {
  const log = (msg: string) => invoke('ext_host_log', { message: `[install] ${msg}` }).catch(() => {})

  try {
    await log(`Installing ${extensionId}...`)

    // B63: validate id BEFORE we use it in any URL or file path.
    let publisher: string, name: string
    try {
      ({ publisher, name } = validateExtensionId(extensionId))
    } catch (e) {
      await log(String(e))
      return false
    }

    // Get the home dir for extensions path
    const extBase = await getExtensionsBase()
    const extDir = `${extBase}/${extensionId}`

    // B63: fetch metadata via the native ext_fetch_url_text command, which
    // validates the host against an Open VSX/Marketplace allowlist and
    // refuses non-https URLs. No more curl-in-shell with interpolated
    // server data.
    await log(`Fetching metadata from Open VSX...`)
    let stdout = ''
    try {
      stdout = await invoke('ext_fetch_url_text', {
        url: `https://open-vsx.org/api/${publisher}/${name}`,
      }) as string
    } catch (e) {
      await log(`Metadata fetch failed: ${e}`)
    }

    let version = 'latest'
    let downloadUrl = ''
    try {
      const metadata = JSON.parse(stdout)
      version = metadata.version || 'latest'

      // Some extensions (Claude Code, ripgrep-based extensions, native
      // binary wrappers) ship platform-specific VSIXes. The metadata's
      // `files.download` is whatever the publisher uploaded LAST, which
      // may not match our host architecture, and `metadata.targetPlatform`
      // tells you which platform the response itself is keyed to.
      // Re-fetch the platform-specific endpoint when our host platform
      // doesn't match what the API returned, then pull download from there.
      let targetPlatform = ''
      try {
        targetPlatform = await invoke<string>('get_target_platform')
      } catch { /* unknown host — fall through to publisher default */ }

      const responsePlatform: string = metadata.targetPlatform || ''
      // 'universal' means the publisher uploaded a single VSIX that runs
      // on every platform — that's what we want regardless of host arch,
      // so no re-fetch needed. Same when the API returned no platform tag
      // at all (the extension only ships one build).
      const isUniversal = !responsePlatform || responsePlatform === 'universal'
      if (targetPlatform && !isUniversal && responsePlatform !== targetPlatform) {
        // The default response was for the wrong platform; re-fetch ours.
        // URL shape: /api/{publisher}/{name}/{targetPlatform}/{version}
        await log(`Default API response is for ${responsePlatform}; re-fetching ${targetPlatform}...`)
        try {
          const platStdout = await invoke('ext_fetch_url_text', {
            url: `https://open-vsx.org/api/${publisher}/${name}/${targetPlatform}/${version}`,
          }) as string
          const platMeta = JSON.parse(platStdout)
          if (platMeta?.files?.download) {
            downloadUrl = platMeta.files.download
            version = platMeta.version || version
          }
        } catch (e) {
          await log(`Platform-specific fetch failed (${e}); falling back to default VSIX.`)
        }
      }

      // Either we already had the right platform, or the platform-specific
      // re-fetch failed. Use whatever metadata.files.download is, falling
      // back to a constructed /latest/file/ URL for extensions that don't
      // populate the file map (rare).
      if (!downloadUrl) {
        downloadUrl = metadata.files?.download
          || `https://open-vsx.org/api/${publisher}/${name}/${version}/file/${extensionId}-${version}.vsix`
      }
      await log(`Found: ${metadata.displayName || name} v${version}${targetPlatform ? ` (${targetPlatform})` : ''}`)
    } catch {
      downloadUrl = `https://open-vsx.org/api/${publisher}/${name}/latest/file/${extensionId}-latest.vsix`
      await log(`Metadata parse failed, trying direct download`)
    }

    // B63: download via native command (also allowlisted).
    const vsixPath = `/tmp/opide-${extensionId}.vsix`
    await log(`Downloading .vsix from ${downloadUrl}...`)
    try {
      await invoke('ext_download_url_to_path', { url: downloadUrl, destPath: vsixPath })
      await log(`Download complete (saved to ${vsixPath})`)
    } catch (e) {
      await log(`Download failed: ${e}`)
      return false
    }

    // B64: extract via native zip command. Skips entries whose names
    // contain `..` or absolute paths and confines extraction to extDir.
    await log(`Extracting to ${extDir} (vsix=${vsixPath})...`)
    try {
      await invoke('ext_extract_vsix', { vsixPath, targetDir: extDir })
      await log(`Extraction complete`)
    } catch (e) {
      await log(`Extraction failed: ${e}`)
      return false
    }

    // Verify package.json exists via the existing read_file tool.
    // ide_read_file returns { content, language, size, ... } not a raw
    // string; the previous `as string` cast was a TypeScript lie that
    // crashed at runtime when extracting Claude Code (the first
    // extension whose install actually got this far). Pull the
    // content field out before string-checking.
    let pkgContent = ''
    try {
      const r = await invoke<{ content?: string }>('ide_read_file', {
        path: `${extDir}/package.json`,
      })
      pkgContent = r?.content ?? ''
    } catch {
      // ignore — handled by the `includes` check below
    }
    if (!pkgContent.includes('"name"')) {
      await log(`Install failed — no valid package.json in extracted extension`)
      return false
    }

    await log(`Extension ${extensionId} installed to ${extDir}`)

    // Register with the workbench (themes, grammars, icons, activation)
    try {
      const { loadExtensionFromDisk } = await import('./extension-loader.ts')
      await loadExtensionFromDisk(extDir, extensionId)
    } catch (e) {
      await log(`Workbench registration failed (non-fatal): ${e}`)
    }

    // Check for matching MCP adapter and register
    await registerAdapterForExtension(extensionId, extDir)

    // The Node sidecar scanned ~/.opide/extensions ONCE at startup. To
    // pick up an extension that was installed AFTER the sidecar started,
    // we have to bounce the sidecar so its scanner re-runs. Without
    // this, the freshly-installed extension never activates and its
    // contributed views never pre-mount — symptom is "I installed it
    // but nothing shows in the sidebar."
    try {
      await log(`Restarting extension host so ${extensionId} activates…`)
      const { restartExtensionHost } = await import('./extension-bridge.ts')
      await restartExtensionHost()
    } catch (e) {
      await log(`Extension host restart failed (non-fatal): ${e}`)
    }

    return true
  } catch (e) {
    invoke('ext_host_log', { message: `[install] FAILED: ${e}` }).catch(() => {})
    return false
  }
}

/** Resolve the user's home directory dynamically */
async function getHomeDir(): Promise<string> {
  // Try Tauri's path API first
  try {
    const { homeDir } = await import('@tauri-apps/api/path')
    const home = await homeDir()
    if (home && home.length > 1) return home.replace(/\/+$/, '')
  } catch {}

  // Fallback: shell $HOME
  try {
    const result = await invoke('ide_run_command', {
      command: 'echo $HOME',
      cwd: '/',
    }) as any
    const home = (result?.stdout || '').trim()
    if (home && home.length > 1) return home
  } catch {}

  // Last resort: derive from workspace path
  try {
    const { getWorkspace } = await import('./ide-context.ts')
    const ws = getWorkspace()
    if (ws?.startsWith('/Users/')) return `/Users/${ws.split('/')[2]}`
    if (ws?.startsWith('/home/')) return `/home/${ws.split('/')[2]}`
  } catch {}

  return '/tmp'
}

/** Get the base extensions directory (~/.opide/extensions) */
async function getExtensionsBase(): Promise<string> {
  const home = await getHomeDir()
  return `${home}/.opide/extensions`
}

/** Install a local .vsix file: extract it into the extensions directory and
 * restart the host so the scanner picks it up. This is the real fallback for
 * installVsixFile when the workbench's IExtensionManagementService.installVSIX
 * isn't available — previously the fallback sent an extension/installVsix RPC
 * the sidecar never handled (silent 30s timeout). */
export async function installVsixFromPath(vsixPath: string): Promise<void> {
  const log = (msg: string) => invoke('ext_host_log', { message: `[install-vsix] ${msg}` }).catch(() => {})
  const extBase = await getExtensionsBase()
  // Derive a stable target dir from the file name. The scanner reads the real
  // id (publisher.name) from each extracted package.json, so the directory
  // name itself doesn't need to match the extension id.
  const base = (vsixPath.split('/').pop() || 'extension')
    .replace(/\.vsix$/i, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
  const targetDir = `${extBase}/${base}`
  await log(`Extracting ${vsixPath} → ${targetDir}`)
  await invoke('ext_extract_vsix', { vsixPath, targetDir })
  await log('Extraction complete; restarting extension host')
  const { restartExtensionHost } = await import('./extension-bridge.ts')
  await restartExtensionHost()
}

/** Check for a matching adapter and register it as an MCP server */
async function registerAdapterForExtension(extensionId: string, _extDir: string): Promise<void> {
  const log = (msg: string) => invoke('ext_host_log', { message: `[adapter] ${msg}` }).catch(() => {})

  // Check for pre-built adapter in extension-adapters/
  const adapterName = `${extensionId}.mcp.cjs`
  const adapterPath = await resolveAdapterPath(`extension-adapters/${adapterName}`)

  // Check if the pre-built adapter exists
  const checkResult = await invoke('ide_run_command', {
    command: `test -f "${adapterPath}" && echo "exists" || echo "missing"`,
    cwd: '/',
  }) as any
  const exists = (checkResult?.stdout || '').trim() === 'exists'

  if (exists) {
    const serverId = `ext-${extensionId.replace(/\./g, '-')}`
    if (_registeredServers.has(serverId)) {
      await log(`Skipping ${extensionId} — already registered as ${serverId}`)
      return
    }
    await log(`Found pre-built adapter: ${adapterPath}`)
    // Register in MCP registry
    const wsPath = await getWorkspacePath()
    const config: McpServerConfig = {
      id: serverId,
      name: extensionId.split('.').pop() || extensionId,
      transport: 'stdio',
      command: 'node',
      args: [adapterPath],
      env: wsPath ? { OPIDE_WORKSPACE: wsPath } : {},
      url: '',
      enabled: true,
    }
    await invoke('engine_mcp_save_server', { server: config })
    await invoke('engine_mcp_connect', { id: config.id })
    _registeredServers.add(serverId)
    await log(`Adapter registered as MCP server: ${config.id}`)
  } else {
    // Phase A-I made the extension host load extensions natively. The
    // legacy "generate an MCP adapter for this extension" path called
    // an LLM (Moonshot, OpenAI, etc) to write a custom MCP wrapper for
    // every fresh install. That predates the real extension host and
    // is now dead weight: it blocks the install UI, hammers the user's
    // API quota, and wraps extensions that already work without any
    // wrapper. Skipped entirely.
    //
    // The extension itself is loaded into the workbench above via
    // loadExtensionFromDisk (line ~397) and will activate when its
    // activationEvents fire (CC1: onLanguage, onCommand, onView,
    // onChat, onDebug, etc.). Nothing else needed.
    await log(`No MCP adapter for ${extensionId} — extension host handles activation directly.`)
  }
}

async function getWorkspacePath(): Promise<string | null> {
  try {
    const { getWorkspace } = await import('./ide-context.ts')
    return getWorkspace()
  } catch { return null }
}

// ─── Register Install Extension command ──────────────────────────────────────

export async function registerInstallCommand(): Promise<void> {
  try {
    const actionsModule = await import(
      '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions'
    )

    const { Action2, registerAction2 } = actionsModule
    if (!registerAction2 || !Action2) return

    registerAction2(class extends Action2 {
      static readonly id = 'opide.installExtension'
      constructor() {
        super({
          id: 'opide.installExtension',
          title: { value: 'OPIDE: Download Extension from Open VSX', original: 'OPIDE: Download Extension from Open VSX' },
          f1: true,
        })
      }
      async run(): Promise<void> {
        try {
          // Get VS Code's quick input service for the input dialog
          const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
          const { IQuickInputService } = await import(
            '@codingame/monaco-vscode-api/vscode/vs/platform/quickinput/common/quickInput.service'
          )

          const quickInput = StandaloneServices.get(IQuickInputService) as any
          if (!quickInput?.input) {
            invoke('ext_host_log', { message: 'Install: quick input service not available' }).catch(() => {})
            return
          }

          const extensionId = await quickInput.input({
            placeHolder: 'publisher.name (e.g. dbaeumer.vscode-eslint)',
            prompt: 'Enter the extension ID from Open VSX',
            validateInput: (value: string) => {
              if (!value.includes('.')) return 'Format: publisher.name'
              return null
            },
          })

          if (!extensionId?.trim()) return

          invoke('ext_host_log', { message: `User requested install: ${extensionId}` }).catch(() => {})
          const success = await installExtensionFromOpenVsx(extensionId.trim())
          invoke('ext_host_log', { message: success ? `Installed: ${extensionId}` : `Failed: ${extensionId}` }).catch(() => {})
        } catch (e) {
          invoke('ext_host_log', { message: `Install command error: ${e}` }).catch(() => {})
        }
      }
    })

    console.log('[ext-mcp] Install Extension command registered')
  } catch (e) {
    console.warn('[ext-mcp] Failed to register install command:', e)
  }
}

// ─── Uninstall Extension ────────────────────────────────────────────────────

/**
 * Uninstall a VS Code extension.
 * Removes ~/.opide/extensions/{extensionId}/ and disconnects MCP server.
 */
export async function uninstallExtension(extensionId: string): Promise<boolean> {
  const log = (msg: string) => invoke('ext_host_log', { message: `[uninstall] ${msg}` }).catch(() => {})

  try {
    await log(`Uninstalling ${extensionId}...`)

    const extBase = await getExtensionsBase()
    const extDir = `${extBase}/${extensionId}`

    // Verify directory exists before deleting
    const checkResult = await invoke('ide_run_command', {
      command: `test -d "${extDir}" && echo "exists" || echo "missing"`,
      cwd: '/',
    }) as any
    if ((checkResult?.stdout || '').trim() !== 'exists') {
      await log(`Extension directory not found: ${extDir}`)
      return false
    }

    // Unload from the workbench (themes, grammars, etc.) — with timeout
    try {
      const { unloadExtension } = await import('./extension-loader.ts')
      await Promise.race([
        unloadExtension(extensionId),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ])
    } catch (e) {
      await log(`Workbench unload failed (non-fatal): ${e}`)
    }

    // Disconnect MCP server if registered — with timeout
    const serverId = `ext-${extensionId.replace(/\./g, '-')}`
    if (_registeredServers.has(serverId)) {
      try {
        await Promise.race([
          invoke('engine_mcp_disconnect', { id: serverId }),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ])
        await log(`Disconnected MCP server: ${serverId}`)
      } catch (e) {
        await log(`MCP disconnect failed (non-fatal): ${e}`)
      }
      _registeredServers.delete(serverId)
    }

    // Remove the extension directory
    await invoke('ide_run_command', {
      command: `rm -rf "${extDir}"`,
      cwd: '/',
    })

    // Verify removal
    const verifyResult = await invoke('ide_run_command', {
      command: `test -d "${extDir}" && echo "exists" || echo "removed"`,
      cwd: '/',
    }) as any
    if ((verifyResult?.stdout || '').trim() === 'removed') {
      await log(`Extension ${extensionId} uninstalled successfully`)
      // Bounce the sidecar so its in-memory extension list drops the
      // removed entry. Otherwise the host keeps a stale reference and
      // the next activation event for that id would fail oddly.
      try {
        const { restartExtensionHost } = await import('./extension-bridge.ts')
        await restartExtensionHost()
      } catch (e) {
        await log(`Extension host restart failed (non-fatal): ${e}`)
      }
      return true
    } else {
      await log(`Failed to remove ${extDir}`)
      return false
    }
  } catch (e) {
    invoke('ext_host_log', { message: `[uninstall] FAILED: ${e}` }).catch(() => {})
    return false
  }
}

// ─── Scan and register all installed extensions on startup ───────────────────

export async function scanAndRegisterInstalledExtensions(): Promise<void> {
  const log = (msg: string) => invoke('ext_host_log', { message: `[scan] ${msg}` }).catch(() => {})

  try {
    const extBase = await getExtensionsBase()
    await log(`Scanning ${extBase} for installed extensions...`)

    // List directories in extensions dir
    const listResult = await invoke('ide_run_command', {
      command: `ls -d "${extBase}"/*/ 2>/dev/null | while read d; do basename "$d"; done`,
      cwd: '/',
    }) as any
    const dirs = (listResult?.stdout || '').trim().split('\n').filter((d: string) => d.length > 0)

    await log(`Found ${dirs.length} installed extension(s)`)

    for (const extId of dirs) {

      // On startup, ONLY register extensions that already have a pre-built adapter.
      // Do NOT generate adapters — that calls AI APIs and blocks for 30-120 seconds.
      // Adapter generation only happens during explicit user install (doInstall flow).
      const serverId = `ext-${extId.replace(/\./g, '-')}`
      if (_registeredServers.has(serverId)) continue

      const adapterName = `${extId}.mcp.cjs`
      const adapterPath = await resolveAdapterPath(`extension-adapters/${adapterName}`)

      const checkResult = await invoke('ide_run_command', {
        command: `test -f "${adapterPath}" && echo "exists" || echo "missing"`,
        cwd: '/',
      }) as any

      if ((checkResult?.stdout || '').trim() === 'exists') {
        try {
          const wsPath = await getWorkspacePath()
          const config: McpServerConfig = {
            id: serverId,
            name: extId.split('.').pop() || extId,
            transport: 'stdio',
            command: 'node',
            args: [adapterPath],
            env: wsPath ? { OPIDE_WORKSPACE: wsPath } : {},
            url: '',
            enabled: true,
          }
          await invoke('engine_mcp_save_server', { server: config })
          await invoke('engine_mcp_connect', { id: config.id })
          _registeredServers.add(serverId)
          await log(`Registered existing adapter: ${serverId}`)
        } catch (e) {
          await log(`Failed to register ${serverId}: ${e}`)
        }
      }
      // No-pre-built-adapter case is intentionally silent now. The
      // extension host registers its own activation events for these
      // (Phase A-I); we do not need an MCP wrapper.
    }
  } catch (e) {
    invoke('ext_host_log', { message: `[scan] FAILED: ${e}` }).catch(() => {})
  }
}
