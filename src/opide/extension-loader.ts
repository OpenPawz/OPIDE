// ── Extension Loader ─────────────────────────────────────────────────────────
// Registers installed Open VSX extensions with the monaco-vscode-api workbench
// so their contributions (themes, grammars, icon themes, snippets, keybindings,
// commands, language servers, etc.) are activated by the built-in VS Code
// extension services.
//
// PERFORMANCE: Only reads package.json + direct contributes files (1-5 per ext).
// Icon theme sub-resources (SVGs, fonts) are loaded in the background AFTER
// startup, not blocking folder open.

import { invoke } from '@tauri-apps/api/core'
import { registerExtension } from '@codingame/monaco-vscode-api/extensions'
import { ExtensionHostKind } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/extensions/common/extensionHostKind'

// ─── Types ──────────────────────────────────────────────────────────────────

interface FileContent {
  path: string
  content: string
  language: string
  size: number
}

interface LoadedExtension {
  id: string
  dispose: () => Promise<void>
}

// ─── State ──────────────────────────────────────────────────────────────────

const _loadedExtensions = new Map<string, LoadedExtension>()
let _cachedExtBase: string | null = null

// ─── Core: Load a single extension from disk ────────────────────────────────

export async function loadExtensionFromDisk(extDir: string, extensionId: string): Promise<boolean> {
  if (_loadedExtensions.has(extensionId)) return true

  try {
    let manifest: any
    try {
      const result = await invoke<FileContent>('ide_read_file', { path: `${extDir}/package.json` })
      manifest = JSON.parse(result.content)
    } catch {
      return false
    }
    return loadExtensionWithManifest(extDir, extensionId, manifest)
  } catch {
    return false
  }
}

async function loadExtensionWithManifest(extDir: string, extensionId: string, manifest: any): Promise<boolean> {
  if (_loadedExtensions.has(extensionId)) return true

  try {
    // Fill required fields
    if (!manifest.name) manifest.name = extensionId.split('.').slice(1).join('.') || extensionId
    if (!manifest.publisher) manifest.publisher = extensionId.split('.')[0] || 'unknown'
    if (!manifest.version) manifest.version = '0.0.0'
    if (!manifest.engines) manifest.engines = { vscode: '*' }

    // 2. Pick host kind
    let hostKind: ExtensionHostKind | undefined
    if (manifest.browser) hostKind = ExtensionHostKind.LocalWebWorker
    else if (manifest.main) hostKind = ExtensionHostKind.LocalProcess

    // 3. Register extension with workbench (instant — no I/O)
    const ext = registerExtension(manifest, hostKind as any, { system: false })

    // 4. Register contributed resource files
    const regFileUrl = (ext as any).registerFileUrl
    if (regFileUrl) {
      // Collect direct contributes file paths (typically 1-5 files)
      const filePaths = collectContributedFilePaths(manifest)
      if (manifest.main) filePaths.add(normRel(manifest.main))
      if (manifest.browser) filePaths.add(normRel(manifest.browser))

      // Register ALL resource files in background — never block startup
      if (filePaths.size > 0 || manifest.contributes?.iconThemes) {
        setTimeout(() => {
          registerFiles(extDir, filePaths, regFileUrl)
            .then(() => {
              if (manifest.contributes?.iconThemes) {
                return loadIconThemeResources(extDir, manifest, regFileUrl)
              }
            })
            .catch(() => {})
        }, 100)
      }
    }

    _loadedExtensions.set(extensionId, {
      id: extensionId,
      dispose: () => ext.dispose(),
    })

    return true
  } catch {
    return false
  }
}

// ─── File path collection ───────────────────────────────────────────────────

function collectContributedFilePaths(manifest: any): Set<string> {
  const paths = new Set<string>()
  const c = manifest.contributes
  if (!c) return paths

  if (c.themes) for (const t of c.themes) if (t.path) paths.add(normRel(t.path))
  if (c.iconThemes) for (const t of c.iconThemes) if (t.path) paths.add(normRel(t.path))
  if (c.productIconThemes) for (const t of c.productIconThemes) if (t.path) paths.add(normRel(t.path))
  if (c.grammars) for (const g of c.grammars) if (g.path) paths.add(normRel(g.path))
  if (c.languages) for (const l of c.languages) if (l.configuration) paths.add(normRel(l.configuration))
  if (c.snippets) for (const s of c.snippets) if (s.path) paths.add(normRel(s.path))
  if (c.jsonValidation) for (const j of c.jsonValidation) if (j.url?.startsWith('.')) paths.add(normRel(j.url))

  return paths
}

function normRel(p: string): string {
  if (p.startsWith('./')) return p
  if (p.startsWith('/')) return `.${p}`
  return `./${p}`
}

// ─── Register files via blob URLs ───────────────────────────────────────────

async function registerFiles(
  extDir: string,
  filePaths: Set<string>,
  registerFileUrl: (path: string, url: string) => any,
): Promise<void> {
  // Read all in parallel — these are typically 1-5 small JSON files
  const reads = Array.from(filePaths).map(async (relPath) => {
    const absPath = `${extDir}/${relPath.replace(/^\.\//, '')}`
    try {
      const result = await invoke<FileContent>('ide_read_file', { path: absPath })
      const blob = new Blob([result.content], { type: guessMime(relPath) })
      registerFileUrl(relPath, URL.createObjectURL(blob))
    } catch { /* skip missing files */ }
  })
  await Promise.all(reads)
}

// ─── Icon theme background loading ──────────────────────────────────────────

async function loadIconThemeResources(
  extDir: string,
  manifest: any,
  registerFileUrl: (path: string, url: string) => any,
): Promise<void> {
  for (const iconTheme of manifest.contributes.iconThemes) {
    if (!iconTheme.path) continue
    const normalizedPath = iconTheme.path.replace(/^\.\//, '')
    const absPath = `${extDir}/${normalizedPath}`
    const iconDir = normalizedPath.substring(0, normalizedPath.lastIndexOf('/') + 1) || ''

    try {
      const result = await invoke<FileContent>('ide_read_file', { path: absPath })
      const theme = JSON.parse(result.content)
      const iconPaths = new Set<string>()

      if (theme.iconDefinitions) {
        for (const def of Object.values(theme.iconDefinitions) as any[]) {
          if (def?.iconPath) iconPaths.add(`./${iconDir}${def.iconPath}`)
        }
      }
      if (theme.fonts) {
        for (const font of theme.fonts) {
          if (font.src) for (const src of font.src) {
            if (src.path) iconPaths.add(`./${iconDir}${src.path}`)
          }
        }
      }

      // Register in batches of 10 to avoid IPC flood
      const pathArr = Array.from(iconPaths)
      for (let i = 0; i < pathArr.length; i += 10) {
        const batch = pathArr.slice(i, i + 10)
        await Promise.all(batch.map(async (relPath) => {
          const abs = `${extDir}/${relPath.replace(/^\.\//, '')}`
          try {
            // For binary files (SVG, PNG, fonts), try text first then base64
            const res = await invoke<FileContent>('ide_read_file', { path: abs })
            const blob = new Blob([res.content], { type: guessMime(relPath) })
            registerFileUrl(relPath, URL.createObjectURL(blob))
          } catch { /* skip */ }
        }))
      }
    } catch { /* non-fatal */ }
  }
}

function guessMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'json': return 'application/json'
    case 'js': case 'cjs': case 'mjs': return 'application/javascript'
    case 'css': return 'text/css'
    case 'svg': return 'image/svg+xml'
    case 'png': return 'image/png'
    case 'woff': return 'font/woff'
    case 'woff2': return 'font/woff2'
    case 'ttf': return 'font/ttf'
    default: return 'application/octet-stream'
  }
}

// ─── Bulk load all installed extensions ─────────────────────────────────────

export async function loadAllInstalledExtensions(): Promise<void> {
  try {
    const extBase = await getExtensionsBase()

    // Single shell command: list dirs AND read all package.jsons at once
    // Output format: DIR_NAME\t{json content}\n===\n
    const result = await invoke('ide_run_command', {
      command: `for d in "${extBase}"/*/; do [ -f "$d/package.json" ] && echo "$(basename "$d")\t$(cat "$d/package.json")" && echo "===OPIDE_SEP==="; done 2>/dev/null`,
      cwd: '/',
    }) as any
    const output = (result?.stdout || '').trim()
    if (!output) return

    // Parse all extensions from the single command output
    const entries = output.split('===OPIDE_SEP===').filter((s: string) => s.trim())

    for (const entry of entries) {
      const tabIdx = entry.indexOf('\t')
      if (tabIdx === -1) continue
      const extId = entry.substring(0, tabIdx).trim()
      const jsonStr = entry.substring(tabIdx + 1).trim()
      if (!extId || !jsonStr) continue

      try {
        await loadExtensionWithManifest(`${extBase}/${extId}`, extId, JSON.parse(jsonStr))
      } catch { /* skip broken extensions */ }
    }
  } catch { /* fail silently */ }
}

// ─── Unload ─────────────────────────────────────────────────────────────────

export async function unloadExtension(extensionId: string): Promise<void> {
  const loaded = _loadedExtensions.get(extensionId)
  if (loaded) {
    try {
      await Promise.race([
        loaded.dispose(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ])
    } catch { /* ignore */ }
    _loadedExtensions.delete(extensionId)
  }
}

export function isExtensionLoaded(extensionId: string): boolean {
  return _loadedExtensions.has(extensionId)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getExtensionsBase(): Promise<string> {
  if (_cachedExtBase) return _cachedExtBase
  try {
    const result = await invoke('ide_run_command', { command: 'echo $HOME', cwd: '/' }) as any
    const home = (result?.stdout || '').trim()
    if (home && home.length > 1) {
      _cachedExtBase = `${home}/.opide/extensions`
      return _cachedExtBase
    }
  } catch {}
  _cachedExtBase = '/Users/elibury/.opide/extensions'
  return _cachedExtBase
}
