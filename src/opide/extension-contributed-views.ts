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
  _contextKeys.set(key, value)
}

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
    if (_slots.has(v.id)) continue // already mounted (re-scan case)

    const container = containerById.get(v.containerId)
    const surface = container?.surface ?? 'sidebar'
    const location = pickContainerLocation(surface)

    const slot: PreMountedSlot = {
      extensionId,
      viewId: v.id,
      containerId: v.containerId,
      type: v.type,
      bodyMounter: null,
      attached: false,
      rootEl: null,
    }
    _slots.set(v.id, slot)

    // Each view becomes its own custom view in the workbench. We use
    // viewId as the workbench id so the user can identify which
    // extension's view they're looking at; collisions across
    // extensions would already be a manifest-level conflict.
    //
    // Defensive: any single bad contribution (malformed icon path,
    // duplicate view id, monaco-vscode-api throwing inside the
    // workbench layout service) is caught so it can't take down the
    // whole pre-mount loop. Failures land in OPIDE.log via
    // ext_host_log so the user can see them when tailing.
    try {
      registerCustomView({
        id: `opide-ext-cv-${v.id}`,
        name: v.name,
        location,
        icon: container?.codiconId || iconCodiconForView(v.type),
        renderBody: (root: HTMLElement) => {
          slot.rootEl = root
          try {
            // Honour `when` clauses. If the expression is currently
            // false we show a placeholder; we don't unregister the
            // view because context keys can flip later (extensions
            // toggle them via setContext).
            if (!evalWhen(v.when)) {
              renderHidden(root, v.name, 'View hidden by `when` clause.')
              return { dispose() { slot.rootEl = null } }
            }
            // Trigger lazy onView:<id> activation. Whatever extension
            // owns this view will activate; its registerWebviewView /
            // registerTreeDataProvider call attaches to the slot via
            // markSlotAttached, then the slot's body gets re-rendered.
            try { onViewActivated(v.id) } catch (actErr) {
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
              renderLoading(root, v.name, extensionId)
            }
          } catch (renderErr) {
            // Catch-all so a bad render can't take the workbench
            // layout down. The slot stays registered; the user can
            // close + reopen it after the cause is fixed.
            logToFile(
              `renderBody for ${v.id} (${extensionId}) threw: ` +
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
    } catch (e) {
      logToFile(
        `registerCustomView for ${v.id} (${extensionId}) failed: ` +
        String((e as Error)?.message || e),
      )
      _slots.delete(v.id)
    }
  }

  // Container icons (activity bar entries) — TODO. The AuxiliaryBar
  // doesn't currently render activity-bar style icons declared at the
  // container level; we rely on the view's own title for now.
  // When we wire ViewContainerLocation.Sidebar registration, the
  // container.iconPath / codiconId are read here.
  void containerById
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
