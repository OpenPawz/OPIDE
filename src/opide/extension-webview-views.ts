// OPIDE Extension Webview Views — Phase B (real workbench webview)
//
// Path B: instead of hand-rolling an iframe + acquireVsCodeApi shim + CSP
// rewriting + opide-ext:// scheme handler, we use monaco-vscode-api's
// IWebviewService directly. That service comes from
// @codingame/monaco-vscode-view-common-service-override (registered in
// src/workbench.ts) and provides the real VS Code webview iframe with:
//   - acquireVsCodeApi() handshake
//   - vscode-webview:// resource URLs via service worker
//   - CSP, nonce, sandbox flags
//   - postMessage protocol with proper queueing
//   - localResourceRoots for restricting file access
//
// We just register the resolver, mount the IWebviewElement into the slot
// the contributed-views layer already pre-built, and bridge setHtml /
// postMessage to the sidecar over the existing RPC.

import { invoke } from '@tauri-apps/api/core'
import { findPreMountedSlot, markSlotAttached } from './extension-contributed-views.ts'

/** Pipe debug into OPIDE.log so we can trace what fires when. */
function logToFile(msg: string): void {
  try { invoke('ext_host_log', { message: `[ext-webview-views] ${msg}` }).catch(() => {}) } catch { /* ignore */ }
}
/** High-volume per-event traces (buildWebview START/DONE, setHtml,
 * reveal requests). Goes to console only when window.OPIDE_VERBOSE_VIEWS
 * is set; off by default to keep OPIDE.log readable. Errors / race
 * surprises still go through logToFile. */
function traceLog(msg: string): void {
  if ((globalThis as any).OPIDE_VERBOSE_VIEWS) {
    console.log(`[ext-webview-views] ${msg}`)
  }
}

interface WebviewViewInst {
  viewId: string
  options: any
  webview: any | null  // IWebviewElement once created
  container: HTMLElement | null
  resolved: boolean
  pendingHtml: string | null
  pendingMessages: any[]
  onResolve: () => void
  onMessage: (message: any) => void
  /** Local resource roots to allow the webview to load from. We grant
   * the extension's install dir so its <script src=...> and <link>
   * tags resolve to files under ~/.opide/extensions/<id>/. */
  localResourceRoots: string[]
  /** Extension manifest publisher.name — used as the extension identifier
   * the workbench attaches to the webview for telemetry / origin keying. */
  extensionId: string
}

const _views = new Map<string, WebviewViewInst>()

/** Lazily resolve the workbench webview service. The override is
 * registered in src/workbench.ts during initializeWorkbench. By the
 * time any extension calls registerWebviewViewProvider, the workbench
 * is up and the service resolves. */
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

async function buildWebview(inst: WebviewViewInst, root: HTMLElement): Promise<void> {
  traceLog(`buildWebview START for ${inst.viewId}, pendingHtml=${inst.pendingHtml ? `len=${inst.pendingHtml.length}` : 'null'}`)
  inst.container = root
  root.style.cssText = 'display:flex;flex-direction:column;height:100%;width:100%;background:var(--vscode-sideBar-background);'

  const service = await getWebviewService()
  const targetWindow = await getActiveCodeWindow()
  const { URI } = await import('@codingame/monaco-vscode-api/vscode/vs/base/common/uri')

  const enableScripts = inst.options?.webviewOptions?.enableScripts !== false
  const enableForms = !!inst.options?.webviewOptions?.enableForms
  const localRoots = inst.localResourceRoots.map((p) => URI.file(p))

  const webview = service.createWebviewElement({
    providedViewType: inst.viewId,
    title: inst.viewId,
    options: {
      purpose: 'webviewView',
      retainContextWhenHidden: !!inst.options?.webviewOptions?.retainContextWhenHidden,
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

  // Mount the webview iframe into our slot's container.
  webview.mountTo(root, targetWindow)

  // Bridge postMessages back to the sidecar. The workbench webview
  // emits onMessage when the iframe's React app calls
  // vscode.postMessage; we forward to onMessage which the bridge wires
  // to webviewView/onMessage RPC.
  webview.onMessage((ev: any) => {
    inst.onMessage(ev?.message)
  })

  // First-mount: ask the extension to fill the html via resolveWebviewView.
  if (!inst.resolved) {
    inst.resolved = true
    traceLog(`buildWebview calling onResolve for ${inst.viewId}`)
    inst.onResolve()
  }

  // If html already arrived (sidecar fast-path), apply it now.
  if (inst.pendingHtml != null) {
    traceLog(`buildWebview applying pendingHtml for ${inst.viewId}, len=${inst.pendingHtml.length}`)
    webview.setHtml(inst.pendingHtml)
    inst.pendingHtml = null
  }
  // Flush any queued postMessages.
  if (inst.pendingMessages.length) {
    traceLog(`buildWebview flushing ${inst.pendingMessages.length} pending messages for ${inst.viewId}`)
    for (const m of inst.pendingMessages) {
      try { webview.postMessage(m) } catch (e) { logToFile(`pending postMessage failed: ${e}`) }
    }
    inst.pendingMessages.length = 0
  }
  traceLog(`buildWebview DONE for ${inst.viewId}`)
}

// ─── Public API ────────────────────────────────────────────────────────

export function registerWebviewView(
  viewId: string,
  options: any,
  onResolve: () => void,
  onMessage: (message: any) => void,
): void {
  if (!viewId) return

  // Compute extension id + local resource roots from options. The
  // sidecar passes options.extensionId and options.extensionPath when
  // available so we can scope resource access correctly.
  const extensionId: string = options?.extensionId || ''
  const extensionPath: string = options?.extensionPath || ''
  const localResourceRoots: string[] = Array.isArray(options?.localResourceRoots)
    ? options.localResourceRoots
    : extensionPath ? [extensionPath] : []

  const inst: WebviewViewInst = {
    viewId,
    options,
    webview: null,
    container: null,
    resolved: false,
    pendingHtml: null,
    pendingMessages: [],
    onResolve,
    onMessage,
    localResourceRoots,
    extensionId,
  }
  _views.set(viewId, inst)

  // Two-phase: if a slot was pre-mounted from package.json contributes.views,
  // attach to it. Otherwise queue and resolve once the slot appears.
  const preMounted = findPreMountedSlot(viewId)
  if (preMounted && preMounted.type === 'webview') {
    markSlotAttached(viewId, (root) => { void buildWebview(inst, root) })
    return
  }
  registerPendingWebviewProvider(viewId)
  setTimeout(() => {
    const slotNow = findPreMountedSlot(viewId)
    if (slotNow && slotNow.type === 'webview') return
    if (_views.get(viewId) !== inst) return
    // No contributed view ever appeared. We DON'T fall back to a
    // legacy custom view here — without a contributes.views entry we
    // can't know which container the extension wanted. Log and wait;
    // most extensions DO declare their views in package.json.
    logToFile(`registerWebviewView: no pre-mounted slot for ${viewId} after grace period`)
  }, 250)
}

type PendingMount = (root: HTMLElement) => void
const _pendingProviders = new Map<string, PendingMount>()

function registerPendingWebviewProvider(viewId: string): void {
  const inst = _views.get(viewId)
  if (!inst) return
  _pendingProviders.set(viewId, (root: HTMLElement) => { void buildWebview(inst, root) })
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

export function disposeWebviewView(viewId: string): void {
  const inst = _views.get(viewId)
  if (!inst) return
  try { inst.webview?.dispose?.() } catch { /* ignore */ }
  if (inst.container) inst.container.innerHTML = ''
  _views.delete(viewId)
}

export function setWebviewViewHtml(viewId: string, html: string): void {
  const inst = _views.get(viewId)
  if (!inst) {
    logToFile(`setWebviewViewHtml: NO inst for ${viewId} (registration race?)`)
    return
  }
  if (!inst.webview) {
    inst.pendingHtml = html
    traceLog(`setWebviewViewHtml: queued for ${viewId} (webview not yet built), len=${html.length}`)
    return
  }
  inst.webview.setHtml(html)
  traceLog(`setWebviewViewHtml: applied to ${viewId}, len=${html.length}`)
}

export function postMessageToWebviewView(viewId: string, message: any): void {
  const inst = _views.get(viewId)
  if (!inst) return
  if (!inst.webview) {
    inst.pendingMessages.push(message)
    return
  }
  try {
    inst.webview.postMessage(message)
  } catch (e) {
    logToFile(`postMessage failed for ${viewId}: ${e}`)
  }
}

export function revealWebviewView(viewId: string): void {
  // The view is mounted by the workbench when its tab is activated;
  // we don't programmatically force-reveal here (caused folder-open
  // hangs in earlier iterations). User clicks the tab. Trace-only —
  // these fire repeatedly while extensions retry reveal calls and
  // overwhelmed OPIDE.log; visible with OPIDE_VERBOSE_VIEWS.
  traceLog(`reveal request for ${viewId} (manual click required)`)
}
