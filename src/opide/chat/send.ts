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
import { gatherIdeContext as _gatherIdeContext, getWorkspace } from '../ide-context.ts'
import { buildSystemPrompt } from './system-prompt.ts'

export { buildSystemPrompt }

// ─── Built-in Agent Definitions ──────────────────────────────────────────────

export const BUILTIN_AGENTS = [] as const

// ─── Send Message ────────────────────────────────────────────────────────────

export async function doSend(): Promise<void> {
  if (!S.textarea) return
  const content = S.textarea.value.trim()
  if (!content) return

  // Deep session: after 3+ completed runs the agent has strong task momentum.
  // Treat every new message as a redirect so it gets the STOP wrapper and
  // history pruning — the user's message needs that weight to compete.
  const DEEP_SESSION_THRESHOLD = 3
  const isRedirect = S.streaming || S.completedRounds >= DEEP_SESSION_THRESHOLD

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

  // On redirect: wrap the message so the model can't miss it against 60+ rounds of history
  const messageContent = isRedirect
    ? `⚡ REDIRECT — STOP YOUR CURRENT TASK ⚡\n\nThe user is redirecting you. Read this carefully and respond to it directly before doing anything else. Do not continue your previous task unless the user's message explicitly asks you to.\n\nUser message:\n${content}`
    : content

  const parts = [context ? `[IDE Context]\n${context}` : '', attachBlock, messageContent].filter(Boolean)
  const fullMessage = parts.join('\n\n')

  const baseSystemPrompt = S.selectedAgent?.system_prompt || buildSystemPrompt(getWorkspace())
  const systemPrompt = S.planMode
    ? baseSystemPrompt + '\n\nPLAN MODE: Write a numbered plan of every step you will take to complete this task (files to create/modify, commands to run, etc). Do NOT use any tools — just write the plan as text. Be specific. The user will review and approve before you execute.'
    : baseSystemPrompt
  S.lastSendWasPlan = S.planMode

  try {
    const response = await invoke<ChatResponse>('engine_chat_send', {
      request: {
        session_id: S.sessionId ?? undefined,
        message: fullMessage,
        system_prompt: systemPrompt,
        agent_id: S.selectedAgent?.agent_id ?? undefined,
        model: S.selectedModel ?? undefined,
        tools_enabled: !S.planMode,
        auto_approve_all: S.approvalMode === 'yolo',
        thinking_level: S.thinkingLevel,
        workspace_path: getWorkspace() ?? undefined,
        is_redirect: isRedirect,
      },
    })
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
  try {
    const response = await invoke<ChatResponse>('engine_chat_send', {
      request: {
        session_id: S.sessionId ?? undefined,
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
