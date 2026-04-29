/**
 * OPIDE Chat - persisted user preferences
 *
 * Round-trips four chat-panel settings across app restarts via
 * localStorage. Without this, every restart silently resets:
 *
 *   - approvalMode (Ask / Auto / Yolo)  - security-relevant
 *   - thinkingLevel (None / Low / Medium / High)
 *   - planMode (toggle)
 *   - selectedAgentId (which agent profile is active)
 *
 * Tauri WebViews use a stable origin so localStorage persists across
 * launches. Audit finding 2B from the settings completeness sweep.
 */
import type { ApprovalMode } from './types.ts'

const STORAGE_KEY = 'opide:chat:prefs:v1'

export interface ChatPrefs {
  approvalMode: ApprovalMode
  thinkingLevel: string
  planMode: boolean
  selectedAgentId: string | null
}

const DEFAULTS: ChatPrefs = {
  approvalMode: 'auto',
  thinkingLevel: 'none',
  planMode: false,
  selectedAgentId: null,
}

/**
 * Load prefs from localStorage. Falls back to defaults on any failure
 * (parse error, missing keys, type mismatch). Forward-compatible: extra
 * fields are ignored, missing fields default. Rolling the version in
 * STORAGE_KEY is the migration story for breaking changes.
 */
export function loadPrefs(): ChatPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULTS }
    return {
      approvalMode: validApprovalMode(parsed.approvalMode) ?? DEFAULTS.approvalMode,
      thinkingLevel: validThinkingLevel(parsed.thinkingLevel) ?? DEFAULTS.thinkingLevel,
      planMode: typeof parsed.planMode === 'boolean' ? parsed.planMode : DEFAULTS.planMode,
      selectedAgentId: typeof parsed.selectedAgentId === 'string' ? parsed.selectedAgentId : null,
    }
  } catch (e) {
    console.warn('[opide-chat:prefs] load failed, using defaults:', e)
    return { ...DEFAULTS }
  }
}

/**
 * Save prefs to localStorage. Silent failure on quota exceeded or
 * disabled storage logs a warning but does not throw - the in-memory
 * state continues to work, the user just loses persistence for that
 * session. Same fault-tolerance pattern as the other Tauri-invoke
 * silent catches we audited in 1B.
 */
export function savePrefs(prefs: ChatPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch (e) {
    console.warn('[opide-chat:prefs] save failed (storage quota or disabled):', e)
  }
}

function validApprovalMode(v: unknown): ApprovalMode | null {
  if (v === 'ask' || v === 'auto' || v === 'yolo') return v
  return null
}

function validThinkingLevel(v: unknown): string | null {
  if (v === 'none' || v === 'low' || v === 'medium' || v === 'high') return v
  return null
}
