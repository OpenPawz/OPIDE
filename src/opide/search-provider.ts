/**
 * OPIDE Search Provider
 *
 * Registers a VS Code text search provider and file search provider
 * backed by Rust's `ignore` + `grep` crates (ripgrep internals).
 *
 * - Cmd+Shift+F → project-wide text search via `search_files`
 * - Cmd+P → quick file open via `search_file_list`
 */

import { invoke } from '@tauri-apps/api/core'
import { registerExtension } from '@codingame/monaco-vscode-api/extensions'
import { ExtensionHostKind } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/extensions/common/extensionHostKind'

// ─── Types (matching Rust structs) ───────────────────────────────────────────

interface SearchMatch {
  path: string
  line_number: number
  line_text: string
}

interface SearchResult {
  matches: SearchMatch[]
  total_matches: number
  truncated: boolean
}

// ─── Registration ────────────────────────────────────────────────────────────

/**
 * Registers an extension that provides text search and file search.
 * Uses the @codingame/monaco-vscode-api extension registration pattern.
 */
export async function registerSearchProviders(workspacePath: string): Promise<void> {
  const ext = registerExtension({
    name: 'opide-search',
    publisher: 'opide',
    version: '0.1.0',
    engines: { vscode: '*' },
  }, ExtensionHostKind.LocalProcess)

  const vscode = await ext.getApi()

  // ── Text Search Provider (Cmd+Shift+F) ──────────────────────────────────
  vscode.workspace.registerTextSearchProvider('file', {
    async provideTextSearchResults(query: any, options: any, progress: any, _token: any) {
      try {
        const result = await invoke<SearchResult>('search_files', {
          request: {
            root: workspacePath,
            query: query.pattern,
            is_regex: query.isRegExp ?? false,
            case_sensitive: query.isCaseSensitive ?? false,
            max_results: options.maxResults ?? 500,
          },
        })

        for (const match of result.matches) {
          const uri = vscode.Uri.file(`${workspacePath}/${match.path}`)
          const lineNumber = Math.max(0, match.line_number - 1)

          // Case-sensitive search must locate the actual case-matched occurrence —
          // lowercasing both sides finds the wrong column for case-sensitive queries.
          const matchIndex = query.isCaseSensitive
            ? match.line_text.indexOf(query.pattern)
            : match.line_text.toLowerCase().indexOf(query.pattern.toLowerCase())
          const startChar = matchIndex >= 0 ? matchIndex : 0
          const endChar = startChar + query.pattern.length

          progress.report({
            uri,
            ranges: [new vscode.Range(lineNumber, startChar, lineNumber, endChar)],
            preview: {
              text: match.line_text,
              matches: [new vscode.Range(0, startChar, 0, endChar)],
            },
          })
        }

        return { limitHit: result.truncated }
      } catch (e) {
        console.warn('[opide-search] text search failed:', e)
        return { limitHit: false }
      }
    },
  })

  // ── File Search Provider (Cmd+P) ────────────────────────────────────────
  vscode.workspace.registerFileSearchProvider('file', {
    async provideFileSearchResults(query: any, options: any, _token: any) {
      try {
        const files = await invoke<string[]>('search_file_list', {
          root: workspacePath,
          maxResults: options.maxResults ?? 500,
        })

        const pattern = query.pattern.toLowerCase()
        const filtered = pattern
          ? files.filter((f) => fuzzyMatch(pattern, f.toLowerCase()))
          : files

        return filtered
          .slice(0, options.maxResults ?? 500)
          .map((f) => vscode.Uri.file(`${workspacePath}/${f}`))
      } catch (e) {
        console.warn('[opide-search] file search failed:', e)
        return []
      }
    },
  })

  console.log('[opide-search] providers registered for', workspacePath)
}

// ─── Fuzzy Match ─────────────────────────────────────────────────────────────

function fuzzyMatch(pattern: string, target: string): boolean {
  let pi = 0
  for (let ti = 0; ti < target.length && pi < pattern.length; ti++) {
    if (target[ti] === pattern[pi]) {
      pi++
    }
  }
  return pi === pattern.length
}
