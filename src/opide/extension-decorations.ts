// OPIDE Extension Decorations — Phase A.A2
//
// Real implementation of `vscode.window.createTextEditorDecorationType` +
// `editor.setDecorations`. Translates VS Code DecorationRenderOptions to
// Monaco IModelDecorationOptions and applies them via deltaDecorations on
// the matching model.
//
// Strategy
//   1. createDecorationType(typeId, options): generate a CSS class per
//      type (className for inline, gutter, etc), inject a stylesheet
//      with the rendered styles. Cache the class names on the type
//      record so setDecorations can refer to them directly.
//   2. setDecorations(uri, typeId, ranges): find the matching Monaco
//      model, build IModelDeltaDecoration[] entries, call
//      model.deltaDecorations(prevIds, newDecorations). Track prevIds
//      per (model, type) so successive calls replace cleanly.
//
// CSS classes are scoped to the type via a unique suffix so two
// extensions can register types with the same render options without
// stepping on each other's styling.

interface DecorationTypeRecord {
  typeId: string
  options: any
  cssClassName: string
  beforeClassName?: string
  afterClassName?: string
  glyphMarginClassName?: string
  isWholeLine: boolean
  rangeBehavior?: number
  /** Per-model decoration IDs from the most recent setDecorations.
   *  Keyed by model URI string. We need this so deltaDecorations can
   *  return the new IDs while removing the old ones. */
  modelToIds: Map<string, string[]>
}

const _types = new Map<string, DecorationTypeRecord>()
let _styleEl: HTMLStyleElement | null = null

function ensureStyleSheet(): HTMLStyleElement {
  if (_styleEl) return _styleEl
  const el = document.createElement('style')
  el.id = 'opide-ext-decorations'
  document.head.appendChild(el)
  _styleEl = el
  return el
}

function safeCssValue(v: any): string {
  if (v == null) return ''
  // `var(--vscode-x)` and ThemeColor objects: we accept theme references
  // by stringifying ThemeColor.id into the matching CSS variable name.
  if (typeof v === 'object' && v.id) return `var(--vscode-${v.id.replace(/\./g, '-')})`
  return String(v)
}

function appendRules(typeId: string, rec: DecorationTypeRecord): void {
  const sheet = ensureStyleSheet()
  const opts = rec.options || {}

  const inlineDecls: string[] = []
  if (opts.color) inlineDecls.push(`color: ${safeCssValue(opts.color)} !important;`)
  if (opts.backgroundColor) inlineDecls.push(`background-color: ${safeCssValue(opts.backgroundColor)} !important;`)
  if (opts.fontStyle) inlineDecls.push(`font-style: ${safeCssValue(opts.fontStyle)} !important;`)
  if (opts.fontWeight) inlineDecls.push(`font-weight: ${safeCssValue(opts.fontWeight)} !important;`)
  if (opts.textDecoration) inlineDecls.push(`text-decoration: ${safeCssValue(opts.textDecoration)} !important;`)
  if (opts.opacity != null) inlineDecls.push(`opacity: ${safeCssValue(opts.opacity)} !important;`)
  if (opts.letterSpacing) inlineDecls.push(`letter-spacing: ${safeCssValue(opts.letterSpacing)} !important;`)
  if (opts.border) inlineDecls.push(`border: ${safeCssValue(opts.border)} !important;`)
  if (opts.borderColor) inlineDecls.push(`border-color: ${safeCssValue(opts.borderColor)} !important;`)
  if (opts.borderStyle) inlineDecls.push(`border-style: ${safeCssValue(opts.borderStyle)} !important;`)
  if (opts.borderWidth) inlineDecls.push(`border-width: ${safeCssValue(opts.borderWidth)} !important;`)
  if (opts.borderRadius) inlineDecls.push(`border-radius: ${safeCssValue(opts.borderRadius)} !important;`)
  if (opts.outline) inlineDecls.push(`outline: ${safeCssValue(opts.outline)} !important;`)
  if (opts.outlineColor) inlineDecls.push(`outline-color: ${safeCssValue(opts.outlineColor)} !important;`)
  if (opts.outlineStyle) inlineDecls.push(`outline-style: ${safeCssValue(opts.outlineStyle)} !important;`)
  if (opts.outlineWidth) inlineDecls.push(`outline-width: ${safeCssValue(opts.outlineWidth)} !important;`)
  if (opts.cursor) inlineDecls.push(`cursor: ${safeCssValue(opts.cursor)} !important;`)

  const inlineRule = inlineDecls.length > 0
    ? `.${rec.cssClassName} { ${inlineDecls.join(' ')} }`
    : ''

  // before / after pseudo-content
  function pseudoRule(side: 'before' | 'after'): string {
    const cfg = opts[side]
    if (!cfg) return ''
    const cn = side === 'before' ? rec.beforeClassName : rec.afterClassName
    if (!cn) return ''
    const decls: string[] = []
    if (cfg.contentText != null) decls.push(`content: ${JSON.stringify(String(cfg.contentText))};`)
    if (cfg.contentIconPath) decls.push(`background-image: url(${JSON.stringify(String(cfg.contentIconPath))}); display: inline-block; width: 16px; height: 16px;`)
    if (cfg.color) decls.push(`color: ${safeCssValue(cfg.color)};`)
    if (cfg.backgroundColor) decls.push(`background-color: ${safeCssValue(cfg.backgroundColor)};`)
    if (cfg.fontStyle) decls.push(`font-style: ${safeCssValue(cfg.fontStyle)};`)
    if (cfg.fontWeight) decls.push(`font-weight: ${safeCssValue(cfg.fontWeight)};`)
    if (cfg.textDecoration) decls.push(`text-decoration: ${safeCssValue(cfg.textDecoration)};`)
    if (cfg.margin) decls.push(`margin: ${safeCssValue(cfg.margin)};`)
    if (cfg.width) decls.push(`width: ${safeCssValue(cfg.width)};`)
    if (cfg.height) decls.push(`height: ${safeCssValue(cfg.height)};`)
    return `.${cn}::${side} { ${decls.join(' ')} }`
  }

  // Glyph margin (gutter icon)
  const glyphRule = (() => {
    if (!opts.gutterIconPath) return ''
    const cn = rec.glyphMarginClassName!
    const sz = opts.gutterIconSize || 'contain'
    return `.${cn} { background-image: url(${JSON.stringify(String(opts.gutterIconPath))}); background-repeat: no-repeat; background-position: center; background-size: ${sz}; }`
  })()

  const rules = [inlineRule, pseudoRule('before'), pseudoRule('after'), glyphRule]
    .filter(Boolean)
    .join('\n')

  sheet.appendChild(document.createTextNode(`/* ${typeId} */\n${rules}\n`))
}

// ─── Public API ────────────────────────────────────────────────────────

export function createDecorationType(typeId: string, options: any): void {
  if (_types.has(typeId)) return
  // CSS-safe class names. Tracked separately so we can target each
  // rendering target (inline body, ::before, ::after, glyph margin).
  const safeId = typeId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const rec: DecorationTypeRecord = {
    typeId,
    options: options || {},
    cssClassName: `opide-dec-${safeId}`,
    beforeClassName: options?.before ? `opide-dec-${safeId}-before` : undefined,
    afterClassName: options?.after ? `opide-dec-${safeId}-after` : undefined,
    glyphMarginClassName: options?.gutterIconPath ? `opide-dec-${safeId}-gutter` : undefined,
    isWholeLine: !!options?.isWholeLine,
    rangeBehavior: options?.rangeBehavior,
    modelToIds: new Map(),
  }
  _types.set(typeId, rec)
  appendRules(typeId, rec)
}

export async function setDecorations(
  uri: string | undefined,
  typeId: string,
  ranges: any[],
): Promise<void> {
  if (!uri) return
  const rec = _types.get(typeId)
  if (!rec) return

  // Resolve Monaco model for the URI. Path-based match is enough; we
  // accept either fsPath or vscode-style 'file:///path' strings.
  const monacoMod = await import('monaco-editor') as any
  const monaco = monacoMod.default || monacoMod
  const targetPath = uri.startsWith('file://') ? uri.replace(/^file:\/\//, '') : uri
  const models = monaco.editor.getModels()
  const model = models.find((m: any) => {
    const mPath = m.uri.fsPath || m.uri.path || ''
    return mPath === targetPath || m.uri.toString() === uri
  })
  if (!model) return

  const newDecorations = ranges.map((r: any) => {
    const range = {
      startLineNumber: (r.range?.start?.line ?? 0) + 1,
      startColumn: (r.range?.start?.character ?? 0) + 1,
      endLineNumber: (r.range?.end?.line ?? 0) + 1,
      endColumn: (r.range?.end?.character ?? 0) + 1,
    }
    // Per-range render options can override the type's defaults; we
    // currently ignore them (Phase A v1) and use the type-level CSS
    // classes only. Most extensions don't use per-range overrides.
    const options: any = {
      isWholeLine: rec.isWholeLine,
      stickiness: rec.rangeBehavior,
    }
    if (rec.cssClassName) options.inlineClassName = rec.cssClassName
    if (rec.cssClassName) options.className = rec.isWholeLine ? rec.cssClassName : undefined
    if (rec.beforeClassName) options.beforeContentClassName = rec.beforeClassName
    if (rec.afterClassName) options.afterContentClassName = rec.afterClassName
    if (rec.glyphMarginClassName) options.glyphMarginClassName = rec.glyphMarginClassName
    if (r.hoverMessage) {
      options.hoverMessage = typeof r.hoverMessage === 'string'
        ? { value: r.hoverMessage }
        : r.hoverMessage
    }
    // Overview ruler: VS Code passes a color directly on render options
    // and a lane enum. Map to Monaco's overviewRuler descriptor.
    const opts = rec.options || {}
    if (opts.overviewRulerColor) {
      const lane = opts.overviewRulerLane ?? 7 /* Full */
      options.overviewRuler = {
        color: safeCssValue(opts.overviewRulerColor),
        position: lane,
      }
    }
    return { range, options }
  })

  const modelKey = model.uri.toString()
  const prevIds = rec.modelToIds.get(modelKey) || []
  const newIds = model.deltaDecorations(prevIds, newDecorations)
  rec.modelToIds.set(modelKey, newIds)
}

export async function disposeDecorationType(typeId: string): Promise<void> {
  const rec = _types.get(typeId)
  if (!rec) return

  // Clear all decorations from every model the type touched.
  try {
    const monacoMod = await import('monaco-editor') as any
    const monaco = monacoMod.default || monacoMod
    for (const [modelKey, ids] of rec.modelToIds) {
      const model = monaco.editor.getModels().find((m: any) => m.uri.toString() === modelKey)
      if (model) model.deltaDecorations(ids, [])
    }
  } catch { /* ignore */ }
  _types.delete(typeId)
}
