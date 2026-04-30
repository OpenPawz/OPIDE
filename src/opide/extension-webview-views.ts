// OPIDE Extension Webview Views — Phase C.C2
//
// Sidebar webview slots: same iframe infrastructure as Phase A.A1
// (createWebviewPanel) but mounted in a panel that lives in the
// auxiliary bar instead of the editor area. Used by extensions that
// register sidebar UIs via window.registerWebviewViewProvider — most
// commonly Continue's sidebar, GitLens commit graph, or test runners.
//
// The provider lifecycle has an extra step compared to panels:
//   1. extension calls registerWebviewViewProvider(viewId, provider)
//   2. user clicks the view in the auxiliary bar → renderBody fires
//   3. we callback the bridge with `webviewView/resolve`
//   4. bridge fires the api-shim's resolveWebviewView in the sidecar
//   5. extension's resolveWebviewView fills in webview.html
//   6. that html arrives via webviewView/setHtml and we update the iframe

import { invoke } from '@tauri-apps/api/core'
import {
  registerCustomView,
  ViewContainerLocation,
} from '@codingame/monaco-vscode-workbench-service-override'
import { notifyViewActivated } from './extension-bridge.ts'
import { findPreMountedSlot, markSlotAttached } from './extension-contributed-views.ts'

/** Pipe debug into OPIDE.log so we can trace what fires when. */
function logToFile(msg: string): void {
  try { invoke('ext_host_log', { message: `[ext-webview-views] ${msg}` }).catch(() => {}) } catch { /* ignore */ }
}

interface WebviewViewInst {
  viewId: string
  options: any
  iframe: HTMLIFrameElement | null
  container: HTMLElement | null
  /** True after the user has revealed this view at least once and the
   * extension has had a chance to call resolveWebviewView. Without this
   * we'd send setHtml messages before the iframe exists. */
  resolved: boolean
  pendingHtml: string | null
  pendingMessages: any[]
  ready: boolean
  onResolve: () => void
  onMessage: (message: any) => void
}

const _views = new Map<string, WebviewViewInst>()
let _messageListener: ((e: MessageEvent) => void) | null = null

function ensureMessageListener(): void {
  if (_messageListener) return
  _messageListener = (event: MessageEvent) => {
    for (const inst of _views.values()) {
      if (event.source === inst.iframe?.contentWindow) {
        if (event.data === '__opide_webview_ready__') {
          inst.ready = true
          for (const m of inst.pendingMessages) {
            try { inst.iframe?.contentWindow?.postMessage(m, '*') } catch { /* ignore */ }
          }
          inst.pendingMessages.length = 0
        } else if (event.data && typeof event.data === 'object' && event.data.__opide_webview_error__) {
          // Iframe-side runtime error captured by the script we
          // inject. Pipe straight to OPIDE.log so the user can see
          // what crashed inside the extension's webview without
          // opening dev tools.
          const err = event.data.__opide_webview_error__
          const summary =
            `iframe error in ${inst.viewId}: ${err.kind || 'error'}: ${err.message || ''}` +
            (err.source ? ` (${err.source}:${err.line}:${err.col})` : '') +
            (err.stack ? `\nstack: ${String(err.stack).split('\n').slice(0, 8).join(' | ')}` : '')
          logToFile(summary)
        } else {
          inst.onMessage(event.data)
        }
        break
      }
    }
  }
  window.addEventListener('message', _messageListener)
}

function buildBody(inst: WebviewViewInst, root: HTMLElement): void {
  logToFile(`buildBody START for ${inst.viewId}, pendingHtml=${inst.pendingHtml ? `len=${inst.pendingHtml.length}` : 'null'}`)
  inst.container = root
  root.style.cssText = 'display:flex;flex-direction:column;height:100%;width:100%;background:var(--vscode-sideBar-background);'

  const iframe = document.createElement('iframe')
  const enableScripts = inst.options?.webviewOptions?.enableScripts !== false
  const sandbox = ['allow-same-origin']
  if (enableScripts) sandbox.push('allow-scripts')
  if (inst.options?.webviewOptions?.enableForms) sandbox.push('allow-forms')
  iframe.setAttribute('sandbox', sandbox.join(' '))
  iframe.style.cssText = 'flex:1;border:0;background:var(--vscode-editor-background);'
  root.appendChild(iframe)
  inst.iframe = iframe
  ensureMessageListener()

  // First-mount: ask the extension to fill the html via resolveWebviewView.
  if (!inst.resolved) {
    inst.resolved = true
    logToFile(`buildBody calling onResolve for ${inst.viewId}`)
    inst.onResolve()
  }
  // If html arrived before we mounted, apply it now.
  if (inst.pendingHtml != null) {
    logToFile(`buildBody applying pendingHtml for ${inst.viewId}, len=${inst.pendingHtml.length}`)
    setWebviewViewHtml(inst.viewId, inst.pendingHtml)
  }
  logToFile(`buildBody DONE for ${inst.viewId}`)
}

function injectScripts(html: string): string {
  const readyScript = `<script>(function(){try{window.parent.postMessage('__opide_webview_ready__','*')}catch(e){}})();</script>`
  // Forward iframe-side runtime errors to the parent so we can see
  // what's actually failing inside extension webviews. Without this,
  // an error in Claude Code's React app shows up as an empty panel
  // with the stack visible only via dev tools (which the user
  // doesn't want to use). Errors land in OPIDE.log via the
  // __opide_webview_error__ message handler in extension-webview-views.
  const errorCaptureScript = `<script>
    (function(){
      function send(payload){
        try { window.parent.postMessage({ __opide_webview_error__: payload }, '*'); } catch(e){}
      }
      window.addEventListener('error', function(ev){
        send({
          kind: 'error',
          message: ev.message,
          source: ev.filename,
          line: ev.lineno,
          col: ev.colno,
          stack: ev.error && ev.error.stack ? String(ev.error.stack) : '',
        });
      });
      window.addEventListener('unhandledrejection', function(ev){
        send({
          kind: 'unhandledrejection',
          message: String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason),
          stack: ev.reason && ev.reason.stack ? String(ev.reason.stack) : '',
        });
      });
    })();
  </script>`
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
  // Rewrite the extension's CSP so it allows opide-ext: alongside the
  // legacy vscode-resource: scheme. Real VS Code's CSP allows
  // vscode-resource: by routing it server-side; we serve opide-ext:
  // from Tauri Rust (see opide_ext_protocol_handler in lib.rs).
  // Without this rewrite, even though asWebviewUri returns opide-ext:
  // URLs, the CSP meta tag in Claude Code's HTML blocks them and the
  // iframe stays empty.
  let rewritten = html.replace(
    /(<meta[^>]+http-equiv\s*=\s*["']Content-Security-Policy["'][^>]+content\s*=\s*["'])([^"']+)(["'])/gi,
    (_full, prefix: string, content: string, suffix: string) => {
      const widened = content
        .replace(/vscode-resource:/g, 'vscode-resource: opide-ext:')
        .replace(/\bopide-ext:\s+opide-ext:/g, 'opide-ext:') // dedupe
      return prefix + widened + suffix
    },
  )
  // Also rewrite raw vscode-resource:// URLs in the HTML body. Some
  // extensions don't go through asWebviewUri for every resource and
  // hardcode the scheme; we redirect those to opide-ext as a defense.
  rewritten = rewritten.replace(/vscode-resource:\/\/(\S+?)([\s"'<>])/g, (_m, path: string, term: string) => {
    // Path may already start with /Users/.../.opide/extensions/<id>/<rel>;
    // we strip the .opide/extensions prefix and rebuild.
    const m = path.match(/[\\/]\.opide[\\/]extensions[\\/]([^\\/]+)[\\/](.*)$/)
    if (m) return `opide-ext://localhost/${encodeURIComponent(m[1])}/${m[2].split(/[\\/]/).map(encodeURIComponent).join('/')}${term}`
    return `opide-ext://localhost/${path}${term}`
  })
  if (/<body[^>]*>/i.test(rewritten)) {
    return rewritten.replace(/<body([^>]*)>/i, `<body$1>${errorCaptureScript}${vsCodeApiShim}${readyScript}`)
  }
  return `<!doctype html><html><head></head><body>${errorCaptureScript}${vsCodeApiShim}${readyScript}${rewritten}</body></html>`
}

// ─── Public API ────────────────────────────────────────────────────────

export function registerWebviewView(
  viewId: string,
  options: any,
  onResolve: () => void,
  onMessage: (message: any) => void,
): void {
  if (!viewId) return
  const inst: WebviewViewInst = {
    viewId,
    options,
    iframe: null,
    container: null,
    resolved: false,
    pendingHtml: null,
    pendingMessages: [],
    ready: false,
    onResolve,
    onMessage,
  }
  _views.set(viewId, inst)

  // Two-phase contribution model: if the view was pre-mounted from
  // package.json contributes.views (P0), the slot already exists in
  // the workbench. We attach to it here; we do NOT registerCustomView
  // again because that would create a duplicate panel.
  //
  // RACE: extensions activated by `onStartupFinished` register their
  // webview-view providers BEFORE the bridge's extensionHost/ready
  // handler runs registerAllContributedViews — so when this function
  // fires, the slot may not yet be in the registry. Solution:
  // register a pending callback that fires when (and if) the slot
  // shows up. If no contributed-view slot ever exists for this id
  // (extension didn't declare it in package.json), we fall back to
  // the legacy "create our own custom view" path AFTER a short
  // grace window.
  const preMounted = findPreMountedSlot(viewId)
  if (preMounted && preMounted.type === 'webview') {
    markSlotAttached(viewId, (root) => buildBody(inst, root))
    return
  }
  // Defer + race-resolve: try again after the next pre-mount runs.
  // If the slot does turn up, attach there and skip the legacy view.
  // If not, create the legacy view as a last resort so the extension
  // isn't stranded.
  registerPendingWebviewProvider(viewId)
  // Wait one tick for pre-mount to potentially happen (it runs
  // synchronously inside registerAllContributedViews); if it didn't,
  // schedule the legacy fallback after a 250ms grace window.
  // 250ms = comfortably longer than the bridge's typical ready
  // dispatch latency.
  setTimeout(() => {
    const slotNow = findPreMountedSlot(viewId)
    if (slotNow && slotNow.type === 'webview') {
      // Already attached via pending queue; nothing to do.
      return
    }
    if (_views.get(viewId) !== inst) {
      // Stale instance (re-registration happened). Skip.
      return
    }
    // No contributed view ever appeared. Create a legacy custom view.
    legacyRegisterWebviewView(viewId, inst)
  }, 250)
}

// ─── Pending registration queue ────────────────────────────────────────
//
// When an extension activates eagerly (onStartupFinished) it registers
// its webview-view provider BEFORE the bridge has a chance to call
// registerAllContributedViews. That race used to create a duplicate
// panel because findPreMountedSlot returned undefined. Now we queue
// the registration; extension-contributed-views.ts checks this queue
// every time it pre-mounts a slot and attaches matching providers.

type PendingMount = (root: HTMLElement) => void
const _pendingProviders = new Map<string, PendingMount>()

function registerPendingWebviewProvider(viewId: string): void {
  const inst = _views.get(viewId)
  if (!inst) return
  _pendingProviders.set(viewId, (root: HTMLElement) => buildBody(inst, root))
}

/** Called by extension-contributed-views.ts every time a slot is
 * registered. If there's a pending webview provider for this slot,
 * attach immediately. */
export function drainPendingForSlot(viewId: string): boolean {
  const mounter = _pendingProviders.get(viewId)
  if (!mounter) return false
  _pendingProviders.delete(viewId)
  markSlotAttached(viewId, mounter)
  return true
}

function legacyRegisterWebviewView(viewId: string, inst: WebviewViewInst): void {

  try {
    registerCustomView({
      id: `opide-ext-wvview-${viewId}`,
      name: viewId,
      location: ViewContainerLocation.AuxiliaryBar,
      icon: 'browser',
      renderBody: (root: HTMLElement) => {
        notifyViewActivated(viewId)
        buildBody(inst, root)
        return {
          dispose() {
            inst.iframe = null
            inst.container = null
            inst.ready = false
          },
        }
      },
    })
  } catch (e) {
    console.warn(`[ext-webview-views] registerCustomView failed for ${viewId}:`, e)
  }
}

export function disposeWebviewView(viewId: string): void {
  const inst = _views.get(viewId)
  if (!inst) return
  if (inst.container) inst.container.innerHTML = ''
  _views.delete(viewId)
}

export function setWebviewViewHtml(viewId: string, html: string): void {
  const inst = _views.get(viewId)
  if (!inst) {
    logToFile(`setWebviewViewHtml: NO inst for ${viewId} (registration race?)`)
    return
  }
  if (!inst.iframe) {
    // Cache until the view is mounted; buildBody will apply it.
    inst.pendingHtml = html
    logToFile(`setWebviewViewHtml: queued for ${viewId} (iframe not yet built), len=${html.length}`)
    return
  }
  inst.ready = false
  inst.iframe.srcdoc = injectScripts(html)
  logToFile(`setWebviewViewHtml: applied to ${viewId}, len=${html.length}`)
}

export function postMessageToWebviewView(viewId: string, message: any): void {
  const inst = _views.get(viewId)
  if (!inst) return
  if (!inst.ready || !inst.iframe?.contentWindow) {
    inst.pendingMessages.push(message)
    return
  }
  try {
    inst.iframe.contentWindow.postMessage(message, '*')
  } catch (e) {
    console.warn('[ext-webview-views] postMessage failed:', e)
  }
}

export function revealWebviewView(viewId: string): void {
  // No-op for now. Programmatic reveal via IViewsService.openView was
  // tried but suspected of contributing to a folder-open hang; until
  // we have a clean repro path the user clicks the tab manually.
  // Honest stub.
  void invoke('ext_host_log', {
    message: `[ext-webview-views] reveal request for ${viewId} (manual click required)`,
  }).catch(() => {})
}
