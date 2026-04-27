/**
 * Shared Monaco lazy-loader.
 *
 * Multiple modules need `monaco-editor` for things like `getModel`, `Uri.file`,
 * marker-setters, etc. A single cached dynamic import avoids the repeated
 * promise round-trip on hot paths (B46).
 */

let _monaco: typeof import('monaco-editor') | null = null

export async function getMonaco(): Promise<typeof import('monaco-editor')> {
  if (!_monaco) {
    _monaco = await import('monaco-editor')
  }
  return _monaco
}
