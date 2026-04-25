/**
 * OPIDE Chat — Panel Registration & Entry Point
 *
 * registerOpideChat() creates the VS Code custom view panel,
 * wires up DOM elements, and loads initial data.
 *
 * Re-exports registerOpideChat as the public API for workbench.ts.
 */

import { marked } from 'marked'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  registerCustomView,
  ViewContainerLocation,
} from '@codingame/monaco-vscode-workbench-service-override'

import { S } from './state.ts'
import type { Agent, Session, StoredMessage, ApprovalMode } from './types.ts'
import {
  renderMessages,
  renderMessagesFull,
  updateAgentSelect,
  updateSessionSelect,
  updateContextPills,
  renderAttachBar,
  clearPlanProgress,
  openPathInEditor,
  updateStatus,
} from './render.ts'
import { ensureListening, initProgressListener } from './streaming.ts'
import { checkProviders, renderProviderSetup } from './settings.ts'
import { doSend, doAbort, doWhisper, doResume } from './send.ts'

marked.setOptions({ async: false, breaks: true, gfm: true })

// ─── Data Loading ────────────────────────────────────────────────────────────

async function loadAgents(): Promise<void> {
  try {
    S.agents = await invoke<Agent[]>('engine_list_all_agents')
    updateAgentSelect()
  } catch (e) {
    console.warn('[opide-chat] failed to load agents:', e)
    S.agents = []
  }
}

export async function loadSessions(): Promise<void> {
  try {
    const all = await invoke<Session[]>('engine_sessions_list')
    // Hide the persistent ghost-completion session from the selector (B49).
    S.sessions = all.filter(s => s.id !== '__opide_completions__')
    updateSessionSelect()
  } catch (e) {
    console.warn('[opide-chat] failed to load sessions:', e)
    S.sessions = []
  }
}

async function loadHistory(): Promise<void> {
  if (!S.sessionId) return
  try {
    const stored = await invoke<StoredMessage[]>('engine_chat_history', {
      sessionId: S.sessionId,
      limit: 200,
    })
    S.messages = stored
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        ts: new Date(m.created_at),
        messageId: m.id,
      }))
    renderMessages()
  } catch { /* no history yet */ }
}

async function loadModels(): Promise<void> {
  try {
    const config = await invoke<any>('engine_get_config')
    S.selectedModel = config?.default_model || null
    if (S.modelSelect && S.selectedModel) {
      const opt = document.createElement('option')
      opt.value = S.selectedModel
      opt.textContent = S.selectedModel
      opt.selected = true
      S.modelSelect.appendChild(opt)
    }
    const models = await invoke<string[]>('engine_list_provider_models', { providerId: '' }).catch(() => [])
    if (S.modelSelect && models.length) {
      S.modelSelect.innerHTML = ''
      for (const m of models) {
        const opt = document.createElement('option')
        opt.value = m
        opt.textContent = m
        opt.selected = m === S.selectedModel
        S.modelSelect.appendChild(opt)
      }
    }
  } catch { /* config not ready */ }
}

async function updateModelSelect(): Promise<void> {
  if (!S.modelSelect) return
  try {
    const config = await invoke<any>('engine_get_config')
    const providers: any[] = config?.providers ?? []
    const current = S.selectedModel

    const models = new Set<string>()
    if (config?.default_model) models.add(config.default_model)
    for (const p of providers) {
      if (p.default_model) models.add(p.default_model)
    }
    const PRESETS: Record<string, string[]> = {
      anthropic: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
      openai: ['gpt-5.4', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
      google: ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
      moonshot: ['kimi-k2', 'moonshot-v1-128k'],
      deepseek: ['deepseek-chat', 'deepseek-reasoner'],
      claudecode: ['sonnet', 'opus', 'haiku'],
    }
    for (const p of providers) {
      // If provider has enabled_models, only show those. Otherwise show all presets.
      const enabledModels: string[] | undefined = p.enabled_models
      if (enabledModels && enabledModels.length > 0) {
        for (const m of enabledModels) models.add(m)
      } else {
        for (const m of PRESETS[p.kind] ?? []) models.add(m)
      }
    }

    S.modelSelect.innerHTML = ''
    const autoOpt = document.createElement('option')
    autoOpt.value = ''; autoOpt.textContent = 'Auto'
    S.modelSelect.appendChild(autoOpt)
    for (const m of models) {
      const opt = document.createElement('option')
      opt.value = m; opt.textContent = m
      opt.selected = m === current
      S.modelSelect.appendChild(opt)
    }
    if (current && models.has(current)) S.selectedModel = current
  } catch { /* ignore */ }
}

// ─── Chat Styles ─────────────────────────────────────────────────────────────

const CHAT_STYLES = `
  /* ── Animations ──────────────────────────────────────────── */
  @keyframes opide-pulse { 0%,100%{opacity:0.2;transform:scaleY(0.8)} 50%{opacity:0.7;transform:scaleY(1.2)} }
  @keyframes opide-blink { 0%,100%{opacity:0} 50%{opacity:0.5} }
  @keyframes opide-slide-in { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
  @keyframes opide-glow-pulse { 0%,100% { box-shadow: 0 0 4px rgba(212,168,67,0.2) } 50% { box-shadow: 0 0 12px rgba(212,168,67,0.35) } }

  /* ── Chat container ──────────────────────────────────────── */
  .opide-chat-container {
    background: #0a0a0e !important;
  }

  /* ── Top bar ─────────────────────────────────────────────── */
  .opide-chat-topbar {
    background: #111116 !important;
    border-bottom: 1px solid #252530 !important;
    box-shadow: 0 3px 10px rgba(0,0,0,0.5) !important;
    padding: 10px 12px !important;
  }
  .opide-chat-topbar select {
    background: #1a1a22 !important;
    border: 1px solid #333340 !important;
    border-radius: 8px !important;
    color: #c0beb8 !important;
    padding: 6px 10px !important;
    font-size: 11px !important;
    transition: all 0.2s !important;
    cursor: pointer;
  }
  .opide-chat-topbar select:hover {
    border-color: #444455 !important;
  }
  .opide-chat-topbar select:focus {
    border-color: rgba(212,168,67,0.5) !important;
    box-shadow: 0 0 0 1px rgba(212,168,67,0.15), 0 0 12px rgba(212,168,67,0.08) !important;
    outline: none !important;
  }
  .opide-chat-topbar button {
    background: transparent !important;
    border: 1px solid #333340 !important;
    border-radius: 8px !important;
    width: 30px !important;
    height: 30px !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    cursor: pointer !important;
    color: #666 !important;
    transition: all 0.2s !important;
  }
  .opide-chat-topbar button:hover {
    border-color: rgba(212,168,67,0.4) !important;
    color: #d4a843 !important;
    box-shadow: 0 0 10px rgba(212,168,67,0.12) !important;
  }

  /* ── Tool execution bar ──────────────────────────────────── */
  .opide-chat-toolrow {
    background: linear-gradient(90deg, rgba(212,168,67,0.05) 0%, transparent 60%) !important;
    border-bottom: 1px solid rgba(212,168,67,0.1) !important;
    padding: 6px 12px !important;
  }

  /* ── Progress log ────────────────────────────────────────── */
  .opide-chat-progress {
    background: #08080c !important;
    border-bottom: 1px solid #1a1a24 !important;
  }

  /* ── Gold separator above input ──────────────────────────── */
  .opide-chat-separator {
    height: 1px;
    background: linear-gradient(90deg, transparent 5%, rgba(212,168,67,0.5) 30%, rgba(212,168,67,0.8) 50%, rgba(212,168,67,0.5) 70%, transparent 95%);
    box-shadow: 0 0 8px rgba(212,168,67,0.15), 0 0 20px rgba(212,168,67,0.05);
    flex-shrink: 0;
  }

  /* ── Input area ──────────────────────────────────────────── */
  .opide-chat-input-area {
    background: #0e0e14 !important;
    padding: 12px 12px 14px !important;
  }
  .opide-chat-input-row {
    background: #141420 !important;
    border: 1px solid #2a2a38 !important;
    border-radius: 14px !important;
    transition: all 0.25s !important;
    padding: 10px 14px !important;
  }
  .opide-chat-input-row:focus-within {
    border-color: rgba(212,168,67,0.5) !important;
    box-shadow: 0 0 0 1px rgba(212,168,67,0.1), 0 0 20px rgba(212,168,67,0.08), 0 0 40px rgba(212,168,67,0.03) !important;
  }

  /* ── Send button — gold paw with glow ────────────────────── */
  .opide-chat-send {
    background: linear-gradient(135deg, #e8c55c 0%, #d4a843 60%, #b8922e 100%) !important;
    border: none !important;
    border-radius: 10px !important;
    width: 36px !important;
    height: 36px !important;
    box-shadow: 0 2px 8px rgba(212,168,67,0.35), 0 0 20px rgba(212,168,67,0.1) !important;
    transition: all 0.2s !important;
    cursor: pointer;
    position: relative;
  }
  .opide-chat-send:hover {
    box-shadow: 0 4px 20px rgba(212,168,67,0.5), 0 0 30px rgba(212,168,67,0.15) !important;
    transform: translateY(-2px) scale(1.08);
  }
  .opide-chat-send:active {
    transform: translateY(0) scale(0.96);
    box-shadow: 0 1px 4px rgba(212,168,67,0.3) !important;
  }

  /* ── User message bubble ─────────────────────────────────── */
  .opide-chat-user-bubble {
    background: #151520 !important;
    border: 1px solid rgba(212,168,67,0.2) !important;
    box-shadow: 0 2px 8px rgba(0,0,0,0.25) !important;
    animation: opide-slide-in 0.2s ease-out;
  }

  /* ── Assistant message — the main card with gold edge glow ── */
  .opide-chat-bubble {
    animation: opide-slide-in 0.25s ease-out;
    background: linear-gradient(180deg, rgba(212,168,67,0.06) 0%, rgba(16,16,22,0.95) 15%, #10101a 100%) !important;
    border: 1px solid rgba(212,168,67,0.15) !important;
    border-radius: 12px !important;
    padding: 16px 18px !important;
    margin: 4px 12px !important;
    box-shadow:
      0 0 15px rgba(212,168,67,0.05),
      0 4px 12px rgba(0,0,0,0.3),
      inset 0 1px 0 rgba(212,168,67,0.08) !important;
  }

  /* ── Assistant message bubble ─────────────────────────────── */
  .opide-chat-bubble {
    animation: opide-slide-in 0.25s ease-out;
  }
  .opide-chat-bubble ul, .opide-chat-bubble ol { padding-left: 20px; margin: 6px 0; }
  .opide-chat-bubble li { margin: 3px 0; line-height: 1.5; }
  .opide-chat-bubble h1, .opide-chat-bubble h2, .opide-chat-bubble h3 { margin: 14px 0 6px; color: #e8e6e1; }
  .opide-chat-bubble h1 { font-size: 16px; font-weight: 600; }
  .opide-chat-bubble h2 { font-size: 14px; font-weight: 600; }
  .opide-chat-bubble h3 { font-size: 13px; font-weight: 600; }
  .opide-chat-bubble p { margin: 5px 0; }
  .opide-chat-bubble pre {
    margin: 8px 0;
    padding: 12px 14px;
    border-radius: 8px;
    overflow-x: auto;
    background: #0e0e14 !important;
    border: 1px solid #2a2a35;
    box-shadow: inset 0 2px 6px rgba(0,0,0,0.4), 0 1px 0 rgba(255,255,255,0.02);
  }
  .opide-chat-bubble code { font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); }
  .opide-chat-bubble code:not(pre code) {
    padding: 2px 7px;
    border-radius: 4px;
    background: #1e1e28;
    border: 1px solid #2e2e3a;
    font-size: 11.5px;
  }
  .opide-chat-bubble table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; border: 1px solid #2a2a35; border-radius: 6px; overflow: hidden; }
  .opide-chat-bubble th, .opide-chat-bubble td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #2a2a35; }
  .opide-chat-bubble th { font-weight: 600; color: #e8e6e1; background: #1a1a24; }
  .opide-chat-bubble tr:hover td { background: rgba(255,255,255,0.02); }
  .opide-chat-bubble td { color: #a0a0a8; }
  .opide-chat-bubble blockquote { border-left: 2px solid rgba(212,168,67,0.3); padding-left: 12px; margin: 8px 0; color: #a0a0a8; }
  .opide-chat-bubble hr { border: none; border-top: 1px solid rgba(255,255,255,0.06); margin: 10px 0; }

  /* ── Tool result card ─────────────────────────────────────── */
  .opide-tool-card {
    background: #16161e !important;
    border: 1px solid #2a2a35;
    border-radius: 8px;
    margin: 2px 0;
    transition: all 0.15s;
  }
  .opide-tool-card:hover {
    background: #1c1c28 !important;
    border-color: #3a3a48;
    box-shadow: 0 2px 6px rgba(0,0,0,0.2);
  }

  /* ── Streaming cursor ────────────────────────────────────── */
  .opide-stream-cursor {
    display: inline-block;
    width: 2px;
    height: 15px;
    background: #d4a843;
    margin-left: 2px;
    vertical-align: text-bottom;
    border-radius: 1px;
    animation: opide-blink 0.8s step-end infinite;
    box-shadow: 0 0 4px rgba(212,168,67,0.3);
  }

  .opide-path-link:hover { filter:brightness(1.2) }

  /* ── Whisper row (mid-run inject) ────────────────────────── */
  .opide-whisper-row {
    display: none;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    background: rgba(100, 100, 200, 0.06);
    border: 1px solid rgba(120, 120, 220, 0.2);
    border-radius: 8px;
    margin-top: 4px;
  }
  .opide-whisper-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--vscode-input-foreground);
    font-size: 11px;
    font-family: var(--vscode-font-family);
    opacity: 0.8;
  }
  .opide-whisper-input::placeholder { opacity: 0.45; font-style: italic; }
  .opide-whisper-btn {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 2px 4px;
    color: rgba(150, 150, 220, 0.7);
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }
  .opide-whisper-btn:hover { color: rgba(180, 180, 255, 1); }
`

// ─── Panel Registration ──────────────────────────────────────────────────────

export function registerOpideChat(): void {
  ensureListening().catch(console.error)

  registerCustomView({
    id: 'opide.chat',
    name: 'OPIDE',
    location: ViewContainerLocation.AuxiliaryBar,
    icon: `${window.location.origin}/brand-paw.png`,
    order: 0,
    default: true,

    renderBody(container) {
      container.className = 'opide-chat-container'
      container.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden'

      // Inject chat styles once
      if (!document.getElementById('opide-chat-styles')) {
        const style = document.createElement('style')
        style.id = 'opide-chat-styles'
        style.textContent = CHAT_STYLES
        document.head.appendChild(style)
      }

      // ── Top Bar (agent, model, session selectors) ──────────────────────
      const topBar = document.createElement('div')
      topBar.className = 'opide-chat-topbar'
      topBar.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;padding:8px 10px;flex-shrink:0;align-items:center'

      // Session selector
      const sessionSel = document.createElement('select')
      sessionSel.style.cssText = 'flex:1;min-width:80px;padding:4px 8px;font-size:11px'
      sessionSel.addEventListener('change', async () => {
        if (S.streaming) await doAbort()
        S.surfaced = false; S.surfacedRound = 0
        if (S.resumeBtn) S.resumeBtn.style.display = 'none'
        const val = sessionSel.value
        if (val) {
          S.sessionId = val
          S.messages = []
          await loadHistory()
        } else {
          S.sessionId = null
          S.messages = []
          renderMessagesFull()
        }
      })
      S.sessionSelect = sessionSel
      topBar.appendChild(sessionSel)

      // Agent selector
      const agentSel = document.createElement('select')
      agentSel.style.cssText = 'min-width:80px;padding:4px 8px;font-size:11px'
      agentSel.addEventListener('change', () => {
        const val = agentSel.value
        if (!val) {
          S.selectedAgent = null
          return
        }
        // V2 build populates BUILTIN_AGENTS; OSS keeps it empty so we go
        // straight to the DB-agent lookup. The dynamic-import path below is
        // only meaningful when builtins exist.
        import('./send.ts').then(({ BUILTIN_AGENTS }) => {
          if (BUILTIN_AGENTS.length === 0) {
            S.selectedAgent = S.agents.find(a => a.agent_id === val) || null
            return
          }
          const builtin = (BUILTIN_AGENTS as any[]).find((a: any) => a.agent_id === val)
          if (builtin) {
            S.selectedAgent = {
              agent_id: builtin.agent_id,
              role: builtin.role,
              name: builtin.name,
              system_prompt: builtin.system_prompt,
            } as any
          } else {
            S.selectedAgent = S.agents.find(a => a.agent_id === val) || null
          }
        }).catch(() => {
          S.selectedAgent = S.agents.find(a => a.agent_id === val) || null
        })
      })
      S.agentSelect = agentSel
      topBar.appendChild(agentSel)

      // Model selector
      const modelSel = document.createElement('select')
      modelSel.style.cssText = 'min-width:60px;padding:4px 8px;font-size:11px'
      modelSel.innerHTML = '<option value="">Auto</option>'
      let modelSaving = false
      modelSel.addEventListener('change', async () => {
        if (modelSaving) return
        S.selectedModel = modelSel.value || null
        // Persist the model selection so it survives reload
        modelSaving = true
        try {
          const config = await invoke<any>('engine_get_config')
          await invoke('engine_set_config', {
            config: { ...config, default_model: S.selectedModel || undefined }
          })
        } catch (e) {
          console.warn('[opide-chat] Failed to persist model selection:', e)
        } finally {
          modelSaving = false
        }
      })
      S.modelSelect = modelSel
      topBar.appendChild(modelSel)

      // New chat button
      const newBtn = document.createElement('button')
      newBtn.title = 'New chat'
      newBtn.style.cssText = 'padding:0'
      newBtn.innerHTML = '<span class="codicon codicon-add" style="font-size:13px"></span>'
      newBtn.addEventListener('click', async () => {
        // Reset the agent's cognitive state and episodic memories so the new
        // chat starts completely fresh — no working memory or recalled findings
        // carry over from the previous run.
        const agentToReset = S.selectedAgent
        // Do NOT null selectedAgent — engine_agent_reset clears the cognitive
        // state for this agent, so the same agent_id starts fresh on the next
        // send. Nulling it would cause the next send to use "default" agent
        // while the dropdown still visually shows the old agent.
        S.sessionId = null
        S.completedRounds = 0
        S.streamAccum = ''
        S.surfaced = false
        S.surfacedRound = 0
        S.surfacedSummary = ''
        if (S.resumeBtn) S.resumeBtn.style.display = 'none'
        S.messages = []
        clearPlanProgress()
        renderMessagesFull()
        S.textarea?.focus()
        if (agentToReset) {
          try {
            await invoke('engine_agent_reset', { agentId: agentToReset.agent_id })
          } catch (e) {
            console.warn('[opide-chat] engine_agent_reset failed:', e)
          }
        }
      })
      topBar.appendChild(newBtn)

      // Providers / Settings button
      const settingsBtn = document.createElement('button')
      settingsBtn.title = 'Configure providers & models'
      settingsBtn.style.cssText = 'padding:0'
      settingsBtn.innerHTML = '<span class="codicon codicon-settings-gear" style="font-size:13px"></span>'
      settingsBtn.addEventListener('click', () => renderProviderSetup())
      topBar.appendChild(settingsBtn)

      container.appendChild(topBar)

      // ── Status + Tool indicator ────────────────────────────────────────
      const statusRow = document.createElement('div')
      statusRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:2px 8px;font-size:10px;color:var(--vscode-descriptionForeground);flex-shrink:0'

      const headerStatus = document.createElement('span')
      S.headerStatus = headerStatus
      statusRow.appendChild(headerStatus)

      const tokenDisp = document.createElement('span')
      tokenDisp.style.cssText = 'opacity:0.6'
      S.tokenDisplay = tokenDisp
      statusRow.appendChild(tokenDisp)

      container.appendChild(statusRow)

      const toolRow = document.createElement('div')
      toolRow.className = 'opide-chat-toolrow'
      toolRow.style.cssText = 'display:none;align-items:center;gap:6px;padding:4px 10px;font-size:11px;color:var(--vscode-descriptionForeground);flex-shrink:0'
      toolRow.innerHTML = '<span class="codicon codicon-loading codicon-modifier-spin" style="font-size:12px"></span><span class="opide-tool-label">Working…</span>'
      S.toolRow = toolRow
      container.appendChild(toolRow)

      // ── Progress log (sandbox ctx.log messages) ─────────────────────
      const progressLog = document.createElement('div')
      progressLog.className = 'opide-chat-progress'
      progressLog.style.cssText = 'display:none;padding:4px 12px 4px 28px;font-size:11px;max-height:120px;overflow-y:auto;flex-shrink:0'
      S.progressLog = progressLog
      container.appendChild(progressLog)

      initProgressListener().catch(console.warn)

      // ── Message list ───────────────────────────────────────────────────
      const msgList = document.createElement('div')
      msgList.style.cssText = 'flex:1;min-height:0;overflow-y:auto;padding:8px 0;display:flex;flex-direction:column;gap:2px'
      msgList.addEventListener('click', (e) => {
        const target = (e.target as HTMLElement).closest('[data-fspath]') as HTMLElement | null
        if (target?.dataset.fspath) openPathInEditor(target.dataset.fspath)
      })
      msgList.addEventListener('wheel', (e) => {
        e.stopPropagation()
        msgList.scrollTop += e.deltaY
      }, { passive: false })
      S.msgList = msgList
      container.appendChild(msgList)

      // ── Context pills bar ──────────────────────────────────────────────
      const contextBar = document.createElement('div')
      contextBar.style.cssText = 'display:none;flex-wrap:wrap;gap:4px;padding:4px 8px 2px;flex-shrink:0'
      S.contextBar = contextBar
      container.appendChild(contextBar)

      // ── Input area ─────────────────────────────────────────────────────
      const inputArea = document.createElement('div')
      inputArea.className = 'opide-chat-input-area'
      inputArea.style.cssText = 'padding:10px;display:flex;flex-direction:column;gap:6px;flex-shrink:0'

      // Options row (thinking level, auto-approve toggle)
      const optionsRow = document.createElement('div')
      optionsRow.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:10px;color:var(--vscode-descriptionForeground)'

      const thinkingLabel = document.createElement('span')
      thinkingLabel.textContent = 'Thinking:'
      optionsRow.appendChild(thinkingLabel)

      const thinkingSel = document.createElement('select')
      thinkingSel.style.cssText = 'background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#333);border-radius:3px;padding:1px 3px;font-size:10px'
      thinkingSel.innerHTML = '<option value="none" selected>None</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>'
      thinkingSel.addEventListener('change', () => { S.thinkingLevel = thinkingSel.value })
      optionsRow.appendChild(thinkingSel)

      // Plan mode toggle
      const planBtn = document.createElement('button')
      planBtn.title = 'Plan mode: agent writes a plan for approval before executing'
      planBtn.style.cssText = 'display:flex;align-items:center;gap:3px;background:transparent;border:1px solid var(--vscode-widget-border,#444);border-radius:4px;padding:1px 6px;font-size:10px;cursor:pointer;color:var(--vscode-descriptionForeground);transition:all 0.15s'
      planBtn.innerHTML = '<span class="codicon codicon-list-tree" style="font-size:11px"></span> Plan'
      function updatePlanBtn() {
        planBtn.style.background = S.planMode ? 'var(--vscode-button-background)' : 'transparent'
        planBtn.style.color = S.planMode ? 'var(--vscode-button-foreground)' : 'var(--vscode-descriptionForeground)'
        planBtn.style.borderColor = S.planMode ? 'var(--vscode-button-background)' : 'var(--vscode-widget-border,#444)'
        if (S.textarea) S.textarea.placeholder = S.planMode ? 'Describe what you want built… (agent will plan first)' : 'Ask OPIDE anything… (Cmd+L)'
      }
      planBtn.addEventListener('click', () => { S.planMode = !S.planMode; updatePlanBtn() })
      updatePlanBtn()
      optionsRow.appendChild(planBtn)

      // Approval mode selector
      const approvalWrap = document.createElement('div')
      approvalWrap.style.cssText = 'display:flex;align-items:center;gap:2px;margin-left:auto;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,#333);border-radius:4px;overflow:hidden'
      const approvalModes: { mode: ApprovalMode; label: string; title: string }[] = [
        { mode: 'ask',  label: 'Ask',  title: 'Ask before every tool call' },
        { mode: 'auto', label: 'Auto', title: 'Auto-approve safe tools, ask for dangerous' },
        { mode: 'yolo', label: 'Yolo', title: 'Auto-approve everything' },
      ]
      const approvalBtns: HTMLButtonElement[] = []
      function setApprovalMode(m: ApprovalMode) {
        S.approvalMode = m
        approvalBtns.forEach((b, i) => {
          const active = approvalModes[i].mode === m
          b.style.background = active ? 'var(--vscode-button-background)' : 'transparent'
          b.style.color = active ? 'var(--vscode-button-foreground)' : 'var(--vscode-descriptionForeground)'
          b.style.fontWeight = active ? '600' : '400'
        })
      }
      for (const { mode, label, title } of approvalModes) {
        const btn = document.createElement('button')
        btn.textContent = label
        btn.title = title
        btn.style.cssText = 'border:none;cursor:pointer;padding:1px 6px;font-size:10px;transition:all 0.1s'
        btn.addEventListener('click', () => setApprovalMode(mode))
        approvalBtns.push(btn)
        approvalWrap.appendChild(btn)
      }
      setApprovalMode(S.approvalMode)
      optionsRow.appendChild(approvalWrap)

      inputArea.appendChild(optionsRow)

      // Text input row
      const inputRow = document.createElement('div')
      inputRow.className = 'opide-chat-input-row'
      inputRow.style.cssText = 'display:flex;align-items:flex-end;gap:6px;padding:8px 10px'

      const textarea = document.createElement('textarea')
      textarea.rows = 1
      textarea.placeholder = 'Ask OPIDE anything… (Cmd+L)'
      textarea.style.cssText = 'flex:1;background:transparent;border:none;outline:none;resize:none;color:var(--vscode-input-foreground);font-size:13px;font-family:var(--vscode-font-family);line-height:1.4;min-height:20px;max-height:120px;overflow-y:auto;padding:0'
      let _heightTimer: ReturnType<typeof setTimeout> | null = null
      textarea.addEventListener('input', () => {
        if (_heightTimer) return
        _heightTimer = setTimeout(() => {
          _heightTimer = null
          // Measure scrollHeight without collapsing to 'auto' first —
          // collapsing causes a layout reflow that can trigger VS Code's focus manager.
          const target = Math.min(textarea.scrollHeight, 120)
          if (Math.abs(textarea.offsetHeight - target) > 2) {
            textarea.style.height = target + 'px'
          }
        }, 50)
      })
      textarea.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend() } })
      textarea.addEventListener('focus', () => { updateContextPills() })

      // ── Focus theft protection ──
      // VS Code's workbench aggressively reclaims focus for the active editor.
      // When the user is actively typing in the chat textarea, we must prevent
      // any external focus steal. We detect "active typing" by tracking recent
      // input events and immediately reclaim focus if it's stolen mid-type.
      let _lastInputTime = 0
      textarea.addEventListener('input', () => { _lastInputTime = Date.now() })
      textarea.addEventListener('blur', () => {
        // If the user typed within the last 2 seconds, reclaim focus.
        // This prevents VS Code's focus manager from stealing focus mid-sentence.
        if (Date.now() - _lastInputTime < 2000 && textarea.value.length > 0) {
          requestAnimationFrame(() => textarea.focus())
        }
      })
      S.textarea = textarea

      const sendBtn = document.createElement('button')
      sendBtn.title = 'Send (Enter)'
      sendBtn.className = 'opide-chat-send'
      sendBtn.style.cssText = 'display:flex;align-items:center;justify-content:center;color:#000;width:28px;height:28px;cursor:pointer;flex-shrink:0'
      sendBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>'
      sendBtn.addEventListener('click', doSend)
      S.sendBtn = sendBtn

      const stopBtn = document.createElement('button')
      stopBtn.title = 'Stop generation'
      stopBtn.style.cssText = 'display:none;align-items:center;justify-content:center;background:#da3633;color:white;border:none;border-radius:4px;width:26px;height:26px;cursor:pointer;flex-shrink:0'
      stopBtn.innerHTML = '<span class="codicon codicon-debug-stop" style="font-size:14px"></span>'
      stopBtn.addEventListener('click', doAbort)
      S.stopBtn = stopBtn

      const surfaceBtn = document.createElement('button')
      surfaceBtn.title = 'Pause agent and surface findings for discussion'
      surfaceBtn.style.cssText = 'display:none;align-items:center;justify-content:center;gap:4px;background:rgba(212,168,67,0.12);color:#d4a843;border:1px solid rgba(212,168,67,0.3);border-radius:4px;padding:0 8px;height:26px;font-size:11px;cursor:pointer;flex-shrink:0'
      surfaceBtn.innerHTML = '<span class="codicon codicon-comment-discussion" style="font-size:12px"></span><span>Surface</span>'
      surfaceBtn.addEventListener('click', () => {
        if (S.sessionId) {
          invoke('engine_chat_surface', { sessionId: S.sessionId }).catch(console.warn)
          updateStatus('Surfacing after current tools…')
        }
      })
      S.surfaceBtn = surfaceBtn

      const resumeBtn = document.createElement('button')
      resumeBtn.title = 'Resume audit from where it was paused'
      resumeBtn.style.cssText = 'display:none;align-items:center;justify-content:center;gap:5px;background:rgba(212,168,67,0.12);color:#d4a843;border:1px solid rgba(212,168,67,0.3);border-radius:4px;padding:0 10px;height:26px;font-size:11px;cursor:pointer;flex-shrink:0;font-weight:600'
      resumeBtn.innerHTML = '<span class="codicon codicon-debug-continue" style="font-size:12px"></span><span>Resume audit</span>'
      resumeBtn.addEventListener('click', doResume)
      S.resumeBtn = resumeBtn

      // Shared file picker helper
      async function pickAndAttach(insertMention: boolean): Promise<void> {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const { readTextFile } = await import('@tauri-apps/plugin-fs')
        const picked = await open({ multiple: true, directory: false }).catch(() => null)
        if (!picked) return
        const files = Array.isArray(picked) ? picked : [picked]
        for (const f of files) {
          try {
            const content = await readTextFile(f)
            const name = f.split('/').pop() ?? f
            S.attachments.push({ name, content, isImage: false })
            renderAttachBar()
            if (insertMention && S.textarea) {
              const pos = S.textarea.selectionStart ?? S.textarea.value.length
              const before = S.textarea.value.slice(0, pos)
              const after = S.textarea.value.slice(pos)
              const prefix = before.endsWith('@') ? before.slice(0, -1) : before
              S.textarea.value = `${prefix}@${name} ${after}`
              const newPos = prefix.length + name.length + 2
              S.textarea.setSelectionRange(newPos, newPos)
              S.textarea.dispatchEvent(new Event('input'))
              S.textarea.focus()
            }
          } catch { /* skip unreadable */ }
        }
      }

      // @ mention button
      const mentionBtn = document.createElement('button')
      mentionBtn.title = 'Mention file (@)'
      mentionBtn.style.cssText = 'background:transparent;border:none;cursor:pointer;padding:3px 5px;color:var(--vscode-descriptionForeground);display:flex;align-items:center;opacity:0.7;flex-shrink:0;font-size:13px;font-weight:600;font-family:monospace'
      mentionBtn.textContent = '@'
      mentionBtn.addEventListener('click', () => pickAndAttach(true))

      // Trigger file picker when user types @ at word boundary
      textarea.addEventListener('keydown', (e) => {
        if (e.key === '@') {
          const pos = textarea.selectionStart
          const before = textarea.value.slice(0, pos)
          if (before === '' || /[\s\n]$/.test(before)) {
            e.preventDefault()
            textarea.value = before + '@' + textarea.value.slice(pos)
            textarea.setSelectionRange(pos + 1, pos + 1)
            pickAndAttach(true)
          }
        }
      })

      // Attach file button (paperclip)
      const attachBtn = document.createElement('button')
      attachBtn.title = 'Attach file'
      attachBtn.style.cssText = 'background:transparent;border:none;cursor:pointer;padding:3px;color:var(--vscode-descriptionForeground);display:flex;opacity:0.7;flex-shrink:0'
      attachBtn.innerHTML = '<span class="codicon codicon-paperclip" style="font-size:14px"></span>'
      attachBtn.addEventListener('click', () => pickAndAttach(false))

      // Image paste support
      textarea.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items
        if (!items) return
        for (const item of Array.from(items)) {
          if (item.type.startsWith('image/')) {
            e.preventDefault()
            const blob = item.getAsFile()
            if (!blob) continue
            const reader = new FileReader()
            reader.onload = () => {
              const dataUrl = reader.result as string
              S.attachments.push({ name: `image-${Date.now()}.png`, content: dataUrl, isImage: true })
              renderAttachBar()
            }
            reader.readAsDataURL(blob)
          }
        }
      })

      inputRow.appendChild(mentionBtn)
      inputRow.appendChild(attachBtn)
      inputRow.appendChild(textarea)
      inputRow.appendChild(sendBtn)
      inputRow.appendChild(stopBtn)
      inputRow.appendChild(surfaceBtn)
      inputRow.appendChild(resumeBtn)

      // Attachment bar (shown above input row when files attached)
      const attachBar = document.createElement('div')
      attachBar.style.cssText = 'display:none;flex-wrap:wrap;gap:4px;padding:4px 0'
      S.attachmentBar = attachBar
      inputArea.appendChild(attachBar)
      inputArea.appendChild(inputRow)

      // ── Whisper row (visible only while streaming) ──────────────────────
      const whisperRow = document.createElement('div')
      whisperRow.className = 'opide-whisper-row'
      S.whisperRow = whisperRow

      const whisperIcon = document.createElement('span')
      whisperIcon.className = 'codicon codicon-comment'
      whisperIcon.style.cssText = 'font-size:11px;opacity:0.45;flex-shrink:0'
      whisperRow.appendChild(whisperIcon)

      const whisperInput = document.createElement('input')
      whisperInput.type = 'text'
      whisperInput.className = 'opide-whisper-input'
      whisperInput.placeholder = 'Whisper to agent…'
      whisperInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doWhisper() } })
      S.whisperInput = whisperInput
      whisperRow.appendChild(whisperInput)

      const whisperBtn = document.createElement('button')
      whisperBtn.className = 'opide-whisper-btn'
      whisperBtn.title = 'Inject guidance into current run'
      whisperBtn.innerHTML = '<span class="codicon codicon-send" style="font-size:11px"></span>'
      whisperBtn.addEventListener('click', doWhisper)
      whisperRow.appendChild(whisperBtn)

      inputArea.appendChild(whisperRow)

      // Gold separator line above input
      const separator = document.createElement('div')
      separator.className = 'opide-chat-separator'
      container.appendChild(separator)

      container.appendChild(inputArea)

      // ── Load initial data ──────────────────────────────────────────────
      renderMessages()

      checkProviders().then(() => {
        if (S.needsProviderSetup) renderProviderSetup()
        else renderMessages()
      }).catch(() => {
        renderMessages()
      })
      loadAgents().catch(() => {})
      loadSessions().catch(() => {})
      loadModels().then(() => updateModelSelect()).catch(() => {})
      // Capture the unlisten so renderBody-on-remount doesn't stack listeners.
      listen('provider-updated', () => updateModelSelect()).then((unlisten) => {
        S.providerUpdatedUnlisten = unlisten
      }).catch(() => {})

      return {
        dispose() {
          S.msgList = null; S.textarea = null; S.sendBtn = null; S.stopBtn = null
          S.toolRow = null; S.streamingBubble = null; S.headerStatus = null; S.progressLog = null
          if (S.progressUnlisten) { S.progressUnlisten(); S.progressUnlisten = null }
          if (S.providerUpdatedUnlisten) { S.providerUpdatedUnlisten(); S.providerUpdatedUnlisten = null }
          S.agentSelect = null; S.modelSelect = null; S.sessionSelect = null
          S.tokenDisplay = null; S.attachmentBar = null; S.contextBar = null
          S.whisperRow = null; S.whisperInput = null
          S.surfaceBtn = null; S.resumeBtn = null; S.surfaced = false; S.surfacedRound = 0
          S.attachments = []; S.checkpoint = null
        },
      }
    },
  })
}
