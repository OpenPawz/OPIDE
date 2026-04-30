// OPIDE Extension Chat Participants — Phase B.B1
//
// Bridges VS Code's `vscode.chat.createChatParticipant` API to OPIDE's
// existing chat panel. Extensions register a participant id (e.g.
// "continue", "claude-code", "copilot.chat") and a handler. When the
// user types `@<id> <prompt>` in OPIDE's chat textarea we route the
// prompt to that handler and stream the response back into the chat
// panel as if it were a normal assistant message.
//
// Strategic choice
//   VS Code makes chat participants live in their own dedicated chat
//   panel. We don't — OPIDE has one chat surface (OpenPawz + agents),
//   and extension participants plug into it as @-mentions. That means
//   Claude Code, Continue, Cline, Copilot Chat all become tools sitting
//   alongside our own agents instead of competing surfaces. This is
//   the differentiator the OPIDE-extensions-plan calls out.
//
// Architecture
//   Extension activation
//     → api-shim chat.createChatParticipant
//       → bridge 'chat/registerParticipant'
//         → registerParticipant(id, dispatchFn) here
//           → CustomEvent('opide-chat-participants-changed') so the chat
//             panel can refresh its hint UI
//
//   User types `@continue explain this`
//     → chat panel detectMention(input) → dispatch(participantId, prompt, ...)
//       → dispatchFn (from registerParticipant) sends chat/dispatch over RPC
//         → api-shim calls the extension's handler with a ChatResponseStream
//           → handler.markdown('...') → chat/streamChunk RPC → deliverStreamChunk
//             → CustomEvent('opide-chat-participant-chunk') → chat panel renders
//
// The chat panel owns the actual rendering; we're a registry plus event
// bus. Keeps coupling low and avoids requiring a circular import.

interface ParticipantRecord {
  id: string
  fullName?: string
  iconPath?: string
  /** Called when a user @-mentions this participant. The bridge wires
   * the closure to send a chat/dispatch RPC; we just hold the function. */
  dispatch: (
    participantId: string,
    prompt: string,
    requestId: string,
    history: any[],
  ) => void
}

interface ActiveDispatch {
  requestId: string
  participantId: string
  /** Resolves once the dispatch ends; the chat panel awaits this so it
   * can finalise the message bubble (stop spinner, etc). */
  done: Promise<{ result?: any; error?: string }>
  resolveDone: (v: { result?: any; error?: string }) => void
  /** Whether the dispatch has emitted any chunk yet. The chat panel
   * uses this to decide between showing a spinner or rendering the
   * partial message. */
  hasReceived: boolean
}

const _participants = new Map<string, ParticipantRecord>()
const _active = new Map<string, ActiveDispatch>()
let _nextRequestId = 1

// ─── Public API (called by extension-bridge) ───────────────────────────

export function registerParticipant(
  id: string,
  dispatch: ParticipantRecord['dispatch'],
): void {
  if (!id) return
  _participants.set(id, { id, dispatch })
  emitChange()
}

export function updateParticipant(id: string, patch: Partial<ParticipantRecord>): void {
  const rec = _participants.get(id)
  if (!rec) return
  if (patch.fullName != null) rec.fullName = patch.fullName
  if (patch.iconPath != null) rec.iconPath = patch.iconPath
  emitChange()
}

export function disposeParticipant(id: string): void {
  if (!_participants.delete(id)) return
  emitChange()
}

/** Chunk arrived from the extension's handler. Forward to the chat
 * panel via a CustomEvent so the message bubble updates live. */
export function deliverStreamChunk(params: any): void {
  const requestId = params?.requestId
  const dispatch = _active.get(requestId)
  if (!dispatch) return
  dispatch.hasReceived = true
  window.dispatchEvent(new CustomEvent('opide-chat-participant-chunk', {
    detail: {
      requestId,
      participantId: dispatch.participantId,
      kind: params?.kind || 'markdown',
      value: params?.value,
      title: params?.title,
      message: params?.message,
      command: params?.command,
      baseUri: params?.baseUri,
    },
  }))
}

export function endDispatch(params: any): void {
  const requestId = params?.requestId
  const dispatch = _active.get(requestId)
  if (!dispatch) return
  _active.delete(requestId)
  dispatch.resolveDone({ result: params?.result, error: params?.error })
  window.dispatchEvent(new CustomEvent('opide-chat-participant-end', {
    detail: { requestId, participantId: dispatch.participantId, error: params?.error },
  }))
}

// ─── Public API (called by OPIDE's chat panel) ─────────────────────────

export interface ParticipantSummary {
  id: string
  fullName: string
  iconPath?: string
}

/** List of registered participants for the chat panel's hint UI. */
export function listParticipants(): ParticipantSummary[] {
  return [..._participants.values()].map((p) => ({
    id: p.id,
    fullName: p.fullName || p.id,
    iconPath: p.iconPath,
  }))
}

/** Try to detect an @-mention of a registered participant at the start
 * of the input. Returns the matched participant id and the rest of the
 * prompt with the mention stripped. Returns null if no match. Used by
 * the chat panel's send hook to decide whether to route the message
 * to a participant or to OPIDE's own engine. */
export function detectMention(text: string): { participantId: string; prompt: string } | null {
  const trimmed = text.trimStart()
  const match = trimmed.match(/^@([a-zA-Z0-9._\-]+)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const id = match[1]
  if (!_participants.has(id)) return null
  return { participantId: id, prompt: (match[2] || '').trim() }
}

/** Begin a dispatch. Returns a promise that resolves when the handler
 * finishes (or errors) so the caller can finalise the message bubble. */
export function dispatchToParticipant(
  participantId: string,
  prompt: string,
  history: any[] = [],
): { requestId: string; done: Promise<{ result?: any; error?: string }> } {
  const rec = _participants.get(participantId)
  if (!rec) {
    return {
      requestId: '',
      done: Promise.resolve({ error: `participant '${participantId}' not registered` }),
    }
  }
  const requestId = `chat-${_nextRequestId++}`
  let resolveDone: (v: { result?: any; error?: string }) => void = () => {}
  const done = new Promise<{ result?: any; error?: string }>((res) => { resolveDone = res })
  _active.set(requestId, { requestId, participantId, done, resolveDone, hasReceived: false })
  rec.dispatch(participantId, prompt, requestId, history)
  return { requestId, done }
}

// ─── Internal: change emitter ──────────────────────────────────────────

function emitChange(): void {
  window.dispatchEvent(new CustomEvent('opide-chat-participants-changed', {
    detail: { participants: listParticipants() },
  }))
}
