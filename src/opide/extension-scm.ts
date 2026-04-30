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

interface ResourceState {
  resourceUri?: string
  decorations?: any
  contextValue?: string
  command?: any
}
interface GroupRec { id: string; label: string; resources: ResourceState[] }
interface ScmRec { id: string; label: string; rootUri?: string; groups: Map<string, GroupRec>; count: number }

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
    for (const g of sc.groups.values()) {
      const groupEl = document.createElement('div')
      groupEl.style.cssText = 'padding:2px 12px 6px 12px;'
      const gh = document.createElement('div')
      gh.style.cssText = 'color:var(--vscode-descriptionForeground);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;padding:4px 0;'
      gh.textContent = g.label
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
}

export function handle(method: string, params: any): void {
  ensureView()
  switch (method) {
    case 'scm/createSourceControl': {
      _scms.set(params.id, {
        id: params.id, label: params.label, rootUri: params.rootUri,
        groups: new Map(), count: 0,
      })
      rerender()
      break
    }
    case 'scm/createGroup': {
      const sc = _scms.get(params.id); if (!sc) return
      sc.groups.set(params.groupKey, { id: params.groupId, label: params.groupLabel, resources: [] })
      rerender()
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
