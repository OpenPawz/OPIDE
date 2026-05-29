// OPIDE Extension Language Model Bridge — Phase B.B2
//
// Maps `vscode.lm.selectChatModels` and `LanguageModelChat.sendRequest`
// onto OPIDE's existing provider system. When an extension asks for
// "anthropic claude-sonnet" we hand it back a wrapper that routes into
// the same engine pipeline our own chat panel uses, so the user's API
// keys stay inside OPIDE and we get unified rate-limiting / billing /
// telemetry across our agents and extension-driven LLM calls.
//
// v1 scope
//   selectModels: query engine_get_config + per-provider PRESETS, build
//     a synthetic model list. Same logic the chat panel's model picker
//     uses (see updateModelSelect in src/opide/chat/index.ts).
//   sendRequest: convert VS Code ChatMessage[] to OPIDE's format and
//     spawn an ephemeral session via engine_chat_send. Stream tokens
//     back via the supplied onChunk callback.
//   countTokens: cheap heuristic for now (chars/4); replace with the
//     engine's tokenizer once we expose a Tauri command for it.
//
// v2 will add:
//   - per-extension quota / approval prompts
//   - tool-call round-trips (LanguageModelToolCall)
//   - vendor: 'opide' models that route to local cache / engram

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

interface ModelEntry {
  id: string
  name: string
  vendor: string
  family: string
  version: string
  maxInputTokens: number
}

const PRESETS: Record<string, { models: string[]; vendor: string }> = {
  anthropic: {
    vendor: 'anthropic',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  },
  openai: {
    vendor: 'openai',
    models: ['gpt-5.4', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
  },
  google: {
    vendor: 'google',
    models: ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  moonshot: { vendor: 'moonshot', models: ['kimi-k2', 'moonshot-v1-128k'] },
  deepseek: { vendor: 'deepseek', models: ['deepseek-chat', 'deepseek-reasoner'] },
  claudecode: { vendor: 'anthropic', models: ['sonnet', 'opus', 'haiku'] },
}

export async function selectModels(selector: any): Promise<ModelEntry[]> {
  let providers: any[] = []
  try {
    const config = await invoke<any>('engine_get_config')
    providers = config?.providers ?? []
  } catch {
    /* engine not ready */
  }

  const vendorFilter = selector?.vendor
  const familyFilter = selector?.family
  const versionFilter = selector?.version

  const out: ModelEntry[] = []
  for (const p of providers) {
    const preset = PRESETS[p.kind]
    const vendor = preset?.vendor || p.kind || 'opide'
    const enabled: string[] = (p.enabled_models && p.enabled_models.length > 0)
      ? p.enabled_models
      : (preset?.models || [])
    for (const m of enabled) {
      if (vendorFilter && vendor !== vendorFilter) continue
      if (familyFilter && !m.toLowerCase().includes(String(familyFilter).toLowerCase())) continue
      if (versionFilter && versionFilter !== '1.0' && !m.includes(String(versionFilter))) continue
      out.push({
        id: m,
        name: m,
        vendor,
        family: m,
        version: '1.0',
        maxInputTokens: 200_000,
      })
    }
  }
  return out
}

export async function sendRequest(
  params: { requestId: string; modelId: string; messages: any[]; options: any },
  onChunk: (text: string) => void,
): Promise<{ text: string }> {
  const { messages, modelId } = params || {}

  // engine_chat_send runs the agent loop in a BACKGROUND task and returns
  // immediately with just { run_id, session_id } — the actual text streams
  // over `engine-event`. Two bugs used to make this path return empty
  // every time: (1) it matched `kind === 'token'` but the engine emits
  // text deltas as `kind === 'delta'`, and (2) it read `result.text`,
  // which ChatResponse doesn't have. So we now (a) match 'delta', (b)
  // await the 'complete' event for the run, and (c) filter by run_id so a
  // concurrent main-chat stream doesn't bleed into the extension's tokens.
  const accumulated: string[] = []
  let myRunId: string | null = null
  // Events that arrive before engine_chat_send resolves (so before we
  // know our run_id) are buffered and replayed once we do.
  const buffered: any[] = []
  let finalText = ''
  let resolveDone: (() => void) | null = null
  const donePromise = new Promise<void>((res) => { resolveDone = res })

  const handleEvent = (p: any) => {
    if (p?.kind === 'delta' && typeof p.text === 'string') {
      accumulated.push(p.text)
      onChunk(p.text)
    } else if (p?.kind === 'complete') {
      if (typeof p.text === 'string') finalText = p.text
      resolveDone?.()
    } else if (p?.kind === 'error') {
      resolveDone?.()
    }
  }

  const unlisten = await listen<any>('engine-event', (e) => {
    const payload: any = e.payload || {}
    if (myRunId === null) { buffered.push(payload); return }
    if (payload?.run_id !== myRunId) return
    handleEvent(payload)
  })

  try {
    // Convert VS Code messages → OPIDE messages. VS Code Chat uses
    // {role, content[]} where content is array of {type, value} or
    // simple strings; we already flattened to strings in the api-shim.
    const opideMessages = (messages || []).map((m: any) => ({
      role: (m.role === 'assistant' || m.role === 'user' || m.role === 'system') ? m.role : 'user',
      content: typeof m.content === 'string' ? m.content : '',
    }))

    // Use a transient session to keep extension calls isolated from
    // the user's main chat history. The engine creates one when the
    // request omits session_id; we don't reuse across calls because
    // that would let an extension contaminate the user's own thread.
    // engine_chat_send takes a single `request` arg with snake_case
    // fields per the existing chat-panel call shape.
    const result = await invoke<any>('engine_chat_send', {
      request: {
        session_id: undefined,
        message: opideMessages.map((m: any) => `${m.role}: ${m.content}`).join('\n\n'),
        system_prompt: undefined,
        model: modelId,
        tools_enabled: false,
        auto_approve_all: true,
        thinking_level: 'none',
        is_redirect: false,
      },
    }).catch(() => null)

    myRunId = result?.run_id ?? null
    if (!myRunId) return { text: '' } // failed to start the run

    // Replay anything that arrived for our run before we knew the id.
    for (const p of buffered) {
      if (p?.run_id === myRunId) handleEvent(p)
    }
    buffered.length = 0

    // Wait for the run to complete. The engine always emits a Complete
    // (or Error) event — even on abort/crash — so this resolves; the
    // timeout is a safety net against a wedged engine.
    await Promise.race([
      donePromise,
      new Promise<void>((res) => setTimeout(res, 300_000)),
    ])

    // If the model didn't stream deltas (some providers only send a final
    // message), fall back to the complete event's full text.
    if (accumulated.length === 0 && finalText) {
      accumulated.push(finalText)
      onChunk(finalText)
    }
    return { text: accumulated.join('') }
  } finally {
    try { unlisten() } catch { /* ignore */ }
  }
}

export async function countTokens(_modelId: string, text: string): Promise<number> {
  // Heuristic: ~4 chars per token. The engine has a real tokenizer but
  // it's not exposed as a Tauri command yet (CC2 follow-up).
  return Math.ceil((text || '').length / 4)
}
