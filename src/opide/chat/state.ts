/**
 * OPIDE Chat — Shared mutable state singleton
 *
 * All 40+ module-level `let` variables from opide-chat.ts are collected here
 * so that every split file can read/write the same state via `import { S }`.
 */

import type { UnlistenFn } from '@tauri-apps/api/event'
import type {
  Agent,
  Session,
  ChatMsg,
  ApprovalMode,
  PendingTool,
  Attachment,
  AgentCheckpoint,
} from './types.ts'

interface ChatState {
  // ── Session / streaming ─────────────────────────────────────────────
  sessionId: string | null
  runId: string | null
  streaming: boolean
  messages: ChatMsg[]
  streamAccum: string
  unlisten: UnlistenFn | null

  // ── Selections ──────────────────────────────────────────────────────
  selectedAgent: Agent | null
  selectedModel: string | null
  agents: Agent[]
  sessions: Session[]
  thinkingLevel: string
  approvalMode: ApprovalMode

  // ── Plan mode ───────────────────────────────────────────────────────
  planMode: boolean
  lastSendWasPlan: boolean
  planSteps: string[]
  planStepIndex: number
  planProgressEl: HTMLElement | null

  // ── Pending tool calls ──────────────────────────────────────────────
  pendingToolCalls: Map<string, PendingTool>

  // ── DOM refs ────────────────────────────────────────────────────────
  msgList: HTMLElement | null
  streamingBubble: HTMLElement | null
  textarea: HTMLTextAreaElement | null
  sendBtn: HTMLButtonElement | null
  stopBtn: HTMLButtonElement | null
  toolRow: HTMLElement | null
  headerStatus: HTMLElement | null
  agentSelect: HTMLSelectElement | null
  modelSelect: HTMLSelectElement | null
  sessionSelect: HTMLSelectElement | null
  tokenDisplay: HTMLElement | null
  attachmentBar: HTMLElement | null
  contextBar: HTMLElement | null

  // ── Attachments / checkpoint ────────────────────────────────────────
  attachments: Attachment[]
  checkpoint: AgentCheckpoint | null

  // ── Provider setup ──────────────────────────────────────────────────
  needsProviderSetup: boolean

  // ── Whisper (mid-run inject) ─────────────────────────────────────────
  whisperRow: HTMLElement | null
  whisperInput: HTMLInputElement | null

  // ── Run tracking ────────────────────────────────────────────────────
  completedRounds: number
  // Run IDs that have fully completed — events carrying these are stale and must be dropped
  completedRunIds: Set<string>

  // ── Surface (pause + discuss) ────────────────────────────────────────
  surfaced: boolean
  surfacedRound: number
  surfacedSummary: string
  surfaceBtn: HTMLButtonElement | null
  resumeBtn: HTMLButtonElement | null

  // ── Streaming frame scheduling ──────────────────────────────────────
  streamingRafId: number | null
  pendingStreamText: string

  // ── Thinking elapsed timer ───────────────────────────────────────────
  thinkingStartTs: number | null
  thinkingTimerInterval: ReturnType<typeof setInterval> | null

  // ── Sandbox progress log ────────────────────────────────────────────
  progressLog: HTMLDivElement | null
  progressUnlisten: (() => void) | null

  // ── Misc unlistens (panel-scoped) ────────────────────────────────────
  providerUpdatedUnlisten: (() => void) | null
}

/** The single shared state object. Import as `S` everywhere. */
export const S: ChatState = {
  sessionId: null,
  runId: null,
  streaming: false,
  messages: [],
  streamAccum: '',
  unlisten: null,

  selectedAgent: null,
  selectedModel: null,
  agents: [],
  sessions: [],
  thinkingLevel: 'none',
  approvalMode: 'auto',

  planMode: false,
  lastSendWasPlan: false,
  planSteps: [],
  planStepIndex: 0,
  planProgressEl: null,

  pendingToolCalls: new Map(),

  msgList: null,
  streamingBubble: null,
  textarea: null,
  sendBtn: null,
  stopBtn: null,
  toolRow: null,
  headerStatus: null,
  agentSelect: null,
  modelSelect: null,
  sessionSelect: null,
  tokenDisplay: null,
  attachmentBar: null,
  contextBar: null,

  attachments: [],
  checkpoint: null,

  needsProviderSetup: true,

  whisperRow: null,
  whisperInput: null,

  completedRounds: 0,
  completedRunIds: new Set<string>(),

  surfaced: false,
  surfacedRound: 0,
  surfacedSummary: '',
  surfaceBtn: null,
  resumeBtn: null,

  streamingRafId: null,
  pendingStreamText: '',
  thinkingStartTs: null,
  thinkingTimerInterval: null,

  progressLog: null,
  progressUnlisten: null,

  providerUpdatedUnlisten: null,
}
