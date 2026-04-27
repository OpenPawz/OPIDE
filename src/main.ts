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
      showStartupError(`Some IDE features failed to load: ${err}`)
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

// B35: surface deferred-features failures via a small floating banner so the
// user has at least a hint when something silently broke (chat panel, MCP,
// extensions, etc.). Console logs alone aren't visible to most users.
function showStartupError(msg: string): void {
  try {
    const banner = document.createElement('div')
    banner.style.cssText = 'position:fixed;bottom:12px;right:12px;background:#3a1f1f;color:#f88;padding:8px 12px;border-radius:6px;font-size:11px;font-family:monospace;z-index:9999;max-width:380px;box-shadow:0 4px 12px rgba(0,0,0,0.4)'
    banner.textContent = msg
    document.body.appendChild(banner)
    setTimeout(() => banner.remove(), 12_000)
  } catch { /* DOM may not be ready */ }
}

boot()
