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
export async function installExtensionFromOpenVsx(extensionId: string): Promise<boolean> {
  const log = (msg: string) => invoke('ext_host_log', { message: `[install] ${msg}` }).catch(() => {})

  try {
    await log(`Installing ${extensionId}...`)

    // Parse publisher.name
    const parts = extensionId.split('.')
    if (parts.length < 2) {
      await log(`Invalid extension ID: ${extensionId} (expected publisher.name)`)
      return false
    }
    const publisher = parts[0]
    const name = parts.slice(1).join('.')

    // Get the home dir for extensions path
    const extBase = await getExtensionsBase()
    const extDir = `${extBase}/${extensionId}`

    // Download .vsix from Open VSX
    // API: https://open-vsx.org/api/{publisher}/{name}
    // Download: https://open-vsx.org/api/{publisher}/{name}/latest/file/{publisher}.{name}-{version}.vsix
    await log(`Fetching metadata from Open VSX...`)
    const metadataResult = await invoke('ide_run_command', {
      command: `curl -sL "https://open-vsx.org/api/${publisher}/${name}"`,
      cwd: '/tmp',
    }) as any
    const stdout = metadataResult?.stdout || ''

    let version = 'latest'
    let downloadUrl = ''
    try {
      const metadata = JSON.parse(stdout)
      version = metadata.version || 'latest'
      downloadUrl = metadata.files?.download
        || `https://open-vsx.org/api/${publisher}/${name}/${version}/file/${extensionId}-${version}.vsix`
      await log(`Found: ${metadata.displayName || name} v${version}`)
    } catch {
      downloadUrl = `https://open-vsx.org/api/${publisher}/${name}/latest/file/${extensionId}-latest.vsix`
      await log(`Metadata parse failed, trying direct download`)
    }

    // Download the .vsix
    const vsixPath = `/tmp/opide-${extensionId}.vsix`
    await log(`Downloading .vsix...`)
    await invoke('ide_run_command', {
      command: `curl -sL "${downloadUrl}" -o "${vsixPath}"`,
      cwd: '/tmp',
    })

    // Verify download
    const checkResult = await invoke('ide_run_command', {
      command: `file "${vsixPath}"`,
      cwd: '/tmp',
    }) as any
    if (!(checkResult?.stdout || '').includes('Zip')) {
      await log(`Download failed — not a valid .vsix (zip) file`)
      return false
    }

    // Extract to extensions directory
    await log(`Extracting to ${extDir}...`)
    await invoke('ide_run_command', {
      command: `mkdir -p "${extDir}" && cd "${extDir}" && unzip -o "${vsixPath}" -d . > /dev/null 2>&1 && if [ -d extension ]; then mv extension/* . 2>/dev/null; mv extension/.* . 2>/dev/null; rmdir extension 2>/dev/null; fi && rm -f "${vsixPath}"`,
      cwd: '/tmp',
    })

    // Verify package.json exists
    const verifyResult = await invoke('ide_run_command', {
      command: `cat "${extDir}/package.json" | head -5`,
      cwd: '/',
    }) as any
    if (!(verifyResult?.stdout || '').includes('"name"')) {
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

/** Check for a matching adapter and register it as an MCP server */
async function registerAdapterForExtension(extensionId: string, extDir: string): Promise<void> {
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
    await log(`No pre-built adapter for ${extensionId}. Generating...`)

    // Run the adapter generator
    try {
      const generatorPath = await resolveAdapterPath('extension-adapters/generate-adapter.cjs')
      const wsPath = await getWorkspacePath()

      // Get user's API config for cloud AI fallback
      let apiArgs = ''
      try {
        const config = await invoke('engine_get_config') as any
        await log(`Config: ${JSON.stringify({ providers: (config?.providers || []).map((p: any) => ({ id: p.id, has_key: !!p.api_key, base_url: p.base_url })), default_model: config?.default_model }).slice(0, 500)}`)
        const providers = config?.providers || []
        const defaultProvider = config?.default_provider || ''
        const defaultModel = config?.default_model || ''

        // Find the matching provider: prefer default_provider, then any with a key
        let provider = providers.find((p: any) => p.id === defaultProvider && p.api_key)
        if (!provider) provider = providers.find((p: any) => p.api_key && p.id !== 'ollama')

        if (provider) {
          const url = provider.base_url || 'https://api.openai.com/v1/chat/completions'
          const mdl = defaultModel || 'gpt-4o-mini'
          apiArgs = ` --api-key "${provider.api_key}" --api-url "${url}" --model "${mdl}"`
          await log(`Using provider ${provider.id} for adapter generation (model: ${mdl}, url: ${url})`)
        }
        if (!apiArgs) await log('No provider with API key found — Ollama only')
      } catch (e) {
        await log(`Config read failed: ${e}`)
      }

      const genResult = await invoke('ide_run_command', {
        command: `node "${generatorPath}" "${extDir}" --workspace "${wsPath || '/tmp'}"${apiArgs}`,
        cwd: '/',
      }) as any

      const generatedCode = (genResult?.stdout || '').trim()
      if (generatedCode && generatedCode.includes('tools/list')) {
        // Save the generated adapter
        const generatedPath = adapterPath // Same location as pre-built
        await invoke('ide_run_command', {
          command: `cat > "${generatedPath}" << 'ADAPTER_EOF'\n${generatedCode}\nADAPTER_EOF`,
          cwd: '/',
        })

        await log(`Adapter generated and saved: ${generatedPath}`)

        // Register it
        const config: McpServerConfig = {
          id: `ext-${extensionId.replace(/\./g, '-')}`,
          name: extensionId.split('.').pop() || extensionId,
          transport: 'stdio',
          command: 'node',
          args: [generatedPath],
          env: wsPath ? { OPIDE_WORKSPACE: wsPath } : {},
          url: '',
          enabled: true,
        }
        await invoke('engine_mcp_save_server', { server: config })
        await invoke('engine_mcp_connect', { id: config.id })
        await log(`Generated adapter registered as MCP server: ${config.id}`)
      } else {
        await log(`Adapter generation failed — no valid output`)
        await log(`stderr: ${(genResult?.stderr || '').slice(0, 500)}`)
      }
    } catch (e) {
      await log(`Adapter generation error: ${e}`)
    }
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
      } else {
        await log(`No adapter for ${extId} — skipping (will generate on next install)`)
      }
    }
  } catch (e) {
    invoke('ext_host_log', { message: `[scan] FAILED: ${e}` }).catch(() => {})
  }
}
