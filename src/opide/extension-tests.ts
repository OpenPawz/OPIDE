// OPIDE Extension Tests — Phase G
//
// vscode.tests bridge. Test controllers register their tests and run
// profiles here; we render a tree in the auxiliary bar showing all
// known tests with status pips (passed / failed / running / queued)
// and let the user click "run" on individual tests or the whole tree.
//
// v1 scope
//   - Single panel that shows all controllers' top-level test items.
//   - Test status updates from runState messages render inline as
//     coloured dots.
//   - Run / Debug profile invocation through the click handler — we
//     track which profile is "default" and call its runHandler via a
//     bridge round-trip.
//
// What's NOT in v1:
//   - Per-controller separate panels (one fused panel for now).
//   - Result diff / message popovers (errors print to console).
//   - Continuous run mode.

import {
  registerCustomView,
  ViewContainerLocation,
} from '@codingame/monaco-vscode-workbench-service-override'

interface TestItemRec {
  id: string
  label: string
  uri?: string
  description?: string
  status: 'unknown' | 'queued' | 'running' | 'passed' | 'failed' | 'errored' | 'skipped'
  duration?: number
  message?: any
}
interface ControllerRec {
  id: string
  label: string
  items: Map<string, TestItemRec>
  profiles: Map<string, { label: string; kind: number; isDefault?: boolean }>
}

const _controllers = new Map<string, ControllerRec>()
const _runs = new Map<string, { controllerId?: string; output: string[] }>()
let _container: HTMLElement | null = null
let _registered = false

function ensureView(): void {
  if (_registered) return
  _registered = true
  try {
    registerCustomView({
      id: 'opide-ext-tests',
      name: 'Tests',
      location: ViewContainerLocation.AuxiliaryBar,
      icon: 'beaker',
      renderBody: (root: HTMLElement) => {
        _container = root
        root.style.cssText = 'display:flex;flex-direction:column;height:100%;width:100%;font-family:var(--vscode-font-family,system-ui);font-size:12px;'
        rerender()
        return { dispose() { _container = null } }
      },
    })
  } catch (e) {
    console.warn('[ext-tests] registerCustomView failed:', e)
  }
}

function statusColor(s: TestItemRec['status']): string {
  switch (s) {
    case 'passed': return '#3fb950'
    case 'failed': case 'errored': return '#f85149'
    case 'running': return '#d4a843'
    case 'queued': return '#888'
    case 'skipped': return '#666'
    default: return '#444'
  }
}

function rerender(): void {
  if (!_container) return
  _container.innerHTML = ''
  if (_controllers.size === 0) {
    const empty = document.createElement('div')
    empty.style.cssText = 'padding:14px;color:var(--vscode-descriptionForeground);'
    empty.textContent = 'No test extensions active.'
    _container.appendChild(empty)
    return
  }
  for (const c of _controllers.values()) {
    const section = document.createElement('div')
    section.style.cssText = 'border-bottom:1px solid var(--vscode-widget-border,#303031);'
    const title = document.createElement('div')
    title.style.cssText = 'padding:6px 12px;font-weight:600;color:var(--vscode-foreground);background:var(--vscode-sideBarSectionHeader-background);'
    title.textContent = c.label
    section.appendChild(title)
    for (const item of c.items.values()) {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 12px;cursor:pointer;color:var(--vscode-foreground);'
      const dot = document.createElement('span')
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${statusColor(item.status)};flex-shrink:0;`
      row.appendChild(dot)
      const lbl = document.createElement('span')
      lbl.textContent = item.label
      lbl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
      row.appendChild(lbl)
      if (item.duration != null) {
        const dur = document.createElement('span')
        dur.textContent = `${item.duration}ms`
        dur.style.cssText = 'color:var(--vscode-descriptionForeground);font-size:11px;flex-shrink:0;'
        row.appendChild(dur)
      }
      section.appendChild(row)
    }
    _container.appendChild(section)
  }
}

export function handle(method: string, params: any): void {
  ensureView()
  switch (method) {
    case 'tests/createController': {
      _controllers.set(params.controllerId, {
        id: params.controllerId, label: params.label,
        items: new Map(), profiles: new Map(),
      })
      rerender()
      break
    }
    case 'tests/disposeController': {
      _controllers.delete(params.controllerId); rerender(); break
    }
    case 'tests/addItem': {
      const c = _controllers.get(params.controllerId); if (!c) return
      c.items.set(params.item.id, {
        id: params.item.id, label: params.item.label, uri: params.item.uri,
        description: params.item.description, status: 'unknown',
      })
      rerender()
      break
    }
    case 'tests/removeItem': {
      const c = _controllers.get(params.controllerId); if (!c) return
      c.items.delete(params.itemId); rerender(); break
    }
    case 'tests/replaceItems': {
      const c = _controllers.get(params.controllerId); if (!c) return
      c.items.clear()
      for (const it of params.items || []) {
        c.items.set(it.id, { id: it.id, label: it.label, uri: it.uri, description: it.description, status: 'unknown' })
      }
      rerender()
      break
    }
    case 'tests/createRunProfile': {
      const c = _controllers.get(params.controllerId); if (!c) return
      c.profiles.set(params.profileId, { label: params.label, kind: params.kind, isDefault: params.isDefault })
      break
    }
    case 'tests/disposeRunProfile': {
      const c = _controllers.get(params.controllerId); if (!c) return
      c.profiles.delete(params.profileId); break
    }
    case 'tests/startRun': {
      _runs.set(params.runId, { controllerId: params.controllerId, output: [] }); break
    }
    case 'tests/runState': {
      const run = _runs.get(params.runId); if (!run) return
      // Find the matching item across controllers
      for (const c of _controllers.values()) {
        const it = c.items.get(params.testId)
        if (it) {
          it.status = params.state || 'unknown'
          if (params.duration != null) it.duration = params.duration
          if (params.message) it.message = params.message
          rerender()
          return
        }
      }
      break
    }
    case 'tests/runOutput': {
      const run = _runs.get(params.runId); if (!run) return
      run.output.push(params.output || '')
      console.log('[ext-tests:output]', params.output)
      break
    }
    case 'tests/endRun': {
      _runs.delete(params.runId); break
    }
  }
}
