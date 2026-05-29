// OPIDE Extension SCM — Phase F
//
// vscode.scm bridge. Each extension-created SourceControl mounts as
// a custom SCM panel; resource groups and resource states render as
// file lists with decoration (modified/added/deleted/etc).
//
// v1 scope
//   - Track sourceControls + groups + resources in memory.
//   - Mount a single auxiliary-bar panel that shows the sum of all
//     extension-registered SCMs. When the user has no extension SCMs
//     active, the panel hides itself.
//   - Status-bar commands and counts are stored but rendering them in
//     the actual status bar is v2 work (needs the workbench's
//     statusbar service hookup).
//
// Strategy note
//   We're not replacing OPIDE's built-in git source control (powered
//   by git.rs). Extension SCMs (GitLens, GitGraph) augment it; this
//   bridge exists so they can paint their own UIs alongside it.

import {
  registerCustomView,
  ViewContainerLocation,
} from '@codingame/monaco-vscode-workbench-service-override'
import { executeExtensionCommand, notifyHost } from './extension-bridge.ts'

interface ResourceState {
  resourceUri?: string
  decorations?: any
  contextValue?: string
  command?: any
}
interface InputBoxState { value: string; placeholder: string; enabled: boolean; visible: boolean }
interface GroupRec { id: string; label: string; resources: ResourceState[]; hideWhenEmpty?: boolean }
interface ScmRec {
  id: string; label: string; rootUri?: string;
  groups: Map<string, GroupRec>; count: number;
  inputBox: InputBoxState;
  /** vscode Command run on commit (acceptInputCommand), if the extension set one. */
  acceptCommand?: { command: string; title?: string; arguments?: any[] }
}

const _scms = new Map<string, ScmRec>()
let _container: HTMLElement | null = null
let _registered = false

function ensureView(): void {
  if (_registered) return
  _registered = true
  try {
    registerCustomView({
      id: 'opide-ext-scm',
      name: 'Extension SCM',
      location: ViewContainerLocation.AuxiliaryBar,
      icon: 'git-merge',
      renderBody: (root: HTMLElement) => {
        _container = root
        root.style.cssText = 'display:flex;flex-direction:column;height:100%;width:100%;font-family:var(--vscode-font-family,system-ui);font-size:12px;'
        rerender()
        return { dispose() { _container = null } }
      },
    })
  } catch (e) {
    console.warn('[ext-scm] registerCustomView failed:', e)
  }
}

function rerender(): void {
  if (!_container) return
  // Preserve focus + caret across the full rebuild so a rerender (e.g. a
  // resource-state refresh from GitLens) doesn't interrupt the user typing
  // a commit message.
  const active = document.activeElement as HTMLTextAreaElement | null
  const focusedScmId = active?.dataset?.scmInput
  const selStart = active?.selectionStart ?? null
  const selEnd = active?.selectionEnd ?? null

  _container.innerHTML = ''
  if (_scms.size === 0) {
    const empty = document.createElement('div')
    empty.style.cssText = 'padding:14px;color:var(--vscode-descriptionForeground);'
    empty.textContent = 'No extension source-control providers active.'
    _container.appendChild(empty)
    return
  }
  for (const sc of _scms.values()) {
    const section = document.createElement('div')
    section.style.cssText = 'border-bottom:1px solid var(--vscode-widget-border,#303031);padding:8px 0;'
    const title = document.createElement('div')
    title.style.cssText = 'padding:4px 12px;font-weight:600;color:var(--vscode-foreground);'
    title.textContent = `${sc.label}${sc.count ? ` (${sc.count})` : ''}`
    section.appendChild(title)

    // Commit-message input box (when the extension made it visible).
    if (sc.inputBox.visible) {
      const inputWrap = document.createElement('div')
      inputWrap.style.cssText = 'padding:4px 12px 8px 12px;display:flex;flex-direction:column;gap:6px;'
      const ta = document.createElement('textarea')
      ta.dataset.scmInput = sc.id
      ta.value = sc.inputBox.value
      ta.placeholder = sc.inputBox.placeholder || 'Message (press Cmd/Ctrl+Enter to commit)'
      ta.rows = 1
      ta.disabled = !sc.inputBox.enabled
      ta.style.cssText = 'resize:vertical;min-height:26px;padding:5px 8px;font-family:var(--vscode-font-family,system-ui);font-size:12px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-widget-border,#3c3c3c));border-radius:3px;outline:none;'
      ta.addEventListener('input', () => {
        sc.inputBox.value = ta.value
        notifyHost('scm/inputBoxChanged', { id: sc.id, value: ta.value })
      })
      ta.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault()
          runAccept(sc)
        }
      })
      inputWrap.appendChild(ta)

      const commitBtn = document.createElement('button')
      commitBtn.textContent = sc.acceptCommand?.title || 'Commit'
      commitBtn.disabled = !sc.acceptCommand
      commitBtn.title = sc.acceptCommand ? '' : 'No commit action registered by the extension'
      commitBtn.style.cssText = 'align-self:flex-start;padding:4px 14px;font-size:12px;border:none;border-radius:3px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);opacity:' + (sc.acceptCommand ? '1' : '0.5')
      commitBtn.addEventListener('click', () => runAccept(sc))
      inputWrap.appendChild(commitBtn)
      section.appendChild(inputWrap)
    }

    for (const g of sc.groups.values()) {
      // hideWhenEmpty groups vanish when they have no resources (VS Code
      // behaviour); otherwise an empty group still shows.
      if (g.hideWhenEmpty && g.resources.length === 0) continue
      const groupEl = document.createElement('div')
      groupEl.style.cssText = 'padding:2px 12px 6px 12px;'
      const gh = document.createElement('div')
      gh.style.cssText = 'display:flex;align-items:center;gap:6px;color:var(--vscode-descriptionForeground);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;padding:4px 0;'
      const ghLabel = document.createElement('span')
      ghLabel.textContent = g.label
      gh.appendChild(ghLabel)
      // Per-group resource count badge (VS Code shows one on each group).
      if (g.resources.length > 0) {
        const badge = document.createElement('span')
        badge.textContent = String(g.resources.length)
        badge.style.cssText = 'min-width:16px;text-align:center;padding:0 5px;border-radius:9px;font-size:10px;line-height:15px;background:var(--vscode-badge-background,#4d4d4d);color:var(--vscode-badge-foreground,#fff);'
        gh.appendChild(badge)
      }
      groupEl.appendChild(gh)
      for (const r of g.resources) {
        const row = document.createElement('div')
        row.style.cssText = 'padding:2px 0 2px 8px;cursor:pointer;color:var(--vscode-foreground);'
        const name = (r.resourceUri || '').split('/').pop() || r.resourceUri || ''
        row.textContent = name
        if (r.decorations?.tooltip) row.title = r.decorations.tooltip
        groupEl.appendChild(row)
      }
      section.appendChild(groupEl)
    }
    _container.appendChild(section)
  }

  // Restore focus + caret to the commit box the user was editing.
  if (focusedScmId) {
    const ta = _container.querySelector(`textarea[data-scm-input="${focusedScmId}"]`) as HTMLTextAreaElement | null
    if (ta) {
      ta.focus()
      if (selStart != null && selEnd != null) {
        try { ta.setSelectionRange(selStart, selEnd) } catch { /* ignore */ }
      }
    }
  }
}

/** Run a source control's acceptInputCommand (commit). No-op if the
 * extension never registered one. */
function runAccept(sc: ScmRec): void {
  const cmd = sc.acceptCommand
  if (!cmd?.command) return
  executeExtensionCommand(cmd.command, ...(cmd.arguments || [])).catch((e) =>
    console.warn('[ext-scm] acceptInputCommand failed:', e),
  )
}

export function handle(method: string, params: any): void {
  ensureView()
  switch (method) {
    case 'scm/createSourceControl': {
      _scms.set(params.id, {
        id: params.id, label: params.label, rootUri: params.rootUri,
        groups: new Map(), count: 0,
        inputBox: { value: '', placeholder: '', enabled: true, visible: true },
      })
      rerender()
      break
    }
    case 'scm/setInputBox': {
      const sc = _scms.get(params.id); if (!sc) return
      // Echoed extension-side change (placeholder, programmatic value set,
      // clear-after-commit, etc). User keystrokes don't come back here.
      if (typeof params.value === 'string') sc.inputBox.value = params.value
      if (typeof params.placeholder === 'string') sc.inputBox.placeholder = params.placeholder
      if (typeof params.enabled === 'boolean') sc.inputBox.enabled = params.enabled
      if (typeof params.visible === 'boolean') sc.inputBox.visible = params.visible
      rerender()
      break
    }
    case 'scm/setAcceptCommand': {
      const sc = _scms.get(params.id); if (!sc) return
      sc.acceptCommand = params.command || undefined
      rerender()
      break
    }
    case 'scm/createGroup': {
      const sc = _scms.get(params.id); if (!sc) return
      sc.groups.set(params.groupKey, { id: params.groupId, label: params.groupLabel, resources: [], hideWhenEmpty: false })
      rerender()
      break
    }
    case 'scm/setGroupHideWhenEmpty': {
      for (const sc of _scms.values()) {
        const g = sc.groups.get(params.groupKey)
        if (g) { g.hideWhenEmpty = !!params.hideWhenEmpty; rerender(); return }
      }
      break
    }
    case 'scm/setResourceStates': {
      // Find the group across all source controls
      for (const sc of _scms.values()) {
        const g = sc.groups.get(params.groupKey)
        if (g) { g.resources = params.resources || []; rerender(); return }
      }
      break
    }
    case 'scm/setCount': {
      const sc = _scms.get(params.id); if (!sc) return
      sc.count = params.count || 0
      rerender()
      break
    }
    case 'scm/setStatusBar': {
      // v2: paint into actual status bar
      break
    }
    case 'scm/disposeGroup': {
      for (const sc of _scms.values()) {
        if (sc.groups.delete(params.groupKey)) { rerender(); return }
      }
      break
    }
    case 'scm/disposeSourceControl': {
      _scms.delete(params.id)
      rerender()
      break
    }
  }
}
