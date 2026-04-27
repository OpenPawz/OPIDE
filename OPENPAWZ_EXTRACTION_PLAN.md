# OpenPawz Extraction Plan (Option C-thin)

## Goal

OPIDE owns the agent-loop / provider / tool-execution code it actually
uses. The `OPIDE/OpenPawz/` folder is deleted. OPIDE has zero dependency
on OpenPawz going forward — they are independent repos that share no
build coupling.

**Not in scope:** changing OpenPawz the product or upstream repo. This
plan only touches the vendored clone inside OPIDE.

## Current state (snapshot, 2026-04-27)

- `OPIDE/OpenPawz/` is a vendored copy of OpenPawz, no `.git` inside,
  not connected to any remote. Path-dep wiring exists in three places:
  - `OPIDE/src-tauri/Cargo.toml:41`
  - `OPIDE/crates/opide-bridge/Cargo.toml:10`
  - `OPIDE/crates/opide-ai/Cargo.toml:21`
- Cargo package name: `openpawz`. Lib name in code: `paw_temp_lib`.
- OPIDE registers 128 Tauri commands; only 19 of those are
  paw_temp_lib commands actually invoked from `OPIDE/src/` —
  the other ~110 OpenPawz handlers are wired in but unreachable
  (~86% dead weight).
- The 15% of OpenPawz that OPIDE actually consumes:
  - `atoms::types` — ProviderConfig, ProviderKind, Message, Role,
    StreamChunk, TokenUsage, ToolCall, ToolDefinition, FunctionDefinition
  - `atoms::traits` — AiProvider, ProviderFactory, ProviderError,
    ToolAssembler
  - `atoms::engram_types` — MemoryScope, ProceduralMemory, ProceduralStep
  - `engine::util` — check_sensitive_path, looks_like_credential_value,
    WriteTarget, classify_write_target, SENSITIVE_PATHS
  - `engine::state::EngineState` — engine boot + workspace lookup
  - `engine::tools::ExternalToolExecutor` (trait) and `execute_tool`
    (fallback fn)
  - `engine::key_vault::prefetch()` — startup hook
  - `engine::engram::cognitive_event::init()` — startup hook
  - `engine::types` re-exports
  - `engine::sessions::SessionStore` — referenced in opide-bridge
    (verify whether actually used)
  - The **19 frontend-called Tauri commands** listed in
    "Phase 2-5 surface" below.

## Target state

```
OPIDE/
├── crates/
│   ├── opide-engine/        ← NEW: replaces ../OpenPawz/src-tauri
│   │   ├── src/
│   │   │   ├── atoms/       (types, traits, engram_types only)
│   │   │   ├── engine/
│   │   │   │   ├── state.rs
│   │   │   │   ├── util.rs
│   │   │   │   ├── key_vault.rs
│   │   │   │   ├── agent_loop/  (only what chat.rs needs)
│   │   │   │   ├── providers/   (only what's actually used — see Decision B)
│   │   │   │   ├── sessions/    (slimmed)
│   │   │   │   ├── tools/       (only ExternalToolExecutor + execute_tool)
│   │   │   │   └── mcp/         (only what 4 mcp commands need)
│   │   │   ├── commands/    (only the 19 used commands)
│   │   │   └── lib.rs
│   │   └── Cargo.toml
│   ├── opide-bridge/        (re-points to opide-engine)
│   ├── opide-ai/            (re-points to opide-engine)
│   ├── opide-shell/         (unchanged)
│   └── opide-sandbox/       (unchanged)
├── src-tauri/               (re-points to opide-engine)
└── (no OpenPawz/ folder)
```

OPIDE is fully self-contained. `cargo build` does not reference any
path outside the OPIDE working tree.

## Open decisions (locked-in choices the plan assumes)

The plan needs commitments on these two before phase 5 / phase 2
respectively. Defaults proposed below; override before starting if
either is wrong.

### Decision A — Engram / memory subsystem

**RESOLVED (revised 2026-04-27): A1 — engram stays.**

Original framing: A2 (delete engram, native rating store) on the basis
that OPIDE only called `engine_message_feedback` and surfaced no memory
recall in any user-visible way. That premise was wrong — phase 1's
"unused command" survey was scoped to the OPIDE frontend only and
missed the OpenPawz Memory Palace view, which is a real OPIDE
feature ("major selling point" per the user) that visualises engram
memory: 3D force-directed graph, embedding scatter plot, recall cards.

Phase 1 deleted the Memory Palace's UI imports along with the rest of
the OpenPawz folder; the recovery commits (`7f21ff8`, `8b59a1f`)
restored both layers — re-registered 14 `engine_memory_*` Tauri
commands, and brought the 6 view files back as OPIDE-native code in
`src/opide/memory-palace/` with local `engine.ts` / `helpers.ts` /
`types.ts` shims and CSS scoped to `.opide-memory-palace`.

What's NOT in scope of this restoration:
- The OpenPawz **forge** subsystem (domain certification of memories)
  is gone permanently. Memory Palace's Forge tab was pruned from
  `molecules.ts`. If forge needs to come back, it's a separate
  initiative.
- The **embedding setup wizard** in `index.ts` was pruned because it
  invoked 6 backend commands (`get_embedding_provider`,
  `enable_memory_plugin`, etc.) that don't exist in OPIDE. Replaced
  with a one-line "configure embeddings in OPIDE Settings →
  Providers" message.

`engine_message_feedback` keeps its existing engram-backed semantics —
no native rating store, no behaviour change to the chat thumbs-up flow.

### Decision B — Provider abstraction

**RESOLVED: B2 (port all provider files).**

Original framing assumed OPIDE only used Claude Code via opide-bridge.
That was wrong: opide-bridge's ProviderFactory only handles
`ProviderKind::ClaudeCode` and returns `None` for everything else, at
which point OpenPawz's engine falls through to its built-in providers.
OPIDE's settings UI exposes 13 provider kinds (Ollama, OpenAI,
Anthropic, Google, DeepSeek, Moonshot/Kimi, Grok, Mistral, OpenRouter,
Azure Foundry, Claude Code, Custom). The B191 Kimi fix lives in
`engine/providers/openai.rs` — that's the user-tested path.

The whole `engine/providers/` directory is only 4 files:
- `openai.rs` — handles 8 OpenAI-compatible kinds (OpenAI, OpenRouter,
  DeepSeek, Grok, Mistral, Moonshot, Azure Foundry, Custom)
- `anthropic.rs`
- `google.rs`
- `mod.rs`

ClaudeCode stays handled by opide-bridge. Ollama is OpenAI-compatible
so routes through openai.rs.

Phase 2 ports all four files. Small surface, load-bearing.

---

## Phase 0 — Branch + scaffold (1 day)

**Goal:** Create the new crate skeleton without touching any consumer.
The OPIDE build still uses the old vendored copy at the end of this
phase. Confidence-building phase.

**Steps:**

1. Branch from `main`: `git checkout -b extract/phase-0-scaffold`.
2. `mkdir -p OPIDE/crates/opide-engine/src`.
3. Write `crates/opide-engine/Cargo.toml`:
   - `name = "opide-engine"`, `version = "0.1.0"`, edition `"2021"`.
   - Dependencies: copy from `OpenPawz/src-tauri/Cargo.toml`. Drop
     features `swarm`, `dex`, `n8n`, channels (telegram/discord/
     slack/matrix), webhook. Verify `default-features = false` is the
     default behaviour.
   - Workspace member: add to OPIDE's top-level `Cargo.toml` if a
     workspace exists, otherwise leave standalone.
4. Add empty `src/lib.rs` with a placeholder `pub fn ping() {}` so
   `cargo check` passes for the new crate.
5. **Don't wire any consumer to it yet.** Just confirm
   `cargo check -p opide-engine` is green.

**Acceptance criteria:**
- `cargo check -p opide-engine` succeeds.
- `cargo check` for the rest of the workspace unchanged.
- `npm run tauri:dev` still launches OPIDE.

**Land as PR #1 — "extract: scaffold opide-engine crate".**

---

## Phase 1 — Pure moves: atoms + util (1-2 days)

**Goal:** Move the three pure-data modules with zero behaviour change.
This validates the import-rewiring story before we touch any
state-carrying code.

**Files to move from `OpenPawz/src-tauri/src/` into
`crates/opide-engine/src/`:**

- `atoms/types.rs` → `atoms/types.rs`
- `atoms/traits.rs` → `atoms/traits.rs`
- `atoms/engram_types.rs` → `atoms/engram_types.rs` (only the structs
  OPIDE imports — MemoryScope, ProceduralMemory, ProceduralStep —
  drop the rest)
- `atoms/error.rs` → `atoms/error.rs` (used internally)
- `engine/util.rs` → `engine/util.rs` (the B194/B195/B197 work)
- `engine/util.rs` tests → keep alongside

**Don't move yet:**
- `atoms/constants.rs` — verify nothing imports from it; likely
  deletable. Defer.

**Steps:**

1. Branch: `extract/phase-1-atoms-util`.
2. `git mv` the files into their new home (preserves history).
3. Update `crates/opide-engine/src/lib.rs` to expose them:
   ```rust
   pub mod atoms { pub mod types; pub mod traits; pub mod engram_types; pub mod error; }
   pub mod engine { pub mod util; }
   ```
4. Add `opide-engine = { path = "../crates/opide-engine" }` to:
   - `OPIDE/src-tauri/Cargo.toml`
   - `OPIDE/crates/opide-bridge/Cargo.toml`
   - `OPIDE/crates/opide-ai/Cargo.toml`
   (Keep the `openpawz` path-dep for now — both coexist this phase.)
5. In each consumer, change imports for the moved modules only:
   - `use paw_temp_lib::atoms::types::...` → `use opide_engine::atoms::types::...`
   - `use paw_temp_lib::atoms::traits::...` → `use opide_engine::atoms::traits::...`
   - `use paw_temp_lib::atoms::engram_types::...` → `use opide_engine::atoms::engram_types::...`
   - `use paw_temp_lib::engine::util::...` → `use opide_engine::engine::util::...`
6. Delete the moved files from `OpenPawz/src-tauri/src/`. Re-export
   under their old names from `OpenPawz` if any internal OpenPawz code
   still references them — likely yes, since OpenPawz' own engine uses
   atoms internally:
   ```rust
   // OpenPawz/src-tauri/src/atoms/mod.rs
   pub use opide_engine::atoms::{types, traits, engram_types, error};
   ```
   This makes OpenPawz a thin shim during the migration.
7. `cargo test --workspace` — all pre-existing tests still green
   (security tests B194/B195 live here).
8. `npm run tauri:dev` — manual smoke test on a chat round.

**Acceptance criteria:**
- Workspace builds.
- All tests pass, including the security tests in util.rs.
- Manual chat smoke test works (Kimi or any provider).

**Land as PR #2 — "extract: move atoms + engine::util to opide-engine".**

---

## Phase 2 — chat.rs commands + agent loop (4-7 days, biggest phase)

**Goal:** Move the agent-loop machinery. This is the hardest phase
because chat.rs is the central nervous system.

**Surface to port (8 commands + 1 startup hook):**

| Command | File |
|---------|------|
| `engine_chat_send` | `commands/chat.rs` |
| `engine_chat_history` | `commands/chat.rs` |
| `engine_chat_abort` | `commands/chat.rs` |
| `engine_chat_inject` | `commands/chat.rs` |
| `engine_chat_surface` | `commands/chat.rs` |
| `engine_agent_reset` | `commands/chat.rs` |
| `engine_sessions_list` | `commands/chat.rs` |
| `engine_approve_tool` | `commands/chat.rs` |
| `engine_set_active_workspace` | `commands/chat.rs` (added in B197) |

**Engine modules these commands transitively pull:**
- `engine::state::EngineState` — heavy: SQLite, key vault, tool
  registry, MCP registry, cognitive event bus.
- `engine::agent_loop/` — the multi-round loop, tool executor,
  approval plumbing, sandbox enforcement, B196/B197/B198 fixes.
- `engine::providers/` — see Decision B. If B1 (default), drop
  everything except the `AiProvider` / `AnyProvider` trait/dispatch.
- `engine::sessions/` — message storage, session CRUD. Keep slim.
- `engine::types` re-exports and helper impls.
- `engine::key_vault` — credential encryption / keychain.
- `engine::engram::cognitive_event::init` — startup hook only.
  Strip the rest of engram (Decision A).
- `engine::tools::{ExternalToolExecutor, execute_tool}` — the trait
  + the fallback fn. Nothing else from `tools/` (OPIDE has its own
  tool implementations in opide-ai).

**Modules to drop entirely in this phase:**
- `engine/swarm/` (feature-gated, default off)
- `engine/orchestrator/`
- `engine/skills/` (WASM skills — already removed from prompts)
- `engine/dex/`, `engine/sol_dex/`
- `engine/n8n_engine/`
- `engine/channels/` (discord, slack, telegram, matrix bots)
- `engine/sandbox/` Docker orchestration
- `engine/browser/` browser automation
- `engine/mail/`, `engine/oauth/`, `engine/integrations/`
- `engine/forge/`, `engine/notifications/`
- `engine/health_monitor/`
- `engine/dashboard/` (and related)
- `engine/projects/`, `engine/flows/`, `engine/automations/`

**Steps:**

1. Branch: `extract/phase-2-chat`.
2. `git mv` the 8 command handlers' source code into
   `opide-engine/src/commands/chat.rs`. Drop the
   `#[tauri::command]` items not in our keep list.
3. `git mv` the engine modules listed above. As you move each,
   delete dead `use` lines and dead helpers.
4. Apply Decision B: drop or keep `providers/`.
5. Apply Decision A: replace `cognitive_event::init` callsite with
   the appropriate stub or no-op (A2). Delete the rest of
   `engine/engram/`.
6. Update `lib.rs` of opide-engine to expose:
   ```rust
   pub mod engine {
     pub mod state; pub mod util; pub mod key_vault;
     pub mod agent_loop; pub mod sessions; pub mod tools;
     // pub mod providers; (only if B2)
     pub mod types;
   }
   pub mod commands { pub mod chat; }
   ```
7. Rewire all `paw_temp_lib::engine::*` consumers in OPIDE to
   `opide_engine::engine::*`.
8. In `src-tauri/src/lib.rs`, replace
   `paw_temp_lib::commands::chat::engine_chat_send` (etc.) with
   `opide_engine::commands::chat::engine_chat_send`.
9. **Crucial test:** `cargo test --workspace` — engine tests
   (sandbox enforcement, agent loop, providers) must pass.
10. Manual verification:
    - `npm run tauri:dev`
    - Send a chat to Kimi: streams, completes, tool approval still
      works.
    - Test approval flow: B194 credential block, B197 workspace
      bound, B198 wrapper bypass.
    - Test redirect: send mid-stream message, confirm STOP wrapper
      and clean handoff.
    - Test surface/resume: trigger a surface event, resume.

**Acceptance criteria:**
- Workspace builds.
- All engine + sandbox tests pass.
- Manual chat lifecycle works end-to-end with at least one provider.
- All B191–B205 fixes still load-bearing.

**Land as PR #3 — "extract: port chat commands and agent loop".**

---

## Phase 3 — mcp.rs commands + MCP machinery (2-3 days)

**Goal:** Move the 4 MCP Tauri commands and only the MCP infrastructure
they touch.

**Surface to port:**

| Command |
|---------|
| `engine_mcp_save_server` |
| `engine_mcp_connect` |
| `engine_mcp_disconnect` |
| `engine_mcp_execute_tool` |

**Engine modules:**
- `engine::mcp::types` — McpServerConfig, McpServerStatus
- `engine::mcp/` — only the connection / lifecycle / execute path.
  Drop tool discovery / refresh / list commands (all unused).
- The dead `use crate::engine::channels` import in mcp.rs — delete on
  contact.

**Drop in this phase:**
- The 5 unused mcp.rs commands: `engine_mcp_list_servers`,
  `_remove_server`, `_status`, `_refresh_tools`, `_connect_all`.

**Steps:**

1. Branch: `extract/phase-3-mcp`.
2. `git mv commands/mcp.rs` (kept handlers only) and `engine/mcp/`
   (kept submodules only).
3. Drop the dead channels import.
4. Update lib.rs exports.
5. Rewire consumers (tauri::generate_handler! list in
   `src-tauri/src/lib.rs`, plus any callers in opide-bridge /
   opide-ai).
6. `cargo test`. `npm run tauri:dev` — connect an MCP server, run
   one tool through it, disconnect.

**Acceptance criteria:**
- `engine_mcp_save_server` + `_connect` + `_execute_tool` +
  `_disconnect` round-trip works against a known MCP server.
- No imports of `paw_temp_lib::engine::mcp::*` remain in OPIDE.

**Land as PR #4 — "extract: port mcp commands".**

---

## Phase 4 — config.rs + agent.rs commands (1-2 days)

**Goal:** Port the small remainders: provider config and agent listing.

**Surface to port:**

| Command | File |
|---------|------|
| `engine_get_config` | `commands/config.rs` |
| `engine_set_config` | `commands/config.rs` |
| `engine_upsert_provider` | `commands/config.rs` |
| `engine_list_provider_models` | `commands/config.rs` |
| `engine_list_all_agents` | `commands/agent.rs` |

**Drop in this phase:**
- All other `commands/config.rs` handlers (sandbox check, daily spend,
  storage paths, auto_setup, status, remove_provider — 9 unused).
- All other `commands/agent.rs` handlers (file CRUD, create/delete
  agent — 6 unused).

**Steps:**

1. Branch: `extract/phase-4-config-agent`.
2. `git mv` only the kept handlers.
3. Update lib.rs and the `tauri::generate_handler!` list.
4. `cargo test`. Manual verification: open settings, change provider
   config, restart, confirm persistence.

**Acceptance criteria:**
- Provider settings UI works.
- Agent dropdown still populates.

**Land as PR #5 — "extract: port config + agent commands".**

---

## Phase 5 — RESOLVED inline (no longer applicable)

**Original goal:** Land `engine_message_feedback` per Decision A2 (delete
engram, build a native SQLite rating store).

**Why it's gone:** Decision A flipped to A1 (engram stays) when Memory
Palace was identified as a load-bearing user-facing feature. The
`engine_message_feedback` handler keeps its existing engram-backed
semantics. No engram deletion, no rating-store replacement.

The work that *did* happen during what would have been phase 5:
- `7f21ff8` re-registered the 14 `engine_memory_*` commands the Memory
  Palace needs.
- `8b59a1f` restored the Memory Palace frontend into
  `src/opide/memory-palace/` as OPIDE-native code (option B — minus
  the Forge tab and the embedding setup wizard).

---

## Phase 6 — Cut the cord (1 day)

**Goal:** Remove the path-dep on `OpenPawz/src-tauri` and delete the
folder.

**Pre-conditions:**
- After phases 1-5, no `paw_temp_lib::*` imports remain anywhere in
  OPIDE source.
- No `openpawz = { path = "../OpenPawz/src-tauri" }` references in
  any Cargo.toml.

**Steps:**

1. Branch: `extract/phase-6-delete`.
2. `grep -rn "paw_temp_lib\|openpawz" OPIDE/src OPIDE/src-tauri OPIDE/crates`
   — must return zero matches before proceeding.
3. Remove `openpawz` lines from:
   - `OPIDE/src-tauri/Cargo.toml`
   - `OPIDE/crates/opide-bridge/Cargo.toml`
   - `OPIDE/crates/opide-ai/Cargo.toml`
4. `cargo clean` then `cargo build --workspace` — must succeed
   without OpenPawz.
5. `git rm -r OPIDE/OpenPawz/`.
6. Update OPIDE README to describe new layout (opide-engine instead
   of OpenPawz folder).
7. Run full test suite + manual smoke (chat, MCP, settings, feedback).

**Acceptance criteria:**
- `OPIDE/OpenPawz/` no longer exists.
- `cargo build --workspace` succeeds.
- All previous Kimi acceptance tests pass (B194/B195/B196/B197/B198/
  B199-B204/B205 still load-bearing).
- README reflects new structure.

**Land as PR #7 — "extract: delete OpenPawz folder, OPIDE is now self-contained".**

---

## Phase 7 — Optional slimming (open-ended)

**Goal:** Now that OPIDE owns the code, simplify subsystems that came
along for the ride but turn out to be over-engineered for OPIDE's
actual usage.

**Candidates (each = its own small PR):**
- Simplify `EngineState::new()` — drop initialization branches that
  served only deleted modules.
- Trim `sessions/` schema — drop tables for trades, positions, tasks,
  dashboards, automations (all now-deleted features).
- Simplify `key_vault` if OPIDE only uses a subset of credential
  types.
- Drop unused feature flags from opide-engine's Cargo.toml.
- Rename internal modules from OpenPawz heritage names to OPIDE-native
  names (low priority — cosmetic).

**No fixed timeline.** Pick when you have appetite.

---

## Risk register

| Risk | Mitigation |
|------|------------|
| Hidden import we missed → cargo error after phase 1-5 | Each phase ends with `cargo check --workspace`; small phases isolate breakage. |
| Manual smoke missed a regression | Each phase explicitly lists what to manually verify; the B-numbered fixes are the regression checklist. |
| EngineState init has hidden order-of-operations dependencies | Phase 2 acceptance includes a clean cold start of OPIDE — if init breaks, we catch it before merging. |
| Feature flags interact unexpectedly | We disable swarm/dex/n8n/channels features in phase 0; phase 2 confirms chat works without them. |
| Decision A2 changes user-visible behaviour | Documented above. If users notice missing memory recall, A1 is reachable from A2 by reintroducing the engram modules later. |
| Phase 2 PR too big to review | If chat.rs port grows past ~3k LOC, split into 2a (state + agent_loop machinery, no commands wired) and 2b (commands wired and tested). |

## Verification checklist (run after each phase)

- [ ] `cargo build --workspace` (no warnings about unused deps if
      possible)
- [ ] `cargo test --workspace`
- [ ] `npm run tauri:dev` launches OPIDE
- [ ] Chat round-trip with Kimi (or any configured provider)
- [ ] Tool approval banner appears for credential write attempt (B194)
- [ ] Tool approval banner appears for shell redirect to /etc/passwd
      (B195)
- [ ] Tool approval banner appears for execute_code (B196/B198)
- [ ] Workspace bound enforced (B197)
- [ ] Replies render once, not twice (B205)

## Rollback

Each phase is a separate PR on its own branch. If any phase introduces
a regression discovered after merge:

- Revert the phase's merge commit on main.
- The previous phase's branch state is reachable via reflog/PR.
- Because phases are additive (each leaves OPIDE building), reverting
  one returns OPIDE to a known-good state.

The point of no return is **phase 6** (the actual folder deletion). Up
to that point, the OpenPawz folder still exists alongside opide-engine
as a safety net. After phase 6, recovery requires re-vendoring from
some external OpenPawz source.

## File sizes / scale

Approximate (run `find OpenPawz/src-tauri/src -name '*.rs' | xargs wc -l`
for current numbers):

- OpenPawz current: ~80k-120k lines of Rust
- Expected opide-engine after extraction: ~10k-20k lines (15-25%)
- Net deletion: ~60k-100k lines of code OPIDE no longer carries.

## Ownership notes

- This plan was generated against the OPIDE state at commit `6a64617`
  (B205, on `main` post-merge of cleanup-pass-1).
- Reference: PR https://github.com/OpenPawz/OPIDE/pull/1 contains the
  prior cleanup work this plan builds on.
- All B-numbered references in this document refer to bug fixes from
  cleanup-pass-1; their tests are the regression contract for the
  extraction.
