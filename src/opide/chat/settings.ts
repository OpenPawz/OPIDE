/**
 * OPIDE Chat — Provider Settings
 *
 * Provider configuration UI: tabs, API key input, model discovery, save.
 */

import { invoke } from '@tauri-apps/api/core'
import { S } from './state.ts'
import { renderMessagesFull } from './render.ts'

// ─── Provider Definitions ────────────────────────────────────────────────────

export const PROVIDER_DEFS = [
  { id: 'anthropic',  label: 'Anthropic',  placeholder: 'sk-ant-...', url: 'https://api.anthropic.com',                             models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'] },
  { id: 'openai',     label: 'OpenAI',     placeholder: 'sk-...',     url: 'https://api.openai.com/v1',                             models: ['gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'] },
  { id: 'google',     label: 'Google',     placeholder: 'AIza...',    url: 'https://generativelanguage.googleapis.com/v1beta',      models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'] },
  { id: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-...', url: 'https://openrouter.ai/api/v1',                          models: ['anthropic/claude-opus-4', 'google/gemini-2.5-pro', 'deepseek/deepseek-r1'] },
  { id: 'moonshot',   label: 'Moonshot',   placeholder: 'sk-...',     url: 'https://api.moonshot.ai/v1',                            models: ['kimi-k2', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'] },
  { id: 'deepseek',   label: 'DeepSeek',   placeholder: 'sk-...',     url: 'https://api.deepseek.com',                              models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'xai',        label: 'xAI (Grok)', placeholder: 'xai-...',    url: 'https://api.x.ai/v1',                                   models: ['grok-3', 'grok-3-mini', 'grok-2'] },
  { id: 'mistral',    label: 'Mistral',    placeholder: 'sk-...',     url: 'https://api.mistral.ai/v1',                             models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'] },
  { id: 'ollama',     label: 'Ollama',     placeholder: '(no key)',   url: 'http://localhost:11434',                                models: ['llama3.2', 'llama3.1:70b', 'qwen2.5-coder', 'deepseek-coder-v2'] },
  { id: 'claudecode', label: 'Claude Code', placeholder: '(no key)',  url: '',                                                      models: ['sonnet', 'opus', 'haiku'] },
  { id: 'custom',     label: 'Custom',     placeholder: 'sk-...',     url: '',                                                      models: [] },
]

// ─── Input Helpers ───────────────────────────────────────────────────────────

function inp(style = ''): HTMLInputElement {
  const i = document.createElement('input')
  i.style.cssText = `background:var(--vscode-input-background,#1e1e1e);color:var(--vscode-input-foreground,#ccc);border:1px solid var(--vscode-input-border,#3c3c3c);border-radius:4px;padding:6px 8px;font-size:12px;outline:none;width:100%;box-sizing:border-box;${style}`
  i.addEventListener('focus', () => { i.style.borderColor = '#E8B931' })
  i.addEventListener('blur',  () => { i.style.borderColor = 'var(--vscode-input-border,#3c3c3c)' })
  return i
}

function lbl(text: string): HTMLElement {
  const l = document.createElement('div')
  l.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:3px;margin-top:8px'
  l.textContent = text
  return l
}

// ─── Provider Check ──────────────────────────────────────────────────────────

export async function checkProviders(): Promise<void> {
  try {
    const config = await invoke<any>('engine_get_config')
    S.needsProviderSetup = !config?.providers?.length
  } catch {
    S.needsProviderSetup = true
  }
}

// ─── Provider Setup UI ───────────────────────────────────────────────────────

export function renderProviderSetup(): void {
  if (!S.msgList) return
  S.msgList.innerHTML = ''

  const wrap = document.createElement('div')
  wrap.style.cssText = 'padding:12px;display:flex;flex-direction:column;gap:0;overflow-y:auto;height:100%'

  const header = document.createElement('div')
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px'
  header.innerHTML = '<span style="font-size:13px;font-weight:600;color:var(--vscode-foreground)">AI Providers</span>'
  const backBtn = document.createElement('button')
  backBtn.textContent = '← Back to chat'
  backBtn.style.cssText = 'background:transparent;border:none;cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 4px'
  backBtn.addEventListener('click', () => { S.needsProviderSetup = false; renderMessagesFull() })
  header.appendChild(backBtn)
  wrap.appendChild(header)

  const tabs = document.createElement('div')
  tabs.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px'

  let selectedProvDef = PROVIDER_DEFS[0]
  const configArea = document.createElement('div')
  // Generation guard: rapid tab clicks fire overlapping async builds; without
  // this each cleared configArea and appended its own content, leaving two
  // providers' fields interleaved. Only the latest build renders.
  let buildGen = 0

  async function buildConfigArea(pDef: typeof PROVIDER_DEFS[0]): Promise<void> {
    const gen = ++buildGen

    // Load existing saved provider data
    let existing: any = null
    try {
      const config = await invoke<any>('engine_get_config')
      existing = config?.providers?.find((p: any) => p.id === pDef.id) ?? null
    } catch { /* no config yet */ }
    if (gen !== buildGen) return // superseded by a newer tab click

    configArea.innerHTML = ''

    const keyLabel = lbl('API Key')
    configArea.appendChild(keyLabel)
    const keyInp = inp()
    keyInp.type = 'password'
    keyInp.placeholder = pDef.placeholder
    if (existing?.api_key) keyInp.value = existing.api_key
    configArea.appendChild(keyInp)

    const urlLabel = lbl('Base URL')
    configArea.appendChild(urlLabel)
    const urlInp = inp()
    urlInp.value = existing?.base_url || pDef.url
    urlInp.placeholder = 'https://api.example.com/v1'
    configArea.appendChild(urlInp)

    if (pDef.id === 'claudecode') {
      keyLabel.style.display = 'none'; keyInp.style.display = 'none'
      urlLabel.style.display = 'none'; urlInp.style.display = 'none'
    }

    configArea.appendChild(lbl('Model'))
    const modelInp = inp()
    modelInp.placeholder = 'Type or click a preset below'
    if (existing?.default_model) modelInp.value = existing.default_model
    configArea.appendChild(modelInp)

    // Model selection: click to set default, checkboxes to enable in dropdown
    let existingEnabled: string[] | null = null
    if (existing?.enabled_models?.length) existingEnabled = existing.enabled_models
    const enabledSet = new Set<string>(existingEnabled ?? pDef.models)
    if (pDef.models.length) {
      configArea.appendChild(lbl('Available Models (check to show in selector, click to set default)'))
      const presets = document.createElement('div')
      presets.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-top:4px'
      for (const m of pDef.models) {
        const row = document.createElement('label')
        row.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;color:var(--vscode-foreground,#ccc)'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = enabledSet.has(m)
        cb.style.cssText = 'accent-color:#E8B931;cursor:pointer'
        cb.addEventListener('change', () => {
          if (cb.checked) enabledSet.add(m)
          else enabledSet.delete(m)
        })
        const nameBtn = document.createElement('span')
        nameBtn.textContent = m
        nameBtn.style.cssText = 'cursor:pointer;padding:2px 6px;border-radius:8px;transition:background 0.15s'
        nameBtn.addEventListener('click', () => {
          modelInp.value = m
          presets.querySelectorAll('span').forEach(s => { (s as HTMLElement).style.background = 'transparent'; (s as HTMLElement).style.color = 'var(--vscode-foreground,#ccc)' })
          nameBtn.style.background = '#E8B931'; nameBtn.style.color = '#000'
        })
        row.appendChild(cb)
        row.appendChild(nameBtn)
        presets.appendChild(row)
      }
      configArea.appendChild(presets)
    }

    const discoverBtn = document.createElement('button')
    discoverBtn.textContent = 'Discover Models'
    discoverBtn.style.cssText = 'margin-top:8px;background:transparent;color:var(--vscode-descriptionForeground);border:1px solid var(--vscode-input-border,#3c3c3c);border-radius:4px;padding:5px 10px;font-size:11px;cursor:pointer;width:100%'
    discoverBtn.addEventListener('click', async () => {
      discoverBtn.textContent = 'Discovering…'
      discoverBtn.disabled = true
      try {
        await invoke('engine_upsert_provider', {
          provider: { id: pDef.id, name: pDef.label, kind: pDef.id, api_key: keyInp.value.trim(), base_url: urlInp.value.trim() }
        })
        // The backend returns objects ({ id, name, context_window, max_output }),
        // not bare strings. Normalise to a string id/label so chips don't render
        // as "[object Object]".
        type DiscoveredModel = string | { id?: string; name?: string }
        const raw = await invoke<DiscoveredModel[]>('engine_list_provider_models', { providerId: pDef.id })
        const modelIdOf = (m: DiscoveredModel): string =>
          typeof m === 'string' ? m : (m?.id || m?.name || '')
        const modelLabelOf = (m: DiscoveredModel): string =>
          typeof m === 'string' ? m : (m?.name || m?.id || '')
        const models = raw
          .map((m) => ({ id: modelIdOf(m), label: modelLabelOf(m) }))
          .filter((m) => m.id)
        discoverBtn.textContent = `${models.length} models found`

        const chips = document.createElement('div')
        chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:8px'
        for (const m of models.slice(0, 40)) {
          const c = document.createElement('button')
          c.textContent = m.label
          c.style.cssText = 'background:var(--vscode-input-background,#1e1e1e);color:var(--vscode-input-foreground,#ccc);border:1px solid var(--vscode-input-border,#3c3c3c);border-radius:10px;padding:2px 8px;font-size:10px;cursor:pointer'
          c.addEventListener('click', () => {
            modelInp.value = m.id
            // Ensure the picked model survives Save — without this it would be
            // set as default but absent from `enabled_models`, hidden from the
            // model-selector dropdown after save.
            enabledSet.add(m.id)
            chips.querySelectorAll('button').forEach(b => { (b as HTMLElement).style.background = 'var(--vscode-input-background,#1e1e1e)'; (b as HTMLElement).style.color = 'var(--vscode-input-foreground,#ccc)' })
            c.style.background = '#E8B931'
            c.style.color = '#000'
          })
          chips.appendChild(c)
        }
        const existing = configArea.querySelector('.model-chips')
        existing?.remove()
        chips.classList.add('model-chips')
        configArea.insertBefore(chips, saveBtn)
      } catch (e) {
        // Some providers (Claude Code CLI, Google) don't support live model
        // listing. That's not a real error — the built-in preset checkboxes
        // above already cover them — so keep the message soft and re-enable.
        const msg = String(e)
        const soft = /unsupported|not support|transport error|list_models/i.test(msg)
        discoverBtn.textContent = soft
          ? 'No live list — use the presets above'
          : `Error: ${msg.slice(0, 60)}`
        discoverBtn.disabled = false
      }
    })
    configArea.appendChild(discoverBtn)

    const saveBtn = document.createElement('button')
    saveBtn.textContent = 'Save Provider'
    saveBtn.style.cssText = 'margin-top:10px;background:#E8B931;color:#000;border:none;border-radius:4px;padding:8px;font-size:12px;font-weight:600;cursor:pointer;width:100%'
    saveBtn.addEventListener('click', async () => {
      const key = keyInp.value.trim()
      const url = urlInp.value.trim()
      const model = modelInp.value.trim()
      if (!key && pDef.id !== 'ollama' && pDef.id !== 'claudecode') { saveBtn.textContent = 'Enter an API key'; setTimeout(() => { saveBtn.textContent = 'Save Provider' }, 2000); return }
      if (!model) { saveBtn.textContent = 'Select or type a model'; setTimeout(() => { saveBtn.textContent = 'Save Provider' }, 2000); return }
      saveBtn.textContent = 'Saving…'
      saveBtn.disabled = true
      try {
        await invoke('engine_upsert_provider', {
          provider: { id: pDef.id, name: pDef.label, kind: pDef.id, api_key: key, base_url: url, default_model: model, enabled_models: Array.from(enabledSet) }
        })
        const config = await invoke<any>('engine_get_config')
        await invoke('engine_set_config', { config: { ...config, default_provider: pDef.id, default_model: model } })
        S.selectedModel = model
        S.needsProviderSetup = false
        // Refresh the top-bar model dropdown so the just-enabled models (and
        // the new default) appear immediately — previously they only showed
        // up after an app restart.
        import('./index.ts').then(({ updateModelSelect }) => updateModelSelect()).catch(() => {})
        renderMessagesFull()
        S.textarea?.focus()
      } catch (e) {
        saveBtn.textContent = `Error: ${String(e).slice(0, 60)}`
        saveBtn.disabled = false
      }
    })
    configArea.appendChild(saveBtn)
  }

  for (const pDef of PROVIDER_DEFS) {
    const tab = document.createElement('button')
    tab.textContent = pDef.label
    tab.style.cssText = `background:${pDef === selectedProvDef ? '#E8B931' : 'var(--vscode-input-background,#1e1e1e)'};color:${pDef === selectedProvDef ? '#000' : 'var(--vscode-foreground)'};border:1px solid var(--vscode-input-border,#3c3c3c);border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer`
    tab.addEventListener('click', () => {
      selectedProvDef = pDef
      tabs.querySelectorAll('button').forEach(b => { (b as HTMLElement).style.background = 'var(--vscode-input-background,#1e1e1e)'; (b as HTMLElement).style.color = 'var(--vscode-foreground)' })
      tab.style.background = '#E8B931'; tab.style.color = '#000'
      buildConfigArea(pDef)
    })
    tabs.appendChild(tab)
  }

  wrap.appendChild(tabs)
  wrap.appendChild(configArea)
  buildConfigArea(selectedProvDef)
  S.msgList.appendChild(wrap)
}
