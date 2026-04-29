/**
 * OPIDE Chat — Rendering
 *
 * All DOM rendering functions: message bubbles, markdown, diffs,
 * streaming indicators, plan progress, context pills, select updates.
 */

import { marked } from 'marked'
import { invoke } from '@tauri-apps/api/core'
import { applyCodeToEditor } from '../opide-editor.ts'
import { getWorkspace, getActiveFile, getSelectionRange } from '../ide-context.ts'
import { S } from './state.ts'
import type { ChatMsg, DiffLine } from './types.ts'

// ─── Markdown ────────────────────────────────────────────────────────────────

export function renderMd(content: string): string {
  try { return marked.parse(content, { async: false }) as string }
  catch { return `<pre>${content.replace(/</g, '&lt;')}</pre>` }
}

export function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ─── Path Links ──────────────────────────────────────────────────────────────

export function linkifyPaths(html: string): string {
  return html.replace(
    /(<(?:pre|code)[^>]*>[\s\S]*?<\/(?:pre|code)>)|(\/(?:Users|home|workspace|tmp|var|opt|srv)[^\s<>"'`,;)\]]{2,})/g,
    (_m, codeBlock, path) => {
      if (codeBlock) return codeBlock
      const name = path.split('/').pop() || path
      return `<span class="opide-path-link" data-fspath="${path}" title="${path}" style="display:inline-flex;align-items:center;gap:3px;background:rgba(77,170,252,0.08);color:var(--vscode-textLink-foreground,#4daafc);cursor:pointer;border-radius:4px;padding:1px 6px 1px 4px;font-family:var(--opide-font-mono);font-size:0.85em;border:1px solid rgba(77,170,252,0.18);vertical-align:middle;white-space:nowrap"><span class="codicon codicon-file-code" style="font-size:10px;opacity:0.8"></span>${name}</span>`
    },
  )
}

// Memoized loaders for the open-file path. The dynamic-import promises are
// cached so repeated clicks don't re-run the module-resolution machinery.
let _uriModule: any = null
let _commandsModule: any = null

async function loadOpenFileDeps(): Promise<{ URI: any; CommandsRegistry: any } | null> {
  try {
    if (!_uriModule) {
      _uriModule = await import('@codingame/monaco-vscode-api/vscode/vs/base/common/uri')
    }
    if (!_commandsModule) {
      _commandsModule = await import('@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands')
    }
    return { URI: _uriModule.URI, CommandsRegistry: _commandsModule.CommandsRegistry }
  } catch {
    return null
  }
}

export async function openPathInEditor(path: string): Promise<void> {
  const deps = await loadOpenFileDeps()
  if (!deps) {
    navigator.clipboard.writeText(path).catch(() => {})
    return
  }
  const cmd = deps.CommandsRegistry.getCommand('vscode.open')
  if (cmd?.handler) {
    cmd.handler(null as any, deps.URI.file(path))
  } else {
    navigator.clipboard.writeText(path).catch(() => {})
  }
}

// ─── Diff Computation ────────────────────────────────────────────────────────

export function computeDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n'), b = after.split('\n')
  const MAX = 400
  const A = a.slice(0, MAX), B = b.slice(0, MAX)
  const m = A.length, n = B.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1])
  const result: DiffLine[] = []
  let i = 0, j = 0
  while (i < m || j < n) {
    if (i < m && j < n && A[i] === B[j]) { result.push({ op: ' ', line: A[i] }); i++; j++ }
    else if (j < n && (i >= m || dp[i][j+1] >= dp[i+1][j])) { result.push({ op: '+', line: B[j] }); j++ }
    else { result.push({ op: '-', line: A[i] }); i++ }
  }
  return result
}

export function sliceDiffContext(lines: DiffLine[], ctx = 3): DiffLine[] {
  const changed = new Set<number>()
  lines.forEach((l, i) => { if (l.op !== ' ') for (let d = -ctx; d <= ctx; d++) changed.add(i + d) })
  const out: DiffLine[] = []
  let skipped = 0
  lines.forEach((l, i) => {
    if (changed.has(i)) { if (skipped) { out.push({ op: ' ', line: `… ${skipped} unchanged lines` }); skipped = 0 } out.push(l) }
    else skipped++
  })
  if (skipped) out.push({ op: ' ', line: `… ${skipped} unchanged lines` })
  return out
}

// ─── Code Block Styling ──────────────────────────────────────────────────────

export function styleCodeBlocks(el: HTMLElement): void {
  el.querySelectorAll('pre').forEach((pre) => {
    const wrapper = document.createElement('div')
    wrapper.style.cssText = 'position:relative;margin:6px 0'
    ;(pre as HTMLElement).style.cssText = 'background:var(--vscode-textCodeBlock-background,#1e1e1e);border:1px solid var(--vscode-widget-border,#333);border-radius:4px;padding:10px 12px;overflow-x:auto;font-size:12px;margin:0'

    const btnRow = document.createElement('div')
    btnRow.style.cssText = 'position:absolute;top:4px;right:4px;display:flex;gap:2px;opacity:0;transition:opacity 0.15s'

    const copyBtn = document.createElement('button')
    copyBtn.textContent = 'Copy'
    copyBtn.style.cssText = 'background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:3px;padding:2px 8px;font-size:10px;cursor:pointer'
    copyBtn.addEventListener('click', () => {
      const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? ''
      navigator.clipboard.writeText(code)
      copyBtn.textContent = 'Copied!'
      setTimeout(() => { copyBtn.textContent = 'Copy' }, 1500)
    })

    const applyBtn = document.createElement('button')
    applyBtn.textContent = 'Apply'
    applyBtn.style.cssText = 'background:#2ea043;color:white;border:none;border-radius:3px;padding:2px 8px;font-size:10px;cursor:pointer'
    applyBtn.addEventListener('click', async () => {
      const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? ''
      const applied = await applyCodeToEditor(code)
      if (applied) {
        applyBtn.textContent = 'Applied!'
        setTimeout(() => { applyBtn.textContent = 'Apply' }, 1500)
      } else {
        navigator.clipboard.writeText(code)
        applyBtn.textContent = 'Copied!'
        setTimeout(() => { applyBtn.textContent = 'Apply' }, 1500)
      }
    })

    btnRow.appendChild(copyBtn)
    btnRow.appendChild(applyBtn)
    wrapper.addEventListener('mouseenter', () => { btnRow.style.opacity = '1' })
    wrapper.addEventListener('mouseleave', () => { btnRow.style.opacity = '0' })
    pre.parentNode?.insertBefore(wrapper, pre)
    wrapper.appendChild(pre)
    wrapper.appendChild(btnRow)
  })

  el.querySelectorAll('code:not(pre code)').forEach((c) => {
    ;(c as HTMLElement).style.cssText = 'background:var(--vscode-textCodeBlock-background,#1e1e1e);padding:1px 5px;border-radius:3px;font-size:12px'
  })
}

// ─── Feedback Button ─────────────────────────────────────────────────────────

export function makeFeedbackBtn(iconCls: string, action: string, msg: ChatMsg): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.innerHTML = `<span class="codicon ${iconCls}" style="font-size:12px"></span>`
  btn.style.cssText = 'background:transparent;border:none;cursor:pointer;padding:2px 4px;border-radius:3px;opacity:0.6;display:flex;align-items:center'
  btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; btn.style.background = 'var(--vscode-toolbar-hoverBackground,rgba(255,255,255,0.1))' })
  btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.6'; btn.style.background = 'transparent' })
  btn.addEventListener('click', () => {
    if (action === 'copy') {
      navigator.clipboard.writeText(msg.content)
      btn.innerHTML = '<span class="codicon codicon-check" style="font-size:12px;color:#89d185"></span>'
      setTimeout(() => { btn.innerHTML = `<span class="codicon ${iconCls}" style="font-size:12px"></span>` }, 1500)
    } else if (action === 'up' || action === 'down') {
      msg.feedbackGiven = action
      if (msg.messageId && S.sessionId) {
        invoke('engine_message_feedback', {
          sessionId: S.sessionId,
          messageId: msg.messageId,
          agentId: S.selectedAgent?.agent_id ?? '',
          helpful: action === 'up',
        }).catch(console.error)
      }
      btn.style.opacity = '1'
    }
  })
  return btn
}

// ─── Message Bubble ──────────────────────────────────────────────────────────

export function makeBubble(msg: ChatMsg): HTMLElement {
  const wrap = document.createElement('div')
  const isUser = msg.role === 'user'
  const isTool = msg.role === 'tool'
  const isSystem = msg.role === 'system'

  const bubble = document.createElement('div')

  if (isUser) {
    wrap.style.cssText = 'display:flex;justify-content:flex-end;padding:6px 14px 2px'
    bubble.className = 'opide-chat-user-bubble'
    bubble.style.cssText = [
      'max-width:84%',
      'padding:10px 14px',
      'border-radius:16px 16px 4px 16px',
      'color:var(--vscode-foreground)',
      'font-size:13px',
      'line-height:1.55',
      'white-space:pre-wrap',
      'word-break:break-word',
    ].join(';')
    bubble.textContent = msg.content

  } else if (isTool) {
    wrap.style.cssText = 'display:flex;justify-content:flex-start;padding:1px 14px'

    const iconCls = msg.toolSuccess === false ? 'codicon-error' : msg.toolSuccess === true ? 'codicon-check' : 'codicon-tools'
    const iconColor = msg.toolSuccess === false ? '#f48771' : msg.toolSuccess === true ? '#4ec9a8' : '#888'
    const duration = msg.toolDuration ? `${msg.toolDuration}ms` : ''
    const fname = msg.filePath ? (msg.filePath.split('/').pop() ?? msg.filePath) : null

    bubble.style.cssText = 'width:100%;display:flex;flex-direction:column;gap:0'

    const card = document.createElement('div')
    card.className = 'opide-tool-card'
    card.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:6px',
      'padding:6px 10px',
      'cursor:pointer',
      'color:var(--vscode-descriptionForeground)',
      'font-size:11px',
      'user-select:none',
    ].join(';')

    const icon = document.createElement('span')
    icon.className = `codicon ${iconCls}`
    icon.style.cssText = `font-size:12px;color:${iconColor};flex-shrink:0`
    card.appendChild(icon)

    const toolLabel = document.createElement('span')
    toolLabel.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);font-family:var(--opide-font-mono)'
    toolLabel.textContent = msg.toolName || 'tool'
    card.appendChild(toolLabel)

    if (fname && msg.filePath) {
      const fileChip = document.createElement('span')
      fileChip.className = 'opide-path-link'
      fileChip.dataset.fspath = msg.filePath
      fileChip.title = msg.filePath
      fileChip.style.cssText = [
        'display:inline-flex',
        'align-items:center',
        'gap:3px',
        'background:rgba(77,170,252,0.08)',
        'color:var(--vscode-textLink-foreground,#4daafc)',
        'border:1px solid rgba(77,170,252,0.18)',
        'border-radius:4px',
        'padding:0 5px 0 3px',
        'font-family:var(--opide-font-mono)',
        'font-size:10px',
        'cursor:pointer',
        'white-space:nowrap',
      ].join(';')
      fileChip.innerHTML = `<span class="codicon codicon-file-code" style="font-size:9px;opacity:0.8"></span>${fname}`
      card.appendChild(fileChip)

      if (msg.linesAdded || msg.linesRemoved) {
        const stats = document.createElement('span')
        stats.style.cssText = 'font-size:10px;font-family:var(--opide-font-mono)'
        stats.innerHTML = [
          msg.linesAdded ? `<span style="color:#4ec9a8">+${msg.linesAdded}</span>` : '',
          msg.linesRemoved ? `<span style="color:#f48771"> −${msg.linesRemoved}</span>` : '',
        ].join('')
        card.appendChild(stats)
      }
    }

    if (duration) {
      const dur = document.createElement('span')
      dur.style.cssText = 'margin-left:auto;font-size:10px;opacity:0.45'
      dur.textContent = duration
      card.appendChild(dur)
    }

    const chevron = document.createElement('span')
    chevron.className = 'codicon codicon-chevron-right'
    chevron.style.cssText = 'font-size:10px;opacity:0.4;flex-shrink:0;transition:transform 0.15s;margin-left:2px'
    card.appendChild(chevron)

    bubble.appendChild(card)

    const expandEl = document.createElement('div')
    expandEl.style.cssText = 'display:none;margin:2px 0 4px;padding:0 4px'
    let expanded = false

    if (msg.diffLines && msg.diffLines.length > 0) {
      const diffEl = document.createElement('div')
      diffEl.style.cssText = [
        'font-size:11px',
        'font-family:var(--opide-font-mono)',
        'border-radius:6px',
        'overflow:hidden',
        'border:1px solid var(--vscode-widget-border,rgba(255,255,255,0.08))',
        'margin-bottom:3px',
      ].join(';')
      for (const dl of msg.diffLines) {
        const row = document.createElement('div')
        const bg = dl.op === '+' ? 'rgba(78,201,168,0.12)' : dl.op === '-' ? 'rgba(244,135,113,0.12)' : 'transparent'
        const color = dl.op === '+' ? '#4ec9a8' : dl.op === '-' ? '#f48771' : 'var(--vscode-descriptionForeground)'
        row.style.cssText = `background:${bg};color:${color};padding:0 8px;white-space:pre;overflow:hidden;text-overflow:ellipsis;line-height:1.5`
        row.textContent = `${dl.op === ' ' ? ' ' : dl.op} ${dl.line}`
        diffEl.appendChild(row)
      }
      expandEl.appendChild(diffEl)
    }

    const details = document.createElement('pre')
    details.style.cssText = 'font-size:10.5px;padding:6px 8px;background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.2));border-radius:5px;max-height:180px;overflow:auto;white-space:pre-wrap;color:var(--vscode-descriptionForeground);margin:0'
    details.textContent = msg.content
    expandEl.appendChild(details)
    bubble.appendChild(expandEl)

    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.opide-path-link')) return
      expanded = !expanded
      expandEl.style.display = expanded ? 'block' : 'none'
      chevron.style.transform = expanded ? 'rotate(90deg)' : 'rotate(0deg)'
    })

  } else if (isSystem) {
    wrap.style.cssText = 'display:flex;justify-content:center;padding:6px 14px'
    bubble.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);opacity:0.45;text-align:center;letter-spacing:0.02em'
    bubble.textContent = msg.content

  } else {
    // Assistant
    wrap.style.cssText = 'display:flex;justify-content:flex-start;padding:4px 0 2px'
    bubble.className = 'opide-chat-bubble'
    bubble.style.cssText = 'max-width:100%;font-size:13px;line-height:1.65;color:#d4d2cc;word-break:break-word'
    bubble.innerHTML = linkifyPaths(renderMd(msg.content))
    styleCodeBlocks(bubble)

    if (msg.tokenUsage || msg.model) {
      const meta = document.createElement('div')
      meta.style.cssText = 'font-size:10px;margin-top:10px;display:flex;gap:8px;align-items:center'
      if (msg.model) meta.innerHTML += `<span style="background:rgba(212,168,67,0.1);color:#d4a843;border:1px solid rgba(212,168,67,0.2);border-radius:6px;padding:2px 8px;font-size:10px;font-weight:500">${msg.model}</span>`
      if (msg.tokenUsage) meta.innerHTML += `<span>${(msg.tokenUsage.input + msg.tokenUsage.output).toLocaleString()} tokens</span>`
      bubble.appendChild(meta)
    }

    const feedbackRow = document.createElement('div')
    feedbackRow.style.cssText = 'display:flex;gap:2px;margin-top:6px;opacity:0;transition:opacity 0.15s'
    bubble.addEventListener('mouseenter', () => { feedbackRow.style.opacity = '1' })
    bubble.addEventListener('mouseleave', () => { feedbackRow.style.opacity = '0' })

    feedbackRow.appendChild(makeFeedbackBtn('codicon-thumbsup', 'up', msg))
    feedbackRow.appendChild(makeFeedbackBtn('codicon-thumbsdown', 'down', msg))
    feedbackRow.appendChild(makeFeedbackBtn('codicon-copy', 'copy', msg))
    bubble.appendChild(feedbackRow)
  }

  wrap.appendChild(bubble)
  return wrap
}

// ─── Render Messages ─────────────────────────────────────────────────────────

// Track how many messages are already rendered in DOM to enable incremental append
let _renderedCount = 0

export function renderMessages(): void {
  if (!S.msgList) return

  if (!S.messages.length && !S.streaming) {
    _renderedCount = 0
    S.msgList.innerHTML = ''
    const empty = document.createElement('div')
    empty.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px;text-align:center;padding:32px'
    empty.innerHTML = `
      <img src="${window.location.origin}/opide-logo.png" style="width:260px;height:auto" alt="OPIDE">
      <span style="font-size:11px;color:var(--vscode-descriptionForeground);opacity:0.4;letter-spacing:0.04em">Your codebase, understood.</span>
    `
    S.msgList.appendChild(empty)
    return
  }

  // If message count decreased (e.g., new session), do a full rebuild that
  // routes through the empty-state branch above when applicable.
  if (S.messages.length < _renderedCount) {
    return renderMessagesFull()
  }

  // Remove empty state placeholder if present
  if (_renderedCount === 0) {
    const empty = S.msgList.querySelector('div[style*="justify-content:center"]')
    if (empty) empty.remove()
  }

  // Incremental append: only add new messages — no DOM teardown, no focus loss
  for (let i = _renderedCount; i < S.messages.length; i++) {
    S.msgList.appendChild(makeBubble(S.messages[i]))
  }
  _renderedCount = S.messages.length

  S.msgList.scrollTop = S.msgList.scrollHeight
}

/** Force a full re-render (used when switching sessions or clearing chat) */
export function renderMessagesFull(): void {
  _renderedCount = 0
  if (S.msgList) S.msgList.innerHTML = ''
  renderMessages()
}

// ─── Streaming Bubble ────────────────────────────────────────────────────────

export function showStreamingBubble(): void {
  if (!S.msgList) return
  const wrap = document.createElement('div')
  wrap.id = 'opide-streaming'
  wrap.style.cssText = 'display:flex;justify-content:flex-start;padding:4px 0 2px'
  const bubble = document.createElement('div')
  bubble.className = 'opide-chat-bubble'
  bubble.style.cssText = 'max-width:100%;font-size:13px;line-height:1.65;color:#d4d2cc;word-break:break-word'
  bubble.innerHTML = `<span style="display:inline-flex;gap:4px;align-items:center;padding:4px 0">${[0,120,240].map(d => `<span style="width:6px;height:6px;border-radius:50%;background:#d4a843;opacity:0.3;animation:opide-pulse 1.2s ease-in-out ${d}ms infinite"></span>`).join('')}</span>`
  wrap.appendChild(bubble)
  S.msgList.appendChild(wrap)
  S.streamingBubble = bubble
  S.msgList.scrollTop = S.msgList.scrollHeight
}

/** Returns true when the scroll position is close enough to the bottom that
 *  auto-scrolling is appropriate (i.e. user hasn't manually scrolled up). */
function isNearBottom(): boolean {
  if (!S.msgList) return true
  const { scrollTop, scrollHeight, clientHeight } = S.msgList
  return scrollHeight - scrollTop - clientHeight < 100
}

/** Lightweight streaming render: avoids full marked.parse on every frame.
 *  Handles code fences, inline code, bold and newlines.  Full markdown is
 *  applied by commitStreamingBubble() once the stream is complete. */
function renderStreamingText(text: string): string {
  // Split on fenced code blocks so we handle their content separately
  const segments = text.split(/(```[\w]*\n?[\s\S]*?```)/g)
  return segments.map((seg, i) => {
    if (i % 2 === 1) {
      // Code-block segment — preserve as <pre>
      const m = seg.match(/^```(\w*)\n?([\s\S]*)```$/)
      if (m) {
        const lang = m[1]
        const code = m[2].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        return `<pre class="opide-code-block"${lang ? ` data-lang="${lang}"` : ''}><code>${code}</code></pre>`
      }
    }
    // Regular text segment
    return seg
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>')
  }).join('')
}

export function updateStreamingBubble(text: string): void {
  if (!S.streamingBubble) return
  S.pendingStreamText = text
  // Schedule exactly one DOM update per animation frame — no artificial delay
  if (S.streamingRafId !== null) return
  S.streamingRafId = requestAnimationFrame(() => {
    S.streamingRafId = null
    if (!S.streamingBubble) return
    S.streamingBubble.innerHTML =
      renderStreamingText(S.pendingStreamText) + '<span class="opide-stream-cursor"></span>'
    if (isNearBottom()) S.msgList?.scrollTo({ top: S.msgList.scrollHeight })
  })
}

/** Finalise the streaming bubble in-place with full markdown, then bump the
 *  internal render counter so renderMessages() treats it as already rendered.
 *  This avoids the remove-then-append flash that was visible on stream end. */
export function commitStreamingBubble(text: string): void {
  // Cancel any pending frame first
  if (S.streamingRafId !== null) {
    cancelAnimationFrame(S.streamingRafId)
    S.streamingRafId = null
  }
  if (!S.streamingBubble) return
  // Full markdown render now that the stream is complete
  S.streamingBubble.innerHTML = renderMd(text)
  // Promote the wrapper from a transient streaming element to a permanent one
  const wrap = S.streamingBubble.closest('#opide-streaming')
  if (wrap) wrap.removeAttribute('id')
  S.streamingBubble = null
  // Tell renderMessages() this slot is already in the DOM
  _renderedCount++
}

// ─── Tool / Status Indicators ────────────────────────────────────────────────

export function showToolIndicator(name: string): void {
  if (!S.toolRow) return
  S.toolRow.style.display = 'flex'
  const label = S.toolRow.querySelector('.opide-tool-label')
  if (label) label.textContent = `Running: ${name}`

  if (S.progressLog) {
    S.progressLog.style.display = 'block'
    S.progressLog.innerHTML = ''
  }
}

export function hideToolIndicator(): void {
  if (S.toolRow) S.toolRow.style.display = 'none'
  if (S.progressLog) S.progressLog.style.display = 'none'
}

export function updateStatus(text: string): void {
  if (S.headerStatus) S.headerStatus.textContent = text
}

export function setStreaming(active: boolean): void {
  S.streaming = active
  // Send button always visible — during streaming it redirects the agent
  if (S.sendBtn) S.sendBtn.style.display = 'flex'
  if (S.stopBtn) S.stopBtn.style.display = active ? 'flex' : 'none'
  // Textarea stays enabled during streaming so user can type a redirect
  if (S.textarea) {
    S.textarea.disabled = false
    S.textarea.placeholder = active
      ? 'Send to redirect agent… (Enter)'
      : 'Ask OPIDE anything… (Cmd+L)'
  }
  if (S.whisperRow) S.whisperRow.style.display = active ? 'flex' : 'none'
  if (!active && S.whisperInput) S.whisperInput.value = ''
  // Surface button: shown only during streaming
  if (S.surfaceBtn) S.surfaceBtn.style.display = active ? 'flex' : 'none'
  // Resume button: always hidden when streaming state changes — handleSurfaced shows it explicitly
  if (S.resumeBtn) S.resumeBtn.style.display = 'none'
  // Starting a new turn clears the surfaced state
  if (active) S.surfaced = false
}

// ─── Select Updates ──────────────────────────────────────────────────────────

export function updateAgentSelect(): void {
  if (!S.agentSelect) return
  S.agentSelect.innerHTML = '<option value="">Default agent</option>'

  // ── Built-in agents (V2 build only; empty in OSS) ───────────────────────
  // Skip the dynamic import + iteration when there are no builtins to render.
  import('../chat/send.ts').then(({ BUILTIN_AGENTS }) => {
    if (BUILTIN_AGENTS.length === 0) return
    for (const agent of BUILTIN_AGENTS as unknown as any[]) {
      const opt = document.createElement('option')
      opt.value = agent.agent_id
      opt.textContent = agent.name
      opt.style.fontWeight = '600'
      if (S.selectedAgent?.agent_id === agent.agent_id) opt.selected = true
      S.agentSelect!.appendChild(opt)
    }
  }).catch(() => {})

  // ── DB agents ─────────────────────────────────────────────────────────────
  for (const agent of S.agents) {
    const opt = document.createElement('option')
    opt.value = agent.agent_id
    opt.textContent = `${agent.agent_id} (${agent.role})`
    if (S.selectedAgent?.agent_id === agent.agent_id) opt.selected = true
    S.agentSelect.appendChild(opt)
  }
}

export function updateSessionSelect(): void {
  if (!S.sessionSelect) return
  S.sessionSelect.innerHTML = '<option value="">New chat</option>'
  for (const session of S.sessions.slice(0, 20)) {
    const opt = document.createElement('option')
    opt.value = session.id
    opt.textContent = session.title || session.id.slice(0, 12)
    if (S.sessionId === session.id) opt.selected = true
    S.sessionSelect.appendChild(opt)
  }
}

// ─── Attachments ─────────────────────────────────────────────────────────────

export function renderAttachBar(): void {
  if (!S.attachmentBar) return
  S.attachmentBar.innerHTML = ''
  updateContextPills()
  if (S.attachments.length === 0) { S.attachmentBar.style.display = 'none'; return }
  S.attachmentBar.style.display = 'flex'
  for (let i = 0; i < S.attachments.length; i++) {
    const att = S.attachments[i]
    const chip = document.createElement('div')
    chip.style.cssText = 'display:flex;align-items:center;gap:4px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:10px;padding:2px 8px;font-size:11px;max-width:160px'
    const icon = att.isImage ? 'codicon-file-media' : 'codicon-file-code'
    chip.innerHTML = `<span class="codicon ${icon}" style="font-size:11px"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${att.name}</span>`
    const rm = document.createElement('span')
    rm.innerHTML = '<span class="codicon codicon-close" style="font-size:10px;cursor:pointer;opacity:0.7"></span>'
    rm.addEventListener('click', () => { S.attachments.splice(i, 1); renderAttachBar() })
    chip.appendChild(rm)
    S.attachmentBar.appendChild(chip)
  }
}

// ─── Context Pills ───────────────────────────────────────────────────────────

export function updateContextPills(): void {
  if (!S.contextBar) return
  S.contextBar.innerHTML = ''
  const pills: { icon: string; label: string; title?: string }[] = []

  const workspace = getWorkspace()
  if (workspace) {
    const name = workspace.split('/').pop() ?? workspace
    pills.push({ icon: 'codicon-folder', label: name, title: workspace })
  }

  const activeFile = getActiveFile()
  if (activeFile) {
    const name = activeFile.split('/').pop() ?? activeFile
    pills.push({ icon: 'codicon-file-code', label: name, title: activeFile })
  }

  const sel = getSelectionRange()
  if (sel) {
    const lines = sel.endLine - sel.startLine + 1
    pills.push({ icon: 'codicon-selection', label: `${lines} lines selected` })
  }

  if (S.attachments.length > 0) {
    pills.push({ icon: 'codicon-paperclip', label: `${S.attachments.length} attached` })
  }

  if (S.thinkingLevel !== 'none') {
    pills.push({ icon: 'codicon-brain', label: `Think: ${S.thinkingLevel}` })
  }

  if (S.checkpoint) {
    pills.push({ icon: 'codicon-history', label: 'Checkpoint saved', title: `HEAD: ${S.checkpoint.head_sha.slice(0,7)}` })
  }

  if (pills.length === 0) {
    S.contextBar.style.display = 'none'
    return
  }

  S.contextBar.style.display = 'flex'
  for (const p of pills) {
    const chip = document.createElement('div')
    chip.title = p.title ?? p.label
    chip.style.cssText = 'display:flex;align-items:center;gap:3px;background:var(--vscode-badge-background,rgba(255,255,255,0.08));color:var(--vscode-badge-foreground,#aaa);border-radius:8px;padding:1px 7px;font-size:10px;white-space:nowrap;border:1px solid transparent'
    chip.innerHTML = `<span class="codicon ${p.icon}" style="font-size:10px;opacity:0.8"></span><span>${p.label}</span>`
    S.contextBar.appendChild(chip)
  }
}

// ─── Plan Progress ───────────────────────────────────────────────────────────

export function parsePlanSteps(text: string): string[] {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => /^\d+[\.\)]\s+\S/.test(l))
    .map(l => l.replace(/^\d+[\.\)]\s+/, '').trim())
    .filter(Boolean)
}

export function renderPlanProgress(): void {
  if (!S.planProgressEl || S.planSteps.length === 0) return
  S.planProgressEl.innerHTML = ''
  const header = document.createElement('div')
  header.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:11px;font-weight:600;color:var(--vscode-foreground);opacity:0.8'
  const done = S.planSteps.every((_, i) => i < S.planStepIndex)
  header.innerHTML = `<span class="codicon ${done ? 'codicon-check-all' : 'codicon-list-tree'}" style="font-size:13px;color:${done ? '#89d185' : 'var(--vscode-foreground)'}"></span>${done ? 'Plan complete' : 'Executing plan…'}`
  S.planProgressEl.appendChild(header)
  S.planSteps.forEach((step, i) => {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:flex-start;gap:7px;padding:3px 0;font-size:11px'
    const completed = i < S.planStepIndex
    const active = i === S.planStepIndex && S.streaming
    let iconHtml: string
    if (completed) {
      iconHtml = '<span class="codicon codicon-check" style="font-size:11px;color:#89d185;flex-shrink:0;margin-top:1px"></span>'
    } else if (active) {
      iconHtml = '<span class="codicon codicon-loading codicon-modifier-spin" style="font-size:11px;color:#E8B931;flex-shrink:0;margin-top:1px"></span>'
    } else {
      iconHtml = '<span style="width:11px;height:11px;border:1px solid var(--vscode-widget-border,#555);border-radius:2px;flex-shrink:0;margin-top:1px;display:inline-block"></span>'
    }
    const color = completed ? 'var(--vscode-descriptionForeground)' : active ? 'var(--vscode-foreground)' : 'var(--vscode-descriptionForeground)'
    const opacity = completed ? '0.6' : '1'
    row.innerHTML = `${iconHtml}<span style="color:${color};opacity:${opacity};line-height:1.4;text-decoration:${completed ? 'line-through' : 'none'}">${step}</span>`
    S.planProgressEl?.appendChild(row)
  })
}

export function attachPlanProgress(): void {
  if (!S.msgList || S.planSteps.length === 0) return
  S.planProgressEl?.remove()
  const el = document.createElement('div')
  el.style.cssText = 'margin:4px 12px 8px;padding:10px 12px;background:var(--vscode-sideBar-background);border:1px solid var(--vscode-widget-border,#333);border-radius:6px;border-left:3px solid #E8B931'
  S.planProgressEl = el
  S.planStepIndex = 0
  S.msgList.appendChild(el)
  renderPlanProgress()
  S.msgList.scrollTop = S.msgList.scrollHeight
}

export function clearPlanProgress(): void {
  S.planProgressEl?.remove()
  S.planProgressEl = null
  S.planSteps = []
  S.planStepIndex = 0
}
