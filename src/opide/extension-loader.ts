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
  /** Blob object URLs created for this extension's resources — revoked on
   * unload so uninstall/reload doesn't leak them. */
  objectUrls: string[]
}

// ─── State ──────────────────────────────────────────────────────────────────

const _loadedExtensions = new Map<string, LoadedExtension>()
let _cachedExtBase: string | null = null

/** File extensions whose content is binary and must be read via
 * ide_read_file_bytes (base64). Reading these through the text-based
 * ide_read_file corrupts them — which broke icon themes that ship PNG
 * icons or icon FONTS (Material Icon Theme et al): file icons rendered
 * blank because the woff/png blobs were UTF-8 mangled. */
const BINARY_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'woff', 'woff2', 'ttf', 'otf', 'eot'])

function isBinaryPath(path: string): boolean {
  return BINARY_EXTS.has(path.split('.').pop()?.toLowerCase() || '')
}

function base64ToBytes(b64: string) {
  const bin = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Read a resource as a Blob, routing binary types through the bytes IPC. */
async function readResourceBlob(absPath: string, relPath: string): Promise<Blob> {
  if (isBinaryPath(relPath)) {
    const b64 = await invoke<string>('ide_read_file_bytes', { path: absPath })
    return new Blob([base64ToBytes(b64)], { type: guessMime(relPath) })
  }
  const result = await invoke<FileContent>('ide_read_file', { path: absPath })
  return new Blob([result.content], { type: guessMime(relPath) })
}

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
    const objectUrls: string[] = []
    if (regFileUrl) {
      // Collect direct contributes file paths (typically 1-5 files)
      const filePaths = collectContributedFilePaths(manifest)
      if (manifest.main) filePaths.add(normRel(manifest.main))
      if (manifest.browser) filePaths.add(normRel(manifest.browser))

      // Register ALL resource files in background — never block startup
      if (filePaths.size > 0 || manifest.contributes?.iconThemes) {
        setTimeout(() => {
          registerFiles(extDir, filePaths, regFileUrl, objectUrls)
            .then(() => {
              if (manifest.contributes?.iconThemes) {
                return loadIconThemeResources(extDir, manifest, regFileUrl, objectUrls)
              }
            })
            .catch(() => {})
        }, 100)
      }
    }

    _loadedExtensions.set(extensionId, {
      id: extensionId,
      dispose: () => ext.dispose(),
      objectUrls,
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
  objectUrls: string[],
): Promise<void> {
  // Read all in parallel — these are typically 1-5 small JSON files
  const reads = Array.from(filePaths).map(async (relPath) => {
    const absPath = `${extDir}/${relPath.replace(/^\.\//, '')}`
    try {
      const blob = await readResourceBlob(absPath, relPath)
      const url = URL.createObjectURL(blob)
      objectUrls.push(url)
      registerFileUrl(relPath, url)
    } catch { /* skip missing files */ }
  })
  await Promise.all(reads)
}

// ─── Icon theme background loading ──────────────────────────────────────────

async function loadIconThemeResources(
  extDir: string,
  manifest: any,
  registerFileUrl: (path: string, url: string) => any,
  objectUrls: string[],
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
            // Binary resources (PNG icons, woff/ttf icon fonts) go through
            // the base64 bytes IPC; text (SVG, JSON) through the text IPC.
            const blob = await readResourceBlob(abs, relPath)
            const url = URL.createObjectURL(blob)
            objectUrls.push(url)
            registerFileUrl(relPath, url)
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

    // List dirs via the typed IPC and read package.json per directory in
    // parallel. Avoids the previous shell glob (B48) which would inject if
    // extBase ever contained shell metacharacters.
    const list = await invoke<{ entries: { name: string; is_dir: boolean }[] }>('ide_list_dir', {
      path: extBase,
    }).catch(() => null)

    // Honour the user's disabled set. The sidecar already skips disabled
    // extensions; without this the workbench loader still registered their
    // themes/grammars/snippets, so "Disable" looked like it did nothing for
    // appearance-type extensions.
    const disabled = new Set<string>(
      await invoke<string[]>('ext_get_disabled').catch(() => [] as string[]),
    )
    const dirs = (list?.entries ?? [])
      .filter(e => e.is_dir && !disabled.has(e.name))
      .map(e => e.name)

    await Promise.all(dirs.map(async (extId) => {
      try {
        const fc = await invoke<FileContent>('ide_read_file', { path: `${extBase}/${extId}/package.json` })
        await loadExtensionWithManifest(`${extBase}/${extId}`, extId, JSON.parse(fc.content))
      } catch { /* skip broken extensions */ }
    }))
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
    // Revoke the blob URLs created for this extension's resources so
    // uninstall/reload cycles don't leak them.
    for (const url of loaded.objectUrls) {
      try { URL.revokeObjectURL(url) } catch { /* ignore */ }
    }
    _loadedExtensions.delete(extensionId)
  }
}

export function isExtensionLoaded(extensionId: string): boolean {
  return _loadedExtensions.has(extensionId)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getExtensionsBase(): Promise<string> {
  if (_cachedExtBase) return _cachedExtBase
  // Use Tauri's homeDir() — works cross-platform without shelling out (B36/B47).
  // Previously fell back to a hardcoded developer path that shipped to all users.
  const { homeDir } = await import('@tauri-apps/api/path')
  const home = (await homeDir()).replace(/[\\/]+$/, '')
  if (!home) throw new Error('Could not determine home directory for extensions base')
  _cachedExtBase = `${home}/.opide/extensions`
  return _cachedExtBase
}
