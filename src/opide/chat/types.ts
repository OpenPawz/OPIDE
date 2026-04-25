/**
 * OPIDE Chat — Type definitions
 *
 * All interfaces and type aliases used across the chat module.
 */

// ─── Domain Types ────────────────────────────────────────────────────────────

export interface Agent {
  project_id: string
  agent_id: string
  role: string
  specialty: string
  status: string
  model: string | null
  system_prompt: string | null
  capabilities: string[]
}

export interface Session {
  id: string
  model: string
  created_at: string
  updated_at: string
  title: string | null
  agent_id: string | null
}

export interface StoredMessage {
  id: string
  session_id: string
  role: string
  content: string
  created_at: string
}

export interface DiffLine { op: ' ' | '+' | '-'; line: string }

export interface ChatMsg {
  role: 'user' | 'assistant' | 'tool' | 'context' | 'system'
  /** Full text. Used by the expand panel for tool messages, and as-is for everything else. */
  content: string
  /** Optional short single-line summary for the collapsed tool-card row.
   *  When absent, callers fall back to a derived snippet of `content`. */
  preview?: string
  ts: Date
  toolName?: string
  toolSuccess?: boolean
  toolDuration?: number
  tokenUsage?: { input: number; output: number }
  model?: string
  feedbackGiven?: 'up' | 'down' | null
  messageId?: string
  filePath?: string
  diffLines?: DiffLine[]
  linesAdded?: number
  linesRemoved?: number
}

export interface ChatResponse { run_id: string; session_id: string }

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface TokenUsage { input_tokens: number; output_tokens: number; total_tokens: number }

export type EngineEvent =
  | { kind: 'delta'; session_id: string; run_id: string; text: string }
  | { kind: 'thinking_delta'; session_id: string; run_id: string; text: string }
  | { kind: 'agent_reasoning'; session_id: string; run_id: string; round: number; text: string }
  | { kind: 'tool_request'; session_id: string; run_id: string; tool_call: ToolCall; tool_tier?: string; round_number?: number; loaded_tools?: string[]; context_tokens?: number }
  | { kind: 'tool_result'; session_id: string; run_id: string; tool_call_id: string; output: string; success: boolean; duration_ms?: number }
  | { kind: 'complete'; session_id: string; run_id: string; text: string; tool_calls_count: number; usage?: TokenUsage; model?: string; total_rounds?: number }
  | { kind: 'surfaced'; session_id: string; run_id: string; round: number; summary: string }
  | { kind: 'plan_start'; session_id: string; run_id: string; description: string; node_count: number }
  | { kind: 'plan_complete'; session_id: string; run_id: string; success_count: number; total_count: number; duration_ms: number }
  | { kind: string; session_id?: string; run_id?: string }

export type ApprovalMode = 'ask' | 'auto' | 'yolo'

export interface PendingTool { call: ToolCall; preContent?: string }

export interface Attachment { name: string; content: string; isImage: boolean }

export interface AgentCheckpoint { head_sha: string; stash_oid: string | null }
