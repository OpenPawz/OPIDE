/**
 * OPIDE Chat — Send / Abort / Plan Execution
 *
 * Message sending, plan execution, abort, and system prompt building.
 */

import { invoke } from '@tauri-apps/api/core'
import { S } from './state.ts'
import type { ChatResponse, AgentCheckpoint } from './types.ts'
import {
  renderMessages,
  showStreamingBubble,
  setStreaming,
  hideToolIndicator,
  updateStatus,
  renderAttachBar,
  updateContextPills,
  parsePlanSteps,
  attachPlanProgress,
} from './render.ts'
import { markRunCompleted } from './streaming.ts'
import { gatherIdeContext as _gatherIdeContext, getWorkspace } from '../ide-context.ts'
import { buildSystemPrompt } from './system-prompt.ts'
import { detectMention, dispatchToParticipant } from '../extension-chat-participants.ts'

export { buildSystemPrompt }

// ─── Built-in Agent Definitions ──────────────────────────────────────────────

// Populated in the V2 build. Empty in OSS — the dropdown shows DB agents only.
// Keep this constant in place; do not delete the call sites that consume it
// (index.ts, render.ts) — V2 reactivates them by populating this array.
export const BUILTIN_AGENTS = [] as const

// ─── Send Message ────────────────────────────────────────────────────────────

export async function doSend(): Promise<void> {
  if (!S.textarea) return
  const content = S.textarea.value.trim()
  if (!content) return

  // Phase B.B1: extension chat participants. If the user typed
  // `@<id> <prompt>` and <id> is a registered participant, route the
  // prompt to that extension's handler instead of OPIDE's engine. The
  // participant streams chunks back via CustomEvents the engine never
  // sees, so this short-circuits cleanly without disturbing the rest
  // of doSend's redirect / streaming bookkeeping.
  if (await dispatchToExtensionParticipantIfMatched(content)) return

  // Two related concepts that USED to share one flag:
  //   - mid-stream redirect: the agent is currently running and the user typed
  //     something new — they want it to stop. Loud `⚡ REDIRECT` wrapper helps
  //     the model notice against 60+ rounds of history.
  //   - deep session: after 3+ completed runs, history is dense and the
  //     backend should still prune to make space — but the user is NOT
  //     interrupting. Don't shout at them; just signal `is_redirect` to the
  //     backend so the pruning policy kicks in.
  const DEEP_SESSION_THRESHOLD = 3
  const isMidStreamRedirect = S.streaming
  const isDeepSession = !S.streaming && S.completedRounds >= DEEP_SESSION_THRESHOLD

  S.textarea.value = ''
  S.textarea.style.height = 'auto'

  const context = await _gatherIdeContext()

  let attachBlock = ''
  if (S.attachments.length > 0) {
    for (const att of S.attachments) {
      if (att.isImage) {
        attachBlock += `[Attached image: ${att.name}]\n(image data omitted from text context)\n\n`
      } else {
        attachBlock += `[Attached file: ${att.name}]\n\`\`\`\n${att.content.slice(0, 8000)}\n\`\`\`\n\n`
      }
    }
    S.attachments = []
    renderAttachBar()
  }

  S.messages.push({ role: 'user', content, ts: new Date() })
  renderMessages()

  if (S.streaming) {
    // Mid-run redirect: save partial streamed text and signal the UI
    if (S.streamAccum) {
      S.messages.push({ role: 'assistant', content: S.streamAccum + '\n\n*(redirected)*', ts: new Date() })
      S.streamAccum = ''
    }
    // Pre-emptively mark the current runId as completed so any terminal events
    // from the OLD run that arrive during the redirect's network round-trip are
    // filtered out by the engine-event listener (streaming.ts:70). Without this,
    // the old run's Complete can sneak through and append a duplicate assistant
    // message after the partial-streamed-text + (redirected) marker.
    if (S.runId) markRunCompleted(S.runId)
    updateStatus('Redirecting after current tools…')
  } else {
    // Normal send or deep-session redirect (agent not currently running):
    // start the streaming bubble normally. is_redirect may still be true
    // (deep session) which ensures the backend applies STOP wrapper + pruning.
    setStreaming(true)
    showStreamingBubble()
    // Snapshot current git state so the user can revert agent changes
    S.checkpoint = null
    const ws = getWorkspace()
    if (ws) {
      invoke<AgentCheckpoint>('git_checkpoint_create', { repoPath: ws })
        .then(cp => { S.checkpoint = cp; updateContextPills() })
        .catch(() => { /* not a git repo or no commits yet */ })
    }
  }

  // Only mid-stream redirects get the loud STOP wrapper. Deep-session sends
  // pass through plain — the backend still gets `is_redirect: true` below for
  // history-pruning, but the model doesn't see shouty all-caps when the agent
  // wasn't actually running.
  const messageContent = isMidStreamRedirect
    ? `⚡ REDIRECT — STOP YOUR CURRENT TASK ⚡\n\nThe user is redirecting you. Read this carefully and respond to it directly before doing anything else. Do not continue your previous task unless the user's message explicitly asks you to.\n\nUser message:\n${content}`
    : content

  const parts = [context ? `[IDE Context]\n${context}` : '', attachBlock, messageContent].filter(Boolean)
  const fullMessage = parts.join('\n\n')

  const baseSystemPrompt = S.selectedAgent?.system_prompt || buildSystemPrompt(getWorkspace())
  const systemPrompt = S.planMode
    ? baseSystemPrompt + '\n\nPLAN MODE: Write a numbered plan of every step you will take to complete this task (files to create/modify, commands to run, etc). Do NOT use any tools — just write the plan as text. Be specific. The user will review and approve before you execute.'
    : baseSystemPrompt
  S.lastSendWasPlan = S.planMode

  // B200: generate the session id BEFORE invoke so the engine-event listener
  // has a non-null S.sessionId when tool_request / delta / etc. start arriving.
  // Previously we set S.sessionId only AFTER invoke resolved — but invoke
  // awaits the entire chat turn (tool approvals included). During the turn
  // the listener saw `!S.sessionId` and silently dropped every event,
  // including tool_request, so the approval UI never rendered. This was
  // *the* reason "zero permission requests EVER" surfaced after the
  // engine-side B196/B197/B198 fixes — the engine asked, the listener
  // dropped the question.
  //
  // The backend uses request.session_id when provided, falling back to its
  // own UUID otherwise (commands/chat.rs::engine_chat_send), so a frontend-
  // generated id round-trips correctly.
  const sessionId = S.sessionId ?? `eng-${crypto.randomUUID()}`
  S.sessionId = sessionId

  try {
    const response = await invoke<ChatResponse>('engine_chat_send', {
      request: {
        session_id: sessionId,
        message: fullMessage,
        system_prompt: systemPrompt,
        agent_id: S.selectedAgent?.agent_id ?? undefined,
        model: S.selectedModel ?? undefined,
        tools_enabled: !S.planMode,
        auto_approve_all: S.approvalMode === 'yolo',
        thinking_level: S.thinkingLevel,
        workspace_path: getWorkspace() ?? undefined,
        is_redirect: isMidStreamRedirect || isDeepSession,
      },
    })
    // Engine echoes back the same session_id; reassigning is a no-op but
    // keeps us aligned if the backend ever decides to migrate sessions.
    S.sessionId = response.session_id
    // Always update runId — on redirect, old complete events won't match new runId
    // so they'll be filtered, and the existing streaming bubble continues for the new run
    S.runId = response.run_id
    // Refresh session list
    import('./index.ts').then(({ loadSessions }) => loadSessions().catch(() => {}))
  } catch (err) {
    S.msgList?.querySelector('#opide-streaming')?.remove()
    S.streamingBubble = null
    S.messages.push({ role: 'assistant', content: `Error: ${err}`, ts: new Date() })
    setStreaming(false)
    renderMessages()
  }
}

// ─── Execute Approved Plan ───────────────────────────────────────────────────

export async function executeApprovedPlan(): Promise<void> {
  if (S.streaming) return
  const lastAssistant = [...S.messages].reverse().find(m => m.role === 'assistant')
  if (lastAssistant) {
    S.planSteps = parsePlanSteps(lastAssistant.content)
  }
  const execMsg = 'The plan looks good. Execute it now — use your tools to implement every step.'
  S.messages.push({ role: 'user', content: 'Execute plan', ts: new Date() })
  renderMessages()
  setStreaming(true)
  showStreamingBubble()
  if (S.planSteps.length > 0) attachPlanProgress()
  // B200: same upfront-id pattern as sendChat — keeps the listener filter
  // happy while the engine is mid-turn.
  const sessionId = S.sessionId ?? `eng-${crypto.randomUUID()}`
  S.sessionId = sessionId

  try {
    const response = await invoke<ChatResponse>('engine_chat_send', {
      request: {
        session_id: sessionId,
        message: execMsg,
        system_prompt: S.selectedAgent?.system_prompt || buildSystemPrompt(getWorkspace()),
        agent_id: S.selectedAgent?.agent_id ?? undefined,
        model: S.selectedModel ?? undefined,
        tools_enabled: true,
        auto_approve_all: S.approvalMode === 'yolo',
        thinking_level: S.thinkingLevel,
        workspace_path: getWorkspace() ?? undefined,
      },
    })
    S.sessionId = response.session_id
    S.runId = response.run_id
  } catch (err) {
    S.msgList?.querySelector('#opide-streaming')?.remove()
    S.streamingBubble = null
    S.messages.push({ role: 'assistant', content: `Error: ${err}`, ts: new Date() })
    setStreaming(false)
    renderMessages()
  }
}

// ─── Whisper (mid-run inject) ─────────────────────────────────────────────────

export async function doWhisper(): Promise<void> {
  if (!S.streaming || !S.sessionId || !S.whisperInput) return
  const message = S.whisperInput.value.trim()
  if (!message) return
  S.whisperInput.value = ''
  try {
    await invoke('engine_chat_inject', { sessionId: S.sessionId, message })
  } catch (err) {
    console.warn('[opide-chat] whisper inject failed:', err)
  }
}

// ─── Resume after Surface ────────────────────────────────────────────────────

export async function doResume(): Promise<void> {
  if (!S.sessionId) return
  const round = S.surfacedRound
  const summaryContext = S.surfacedSummary
    ? `Context from pause: ${S.surfacedSummary}\n\n`
    : ''
  const resumeMsg = `${summaryContext}Resume from round ${round}. Your task is determined by the discussion above — if the user gave new direction, follow it. If no direction was given, continue from where you paused.`
  S.surfacedSummary = ''
  S.messages.push({ role: 'user', content: 'Resume', ts: new Date() })
  renderMessages()
  setStreaming(true)
  showStreamingBubble()
  try {
    const response = await invoke<ChatResponse>('engine_chat_send', {
      request: {
        session_id: S.sessionId,
        message: resumeMsg,
        system_prompt: S.selectedAgent?.system_prompt || buildSystemPrompt(getWorkspace()),
        agent_id: S.selectedAgent?.agent_id ?? undefined,
        model: S.selectedModel ?? undefined,
        tools_enabled: true,
        auto_approve_all: S.approvalMode === 'yolo',
        thinking_level: S.thinkingLevel,
        workspace_path: getWorkspace() ?? undefined,
      },
    })
    S.sessionId = response.session_id
    S.runId = response.run_id
    import('./index.ts').then(({ loadSessions }) => loadSessions().catch(() => {}))
  } catch (err) {
    S.msgList?.querySelector('#opide-streaming')?.remove()
    S.streamingBubble = null
    S.messages.push({ role: 'assistant', content: `Error: ${err}`, ts: new Date() })
    setStreaming(false)
    renderMessages()
  }
}

// ─── Abort ───────────────────────────────────────────────────────────────────

export async function doAbort(): Promise<void> {
  if (!S.sessionId) return
  try {
    await invoke('engine_chat_abort', { sessionId: S.sessionId })
    setStreaming(false)
    hideToolIndicator()
    updateStatus('Aborted')
    S.msgList?.querySelector('#opide-streaming')?.remove()
    S.streamingBubble = null
    if (S.streamAccum) {
      S.messages.push({ role: 'assistant', content: S.streamAccum + '\n\n*(aborted)*', ts: new Date() })
      S.streamAccum = ''
    }
    renderMessages()
  } catch (e) {
    console.warn('[opide-chat] abort failed:', e)
  }
}

// ─── Phase B.B1: extension chat participant routing ───────────────────────
//
// If the user types `@<id> <prompt>` and <id> is a registered extension
// chat participant, route the prompt to that extension's handler. The
// extension streams chunks back via CustomEvents we listen on; each
// chunk appends to the assistant message bubble. When the dispatch
// ends (success or error), we detach listeners and clean up.
//
// Returns true if the message was handled by a participant (caller
// should short-circuit). Returns false if no participant matched, in
// which case doSend continues with the regular OPIDE engine flow.

async function dispatchToExtensionParticipantIfMatched(content: string): Promise<boolean> {
  const mention = detectMention(content)
  if (!mention) return false
  if (!S.textarea) return false

  // Mirror the user's message in the chat thread, clear the textarea,
  // and create a placeholder assistant bubble that we'll mutate as
  // chunks arrive. We do NOT call setStreaming/showStreamingBubble
  // because those manage the engine's own streaming state and would
  // confuse the regular send path if it runs concurrently.
  S.messages.push({ role: 'user', content, ts: new Date() })
  S.textarea.value = ''
  S.textarea.style.height = 'auto'

  const placeholderIdx = S.messages.length
  S.messages.push({
    role: 'assistant',
    content: `*Asking @${mention.participantId}…*`,
    ts: new Date(),
  })
  renderMessages()

  // Build per-dispatch listeners. We close over the requestId after
  // dispatchToParticipant returns it; the listeners filter chunks so
  // concurrent dispatches don't bleed into each other's bubbles.
  let active = true
  const handleChunk = (e: Event) => {
    if (!active) return
    const ev = e as CustomEvent
    if (!ev.detail || ev.detail.requestId !== requestId) return
    const msg = S.messages[placeholderIdx]
    if (!msg) return
    // Reset the placeholder copy on first chunk so we don't have
    // "*Asking @claude…*" stuck above the real response.
    if (msg.content.startsWith('*Asking @')) msg.content = ''
    if (ev.detail.kind === 'markdown' && typeof ev.detail.value === 'string') {
      msg.content += ev.detail.value
    } else if (ev.detail.kind === 'progress' && typeof ev.detail.message === 'string') {
      // Progress notes go inline as italic text; participants use these
      // for "thinking" / "fetching context" style statuses.
      msg.content += `\n\n_${ev.detail.message}_`
    } else if (ev.detail.kind === 'anchor' && typeof ev.detail.value === 'string') {
      msg.content += `\n\n[${ev.detail.title || ev.detail.value}](${ev.detail.value})`
    } else if (ev.detail.kind === 'reference' && ev.detail.value) {
      msg.content += `\n\n_(reference: ${String(ev.detail.value)})_`
    }
    renderMessages()
  }
  const handleEnd = (e: Event) => {
    const ev = e as CustomEvent
    if (!ev.detail || ev.detail.requestId !== requestId) return
    active = false
    window.removeEventListener('opide-chat-participant-chunk', handleChunk)
    window.removeEventListener('opide-chat-participant-end', handleEnd)
    if (ev.detail.error) {
      const msg = S.messages[placeholderIdx]
      if (msg) {
        if (msg.content.startsWith('*Asking @')) msg.content = ''
        msg.content += `\n\n*(error: ${String(ev.detail.error)})*`
        renderMessages()
      }
    }
  }
  window.addEventListener('opide-chat-participant-chunk', handleChunk)
  window.addEventListener('opide-chat-participant-end', handleEnd)

  // Recent assistant turns become the "history" we hand the participant
  // so it has continuity inside its own thread. We bound it to the last
  // 10 turns to avoid blowing past extensions' own context limits.
  const history = S.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content }))

  const { requestId } = dispatchToParticipant(mention.participantId, mention.prompt, history)
  if (!requestId) {
    // Participant disappeared between detect and dispatch; clean up.
    active = false
    window.removeEventListener('opide-chat-participant-chunk', handleChunk)
    window.removeEventListener('opide-chat-participant-end', handleEnd)
    const msg = S.messages[placeholderIdx]
    if (msg) {
      msg.content = '*(participant not found)*'
      renderMessages()
    }
  }
  return true
}
