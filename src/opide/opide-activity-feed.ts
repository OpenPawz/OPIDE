// ── OPIDE Activity Feed ─────────────────────────────────────────────────────
// Live sidebar panel showing what the AI agent is doing in real-time.
// Translates engine-event payloads into human-readable status lines.

import { listen } from '@tauri-apps/api/event'
import {
  registerCustomView,
  ViewContainerLocation,
} from '@codingame/monaco-vscode-workbench-service-override'
import type { EngineEvent, ToolCall } from './chat/types.ts'

// ─── State ──────────────────────────────────────────────────────────────────

interface ActivityEntry {
  ts: Date
  kind: 'tool_active' | 'tool_done' | 'thinking' | 'complete' | 'error' | 'auto_approved' | 'round' | 'run_start' | 'reasoning' | 'subtool_active' | 'subtool_done'
  summary: string
  success?: boolean
  durationMs?: number
  toolCallId?: string
  detail?: string
}

const MAX_ENTRIES = 500
let entries: ActivityEntry[] = []
let listEl: HTMLElement | null = null
let isThinking = false
let unlistenFn: (() => void) | null = null

// Correlation: tool_call.id → { description, DOM element, start time, timer }
const activeTools = new Map<string, { description: string; element: HTMLElement | null; startTime: number; timer: ReturnType<typeof setInterval> | null }>()

// Track the most recently active execute_code DOM element for sandbox-progress updates
let activeExecElement: HTMLElement | null = null
let activeExecCallId: string | null = null   // call ID of the in-flight execute_code
let sandboxProgressUnlisten: (() => void) | null = null

// Sub-tool correlation: tool_call_id → { description, DOM element, start time, timer }
// Populated by sandbox-subtool-start events, cleaned up on sandbox-subtool-end
const activeSubTools = new Map<string, { description: string; element: HTMLElement | null; startTime: number; timer: ReturnType<typeof setInterval> | null }>()
let sandboxSubtoolUnlistenStart: (() => void) | null = null
let sandboxSubtoolUnlistenEnd: (() => void) | null = null

// Round and run tracking
let currentRound: number | null = null
let currentRunId: string | null = null
// Run IDs that have fully completed — drop any delayed events carrying these.
// Capped at 64 entries (B66) so a long session doesn't grow the set without bound.
const completedRunIds = new Set<string>()
const MAX_COMPLETED_RUN_IDS = 64
function trackCompletedRun(runId: string): void {
  if (!runId || completedRunIds.has(runId)) return
  completedRunIds.add(runId)
  if (completedRunIds.size > MAX_COMPLETED_RUN_IDS) {
    const first = completedRunIds.values().next().value
    if (first) completedRunIds.delete(first)
  }
}

// ─── Tool Name Translation ──────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  ide_read_file: 'Reading',
  ide_write_file: 'Writing',
  ide_apply_edit: 'Editing',
  ide_list_dir: 'Listing',
  ide_search_text: 'Searching',
  ide_search_semantic: 'Semantic search',
  ide_get_diagnostics: 'Checking diagnostics',
  ide_git_status: 'Git status',
  ide_git_diff: 'Git diff',
  ide_git_commit: 'Committing',
  ide_git_log: 'Git log',
  ide_ast_callers: 'Tracing callers',
  ide_ast_callees: 'Tracing callees',
  ide_ast_impact: 'Analyzing impact',
  ide_ast_definition: 'Finding definition',
  ide_run_command: 'Running',
  execute_code: 'Executing',
  ide_get_project_overview: 'Scanning project',
  ide_open_file: 'Opening',
  read_file: 'Reading',
  write_file: 'Writing',
  edit_file: 'Editing',
  create_file: 'Creating',
  list_directory: 'Listing',
  search_files: 'Searching',
  grep_search: 'Searching code',
  web_search: 'Web search',
  web_read: 'Reading webpage',
  delete_file: 'Deleting',
  append_file: 'Appending',
}

function describeToolCall(call: ToolCall): string {
  // B202: ToolCall has nested function: { name, arguments } — match the
  // Rust serialization. Old flat-shape reads returned undefined and
  // tripped silently inside try/catch.
  const name = call.function?.name ?? ''
  const argStr = call.function?.arguments ?? ''
  const label = TOOL_LABELS[name] || name.replace(/^ide_/, '').replace(/_/g, ' ')
  try {
    const args = JSON.parse(argStr || '{}')

    // For execute_code: extract a meaningful hint from the JS source
    if (name === 'execute_code' && args.code) {
      const code: string = args.code

      // 1. Leading single-line comment — most reliable when the model adds one
      const slComment = code.match(/^\s*\/\/\s*(.{4,80})/m)
      if (slComment) return `Executing: ${slComment[1].trim()}`

      // 2. Leading block comment  /* ... */
      const blComment = code.match(/^\s*\/\*+\s*([\s\S]{4,120}?)\s*\*+\//)
      if (blComment) {
        const first = blComment[1].split('\n')[0].replace(/^\s*\*?\s*/, '').trim()
        if (first.length >= 4) return `Executing: ${first.slice(0, 80)}`
      }

      // 3. ctx.ast_callers / ast_callees / ast_definition / ast_impact / ast_type_info
      //    Model calls these directly as ctx.ast_callers('SYMBOL')
      const astCall = code.match(/ctx\.ast_(callers|callees|definition|impact|type_info)\(["'`]([^"'`]{1,60})["'`]/)
      if (astCall) {
        const methodLabels: Record<string, string> = {
          callers: 'Tracing callers',
          callees: 'Tracing callees',
          definition: 'Finding definition',
          impact: 'Analyzing impact',
          type_info: 'Type info',
        }
        return `${methodLabels[astCall[1]] ?? astCall[1]}: ${astCall[2]}`
      }

      // 4. ctx.tool('toolname', { ... }) — extract tool label + first meaningful arg value
      const ctxTool = code.match(/ctx\.tool\(["'`]([^"'`]+)["'`]\s*,\s*(\{[^}]{0,200}\})/)
      if (ctxTool) {
        const innerLabel = TOOL_LABELS[ctxTool[1]] ?? ctxTool[1].replace(/^ide_/, '').replace(/_/g, ' ')
        try {
          const innerArgs = JSON.parse(ctxTool[2])
          const hint = innerArgs.function ?? innerArgs.symbol ?? innerArgs.name
            ?? innerArgs.query ?? innerArgs.pattern
            ?? (innerArgs.path ? (innerArgs.path as string).split('/').slice(-1)[0] : null)
          if (hint) return `${innerLabel}: ${String(hint).slice(0, 60)}`
        } catch { /* use label only */ }
        return innerLabel
      }

      // 5. ctx.search('query')
      const searchCall = code.match(/ctx\.search\(["'`]([^"'`]{2,60})["'`]/)
      if (searchCall) return `Searching: "${searchCall[1]}"`

      // 6. ctx.exec('command') — shell execution
      const execMatch = code.match(/ctx\.exec\(["'`]([^"'`]{4,60})/)
      if (execMatch) return `Running: ${execMatch[1].trim()}`

      // 7. ctx.file_read / ctx.file_write path
      const fileMatch = code.match(/ctx\.file_(?:read|write)\(["'`]([^"'`]+)/)
      if (fileMatch) return `Executing: ${fileMatch[1].split('/').slice(-2).join('/')}`

      // 8. const <name> = — use variable name as a last-resort hint
      const varMatch = code.match(/(?:const|let)\s+([a-zA-Z][a-zA-Z0-9_]{2,30})\s*=/)
      if (varMatch) {
        const readable = varMatch[1].replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim().toLowerCase()
        if (readable.length >= 4) return `Executing: ${readable}`
      }

      return 'Executing script…'
    }

    if (args.path || args.file_path || args.filename) {
      const p = args.path || args.file_path || args.filename
      const short = p.split('/').slice(-2).join('/')
      return `${label}: ${short}`
    }
    if (args.command) {
      const cmd = args.command.length > 50 ? args.command.slice(0, 50) + '…' : args.command
      return `${label}: ${cmd}`
    }
    if (args.pattern || args.query) {
      return `${label}: "${args.pattern || args.query}"`
    }
    return label
  } catch {
    return label
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function addEntry(entry: ActivityEntry): void {
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) {
    entries.shift()
    // Drop the matching DOM node so the rendered list stays bounded too.
    // Without this, the in-memory array is capped but the DOM accumulates
    // forever, which causes UI lag in long-running sessions (1D-1).
    // We drop the first non-empty-state child, since the empty-state
    // placeholder lives at the top until the first real entry appears.
    if (listEl) {
      let firstReal = listEl.firstElementChild
      while (firstReal && firstReal.classList?.contains('af-empty')) {
        firstReal = firstReal.nextElementSibling
      }
      if (firstReal) firstReal.remove()
    }
  }
  if (listEl) renderEntry(entry)
}

function renderEntry(entry: ActivityEntry): HTMLElement | null {
  if (!listEl) return null

  // Remove empty state message if present
  const empty = listEl.querySelector('.af-empty')
  if (empty) empty.remove()

  const el = document.createElement('div')
  el.className = `af-entry af-${entry.kind}${entry.success === false ? ' af-fail' : ''}`

  const time = formatTime(entry.ts)

  const icons: Record<string, string> = {
    tool_active: '⚙',
    tool_done: entry.success === false ? '✗' : '✓',
    thinking: '◉',
    complete: '◆',
    error: '✗',
    auto_approved: '↳',
    round: '─',
    run_start: '▶',
    reasoning: '→',
    subtool_active: '↳',
    subtool_done: entry.success === false ? '↳✗' : '↳✓',
  }
  const icon = icons[entry.kind] || '·'

  const duration = entry.durationMs ? ` <span class="af-dur">${formatDuration(entry.durationMs)}</span>` : ''

  el.innerHTML = `<span class="af-time">${time}</span> <span class="af-icon">${icon}</span> <span class="af-text">${entry.summary}</span>${duration}`

  // Reasoning entries with full text get an expandable detail section
  if (entry.kind === 'reasoning' && entry.detail) {
    el.classList.add('af-expandable')
    const detail = document.createElement('div')
    detail.className = 'af-reasoning-detail'
    detail.textContent = entry.detail
    detail.style.display = 'none'
    el.appendChild(detail)
    el.addEventListener('click', () => {
      const isVisible = detail.style.display !== 'none'
      detail.style.display = isVisible ? 'none' : 'block'
    })
  }

  listEl.appendChild(el)

  autoScroll()
  return el
}

function updateToolElement(toolCallId: string, success: boolean, durationMs?: number, errorMsg?: string): void {
  const info = activeTools.get(toolCallId)
  if (!info || !info.element) return

  // Clear the running timer
  if (info.timer) clearInterval(info.timer)

  // Update the class: gold → green/red
  info.element.className = `af-entry af-tool_done${success === false ? ' af-fail' : ''}`

  // Update the icon and add duration
  const icon = success ? '✓' : '✗'
  const summaryText = success ? info.description : `${info.description} — ${(errorMsg || 'Failed').slice(0, 60)}`
  const elapsed = durationMs ?? (Date.now() - info.startTime)
  const duration = ` <span class="af-dur">${formatDuration(elapsed)}</span>`

  const time = info.element.querySelector('.af-time')?.textContent || ''
  info.element.innerHTML = `<span class="af-time">${time}</span> <span class="af-icon">${icon}</span> <span class="af-text">${summaryText}</span>${duration}`

  // Add expandable error detail on failure
  if (!success && errorMsg && errorMsg.length > 60) {
    info.element.classList.add('af-expandable')
    const detail = document.createElement('div')
    detail.className = 'af-error-detail'
    detail.textContent = errorMsg
    detail.style.display = 'none'
    info.element.appendChild(detail)
    info.element.addEventListener('click', () => {
      const isVisible = detail.style.display !== 'none'
      detail.style.display = isVisible ? 'none' : 'block'
    })
  }

  activeTools.delete(toolCallId)
  autoScroll()
}

function autoScroll(): void {
  if (!listEl) return
  if (listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80) {
    listEl.scrollTop = listEl.scrollHeight
  }
}

function renderAll(): void {
  if (!listEl) return
  listEl.innerHTML = ''
  for (const entry of entries) renderEntry(entry)
}

// ─── Event Listener ─────────────────────────────────────────────────────────

async function startListening(): Promise<void> {
  if (unlistenFn) return
  unlistenFn = await listen<EngineEvent>('engine-event', ({ payload }) => {

    // Drop events from runs that have already completed — these are stale delayed
    // events and must not create phantom "Done" entries in the current view.
    if ('run_id' in payload && payload.run_id && completedRunIds.has(payload.run_id as string)) return

    // ── Run separator: detect new agent run ──
    if ('run_id' in payload && payload.run_id && payload.run_id !== currentRunId) {
      currentRunId = payload.run_id as string
      currentRound = null
      const entry: ActivityEntry = {
        ts: new Date(),
        kind: 'run_start',
        summary: `New run`,
      }
      addEntry(entry)
    }

    switch (payload.kind) {
      case 'tool_request': {
        const ev = payload as Extract<EngineEvent, { kind: 'tool_request' }>
        isThinking = false

        // ── Round separator ──
        if (ev.round_number != null && ev.round_number !== currentRound) {
          currentRound = ev.round_number
          addEntry({
            ts: new Date(),
            kind: 'round',
            summary: `Round ${currentRound}`,
          })
        }

        // ── Tool start: create line, store for in-place update ──
        const description = describeToolCall(ev.tool_call)
        const entry: ActivityEntry = {
          ts: new Date(),
          kind: 'tool_active',
          summary: description,
          toolCallId: ev.tool_call.id,
        }
        addEntry(entry)

        // Store reference for in-place update when result arrives
        const lastEl = listEl?.lastElementChild as HTMLElement | null
        const startTime = Date.now()

        // Start running timer — updates the duration every second while tool is active
        let timer: ReturnType<typeof setInterval> | null = null
        if (lastEl) {
          timer = setInterval(() => {
            const elapsed = Date.now() - startTime
            const durSpan = lastEl.querySelector('.af-dur')
            if (durSpan) {
              durSpan.textContent = formatDuration(elapsed)
            } else {
              // Append duration span if not present
              const span = document.createElement('span')
              span.className = 'af-dur'
              span.textContent = formatDuration(elapsed)
              lastEl.appendChild(span)
            }
          }, 1000)
        }

        activeTools.set(ev.tool_call.id, {
          description,
          element: lastEl,
          startTime,
          timer,
        })

        // Track active exec element so sandbox-progress and sub-tool events can update it
        // B202: nested ToolCall shape, not flat.
        if (ev.tool_call.function?.name === 'execute_code') {
          activeExecElement = lastEl
          activeExecCallId = ev.tool_call.id
        }
        break
      }
      case 'tool_result': {
        const ev = payload as Extract<EngineEvent, { kind: 'tool_result' }>

        // Clear exec element tracking when execute_code finishes.
        // Check by call ID — description-based checks break when Phase 4 returns
        // labels like "Tracing callers: X" instead of "Executing: ...".
        if (ev.tool_call_id === activeExecCallId) {
          activeExecElement = null
          activeExecCallId = null
        }

        // ── In-place update: find the tool_request line and update it ──
        if (activeTools.has(ev.tool_call_id)) {
          updateToolElement(
            ev.tool_call_id,
            ev.success,
            ev.duration_ms,
            ev.success ? undefined : ev.output,
          )
        } else {
          // Fallback: no matching request (e.g., panel opened mid-run)
          addEntry({
            ts: new Date(),
            kind: 'tool_done',
            summary: ev.success ? 'Done' : `Failed: ${(ev.output || '').slice(0, 60)}`,
            success: ev.success,
            durationMs: ev.duration_ms,
          })
        }
        break
      }
      case 'thinking_delta': {
        if (!isThinking) {
          isThinking = true
          addEntry({ ts: new Date(), kind: 'thinking', summary: 'Thinking…' })
        }
        break
      }
      case 'agent_reasoning': {
        const ev = payload as Extract<EngineEvent, { kind: 'agent_reasoning' }>
        // First non-empty line as the summary; full text stored for expand-on-click
        const firstLine = ev.text.split('\n').find(l => l.trim().length > 0) || ''
        const summary = firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine
        addEntry({
          ts: new Date(),
          kind: 'reasoning',
          summary: `Round ${ev.round}: ${summary || 'Analysis'}`,
          detail: ev.text.length > firstLine.length ? ev.text : undefined,
        })
        break
      }
      case 'complete': {
        const ev = payload as Extract<EngineEvent, { kind: 'complete' }>
        isThinking = false

        // Format completion with token count
        const parts: string[] = ['Complete']
        const details: string[] = []
        if (ev.total_rounds) details.push(`${ev.total_rounds} rounds`)
        if (ev.tool_calls_count) details.push(`${ev.tool_calls_count} tools`)
        if (ev.usage?.total_tokens) {
          const tokens = ev.usage.total_tokens
          details.push(tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K tokens` : `${tokens} tokens`)
        }
        if (details.length) parts.push(`(${details.join(', ')})`)

        addEntry({
          ts: new Date(),
          kind: 'complete',
          summary: parts.join(' '),
        })

        // B66: clear any still-running tool timers from this run before we
        // mark the run completed. Without this, a tool that never received
        // its tool_result (run aborted, panel mid-restart) keeps firing its
        // 1-second update interval forever.
        for (const [, info] of activeTools) {
          if (info.timer) {
            clearInterval(info.timer)
            info.timer = null
          }
        }
        activeTools.clear()
        if (currentRunId) trackCompletedRun(currentRunId)
        break
      }
      case 'tool_auto_approved': {
        const ev = payload as Extract<EngineEvent, { kind: string }>
        // 1D-2: in yolo mode the engine fires both `tool_request` (audit
        // trail for the activity bar timer) AND `tool_auto_approved`. If
        // the tool_call_id already has an entry from `tool_request`, this
        // event is a duplicate and we skip it. The fallback path (no
        // matching tool_request, e.g. an event arriving before the panel
        // mounted) still records an entry so we don't lose the signal.
        const toolCallId = (ev as any).tool_call_id as string | undefined
        if (toolCallId && activeTools.has(toolCallId)) break
        addEntry({
          ts: new Date(),
          kind: 'auto_approved',
          summary: `Auto-approved: ${(ev as any).tool_name || 'tool'}`,
        })
        break
      }
    }
  })
}

// ─── Sandbox Sub-Tool Listener ───────────────────────────────────────────────

interface SandboxSubtoolStart {
  tool_name: string
  tool_call_id: string
  args_preview: string
}

interface SandboxSubtoolEnd {
  tool_call_id: string
  success: boolean
  duration_ms: number
}

async function startSandboxSubtoolListener(): Promise<void> {
  if (sandboxSubtoolUnlistenStart && sandboxSubtoolUnlistenEnd) return

  // ── Start event: create a nested sub-tool entry under the active execute_code line ──
  sandboxSubtoolUnlistenStart = await listen<SandboxSubtoolStart>('sandbox-subtool-start', ({ payload }) => {
    // Only show sub-tool entries when there is an active execute_code parent line.
    // If no execute_code is in flight (e.g. a stale event arrives late) we skip it.
    if (!activeExecElement) return

    // Build a human-readable label using the same TOOL_LABELS map
    const toolLabel = TOOL_LABELS[payload.tool_name] ?? payload.tool_name.replace(/^ide_/, '').replace(/_/g, ' ')
    let description = toolLabel
    try {
      const rawPreview = payload.args_preview.endsWith('…')
        ? payload.args_preview.slice(0, -1) // trim the ellipsis before parsing
        : payload.args_preview
      const parsedArgs = JSON.parse(rawPreview || '{}')
      // Most AST tools take `function`, `symbol`, or `name`; fallback to `path`
      const hint = parsedArgs.function ?? parsedArgs.symbol ?? parsedArgs.name
        ?? (parsedArgs.path ? (parsedArgs.path as string).split('/').slice(-1)[0] : null)
        ?? (parsedArgs.query ? `"${parsedArgs.query}"` : null)
      if (hint) description = `${toolLabel}: ${hint}`
    } catch { /* keep label-only fallback */ }

    addEntry({
      ts: new Date(),
      kind: 'subtool_active',
      summary: description,
      toolCallId: payload.tool_call_id,
    })

    const lastEl = listEl?.lastElementChild as HTMLElement | null
    const startTime = Date.now()

    // Running timer — updates duration every second while sub-tool is active
    let timer: ReturnType<typeof setInterval> | null = null
    if (lastEl) {
      timer = setInterval(() => {
        const elapsed = Date.now() - startTime
        const durSpan = lastEl.querySelector('.af-dur')
        if (durSpan) {
          durSpan.textContent = formatDuration(elapsed)
        } else {
          const span = document.createElement('span')
          span.className = 'af-dur'
          span.textContent = formatDuration(elapsed)
          lastEl.appendChild(span)
        }
      }, 1000)
    }

    activeSubTools.set(payload.tool_call_id, { description, element: lastEl, startTime, timer })
  })

  // ── End event: update the sub-tool entry in-place with success/duration ──
  sandboxSubtoolUnlistenEnd = await listen<SandboxSubtoolEnd>('sandbox-subtool-end', ({ payload }) => {
    const info = activeSubTools.get(payload.tool_call_id)
    if (!info) return

    if (info.timer) clearInterval(info.timer)

    if (info.element) {
      info.element.className = `af-entry af-subtool_done${payload.success === false ? ' af-fail' : ''}`
      const icon = payload.success !== false ? '↳✓' : '↳✗'
      const elapsed = payload.duration_ms ?? (Date.now() - info.startTime)
      const duration = ` <span class="af-dur">${formatDuration(elapsed)}</span>`
      const time = info.element.querySelector('.af-time')?.textContent ?? ''
      info.element.innerHTML = `<span class="af-time">${time}</span> <span class="af-icon">${icon}</span> <span class="af-text">${info.description}</span>${duration}`
    }

    activeSubTools.delete(payload.tool_call_id)
    autoScroll()
  })
}

// ─── Indexer Progress Listener ───────────────────────────────────────────────

interface IndexerProgress {
  phase: string
  current?: number
  total?: number
  percent?: number
  source?: string
  path?: string
}

let indexerLine: HTMLElement | null = null
let indexerUnlisten: (() => void) | null = null

// Status bar state
interface IndexStatus {
  phase: 'idle' | 'scanning' | 'chunking' | 'ast_ready' | 'embedding' | 'complete'
  current: number
  total: number
  percent: number
  label: string
}
const indexStatus: IndexStatus = { phase: 'idle', current: 0, total: 0, percent: 0, label: '' }
const astStatus: IndexStatus = { phase: 'idle', current: 0, total: 0, percent: 0, label: '' }
const embedStatus: IndexStatus = { phase: 'idle', current: 0, total: 0, percent: 0, label: '' }
let statusBarEl: HTMLElement | null = null

function renderStatusBar(): void {
  if (!statusBarEl) return

  function meterHtml(label: string, status: IndexStatus): string {
    const isComplete = status.phase === 'complete' || status.phase === 'ast_ready'
    const isIdle = status.phase === 'idle'
    const pct = status.percent
    const color = isComplete ? '#4CAF50' : isIdle ? '#333' : '#E8B931'
    const textColor = isComplete ? '#4CAF50' : isIdle ? '#555' : '#ccc'
    const icon = isComplete ? '✓' : isIdle ? '○' : '◉'
    const detail = isIdle ? '—' : status.label

    return `
      <div class="af-meter" style="color:${textColor}">
        <span class="af-meter-label">${icon} ${label}</span>
        <div class="af-meter-bar">
          <div class="af-meter-fill" style="width:${pct}%;background:${color}"></div>
        </div>
        <span class="af-meter-detail">${detail}</span>
      </div>
    `
  }

  statusBarEl.innerHTML =
    meterHtml('INDEX', indexStatus) +
    meterHtml('AST', astStatus) +
    meterHtml('EMBED', embedStatus)
}

async function startIndexerListener(): Promise<void> {
  if (indexerUnlisten) return
  indexerUnlisten = await listen<IndexerProgress>('indexer-progress', ({ payload }) => {
    const source = payload.source === 'external' ? `[ext] ` : ''
    const pathShort = payload.path ? payload.path.split('/').slice(-2).join('/') : ''

    switch (payload.phase) {
      case 'scanning': {
        const total = payload.total || 0
        indexStatus.phase = total > 0 ? 'complete' : 'scanning'
        indexStatus.percent = total > 0 ? 100 : 10
        indexStatus.label = total > 0 ? `${total} files` : `scanning ${pathShort}…`
        astStatus.phase = 'idle'; astStatus.percent = 0; astStatus.label = ''
        embedStatus.phase = 'idle'; embedStatus.percent = 0; embedStatus.label = ''
        renderStatusBar()

        indexerLine = null
        const entry: ActivityEntry = {
          ts: new Date(),
          kind: 'tool_active',
          summary: `${source}Indexing: scanning ${pathShort}…`,
        }
        addEntry(entry)
        indexerLine = listEl?.lastElementChild as HTMLElement | null
        break
      }
      case 'chunking': {
        const total = payload.total || 0
        indexStatus.phase = 'chunking'
        indexStatus.percent = 40
        indexStatus.current = 0
        indexStatus.total = total
        indexStatus.label = `${total} files`
        renderStatusBar()

        if (indexerLine) {
          const text = indexerLine.querySelector('.af-text')
          if (text) text.textContent = `${source}Indexing: ${total} files found, chunking…`
        }
        break
      }
      case 'ast_ready': {
        const chunks = payload.current || 0
        indexStatus.phase = 'complete'
        indexStatus.percent = 100
        indexStatus.label = `${indexStatus.total} files`
        astStatus.phase = 'ast_ready'
        astStatus.percent = 100
        astStatus.label = `${chunks} chunks`
        renderStatusBar()

        if (indexerLine) {
          indexerLine.className = 'af-entry af-tool_done'
          const text = indexerLine.querySelector('.af-text')
          if (text) text.textContent = `${source}Index ready: ${chunks} chunks, AST available`
        }
        indexerLine = null
        break
      }
      case 'embedding': {
        const current = payload.current || 0
        const total = payload.total || 0
        const pct = total > 0 ? Math.round((current / total) * 100) : 0
        embedStatus.phase = 'embedding'
        embedStatus.percent = pct
        embedStatus.current = current
        embedStatus.total = total
        embedStatus.label = `${current}/${total}`
        renderStatusBar()
        break
      }
      case 'complete': {
        embedStatus.phase = 'complete'
        embedStatus.percent = 100
        embedStatus.label = embedStatus.total > 0 ? `${embedStatus.total} chunks` : 'done'
        renderStatusBar()

        addEntry({
          ts: new Date(),
          kind: 'complete',
          summary: `${source}Indexing complete`,
        })
        indexerLine = null
        break
      }
    }
  })
}

// ─── Sandbox Progress Listener ───────────────────────────────────────────────

async function startSandboxProgressListener(): Promise<void> {
  if (sandboxProgressUnlisten) return
  sandboxProgressUnlisten = await listen<{ message: string; timestamp: number }>('sandbox-progress', ({ payload }) => {
    if (!activeExecElement) return
    const text = activeExecElement.querySelector('.af-text')
    if (text) {
      const short = payload.message.length > 80 ? payload.message.slice(0, 77) + '…' : payload.message
      text.textContent = `⚡ ${short}`
    }
  })
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const STYLES = `
  .af-panel {
    height: 100%; min-height: 0; overflow: hidden;
    display: flex; flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: transparent;
  }
  .af-header {
    flex-shrink: 0; padding: 10px 14px;
    display: flex; align-items: center; justify-content: space-between;
    border-bottom: 1px solid rgba(232, 185, 49, 0.2);
  }
  .af-title {
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.5px; color: #E8B931;
    display: flex; align-items: center; gap: 6px;
  }
  .af-pulse {
    width: 6px; height: 6px; border-radius: 50%; background: #E8B931;
    animation: af-pulse 2s ease-in-out infinite;
  }
  @keyframes af-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.2 } }
  .af-clear {
    background: none; border: none; color: #666; cursor: pointer;
    font-size: 11px; padding: 2px 6px; border-radius: 3px;
  }
  .af-clear:hover { color: #E8B931; background: rgba(232, 185, 49, 0.1); }
  .af-list {
    flex: 1; overflow-y: auto; padding: 6px 10px;
    overscroll-behavior: contain;
  }
  .af-list::-webkit-scrollbar { width: 4px; }
  .af-list::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
  .af-list::-webkit-scrollbar-thumb:hover { background: #E8B931; }
  .af-entry {
    padding: 2px 4px; font-size: 11px; line-height: 1.6;
    color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    border-left: 2px solid transparent; padding-left: 8px;
  }
  .af-tool_active { border-left-color: #E8B931; color: #ccc; }
  .af-tool_done { border-left-color: #4CAF50; color: #999; }
  .af-tool_done.af-fail { border-left-color: #ff6b6b; color: #ff6b6b; }
  .af-thinking { border-left-color: #555; color: #666; }
  .af-complete { border-left-color: #89d185; color: #89d185; font-weight: 500; }
  .af-error { border-left-color: #ff6b6b; color: #ff6b6b; }
  .af-auto_approved { border-left-color: rgba(232, 185, 49, 0.4); color: #777; }
  .af-subtool_active { border-left-color: rgba(232, 185, 49, 0.3); color: #aaa; padding-left: 20px; font-size: 10.5px; }
  .af-subtool_done { border-left-color: rgba(76, 175, 80, 0.4); color: #777; padding-left: 20px; font-size: 10.5px; }
  .af-subtool_done.af-fail { border-left-color: rgba(255, 107, 107, 0.4); color: #cc6666; }
  .af-round {
    border-left-color: transparent; color: #555; font-size: 10px;
    margin-top: 4px; letter-spacing: 0.5px;
    border-bottom: 1px solid #222; padding-bottom: 2px;
  }
  .af-run_start {
    border-left-color: #E8B931; color: #E8B931; font-size: 10px;
    margin-top: 8px; font-weight: 600;
  }
  .af-time { color: #555; font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 10px; }
  .af-icon { margin: 0 4px; }
  .af-text { }
  .af-dur { color: #555; font-size: 10px; margin-left: 4px; }
  .af-expandable { cursor: pointer; }
  .af-expandable:hover { background: rgba(255, 107, 107, 0.05); }
  .af-error-detail {
    white-space: pre-wrap; word-break: break-all;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 10px; color: #cc5555; line-height: 1.4;
    padding: 6px 8px; margin: 2px 0 4px 16px;
    background: rgba(255, 50, 50, 0.06);
    border-radius: 3px; border-left: 2px solid #ff6b6b;
    max-height: 150px; overflow-y: auto;
  }
  .af-status-bar {
    flex-shrink: 0; padding: 8px 12px;
    border-bottom: 1px solid rgba(232, 185, 49, 0.15);
    display: flex; flex-direction: column; gap: 4px;
  }
  .af-meter {
    display: flex; align-items: center; gap: 6px;
    font-size: 10px; line-height: 1;
  }
  .af-meter-label {
    width: 52px; flex-shrink: 0;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-weight: 600; font-size: 9px; letter-spacing: 0.5px;
  }
  .af-meter-bar {
    flex: 1; height: 4px; background: #222; border-radius: 2px;
    overflow: hidden;
  }
  .af-meter-fill {
    height: 100%; border-radius: 2px;
    transition: width 0.3s ease, background 0.3s ease;
  }
  .af-meter-detail {
    width: 70px; flex-shrink: 0; text-align: right;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 9px;
  }
  .af-empty {
    color: #444; font-size: 11px; text-align: center;
    padding: 40px 20px; line-height: 1.6;
  }
`

// ─── Registration ───────────────────────────────────────────────────────────

export function registerActivityFeed(): void {
  // Inject styles
  if (!document.getElementById('opide-af-styles')) {
    const style = document.createElement('style')
    style.id = 'opide-af-styles'
    style.textContent = STYLES
    document.head.appendChild(style)
  }

  // Start listening immediately (captures events before panel is opened)
  startListening().catch(e => console.warn('[opide-af] listener failed:', e))
  startIndexerListener().catch(e => console.warn('[opide-af] indexer listener failed:', e))
  startSandboxProgressListener().catch(e => console.warn('[opide-af] sandbox-progress listener failed:', e))
  startSandboxSubtoolListener().catch(e => console.warn('[opide-af] sandbox-subtool listener failed:', e))

  // Also poll index status after a short delay — catches cached indexes that loaded
  // before the indexer-progress listener was registered.
  setTimeout(() => {
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('get_index_status').then((status: any) => {
        if (status?.has_index && indexStatus.phase === 'idle') {
          indexStatus.phase = 'complete'
          indexStatus.percent = 100
          indexStatus.label = `${status.files} files`
          astStatus.phase = 'ast_ready'
          astStatus.percent = 100
          astStatus.label = `${status.chunks} chunks`
          embedStatus.phase = 'complete'
          embedStatus.percent = 100
          embedStatus.label = 'done'
          renderStatusBar()
        }
      }).catch(() => {})
    }).catch(() => {})
  }, 3000)

  registerCustomView({
    id: 'opide.activityFeed',
    name: 'Activity',
    location: ViewContainerLocation.Sidebar,
    icon: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>')}`,
    order: 6,
    default: false,

    renderBody(container) {
      container.style.cssText = 'height:100%;min-height:0;overflow:hidden;display:flex;flex-direction:column'

      // Fix flex parents for scroll (same pattern as extensions panel)
      let el: HTMLElement | null = container
      for (let i = 0; i < 5 && el; i++) {
        el = el.parentElement
        if (el) {
          el.style.minHeight = '0'
          if (getComputedStyle(el).display === 'flex') {
            el.style.overflow = 'hidden'
          }
        }
      }

      // Build DOM
      container.innerHTML = `
        <div class="af-panel">
          <div class="af-header">
            <div class="af-title"><div class="af-pulse"></div> Activity</div>
            <button class="af-clear" title="Clear">Clear</button>
          </div>
          <div class="af-status-bar"></div>
          <div class="af-list"></div>
        </div>
      `

      statusBarEl = container.querySelector('.af-status-bar')!
      renderStatusBar()

      // Query current index state (may have loaded from cache before listener was ready)
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('get_index_status').then((status: any) => {
          if (status?.has_index) {
            indexStatus.phase = 'complete'
            indexStatus.percent = 100
            indexStatus.label = `${status.files} files`
            astStatus.phase = 'ast_ready'
            astStatus.percent = 100
            astStatus.label = `${status.chunks} chunks`
            embedStatus.phase = 'complete'
            embedStatus.percent = 100
            embedStatus.label = 'done'
            renderStatusBar()
          }
        }).catch(() => {})
      }).catch(() => {})

      listEl = container.querySelector('.af-list')!

      // Clear button
      container.querySelector('.af-clear')!.addEventListener('click', () => {
        entries = []
        if (listEl) listEl.innerHTML = ''
      })

      // Render accumulated entries
      if (entries.length > 0) {
        renderAll()
      } else {
        listEl.innerHTML = '<div class="af-empty">Waiting for agent activity…</div>'
      }

      return {
        dispose() {
          // Clear all running tool timers to prevent memory leaks
          for (const [, info] of activeTools) {
            if (info.timer) clearInterval(info.timer)
          }
          activeTools.clear()
          // Clear sub-tool timers too
          for (const [, info] of activeSubTools) {
            if (info.timer) clearInterval(info.timer)
          }
          activeSubTools.clear()
          // B67: dispose all four module-level engine-event listeners. Without
          // this, hot-reload or workbench layout changes that re-mount the
          // panel stack additional listeners on top of the existing ones.
          if (unlistenFn) { unlistenFn(); unlistenFn = null }
          if (sandboxProgressUnlisten) { sandboxProgressUnlisten(); sandboxProgressUnlisten = null }
          if (sandboxSubtoolUnlistenStart) { sandboxSubtoolUnlistenStart(); sandboxSubtoolUnlistenStart = null }
          if (sandboxSubtoolUnlistenEnd) { sandboxSubtoolUnlistenEnd(); sandboxSubtoolUnlistenEnd = null }
          if (indexerUnlisten) { indexerUnlisten(); indexerUnlisten = null }
          listEl = null
          statusBarEl = null
        }
      }
    },
  })

  console.log('[opide-af] Activity feed registered')
}
