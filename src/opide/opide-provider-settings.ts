/**
 * OPIDE Provider Settings — Custom tab inside VS Code's Settings editor (Cmd+,)
 *
 * Registers an "OPIDE AI" pane via IPreferencesEditorPaneRegistry.
 * Full provider management: add/edit/remove providers, model routing, engine defaults.
 */

import { invoke } from '@tauri-apps/api/core'
import { Registry } from '@codingame/monaco-vscode-api/vscode/vs/platform/registry/common/platform'
import { Extensions as PreferencesExtensions } from '@codingame/monaco-vscode-preferences-service-override/vscode/vs/workbench/contrib/preferences/browser/preferencesEditorRegistry'
import { SyncDescriptor } from '@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/descriptors'

// ─── Constants (matching OpenPawz atoms.ts) ──────────────────────────────────

const PROVIDER_KINDS = [
  { value: 'ollama', label: 'Ollama (local)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'moonshot', label: 'Moonshot (Kimi)' },
  { value: 'grok', label: 'xAI (Grok)' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'azure_foundry', label: 'Azure AI Foundry' },
  { value: 'claudecode', label: 'Claude Code (Max)' },
  { value: 'custom', label: 'Custom / Compatible' },
]

const DEFAULT_URLS: Record<string, string> = {
  ollama: 'http://localhost:11434',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com',
  moonshot: 'https://api.moonshot.ai/v1',
  grok: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  azure_foundry: '',
  claudecode: '',
  custom: '',
}

const PRESETS = [
  { label: 'Claude Opus + Haiku', boss: 'claude-opus-4-6', worker: 'claude-haiku-4-5-20251001' },
  { label: 'GPT-4o + mini', boss: 'gpt-4o', worker: 'gpt-4o-mini' },
  { label: 'Gemini Pro + Flash', boss: 'gemini-2.5-pro', worker: 'gemini-2.5-flash' },
]

// ─── Styles ──────────────────────────────────────────────────────────────────

const STYLES = `
  .opide-prov { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; color:#ccc; padding:16px; max-width:720px; }
  .opide-prov h2 { font-size:16px; font-weight:600; color:#fff; margin:20px 0 6px; }
  .opide-prov h2:first-child { margin-top:0; }
  .opide-prov p.desc { font-size:11px; color:#888; margin:0 0 12px; }
  .opide-prov table { width:100%; border-collapse:collapse; font-size:12px; margin-bottom:16px; }
  .opide-prov th { text-align:left; padding:6px 10px; border-bottom:1px solid #333; color:#888; font-weight:500; }
  .opide-prov td { padding:6px 10px; border-bottom:1px solid #2a2a2a; }
  .opide-prov .card { background:#252526; border:1px solid #3c3c3c; border-radius:6px; padding:12px; margin-bottom:8px; }
  .opide-prov .card-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
  .opide-prov .card-title { font-weight:600; font-size:12px; color:#fff; }
  .opide-prov .badge { font-size:9px; padding:2px 6px; border-radius:8px; background:#E8B931; color:#000; font-weight:600; }
  .opide-prov .field { margin-bottom:8px; }
  .opide-prov .field label { display:block; font-size:10px; color:#888; margin-bottom:2px; }
  .opide-prov .inp { width:100%; background:#1e1e1e; color:#ccc; border:1px solid #3c3c3c; border-radius:3px; padding:5px 8px; font-size:12px; outline:none; box-sizing:border-box; }
  .opide-prov .inp:focus { border-color:#E8B931; }
  .opide-prov .sel { width:100%; background:#1e1e1e; color:#ccc; border:1px solid #3c3c3c; border-radius:3px; padding:5px 8px; font-size:12px; box-sizing:border-box; }
  .opide-prov .btn { padding:4px 12px; border:none; border-radius:3px; cursor:pointer; font-size:11px; }
  .opide-prov .btn-p { background:#E8B931; color:#000; font-weight:500; }
  .opide-prov .btn-p:hover { background:#F0CC50; }
  .opide-prov .btn-d { background:transparent; color:#f85149; border:1px solid #f85149; }
  .opide-prov .btn-g { background:transparent; color:#888; border:1px solid #3c3c3c; }
  .opide-prov .btn-g:hover { color:#ccc; border-color:#555; }
  .opide-prov .btn-row { display:flex; gap:6px; margin-top:8px; }
  .opide-prov .chips { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; }
  .opide-prov .chip { font-size:10px; padding:2px 8px; border-radius:10px; background:#3c3c3c; color:#ccc; cursor:pointer; border:none; }
  .opide-prov .chip:hover { background:#E8B931; color:#000; }
  .opide-prov .dot { width:7px; height:7px; border-radius:50%; display:inline-block; margin-right:5px; }
  .opide-prov .dot-g { background:#2ea043; }
  .opide-prov .dot-r { background:#da3633; }
  .opide-prov .dot-y { background:#d29922; }
  .opide-prov .divider { border:none; border-top:1px solid #333; margin:16px 0; }
  .opide-prov .empty { padding:20px; text-align:center; border:1px dashed #3c3c3c; border-radius:6px; color:#888; font-size:12px; }
  .opide-prov .toast { position:fixed; bottom:16px; right:16px; padding:8px 14px; background:#E8B931; color:#000; border-radius:4px; font-size:12px; font-weight:500; z-index:10001; }
`

function toast(msg: string): void {
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = msg
  document.querySelector('.opide-prov')?.appendChild(el)
  setTimeout(() => el.remove(), 2000)
}

// ─── Pane Class ──────────────────────────────────────────────────────────────

class OpideAISettingsPane {
  private root: HTMLElement
  private content: HTMLElement

  constructor() {
    this.root = document.createElement('div')
    this.root.className = 'opide-prov'

    const style = document.createElement('style')
    style.textContent = STYLES
    this.root.appendChild(style)

    this.content = document.createElement('div')
    this.root.appendChild(this.content)

    this.render()
  }

  getDomNode(): HTMLElement {
    return this.root
  }

  layout(_dimension: { width: number; height: number }): void {
    // Content flows naturally, no fixed layout needed
  }

  search(_text: string): void {
    // Could highlight matching sections — skip for now
  }

  dispose(): void {
    this.root.remove()
  }

  // ─── Main Render ─────────────────────────────────────────────────────────

  private async render(): Promise<void> {
    this.content.innerHTML = '<p style="color:#888">Loading…</p>'

    let config: any
    try {
      config = await invoke('engine_get_config')
    } catch (e) {
      this.content.innerHTML = `<p style="color:#f85149">Failed to load config: ${e}</p>`
      return
    }

    this.content.innerHTML = ''
    const providers = config.providers ?? []

    // Branded Header
    const header = document.createElement('div')
    header.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 0;margin-bottom:16px;border-bottom:1px solid #333'
    header.innerHTML = `
      <img src="${window.location.origin}/brand-paw.png" style="width:36px;height:36px;filter:drop-shadow(0 0 6px rgba(232,185,49,0.3))" alt="OPIDE">
      <div>
        <div style="font-size:16px;font-weight:600;color:#E8B931;letter-spacing:0.05em">OPIDE AI</div>
        <div style="font-size:11px;color:#888">Powered by OpenPawz Engine</div>
      </div>
    `
    this.content.appendChild(header)

    // Section 1: Overview
    this.content.appendChild(this.renderOverview(providers, config))

    // Section 2: Default Model
    this.content.appendChild(this.renderDefaultModel(config, providers))

    // Divider
    this.content.appendChild(Object.assign(document.createElement('hr'), { className: 'divider' }))

    // Section 3: Model Routing
    this.content.appendChild(this.renderRouting(config))

    // Divider
    this.content.appendChild(Object.assign(document.createElement('hr'), { className: 'divider' }))

    // Section 4: Manage Providers
    this.content.appendChild(this.renderManageProviders(providers, config))

    // Divider
    this.content.appendChild(Object.assign(document.createElement('hr'), { className: 'divider' }))

    // Section 5: Engine Defaults
    this.content.appendChild(this.renderEngineDefaults(config))
  }

  // ─── Section 1: Overview ─────────────────────────────────────────────────

  private renderOverview(providers: any[], config: any): HTMLElement {
    const section = document.createElement('div')
    section.innerHTML = '<h2>Configured Providers</h2><p class="desc">All your AI providers. Agents can use any of these.</p>'

    if (!providers.length) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = 'No providers configured yet. Add one below.'
      section.appendChild(empty)
      return section
    }

    const table = document.createElement('table')
    table.innerHTML = '<thead><tr><th>Provider</th><th>Type</th><th>Endpoint</th><th>Model</th><th>Status</th></tr></thead>'
    const tbody = document.createElement('tbody')

    for (const p of providers) {
      const kind = PROVIDER_KINDS.find(k => k.value === p.kind)?.label ?? p.kind
      const url = p.base_url || DEFAULT_URLS[p.kind] || '—'
      const hasKey = !!p.api_key
      const isLocal = p.kind === 'ollama'
      const isCli = p.kind === 'claudecode'
      const isDefault = p.id === config.default_provider
      const dotClass = hasKey ? 'dot-g' : (isLocal || isCli) ? 'dot-y' : 'dot-r'
      const statusText = hasKey ? 'Key set' : isCli ? 'CLI (Max)' : isLocal ? 'Local' : 'No key'

      const tr = document.createElement('tr')
      tr.innerHTML = `
        <td><strong>${esc(p.id)}</strong>${isDefault ? ' <span class="badge">default</span>' : ''}</td>
        <td style="color:#888">${esc(kind)}</td>
        <td style="font-family:monospace;font-size:10px">${esc(url.length > 40 ? url.slice(0, 40) + '…' : url)}</td>
        <td style="font-family:monospace;font-size:10px">${esc(p.default_model || '—')}</td>
        <td><span class="dot ${dotClass}"></span>${statusText}</td>
      `
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    section.appendChild(table)
    return section
  }

  // ─── Section 2: Default Model ────────────────────────────────────────────

  private renderDefaultModel(config: any, providers: any[]): HTMLElement {
    const section = document.createElement('div')
    section.innerHTML = '<h2>Default Model & Provider</h2><p class="desc">Used for conversations unless overridden per-agent.</p>'

    // Provider dropdown
    const provField = mkField('Default Provider')
    const provSel = document.createElement('select')
    provSel.className = 'sel'
    provSel.innerHTML = '<option value="">— auto —</option>'
    for (const p of providers) {
      const opt = document.createElement('option')
      opt.value = p.id
      opt.textContent = p.id
      opt.selected = p.id === config.default_provider
      provSel.appendChild(opt)
    }
    provField.appendChild(provSel)
    section.appendChild(provField)

    // Model input
    const modelField = mkField('Default Model')
    const modelInp = mkInput(config.default_model || '', 'e.g. claude-sonnet-4-6, gpt-4o, moonshot-v1-8k')
    modelField.appendChild(modelInp)
    section.appendChild(modelField)

    // Save
    const saveBtn = document.createElement('button')
    saveBtn.className = 'btn btn-p'
    saveBtn.textContent = 'Save'
    saveBtn.addEventListener('click', async () => {
      try {
        await invoke('engine_set_config', {
          config: { ...config, default_provider: provSel.value || undefined, default_model: modelInp.value.trim() || undefined }
        })
        toast('Saved')
        this.render()
      } catch (e) { toast(`Error: ${e}`) }
    })
    section.appendChild(saveBtn)
    return section
  }

  // ─── Section 3: Model Routing ────────────────────────────────────────────

  private renderRouting(config: any): HTMLElement {
    const section = document.createElement('div')
    const routing = config.model_routing ?? {}

    section.innerHTML = '<h2>Model Routing</h2><p class="desc">Use different models for different roles. Smart Auto-Tier uses cheap models for simple tasks.</p>'

    // Auto-tier toggle
    const autoRow = document.createElement('div')
    autoRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px'
    const autoCheck = document.createElement('input')
    autoCheck.type = 'checkbox'
    autoCheck.checked = routing.auto_tier ?? false
    const autoLabel = document.createElement('span')
    autoLabel.style.fontSize = '12px'
    autoLabel.textContent = 'Smart Auto-Tier (cheap model for simple tasks)'
    autoRow.appendChild(autoCheck)
    autoRow.appendChild(autoLabel)
    section.appendChild(autoRow)

    // Boss model
    const bossField = mkField('Boss / Orchestrator Model')
    const bossInp = mkInput(routing.boss_model || '', 'e.g. claude-opus-4-6')
    bossField.appendChild(bossInp)
    section.appendChild(bossField)

    // Worker model
    const workerField = mkField('Worker / Foreman Model')
    const workerInp = mkInput(routing.worker_model || '', 'e.g. gemini-2.0-flash')
    workerField.appendChild(workerInp)
    section.appendChild(workerField)

    // Presets
    const chips = document.createElement('div')
    chips.className = 'chips'
    for (const p of PRESETS) {
      const chip = document.createElement('button')
      chip.className = 'chip'
      chip.textContent = p.label
      chip.addEventListener('click', () => { bossInp.value = p.boss; workerInp.value = p.worker })
      chips.appendChild(chip)
    }
    section.appendChild(chips)

    // Save
    const saveBtn = document.createElement('button')
    saveBtn.className = 'btn btn-p'
    saveBtn.style.marginTop = '10px'
    saveBtn.textContent = 'Save Routing'
    saveBtn.addEventListener('click', async () => {
      try {
        await invoke('engine_set_config', {
          config: {
            ...config,
            model_routing: {
              ...routing,
              auto_tier: autoCheck.checked,
              boss_model: bossInp.value.trim() || undefined,
              worker_model: workerInp.value.trim() || undefined,
            }
          }
        })
        toast('Routing saved')
      } catch (e) { toast(`Error: ${e}`) }
    })
    section.appendChild(saveBtn)
    return section
  }

  // ─── Section 4: Manage Providers ─────────────────────────────────────────

  private renderManageProviders(providers: any[], config: any): HTMLElement {
    const section = document.createElement('div')

    // Header with Add button
    const header = document.createElement('div')
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center'
    header.innerHTML = '<h2 style="margin:0">Manage Providers</h2>'
    const addBtn = document.createElement('button')
    addBtn.className = 'btn btn-p'
    addBtn.textContent = '+ Add Provider'
    let formVisible = false
    addBtn.addEventListener('click', () => {
      formVisible = !formVisible
      addForm.style.display = formVisible ? 'block' : 'none'
    })
    header.appendChild(addBtn)
    section.appendChild(header)

    // Add form (hidden)
    const addForm = this.buildAddForm(config)
    addForm.style.display = 'none'
    section.appendChild(addForm)

    // Provider cards
    for (const p of providers) {
      section.appendChild(this.buildProviderCard(p, config))
    }

    return section
  }

  private buildAddForm(config: any): HTMLElement {
    const form = document.createElement('div')
    form.className = 'card'
    form.style.marginTop = '8px'

    const idField = mkField('Provider ID')
    const idInp = mkInput('', 'my-openai')
    idField.appendChild(idInp)
    form.appendChild(idField)

    const typeField = mkField('Type')
    const typeSel = document.createElement('select')
    typeSel.className = 'sel'
    for (const k of PROVIDER_KINDS) {
      const o = document.createElement('option')
      o.value = k.value; o.textContent = k.label
      typeSel.appendChild(o)
    }
    typeField.appendChild(typeSel)
    form.appendChild(typeField)

    const urlField = mkField('Base URL')
    const urlInp = mkInput(DEFAULT_URLS['ollama'], '')
    urlField.appendChild(urlInp)
    form.appendChild(urlField)

    const keyField = mkField('API Key')
    const keyInp = mkInput('', 'sk-...')
    keyInp.type = 'password'
    keyField.appendChild(keyInp)
    form.appendChild(keyField)

    const modelField = mkField('Default Model (optional)')
    const modelInp = mkInput('', '')
    modelField.appendChild(modelInp)
    form.appendChild(modelField)

    typeSel.addEventListener('change', () => {
      urlInp.value = DEFAULT_URLS[typeSel.value] || ''
      const isCli = typeSel.value === 'claudecode'
      urlField.style.display = isCli ? 'none' : ''
      keyField.style.display = isCli ? 'none' : ''
      if (isCli) modelInp.placeholder = 'sonnet, opus, or haiku'
      else modelInp.placeholder = ''
    })

    const saveBtn = document.createElement('button')
    saveBtn.className = 'btn btn-p'
    saveBtn.textContent = 'Add Provider'
    saveBtn.addEventListener('click', async () => {
      const id = idInp.value.trim() || typeSel.value + '-' + Date.now().toString(36)
      try {
        await invoke('engine_upsert_provider', {
          provider: {
            id,
            name: PROVIDER_KINDS.find(k => k.value === typeSel.value)?.label || id,
            kind: typeSel.value,
            api_key: keyInp.value.trim(),
            base_url: urlInp.value.trim(),
            default_model: modelInp.value.trim() || undefined,
          }
        })
        if (!(config.providers?.length)) {
          await invoke('engine_set_config', { config: { ...config, default_provider: id } })
        }
        toast('Provider added')
        this.render()
      } catch (e) { toast(`Error: ${e}`) }
    })
    form.appendChild(saveBtn)

    return form
  }

  private buildProviderCard(p: any, config: any): HTMLElement {
    const card = document.createElement('div')
    card.className = 'card'
    card.style.marginTop = '8px'

    const isDefault = p.id === config.default_provider
    const hasKey = !!p.api_key
    const dotClass = hasKey ? 'dot-g' : p.kind === 'ollama' ? 'dot-y' : 'dot-r'

    // Header
    const head = document.createElement('div')
    head.className = 'card-head'
    head.innerHTML = `<div class="card-title">${esc(p.id)} ${isDefault ? '<span class="badge">default</span>' : ''}</div><div><span class="dot ${dotClass}"></span><span style="font-size:10px;color:#888">${PROVIDER_KINDS.find(k => k.value === p.kind)?.label || p.kind}</span></div>`
    card.appendChild(head)

    // Edit fields
    const urlField = mkField('Base URL')
    const urlInp = mkInput(p.base_url || '', '')
    urlField.appendChild(urlInp)
    card.appendChild(urlField)

    const keyField = mkField('API Key')
    const keyInp = mkInput(p.api_key || '', 'sk-...')
    keyInp.type = 'password'
    keyField.appendChild(keyInp)
    card.appendChild(keyField)

    const modelField = mkField('Default Model')
    const modelInp = mkInput(p.default_model || '', '')
    modelField.appendChild(modelInp)
    card.appendChild(modelField)

    // Discover models
    const discoverBtn = document.createElement('button')
    discoverBtn.className = 'btn btn-g'
    discoverBtn.textContent = 'Discover Models'
    discoverBtn.addEventListener('click', async () => {
      discoverBtn.textContent = 'Discovering…'
      try {
        const models = await invoke<string[]>('engine_list_provider_models', { providerId: p.id })
        discoverBtn.textContent = `Found ${models.length} models`
        const chips = document.createElement('div')
        chips.className = 'chips'
        chips.style.marginTop = '4px'
        for (const m of models.slice(0, 30)) {
          const c = document.createElement('button')
          c.className = 'chip'
          c.textContent = m
          c.addEventListener('click', () => { modelInp.value = m })
          chips.appendChild(c)
        }
        discoverBtn.after(chips)
      } catch (e) { discoverBtn.textContent = `Error: ${e}` }
    })
    card.appendChild(discoverBtn)

    // Enabled models checkboxes
    const MODEL_PRESETS: Record<string, string[]> = {
      anthropic: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
      openai: ['gpt-5.4', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
      google: ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
      moonshot: ['kimi-k2', 'moonshot-v1-128k'],
      deepseek: ['deepseek-chat', 'deepseek-reasoner'],
      claudecode: ['sonnet', 'opus', 'haiku'],
    }
    const presetModels = MODEL_PRESETS[p.kind] ?? []
    if (presetModels.length > 0) {
      const modelsField = mkField('Enabled Models (shown in selector)')
      const enabledSet = new Set<string>(p.enabled_models ?? presetModels)
      const checkboxes = document.createElement('div')
      checkboxes.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:4px'
      for (const m of presetModels) {
        const label = document.createElement('label')
        label.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;cursor:pointer'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = enabledSet.has(m)
        cb.style.cssText = 'accent-color:#E8B931;cursor:pointer'
        cb.addEventListener('change', () => {
          if (cb.checked) enabledSet.add(m)
          else enabledSet.delete(m)
        })
        label.appendChild(cb)
        label.appendChild(document.createTextNode(m))
        checkboxes.appendChild(label)
      }
      modelsField.appendChild(checkboxes)
      card.appendChild(modelsField)

      // Store reference for save button
      var getEnabledModels = () => Array.from(enabledSet)
    }

    // Action buttons
    const actions = document.createElement('div')
    actions.className = 'btn-row'

    const saveBtn = document.createElement('button')
    saveBtn.className = 'btn btn-p'
    saveBtn.textContent = 'Save'
    saveBtn.addEventListener('click', async () => {
      try {
        const enabled = typeof getEnabledModels === 'function' ? getEnabledModels() : undefined
        await invoke('engine_upsert_provider', {
          provider: {
            ...p,
            base_url: urlInp.value.trim(),
            api_key: keyInp.value.trim(),
            default_model: modelInp.value.trim() || undefined,
            enabled_models: enabled,
          }
        })
        toast('Saved')
        this.render()
      } catch (e) { toast(`Error: ${e}`) }
    })
    actions.appendChild(saveBtn)

    if (!isDefault) {
      const defBtn = document.createElement('button')
      defBtn.className = 'btn btn-g'
      defBtn.textContent = 'Set Default'
      defBtn.addEventListener('click', async () => {
        await invoke('engine_set_config', { config: { ...config, default_provider: p.id } })
        toast('Default set')
        this.render()
      })
      actions.appendChild(defBtn)
    }

    const rmBtn = document.createElement('button')
    rmBtn.className = 'btn btn-d'
    rmBtn.textContent = 'Remove'
    rmBtn.addEventListener('click', () => {
      rmBtn.textContent = 'Confirm?'
      rmBtn.addEventListener('click', async () => {
        await invoke('engine_remove_provider', { providerId: p.id })
        toast('Removed')
        this.render()
      }, { once: true })
    }, { once: true })
    actions.appendChild(rmBtn)

    card.appendChild(actions)
    return card
  }

  // ─── Section 5: Engine Defaults ──────────────────────────────────────────

  private renderEngineDefaults(config: any): HTMLElement {
    const section = document.createElement('div')
    section.innerHTML = '<h2>Engine Defaults</h2><p class="desc">Global agent settings.</p>'

    const roundsField = mkField('Max Tool Rounds')
    const roundsInp = mkInput(String(config.max_tool_rounds ?? 25), '25')
    roundsInp.type = 'number'
    roundsField.appendChild(roundsInp)
    section.appendChild(roundsField)

    const timeoutField = mkField('Tool Timeout (seconds)')
    const timeoutInp = mkInput(String(config.tool_timeout_secs ?? 30), '30')
    timeoutInp.type = 'number'
    timeoutField.appendChild(timeoutInp)
    section.appendChild(timeoutField)

    const ctxField = mkField('Context Window (tokens)')
    const ctxInp = mkInput(String(config.context_window_tokens ?? 32000), '32000')
    ctxInp.type = 'number'
    ctxField.appendChild(ctxInp)
    section.appendChild(ctxField)

    const budgetField = mkField('Daily Budget (USD, 0 = unlimited)')
    const budgetInp = mkInput(String(config.daily_budget_usd ?? 0), '0')
    budgetInp.type = 'number'
    budgetField.appendChild(budgetInp)
    section.appendChild(budgetField)

    const saveBtn = document.createElement('button')
    saveBtn.className = 'btn btn-p'
    saveBtn.textContent = 'Save Defaults'
    saveBtn.addEventListener('click', async () => {
      try {
        await invoke('engine_set_config', {
          config: {
            ...config,
            max_tool_rounds: parseInt(roundsInp.value) || 25,
            tool_timeout_secs: parseInt(timeoutInp.value) || 30,
            context_window_tokens: parseInt(ctxInp.value) || 32000,
            daily_budget_usd: parseFloat(budgetInp.value) || 0,
          }
        })
        toast('Defaults saved')
      } catch (e) { toast(`Error: ${e}`) }
    })
    section.appendChild(saveBtn)
    return section
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mkField(label: string): HTMLElement {
  const d = document.createElement('div')
  d.className = 'field'
  const l = document.createElement('label')
  l.textContent = label
  d.appendChild(l)
  return d
}

function mkInput(value: string, placeholder: string): HTMLInputElement {
  const i = document.createElement('input')
  i.className = 'inp'
  i.value = value
  i.placeholder = placeholder
  return i
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerOpideSettingsPane(): void {
  try {
    const registry = Registry.as<any>(PreferencesExtensions.PreferencesEditorPane)
    registry.registerPreferencesEditorPane({
      id: 'opide.ai.settings',
      title: 'OPIDE AI',
      order: 100,
      ctorDescriptor: new SyncDescriptor(OpideAISettingsPane),
    })
    console.log('[opide] registered OPIDE AI settings pane')
  } catch (e) {
    console.warn('[opide] failed to register settings pane (falling back):', e)
    // Fallback: settings pane couldn't register — user can still use Cmd+, with basic config
  }
}
