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
import {
  registerCustomView,
  ViewContainerLocation,
} from '@codingame/monaco-vscode-workbench-service-override'
import { marked } from 'marked'
import { installExtensionFromOpenVsx } from './extension-mcp.ts'

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
let _installStatus = new Map<string, InstallStatus>()
let _debounceTimer: ReturnType<typeof setTimeout> | null = null
let _detailView: OvsxExtension | null = null
let _detailReadme = ''

// ─── Open VSX API ────────────────────────────────────────────────────────────

async function searchOpenVsx(query: string): Promise<OvsxExtension[]> {
  const q = encodeURIComponent(query || '')
  const url = query
    ? `https://open-vsx.org/api/-/search?query=${q}&size=30&sortBy=relevance&sortOrder=desc`
    : `https://open-vsx.org/api/-/search?size=30&sortBy=downloadCount&sortOrder=desc`

  const result = await invoke('ide_run_command', {
    command: `curl -sL "${url}"`,
    cwd: '/',
  }) as any

  const data = JSON.parse(result?.stdout || '{}')
  return (data.extensions || []).map(mapExtension)
}

async function fetchExtensionDetail(publisher: string, name: string): Promise<any> {
  const result = await invoke('ide_run_command', {
    command: `curl -sL "https://open-vsx.org/api/${publisher}/${name}"`,
    cwd: '/',
  }) as any
  return JSON.parse(result?.stdout || '{}')
}

async function fetchReadme(url: string): Promise<string> {
  const result = await invoke('ide_run_command', {
    command: `curl -sL "${url}"`,
    cwd: '/',
  }) as any
  return result?.stdout || ''
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
  try {
    const result = await invoke('ide_run_command', {
      command: 'ls ~/.opide/extensions/ 2>/dev/null',
      cwd: '/',
    }) as any
    const dirs = (result?.stdout || '').trim().split('\n').filter((d: string) => d.length > 0)
    _installedIds = new Set(dirs)
  } catch {
    _installedIds = new Set()
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
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
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
      _debounceTimer = setTimeout(() => doSearch(), 300)
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
    if (id === 'opide.test-extension') continue
    const card = document.createElement('div')
    card.className = 'opide-ext-card'
    card.appendChild(makeIconPlaceholder(id))
    const info = document.createElement('div')
    info.className = 'opide-ext-info'
    const name = document.createElement('div')
    name.className = 'opide-ext-name'
    name.textContent = id.split('.').slice(1).join('.') || id
    info.appendChild(name)
    const pub = document.createElement('div')
    pub.className = 'opide-ext-publisher'
    pub.textContent = id.split('.')[0]
    info.appendChild(pub)
    card.appendChild(info)
    const actions = document.createElement('div')
    actions.className = 'opide-ext-actions'
    const btn = document.createElement('button')
    btn.className = 'opide-ext-install-btn installed'
    btn.textContent = 'Installed'
    actions.appendChild(btn)
    card.appendChild(actions)
    list.appendChild(card)
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
        invoke('ide_run_command', { command: `open "${ext.repository}"`, cwd: '/' }).catch(() => {})
      })
      sidebar.appendChild(link)
    }
    detail.appendChild(sidebar)
  }

  container.appendChild(detail)
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function doSearch(): Promise<void> {
  _loading = true
  render()
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

  try {
    _installStatus.set(ext.id, 'downloading')
    render()

    const success = await installExtensionFromOpenVsx(ext.id)

    if (success) {
      _installStatus.set(ext.id, 'complete')
      _installedIds.add(ext.id)
    } else {
      _installStatus.set(ext.id, 'error')
    }
  } catch {
    _installStatus.set(ext.id, 'error')
  }
  render()
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerOpideExtensions(): void {
  injectStyles()

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

      return { dispose() {} }
    },
  })

  console.log('[opide-ext] Extensions panel registered')
}
