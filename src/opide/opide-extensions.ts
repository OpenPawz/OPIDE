// ── OPIDE Extensions Panel ───────────────────────────────────────────────────
// Custom Extensions marketplace UI that queries Open VSX directly.
// Apple-inspired design. No VS Code canInstall checks. Full control.
//
// Features:
//   - Search Open VSX with debounce
//   - Extension cards with icons, ratings, downloads
//   - One-click Install via MCP bridge pipeline
//   - Installed tab with MCP tool info
//   - Detail view with README rendering

import { invoke } from '@tauri-apps/api/core'
import { homeDir } from '@tauri-apps/api/path'
import {
  registerCustomView,
  ViewContainerLocation,
} from '@codingame/monaco-vscode-workbench-service-override'
import { marked } from 'marked'
import { installExtensionFromOpenVsx, uninstallExtension } from './extension-mcp.ts'

marked.setOptions({ async: false, breaks: true, gfm: true })

// ─── Types ───────────────────────────────────────────────────────────────────

interface OvsxExtension {
  id: string
  displayName: string
  name: string
  publisher: string
  verified: boolean
  description: string
  iconUrl: string | null
  downloadCount: number
  averageRating: number
  reviewCount: number
  version: string
  categories: string[]
  downloadUrl: string
  readmeUrl: string | null
  changelogUrl: string | null
  repository: string | null
  license: string | null
  timestamp: string
}

type InstallStatus =
  | null
  | 'downloading'
  | 'extracting'
  | 'generating'
  | 'registering'
  | 'complete'
  | 'error'

// ─── State ───────────────────────────────────────────────────────────────────

let _container: HTMLElement | null = null
let _query = ''
let _results: OvsxExtension[] = []
let _loading = false
let _activeTab: 'marketplace' | 'installed' = 'marketplace'
let _installedIds = new Set<string>()
let _disabledIds = new Set<string>()
let _installStatus = new Map<string, InstallStatus>()
let _debounceTimer: ReturnType<typeof setTimeout> | null = null
let _detailView: OvsxExtension | null = null
let _detailReadme = ''
// Cache extension metadata so the installed tab can show apply buttons
const _extMetadataCache = new Map<string, OvsxExtension>()

// ─── Open VSX API ────────────────────────────────────────────────────────────

// All three of these previously shelled out to `curl` via `ide_run_command`,
// which spawns `zsh -l -c <cmd>` — i.e. a login shell that re-sources
// /etc/zprofile, ~/.zshenv, ~/.zshrc on every call. With nvm/pyenv/oh-my-zsh
// in the user's profile, that's 300-800ms of pure shell startup before
// curl even runs. Multiplied across search + detail + readme + installed-list
// it made opening the Extensions panel feel sluggish.
//
// `ext_fetch_url_text` is the native reqwest-based command we shipped in
// B63/B64 specifically to replace this curl pattern. It hits Open VSX
// directly from Rust and skips the shell entirely.
async function searchOpenVsx(query: string): Promise<OvsxExtension[]> {
  const q = encodeURIComponent(query || '')
  const url = query
    ? `https://open-vsx.org/api/-/search?query=${q}&size=30&sortBy=relevance&sortOrder=desc`
    : `https://open-vsx.org/api/-/search?size=30&sortBy=downloadCount&sortOrder=desc`

  const text = await invoke<string>('ext_fetch_url_text', { url })
  const data = JSON.parse(text || '{}')
  return (data.extensions || []).map(mapExtension)
}

async function fetchExtensionDetail(publisher: string, name: string): Promise<any> {
  const text = await invoke<string>('ext_fetch_url_text', {
    url: `https://open-vsx.org/api/${publisher}/${name}`,
  })
  return JSON.parse(text || '{}')
}

async function fetchReadme(url: string): Promise<string> {
  // Open VSX serves readme files from openvsxorg.blob.core.windows.net,
  // which is in `ext_fetch_url_text`'s allowlist. If the URL ever points
  // somewhere else (rare — extension manifest could in theory reference
  // a third-party host), the call rejects and we surface the empty
  // string so the UI just shows the "no readme" placeholder instead of
  // hanging. We do NOT fall back to curl-via-shell because the slow
  // login-shell startup is the exact thing this commit is fixing.
  try {
    return await invoke<string>('ext_fetch_url_text', { url })
  } catch (e) {
    console.warn('[opide-extensions] readme fetch failed:', e)
    return ''
  }
}

function mapExtension(ext: any): OvsxExtension {
  const publisher = ext.namespace || ext.publisher || 'unknown'
  const name = ext.name || ''
  return {
    id: `${publisher}.${name}`,
    displayName: ext.displayName || name,
    name,
    publisher,
    verified: ext.verified || false,
    description: ext.description || '',
    iconUrl: ext.files?.icon || null,
    downloadCount: ext.downloadCount || 0,
    averageRating: ext.averageRating || 0,
    reviewCount: ext.reviewCount || 0,
    version: ext.version || '0.0.0',
    categories: ext.categories || [],
    downloadUrl: ext.files?.download || '',
    readmeUrl: ext.files?.readme || null,
    changelogUrl: ext.files?.changelog || null,
    repository: ext.repository || null,
    license: ext.license || null,
    timestamp: ext.timestamp || '',
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function renderStars(rating: number): string {
  const full = Math.floor(rating)
  const half = rating - full >= 0.4 ? 1 : 0
  const empty = 5 - full - half
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty)
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime()
  const days = Math.floor(diff / 86400000)
  if (days < 1) return 'today'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

async function loadInstalledIds(): Promise<void> {
  // Same motivation as the search/detail/readme swap above: previously
  // this shelled out to `ls ~/.opide/extensions/ 2>/dev/null` through
  // `zsh -l -c`, paying the full login-shell startup cost just to read
  // a directory listing. Now we use Tauri's homeDir + ide_list_dir
  // which goes through tokio::fs::read_dir directly.
  try {
    const home = await homeDir()
    const extDir = `${home.replace(/\/$/, '')}/.opide/extensions`
    const result = await invoke<{ entries: { name: string; is_dir: boolean }[] }>('ide_list_dir', { path: extDir })
    _installedIds = new Set(
      (result?.entries ?? [])
        .filter((e) => e.is_dir)
        .map((e) => e.name),
    )
  } catch {
    // First-launch case: ~/.opide/extensions doesn't exist yet, which
    // makes ide_list_dir reject. That's not an error from the user's
    // perspective — they just have nothing installed.
    _installedIds = new Set()
  }

  // Load the user-disabled set so the installed tab can show the right toggle.
  try {
    const disabled = await invoke<string[]>('ext_get_disabled')
    _disabledIds = new Set(disabled ?? [])
  } catch {
    _disabledIds = new Set()
  }
}

/** Semver-ish compare: is `latest` strictly newer than `installed`? Compares
 *  major.minor.patch numerically; non-numeric / missing parts count as 0. */
function isNewerVersion(latest: string, installed: string): boolean {
  const a = latest.split('.').map((n) => parseInt(n, 10) || 0)
  const b = installed.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

/** Read an installed extension's on-disk version from its package.json. */
async function readInstalledVersion(id: string): Promise<string | null> {
  try {
    const home = (await homeDir()).replace(/\/$/, '')
    const path = `${home}/.opide/extensions/${id}/package.json`
    const r = await invoke<{ content?: string }>('ide_read_file', { path })
    if (!r?.content) return null
    return JSON.parse(r.content).version ?? null
  } catch {
    return null
  }
}

/** Best-effort: if Open VSX has a newer version than what's installed, inject
 *  an "Update" button into the card's action row. Failures are silent. */
async function checkForUpdate(id: string, card: HTMLElement): Promise<void> {
  try {
    const installed = await readInstalledVersion(id)
    if (!installed) return
    const publisher = id.split('.')[0]
    const name = id.split('.').slice(1).join('.')
    const detail = await fetchExtensionDetail(publisher, name)
    const latest: string | undefined = detail?.version
    if (!latest || !isNewerVersion(latest, installed)) return

    const actions = card.querySelector('.opide-ext-actions')
    if (!actions) return
    const updBtn = document.createElement('button')
    updBtn.className = 'opide-ext-uninstall-btn'
    updBtn.style.background = '#1f6feb'
    updBtn.style.borderColor = '#1f6feb'
    updBtn.style.color = '#fff'
    updBtn.textContent = `Update → ${latest}`
    updBtn.title = `Installed v${installed}, latest v${latest}`
    updBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      updBtn.disabled = true
      updBtn.textContent = 'Updating…'
      try {
        // Reinstalling from Open VSX pulls the latest VSIX over the old one.
        await installExtensionFromOpenVsx(id)
      } catch (err) {
        console.warn('[opide-ext] update failed:', err)
        updBtn.disabled = false
        updBtn.textContent = `Update → ${latest}`
      }
    })
    actions.insertBefore(updBtn, actions.firstChild)
  } catch {
    // best-effort — no update badge on error
  }
}

/** Toggle an extension between enabled and disabled, persist the set, then
 *  restart the host so the change applies (a disabled extension is skipped on
 *  the host's next scan). */
async function toggleExtensionEnabled(id: string, btn: HTMLButtonElement): Promise<void> {
  const willDisable = !_disabledIds.has(id)
  btn.disabled = true
  btn.textContent = willDisable ? 'Disabling…' : 'Enabling…'
  if (willDisable) _disabledIds.add(id)
  else _disabledIds.delete(id)
  try {
    await invoke('ext_set_disabled', { disabled: Array.from(_disabledIds) })
    const { restartExtensionHost } = await import('./extension-bridge.ts')
    await restartExtensionHost()
  } catch (e) {
    console.warn('[opide-ext] toggle enabled failed:', e)
    // Roll back the in-memory state so the UI matches reality.
    if (willDisable) _disabledIds.delete(id)
    else _disabledIds.add(id)
  } finally {
    render()
  }
}

// ─── Styles ──────────────────────────────────────────────────────────────────

function injectStyles(): void {
  if (document.getElementById('opide-ext-styles')) return
  const style = document.createElement('style')
  style.id = 'opide-ext-styles'
  style.textContent = `
    .opide-ext-panel {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      background: var(--vscode-sideBar-background);
      font-family: var(--opide-font-ui);
      color: var(--vscode-foreground);
      overflow: hidden;
    }

    /* ── Search ────────────────────────────────── */
    .opide-ext-search {
      padding: 12px 14px 8px;
      flex-shrink: 0;
    }
    .opide-ext-search-input {
      width: 100%;
      padding: 8px 12px 8px 32px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #333);
      border-radius: 8px;
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
      -webkit-appearance: none;
    }
    .opide-ext-search-input:focus {
      border-color: #E8B931;
      box-shadow: 0 0 0 3px rgba(232, 185, 49, 0.15);
    }
    .opide-ext-search-wrap {
      position: relative;
    }
    .opide-ext-search-icon {
      position: absolute;
      left: 10px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 14px;
      color: var(--vscode-descriptionForeground);
      pointer-events: none;
    }

    /* ── Tabs ──────────────────────────────────── */
    .opide-ext-tabs {
      display: flex;
      gap: 0;
      padding: 0 14px;
      border-bottom: 1px solid var(--vscode-widget-border, #333);
      flex-shrink: 0;
    }
    .opide-ext-tab {
      padding: 8px 16px;
      font-size: 12px;
      font-weight: 500;
      color: var(--vscode-descriptionForeground);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
      letter-spacing: 0.01em;
    }
    .opide-ext-tab:hover {
      color: var(--vscode-foreground);
    }
    .opide-ext-tab.active {
      color: #E8B931;
      border-bottom-color: #E8B931;
    }

    /* ── Results list ─────────────────────────── */
    .opide-ext-list {
      flex: 1 1 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 8px 10px;
      min-height: 0;
    }
    .opide-ext-list::-webkit-scrollbar { width: 6px; }
    .opide-ext-list::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.1);
      border-radius: 3px;
    }

    /* ── Extension Card ───────────────────────── */
    .opide-ext-card {
      display: flex;
      gap: 12px;
      padding: 12px;
      border-radius: 10px;
      cursor: pointer;
      transition: background 0.15s, transform 0.15s, box-shadow 0.15s;
      margin-bottom: 4px;
    }
    .opide-ext-card:hover {
      background: rgba(255,255,255,0.04);
      transform: translateY(-1px);
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    }
    .opide-ext-card:active {
      transform: translateY(0);
    }
    .opide-ext-icon {
      width: 48px;
      height: 48px;
      border-radius: 10px;
      background: rgba(255,255,255,0.06);
      flex-shrink: 0;
      object-fit: cover;
    }
    .opide-ext-icon-placeholder {
      width: 48px;
      height: 48px;
      border-radius: 10px;
      background: linear-gradient(135deg, rgba(232,185,49,0.15), rgba(232,185,49,0.05));
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      color: #E8B931;
    }
    .opide-ext-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .opide-ext-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--vscode-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      letter-spacing: -0.01em;
    }
    .opide-ext-publisher {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .opide-ext-verified {
      color: #4CAF50;
      font-size: 10px;
    }
    .opide-ext-desc {
      font-size: 11.5px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.4;
    }
    .opide-ext-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }
    .opide-ext-stars {
      color: #E8B931;
      font-size: 10px;
      letter-spacing: 1px;
    }
    .opide-ext-downloads {
      display: flex;
      align-items: center;
      gap: 3px;
    }

    /* ── Install button ───────────────────────── */
    .opide-ext-actions {
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }
    .opide-ext-install-btn {
      padding: 5px 14px;
      border-radius: 14px;
      font-size: 12px;
      font-weight: 600;
      border: none;
      cursor: pointer;
      transition: all 0.15s;
      letter-spacing: 0.01em;
      white-space: nowrap;
    }
    .opide-ext-install-btn.get {
      background: #E8B931;
      color: #000;
    }
    .opide-ext-install-btn.get:hover {
      background: #F0CC50;
      transform: scale(1.04);
    }
    .opide-ext-install-btn.installed {
      background: transparent;
      border: 1.5px solid rgba(232,185,49,0.5);
      color: #E8B931;
      cursor: default;
    }
    .opide-ext-install-btn.installing {
      background: rgba(232,185,49,0.15);
      color: #E8B931;
      cursor: wait;
    }
    .opide-ext-uninstall-btn {
      padding: 5px 12px;
      border-radius: 14px;
      font-size: 11px;
      font-weight: 500;
      border: 1px solid rgba(255,80,80,0.4);
      background: transparent;
      color: #ff5050;
      cursor: pointer;
      transition: all 0.15s;
      margin-left: 6px;
    }
    .opide-ext-uninstall-btn:hover {
      background: rgba(255,80,80,0.12);
      border-color: rgba(255,80,80,0.6);
    }
    .opide-ext-uninstall-btn.uninstalling {
      color: var(--vscode-descriptionForeground);
      border-color: rgba(255,255,255,0.15);
      cursor: wait;
    }
    .opide-ext-apply-btn {
      padding: 5px 12px;
      border-radius: 14px;
      font-size: 11px;
      font-weight: 500;
      border: 1px solid rgba(232,185,49,0.5);
      background: rgba(232,185,49,0.1);
      color: #E8B931;
      cursor: pointer;
      transition: all 0.15s;
      margin-left: 6px;
    }
    .opide-ext-apply-btn:hover {
      background: rgba(232,185,49,0.2);
      border-color: #E8B931;
    }

    /* ── Loading ──────────────────────────────── */
    .opide-ext-loading {
      display: flex;
      justify-content: center;
      padding: 32px;
    }
    .opide-ext-spinner {
      width: 20px;
      height: 20px;
      border: 2px solid rgba(255,255,255,0.08);
      border-top-color: #E8B931;
      border-radius: 50%;
      animation: opide-ext-spin 0.7s linear infinite;
    }
    @keyframes opide-ext-spin { to { transform: rotate(360deg); } }

    .opide-ext-empty {
      text-align: center;
      padding: 40px 20px;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
    }

    /* ── Detail View ──────────────────────────── */
    .opide-ext-detail {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    .opide-ext-detail-header {
      padding: 16px;
      display: flex;
      gap: 14px;
      align-items: flex-start;
      border-bottom: 1px solid var(--vscode-widget-border, #333);
      flex-shrink: 0;
    }
    .opide-ext-detail-icon {
      width: 64px;
      height: 64px;
      border-radius: 14px;
      object-fit: cover;
      flex-shrink: 0;
    }
    .opide-ext-detail-title {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 2px;
    }
    .opide-ext-detail-pub {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }
    .opide-ext-detail-meta {
      display: flex;
      gap: 12px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      align-items: center;
    }
    .opide-ext-detail-back {
      padding: 8px 14px;
      font-size: 12px;
      color: #E8B931;
      background: none;
      border: none;
      cursor: pointer;
      border-bottom: 1px solid var(--vscode-widget-border, #333);
      text-align: left;
      flex-shrink: 0;
    }
    .opide-ext-detail-back:hover { text-decoration: underline; }
    .opide-ext-detail-body {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      min-height: 0;
      font-size: 13px;
      line-height: 1.6;
    }
    .opide-ext-detail-body img {
      max-width: 100%;
      border-radius: 6px;
      margin: 8px 0;
    }
    .opide-ext-detail-body h1,
    .opide-ext-detail-body h2,
    .opide-ext-detail-body h3 {
      margin-top: 20px;
      margin-bottom: 8px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .opide-ext-detail-body code {
      background: rgba(255,255,255,0.06);
      padding: 2px 5px;
      border-radius: 4px;
      font-size: 12px;
    }
    .opide-ext-detail-body pre {
      background: rgba(0,0,0,0.3);
      padding: 12px;
      border-radius: 8px;
      overflow-x: auto;
      margin: 8px 0;
    }
    .opide-ext-detail-body pre code {
      background: none;
      padding: 0;
    }
    .opide-ext-detail-body a {
      color: #E8B931;
    }
    .opide-ext-detail-sidebar {
      padding: 16px;
      border-top: 1px solid var(--vscode-widget-border, #333);
      flex-shrink: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      font-size: 11px;
    }
    .opide-ext-detail-tag {
      padding: 3px 8px;
      background: rgba(255,255,255,0.06);
      border-radius: 10px;
      color: var(--vscode-descriptionForeground);
    }
  `
  document.head.appendChild(style)
}

// ─── Render ──────────────────────────────────────────────────────────────────

let _listEl: HTMLElement | null = null
let _tabsEl: HTMLElement | null = null
let _initialized = false

function render(): void {
  if (!_container) return

  if (_detailView) {
    _container.innerHTML = ''
    renderDetailView(_container)
    return
  }

  // First render — build the full panel structure
  if (!_initialized) {
    _container.innerHTML = ''
    const panel = document.createElement('div')
    panel.className = 'opide-ext-panel'

    // Search
    const searchArea = document.createElement('div')
    searchArea.className = 'opide-ext-search'
    const searchWrap = document.createElement('div')
    searchWrap.className = 'opide-ext-search-wrap'
    const searchIcon = document.createElement('span')
    searchIcon.className = 'opide-ext-search-icon codicon codicon-search'
    const searchInput = document.createElement('input')
    searchInput.className = 'opide-ext-search-input'
    searchInput.type = 'text'
    searchInput.placeholder = 'Search extensions...'
    searchInput.value = _query
    searchInput.addEventListener('input', () => {
      _query = searchInput.value
      if (_debounceTimer) clearTimeout(_debounceTimer)
      _debounceTimer = setTimeout(() => doSearch(), 600)
    })
    searchWrap.appendChild(searchIcon)
    searchWrap.appendChild(searchInput)
    searchArea.appendChild(searchWrap)
    panel.appendChild(searchArea)

    // Tabs
    _tabsEl = document.createElement('div')
    _tabsEl.className = 'opide-ext-tabs'
    panel.appendChild(_tabsEl)

    // List
    _listEl = document.createElement('div')
    _listEl.className = 'opide-ext-list'
    // Ensure trackpad scroll works — prevent parent from stealing wheel events
    _listEl.addEventListener('wheel', (e) => {
      e.stopPropagation()
      _listEl!.scrollTop += e.deltaY
    }, { passive: false })
    panel.appendChild(_listEl)

    _container.appendChild(panel)
    _initialized = true

    // Auto-load popular extensions
    doSearch()
  }

  // Update tabs (lightweight)
  if (_tabsEl) {
    _tabsEl.innerHTML = ''
    const mkTab = (label: string, id: 'marketplace' | 'installed') => {
      const btn = document.createElement('button')
      btn.className = `opide-ext-tab ${_activeTab === id ? 'active' : ''}`
      btn.textContent = label
      btn.addEventListener('click', () => { _activeTab = id; render() })
      return btn
    }
    _tabsEl.appendChild(mkTab('Marketplace', 'marketplace'))
    _tabsEl.appendChild(mkTab(`Installed (${_installedIds.size})`, 'installed'))
  }

  // Update results list only (don't touch search input)
  if (_listEl) {
    _listEl.innerHTML = ''

    if (_activeTab === 'marketplace') {
      if (_loading) {
        _listEl.innerHTML = '<div class="opide-ext-loading"><div class="opide-ext-spinner"></div></div>'
      } else if (_results.length === 0) {
        _listEl.innerHTML = `<div class="opide-ext-empty">${_query ? 'No extensions found' : 'Loading popular extensions...'}</div>`
      } else {
        for (const ext of _results) {
          _listEl.appendChild(renderCard(ext))
        }
      }
    } else {
      renderInstalledTab(_listEl)
    }
  }
}

function renderCard(ext: OvsxExtension): HTMLElement {
  const card = document.createElement('div')
  card.className = 'opide-ext-card'

  // Icon
  if (ext.iconUrl) {
    const img = document.createElement('img')
    img.className = 'opide-ext-icon'
    img.src = ext.iconUrl
    img.loading = 'lazy'
    img.onerror = () => { img.replaceWith(makeIconPlaceholder(ext.displayName)) }
    card.appendChild(img)
  } else {
    card.appendChild(makeIconPlaceholder(ext.displayName))
  }

  // Info
  const info = document.createElement('div')
  info.className = 'opide-ext-info'

  const name = document.createElement('div')
  name.className = 'opide-ext-name'
  name.textContent = ext.displayName
  info.appendChild(name)

  const pub = document.createElement('div')
  pub.className = 'opide-ext-publisher'
  pub.textContent = ext.publisher
  if (ext.verified) {
    const badge = document.createElement('span')
    badge.className = 'opide-ext-verified codicon codicon-verified-filled'
    pub.appendChild(badge)
  }
  info.appendChild(pub)

  const desc = document.createElement('div')
  desc.className = 'opide-ext-desc'
  desc.textContent = ext.description
  info.appendChild(desc)

  const meta = document.createElement('div')
  meta.className = 'opide-ext-meta'
  if (ext.averageRating > 0) {
    const stars = document.createElement('span')
    stars.className = 'opide-ext-stars'
    stars.textContent = renderStars(ext.averageRating)
    meta.appendChild(stars)
  }
  const dl = document.createElement('span')
  dl.className = 'opide-ext-downloads'
  dl.innerHTML = `<span class="codicon codicon-cloud-download" style="font-size:11px"></span> ${formatDownloads(ext.downloadCount)}`
  meta.appendChild(dl)
  info.appendChild(meta)

  card.appendChild(info)

  // Actions
  const actions = document.createElement('div')
  actions.className = 'opide-ext-actions'
  const btn = document.createElement('button')
  const status = _installStatus.get(ext.id)
  const isInstalled = _installedIds.has(ext.id)

  if (isInstalled || status === 'complete') {
    btn.className = 'opide-ext-install-btn installed'
    btn.textContent = 'Installed'

    // Show apply button for themes / icon themes
    addApplyButton(actions, ext)

    const unBtn = document.createElement('button')
    unBtn.className = 'opide-ext-uninstall-btn'
    unBtn.textContent = 'Uninstall'
    unBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      doUninstall(ext.id, unBtn)
    })
    actions.appendChild(unBtn)
  } else if (status) {
    btn.className = 'opide-ext-install-btn installing'
    btn.textContent = status === 'downloading' ? 'Getting...'
      : status === 'extracting' ? 'Extracting...'
      : status === 'generating' ? 'Adapting...'
      : status === 'registering' ? 'Registering...'
      : 'Error'
  } else {
    btn.className = 'opide-ext-install-btn get'
    btn.textContent = 'Get'
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      doInstall(ext)
    })
  }
  actions.appendChild(btn)
  card.appendChild(actions)

  // Click card for detail
  card.addEventListener('click', () => openDetail(ext))

  return card
}

function makeIconPlaceholder(name: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'opide-ext-icon-placeholder'
  el.textContent = (name || '?')[0].toUpperCase()
  return el
}

function renderInstalledTab(list: HTMLElement): void {
  if (_installedIds.size === 0) {
    list.innerHTML = '<div class="opide-ext-empty">No extensions installed yet</div>'
    return
  }
  for (const id of _installedIds) {
    const card = document.createElement('div')
    card.className = 'opide-ext-card'
    card.appendChild(makeIconPlaceholder(id))
    const info = document.createElement('div')
    info.className = 'opide-ext-info'
    const isDisabled = _disabledIds.has(id)
    const name = document.createElement('div')
    name.className = 'opide-ext-name'
    name.textContent = (id.split('.').slice(1).join('.') || id) + (isDisabled ? '  (disabled)' : '')
    if (isDisabled) name.style.opacity = '0.55'
    info.appendChild(name)
    const pub = document.createElement('div')
    pub.className = 'opide-ext-publisher'
    pub.textContent = id.split('.')[0]
    info.appendChild(pub)
    card.appendChild(info)
    const actions = document.createElement('div')
    actions.className = 'opide-ext-actions'

    // Show apply button if we have cached metadata (only when enabled)
    const cached = _extMetadataCache.get(id)
    if (cached && !isDisabled) {
      addApplyButton(actions, cached)
    }

    // Enable / Disable toggle (keeps the extension installed either way).
    const toggleBtn = document.createElement('button')
    toggleBtn.className = 'opide-ext-uninstall-btn'
    toggleBtn.style.background = 'transparent'
    toggleBtn.style.borderColor = '#888'
    toggleBtn.style.color = '#ccc'
    toggleBtn.textContent = isDisabled ? 'Enable' : 'Disable'
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleExtensionEnabled(id, toggleBtn)
    })
    actions.appendChild(toggleBtn)

    const unBtn = document.createElement('button')
    unBtn.className = 'opide-ext-uninstall-btn'
    unBtn.textContent = 'Uninstall'
    unBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      doUninstall(id, unBtn)
    })
    actions.appendChild(unBtn)
    card.appendChild(actions)
    list.appendChild(card)

    // Best-effort: check Open VSX for a newer version and add an Update
    // button if one exists. Skipped for disabled extensions.
    if (!isDisabled) void checkForUpdate(id, card)
  }
}

// ─── Detail View ─────────────────────────────────────────────────────────────

async function openDetail(ext: OvsxExtension): Promise<void> {
  _detailView = ext
  _detailReadme = ''
  _initialized = false
  render()

  // Fetch full details + README
  try {
    const detail = await fetchExtensionDetail(ext.publisher, ext.name)
    if (detail.files?.readme) {
      const md = await fetchReadme(detail.files.readme)
      _detailReadme = marked.parse(md) as string
    } else {
      _detailReadme = `<p>${ext.description}</p>`
    }
  } catch {
    _detailReadme = `<p>${ext.description}</p>`
  }
  render()
}

function renderDetailView(container: HTMLElement): void {
  const ext = _detailView!
  const detail = document.createElement('div')
  detail.className = 'opide-ext-panel opide-ext-detail'

  // Back button
  const back = document.createElement('button')
  back.className = 'opide-ext-detail-back'
  back.innerHTML = '← Extensions'
  back.addEventListener('click', () => { _detailView = null; _detailReadme = ''; _initialized = false; render() })
  detail.appendChild(back)

  // Header
  const header = document.createElement('div')
  header.className = 'opide-ext-detail-header'

  if (ext.iconUrl) {
    const img = document.createElement('img')
    img.className = 'opide-ext-detail-icon'
    img.src = ext.iconUrl
    header.appendChild(img)
  }

  const headerInfo = document.createElement('div')
  headerInfo.style.cssText = 'flex:1;min-width:0'

  const title = document.createElement('div')
  title.className = 'opide-ext-detail-title'
  title.textContent = ext.displayName
  headerInfo.appendChild(title)

  const pub = document.createElement('div')
  pub.className = 'opide-ext-detail-pub'
  pub.textContent = `${ext.publisher} · v${ext.version}`
  if (ext.verified) pub.innerHTML += ' <span class="opide-ext-verified codicon codicon-verified-filled"></span>'
  headerInfo.appendChild(pub)

  const meta = document.createElement('div')
  meta.className = 'opide-ext-detail-meta'
  if (ext.averageRating > 0) {
    meta.innerHTML += `<span class="opide-ext-stars">${renderStars(ext.averageRating)}</span>`
    meta.innerHTML += `<span>(${ext.reviewCount})</span>`
  }
  meta.innerHTML += `<span>${formatDownloads(ext.downloadCount)} downloads</span>`
  if (ext.license) meta.innerHTML += `<span>${ext.license}</span>`
  if (ext.timestamp) meta.innerHTML += `<span>Updated ${timeAgo(ext.timestamp)}</span>`
  headerInfo.appendChild(meta)

  header.appendChild(headerInfo)

  // Install button in header
  const headerActions = document.createElement('div')
  headerActions.style.cssText = 'flex-shrink:0;align-self:center'
  const btn = document.createElement('button')
  const isInstalled = _installedIds.has(ext.id) || _installStatus.get(ext.id) === 'complete'
  if (isInstalled) {
    btn.className = 'opide-ext-install-btn installed'
    btn.textContent = 'Installed'

    // Apply buttons for themes/icon themes in detail view
    addApplyButton(headerActions, ext)

    const unBtn = document.createElement('button')
    unBtn.className = 'opide-ext-uninstall-btn'
    unBtn.textContent = 'Uninstall'
    unBtn.style.cssText = 'padding:7px 16px;font-size:12px;border-radius:16px;margin-left:8px'
    unBtn.addEventListener('click', () => doUninstall(ext.id, unBtn))
    headerActions.appendChild(unBtn)
  } else {
    btn.className = 'opide-ext-install-btn get'
    btn.textContent = 'Get'
    btn.style.cssText = 'padding:7px 20px;font-size:13px;border-radius:16px'
    btn.addEventListener('click', () => doInstall(ext))
  }
  headerActions.appendChild(btn)
  header.appendChild(headerActions)

  detail.appendChild(header)

  // Body — README
  const body = document.createElement('div')
  body.className = 'opide-ext-detail-body'
  if (_detailReadme) {
    body.innerHTML = _detailReadme
  } else {
    body.innerHTML = '<div class="opide-ext-loading"><div class="opide-ext-spinner"></div></div>'
  }
  // Trackpad scroll fix
  body.addEventListener('wheel', (e) => {
    e.stopPropagation()
    body.scrollTop += e.deltaY
  }, { passive: false })
  detail.appendChild(body)

  // Tags / categories
  if (ext.categories.length > 0) {
    const sidebar = document.createElement('div')
    sidebar.className = 'opide-ext-detail-sidebar'
    for (const cat of ext.categories) {
      const tag = document.createElement('span')
      tag.className = 'opide-ext-detail-tag'
      tag.textContent = cat
      sidebar.appendChild(tag)
    }
    if (ext.repository) {
      const link = document.createElement('a')
      link.className = 'opide-ext-detail-tag'
      link.textContent = 'Repository'
      link.style.cssText = 'color:#E8B931;cursor:pointer;text-decoration:none'
      link.addEventListener('click', () => {
        // Open via the OS opener with the URL as a distinct argv entry (no
        // shell). The repository URL comes from marketplace metadata, so the
        // old `ide_run_command('open "<url>")` path was a shell-injection
        // vector (a hostile listing could set repository to $(...)).
        invoke('open_external', { url: ext.repository }).catch((e) => {
          console.warn('[opide-extensions] open repository link failed:', ext.repository, e)
        })
      })
      sidebar.appendChild(link)
    }
    detail.appendChild(sidebar)
  }

  container.appendChild(detail)
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function doSearch(): Promise<void> {
  // Don't search for partial words — wait until the user has typed something meaningful
  if (_query.length > 0 && _query.length < 2) return

  _loading = true
  // Only update the list area, not the whole panel — avoids stealing input focus
  if (_listEl) {
    _listEl.innerHTML = '<div class="opide-ext-loading"><div class="opide-ext-spinner"></div></div>'
  }
  try {
    _results = await searchOpenVsx(_query)
  } catch (e) {
    _results = []
  }
  _loading = false
  render()
}

async function doInstall(ext: OvsxExtension): Promise<void> {
  _installStatus.set(ext.id, 'downloading')
  render()

  // Pipe install lifecycle events into the OPIDE log file so users can
  // `tail -f ~/Library/Logs/com.openpawz.opide/OPIDE.log` from a second
  // terminal and watch what failed without opening dev tools.
  const log = (msg: string) =>
    invoke('ext_host_log', { message: `[install:panel] ${msg}` }).catch(() => {})

  try {
    await log(`Starting install of ${ext.id}`)

    const success = await installExtensionFromOpenVsx(ext.id)

    if (success) {
      _installStatus.set(ext.id, 'complete')
      _installedIds.add(ext.id)
      _extMetadataCache.set(ext.id, ext)
      await log(`${ext.id} installed successfully`)
    } else {
      _installStatus.set(ext.id, 'error')
      // installExtensionFromOpenVsx returns false rather than throwing.
      // It already wrote a [install] failure line via ext_host_log; this
      // line is the panel's own marker so users can correlate the UI
      // status pip with the underlying failure in the log.
      await log(`${ext.id} install reported failure — see the previous [install] lines for the cause`)
    }
  } catch (e) {
    _installStatus.set(ext.id, 'error')
    await log(`${ext.id} install threw: ${e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)}`)
  }
  render()
}

// ─── Apply theme / icon theme ───────────────────────────────────────────────

function isThemeExtension(ext: OvsxExtension): boolean {
  const cats = (ext.categories || []).map((c) => c.toLowerCase())
  return cats.includes('themes') || cats.includes('color themes')
}

function isIconThemeExtension(ext: OvsxExtension): boolean {
  const cats = (ext.categories || []).map((c) => c.toLowerCase())
  return cats.includes('icon themes')
}

async function applyTheme(extensionId: string): Promise<void> {
  try {
    const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
    const themeServiceMod = await import(
      '@codingame/monaco-vscode-api/vscode/vs/workbench/services/themes/common/workbenchThemeService.service'
    )
    const IWorkbenchThemeService = themeServiceMod?.IWorkbenchThemeService
    if (!IWorkbenchThemeService) return

    const themeService = StandaloneServices.get(IWorkbenchThemeService) as any
    if (!themeService?.getColorThemes) return

    const themes = await themeService.getColorThemes()
    // Find theme(s) from this extension
    const extThemes = themes.filter((t: any) => {
      const extId = t.extensionData?.extensionId?.toLowerCase() || ''
      return extId === extensionId.toLowerCase() || extId.includes(extensionId.split('.').pop()?.toLowerCase() || '___')
    })

    if (extThemes.length > 0) {
      await themeService.setColorTheme(extThemes[0].id, 'memory')
    } else {
      // Fallback: open the theme picker via command palette
      const { StandaloneServices: SS2 } = await import('@codingame/monaco-vscode-api/services')
      const { ICommandService } = await import(
        '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands'
      )
      const cmdService = SS2.get(ICommandService) as any
      await cmdService?.executeCommand?.('workbench.action.selectTheme')
    }
  } catch (e) {
    console.warn('[opide-ext] Apply theme failed:', e)
  }
}

async function applyIconTheme(extensionId: string): Promise<void> {
  try {
    const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
    const themeServiceMod = await import(
      '@codingame/monaco-vscode-api/vscode/vs/workbench/services/themes/common/workbenchThemeService.service'
    )
    const IWorkbenchThemeService = themeServiceMod?.IWorkbenchThemeService
    if (!IWorkbenchThemeService) return

    const themeService = StandaloneServices.get(IWorkbenchThemeService) as any
    if (!themeService?.getFileIconThemes) return

    const themes = await themeService.getFileIconThemes()
    const extThemes = themes.filter((t: any) => {
      const extId = t.extensionData?.extensionId?.toLowerCase() || ''
      return extId === extensionId.toLowerCase() || extId.includes(extensionId.split('.').pop()?.toLowerCase() || '___')
    })

    if (extThemes.length > 0) {
      await themeService.setFileIconTheme(extThemes[0].id, 'memory')
    } else {
      const { StandaloneServices: SS2 } = await import('@codingame/monaco-vscode-api/services')
      const { ICommandService } = await import(
        '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands'
      )
      const cmdService = SS2.get(ICommandService) as any
      await cmdService?.executeCommand?.('workbench.action.selectFileIconTheme')
    }
  } catch (e) {
    console.warn('[opide-ext] Apply icon theme failed:', e)
  }
}

function addApplyButton(
  container: HTMLElement,
  ext: OvsxExtension,
): void {
  if (isThemeExtension(ext)) {
    const btn = document.createElement('button')
    btn.className = 'opide-ext-apply-btn'
    btn.textContent = 'Apply Theme'
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      btn.textContent = 'Applying...'
      applyTheme(ext.id).then(() => { btn.textContent = 'Applied ✓' })
        .catch(() => { btn.textContent = 'Apply Theme' })
    })
    container.appendChild(btn)
  }
  if (isIconThemeExtension(ext)) {
    const btn = document.createElement('button')
    btn.className = 'opide-ext-apply-btn'
    btn.textContent = 'Apply Icons'
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      btn.textContent = 'Applying...'
      applyIconTheme(ext.id).then(() => { btn.textContent = 'Applied ✓' })
        .catch(() => { btn.textContent = 'Apply Icons' })
    })
    container.appendChild(btn)
  }
}

// ─── Uninstall ──────────────────────────────────────────────────────────────

async function doUninstall(extensionId: string, btn: HTMLButtonElement): Promise<void> {
  btn.textContent = 'Removing...'
  btn.className = 'opide-ext-uninstall-btn uninstalling'

  try {
    const success = await uninstallExtension(extensionId)
    if (success) {
      _installedIds.delete(extensionId)
      _installStatus.delete(extensionId)
      _initialized = false
      render()
    } else {
      btn.textContent = 'Failed'
      setTimeout(() => { btn.textContent = 'Uninstall'; btn.className = 'opide-ext-uninstall-btn' }, 2000)
    }
  } catch {
    btn.textContent = 'Failed'
    setTimeout(() => { btn.textContent = 'Uninstall'; btn.className = 'opide-ext-uninstall-btn' }, 2000)
  }
}

// ─── Registration ────────────────────────────────────────────────────────────

/**
 * Bind Cmd/Ctrl+Shift+X to OPIDE's Extensions panel. OPIDE hides VS Code's
 * built-in extensions viewlet, so its default Cmd+Shift+X would open nothing;
 * this action overrides it (high keybinding weight) and focuses our panel via
 * the auto-generated `opide.extensions.focus` command that every registered
 * view gets.
 */
async function registerExtensionsKeybinding(): Promise<void> {
  try {
    const { Action2, registerAction2 } = (await import(
      '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions'
    )) as any
    if (!registerAction2 || !Action2) return

    registerAction2(
      class extends Action2 {
        constructor() {
          super({
            id: 'opide.openExtensions',
            title: {
              value: 'Extensions: Open OPIDE Marketplace',
              original: 'Extensions: Open OPIDE Marketplace',
            },
            f1: true,
            keybinding: {
              // CtrlCmd(2048) | Shift(1024) | KeyX(54). High weight so it beats
              // the hidden built-in extensions viewlet's Cmd+Shift+X.
              primary: 2048 | 1024 | 54,
              weight: 1000,
            },
          })
        }
        async run(): Promise<void> {
          try {
            const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
            const { ICommandService } = await import(
              '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands'
            )
            const commandService = StandaloneServices.get(ICommandService) as any
            await commandService?.executeCommand?.('opide.extensions.focus')
          } catch (e) {
            console.warn('[opide-ext] open extensions via keybinding failed:', e)
          }
        }
      },
    )
  } catch (e) {
    console.warn('[opide-ext] extensions keybinding registration failed:', e)
  }
}

export function registerOpideExtensions(): void {
  injectStyles()
  void registerExtensionsKeybinding()

  registerCustomView({
    id: 'opide.extensions',
    name: 'Extensions',
    location: ViewContainerLocation.Sidebar,
    icon: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M12 18v-6"/><path d="M9 15h6"/></svg>')}`,
    order: 5,
    default: false,

    renderBody(container) {
      _container = container
      container.style.cssText = 'height:100%;min-height:0;overflow:hidden;display:flex;flex-direction:column'

      // Walk up the DOM and fix flex parents so scroll works
      let el: HTMLElement | null = container
      for (let i = 0; i < 5 && el; i++) {
        el = el.parentElement
        if (el) {
          el.style.minHeight = '0'
          if (getComputedStyle(el).display === 'flex') {
            el.style.overflow = 'hidden'
          }
        }
      }

      loadInstalledIds().then(() => render())

      return {
        dispose() {
          // Cancel a pending search so it doesn't fire doSearch() into a
          // detached panel after the view closes.
          if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null }
        },
      }
    },
  })

  console.log('[opide-ext] Extensions panel registered')
}
