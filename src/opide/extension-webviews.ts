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
  iframe: HTMLIFrameElement
  tab: HTMLButtonElement
  body: HTMLDivElement
  panel: HTMLDivElement
  pendingMessages: any[]
  ready: boolean
  options: any
  onMessage: (panelId: string, message: any) => void
  onDispose: (panelId: string) => void
  onViewState: (panelId: string, state: { visible: boolean; active: boolean }) => void
}

const _panels = new Map<string, WebviewPanelInst>()
let _activePanelId: string | null = null
let _dockEl: HTMLDivElement | null = null
let _tabStripEl: HTMLDivElement | null = null
let _bodyAreaEl: HTMLDivElement | null = null
let _messageListener: ((e: MessageEvent) => void) | null = null

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

  // Single global listener for postMessage from any iframe. We dispatch
  // by matching the source iframe contentWindow against our registry.
  // Cheaper than per-panel listeners and survives panel recreation.
  if (!_messageListener) {
    _messageListener = (event: MessageEvent) => {
      for (const panel of _panels.values()) {
        if (event.source === panel.iframe.contentWindow) {
          // Ignore the iframe's "ready" handshake; only forward extension
          // messages. Extensions in VS Code use vscode-webview-api's
          // postMessage which always carries a payload, so we only care
          // about events with `data`.
          if (event.data === '__opide_webview_ready__') {
            panel.ready = true
            // Flush any queued messages now that the iframe is alive.
            for (const m of panel.pendingMessages) {
              try { panel.iframe.contentWindow?.postMessage(m, '*') } catch { /* ignore */ }
            }
            panel.pendingMessages.length = 0
          } else {
            panel.onMessage(panel.panelId, event.data)
          }
          break
        }
      }
    }
    window.addEventListener('message', _messageListener)
  }
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
    extensionPath?: string
  },
  onMessage: (panelId: string, message: any) => void,
  onDispose: (panelId: string) => void,
  onViewState: (panelId: string, state: { visible: boolean; active: boolean }) => void,
): void {
  ensureDock()
  if (!_tabStripEl || !_bodyAreaEl) return

  const { panelId, viewType, title, options } = params

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

  // Body + iframe
  const body = document.createElement('div')
  body.className = 'opide-webview-body'

  const iframe = document.createElement('iframe')
  // Sandbox attributes derived from extension's enableScripts option.
  // VS Code default: enableScripts=false -> sandboxed without scripts.
  // We default to enableScripts=true for compatibility with most
  // extensions; if an extension explicitly opts out we can lock it down.
  const enableScripts = options?.enableScripts !== false
  const sandbox = ['allow-same-origin']
  if (enableScripts) sandbox.push('allow-scripts')
  if (options?.enableForms) sandbox.push('allow-forms')
  iframe.setAttribute('sandbox', sandbox.join(' '))
  // Permissions-policy: extensions can't access camera/mic by default.
  iframe.setAttribute('allow', '')
  body.appendChild(iframe)

  _bodyAreaEl.appendChild(body)

  const inst: WebviewPanelInst = {
    panelId,
    viewType,
    title,
    iframe,
    tab,
    body,
    panel: body, // alias so we can call removeChild without ambiguity
    pendingMessages: [],
    ready: false,
    options: options || {},
    onMessage,
    onDispose,
    onViewState,
  }
  _panels.set(panelId, inst)

  activatePanel(panelId)
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

  // Inject a small ready-handshake script so we can flush queued
  // postMessages once the iframe's contentWindow is alive. Extensions
  // call panel.webview.html = '...' before calling postMessage, so
  // without this, early messages would be dropped.
  const readyScript = `<script>(function(){try{window.parent.postMessage('__opide_webview_ready__','*')}catch(e){}})();</script>`
  // VS Code extensions expect a `acquireVsCodeApi()` global.
  const vsCodeApiShim = `<script>
    (function(){
      let _state = undefined;
      window.acquireVsCodeApi = function() {
        return {
          postMessage: function(msg) { try { window.parent.postMessage(msg, '*'); } catch (e) {} },
          getState: function() { return _state; },
          setState: function(s) { _state = s; },
        };
      };
    })();
  </script>`

  // Append our scripts at the start of <body>; if the html has no body,
  // wrap it. This keeps the extension's html intact while ensuring our
  // shim runs before extension scripts.
  let injected = html
  if (/<body[^>]*>/i.test(html)) {
    injected = html.replace(/<body([^>]*)>/i, `<body$1>${vsCodeApiShim}${readyScript}`)
  } else {
    injected = `<!doctype html><html><head></head><body>${vsCodeApiShim}${readyScript}${html}</body></html>`
  }

  inst.ready = false
  inst.iframe.srcdoc = injected
}

export function postMessageToWebview(panelId: string, message: any): void {
  const inst = _panels.get(panelId)
  if (!inst) return
  if (!inst.ready) {
    inst.pendingMessages.push(message)
    return
  }
  try {
    inst.iframe.contentWindow?.postMessage(message, '*')
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
