# OPIDE vs Cursor — Strategic Deep Dive

_Last updated: 2026-06-09. Companion to docs/CURSOR-GAP-ANALYSIS.md (the
feature-parity checklist). This doc is about positioning: where we close the
gap, and where we structurally overtake._

## The core thesis

**Cursor is a VS Code fork with agents bolted on. OPIDE is an agent platform
that grew an editor.**

That sounds like marketing, but it's an architectural fact with consequences.
Cursor started from Microsoft's editor and has spent two years knee-jerking
agent features onto a codebase designed for human-driven editing — under a
metered API-reseller business model. OPIDE started from the OpenPawz engine
(multi-agent, persistent memory, encrypted, skill-extensible) and mounted a
real VS Code-class workbench on top via monaco-vscode-api + a Tauri shell. The
agent isn't a panel in OPIDE; it's the substrate.

## Cursor's exposed flank (where we overtake, not just match)

Grounded in current reporting (sources at bottom), Cursor has four structural
weaknesses we are positioned to attack:

### 1. The pricing betrayal (our biggest opening)
June 2025 Cursor silently swapped fixed request quotas for usage-based credit
pools tied to raw API cost. Power users posted receipts: $10–20/day surprise
charges, a $7,000 annual plan drained in one day, one user ~$1,400/month vs the
"$20-ish" they signed up for. Cursor publicly apologized + refunded, but trust
didn't recover — users now watch every release with suspicion.

**OPIDE's structural answer: BYO-keys and local models. No metered reseller
margin, ever.** You pay Anthropic/OpenAI/Google directly at cost, or run Ollama
/ Kimi / local models for $0. We are not in the token-arbitrage business, so we
can never do to users what Cursor did. This is not a feature we added; it's a
business model Cursor cannot copy without dismantling their revenue.

### 2. Eight-party data fan-out vs local-first
Cursor routes code through up to 8 third parties (Fireworks, Baseten, Together,
OpenAI, Anthropic, Google Vertex, xAI, Turbopuffer). "Privacy Mode" is
unverifiable. They've also shipped multiple high-severity RCE CVEs (prompt
injection + config-file manipulation) since mid-2025.

**OPIDE's answer:** the agent, the Engram memory, the indexer, and the vault all
run **on the user's machine**. Code leaves only to the provider the user chose,
with their own key. Plus we already ship defense-in-depth Cursor lacks:
injection scanning of tool results (`engine::injection`, 38 files touch it),
SSRF-hardened fetch, an OS-keychain-backed encrypted vault (AES-256-GCM), and
encrypted-at-rest chat/config. We should get this independently audited and make
it a headline — it's a real, demonstrable edge, not a claim.

### 3. Performance + stability fatigue
Documented: sluggish/freezing editor, 5+ crashes/day reports, release-breaking
updates (2.1 corrupted chat history + worktrees), broken Tab key, AI editing
unrelated files without permission.

**OPIDE's answer:** Rust + Tauri (no Electron tax — smaller, lighter), and a
**reviewable edit gate** (green/red diff Accept/Reject, Accept-All/Reject-All
per turn) so the agent never silently mutates files — the exact failure Cursor
shipped. We must protect this with the regression discipline we just started
(793 Rust tests + extension-host smoke test); stability IS the wedge against an
incumbent that broke its users' trust on reliability.

### 4. The fork's TOS gray area
Cursor pulls from Microsoft's marketplace as a non-VS-Code product. OPIDE uses
**Open VSX** (Eclipse Foundation) exclusively — legally clean by construction.
Minor today, real moat at enterprise procurement time.

## What we have that Cursor does not (VERIFIED against OPIDE source)

> **Honesty rule for this doc:** every row below was checked against actual
> OPIDE wiring (allowlist `OPIDE_EXPOSED_TOOLS`, startup init, frontend
> surface), NOT against tool names or planning docs. The OpenPawz engine
> defines far more than OPIDE exposes — tool definitions existing in the crate
> does NOT mean they work in OPIDE. See "OpenPawz-only — NOT in OPIDE" below.

| Capability | What it is | Verified | Cursor equivalent |
|---|---|---|---|
| **Persistent Engram memory** | HNSW vector + graph + consolidation across sessions; `cognitive_event::init()` at startup, `memory_*` tools exposed, ContextBuilder/WorkingMemory wired into the agent loop | ✅ real & active | Per-session embeddings only — forgets between sessions |
| **Memory Palace** | Live graph visualization of the Engram memory (`src/opide/memory-palace/`) | ✅ real UI | None |
| **Reviewable edit gate** | `request_edit_review` → green/red diff, Accept/Reject, Accept-All/Reject-All per turn — agent never silently mutates files | ✅ real & wired | None (Cursor has shipped silent unrelated-file edits) |
| **Encrypted vault** | OS-keychain AES-256-GCM credential store; chat/config encrypted at rest | ✅ real | None in-editor |
| **Injection-scanned tool results** | `engine::injection` wraps tool output before it re-enters the loop; SSRF-hardened fetch | ✅ real | None |
| **Soul files** | Durable agent identity/preferences (`soul_read/write/list`), file-based | ✅ exposed, minor | Rules files (static text only) |
| **DAG planning** | `execute_plan` referenced in the agent loop | ⚠️ reachable, depth unverified | Linear agent loop |

This is a **single-agent** IDE with genuinely persistent, visualized memory, a
real edit-approval gate, and on-machine security. That's a true and defensible
differentiator — but it is NOT the "agent organism with squads and skills"
story; that belongs to the parent project (OpenPawz).

## OpenPawz-only — NOT in OPIDE (do not market these for OPIDE)

These exist in the shared engine crate (pulled from OpenPawz) but are
unreachable or vestigial in OPIDE. Claiming them would be false:

- **Multi-agent squads** — `create_squad`/`squad_broadcast`/etc. are NOT in
  OPIDE's `OPIDE_EXPOSED_TOOLS` allowlist. Unreachable.
- **Agent-to-agent messaging** — `agent_send_message`/`agent_read_messages` are
  exposed, BUT `create_agent` is not and OPIDE runs a single "default agent" —
  there is no second agent to message. Vestigial.
- **WASM skills** — `engine::skills` was deleted in the OPIDE extraction;
  `skill_tools()` returns an empty list. Gone.
- **Canvas dashboards** — `canvas_*` tools are allowlisted but there is no
  canvas rendering surface in the OPIDE frontend. Vestigial.

If we WANT any of these in OPIDE, they are roadmap items requiring real wiring
(multi-agent runtime, a skills host, a canvas panel), not existing features.

## Close-the-gap priorities (where Cursor is still ahead)

From CURSOR-GAP-ANALYSIS.md, ranked by leverage:

1. **Tab / next-edit prediction — the one true gap.** We shipped FIM + recent-
   edit awareness (the model-side groundwork). The missing piece is the
   **next-edit-LOCATION jump UI**: predict where the next edit goes (possibly
   another file) and let the user Tab to it. This is Cursor's single most-loved
   feature and the highest-value thing we can build. Realistically we won't
   out-train their Sonic model, but a credible jump-to-next-edit on a fast
   local/Kimi model is achievable and would neutralize their headline demo.
2. **Composer-grade multi-file review surface** — we have the engine + edit
   gate; needs the consolidated atomic diff-set view (the reverted center-editor
   work, retried properly).
3. **Background/cloud agents** — Cursor's 2026 frontier (browser/phone → PR).
   Our multi-agent engine is *more* capable locally; the gap is the async-remote
   + GitHub-PR plumbing, not the agent.
4. Smaller: scoped terminal Cmd+K keybinding, richer @-mentions (@web/@terminal),
   BugBot-style PR review (we have the agent; needs the GitHub App).

## Positioning one-liner candidates (only claims that survive code-check)
- "Your model, your keys, your machine. No surprise bills. No eight middlemen."
- "The AI IDE that remembers — across every session, on your hardware."
- "The agent never edits without your yes." (the reviewable edit gate)
- Do NOT use "agent platform / organism / squads" for OPIDE — those are
  OpenPawz, not OPIDE (see the NOT-in-OPIDE section).

## Sources
- Cursor pricing timeline / backlash — https://www.wearefounders.uk/cursors-pricing-disaster-the-full-timeline-of-how-an-ai-coding-darling-burned-its-most-loyal-users/
- Pricing hidden costs — https://www.wearefounders.uk/cursor-pricing-2026-every-plan-explained-and-the-hidden-costs-nobody-mentions/
- Security / data routing / CVEs — https://witness.ai/blog/cursor-ai-security/ , https://www.truefoundry.com/blog/cursor-security
- Developer sentiment / "built for demos" — https://machine-learning-made-simple.medium.com/built-for-demos-not-for-devs-05186132116f
- Reviews — https://checkthat.ai/brands/cursor/reviews
