// OPIDE Extension Webview Panels — Phase A.A1
//
// Real implementation of VS Code's `vscode.window.createWebviewPanel`.
// Each panel renders as a sandboxed iframe inside a docked container on
// the right side of the OPIDE editor area, with a tab strip at the top
// when multiple panels are open at once.
//
// Architecture
//   Extension calls createWebviewPanel(...)
//     → api-shim sends 'webview/create' over JSON-RPC
//       → extension-bridge calls createWebviewPanel(params, msgCb, disposeCb, viewStateCb) here
//         → we mount a <div class="opide-webview-dock"> with a tab + an iframe
//           → user interacts; iframe.postMessage('msg from host') and
//             window.addEventListener('message', e => msgCb(panelId, e.data))
//
// The bridge owns the lifecycle: we never call back into JSON-RPC directly,
// only through the callbacks the bridge passed in. That keeps this module
// independent of the IPC plumbing and makes it unit-testable.

interface WebviewPanelInst {
  panelId: string
  viewType: string
  title: string
  /** Real workbench webview element from IWebviewService. Owns its own
   * iframe inside the body div. We talk to it via setHtml/postMessage/
   * onMessage instead of constructing an iframe by hand. */
  webview: any | null
  tab: HTMLButtonElement
  body: HTMLDivElement
  panel: HTMLDivElement
  pendingMessages: any[]
  pendingHtml: string | null
  options: any
  extensionId: string
  extensionPath: string
  onMessage: (panelId: string, message: any) => void
  onDispose: (panelId: string) => void
  onViewState: (panelId: string, state: { visible: boolean; active: boolean }) => void
}

const _panels = new Map<string, WebviewPanelInst>()
let _activePanelId: string | null = null
let _dockEl: HTMLDivElement | null = null
let _tabStripEl: HTMLDivElement | null = null
let _bodyAreaEl: HTMLDivElement | null = null

// ─── Dock infrastructure ───────────────────────────────────────────────

/** Lazy-create the dock container. We don't render anything until the
 * first webview is created, so the container is invisible if no
 * extension uses webviews. */
function ensureDock(): void {
  if (_dockEl) return

  // Inject CSS once. Tokens fall back to the @vscode-* tokens because the
  // workbench uses those everywhere.
  if (!document.getElementById('opide-webview-style')) {
    const style = document.createElement('style')
    style.id = 'opide-webview-style'
    style.textContent = `
      .opide-webview-dock {
        position: fixed;
        right: 0;
        top: 35px; /* below tab bar; adjusted at runtime if needed */
        bottom: 22px; /* above status bar */
        width: 480px;
        min-width: 280px;
        max-width: 80vw;
        background: var(--vscode-editor-background, #1e1e1e);
        color: var(--vscode-foreground, #cccccc);
        border-left: 1px solid var(--vscode-widget-border, #303031);
        z-index: 8000;
        display: flex;
        flex-direction: column;
        box-shadow: -4px 0 12px rgba(0,0,0,0.25);
        font-family: var(--vscode-font-family, system-ui);
      }
      .opide-webview-tabs {
        display: flex;
        align-items: stretch;
        background: var(--vscode-tab-inactiveBackground, #2d2d2d);
        border-bottom: 1px solid var(--vscode-widget-border, #303031);
        overflow-x: auto;
        flex-shrink: 0;
        scrollbar-width: thin;
      }
      .opide-webview-tab {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px 6px 12px;
        font-size: 12px;
        background: transparent;
        color: var(--vscode-tab-inactiveForeground, #969696);
        border: none;
        border-right: 1px solid var(--vscode-widget-border, #303031);
        cursor: pointer;
        font-family: inherit;
        max-width: 220px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .opide-webview-tab.active {
        background: var(--vscode-tab-activeBackground, #1e1e1e);
        color: var(--vscode-tab-activeForeground, #ffffff);
        box-shadow: inset 0 -2px 0 var(--vscode-focusBorder, #0078d4);
      }
      .opide-webview-tab-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: 3px;
        font-size: 13px;
        line-height: 1;
        color: inherit;
        opacity: 0.7;
        background: transparent;
        border: none;
        cursor: pointer;
      }
      .opide-webview-tab-close:hover {
        opacity: 1;
        background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
      }
      .opide-webview-body-area {
        position: relative;
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }
      .opide-webview-body {
        position: absolute;
        inset: 0;
        display: none;
      }
      .opide-webview-body.active {
        display: block;
      }
      .opide-webview-body iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: var(--vscode-editor-background, #1e1e1e);
      }
      .opide-webview-resizer {
        position: absolute;
        left: -3px;
        top: 0;
        bottom: 0;
        width: 6px;
        cursor: col-resize;
        background: transparent;
      }
      .opide-webview-resizer:hover { background: rgba(0,120,212,0.18); }
    `
    document.head.appendChild(style)
  }

  const dock = document.createElement('div')
  dock.className = 'opide-webview-dock'
  dock.setAttribute('aria-label', 'Extension Webview Panels')

  const resizer = document.createElement('div')
  resizer.className = 'opide-webview-resizer'
  installResizer(resizer, dock)
  dock.appendChild(resizer)

  const tabs = document.createElement('div')
  tabs.className = 'opide-webview-tabs'
  dock.appendChild(tabs)

  const bodyArea = document.createElement('div')
  bodyArea.className = 'opide-webview-body-area'
  dock.appendChild(bodyArea)

  document.body.appendChild(dock)

  _dockEl = dock
  _tabStripEl = tabs
  _bodyAreaEl = bodyArea
  // resizer is owned by the dock subtree; no separate ref needed.
  void resizer

  // No global window message listener needed — the workbench webview
  // service emits onMessage events on each individual IWebviewElement,
  // which we wire up per-panel in createWebviewPanel.
}

/** Resolve the workbench webview service (lazy — workbench may not be
 * fully up at module load time). */
async function getWebviewService(): Promise<any> {
  const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
  const { IWebviewService } = await import(
    '@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/webview/browser/webview.service'
  )
  return StandaloneServices.get(IWebviewService)
}

async function getActiveCodeWindow(): Promise<any> {
  const { getActiveWindow } = await import(
    '@codingame/monaco-vscode-api/vscode/vs/base/browser/dom'
  )
  return getActiveWindow()
}

/** Drag-resize handler for the dock's left edge. Lets the user widen
 * narrow it without conflicting with Monaco's own splitters. */
function installResizer(resizer: HTMLDivElement, dock: HTMLDivElement): void {
  let startX = 0
  let startWidth = 0
  let dragging = false
  resizer.addEventListener('mousedown', (e) => {
    dragging = true
    startX = e.clientX
    startWidth = dock.getBoundingClientRect().width
    document.body.style.userSelect = 'none'
    e.preventDefault()
  })
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return
    const delta = startX - e.clientX
    const next = Math.max(280, Math.min(window.innerWidth * 0.8, startWidth + delta))
    dock.style.width = `${next}px`
  })
  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false
      document.body.style.userSelect = ''
    }
  })
}

// ─── Public API (called by extension-bridge) ───────────────────────────

export function createWebviewPanel(
  params: {
    panelId: string
    viewType: string
    title: string
    options?: any
    extensionId?: string
    extensionPath?: string
  },
  onMessage: (panelId: string, message: any) => void,
  onDispose: (panelId: string) => void,
  onViewState: (panelId: string, state: { visible: boolean; active: boolean }) => void,
): void {
  ensureDock()
  if (!_tabStripEl || !_bodyAreaEl) return

  const { panelId, viewType, title, options, extensionId = '', extensionPath = '' } = params

  // Tab button
  const tab = document.createElement('button')
  tab.className = 'opide-webview-tab'
  tab.title = title
  const titleSpan = document.createElement('span')
  titleSpan.textContent = title
  titleSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;'
  tab.appendChild(titleSpan)

  const closeBtn = document.createElement('button')
  closeBtn.className = 'opide-webview-tab-close'
  closeBtn.title = 'Close panel'
  closeBtn.textContent = '×'
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    disposeWebviewPanel(panelId)
  })
  tab.appendChild(closeBtn)

  tab.addEventListener('click', () => activatePanel(panelId))

  _tabStripEl.appendChild(tab)

  // Body — the workbench webview will mount its own iframe here.
  const body = document.createElement('div')
  body.className = 'opide-webview-body'
  _bodyAreaEl.appendChild(body)

  const inst: WebviewPanelInst = {
    panelId,
    viewType,
    title,
    webview: null,
    tab,
    body,
    panel: body,
    pendingMessages: [],
    pendingHtml: null,
    options: options || {},
    extensionId,
    extensionPath,
    onMessage,
    onDispose,
    onViewState,
  }
  _panels.set(panelId, inst)

  // Construct the real workbench webview asynchronously and mount it.
  void mountPanelWebview(inst)

  activatePanel(panelId)
}

async function mountPanelWebview(inst: WebviewPanelInst): Promise<void> {
  const service = await getWebviewService()
  const targetWindow = await getActiveCodeWindow()
  const { URI } = await import('@codingame/monaco-vscode-api/vscode/vs/base/common/uri')

  const enableScripts = inst.options?.enableScripts !== false
  const enableForms = !!inst.options?.enableForms
  const localRoots = inst.extensionPath ? [URI.file(inst.extensionPath)] : []

  const webview = service.createWebviewElement({
    providedViewType: inst.viewType,
    title: inst.title,
    options: {
      purpose: 'webviewView',
      retainContextWhenHidden: !!inst.options?.retainContextWhenHidden,
    },
    contentOptions: {
      allowScripts: enableScripts,
      allowForms: enableForms,
      localResourceRoots: localRoots,
      enableCommandUris: false,
    },
    extension: inst.extensionId
      ? { id: { value: inst.extensionId, _lower: inst.extensionId.toLowerCase() } }
      : undefined,
  })
  inst.webview = webview

  webview.mountTo(inst.body, targetWindow)

  webview.onMessage((ev: any) => {
    inst.onMessage(inst.panelId, ev?.message)
  })

  if (inst.pendingHtml != null) {
    webview.setHtml(inst.pendingHtml)
    inst.pendingHtml = null
  }
  if (inst.pendingMessages.length) {
    for (const m of inst.pendingMessages) {
      try { webview.postMessage(m) } catch { /* ignore */ }
    }
    inst.pendingMessages.length = 0
  }
}

/** Switch to the given panel. Hides others, fires onViewState for both
 * the previously-active and newly-active panels. */
function activatePanel(panelId: string): void {
  if (_activePanelId === panelId) return
  const previous = _activePanelId
  _activePanelId = panelId
  for (const [id, inst] of _panels) {
    const isActive = id === panelId
    inst.body.classList.toggle('active', isActive)
    inst.tab.classList.toggle('active', isActive)
  }
  // Fire view-state events
  if (previous && _panels.has(previous)) {
    const prev = _panels.get(previous)!
    prev.onViewState(previous, { visible: true, active: false })
  }
  if (_panels.has(panelId)) {
    const cur = _panels.get(panelId)!
    cur.onViewState(panelId, { visible: true, active: true })
  }
}

export function setWebviewHtml(panelId: string, html: string): void {
  const inst = _panels.get(panelId)
  if (!inst) return
  if (!inst.webview) {
    inst.pendingHtml = html
    return
  }
  // The workbench webview handles CSP, nonce, acquireVsCodeApi
  // injection, vscode-webview:// resource resolution, and postMessage
  // queueing internally. We just hand it the raw HTML.
  inst.webview.setHtml(html)
}

export function postMessageToWebview(panelId: string, message: any): void {
  const inst = _panels.get(panelId)
  if (!inst) return
  if (!inst.webview) {
    inst.pendingMessages.push(message)
    return
  }
  try {
    inst.webview.postMessage(message)
  } catch (e) {
    console.warn('[ext-webviews] postMessage failed:', e)
  }
}

export function revealWebviewPanel(panelId: string): void {
  if (!_panels.has(panelId)) return
  activatePanel(panelId)
}

export function disposeWebviewPanel(panelId: string): void {
  const inst = _panels.get(panelId)
  if (!inst) return

  try { inst.webview?.dispose?.() } catch { /* ignore */ }
  inst.tab.remove()
  inst.body.remove()
  _panels.delete(panelId)
  inst.onDispose(panelId)

  // If the active panel was disposed, activate the next one. If no
  // panels remain, hide the dock entirely so we don't leave an empty
  // bar floating over the editor.
  if (_activePanelId === panelId) {
    _activePanelId = null
    const next = _panels.values().next().value as WebviewPanelInst | undefined
    if (next) {
      activatePanel(next.panelId)
    } else if (_dockEl) {
      _dockEl.style.display = 'none'
    }
  }
  if (_panels.size > 0 && _dockEl) {
    _dockEl.style.display = 'flex'
  }
}
