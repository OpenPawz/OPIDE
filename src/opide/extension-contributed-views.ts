// OPIDE Extension Contributed Views — P0 of the coding-agent rollout.
//
// Implements VS Code's two-phase contribution model for views declared
// in package.json. Until this existed, sidebar-based extensions
// (Continue, Claude Code, Cline, Cody, GitLens, Test Explorer, …) never
// appeared in OPIDE because:
//
//   - Their activationEvents include `onView:<id>` — fires when the
//     user clicks the view's slot in the activity bar / sidebar
//   - But the slot only exists once the extension calls
//     registerWebviewViewProvider / registerTreeDataProvider
//   - Which only runs after the extension activates
//   - Which only fires when the user clicks the slot
//   - Chicken and egg.
//
// VS Code breaks the cycle by reading `contributes.viewsContainers` and
// `contributes.views` from package.json AT EXTENSION SCAN TIME and
// mounting empty placeholder slots IMMEDIATELY, before any extension
// activates. When the user reveals a slot, VS Code fires `onView:<id>`,
// the extension activates, and the extension's provider attaches to
// the existing slot. Same model implemented here.
//
// Slot lookup hooks
//
//   extension-webview-views.ts and extension-tree-views.ts now check
//   the registry below before creating a fresh custom view. If the
//   slot already exists (because we pre-mounted it from package.json),
//   they attach the iframe / tree to that slot instead of creating a
//   duplicate.

import { invoke } from '@tauri-apps/api/core'
import {
  registerCustomView,
  ViewContainerLocation,
} from '@codingame/monaco-vscode-workbench-service-override'

import type {
  ExtContributedView,
  ExtContributedViewContainer,
} from './extension-bridge.ts'

/** Send a line through ext_host_log so it lands in OPIDE.log next to
 * the install / activation messages. We deliberately don't import the
 * bridge's debugLog because that would create a runtime cycle. */
function logToFile(msg: string): void {
  try {
    invoke('ext_host_log', { message: `[ext-contrib-views] ${msg}` }).catch(() => {})
  } catch { /* never throw in logging */ }
  console.warn(`[ext-contrib-views] ${msg}`)
}
/** High-volume diagnostic logs (per-view renderBody fires, pre-mount
 * announcements). Goes to console only when window.OPIDE_VERBOSE_VIEWS
 * is set — keeps OPIDE.log readable. */
function traceLog(msg: string): void {
  if ((globalThis as any).OPIDE_VERBOSE_VIEWS) {
    console.log(`[ext-contrib-views] ${msg}`)
  }
}

// ─── Public registry ───────────────────────────────────────────────────

/** Each pre-mounted view exposes a `mount(root)` callback the slot's
 * renderBody fires when the user reveals it. The webview / tree-view
 * modules grab this entry by id, replace the mount function, and stuff
 * their iframe / tree DOM into root. */
export interface PreMountedSlot {
  extensionId: string
  viewId: string
  containerId: string
  type: 'tree' | 'webview'
  /** Called when the slot's renderBody fires. The whole slot's lifecycle
   * (DOM root, dispose) is owned here; webview-views / tree-views
   * replace the `bodyMounter` callback when their provider attaches. */
  bodyMounter: ((root: HTMLElement) => void) | null
  /** Set true once a webview/tree provider has attached. Used to decide
   * whether to fall back to "loading…" placeholder content. */
  attached: boolean
  rootEl: HTMLElement | null
}

const _slots = new Map<string, PreMountedSlot>() // viewId → slot
const _registeredExtensions = new Set<string>()

/** Full registration record for every contributed view — including ones
 * currently hidden by a `when` clause. Kept so that when a context key
 * flips at runtime (extension calls setContext during activation) we can
 * mount a view that just became eligible, or tear one down that no longer
 * is. Without this, extensions like Claude Code that pick their sidebar
 * view via `claude-code:doesNotSupportSecondarySidebar` (set AFTER
 * pre-mount runs) never get their real view mounted. */
interface ViewRecord {
  extensionId: string
  view: ExtContributedView
  containerId: string
  location: ViewContainerLocation
  containerCodiconId?: string
  onViewActivated: (viewId: string) => void
  /** The registerCustomView disposable while this view is mounted; null
   * when the view is unmounted (its `when` clause is currently false). */
  disposable: { dispose(): void } | null
}
const _viewRecords = new Map<string, ViewRecord>() // viewId → record

/** Used by extension-webview-views and extension-tree-views when a
 * provider is registered dynamically. They look up the slot here; if
 * found they attach to it and skip creating a fresh registerCustomView. */
export function findPreMountedSlot(viewId: string): PreMountedSlot | undefined {
  return _slots.get(viewId)
}

/** Mark a slot as attached so the empty-state placeholder gets cleared. */
export function markSlotAttached(viewId: string, mounter: (root: HTMLElement) => void): void {
  const slot = _slots.get(viewId)
  if (!slot) return
  slot.bodyMounter = mounter
  slot.attached = true
  // If the slot was already revealed before the provider attached,
  // remount its body so the user sees the real content immediately.
  if (slot.rootEl) {
    slot.rootEl.innerHTML = ''
    try { mounter(slot.rootEl) } catch (e) {
      console.warn(`[ext-contributed-views] mount ${viewId} failed:`, e)
    }
  }
}

// ─── Context-key surface (for `when` clauses) ──────────────────────────
//
// VS Code views support `when` clauses like
// "claude-code:doesNotSupportSecondarySidebar". We can't fully evaluate
// VS Code's expression syntax (a && b || !c) without pulling in their
// parser, but for v1 we handle the common cases:
//   - bare key                             →  truthy
//   - "!key"                               →  falsy
//   - "a && b" / "a || b"                  →  conjunction / disjunction
// The rest defaults to true (show the view) so we don't silently hide
// extensions whose `when` is too complex.

const _contextKeys = new Map<string, any>()

export function setContextKey(key: string, value: any): void {
  const prev = _contextKeys.get(key)
  _contextKeys.set(key, value)
  // Re-evaluate contributed views whose `when` clause may now flip.
  // Only when the value actually changed — extensions spam setContext
  // with unchanged values and we don't want to thrash the workbench.
  // `truthy` only cares about truthiness, so compare on that.
  if (!!prev !== !!value || !_contextKeysSeen.has(key)) {
    _contextKeysSeen.add(key)
    try { reevaluateViews() } catch (e) {
      logToFile(`reevaluateViews after setContext("${key}") threw: ${String((e as Error)?.message || e)}`)
    }
  }
}
/** Keys we've already evaluated at least once — so the very first
 * setContext for a key (prev === undefined) still triggers a pass. */
const _contextKeysSeen = new Set<string>()

function evalWhen(expr: string | undefined): boolean {
  if (!expr) return true
  const e = expr.trim()
  if (!e) return true
  // Top-level && (left to right, no precedence pretending)
  if (e.includes('&&')) return e.split('&&').every((p) => evalWhen(p))
  if (e.includes('||')) return e.split('||').some((p) => evalWhen(p))
  if (e.startsWith('!')) return !truthy(e.slice(1).trim())
  return truthy(e)
}
function truthy(key: string): boolean {
  if (!_contextKeys.has(key)) return false
  const v = _contextKeys.get(key)
  return !!v
}

// ─── Activity-bar surface ──────────────────────────────────────────────
//
// monaco-vscode-api's registerCustomView mounts a panel inside an
// existing view container. Adding a NEW activity-bar container (with
// its own clickable icon) requires the service-override IViewsService
// which isn't always exposed publicly. For P0 we fall back to the
// AuxiliaryBar (right side, where chat lives) for activity-bar
// declarations. The view appears, just not in the visually-correct
// slot — UX cosmetic, not a functional gap.
//
// When monaco-vscode-api gets the container API exposed (or we patch
// it), this function is the one place we change to put the icons in
// the actual activity bar.

function pickContainerLocation(surface: string): ViewContainerLocation {
  switch (surface) {
    case 'panel': return ViewContainerLocation.Panel
    case 'secondarySidebar': return ViewContainerLocation.AuxiliaryBar
    case 'activitybar':
    default:
      // TODO: ViewContainerLocation.Sidebar once we wire icon
      // registration into the activity bar. AuxiliaryBar for now so
      // the view shows up at all.
      return ViewContainerLocation.AuxiliaryBar
  }
}

// ─── Public API: bridge calls this on extensionHost/ready ──────────────

/** Pre-register every contributed view + container for an extension.
 * Called once per extension at ready time. Idempotent — if the
 * extension is re-scanned (after install/uninstall) we skip slots
 * we already mounted to avoid duplicate panels. */
export function registerExtensionContributions(
  extensionId: string,
  containers: ExtContributedViewContainer[],
  views: ExtContributedView[],
  onViewActivated: (viewId: string) => void,
): void {
  if (_registeredExtensions.has(extensionId)) return
  _registeredExtensions.add(extensionId)

  try { injectStyle() } catch (e) {
    logToFile(`injectStyle failed: ${String((e as Error)?.message || e)}`)
  }
  // Keep this at file-log level — it's the single signal that
  // contributed views from a given extension were processed. Without
  // it we can't tell whether a missing-tab is "pre-mount didn't run"
  // vs "pre-mount ran, attach failed". Fires once per extension.
  logToFile(
    `pre-mounting for ${extensionId}: ${containers.length} container(s), ${views.length} view(s)`,
  )

  // Build a quick lookup so each view knows which surface its
  // container lives on. Built-in containers (explorer, scm, debug,
  // test) come from VS Code itself — extensions like GitLens add
  // views to those without declaring a viewContainer of their own.
  // For built-ins we treat the surface as 'sidebar' which today
  // means "auxiliary bar" until activity-bar registration lands.
  const containerById = new Map<string, ExtContributedViewContainer>()
  for (const c of containers) containerById.set(c.id, c)

  for (const v of views) {
    if (_viewRecords.has(v.id)) continue // already processed (re-scan case)

    const container = containerById.get(v.containerId)
    const surface = container?.surface ?? 'sidebar'
    const location = pickContainerLocation(surface)

    const record: ViewRecord = {
      extensionId,
      view: v,
      containerId: v.containerId,
      location,
      containerCodiconId: container?.codiconId,
      onViewActivated,
      disposable: null,
    }
    _viewRecords.set(v.id, record)

    // Honour `when` clauses at pre-mount. A view whose `when` is
    // currently false stays in _viewRecords but isn't mounted yet —
    // reevaluateViews() mounts it later if a setContext flips the key.
    // This prevents the empty duplicate "Claude Code" tab while still
    // mounting the right view once the extension picks its sidebar.
    if (v.when && !evalWhen(v.when)) {
      logToFile(`pre-mount defer ${v.id}: when="${v.when}" evaluates false (will mount if it flips)`)
      continue
    }
    mountViewSlot(record)
  }

  // Container icons (activity bar entries) — TODO. The AuxiliaryBar
  // doesn't currently render activity-bar style icons declared at the
  // container level; we rely on the view's own title for now.
  // When we wire ViewContainerLocation.Sidebar registration, the
  // container.iconPath / codiconId are read here.
  void containerById
}

/** Register a slot + custom view for one contributed view. Idempotent:
 * if a slot already exists for the view we leave it alone. Captures the
 * registerCustomView disposable on the record so reevaluateViews() can
 * tear it down if the view's `when` clause later goes false. */
function mountViewSlot(record: ViewRecord): void {
  const v = record.view
  if (_slots.has(v.id)) return // already mounted

  const slot: PreMountedSlot = {
    extensionId: record.extensionId,
    viewId: v.id,
    containerId: record.containerId,
    type: v.type,
    bodyMounter: null,
    attached: false,
    rootEl: null,
  }
  _slots.set(v.id, slot)

  // Race resolution: if the extension activated BEFORE this slot was
  // mounted and already registered a webview-view provider, that
  // registration is sitting in extension-webview-views' pending queue.
  // Drain it now so the slot mounts the real iframe instead of a
  // placeholder. This is also the path that attaches Claude Code's
  // primary view when its `when` key flips after activation.
  if (v.type === 'webview') {
    const viewIdCapture = v.id
    void import('./extension-webview-views.ts')
      .then((m) => m.drainPendingForSlot?.(viewIdCapture))
      .catch((e) => {
        logToFile(`drainPendingForSlot import failed: ${String((e as Error)?.message || e)}`)
      })
  }
  // Tree views currently don't have a pending queue (the race window
  // doesn't manifest the same way for them).

  // Each view becomes its own custom view in the workbench. Defensive:
  // any single bad contribution is caught so it can't take down the
  // whole pre-mount loop. Failures land in OPIDE.log via ext_host_log.
  try {
    const disposable = registerCustomView({
      id: `opide-ext-cv-${v.id}`,
      name: v.name,
      location: record.location,
      icon: record.containerCodiconId || iconCodiconForView(v.type),
      renderBody: (root: HTMLElement) => {
        traceLog(`renderBody fired for ${v.id} (ext=${record.extensionId}), bodyMounter=${slot.bodyMounter ? 'set' : 'null'}, when=${v.when ?? 'none'}`)
        slot.rootEl = root
        try {
          // Honour `when` clauses. If currently false we show a
          // placeholder; reevaluateViews() will unmount the slot
          // entirely when the key flips, so this is a transient state.
          const whenOk = evalWhen(v.when)
          traceLog(`renderBody ${v.id} when="${v.when ?? ''}" → ${whenOk}`)
          if (!whenOk) {
            renderHidden(root, v.name, 'View hidden by `when` clause.')
            return { dispose() { slot.rootEl = null } }
          }
          // Trigger lazy onView:<id> activation. Whatever extension
          // owns this view will activate; its registerWebviewView /
          // registerTreeDataProvider call attaches to the slot via
          // markSlotAttached, then the slot's body gets re-rendered.
          try { record.onViewActivated(v.id) } catch (actErr) {
            logToFile(`onViewActivated(${v.id}) threw: ${String((actErr as Error)?.message || actErr)}`)
          }
          if (slot.bodyMounter) {
            try { slot.bodyMounter(root) } catch (e) {
              renderError(root, v.name, String((e as Error)?.message || e))
            }
          } else {
            // Show a small "loading" affordance until activation
            // completes. Most extensions take 50-300ms to wire up
            // their provider; if it never attaches we leave the
            // affordance — better than a blank panel.
            renderLoading(root, v.name, record.extensionId)
          }
        } catch (renderErr) {
          logToFile(
            `renderBody for ${v.id} (${record.extensionId}) threw: ` +
            String((renderErr as Error)?.message || renderErr),
          )
          try { renderError(root, v.name, String((renderErr as Error)?.message || renderErr)) } catch { /* ignore */ }
        }
        return {
          dispose() {
            slot.rootEl = null
          },
        }
      },
    })
    record.disposable = (disposable as { dispose(): void }) ?? null
  } catch (e) {
    logToFile(
      `registerCustomView for ${v.id} (${record.extensionId}) failed: ` +
      String((e as Error)?.message || e),
    )
    _slots.delete(v.id)
  }
}

/** Tear down a view's workbench slot (its tab + panel) when its `when`
 * clause goes false. We dispose the registerCustomView registration so
 * the dead tab disappears instead of lingering as a "hidden by `when`"
 * placeholder. The ViewRecord stays so it can be re-mounted if the key
 * flips back. */
function unmountViewSlot(record: ViewRecord): void {
  const viewId = record.view.id
  try { record.disposable?.dispose() } catch (e) {
    logToFile(`unmount ${viewId}: dispose threw ${String((e as Error)?.message || e)}`)
  }
  record.disposable = null
  const slot = _slots.get(viewId)
  if (slot?.rootEl) { try { slot.rootEl.innerHTML = '' } catch { /* ignore */ } }
  _slots.delete(viewId)
}

/** Re-evaluate every contributed view's `when` clause after a context
 * key changes. Mounts views that just became eligible (and drains any
 * webview provider waiting in the pending queue), and unmounts views
 * that are no longer eligible. This is what fixes extensions like Claude
 * Code that call setContext('claude-code:doesNotSupportSecondarySidebar')
 * DURING activation — i.e. after our pre-mount already ran. */
function reevaluateViews(): void {
  for (const record of _viewRecords.values()) {
    const v = record.view
    if (!v.when) continue // unconditional views never change eligibility
    const whenOk = evalWhen(v.when)
    const mounted = _slots.has(v.id)
    if (whenOk && !mounted) {
      logToFile(`reevaluate: mounting ${v.id} (when="${v.when}" now true)`)
      mountViewSlot(record)
    } else if (!whenOk && mounted) {
      logToFile(`reevaluate: unmounting ${v.id} (when="${v.when}" now false)`)
      unmountViewSlot(record)
    }
  }
}

// ─── Slot body helpers ─────────────────────────────────────────────────

function injectStyle(): void {
  if (document.getElementById('opide-ext-cv-style')) return
  const style = document.createElement('style')
  style.id = 'opide-ext-cv-style'
  style.textContent = `
    .opide-ext-cv-pad {
      padding: 14px 16px; font-family: var(--vscode-font-family, system-ui);
      font-size: 12px; color: var(--vscode-descriptionForeground, #9d9d9d);
      line-height: 1.5;
    }
    .opide-ext-cv-pad h4 {
      color: var(--vscode-foreground, #cccccc); margin: 0 0 6px 0;
      font-size: 13px; font-weight: 600;
    }
    .opide-ext-cv-pad code {
      background: rgba(255,255,255,0.05); padding: 1px 5px; border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .opide-ext-cv-spinner {
      display: inline-block; width: 10px; height: 10px; border: 2px solid #444;
      border-top-color: var(--vscode-progressBar-background, #0e639c);
      border-radius: 50%; animation: opide-ext-cv-spin 0.9s linear infinite;
      margin-right: 6px; vertical-align: -1px;
    }
    @keyframes opide-ext-cv-spin { to { transform: rotate(360deg) } }
  `
  document.head.appendChild(style)
}

function renderLoading(root: HTMLElement, viewName: string, extensionId: string): void {
  root.innerHTML = ''
  const card = document.createElement('div')
  card.className = 'opide-ext-cv-pad'
  card.innerHTML = `<h4><span class="opide-ext-cv-spinner"></span>${escapeHtml(viewName)}</h4>` +
    `<div>Activating <code>${escapeHtml(extensionId)}</code>…</div>`
  root.appendChild(card)
}

function renderHidden(root: HTMLElement, viewName: string, reason: string): void {
  root.innerHTML = ''
  const card = document.createElement('div')
  card.className = 'opide-ext-cv-pad'
  card.innerHTML = `<h4>${escapeHtml(viewName)}</h4><div>${escapeHtml(reason)}</div>`
  root.appendChild(card)
}

function renderError(root: HTMLElement, viewName: string, message: string): void {
  root.innerHTML = ''
  const card = document.createElement('div')
  card.className = 'opide-ext-cv-pad'
  card.innerHTML = `<h4>${escapeHtml(viewName)}</h4>` +
    `<div style="color: var(--vscode-errorForeground, #f48771);">${escapeHtml(message)}</div>`
  root.appendChild(card)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!))
}

function iconCodiconForView(type: 'tree' | 'webview'): string {
  return type === 'webview' ? 'browser' : 'list-tree'
}
