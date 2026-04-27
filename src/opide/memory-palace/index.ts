// Memory Palace — index / orchestration / OPIDE registration.
//
// Public surface:
//   - `loadMemoryPalace()` — wire up DOM IDs + populate the view.
//   - `registerMemoryPalace()` — register the EditorPane + activity-bar entry.
//   - Re-exports of view functions for embedded uses (e.g. dashboards).
//
// The historical OpenPawz embedding-setup wizard (which used six legacy Tauri
// commands like `enable_memory_plugin`) is gone in OPIDE — embedding config
// lives in OPIDE's central Settings → Providers UI. If embeddings aren't ready,
// we render a one-line pointer instead of trying to take over configuration.

import { invoke } from '@tauri-apps/api/core';
import {
  registerEditorPane,
  SimpleEditorPane,
  SimpleEditorInput,
} from '@codingame/monaco-vscode-workbench-service-override';

import './styles/memory-palace.css';
import './styles/memory.css';

import { pawEngine } from './engine';
import { $ } from './helpers';
import { isConnected } from './connection';
import {
  initPalaceTabs,
  initPalaceRecall,
  initPalaceRemember,
  resetPalaceTabs,
  loadPalaceStats,
  loadPalaceSidebar,
  palaceRecallById,
  exportMemories,
} from './molecules';
import { initPalaceGraph } from './graph';

// IDisposable is consumed by VS Code's EditorPane but isn't directly exported
// from the public API surface. We define a minimal stub locally to avoid the
// import-resolution issue.
interface IDisposable {
  dispose(): void;
}

// ── Re-exports ─────────────────────────────────────────────────────────────

export type { MemoryFormData, RecallCardData } from './atoms';
export { validateMemoryForm, CATEGORY_COLORS } from './atoms';
export {
  renderRecallCard,
  palaceRecallById,
  loadPalaceStats,
  loadPalaceSidebar,
} from './molecules';
export { renderPalaceGraph } from './graph';
export { renderAtlas, destroyAtlas } from './embedding-scatter';

// ── Module state ───────────────────────────────────────────────────────────

let _palaceInitialized = false;
let _palaceAvailable = false;

export function setCurrentSessionKey(_key: string | null): void {
  // Reserved for session-aware memory queries
}

export function isPalaceAvailable(): boolean {
  return _palaceAvailable;
}

export function resetPalaceState(): void {
  _palaceInitialized = false;
}

// ── Embeddings-not-configured banner ───────────────────────────────────────

/**
 * Render an inline message when embeddings aren't configured. Defers to the
 * existing OPIDE Settings → Providers UI rather than offering inline setup.
 */
function renderEmbeddingsUnavailableBanner(reason: string): void {
  const statsEl = $('palace-stats');
  if (!statsEl) return;
  // Replace any prior banner so we don't accumulate stale ones
  $('palace-embedding-banner')?.remove();
  const banner = document.createElement('div');
  banner.id = 'palace-embedding-banner';
  banner.className = 'palace-embedding-banner';
  banner.innerHTML = `
    <span class="ms ms-sm">info</span>
    <div>
      <strong>Embeddings not configured.</strong>
      Open <em>OPIDE Settings → Providers</em> to set up an embedding provider.
      ${reason ? `<div class="palace-embedding-banner-reason">${reason}</div>` : ''}
    </div>`;
  statsEl.after(banner);
}

// ── Main loader ────────────────────────────────────────────────────────────

export async function loadMemoryPalace(): Promise<void> {
  if (!isConnected()) return;

  if (!_palaceInitialized) {
    _palaceInitialized = true;

    // Engine mode: memory store is always available (SQLite-backed). Embeddings
    // are a separate concern — checked below to decide whether to show the
    // "not configured" banner.
    try {
      const stats = await pawEngine.memoryStats();
      _palaceAvailable = true;
      console.debug('[memory] Engine mode — memory available, total:', stats.total_memories);
    } catch (e) {
      console.warn('[memory] Engine mode — memory check failed:', e);
      _palaceAvailable = true; // Still available; backend may just lack embeddings yet
    }
  }

  initPalaceTabs();
  resetPalaceTabs();
  initPalaceRecall();
  initPalaceRemember(async () => {
    await loadPalaceSidebar((id) => palaceRecallById(id));
    await loadPalaceStats();
  });
  initPalaceGraph();

  if (_palaceAvailable) {
    await loadPalaceStats();
    await loadPalaceSidebar((id) => palaceRecallById(id));

    // Surface a one-line pointer if embeddings aren't ready — but only the
    // pointer, not a takeover of the panel. Settings → Providers does config.
    try {
      const status = await pawEngine.embeddingStatus();
      const ready = status.model_available && (status.ollama_running || status.model_name !== '');
      if (!ready) {
        renderEmbeddingsUnavailableBanner(status.error ?? '');
      }
    } catch (e) {
      // Backend doesn't know embedding state — render the generic pointer.
      console.debug('[memory] embedding status probe failed:', e);
      renderEmbeddingsUnavailableBanner('');
    }
  }
}

// ── UI event wiring ────────────────────────────────────────────────────────

export function initPalaceEvents(): void {
  // Refresh button
  $('palace-refresh')?.addEventListener('click', async () => {
    _palaceInitialized = false;
    await loadMemoryPalace();
  });

  // Export button
  $('palace-export')?.addEventListener('click', () => {
    exportMemories();
  });

  // Sidebar search filter
  $('palace-search')?.addEventListener('input', () => {
    const query = (($('palace-search') as HTMLInputElement)?.value ?? '').toLowerCase();
    document.querySelectorAll('.palace-memory-card').forEach((card) => {
      const text = card.textContent?.toLowerCase() ?? '';
      (card as HTMLElement).style.display = text.includes(query) ? '' : 'none';
    });
  });

  // Agent filter dropdown
  $('palace-agent-filter')?.addEventListener('change', async () => {
    await loadPalaceSidebar((id) => palaceRecallById(id));
  });
}

// ── HTML scaffold ──────────────────────────────────────────────────────────
//
// The DOM IDs here are the contract between the molecules/graph/atlas modules
// and the EditorPane. Removed pieces vs the historical scaffold:
//   - Embedding-setup install banner (`palace-install-*`, `palace-provider`,
//     `palace-api-*`, `palace-skip-btn`, etc.) — OPIDE config goes through
//     Settings → Providers instead.
//   - Forge tab + panel — backend commands deleted (option B).

const PALACE_HTML = `
<div class="opide-memory-palace" id="memory-view">
  <div class="palace-sidebar">
    <div class="palace-sidebar-header">
      <span class="palace-sidebar-title">Memory</span>
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
      </select>
    </div>
    <div class="palace-memory-list" id="palace-memory-list">
      <div class="palace-list-empty">Loading…</div>
    </div>
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
      <button class="palace-tab" data-palace-tab="remember">
        <span class="ms ms-sm">add</span> Remember
      </button>
    </div>
    <div class="palace-panel active" id="palace-recall-panel">
      <div class="palace-recall-input-area">
        <textarea class="palace-recall-input" id="palace-recall-input" placeholder="Search by meaning…" rows="2"></textarea>
        <button class="btn btn-primary btn-sm" id="palace-recall-btn">Recall</button>
      </div>
      <div class="palace-recall-results" id="palace-recall-results">
        <div class="empty-state" id="palace-recall-empty">
          <div class="empty-icon"><span class="ms" style="font-size:48px">search</span></div>
          <div class="empty-title">Semantic search</div>
          <div class="empty-subtitle">Search your agent's memories by meaning — not just keywords</div>
        </div>
      </div>
    </div>
    <div class="palace-panel" id="palace-graph-panel">
      <div class="palace-graph-container" id="palace-graph-canvas">
        <div class="empty-state" id="palace-graph-empty">
          <div class="empty-icon"><span class="ms" style="font-size:48px">hub</span></div>
          <div class="empty-title">Knowledge graph</div>
          <div class="empty-subtitle">Visual map of how your agent's memories connect</div>
        </div>
        <canvas id="palace-graph-render" width="800" height="600" style="display:none"></canvas>
      </div>
    </div>
    <div class="palace-panel" id="palace-atlas-panel">
      <div class="palace-atlas-container" id="palace-atlas-container">
        <div class="atlas-empty">
          <span class="ms" style="font-size:48px;color:var(--text-muted)">scatter_plot</span>
          <div class="atlas-empty-title">Memory Atlas</div>
          <div class="atlas-empty-subtitle">3D embedding space visualization</div>
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
        <button class="btn btn-primary" id="palace-remember-save">
          <span class="ms ms-sm" style="margin-right:4px">add</span> Store Memory
        </button>
      </div>
    </div>
  </div>
</div>
`;

// ── EditorPane plumbing ────────────────────────────────────────────────────

class MemoryPalacePane extends SimpleEditorPane {
  initialize(): HTMLElement {
    const root = document.createElement('div');
    root.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:var(--vscode-editor-background)';
    root.innerHTML = PALACE_HTML;

    // Trackpad scroll fix on scrollable areas
    root
      .querySelectorAll('.palace-sidebar, .palace-main, .palace-memory-list, .palace-recall-results')
      .forEach((el) => {
        (el as HTMLElement).addEventListener(
          'wheel',
          (e) => {
            e.stopPropagation();
            (el as HTMLElement).scrollTop += (e as WheelEvent).deltaY;
          },
          { passive: false },
        );
      });

    return root;
  }

  async renderInput?(): Promise<IDisposable> {
    try {
      await loadMemoryPalace();
      initPalaceEvents();
    } catch (e) {
      console.error('[memory-palace] renderInput failed:', e);
      const root = document.getElementById('memory-view');
      if (root) {
        root.innerHTML = `<div style="padding:20px;color:#ff6b6b;font-family:monospace;font-size:12px">
          <h3>Memory Palace failed to load</h3>
          <pre style="white-space:pre-wrap;margin-top:8px">${String(e)}</pre>
        </div>`;
      }
    }
    return { dispose: () => {} };
  }
}

class MemoryPalaceInput extends SimpleEditorInput {
  static readonly ID = 'opide.memoryPalaceInput';
  constructor() {
    super();
  }
  override get typeId(): string {
    return MemoryPalaceInput.ID;
  }
  override getName(): string {
    return 'Memory Palace';
  }
}

let _inputInstance: MemoryPalaceInput | null = null;
function getInput(): MemoryPalaceInput {
  if (!_inputInstance) _inputInstance = new MemoryPalaceInput();
  return _inputInstance;
}

/**
 * Probe whether the memory backend is reachable. We don't gate the UI on
 * `_available`/`_unavailable` flags any more — registration is unconditional
 * if the engine is in-process — but a successful probe signals that we'll
 * have something useful to show.
 */
async function isMemoryBackendReachable(): Promise<boolean> {
  try {
    await invoke('engine_memory_stats');
    return true;
  } catch (e) {
    console.warn('[memory-palace] backend probe failed:', e);
    return false;
  }
}

// ── Public registration entry point ────────────────────────────────────────

export async function registerMemoryPalace(): Promise<void> {
  if (!(await isMemoryBackendReachable())) {
    console.log('[opide] Memory Palace skipped — engine_memory_stats unreachable');
    return;
  }

  registerEditorPane(
    'opide.memoryPalace',
    'Memory Palace',
    MemoryPalacePane as unknown as Parameters<typeof registerEditorPane>[2],
    [MemoryPalaceInput],
  );

  // Inject a small activity-bar icon that opens the palace as a center tab.
  function injectActivityBarIcon(retriesLeft = 20): void {
    const activityBar =
      document.querySelector('.part.activitybar .content .composite-bar') ||
      document.querySelector('.activitybar .actions-container');
    if (!activityBar) {
      if (retriesLeft <= 0) {
        console.warn('[opide] Memory Palace icon: activity bar not found, giving up');
        return;
      }
      window.setTimeout(() => injectActivityBarIcon(retriesLeft - 1), 500);
      return;
    }
    if (document.getElementById('opide-palace-icon')) return;

    const action = document.createElement('div');
    action.id = 'opide-palace-icon';
    action.title = 'Memory Palace';
    action.style.cssText =
      'width:48px;height:48px;display:flex;align-items:center;justify-content:center;' +
      'cursor:pointer;opacity:0.6;transition:opacity 0.15s;position:relative;';
    action.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="12" cy="12" r="3"/>
      <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
    </svg>`;
    action.addEventListener('mouseenter', () => {
      action.style.opacity = '1';
    });
    action.addEventListener('mouseleave', () => {
      action.style.opacity = '0.6';
    });
    action.addEventListener('click', async () => {
      try {
        const services = await import('@codingame/monaco-vscode-api/services');
        const editorService = (await services.getService(services.IEditorService)) as {
          openEditor(input: unknown, options?: unknown): Promise<unknown>;
        };
        await editorService.openEditor(getInput(), {});
      } catch (e) {
        console.warn('[opide] Failed to open Memory Palace:', e);
      }
    });

    const globalActions =
      document.querySelector('.activitybar .global-activity') ||
      document.querySelector('.activitybar .actions-container:last-child');
    if (globalActions?.parentElement) {
      globalActions.parentElement.insertBefore(action, globalActions);
    } else {
      activityBar.appendChild(action);
    }
  }

  window.setTimeout(injectActivityBarIcon, 1000);
  console.log('[opide] Memory Palace registered');
}
