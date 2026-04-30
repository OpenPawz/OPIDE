// OPIDE Extension Tree Views — Phase C.C1
//
// Renders extension-provided tree data (vscode.window.registerTreeDataProvider)
// in a custom sidebar slot in the auxiliary bar. Each registered viewId
// becomes its own panel with a tree of expand/collapse rows that lazy-
// load children from the extension via the bridge.
//
// Communication contract
//   - registerTreeProvider(viewId, fetchChildren, onNodeClick) — bridge
//     passes us callbacks; fetchChildren(parentNodeId, requestId) sends
//     a `tree/getChildren` notification down to the sidecar, the sidecar
//     answers with `tree/childrenResponse` which the bridge routes back
//     into deliverChildren(requestId, items).
//   - refreshTree(viewId): drop cached children + re-fetch root.
//   - disposeTreeProvider(viewId): remove the panel.
//
// View rendering uses Monaco-vscode's registerCustomView (same API our
// chat panel uses), so the extension's tree shows up alongside builtin
// views and the user can drag/dock it like any other.

import {
  registerCustomView,
  ViewContainerLocation,
} from '@codingame/monaco-vscode-workbench-service-override'
import { notifyViewActivated } from './extension-bridge.ts'
import { findPreMountedSlot, markSlotAttached } from './extension-contributed-views.ts'

interface TreeNodeUI {
  nodeId: string
  label: string
  description?: string
  tooltip?: string
  collapsibleState: number
  iconPath?: string
  contextValue?: string
  command?: { command: string; title: string; arguments?: any[] }
  resourceUri?: string
  childrenContainer?: HTMLElement
  fetched?: boolean
}

interface TreeViewInst {
  viewId: string
  container: HTMLElement | null
  rootList: HTMLUListElement
  fetchChildren: (parentNodeId: string | undefined, requestId: string) => void
  onNodeClick: (nodeId: string) => void
  pendingFetches: Map<string, (items: TreeNodeUI[]) => void>
  /** Map nodeId → DOM element so refreshes can locate them. */
  nodes: Map<string, { el: HTMLLIElement; node: TreeNodeUI }>
}

const _trees = new Map<string, TreeViewInst>()
let _nextRequestId = 1

function ensureStyle(): void {
  if (document.getElementById('opide-ext-tree-style')) return
  const style = document.createElement('style')
  style.id = 'opide-ext-tree-style'
  style.textContent = `
    .opide-tree-root { list-style:none; margin:0; padding:4px 0; font-size:12px; font-family: var(--vscode-font-family, system-ui); }
    .opide-tree-list { list-style:none; margin:0; padding:0 0 0 14px; }
    .opide-tree-item { display:flex; align-items:center; gap:4px; padding:2px 8px; cursor:pointer; user-select:none; color: var(--vscode-foreground, #cccccc); }
    .opide-tree-item:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06)); }
    .opide-tree-item .twisty { width:14px; text-align:center; opacity:0.7; flex-shrink:0; }
    .opide-tree-item .label { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .opide-tree-item .desc { color: var(--vscode-descriptionForeground, #9d9d9d); font-size:11px; margin-left:6px; flex-shrink:0; max-width:50%; overflow:hidden; text-overflow:ellipsis; }
    .opide-tree-item .icon { width:16px; height:16px; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; opacity:0.85; }
    .opide-tree-empty { padding:12px 16px; color: var(--vscode-descriptionForeground, #9d9d9d); font-size:12px; }
  `
  document.head.appendChild(style)
}

function makeTwisty(state: number): string {
  // 0 = None, 1 = Collapsed, 2 = Expanded
  return state === 1 ? '▶' : state === 2 ? '▼' : ' '
}

function renderNode(
  inst: TreeViewInst,
  node: TreeNodeUI,
  depth: number,
): HTMLLIElement {
  const li = document.createElement('li')
  const row = document.createElement('div')
  row.className = 'opide-tree-item'
  row.style.paddingLeft = `${4 + depth * 12}px`
  if (node.tooltip) row.title = node.tooltip

  const twisty = document.createElement('span')
  twisty.className = 'twisty'
  twisty.textContent = makeTwisty(node.collapsibleState)
  row.appendChild(twisty)

  const icon = document.createElement('span')
  icon.className = 'icon'
  if (node.iconPath) {
    if (node.iconPath.startsWith('http') || node.iconPath.startsWith('data:') || node.iconPath.includes('/')) {
      const img = document.createElement('img')
      img.src = node.iconPath
      img.style.cssText = 'width:14px;height:14px;'
      icon.appendChild(img)
    } else {
      // Treat as a codicon id (e.g. 'symbol-method')
      icon.innerHTML = `<i class="codicon codicon-${node.iconPath}" style="font-size:14px"></i>`
    }
  }
  row.appendChild(icon)

  const label = document.createElement('span')
  label.className = 'label'
  label.textContent = node.label || '(unnamed)'
  row.appendChild(label)

  if (node.description) {
    const desc = document.createElement('span')
    desc.className = 'desc'
    desc.textContent = node.description
    row.appendChild(desc)
  }

  // Children container, hidden until expanded
  const childList = document.createElement('ul')
  childList.className = 'opide-tree-list'
  childList.style.display = 'none'
  node.childrenContainer = childList

  row.addEventListener('click', () => {
    if (node.collapsibleState !== 0) {
      // Toggle expand/collapse and fetch on first expansion
      const expanded = node.collapsibleState === 2
      node.collapsibleState = expanded ? 1 : 2
      twisty.textContent = makeTwisty(node.collapsibleState)
      childList.style.display = expanded ? 'none' : 'block'
      if (!expanded && !node.fetched) {
        node.fetched = true
        fetchChildrenInto(inst, node.nodeId, childList, depth + 1)
      }
    }
    inst.onNodeClick(node.nodeId)
  })

  li.appendChild(row)
  li.appendChild(childList)
  inst.nodes.set(node.nodeId, { el: li, node })
  return li
}

function fetchChildrenInto(
  inst: TreeViewInst,
  parentNodeId: string | undefined,
  container: HTMLElement,
  depth: number,
): void {
  const requestId = `tr-${_nextRequestId++}`
  inst.pendingFetches.set(requestId, (items) => {
    container.innerHTML = ''
    if (items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'opide-tree-empty'
      empty.textContent = 'No items'
      container.appendChild(empty)
      return
    }
    for (const item of items) {
      const li = renderNode(inst, item, depth)
      container.appendChild(li)
      // Auto-expand items the extension marked as Expanded
      if (item.collapsibleState === 2) {
        item.fetched = true
        ;(item.childrenContainer!).style.display = 'block'
        fetchChildrenInto(inst, item.nodeId, item.childrenContainer!, depth + 1)
      }
    }
  })
  inst.fetchChildren(parentNodeId, requestId)
}

function buildTreePanel(inst: TreeViewInst, root: HTMLElement): void {
  ensureStyle()
  inst.container = root
  inst.rootList.className = 'opide-tree-root'
  root.appendChild(inst.rootList)
  // Initial root fetch
  fetchChildrenInto(inst, undefined, inst.rootList, 0)
}

// ─── Public API ────────────────────────────────────────────────────────

export function registerTreeProvider(
  viewId: string,
  fetchChildren: (parentNodeId: string | undefined, requestId: string) => void,
  onNodeClick: (nodeId: string) => void,
): void {
  if (!viewId) return
  if (_trees.has(viewId)) {
    // Re-registration: dispose old, build new.
    disposeTreeProvider(viewId)
  }
  const inst: TreeViewInst = {
    viewId,
    container: null,
    rootList: document.createElement('ul'),
    fetchChildren,
    onNodeClick,
    pendingFetches: new Map(),
    nodes: new Map(),
  }
  _trees.set(viewId, inst)

  // P0 two-phase model: prefer the slot pre-mounted from package.json
  // contributes.views. If found, attach to it; if not, register a new
  // custom view (the dynamic-only path that some extensions use).
  const preMounted = findPreMountedSlot(viewId)
  if (preMounted && preMounted.type === 'tree') {
    markSlotAttached(viewId, (root) => {
      buildTreePanel(inst, root)
    })
    return
  }

  try {
    registerCustomView({
      id: `opide-ext-tree-${viewId}`,
      name: viewId,
      location: ViewContainerLocation.AuxiliaryBar,
      icon: 'list-tree',
      renderBody: (root: HTMLElement) => {
        // CC1: tell the sidecar a view became visible so onView:<id>
        // extensions activate just-in-time. Cheap fire-and-forget.
        notifyViewActivated(viewId)
        buildTreePanel(inst, root)
        return {
          dispose() {
            inst.container = null
            inst.nodes.clear()
            inst.pendingFetches.clear()
          },
        }
      },
    })
  } catch (e) {
    console.warn(`[ext-tree-views] registerCustomView failed for ${viewId}:`, e)
  }
}

export function disposeTreeProvider(viewId: string): void {
  const inst = _trees.get(viewId)
  if (!inst) return
  if (inst.container) inst.container.innerHTML = ''
  _trees.delete(viewId)
  // Note: we can't unregister a custom view via the API — the panel
  // remains in the layout but is now empty. Users can hide it via
  // right-click. Add proper disposal when @codingame ships unregister.
}

export function refreshTree(viewId: string): void {
  const inst = _trees.get(viewId)
  if (!inst || !inst.rootList) return
  inst.nodes.clear()
  inst.rootList.innerHTML = ''
  fetchChildrenInto(inst, undefined, inst.rootList, 0)
}

export function deliverChildren(requestId: string, items: TreeNodeUI[]): void {
  for (const inst of _trees.values()) {
    const cb = inst.pendingFetches.get(requestId)
    if (cb) {
      inst.pendingFetches.delete(requestId)
      cb(items)
      return
    }
  }
}
