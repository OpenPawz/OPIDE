/**
 * OPIDE detached chat window - standalone bootstrap.
 *
 * Runs in a separate Tauri WebviewWindow (label "opide-chat-detached")
 * created by the `open_chat_window` Rust command. This entry point
 * does NOT load the Monaco workbench, the file explorer, the
 * extension host, or any other IDE machinery - only the chat panel.
 *
 * State migration with the main window happens via localStorage:
 *   - On Detach: main window writes `opide:chat:detached-state` and
 *     opens this window. We hydrate from that key on mount.
 *   - On Reattach: this window writes the current state back to the
 *     same key, emits `chat-reattach` to main, and closes.
 *
 * Engine events: Tauri's `app.emit()` broadcasts to every webview, so
 * the chat module's existing `engine-event` listener picks up streaming
 * deltas, tool requests, etc. without any extra plumbing.
 */
import './styles/opide-tokens.css'

import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'

import { S } from './opide/chat/state.ts'
import type { ChatMsg } from './opide/chat/types.ts'
import { renderMessages, showStreamingBubble } from './opide/chat/render.ts'
import { ensureListening, initProgressListener } from './opide/chat/streaming.ts'
import { doSend, doAbort } from './opide/chat/send.ts'
import { loadPrefs } from './opide/chat/prefs.ts'

const DETACHED_STATE_KEY = 'opide:chat:detached-state'

/**
 * Snapshot of state migrated between the auxiliary-bar slot and the
 * detached window. Only the values that need to survive the handoff
 * are listed - DOM refs (S.msgList etc.) are local to each window
 * and recomputed on mount.
 */
interface DetachedSnapshot {
  messages: ChatMsg[]
  sessionId: string | null
  runId: string | null
  streamAccum: string
  streaming: boolean
  selectedAgentId: string | null
  selectedModel: string | null
}

function readSnapshot(): DetachedSnapshot | null {
  try {
    const raw = localStorage.getItem(DETACHED_STATE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as DetachedSnapshot
  } catch (e) {
    console.warn('[opide-chat-detached] snapshot read failed:', e)
    return null
  }
}

function writeSnapshot(snap: DetachedSnapshot): void {
  try {
    localStorage.setItem(DETACHED_STATE_KEY, JSON.stringify(snap))
  } catch (e) {
    console.warn('[opide-chat-detached] snapshot write failed:', e)
  }
}

function clearSnapshot(): void {
  try {
    localStorage.removeItem(DETACHED_STATE_KEY)
  } catch { /* nothing to do */ }
}

function currentSnapshot(): DetachedSnapshot {
  return {
    messages: S.messages,
    sessionId: S.sessionId,
    runId: S.runId,
    streamAccum: S.streamAccum,
    streaming: S.streaming,
    selectedAgentId: S.selectedAgent?.agent_id ?? null,
    selectedModel: S.selectedModel,
  }
}

/**
 * The single reattach code path used by:
 *   - the Reattach button in this window
 *   - the `chat-trigger-reattach` event from the main panel's
 *     "Bring chat back" button
 *   - the `beforeunload` handler (best-effort on OS X close)
 *
 * Steps: snapshot current state to localStorage, emit `chat-reattach`
 * so the main panel hydrates, then ask Rust to close this window.
 * Idempotent — guarded by `reattaching` so concurrent triggers don't
 * double-emit or race the close.
 */
let reattaching = false
async function performReattach(): Promise<void> {
  if (reattaching) return
  reattaching = true
  try {
    writeSnapshot(currentSnapshot())
    try { await emit('chat-reattach') } catch (e) { console.warn('[opide-chat-detached] emit reattach failed:', e) }
    try { await invoke('close_chat_window') } catch (e) { console.warn('[opide-chat-detached] close failed:', e) }
  } finally {
    // Don't reset — the window is closing.
  }
}

function applySnapshot(snap: DetachedSnapshot): void {
  S.messages = snap.messages ?? []
  S.sessionId = snap.sessionId ?? null
  S.runId = snap.runId ?? null
  S.streamAccum = snap.streamAccum ?? ''
  S.streaming = snap.streaming ?? false
  // selectedAgent is hydrated lazily once we have an agent list. For
  // the detached window v1 we skip the agent selector entirely; that
  // landing slot is fine.
  S.selectedModel = snap.selectedModel ?? null
}

/**
 * Render the slim chat UI for the detached window. NOT a copy-paste
 * of registerOpideChat's renderBody (that's 560 lines of auxiliary-
 * bar-specific layout). This is the minimal viable surface:
 *
 *   - top bar with title + Reattach button
 *   - scrollable message list
 *   - input row (textarea + Send / Stop)
 *
 * Approval banners, streaming bubbles, tool message cards, and the
 * activity feed all hook into S.msgList through the existing render
 * helpers - they will land in this window the same way they land in
 * the main one. Feature parity for agent selector, session selector,
 * thinking / plan / approval-mode toggles is v2 work.
 */
function buildDetachedChatUI(root: HTMLElement): void {
  root.style.cssText =
    'display:flex;flex-direction:column;height:100vh;width:100vw;overflow:hidden;' +
    'background:var(--opide-bg, #0a0a0c);color:var(--opide-text, #e8e6e1);' +
    'font-family:var(--opide-font-ui, system-ui);'

  // ── Header ───────────────────────────────────────────────────────────
  const header = document.createElement('div')
  header.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;gap:8px;' +
    'padding:8px 12px;border-bottom:1px solid var(--opide-border-subtle, #252530);' +
    'background:var(--opide-surface, #151519);flex-shrink:0;-webkit-app-region:drag;'

  const title = document.createElement('div')
  title.style.cssText = 'font-size:11px;font-weight:600;color:var(--opide-accent, #d4a843);letter-spacing:0.05em;text-transform:uppercase;'
  title.textContent = 'OPIDE Chat'
  header.appendChild(title)

  const reattachBtn = document.createElement('button')
  reattachBtn.textContent = 'Reattach'
  reattachBtn.title = 'Send the chat back into the main OPIDE window'
  reattachBtn.style.cssText =
    '-webkit-app-region:no-drag;background:transparent;color:var(--opide-text-secondary, #a0a0a8);' +
    'border:1px solid var(--opide-border, #333340);border-radius:4px;padding:3px 8px;' +
    'font-size:11px;cursor:pointer;font-family:inherit;'
  reattachBtn.addEventListener('mouseenter', () => { reattachBtn.style.borderColor = 'var(--opide-accent, #d4a843)' })
  reattachBtn.addEventListener('mouseleave', () => { reattachBtn.style.borderColor = 'var(--opide-border, #333340)' })
  reattachBtn.addEventListener('click', () => { void performReattach() })
  header.appendChild(reattachBtn)

  // Catch-all: if the user closes via the OS X button (no Reattach
  // click), still write state and notify main so the IDE panel can
  // restore. Without this the main window's "detached" placeholder
  // would be stuck because no `chat-reattach` event ever fires.
  window.addEventListener('beforeunload', () => {
    try { writeSnapshot(currentSnapshot()) } catch { /* best effort */ }
    // emit() returns a promise but beforeunload fires synchronously;
    // we still kick it off and let it land if the runtime survives
    // long enough. Tauri's emit is fast enough that this usually
    // completes before the window closes.
    void emit('chat-reattach').catch(() => { /* swallow */ })
  })

  root.appendChild(header)

  // ── Messages list ────────────────────────────────────────────────────
  const msgList = document.createElement('div')
  msgList.id = 'opide-chat-msglist'
  msgList.style.cssText =
    'flex:1;min-height:0;overflow-y:auto;padding:8px 0;' +
    'background:var(--opide-bg, #0a0a0c);'
  root.appendChild(msgList)

  // ── Input row ────────────────────────────────────────────────────────
  const inputArea = document.createElement('div')
  inputArea.style.cssText =
    'flex-shrink:0;border-top:1px solid var(--opide-border-subtle, #252530);' +
    'background:var(--opide-surface, #151519);padding:8px 10px;' +
    'display:flex;align-items:flex-end;gap:6px;'

  const textarea = document.createElement('textarea')
  textarea.rows = 1
  textarea.placeholder = 'Ask OPIDE anything…'
  textarea.style.cssText =
    'flex:1;background:var(--opide-surface-card, #1a1a22);color:var(--opide-text, #e8e6e1);' +
    'border:1px solid var(--opide-border-subtle, #252530);border-radius:6px;' +
    'padding:8px 10px;font-size:13px;font-family:var(--opide-font-ui, system-ui);' +
    'line-height:1.4;resize:none;min-height:36px;max-height:160px;outline:none;'
  textarea.addEventListener('focus', () => { textarea.style.borderColor = 'var(--opide-accent, #d4a843)' })
  textarea.addEventListener('blur', () => { textarea.style.borderColor = 'var(--opide-border-subtle, #252530)' })
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto'
    textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px'
  })
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      doSend()
    }
  })

  const sendBtn = document.createElement('button')
  sendBtn.textContent = 'Send'
  sendBtn.style.cssText =
    'background:var(--opide-accent, #d4a843);color:var(--opide-bg, #0a0a0c);' +
    'border:none;border-radius:6px;padding:8px 14px;font-size:12px;font-weight:600;' +
    'cursor:pointer;font-family:inherit;flex-shrink:0;'
  sendBtn.addEventListener('click', () => doSend())

  const stopBtn = document.createElement('button')
  stopBtn.textContent = 'Stop'
  stopBtn.style.cssText =
    'background:transparent;color:var(--opide-text-secondary, #a0a0a8);' +
    'border:1px solid var(--opide-border, #333340);border-radius:6px;' +
    'padding:8px 12px;font-size:12px;cursor:pointer;font-family:inherit;flex-shrink:0;display:none;'
  stopBtn.addEventListener('click', () => doAbort())

  inputArea.appendChild(textarea)
  inputArea.appendChild(sendBtn)
  inputArea.appendChild(stopBtn)
  root.appendChild(inputArea)

  // ── Wire S into our DOM so the existing chat helpers can update it ──
  S.msgList = msgList
  S.textarea = textarea
  S.sendBtn = sendBtn
  S.stopBtn = stopBtn

  // Initial paint of any messages we hydrated from the snapshot.
  renderMessages()
  if (S.streaming) {
    // Mid-stream when we got detached - put the streaming bubble back
    // so the next delta event has somewhere to land.
    showStreamingBubble()
  }
}

async function bootstrap(): Promise<void> {
  const root = document.getElementById('opide-chat-detached-root')
  if (!root) {
    console.error('[opide-chat-detached] root element missing')
    return
  }

  // 1. Hydrate prefs from localStorage (shared origin with the main
  //    window so this is the same data PR #21 added).
  const prefs = loadPrefs()
  S.approvalMode = prefs.approvalMode
  S.thinkingLevel = prefs.thinkingLevel
  S.planMode = prefs.planMode

  // 2. Hydrate the migrated snapshot, if any. The main window writes
  //    this immediately before opening us; under normal use the key is
  //    populated. Missing key means cold-launching the chat directly,
  //    in which case we start empty and the user sees a fresh chat.
  const snap = readSnapshot()
  if (snap) {
    applySnapshot(snap)
    // Clear so a future cold-launch doesn't replay stale state. We
    // re-write it on Reattach.
    clearSnapshot()
  }

  // 3. Set up the engine-event listener (drives streaming deltas, tool
  //    requests, etc). The same listener the main window uses.
  await ensureListening()
  await initProgressListener()

  // 3b. Listen for the main panel's "Bring chat back" trigger. This is
  //     symmetric with the Reattach button click — both code paths run
  //     `performReattach()` from inside this window's JS, which means
  //     the snapshot write and `chat-reattach` emit are guaranteed to
  //     happen before close. Relying on `beforeunload` to do this on a
  //     Rust-initiated close was unreliable (the Tauri close path can
  //     skip JS lifecycle events), which left the main panel stuck on
  //     the placeholder.
  try {
    await listen('chat-trigger-reattach', () => { void performReattach() })
  } catch (e) {
    console.warn('[opide-chat-detached] trigger-reattach listener failed:', e)
  }

  // 4. Build the UI.
  buildDetachedChatUI(root)

  // Note: the slim v1 UI does not surface the approval-mode /
  // thinking-level / plan-mode toggles. Prefs are still loaded above
  // (so engine_chat_send sends the right approval mode) but cannot be
  // changed from this window. v2 will add the full control row.
}

bootstrap().catch((e) => {
  console.error('[opide-chat-detached] bootstrap failed:', e)
  const root = document.getElementById('opide-chat-detached-root')
  if (root) {
    root.innerHTML = `<div style="padding:24px;color:#f88;font-family:var(--opide-font-mono, monospace);font-size:12px"><h3>Detached chat failed to start</h3><pre style="white-space:pre-wrap;margin-top:8px">${String(e)}</pre></div>`
  }
})
