# OPIDE vs Cursor — Feature Gap Analysis

_Last updated: 2026-06-02_

## Why Cursor is beating VS Code

In VS Code the AI is a passenger (Copilot bolted on as an extension). In Cursor
the AI is the driver, woven into the edit loop itself. Concretely that is four
things:

1. **Tab (next-edit prediction).** Cursor's proprietary low-latency "Sonic"
   model predicts your *next edit*, not just autocomplete: multi-line, jumps to
   the next edit location, jumps across files when a change creates a
   dependency, auto-adds imports. This is the feature people get addicted to and
   the hardest to copy (they trained their own model).
2. **Whole-codebase context in every response** via embedding-based indexing.
3. **Composer / Agent** makes multi-file changes autonomously and presents them
   as one reviewable, atomic diff set.
4. **They own the fork**, so they reshape the editing surface (parallel agents,
   background agents) instead of being limited to VS Code's extension API.

Key framing: **OPIDE is already on Cursor's side of that divide** (AI-as-driver,
agent woven in, Engram codebase memory). We are not missing "the whole thing";
we are missing specific marquee features.

## The stack: Cursor 2026 vs OPIDE

| Capability | Cursor | OPIDE | Verdict |
|---|---|---|---|
| Chat (Cmd+L), multi-model | Yes (credit system) | Yes + more models (Ollama local, Claude Code Max, Kimi, DeepSeek, BYO keys) | **OPIDE ahead** |
| Inline edit (Cmd+K) | Yes | Yes (`opide.inlineEdit`) | Even |
| Multi-file agent + reviewable diffs | Yes (Composer) | Yes (engine + edit-review Accept/Reject) | Even-ish (UX polish gap) |
| Codebase indexing / memory | Yes (embeddings) | Yes (Engram HNSW + 13-lang AST) | **OPIDE ahead** (persistent memory) |
| MCP | Yes | Yes | Even |
| Extensions | Yes (VS Code marketplace) | Yes (Open VSX + sidecar) | Even (smaller registry) |
| **Tab / next-edit prediction** | Yes (Sonic model) | Basic inline completions only | **Biggest gap** |
| **Project Rules** (`.cursor/rules`) | Yes (globs/alwaysApply) | No | Gap (easy win) |
| **Web / docs context** (@web, @docs) | Yes | No web-search tool | Gap |
| **Rich @-symbols** (@git, @terminal, @codebase) | Yes | Files only | Partial gap |
| **Background / Cloud agents** | Yes (browser/phone/Slack to PR) | Local only | Gap (big lift) |
| **BugBot** (auto PR review) | Yes (GitHub) | No | Gap |
| **Terminal Cmd+K** (AI command gen) | Yes | No | Gap (easy) |
| **Hooks** (`.cursor/hooks`) | Yes (pre/post-edit) | No | Gap |
| **CLI headless agent** | Yes (CI/cron) | Claude Code bridge only | Gap |
| Rust/Tauri footprint | No (Electron) | Yes (lighter) | **OPIDE ahead** |

## Priorities (impact vs effort)

### Tier 1 — the moat
- **Tab / next-edit prediction.** Highest-impact gap, the everyday "wow."
  Realistically we will not out-train Sonic, but we can ship a credible version:
  a fast model (Kimi / Haiku / local) behind a next-edit *diff* harness that
  predicts the next change plus the jump location, sub-200ms target latency.
  Real project, not a weekend.
- **Composer-grade multi-file review UX.** Engine exists; the polish is the
  atomic, reviewable diff-set surface (the center-editor / diff work).

### Tier 2 — high value, low-to-medium effort
- **Project Rules** (`.opide/rules`, or honor `.cursor/rules` / `CLAUDE.md`),
  injected into the agent system prompt. Cheap, high impact, table stakes.
- **@web + @docs + @terminal + @git** context. Web-search tool plus terminal
  output capture into chat.
- **Terminal Cmd+K** (natural language to command). Small, delightful.

### Tier 3 — workflow expansion (bigger lifts)
- **Background agents** (async work to draft PR). Infra + GitHub integration;
  Cursor's 2026 frontier.
- **BugBot-style PR review** (GitHub App + review prompt).
- **Headless CLI** for CI.

## OPIDE's edges over Cursor (do not lose these)
Persistent **Engram memory** (beyond a per-session index), **BYO-keys / local
models** (no metered credit lock-in), **Claude Code Max** auth, **Rust/Tauri**
footprint, and the **multi-agent OpenPawz engine**. The wedge Cursor
structurally cannot match: _local-first, your models, persistent memory._

## Sources
- A new Tab model — https://cursor.com/blog/tab-update
- Cursor 2026: Composer, Agent Mode, MCP & Background Agent (DeployHQ) — https://www.deployhq.com/guides/cursor
- Cursor changelog — https://cursor.com/changelog
- Cursor vs VS Code (Augment Code) — https://www.augmentcode.com/tools/cursor-vs-vscode-comparison-guide
- Cursor vs VS Code vs Windsurf 2026 (daily.dev) — https://daily.dev/blog/cursor-vs-vs-code-vs-windsurf-ai-code-editor-comparison/
