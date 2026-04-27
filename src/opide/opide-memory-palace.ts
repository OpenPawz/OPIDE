// ── OPIDE Memory Palace Viewport ─────────────────────────────────────────────
// Brings the OpenPawz Memory Palace into OPIDE's VS Code workbench.
// Uses the EditorPane pattern: sidebar entry → opens center tab.
//
// Pattern:
//   1. Import CSS from @openpawz/styles
//   2. Register EditorPane (center tab) with HTML scaffold
//   3. Dynamic import loadMemoryPalace() on activation
//   4. Sidebar entry with activity bar icon

// Vite alias (order matters: reset → tokens → view CSS)
import '@openpawz/styles/_reset.css'
import '@openpawz/styles/_tokens.css'
import '@openpawz/styles/_memory-palace.css'
import '@openpawz/styles/_memory.css'

import {
  registerEditorPane,
  SimpleEditorPane,
  SimpleEditorInput,
} from '@codingame/monaco-vscode-workbench-service-override'

// Override OpenPawz tokens with OPIDE theme
const OPIDE_THEME_OVERRIDES = `
  :root {
    --bg-primary: #1e1e1e;
    --bg-secondary: #252526;
    --bg-sidebar: #161616;
    --bg-hover: rgba(255,255,255,0.04);
    --border: #333;
    --border-focus: #E8B931;
    --accent: #E8B931;
    --accent-lighter: #F0CC50;
    --brand: #E8B931;
    --accent-strong: rgba(232, 185, 49, 0.55);
    --accent-muted: rgba(232, 185, 49, 0.18);
    --text-primary: #cccccc;
    --text-secondary: #999999;
    --text-muted: #666666;
    --font-primary: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
    --font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
    --success: #4CAF50;
    --danger: #ff6b6b;
    --radius-sm: 6px;
    --radius-xs: 4px;
    --transition-fast: 0.15s ease;
  }
`
// IDisposable is used by VS Code's EditorPane but not directly exported from the main module.
// We define a minimal interface here to avoid the import resolution issue.
interface IDisposable { dispose(): void }

// ─── HTML Scaffold ───────────────────────────────────────────────────────────
// Extracted from OpenPawz/index.html — the DOM elements the Memory Palace expects.

const PALACE_HTML = `
<div class="view palace-view active" id="memory-view">
  <div class="palace-install-banner" id="palace-install-banner" style="display: none">
    <div class="palace-install-card">
      <div class="palace-install-icon">
        <span class="ms" style="font-size: 48px">lightbulb</span>
      </div>
      <h2 class="palace-install-title">Enable Long-Term Memory</h2>
      <p class="palace-install-desc">
        Give your agent persistent vector memory with auto-capture and semantic recall.
        Works with OpenAI, Azure OpenAI, or any compatible endpoint — just add your API key.
      </p>
      <div class="palace-api-config" id="palace-api-config">
        <label class="palace-api-label" for="palace-provider">
          Provider <span class="palace-api-required">*</span>
        </label>
        <select class="palace-api-input palace-api-select" id="palace-provider">
          <option value="openai">OpenAI</option>
          <option value="azure">Azure OpenAI</option>
        </select>
        <label class="palace-api-label" for="palace-api-key">
          API Key <span class="palace-api-required">*</span>
        </label>
        <input class="palace-api-input" id="palace-api-key" type="password" placeholder="sk-..." autocomplete="off" spellcheck="false" />
        <div id="palace-azure-fields" style="display: none">
          <label class="palace-api-label" for="palace-base-url">
            Azure Endpoint <span class="palace-api-required">*</span>
          </label>
          <input class="palace-api-input" id="palace-base-url" type="text" placeholder="https://your-resource.openai.azure.com" autocomplete="off" spellcheck="false" />
          <p class="palace-api-hint" style="font-size: 11px; margin: -6px 0 8px 0; opacity: 0.6">
            Your Azure resource endpoint (e.g. https://myresource.openai.azure.com).
          </p>
        </div>
        <div id="palace-openai-endpoint-field">
          <label class="palace-api-label" for="palace-base-url-openai">
            Custom Endpoint <span class="palace-api-hint">(optional — leave blank for api.openai.com)</span>
          </label>
          <input class="palace-api-input" id="palace-base-url-openai" type="text" placeholder="https://api.openai.com" autocomplete="off" spellcheck="false" />
        </div>
        <label class="palace-api-label" for="palace-model-name" id="palace-model-label">
          Model <span class="palace-api-hint">(defaults to text-embedding-3-small)</span>
        </label>
        <input class="palace-api-input" id="palace-model-name" type="text" placeholder="text-embedding-3-small" autocomplete="off" spellcheck="false" />
        <div id="palace-api-version-field" style="display: none">
          <label class="palace-api-label" for="palace-api-version">
            API Version <span class="palace-api-hint">(defaults to 2024-08-01-preview)</span>
          </label>
          <input class="palace-api-input" id="palace-api-version" type="text" placeholder="2024-08-01-preview" autocomplete="off" spellcheck="false" />
        </div>
      </div>
      <div class="palace-install-progress" id="palace-install-progress" style="display: none">
        <p class="progress-text" id="palace-progress-text">Saving configuration…</p>
      </div>
      <div class="palace-install-actions">
        <div class="palace-btn-row">
          <button class="btn btn-outline" id="palace-test-btn">Test Connection</button>
          <button class="btn btn-primary" id="palace-install-btn">Enable Memory</button>
        </div>
        <button class="btn btn-ghost btn-sm" id="palace-skip-btn">Skip — use file editor only</button>
      </div>
    </div>
  </div>
  <div class="palace-sidebar">
    <div class="palace-sidebar-header">
      <span class="palace-sidebar-title">Memory</span>
      <button class="btn-icon" id="palace-settings" title="Memory settings" style="display: none">
        <span class="ms ms-sm">settings</span>
      </button>
      <button class="btn-icon" id="palace-export" title="Export all memories">
        <span class="ms ms-sm">download</span>
      </button>
      <button class="btn-icon" id="palace-refresh" title="Refresh memories">
        <span class="ms ms-sm">sync</span>
      </button>
    </div>
    <div class="palace-stats" id="palace-stats">
      <div class="palace-stat">
        <span class="palace-stat-num" id="palace-total">—</span>
        <span class="palace-stat-label">Total</span>
      </div>
      <div class="palace-stat">
        <span class="palace-stat-num" id="palace-types">—</span>
        <span class="palace-stat-label">Types</span>
      </div>
      <div class="palace-stat">
        <span class="palace-stat-num" id="palace-graph-edges">—</span>
        <span class="palace-stat-label">Links</span>
      </div>
    </div>
    <div class="palace-filters">
      <input class="palace-search-input" id="palace-search" placeholder="Search memories…" />
      <select class="palace-filter-select" id="palace-agent-filter">
        <option value="">All agents</option>
        <option value="">System (shared)</option>
      </select>
      <select class="palace-filter-select" id="palace-type-filter">
        <option value="">All types</option>
        <option value="fact">Facts</option>
        <option value="preference">Preferences</option>
        <option value="architecture">Architecture</option>
        <option value="decision">Decisions</option>
        <option value="insight">Insights</option>
        <option value="gotcha">Gotchas</option>
        <option value="event">Events</option>
        <option value="solution">Solutions</option>
      </select>
      <select class="palace-filter-select" id="palace-project-filter">
        <option value="">All projects</option>
      </select>
    </div>
    <div class="palace-memory-list" id="palace-memory-list">
      <div class="palace-list-empty" style="padding: 12px; color: var(--text-muted); font-size: 0.85rem">
        Loading…
      </div>
    </div>
    <div class="palace-section-divider" id="palace-files-divider">
      <span>Agent Files</span>
      <button class="btn-icon" id="refresh-memory-btn" title="Refresh files">
        <span class="ms ms-sm">sync</span>
      </button>
    </div>
    <div class="palace-memory-list" id="memory-list"></div>
  </div>
  <div class="palace-main">
    <div class="palace-tabs">
      <button class="palace-tab active" data-palace-tab="recall">
        <span class="ms ms-sm">search</span> Recall
      </button>
      <button class="palace-tab" data-palace-tab="graph">
        <span class="ms ms-sm">hub</span> Map
      </button>
      <button class="palace-tab" data-palace-tab="atlas">
        <span class="ms ms-sm">scatter_plot</span> Atlas
      </button>
      <button class="palace-tab" data-palace-tab="forge">
        <span class="ms ms-sm">verified</span> Forge
      </button>
      <button class="palace-tab" data-palace-tab="remember">
        <span class="ms ms-sm">add</span> Remember
      </button>
      <button class="palace-tab" data-palace-tab="files">
        <span class="ms ms-sm">description</span> Files
      </button>
    </div>
    <div class="palace-panel active" id="palace-recall-panel">
      <div class="palace-recall-input-area">
        <textarea class="palace-recall-input" id="palace-recall-input" placeholder="Search by meaning… e.g. 'How does authentication work?'" rows="2"></textarea>
        <button class="btn btn-primary btn-sm" id="palace-recall-btn">Recall</button>
      </div>
      <div class="palace-recall-results" id="palace-recall-results">
        <div class="empty-state" id="palace-recall-empty">
          <div class="empty-icon"><span class="ms" style="font-size: 48px">search</span></div>
          <div class="empty-title">Semantic search</div>
          <div class="empty-subtitle">Search your agent's memories by meaning — not just keywords</div>
        </div>
      </div>
    </div>
    <div class="palace-panel" id="palace-graph-panel">
      <div class="palace-graph-container" id="palace-graph-canvas">
        <div class="empty-state" id="palace-graph-empty">
          <div class="empty-icon"><span class="ms" style="font-size: 48px">hub</span></div>
          <div class="empty-title">Knowledge graph</div>
          <div class="empty-subtitle">Visual map of how your agent's memories connect</div>
        </div>
        <canvas id="palace-graph-render" width="800" height="600" style="display: none"></canvas>
      </div>
    </div>
    <div class="palace-panel" id="palace-atlas-panel">
      <div class="palace-atlas-container" id="palace-atlas-container">
        <div class="atlas-empty">
          <span class="ms" style="font-size: 48px; color: var(--text-muted)">scatter_plot</span>
          <div class="atlas-empty-title">Memory Atlas</div>
          <div class="atlas-empty-subtitle">3D embedding space visualization</div>
        </div>
      </div>
    </div>
    <div class="palace-panel" id="palace-forge-panel" style="display:none">
      <div class="palace-forge-container" id="palace-forge-content">
        <div class="empty-state" id="palace-forge-empty">
          <div class="empty-icon"><span class="ms" style="font-size: 48px">verified</span></div>
          <div class="empty-title">Skill Certification</div>
          <div class="empty-subtitle">Training domains and certified procedural memories from THE FORGE</div>
        </div>
      </div>
    </div>
    <div class="palace-panel" id="palace-remember-panel">
      <div class="palace-remember-form">
        <div class="form-group">
          <label class="form-label">Category</label>
          <select class="form-input" id="palace-remember-type">
            <option value="other">Other</option>
            <option value="fact">Fact</option>
            <option value="preference">Preference</option>
            <option value="decision">Decision</option>
            <option value="procedure">Procedure</option>
            <option value="concept">Concept</option>
            <option value="code">Code</option>
            <option value="person">Person</option>
            <option value="project">Project</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Content</label>
          <textarea class="form-input" id="palace-remember-content" rows="5" placeholder="What should the agent remember?"></textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Importance (1–10)</label>
          <select class="form-input" id="palace-remember-importance">
            <option value="3">3 – Low</option>
            <option value="5" selected>5 – Normal</option>
            <option value="7">7 – High</option>
            <option value="10">10 – Critical</option>
          </select>
        </div>
        <button class="btn btn-primary" id="palace-remember-save" style="align-self: flex-start">
          <span class="ms ms-sm" style="margin-right: 4px">add</span> Store Memory
        </button>
      </div>
    </div>
    <div class="palace-panel" id="palace-files-panel">
      <div class="memory-editor-panel" style="flex: 1; display: flex; flex-direction: column">
        <div class="memory-editor" id="memory-editor" style="display: none">
          <div class="memory-editor-header">
            <span class="memory-editor-path" id="memory-editor-path"></span>
            <div style="display: flex; gap: 6px">
              <button class="btn btn-ghost btn-sm" id="memory-editor-close">Close</button>
              <button class="btn btn-primary btn-sm" id="memory-editor-save">Save</button>
            </div>
          </div>
          <textarea class="memory-editor-content" id="memory-editor-content"></textarea>
        </div>
        <div class="empty-state" id="memory-empty">
          <div class="empty-icon"><span class="ms" style="font-size: 48px">description</span></div>
          <div class="empty-title">Agent files</div>
          <div class="empty-subtitle">Raw filesystem used by your agent for persistent storage</div>
        </div>
      </div>
    </div>
  </div>
  <div class="view-loading" id="memory-loading" style="display: none">Loading memory…</div>
</div>
`

// ─── EditorPane ──────────────────────────────────────────────────────────────

class MemoryPalacePane extends SimpleEditorPane {
  initialize(): HTMLElement {
    // Inject OPIDE theme overrides
    if (!document.getElementById('opide-palace-theme')) {
      const style = document.createElement('style')
      style.id = 'opide-palace-theme'
      style.textContent = OPIDE_THEME_OVERRIDES + `
        /* Fix scroll in EditorPane */
        .palace-view.active { height: 100%; }
        .palace-sidebar { overflow-y: auto; }
        .palace-main { overflow-y: auto; }
        .palace-memory-list { overflow-y: auto; -webkit-overflow-scrolling: touch; }
        .palace-recall-results { overflow-y: auto; }
        .palace-panel { overflow-y: auto; }
        .palace-panel.active { display: flex; flex-direction: column; }

        /* Fix trackpad scroll */
        .palace-sidebar, .palace-main, .palace-memory-list,
        .palace-recall-results, .palace-panel {
          overscroll-behavior: contain;
        }
      `
      document.head.appendChild(style)
    }

    const root = document.createElement('div')
    root.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:var(--bg-primary)'
    root.innerHTML = PALACE_HTML

    // Trackpad scroll fix on scrollable areas
    root.querySelectorAll('.palace-sidebar, .palace-main, .palace-memory-list, .palace-recall-results').forEach(el => {
      (el as HTMLElement).addEventListener('wheel', (e) => {
        e.stopPropagation();
        (el as HTMLElement).scrollTop += (e as WheelEvent).deltaY
      }, { passive: false })
    })

    return root
  }

  async renderInput?(): Promise<IDisposable> {
    try {
      // Set connected state (required — loadMemoryPalace exits immediately without it)
      const { setConnected } = await import('@openpawz/state/connection')
      setConnected(true)

      // Load the Memory Palace view (binds to all DOM IDs in the scaffold)
      // pawEngine.startListening() is called at app boot in workbench.ts
      const { loadMemoryPalace } = await import('@openpawz/views/memory-palace/index')
      await loadMemoryPalace()
    } catch (e) {
      console.error('[opide-palace] renderInput failed:', e)
      // Show error in the pane
      const root = document.getElementById('memory-view')
      if (root) {
        root.innerHTML = `<div style="padding:20px;color:#ff6b6b;font-family:monospace;font-size:12px">
          <h3>Memory Palace failed to load</h3>
          <pre style="white-space:pre-wrap;margin-top:8px">${String(e)}</pre>
        </div>`
      }
    }

    return { dispose: () => {} }
  }
}

class MemoryPalaceInput extends SimpleEditorInput {
  static readonly ID = 'opide.memoryPalaceInput'
  constructor() {
    super()
  }
  get typeId(): string { return MemoryPalaceInput.ID }
  getName(): string { return 'Memory Palace' }
}

let _inputInstance: MemoryPalaceInput | null = null
function getInput(): MemoryPalaceInput {
  if (!_inputInstance) _inputInstance = new MemoryPalaceInput()
  return _inputInstance
}

// ─── Registration ────────────────────────────────────────────────────────────

/** Returns true iff the V2 Memory Palace runtime is available in this build (B68). */
async function isMemoryPalaceAvailable(): Promise<boolean> {
  try {
    const mod: any = await import('@openpawz/engine')
    return typeof mod?.pawEngine?.startListening === 'function'
  } catch {
    return false
  }
}

export async function registerMemoryPalace(): Promise<void> {
  // OSS strips the V2 engine; silently no-op so the activity-bar icon and
  // EditorPane don't appear when the feature can't actually run.
  if (!await isMemoryPalaceAvailable()) {
    console.log('[opide] Memory Palace not available in this build (V2 feature)')
    return
  }

  // Register the EditorPane (opens as a center tab)
  registerEditorPane(
    'opide.memoryPalace',
    'Memory Palace',
    MemoryPalacePane as any,
    [MemoryPalaceInput],
  )

  // Inject a custom icon into the activity bar — no sidebar, just opens center tab
  function injectActivityBarIcon(retriesLeft = 20): void {
    const activityBar = document.querySelector('.part.activitybar .content .composite-bar')
      || document.querySelector('.activitybar .actions-container')
    if (!activityBar) {
      // B69: cap retries (~10s @ 500ms) so we don't spin forever when the
      // activity bar is permanently hidden.
      if (retriesLeft <= 0) {
        console.warn('[opide] Memory Palace activity-bar icon: activity bar not found, giving up')
        return
      }
      setTimeout(() => injectActivityBarIcon(retriesLeft - 1), 500)
      return
    }

    // Don't double-inject
    if (document.getElementById('opide-palace-icon')) return

    const action = document.createElement('div')
    action.id = 'opide-palace-icon'
    action.title = 'Memory Palace'
    action.style.cssText = `
      width: 48px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      opacity: 0.6;
      transition: opacity 0.15s;
      position: relative;
    `
    action.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="12" cy="12" r="3"/>
      <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
    </svg>`

    action.addEventListener('mouseenter', () => { action.style.opacity = '1' })
    action.addEventListener('mouseleave', () => { action.style.opacity = '0.6' })
    action.addEventListener('click', async () => {
      try {
        const { getService, IEditorService } = await import('@codingame/monaco-vscode-api/services')
        const editorService = await getService(IEditorService) as any
        await editorService.openEditor(getInput(), {})
      } catch (e) {
        console.warn('[opide] Failed to open Memory Palace:', e)
      }
    })

    // Insert at the bottom, just above Accounts/Manage
    const globalActions = document.querySelector('.activitybar .global-activity')
      || document.querySelector('.activitybar .actions-container:last-child')
    if (globalActions?.parentElement) {
      globalActions.parentElement.insertBefore(action, globalActions)
    } else {
      activityBar.appendChild(action)
    }
  }

  // Wait for workbench to render then inject
  setTimeout(injectActivityBarIcon, 1000)

  // Also register in command palette
  import(
    '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions'
  ).then((actionsModule) => {
    const { Action2, registerAction2 } = actionsModule
    if (!registerAction2 || !Action2) return

    registerAction2(class extends Action2 {
      static readonly id = 'opide.openMemoryPalace'
      constructor() {
        super({
          id: 'opide.openMemoryPalace',
          title: { value: 'OPIDE: Open Memory Palace', original: 'OPIDE: Open Memory Palace' },
          f1: true,
        })
      }
      async run(): Promise<void> {
        try {
          const { getService, IEditorService } = await import('@codingame/monaco-vscode-api/services')
          const editorService = await getService(IEditorService) as any
          await editorService.openEditor(getInput(), {})
        } catch (e) {
          console.warn('[opide] Failed to open Memory Palace:', e)
        }
      }
    })
  }).catch(() => {})

  console.log('[opide] Memory Palace registered')
}
