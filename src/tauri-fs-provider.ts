/**
 * TauriFileSystemProvider
 *
 * Implements VS Code's IFileSystemProvider interface backed by @tauri-apps/plugin-fs.
 * Registered for the `file://` scheme so VS Code's Explorer, editor, and search
 * all read/write real disk files through Tauri's native fs layer.
 */

import {
  FileChangeType,
  FileSystemProviderCapabilities,
  FileSystemProviderErrorCode,
  FileType,
  type IFileChange,
  type IFileDeleteOptions,
  type IFileOverwriteOptions,
  type IFileSystemProviderWithFileReadWriteCapability,
  type IStat,
  type IWatchOptions,
} from '@codingame/monaco-vscode-files-service-override'

import {
  createFileSystemProviderError,
} from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files'

import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { Emitter, type Event } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import { Disposable } from '@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle'

import {
  readFile,
  writeFile,
  readDir,
  mkdir,
  remove,
  rename,
  stat,
  exists,
} from '@tauri-apps/plugin-fs'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

// ─── helpers ──────────────────────────────────────────────────────────────────

function uriToPath(resource: URI): string {
  // VS Code URIs on macOS/Linux: file:///Users/foo/bar → /Users/foo/bar
  return resource.fsPath
}

function mapError(err: unknown): Error {
  const msg = String(err)
  if (msg.includes('No such file') || msg.includes('not found') || msg.includes('os error 2')) {
    return createFileSystemProviderError(msg, FileSystemProviderErrorCode.FileNotFound)
  }
  if (msg.includes('Permission denied') || msg.includes('os error 13')) {
    return createFileSystemProviderError(msg, FileSystemProviderErrorCode.NoPermissions)
  }
  if (msg.includes('Already exists') || msg.includes('os error 17')) {
    return createFileSystemProviderError(msg, FileSystemProviderErrorCode.FileExists)
  }
  return createFileSystemProviderError(msg, FileSystemProviderErrorCode.Unknown)
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class TauriFileSystemProvider extends Disposable
  implements IFileSystemProviderWithFileReadWriteCapability {

  readonly capabilities =
    FileSystemProviderCapabilities.FileReadWrite |
    FileSystemProviderCapabilities.PathCaseSensitive

  // Required by IFileSystemProviderWithFileReadWriteCapability — fires when capabilities change
  private readonly _onDidChangeCapabilities = this._register(new Emitter<void>())
  readonly onDidChangeCapabilities: Event<void> = this._onDidChangeCapabilities.event

  // File change events — fired when we detect changes
  private readonly _onDidChangeFile = this._register(new Emitter<readonly IFileChange[]>())
  readonly onDidChangeFile: Event<readonly IFileChange[]> = this._onDidChangeFile.event

  // ── stat ────────────────────────────────────────────────────────────────────

  async stat(resource: URI): Promise<IStat> {
    const path = uriToPath(resource)
    try {
      const s = await stat(path)
      const isDir = s.isDirectory
      const isFile = s.isFile
      return {
        type: isDir ? FileType.Directory : isFile ? FileType.File : FileType.Unknown,
        ctime: s.birthtime ? new Date(s.birthtime).getTime() : 0,
        mtime: s.mtime ? new Date(s.mtime).getTime() : Date.now(),
        size: s.size ?? 0,
      }
    } catch (err) {
      throw mapError(err)
    }
  }

  // ── readdir ─────────────────────────────────────────────────────────────────

  async readdir(resource: URI): Promise<[string, FileType][]> {
    const path = uriToPath(resource)
    try {
      const entries = await readDir(path)
      const result: [string, FileType][] = []
      for (const entry of entries) {
        const type = entry.isDirectory
          ? FileType.Directory
          : entry.isFile
            ? FileType.File
            : FileType.Unknown
        result.push([entry.name, type])
      }
      return result
    } catch (err) {
      throw mapError(err)
    }
  }

  // ── readFile ────────────────────────────────────────────────────────────────

  async readFile(resource: URI): Promise<Uint8Array> {
    const path = uriToPath(resource)
    try {
      const data = await readFile(path)
      return new Uint8Array(data)
    } catch (err) {
      throw mapError(err)
    }
  }

  // ── writeFile ───────────────────────────────────────────────────────────────

  async writeFile(
    resource: URI,
    content: Uint8Array,
    _opts: IFileOverwriteOptions,
  ): Promise<void> {
    const path = uriToPath(resource)
    try {
      await writeFile(path, content)
      // Notify VS Code that this file changed
      this._onDidChangeFile.fire([{
        type: FileChangeType.UPDATED,
        resource,
      }])
    } catch (err) {
      throw mapError(err)
    }
  }

  // ── mkdir ───────────────────────────────────────────────────────────────────

  async mkdir(resource: URI): Promise<void> {
    const path = uriToPath(resource)
    try {
      await mkdir(path, { recursive: true })
    } catch (err) {
      throw mapError(err)
    }
  }

  // ── delete ──────────────────────────────────────────────────────────────────

  async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
    const path = uriToPath(resource)
    try {
      await remove(path, { recursive: opts.recursive })
    } catch (err) {
      throw mapError(err)
    }
  }

  // ── rename ──────────────────────────────────────────────────────────────────

  async rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
    const fromPath = uriToPath(from)
    const toPath = uriToPath(to)
    try {
      if (!opts.overwrite) {
        const fileExists = await exists(toPath)
        if (fileExists) {
          throw createFileSystemProviderError(
            `File already exists: ${toPath}`,
            FileSystemProviderErrorCode.FileExists,
          )
        }
      }
      await rename(fromPath, toPath)
    } catch (err) {
      if (err instanceof Error && 'code' in err) throw err
      throw mapError(err)
    }
  }

  // ── watch ─────────────────────────────────────────────────────────────────

  watch(resource: URI, opts: IWatchOptions): { dispose(): void } {
    const path = uriToPath(resource)
    let watchId: string | null = null
    let unlisten: (() => void) | null = null

    // Start watching asynchronously
    const setup = async () => {
      watchId = await invoke<string>('fs_watch', {
        path,
        recursive: opts.recursive ?? false,
      })

      unlisten = await listen<{ kind: string; path: string }>('fs-change', ({ payload }) => {
        // Only fire events for paths under the watched resource
        if (!payload.path.startsWith(path)) return

        const changeType =
          payload.kind === 'created' ? FileChangeType.ADDED
            : payload.kind === 'deleted' ? FileChangeType.DELETED
              : FileChangeType.UPDATED

        this._onDidChangeFile.fire([{
          type: changeType,
          resource: URI.file(payload.path),
        }])
      })
    }

    setup().catch((e) => console.warn('[opide-fs] watch setup failed:', e))

    return {
      dispose() {
        unlisten?.()
        if (watchId) {
          invoke('fs_unwatch', { watchId }).catch(() => {})
        }
      },
    }
  }
}
