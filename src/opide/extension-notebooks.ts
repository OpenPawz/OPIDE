// OPIDE Extension Notebooks — Phase H
//
// vscode.notebooks bridge. Notebook controllers (kernels) and
// serializers register here; cell execution events are tracked but
// the notebook editor UI itself comes from
// monaco-vscode-notebook-service-override.
//
// v1 scope (intentionally minimal)
//   - Track registered controllers + serializers in memory.
//   - When a controller's executeHandler fires (as a result of the
//     user clicking "run" in a notebook cell), the cellExec lifecycle
//     events render to console for debugging. Surfacing them in the
//     actual notebook output requires deeper monaco-vscode-notebook
//     integration which is the bulk of Phase H v2.
//   - The big-ticket goal here was to make Jupyter, Polyglot Notebooks
//     and similar packages INSTALL without crashing. Full execution
//     output rendering is a v2.
//
// What's NOT in v1
//   - Notebook output renderer plumbing (custom MIME renderers).
//   - Cell metadata / execution-summary updates that need the
//     workbench notebook model.
//   - Document open/close hooks for serializers.

interface ControllerRec {
  id: string
  viewType: string
  label: string
  supportedLanguages?: string[]
}
const _controllers = new Map<string, ControllerRec>()
const _serializers = new Map<string, true>()
const _execOutputs = new Map<string, any[]>()

export function handle(method: string, params: any): void {
  switch (method) {
    case 'notebooks/createController': {
      _controllers.set(params.id, { id: params.id, viewType: params.viewType, label: params.label })
      break
    }
    case 'notebooks/disposeController': {
      _controllers.delete(params.id); break
    }
    case 'notebooks/updateController': {
      const c = _controllers.get(params.id); if (!c) return
      if (params.supportedLanguages) c.supportedLanguages = params.supportedLanguages
      break
    }
    case 'notebooks/registerSerializer': {
      _serializers.set(params.notebookType, true); break
    }
    case 'notebooks/cellExecStart': {
      const key = `${params.id}:${params.cellIndex}`
      _execOutputs.set(key, [])
      console.log('[ext-notebooks] exec start', key)
      break
    }
    case 'notebooks/cellExecEnd': {
      const key = `${params.id}:${params.cellIndex}`
      const outputs = _execOutputs.get(key) || []
      console.log(`[ext-notebooks] exec end ${key} success=${params.success} outputs=${outputs.length}`)
      _execOutputs.delete(key)
      break
    }
    case 'notebooks/cellClearOutput': {
      const key = `${params.id}:${params.cellIndex}`
      _execOutputs.set(key, [])
      break
    }
    case 'notebooks/cellReplaceOutput':
    case 'notebooks/cellAppendOutput': {
      const key = `${params.id}:${params.cellIndex}`
      const arr = _execOutputs.get(key) || []
      if (method.endsWith('replaceOutput')) arr.length = 0
      arr.push(params.output)
      _execOutputs.set(key, arr)
      break
    }
  }
}
