/**
 * OPIDE Chat — Streaming & Tool Handling
 *
 * SSE event listener, tool request/result handling, approval UI,
 * sandbox progress log, and stream finalization.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { S } from './state.ts'
import type { ChatMsg, EngineEvent } from './types.ts'
import {
  renderMessages,
  updateStreamingBubble,
  showStreamingBubble,
  commitStreamingBubble,
  showToolIndicator,
  hideToolIndicator,
  updateStatus,
  setStreaming,
  renderPlanProgress,
  clearPlanProgress,
  updateContextPills,
  computeDiff,
  sliceDiffContext,
  escapeHtml,
} from './render.ts'
import { getWorkspace } from '../ide-context.ts'

// ─── Tool Classification ────────────────────────────────────────────────────

const SAFE_TOOLS = new Set([
  // OpenPawz safe tools
  'read_file','list_directory','search_files','grep_search','web_search',
  'get_current_date','read_dir','get_file_info','list_directory_recursive',
  // OPIDE read-only tools (never need approval)
  'ide_read_file', 'ide_list_dir', 'ide_search_text', 'ide_search_semantic',
  'ide_get_diagnostics', 'ide_get_selection', 'ide_get_open_files', 'ide_open_file',
  'ide_get_terminal_output', 'ide_get_project_overview',
  'ide_git_status', 'ide_git_diff', 'ide_git_log', 'ide_git_branches',
  'ide_ast_callers', 'ide_ast_callees', 'ide_ast_impact', 'ide_ast_definition', 'ide_ast_type_info',
  'memory_search', 'soul_read', 'soul_list', 'self_info',
])
const WRITE_TOOLS = new Set([
  'write_file','create_file','edit_file','overwrite_file','apply_patch','str_replace',
  // OPIDE write tools
  'ide_write_file', 'ide_apply_edit', 'ide_delete_file',
])
const IDE_REVIEWED_TOOLS = new Set(['ide_write_file', 'ide_apply_edit'])

function needsApprovalFor(_tier: string, toolName: string): boolean {
  if (S.approvalMode === 'yolo') return false
  if (S.approvalMode === 'ask') return true
  // Auto mode: approve safe tools, prompt for writes, external, dangerous, and unknown
  if (SAFE_TOOLS.has(toolName)) return false
  return true
}

// ─── Completed-run-id tracking (capped) ─────────────────────────────────────

const MAX_COMPLETED_RUN_IDS = 64

/** Add a runId to the completed set, evicting the oldest if we exceed the cap. */
export function markRunCompleted(runId: string): void {
  if (!runId) return
  if (S.completedRunIds.has(runId)) return
  S.completedRunIds.add(runId)
  if (S.completedRunIds.size > MAX_COMPLETED_RUN_IDS) {
    // Set preserves insertion order — first is oldest.
    const first = S.completedRunIds.values().next().value
    if (first) S.completedRunIds.delete(first)
  }
}

// ─── SSE Listener ────────────────────────────────────────────────────────────

export async function ensureListening(): Promise<void> {
  if (S.unlisten) return
  S.unlisten = await listen<EngineEvent>('engine-event', ({ payload }) => {
    // While no session is active (new-chat reset or startup) drop everything —
    // stale events from a previous run must never bleed into a fresh chat.
    if (!S.sessionId) return
    if (S.sessionId && payload.session_id !== S.sessionId) return
    // Drop events from runs that have already completed (S.runId is null between runs,
    // so without this check stale delayed events would pass through unfiltered).
    if (payload.run_id && S.completedRunIds.has(payload.run_id)) return
    if (S.runId && payload.run_id !== S.runId) return

    switch (payload.kind) {
      case 'delta': {
        const ev = payload as Extract<EngineEvent, { kind: 'delta' }>
        // Clear thinking timer the moment content starts flowing
        if (S.thinkingTimerInterval !== null) {
          clearInterval(S.thinkingTimerInterval)
          S.thinkingTimerInterval = null
          S.thinkingStartTs = null
          updateStatus('')
        }
        // Auto-create streaming bubble if missing — happens after a redirect when
        // the old run's Complete fires first and finalizeStreaming clears the bubble
        if (!S.streamingBubble) {
          setStreaming(true)
          showStreamingBubble()
          S.streamAccum = ''
        }
        S.streamAccum += ev.text
        updateStreamingBubble(S.streamAccum)
        break
      }
      case 'thinking_delta': {
        if (S.thinkingStartTs === null) {
          S.thinkingStartTs = Date.now()
          S.thinkingTimerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - (S.thinkingStartTs ?? Date.now())) / 1000)
            updateStatus(`Thinking… ${elapsed}s`)
          }, 1000)
        }
        updateStatus(`Thinking… ${Math.floor((Date.now() - S.thinkingStartTs) / 1000)}s`)
        break
      }
      case 'tool_request': {
        const ev = payload as Extract<EngineEvent, { kind: 'tool_request' }>
        // showToolRequest is async (it awaits the pre-write file snapshot for B16)
        // but the event handler itself is sync — fire-and-forget with error log.
        showToolRequest(ev).catch((e) => console.warn('[opide-chat] showToolRequest failed:', e))
        break
      }
      case 'tool_result': {
        const ev = payload as Extract<EngineEvent, { kind: 'tool_result' }>
        handleToolResult(ev)
        break
      }
      case 'complete': {
        const ev = payload as Extract<EngineEvent, { kind: 'complete' }>
        finalizeStreaming(ev)
        break
      }
      case 'surfaced': {
        const ev = payload as Extract<EngineEvent, { kind: 'surfaced' }>
        handleSurfaced(ev)
        break
      }
      case 'plan_start': {
        const ev = payload as Extract<EngineEvent, { kind: 'plan_start' }>
        S.messages.push({ role: 'system', content: `Plan: ${ev.description} (${ev.node_count} steps)`, ts: new Date() })
        renderMessages()
        break
      }
      case 'plan_complete': {
        const ev = payload as Extract<EngineEvent, { kind: 'plan_complete' }>
        S.messages.push({ role: 'system', content: `Plan complete: ${ev.success_count}/${ev.total_count} steps (${(ev.duration_ms / 1000).toFixed(1)}s)`, ts: new Date() })
        renderMessages()
        break
      }
    }
  })
}

// ─── Tool Request ────────────────────────────────────────────────────────────

async function showToolRequest(ev: Extract<EngineEvent, { kind: 'tool_request' }>): Promise<void> {
  const tier = ev.tool_tier || 'unknown'
  // B202: ToolCall is `{ id, type, function: { name, arguments } }` —
  // the previous flat-shape reads (`ev.tool_call.name`,
  // `ev.tool_call.arguments`) returned undefined on every event and
  // tripped a TypeError on `.slice` that the listener's .catch
  // silently swallowed. Pull from the nested `function` object now,
  // matching the Rust serialization.
  const toolName = ev.tool_call.function?.name ?? '(unknown)'
  const toolArgs = ev.tool_call.function?.arguments ?? ''
  const needsApproval = needsApprovalFor(tier, toolName)

  S.pendingToolCalls.set(ev.tool_call.id, { call: ev.tool_call })

  if (IDE_REVIEWED_TOOLS.has(toolName)) {
    S.messages.push({
      role: 'tool',
      content: `Reviewing edit in diff editor: **${toolName}**`,
      ts: new Date(),
    })
    renderMessages()
  }

  // Snapshot the file BEFORE the tool runs so the diff is accurate.
  // Awaited synchronously so the tool_result handler always sees `preContent`
  // populated (or knows the read genuinely failed). Without the await, fast
  // tools could complete before the read resolved → diff path saw `undefined`
  // and fell back to "all lines added" (B16).
  if (WRITE_TOOLS.has(toolName)) {
    try {
      const args = JSON.parse(toolArgs || '{}')
      const path = args.path || args.file_path || args.filename
      if (path) {
        const { readTextFile } = await import('@tauri-apps/plugin-fs')
        try {
          const content = await readTextFile(path)
          const pending = S.pendingToolCalls.get(ev.tool_call.id)
          if (pending) pending.preContent = content
        } catch { /* file may not exist yet — leave preContent undefined */ }
      }
    } catch { /* args not JSON */ }
  }

  if (needsApproval) {
    S.messages.push({
      role: 'tool',
      content: `Tool requires approval: **${toolName}**\nTier: ${tier}\nArgs: \`${toolArgs.slice(0, 200)}\``,
      ts: new Date(),
      toolName,
    })
    renderMessages()
    addApprovalButtons(ev.tool_call.id, toolName, tier)
  } else {
    updateStatus(`Running: ${toolName}`)
    showToolIndicator(toolName)
  }
}

// ─── Approval Buttons ────────────────────────────────────────────────────────

/**
 * Render an obvious, full-width approval row in the message list.
 *
 * The previous implementation appended the buttons inside the tool
 * message's flex wrap (display:flex, child width:100%), which compressed
 * the button row to zero width — the engine asked, the buttons existed
 * in the DOM, but nothing visible appeared. The user reported "zero
 * permission requests EVER" because of this. (Live repro 2026-04-26
 * after B198 fixed the engine-side auto-approve bug.)
 *
 * Now: build a self-contained row, append it to msgList directly as a
 * sibling of the message bubbles, with a clear "Approval needed" label
 * and a faint background so it's hard to miss.
 */
/**
 * Render the approval row inline inside the OPIDE chat panel as its own
 * standalone message-list row.
 *
 * History:
 *   B199 first attempt: appended buttons inside the tool-message bubble's
 *     flex wrap → child width:100% squashed btnRow to 0px (invisible).
 *   B201: switched to a fixed-position body overlay. Always visible, but
 *     in the *middle of the IDE window*, not the chat panel — the user
 *     was looking at the chat and missed it.
 *   This version: standalone row appended to S.msgList (the chat
 *     message list itself). Lives in the same scroll container as the
 *     conversation, scrolls into view automatically. Falls back to
 *     body-level overlay only if S.msgList is genuinely missing.
 */
function addApprovalButtons(toolCallId: string, toolName: string, tier: string): void {
  const row = document.createElement('div')
  row.dataset.approvalForToolCall = toolCallId
  row.style.cssText = [
    'display:flex',
    'align-items:center',
    'gap:8px',
    'margin:6px 14px',
    'padding:10px 12px',
    'border-radius:6px',
    'background:rgba(212,168,67,0.08)',
    'border:1px solid rgba(212,168,67,0.4)',
  ].join(';')

  const label = document.createElement('span')
  label.style.cssText = 'flex:1;font-size:12px;color:var(--vscode-foreground);line-height:1.4'
  label.innerHTML = `<strong style="color:#d4a843">Approval needed</strong> <code style="font-family:var(--vscode-editor-font-family,monospace);font-size:11px;opacity:0.85">${toolName}</code> <span style="opacity:0.55;font-size:10px">(${tier})</span>`
  row.appendChild(label)

  const approveBtn = document.createElement('button')
  approveBtn.textContent = 'Approve'
  approveBtn.style.cssText = 'background:#2ea043;color:white;border:none;border-radius:4px;padding:5px 12px;font-size:12px;cursor:pointer;font-weight:500'
  approveBtn.addEventListener('click', () => {
    invoke('engine_approve_tool', { sessionId: S.sessionId, toolCallId, approved: true }).catch(console.error)
    row.remove()
  })

  const denyBtn = document.createElement('button')
  denyBtn.textContent = 'Deny'
  denyBtn.style.cssText = 'background:#da3633;color:white;border:none;border-radius:4px;padding:5px 12px;font-size:12px;cursor:pointer;font-weight:500'
  denyBtn.addEventListener('click', () => {
    invoke('engine_approve_tool', { sessionId: S.sessionId, toolCallId, approved: false }).catch(console.error)
    row.remove()
  })

  row.appendChild(approveBtn)
  row.appendChild(denyBtn)

  if (S.msgList) {
    S.msgList.appendChild(row)
    S.msgList.scrollTop = S.msgList.scrollHeight
  } else {
    // Last-resort fallback: chat panel hasn't mounted, attach to body so the
    // approval is at least clickable somewhere. Should be rare in practice
    // because the chat panel is always registered before any agent run.
    document.body.appendChild(row)
  }
}

// ─── Tool Result ─────────────────────────────────────────────────────────────

function handleToolResult(ev: Extract<EngineEvent, { kind: 'tool_result' }>): void {
  hideToolIndicator()
  updateStatus('')

  const pending = S.pendingToolCalls.get(ev.tool_call_id)
  S.pendingToolCalls.delete(ev.tool_call_id)

  // Preserve the full output on `content` (used by the expand panel) and
  // derive a short single-line `preview` for the collapsed card row.
  const fullOutput = ev.output ?? ''
  const PREVIEW_MAX = 80
  const flat = fullOutput.replace(/\s+/g, ' ').trim()
  const preview = flat.length > PREVIEW_MAX ? flat.slice(0, PREVIEW_MAX) + '…' : flat

  const msg: ChatMsg = {
    role: 'tool',
    content: fullOutput,
    preview,
    ts: new Date(),
    toolSuccess: ev.success,
    toolDuration: ev.duration_ms,
    toolName: pending?.call.function?.name,
  }

  // B202: same nested-shape fix here.
  const pendingName = pending?.call.function?.name
  if (pending && pendingName && WRITE_TOOLS.has(pendingName) && !IDE_REVIEWED_TOOLS.has(pendingName) && ev.success) {
    try {
      const args = JSON.parse(pending.call.function?.arguments || '{}')
      const path = args.path || args.file_path || args.filename
      if (path) {
        msg.filePath = path
        const afterContent = args.content ?? args.new_content ?? args.text ?? null
        if (afterContent !== null && pending.preContent !== undefined) {
          const diff = sliceDiffContext(computeDiff(pending.preContent, afterContent))
          msg.diffLines = diff
          msg.linesAdded = diff.filter(l => l.op === '+').length
          msg.linesRemoved = diff.filter(l => l.op === '-').length
        } else if (afterContent !== null && pending.preContent === undefined) {
          const lines = afterContent.split('\n').slice(0, 200).map((line: string) => ({ op: '+' as const, line }))
          msg.diffLines = lines
          msg.linesAdded = lines.length
          msg.linesRemoved = 0
        }
      }
    } catch { /* args not parseable */ }
  }

  S.messages.push(msg)
  // B205: render now so _renderedCount stays in sync with S.messages.length.
  // Without this, the count fell behind by one after each tool_result, then
  // commitStreamingBubble's `_renderedCount++` would claim the wrong slot —
  // finalizeStreaming's renderMessages loop then re-rendered the assistant
  // message a second time, producing the visible "reply printed twice" bug.
  renderMessages()

  if (S.planSteps.length > 0 && S.planStepIndex < S.planSteps.length) {
    S.planStepIndex++
    renderPlanProgress()
  }
}

// ─── Sandbox Progress Log ────────────────────────────────────────────────────

export async function initProgressListener(): Promise<void> {
  if (S.progressUnlisten) return
  const { listen: listenEvent } = await import('@tauri-apps/api/event')

  const unlisten = await listenEvent<{ message: string; timestamp: number }>('sandbox-progress', ({ payload }) => {
    // sandbox-progress carries no run_id so we guard with S.runId — if no run
    // is active, this is a stale log from a completed run and must be dropped.
    if (!S.runId) return
    if (!S.progressLog || !S.msgList) return

    if (S.progressLog.style.display === 'none') {
      S.progressLog.style.display = 'block'
    }

    const line = document.createElement('div')
    line.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);padding:1px 0;display:flex;align-items:center;gap:4px'
    line.innerHTML = `<span style="color:var(--vscode-testing-iconPassed);font-size:10px">✓</span> ${escapeHtml(payload.message)}`
    S.progressLog.appendChild(line)

    S.msgList.scrollTo({ top: S.msgList.scrollHeight })

    const label = S.toolRow?.querySelector('.opide-tool-label')
    if (label) {
      const short = payload.message.length > 60 ? payload.message.slice(0, 57) + '...' : payload.message
      label.textContent = `⚡ ${short}`
    }
  })

  S.progressUnlisten = unlisten
}

// ─── Handle Surfaced ─────────────────────────────────────────────────────────

function handleSurfaced(ev: Extract<EngineEvent, { kind: 'surfaced' }>): void {
  S.msgList?.querySelector('#opide-streaming')?.remove()
  S.streamingBubble = null
  S.streamAccum = ''
  S.surfacedRound = ev.round
  S.surfacedSummary = ev.summary
  if (S.runId) markRunCompleted(S.runId)
  S.runId = null
  hideToolIndicator()
  updateStatus('Surfaced — discuss then resume')
  S.messages.push({ role: 'assistant', content: ev.summary, ts: new Date() })
  setStreaming(false)
  // setStreaming(false) hides resumeBtn — now show it for the surfaced state
  S.surfaced = true
  if (S.resumeBtn) S.resumeBtn.style.display = 'flex'
  renderMessages()
}

// ─── Finalize Streaming ──────────────────────────────────────────────────────

function finalizeStreaming(ev: Extract<EngineEvent, { kind: 'complete' }>): void {
  // Clear thinking timer (fires when model skips straight to complete with no deltas)
  if (S.thinkingTimerInterval !== null) {
    clearInterval(S.thinkingTimerInterval)
    S.thinkingTimerInterval = null
    S.thinkingStartTs = null
  }
  // Finalize the streaming bubble in-place — full markdown render, no remove+append flash
  commitStreamingBubble(ev.text)
  S.streamAccum = ''
  // Mark this run as completed before clearing — so any delayed events arriving
  // after S.runId is null are still correctly identified and dropped.
  if (S.runId) markRunCompleted(S.runId)
  S.runId = null
  S.completedRounds++
  hideToolIndicator()
  updateStatus('')
  S.messages.push({
    role: 'assistant',
    content: ev.text,
    ts: new Date(),
    tokenUsage: ev.usage ? { input: ev.usage.input_tokens, output: ev.usage.output_tokens } : undefined,
    model: ev.model || undefined,
  })
  setStreaming(false)
  renderMessages()
  if (ev.usage && S.tokenDisplay) {
    S.tokenDisplay.textContent = `${ev.usage.total_tokens} tokens`
  }

  // Mark all plan steps complete when execution finishes
  if (S.planSteps.length > 0 && S.planStepIndex >= S.planSteps.length) {
    renderPlanProgress()
    setTimeout(() => clearPlanProgress(), 8000)
  }

  // Show Revert button if we have a checkpoint and agent made tool calls
  if (S.checkpoint && ev.tool_calls_count > 0) {
    const cp = S.checkpoint
    const lastBubble = S.msgList?.lastElementChild?.querySelector('div') as HTMLElement | null
    if (lastBubble) {
      const revertBar = document.createElement('div')
      revertBar.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:8px;padding:6px 8px;background:rgba(100,30,30,0.15);border:1px solid rgba(244,135,113,0.25);border-radius:4px'

      const revertBtn = document.createElement('button')
      revertBtn.innerHTML = '<span class="codicon codicon-discard" style="font-size:12px;margin-right:4px"></span>Revert agent changes'
      revertBtn.title = `Restore to ${cp.head_sha.slice(0, 7)}`
      revertBtn.style.cssText = 'display:flex;align-items:center;background:transparent;color:#f48771;border:1px solid rgba(244,135,113,0.5);border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer'
      revertBtn.addEventListener('click', async () => {
        const ws2 = getWorkspace()
        if (!ws2) return
        revertBtn.textContent = 'Reverting…'
        revertBtn.disabled = true
        try {
          await invoke('git_checkpoint_restore', {
            repoPath: ws2,
            headSha: cp.head_sha,
            stashOid: cp.stash_oid ?? undefined,
          })
          revertBar.innerHTML = '<span class="codicon codicon-check" style="font-size:12px;color:#89d185"></span><span style="font-size:11px;color:var(--vscode-descriptionForeground)">Reverted to pre-agent state</span>'
          S.checkpoint = null
          updateContextPills()
        } catch (e) {
          revertBtn.textContent = `Failed: ${String(e).slice(0, 60)}`
          revertBtn.disabled = false
        }
      })

      const dismissBtn = document.createElement('button')
      dismissBtn.innerHTML = '<span class="codicon codicon-close" style="font-size:11px"></span>'
      dismissBtn.title = 'Dismiss'
      dismissBtn.style.cssText = 'display:flex;align-items:center;background:transparent;border:none;color:var(--vscode-descriptionForeground);cursor:pointer;opacity:0.6;margin-left:auto;padding:2px'
      dismissBtn.addEventListener('click', () => { revertBar.remove(); S.checkpoint = null; updateContextPills() })

      revertBar.appendChild(revertBtn)
      revertBar.appendChild(dismissBtn)
      lastBubble.appendChild(revertBar)
    }
  }

  // If this was a plan response, inject "Execute Plan" button
  if (S.lastSendWasPlan) {
    S.lastSendWasPlan = false
    const lastBubble = S.msgList?.lastElementChild?.querySelector('div') as HTMLElement | null
    if (lastBubble) {
      const bar = document.createElement('div')
      bar.style.cssText = 'display:flex;gap:8px;margin-top:10px;align-items:center'

      const execBtn = document.createElement('button')
      execBtn.innerHTML = '<span class="codicon codicon-run" style="font-size:12px;margin-right:4px"></span>Execute Plan'
      execBtn.style.cssText = 'display:flex;align-items:center;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;padding:4px 12px;font-size:12px;cursor:pointer;font-weight:600'
      execBtn.addEventListener('click', () => {
        bar.remove()
        // Import dynamically to avoid circular dep
        import('./send.ts').then(({ executeApprovedPlan }) => executeApprovedPlan())
      })

      const editBtn = document.createElement('button')
      editBtn.innerHTML = '<span class="codicon codicon-edit" style="font-size:12px;margin-right:4px"></span>Edit plan first'
      editBtn.style.cssText = 'display:flex;align-items:center;background:transparent;color:var(--vscode-descriptionForeground);border:1px solid var(--vscode-widget-border,#444);border-radius:4px;padding:4px 12px;font-size:12px;cursor:pointer'
      editBtn.addEventListener('click', () => {
        bar.remove()
        if (S.textarea) { S.textarea.value = 'Revise the plan: '; S.textarea.focus() }
      })

      const discardBtn = document.createElement('button')
      discardBtn.innerHTML = '<span class="codicon codicon-trash" style="font-size:11px"></span>'
      discardBtn.title = 'Discard plan'
      discardBtn.style.cssText = 'display:flex;align-items:center;background:transparent;color:var(--vscode-descriptionForeground);border:none;border-radius:4px;padding:4px 6px;font-size:12px;cursor:pointer;opacity:0.6'
      discardBtn.addEventListener('click', () => bar.remove())

      bar.appendChild(execBtn)
      bar.appendChild(editBtn)
      bar.appendChild(discardBtn)
      lastBubble.appendChild(bar)
    }
  }
}
