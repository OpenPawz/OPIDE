import './global.css'
import { initializeWorkbench, initializeDeferredFeatures } from './workbench.ts'

async function boot() {
  try {
    // Phase 1: Core workbench — must complete before showing UI
    await initializeWorkbench()

    // Hide the loading screen IMMEDIATELY after workbench shell is ready
    const loading = document.getElementById('workbench-loading')
    if (loading) {
      loading.classList.add('hidden')
      setTimeout(() => loading.remove(), 400)
    }

    // Phase 2: AI features, extensions, MCP, indexing — runs AFTER UI is visible
    // User sees the IDE immediately. Activity feed shows progress of deferred features.
    initializeDeferredFeatures().catch(err => {
      console.warn('[OPIDE] Deferred features failed:', err)
    })
  } catch (err) {
    console.error('[OPIDE] Workbench initialization failed:', err)
    const loading = document.getElementById('workbench-loading')
    if (loading) {
      loading.innerHTML = `
        <div style="text-align:center;color:#f88;font-family:monospace;padding:24px">
          <div style="font-size:18px;margin-bottom:8px">Workbench failed to start</div>
          <div style="font-size:12px;opacity:0.7">${String(err)}</div>
        </div>
      `
    }
  }
}

boot()
