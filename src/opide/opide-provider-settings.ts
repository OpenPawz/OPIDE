/**
 * OPIDE Provider Settings — Read-only overview in VS Code Settings (Cmd+,)
 *
 * Shows configured providers at a glance. All management (add/edit/remove)
 * happens in the Chat panel's provider settings (gear icon).
 */

import { invoke } from '@tauri-apps/api/core'
import { Registry } from '@codingame/monaco-vscode-api/vscode/vs/platform/registry/common/platform'
import { Extensions as PreferencesExtensions } from '@codingame/monaco-vscode-preferences-service-override/vscode/vs/workbench/contrib/preferences/browser/preferencesEditorRegistry'
import { SyncDescriptor } from '@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/descriptors'

// ─── Styles ──────────────────────────────────────────────────────────────────

const STYLES = `
  .opide-prov { font-family:var(--opide-font-ui); color:#ccc; padding:16px; max-width:720px; }
  .opide-prov h2 { font-size:16px; font-weight:600; color:#fff; margin:20px 0 6px; }
  .opide-prov h2:first-child { margin-top:0; }
  .opide-prov p.desc { font-size:11px; color:#888; margin:0 0 12px; }
  .opide-prov table { width:100%; border-collapse:collapse; font-size:12px; margin-bottom:16px; }
  .opide-prov th { text-align:left; padding:6px 10px; border-bottom:1px solid #333; color:#888; font-weight:500; }
  .opide-prov td { padding:6px 10px; border-bottom:1px solid #2a2a2a; }
  .opide-prov .dot { width:7px; height:7px; border-radius:50%; display:inline-block; margin-right:5px; }
  .opide-prov .dot-g { background:#2ea043; }
  .opide-prov .dot-r { background:#da3633; }
  .opide-prov .dot-y { background:#d29922; }
  .opide-prov .badge { font-size:9px; padding:2px 6px; border-radius:8px; background:#E8B931; color:#000; font-weight:600; }
  .opide-prov .empty { padding:20px; text-align:center; border:1px dashed #3c3c3c; border-radius:6px; color:#888; font-size:12px; }
  .opide-prov .hint { margin-top:16px; padding:10px 14px; background:#1e1e1e; border:1px solid #3c3c3c; border-radius:6px; font-size:11px; color:#888; }
  .opide-prov .hint strong { color:#E8B931; }
`

const PROVIDER_LABELS: Record<string, string> = {
  ollama: 'Ollama (local)', openai: 'OpenAI', anthropic: 'Anthropic',
  google: 'Google', deepseek: 'DeepSeek', moonshot: 'Moonshot (Kimi)',
  grok: 'xAI (Grok)', xai: 'xAI (Grok)', mistral: 'Mistral',
  openrouter: 'OpenRouter', azure_foundry: 'Azure AI Foundry',
  claudecode: 'Claude Code (Max)', custom: 'Custom',
}

// ─── Pane Class ──────────────────────────────────────────────────────────────

class OpideAISettingsPane {
  private root: HTMLElement
  private content: HTMLElement
  private disposed = false

  constructor() {
    this.root = document.createElement('div')
    this.root.className = 'opide-prov'

    const style = document.createElement('style')
    style.textContent = STYLES
    this.root.appendChild(style)

    this.content = document.createElement('div')
    this.root.appendChild(this.content)

    this.loadAndRender()
  }

  getDomNode(): HTMLElement { return this.root }
  layout(): void {}
  search(): void {}

  dispose(): void {
    this.disposed = true
    this.root.remove()
  }

  // ─── Load & Render (once) ──────────────────────────────────────────────

  private async loadAndRender(): Promise<void> {
    this.content.textContent = 'Loading…'

    let config: any
    try {
      config = await invoke('engine_get_config')
    } catch (e) {
      if (this.disposed) return
      const err = document.createElement('p')
      err.style.color = '#f85149'
      err.textContent = `Failed to load config: ${e}`
      this.content.textContent = ''
      this.content.appendChild(err)
      return
    }

    if (this.disposed) return
    this.content.textContent = ''

    const providers: any[] = config.providers ?? []

    // Header
    const header = document.createElement('div')
    header.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 0;margin-bottom:16px;border-bottom:1px solid #333'

    const img = document.createElement('img')
    img.src = `${window.location.origin}/brand-paw.png`
    img.alt = 'OPIDE'
    img.style.cssText = 'width:36px;height:36px'
    header.appendChild(img)

    const titleWrap = document.createElement('div')
    const title = document.createElement('div')
    title.style.cssText = 'font-size:16px;font-weight:600;color:#E8B931;letter-spacing:0.05em'
    title.textContent = 'OPIDE AI'
    const subtitle = document.createElement('div')
    subtitle.style.cssText = 'font-size:11px;color:#888'
    subtitle.textContent = 'Powered by OpenPawz Engine'
    titleWrap.appendChild(title)
    titleWrap.appendChild(subtitle)
    header.appendChild(titleWrap)
    this.content.appendChild(header)

    // Section heading
    const h2 = document.createElement('h2')
    h2.textContent = 'Configured Providers'
    this.content.appendChild(h2)

    const desc = document.createElement('p')
    desc.className = 'desc'
    desc.textContent = 'Read-only overview. To add, edit, or remove providers, use the gear icon in the Chat panel.'
    this.content.appendChild(desc)

    // Provider table or empty state
    if (!providers.length) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = 'No providers configured. Open the Chat panel and click the gear icon to add one.'
      this.content.appendChild(empty)
    } else {
      const table = document.createElement('table')
      const thead = document.createElement('thead')
      thead.innerHTML = '<tr><th>Provider</th><th>Type</th><th>Model</th><th>Status</th></tr>'
      table.appendChild(thead)

      const tbody = document.createElement('tbody')
      for (const p of providers) {
        const tr = document.createElement('tr')

        // Provider name + default badge
        const tdName = document.createElement('td')
        const strong = document.createElement('strong')
        strong.textContent = p.id
        tdName.appendChild(strong)
        if (p.id === config.default_provider) {
          const badge = document.createElement('span')
          badge.className = 'badge'
          badge.textContent = 'default'
          badge.style.marginLeft = '6px'
          tdName.appendChild(badge)
        }
        tr.appendChild(tdName)

        // Type
        const tdType = document.createElement('td')
        tdType.style.color = '#888'
        tdType.textContent = PROVIDER_LABELS[p.kind] ?? p.kind
        tr.appendChild(tdType)

        // Model
        const tdModel = document.createElement('td')
        tdModel.style.cssText = 'font-family:var(--opide-font-mono);font-size:10px'
        tdModel.textContent = p.default_model || '—'
        tr.appendChild(tdModel)

        // Status
        const tdStatus = document.createElement('td')
        const dot = document.createElement('span')
        const hasKey = !!p.api_key
        const isLocal = p.kind === 'ollama'
        const isCli = p.kind === 'claudecode'
        dot.className = `dot ${hasKey ? 'dot-g' : (isLocal || isCli) ? 'dot-y' : 'dot-r'}`
        tdStatus.appendChild(dot)
        tdStatus.appendChild(document.createTextNode(
          hasKey ? 'Key set' : isCli ? 'CLI (Max)' : isLocal ? 'Local' : 'No key'
        ))
        tr.appendChild(tdStatus)

        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      this.content.appendChild(table)
    }

    // Engine info
    const h2engine = document.createElement('h2')
    h2engine.textContent = 'Engine'
    this.content.appendChild(h2engine)

    const engineInfo = document.createElement('table')
    const eTbody = document.createElement('tbody')
    // B71: read context_window_tokens from the engine config when present;
    // fall back to a clearly-labeled estimate when the field is missing.
    const ctxLabel = typeof config.context_window_tokens === 'number'
      ? `${config.context_window_tokens.toLocaleString()} tokens`
      : '32,000 tokens (default)'
    const fields = [
      ['Default Model', config.default_model || '—'],
      ['Context Window', ctxLabel],
      ['Max Tool Rounds', String(config.max_tool_rounds ?? 25)],
    ]
    for (const [label, value] of fields) {
      const tr = document.createElement('tr')
      const tdLabel = document.createElement('td')
      tdLabel.style.color = '#888'
      tdLabel.textContent = label
      const tdValue = document.createElement('td')
      tdValue.style.cssText = 'font-family:var(--opide-font-mono);font-size:11px'
      tdValue.textContent = value
      tr.appendChild(tdLabel)
      tr.appendChild(tdValue)
      eTbody.appendChild(tr)
    }
    engineInfo.appendChild(eTbody)
    this.content.appendChild(engineInfo)

    // Hint
    const hint = document.createElement('div')
    hint.className = 'hint'
    hint.innerHTML = 'To manage providers, model routing, and engine settings — open the <strong>Chat panel</strong> and click the <strong>gear icon</strong>.'
    this.content.appendChild(hint)
  }
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
  } catch (e) {
    console.warn('[opide] failed to register settings pane:', e)
  }
}
