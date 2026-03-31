# OpenPawz CLI

Command-line interface to the OpenPawz AI engine. Talks directly to the same `openpawz-core` library as the desktop app — zero network overhead, shared SQLite database and configuration.

## Installation

### From source

```bash
cd src-tauri
cargo build --release -p openpawz-cli
# Binary at target/release/openpawz
```

### Move to PATH (optional)

```bash
cp target/release/openpawz ~/.local/bin/
# or
sudo cp target/release/openpawz /usr/local/bin/
```

### Shell Completions

```bash
# Bash
openpawz completions bash > ~/.local/share/bash-completion/completions/openpawz

# Zsh
openpawz completions zsh > ~/.zfunc/_openpawz

# Fish
openpawz completions fish > ~/.config/fish/completions/openpawz.fish

# PowerShell
openpawz completions powershell >> $PROFILE
```

## Quick Start

```bash
# Run the setup wizard (configures your AI provider)
openpawz setup

# Check engine status
openpawz status

# List your agents
openpawz agent list

# View chat history
openpawz session list
openpawz session history <session-id>

# Store a memory
openpawz memory store "The user prefers dark mode" --category preference --importance 7
```

## Global Flags

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--output <format>` | | Output format: `human`, `json`, `quiet` | `human` |
| `--verbose` | `-v` | Enable debug logging | off |

The `--output` flag works with every command:

```bash
# Machine-readable JSON output (for scripting)
openpawz agent list --output json

# Quiet mode — IDs only (for piping)
openpawz session list --output quiet

# Human-readable tables (default)
openpawz agent list
```

## Commands

### `setup` — Initial Setup Wizard

Interactive wizard that configures your AI provider and writes the engine config.

```bash
openpawz setup
```

Supported providers:
1. **Anthropic** (Claude) — default
2. **OpenAI** (GPT)
3. **Google** (Gemini)
4. **Ollama** (local, no API key needed)
5. **OpenRouter**

If already configured, prompts before overwriting.

---

### `status` — Engine Diagnostics

```bash
openpawz status
```

Shows:
- Engine configuration state
- AI provider status
- Memory configuration
- Data directory path
- Session count

```bash
# JSON output for monitoring scripts
openpawz status --output json
```

---

### `agent` — Agent Management

#### List all agents

```bash
openpawz agent list
```

```
AGENT ID             PROJECT              ROLE
------------------------------------------------------------
research-agent       default              researcher
code-review          backend              reviewer
```

#### Get agent details

```bash
openpawz agent get <agent-id>
```

Shows the agent's files and their sizes.

#### Create a new agent

```bash
openpawz agent create --name "Research Agent" --model claude-sonnet-4-20250514
```

The `--model` flag is optional. A unique ID is generated automatically.

#### Delete an agent

```bash
openpawz agent delete <agent-id>
```

Removes the agent and all associated files.

#### Read an agent file

```bash
openpawz agent file-get --id research-agent --file SOUL.md
```

Reads and prints the content of a specific agent file (e.g. `SOUL.md`, `IDENTITY.md`, `persona.md`).

#### Write an agent file

```bash
# Inline content
openpawz agent file-set --id research-agent --file SOUL.md --content "You are a careful researcher."

# From a local file
openpawz agent file-set --id research-agent --file SOUL.md --from-file ~/agent-soul.md
```

#### Show composed agent context

```bash
openpawz agent context research-agent
```

Assembles and prints the full agent context (soul + persona + identity files combined).

#### Export an agent to a directory

```bash
openpawz agent export research-agent --output ./my-agent/
```

Writes all agent files (SOUL.md, IDENTITY.md, etc.) to the target directory for version control or sharing.

#### Import agent files from a directory

```bash
openpawz agent import --id research-agent --input ./my-agent/
```

Reads `.md`, `.json`, `.txt`, `.yaml`, `.yml`, `.toml` files from the directory and stores them as agent files. Creates the agent if it doesn't exist. Ideal for Infrastructure-as-Code agent provisioning.

```bash
# Example: bootstrap an agent from a Git repo
git clone https://github.com/team/agent-templates.git
openpawz agent import --id security-auditor --input agent-templates/security/
```

---

### `session` — Chat Session Management

#### List sessions

```bash
openpawz session list
openpawz session list --limit 10
```

```
ID                                       MODEL                          MSGS UPDATED
-----------------------------------------------------------------------------------------------
abc123-def456...                         claude-sonnet-4-20250514          24 2026-03-10 14:30
```

#### View chat history

```bash
openpawz session history <session-id>
openpawz session history <session-id> --limit 10
```

Messages are color-coded by role (user, assistant, system, tool).

#### Rename a session

```bash
openpawz session rename <session-id> "My Research Chat"
```

#### Delete a session

```bash
openpawz session delete <session-id>
```

#### Clean up empty sessions

```bash
openpawz session cleanup
```

Removes sessions older than 1 hour that have no messages.

#### Prune old messages

```bash
openpawz session prune <session-id> --keep 20
```

Removes old messages from a session, keeping only the most recent N. Useful for reclaiming space in long-running sessions.

#### Export session to file

```bash
openpawz session export <session-id> --output chat.json
```

Exports the full session metadata and message history as a JSON file.

---

### `config` — Engine Configuration

#### View current config

```bash
openpawz config get
```

Prints the full engine configuration as pretty-printed JSON.

#### Set a config value

```bash
openpawz config set default_model claude-sonnet-4-20250514
openpawz config set daily_budget_usd 10.0
openpawz config set max_tool_rounds 15
```

Values are parsed as JSON when possible (numbers, booleans, arrays), otherwise stored as strings.

Configuration keys are validated against a known allowlist. Use `openpawz config keys` to see all valid keys.

#### List valid config keys

```bash
openpawz config keys
```

#### Show configured providers

```bash
openpawz config providers
```

Shows each provider's ID, kind, default model, and whether an API key is set.

#### Get data directory path

```bash
openpawz config path
```

---

### `memory` — Memory Operations

#### List memories

```bash
openpawz memory list
openpawz memory list --limit 50
```

```
[a1b2c3d4] (preference, imp:7) The user prefers dark mode
[e5f6g7h8] (fact, imp:9) Project uses Rust with Tauri

2 memor(ies)
```

#### Store a new memory

```bash
openpawz memory store "The deploy target is AWS us-east-1" \
  --category fact \
  --importance 8 \
  --agent research-agent
```

| Flag | Default | Description |
|------|---------|-------------|
| `--category` | `general` | Category: `general`, `preference`, `fact`, etc. |
| `--importance` | `5` | Importance level (0–10) |
| `--agent` | none | Associate with a specific agent |

#### Delete a memory

```bash
openpawz memory delete <memory-id>
```

#### Search memories

```bash
openpawz memory search "deploy target"
openpawz memory search "user preferences" --limit 5
```

Full-text search across all stored memories using FTS5.

#### Memory statistics

```bash
openpawz memory stats
```

Shows total memory count, embedding status, and per-category breakdown.

#### Export memories (encrypted)

```bash
openpawz memory export --output memories.enc --agent global --passphrase "my-secret"
```

Exports all memories for an agent (or `global` for all) as an AES-256-GCM encrypted archive with HMAC integrity verification. Passphrase must be at least 8 characters.

#### Import memories (encrypted)

```bash
openpawz memory import --input memories.enc --passphrase "my-secret"
```

Decrypts and imports memories from an archive. Duplicate IDs are skipped.

---

### `task` — Task Management

#### List tasks

```bash
openpawz task list
openpawz task list --status pending
```

Displays all tasks with status, priority, title, and assigned agent.

#### Get task details

```bash
openpawz task get <task-id>
```

Shows full task metadata including multi-agent assignments and cron schedule.

#### Create a task

```bash
openpawz task create --title "Review security audit" --priority high --agent research-agent
openpawz task create --title "Daily report" --description "Generate morning briefing"
```

| Flag | Default | Description |
|------|---------|-------------|
| `--title` | required | Task title |
| `--description` | none | Detailed description |
| `--priority` | `medium` | Priority: `low`, `medium`, `high`, `critical` |
| `--agent` | none | Agent to assign |

#### Update a task

```bash
openpawz task update <task-id> --status done
openpawz task update <task-id> --priority urgent --title "New title"
```

#### Delete a task

```bash
openpawz task delete <task-id>
```

#### Show due cron tasks

```bash
openpawz task due
```

Lists tasks with cron schedules that are currently due for execution.

---

### `audit` — Audit Trail

Tamper-evident HMAC-SHA256 chained audit log for all engine operations.

#### View recent audit entries

```bash
openpawz audit log
openpawz audit log --limit 50
openpawz audit log --category tool_call
openpawz audit log --agent research-agent
```

| Filter | Description |
|--------|-------------|
| `--limit` | Max entries (default 25) |
| `--category` | `tool_call`, `memory`, `credential`, `api_request`, `security`, `cognitive`, `flow` |
| `--agent` | Filter by agent ID |

#### Verify audit chain integrity

```bash
openpawz audit verify
```

Walks the entire HMAC chain and verifies every entry's signature. Returns exit code 0 if intact, non-zero if tampered.

```bash
# Use in CI/monitoring scripts
if openpawz audit verify --output quiet; then
  echo "Audit chain OK"
else
  echo "WARNING: Audit chain tampered!"
fi
```

#### Audit statistics

```bash
openpawz audit stats
```

Shows total entries, time range, and per-category breakdown.

---

### `project` — Multi-Agent Project Orchestration

Manage multi-agent projects with boss/worker delegation, team composition, and message logs.

#### List projects

```bash
openpawz project list
```

```
ID           STATUS       TITLE                          BOSS            AGENTS
-------------------------------------------------------------------------------------
proj-a1b2    running      Backend Refactor               architect       3
proj-c3d4    planning     Security Audit                 sec-lead        2
```

#### Create a project

```bash
openpawz project create --title "API Redesign" --goal "Modernize REST API to GraphQL" --boss architect-agent
```

Creates a project with a boss agent. The boss is automatically added to the team.

#### Get project details

```bash
openpawz project get <project-id>
```

Shows full project metadata and the team roster with each agent's role, specialty, status, and current task.

#### Add an agent to a project

```bash
openpawz project add-agent --project proj-a1b2 --agent code-reviewer --role worker --specialty security
```

| Flag | Default | Description |
|------|---------|-------------|
| `--role` | `worker` | `boss` or `worker` |
| `--specialty` | `general` | `coder`, `researcher`, `designer`, `communicator`, `security`, `general` |

#### View project messages

```bash
openpawz project messages <project-id>
openpawz project messages <project-id> --limit 100
```

Shows the delegation log — messages exchanged between agents within the project.

#### Update project status

```bash
openpawz project update <project-id> --status completed
openpawz project update <project-id> --title "New Project Name"
```

Status values: `planning`, `running`, `paused`, `completed`, `failed`.

#### Delete a project

```bash
openpawz project delete <project-id>
```

---

### `engram` — Deep Memory & Graph Exploration

Search and explore the Engram memory subsystem — episodic, semantic, and procedural memories with graph relationships.

```bash
# Episodic BM25 search
openpawz engram search "deployment strategy" --limit 20

# Semantic BM25 search
openpawz engram semantic "how to configure OAuth" --limit 10

# Procedural pattern search
openpawz engram procedural "docker%" --limit 5

# Memory statistics
openpawz engram stats
```

```
  Episodic:   142 memories
  Semantic:    58 memories
  Procedural:  23 memories
  Edges:      310 relationships
```

```bash
# List graph edges for a memory
openpawz engram edges <memory-id> --limit 50

# Run spreading activation from a node
openpawz engram activate <memory-id> --depth 3 --decay 0.5 --top-k 20

# List garbage collection candidates
openpawz engram gc-candidates --limit 100
```

---

### `metrics` — Usage Metrics & Cost Tracking

Track token usage, cost, and model breakdown across sessions.

```bash
# Today's usage summary
openpawz metrics today
```

```
  Tokens (in/out):  12.4K / 8.2K
  Cost:             $0.0341
  Sessions:         7
```

```bash
# Daily breakdown for last N days
openpawz metrics daily --days 7

# Date range
openpawz metrics range --from yyyy-mm-dd --to yyyy-mm-dd

# Model-level breakdown
openpawz metrics models
```

```
  MODEL                   TOKENS IN   TOKENS OUT    COST
  ─────────────────────────────────────────────────────────
  claude-3.5-sonnet         45.2K       32.1K      $0.1247
  gpt-5.1                    12.8K        8.4K      $0.0382
  llama-3.1-70b              8.1K        5.2K      $0.0000
```

```bash
# Per-session usage
openpawz metrics session --limit 10

# Purge old metrics
openpawz metrics purge --before yyyy-mm-dd
```

---

### `providers` — Integration Provider Status

Check OAuth and API connection status across configured providers.

```bash
# List all registered providers
openpawz providers list
```

```
  PROVIDER        STATUS    BASE URL
  ────────────────────────────────────────────────────
  anthropic       ✓ ready   https://api.anthropic.com
  openai          ✓ ready   https://api.openai.com
  ollama          ✓ ready   http://localhost:11434
  google          ✗ —       https://generativelanguage.googleapis.com
```

```bash
# Show only ready providers
openpawz providers ready

# Check a specific provider
openpawz providers check anthropic

# Count registered providers
openpawz providers count
```

---

### `doctor` — Engine Health Check

Comprehensive diagnostic check for CI, monitoring, and troubleshooting. Returns exit code 1 if any errors are detected.

```bash
openpawz doctor
```

```
 ✓ Database        — connected, WAL mode
 ✓ Key Vault       — OS keychain operational
 ✓ Engine Config   — configured
 ✓ AI Provider     — anthropic (API key set)
 ✓ Memory          — 42 entries stored
 ✓ Audit Chain     — 128 entries, integrity OK
 ✓ Data Directory  — exists and writable

7/7 checks passed
```

```bash
# Use in CI pipelines
openpawz doctor --output quiet || exit 1

# JSON for monitoring dashboards
openpawz doctor --output json
```

---

### `bench` — Performance Benchmarks

Built-in timing of core engine operations for performance testing and regression detection.

#### Quick benchmark (built-in)

```bash
openpawz bench quick
openpawz bench quick --iterations 500
```

```
  OPERATION                             ITERS    TOTAL (µs)     AVG (µs)
  -------------------------------------------------------------------------
  session_create                          100         4320           43
  message_add                             100         3890           38
  memory_store                            100         5210           52
  memory_search_keyword                   100         1820           18
  audit_append                            100         8740           87
  audit_verify_chain (100 entries)          1          920          920
  task_create                             100         4150           41
  agent_file_set                          100         3680           36
  injection_scan                          100          540            5
  pii_detection                           100          310            3
  scc_issue_certificate                   100         9200           92
  pricing_estimate_cost                   100           80            0
```

Uses an isolated in-memory database — safe to run anytime without affecting production data.

#### Full Criterion suite

The `openpawz-bench` crate contains 6 Criterion harnesses covering 100+ benchmarks across the entire engine:

| Target | Coverage |
|--------|----------|
| `session_bench` | Session CRUD, messages, tasks, agent files |
| `memory_bench` | Store, keyword/BM25 search, list, graph operations, procedural memory |
| `engram_bench` | HNSW insert/search, reranking (RRF/MMR), hybrid search, abstraction tree, tokenizer, sensory buffer, working memory, emotional affect |
| `audit_bench` | Append, verify chain (100/1K/5K), query, stats, SCC certificates |
| `security_bench` | Injection scan (1KB–100KB), PII detection, encryption/decryption, constrained decoding |
| `reasoning_bench` | Affect scoring, encoding strength, congruent boost, pricing, task complexity, tool metadata |

```bash
# Run all 6 bench suites with HTML reports
openpawz bench full

# Run a specific bench target
openpawz bench full --bench engram_bench

# Filter to a specific group within a target
openpawz bench full --bench engram_bench hnsw
openpawz bench full --bench audit_bench scc
```

Runs the Criterion benchmark suite (`cargo bench -p openpawz-bench`) which produces statistical analysis and HTML reports in `target/criterion/`.

#### Generate a report

Parse Criterion's saved results into a clean Markdown report:

```bash
# Generate from existing results
openpawz bench report

# Custom output path
openpawz bench report -f perf-report.md

# Run benchmarks first, then generate report
openpawz bench report --run-first

# Run a specific suite, then report
openpawz bench report --run-first --bench session_bench

# Machine-readable JSON output
openpawz bench report --output json
```

The report includes a summary table, per-category details (mean/median/std dev), and top-10 slowest/fastest operations. See [docs/benchmarks.md](benchmarks.md) for the full benchmark guide.

#### Running benchmarks directly with cargo

```bash
cd src-tauri

# All benchmarks from the dedicated crate
cargo bench -p openpawz-bench

# Specific target
cargo bench -p openpawz-bench --bench engram_bench
cargo bench -p openpawz-bench --bench security_bench

# Filter to specific group
cargo bench -p openpawz-bench --bench engram_bench -- hnsw
cargo bench -p openpawz-bench --bench audit_bench -- scc
```

---

## Scripting Examples

### Export all sessions as JSON

```bash
openpawz session list --output json > sessions.json
```

### Delete all empty sessions

```bash
openpawz session cleanup --output quiet
```

### List agent IDs (for piping)

```bash
openpawz agent list --output quiet | while read id; do
  echo "Agent: $id"
  openpawz agent get "$id" --output json
done
```

### Check if engine is configured (CI/scripts)

```bash
if openpawz status --output json | grep -q '"provider": "configured"'; then
  echo "Engine ready"
else
  echo "Run: openpawz setup"
  exit 1
fi
```

### Verify audit chain integrity (CI/monitoring)

```bash
openpawz audit verify --output quiet || echo "ALERT: audit chain tampered"
```

### Export memories before migration

```bash
openpawz memory export --output backup.enc --passphrase "$BACKUP_KEY"
```

### Create task from script

```bash
TASK_ID=$(openpawz task create --title "Deploy review" --priority high --output quiet)
echo "Created task: $TASK_ID"
```

### Agent context for prompt engineering

```bash
openpawz agent context my-agent > /tmp/agent-context.txt
```

### Export and re-import an agent (backup / clone)

```bash
openpawz agent export my-agent --output ./backup/my-agent/
# …later, or on another machine:
openpawz agent import --id my-agent-clone --input ./backup/my-agent/
```

### Create a project with a team

```bash
openpawz project create --title "Feature Sprint" --goal "Ship v2.0" --boss lead-agent
PID=$(openpawz project list --output quiet | tail -1)
openpawz project add-agent --project "$PID" --agent coder --specialty coder
openpawz project add-agent --project "$PID" --agent reviewer --specialty security
```

### Health check in CI

```bash
openpawz doctor --output quiet || { echo "Engine unhealthy"; exit 1; }
```

### Performance regression check

```bash
# Quick timing in JSON for automated tracking
openpawz bench quick --iterations 200 --output json > bench-results.json
```

## Data Location

The CLI shares the same data directory as the desktop app:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/com.openpawz.app/` |
| Linux | `~/.local/share/com.openpawz.app/` |
| Windows | `%APPDATA%\com.openpawz.app\` |

The SQLite database, agent files, and configuration are all stored here. Changes made via the CLI are immediately visible in the desktop app and vice versa.

## Security

- All cryptographic operations use AES-256-GCM with OS CSPRNG (`getrandom`) for key/nonce generation
- Key material is stored in the OS keychain (macOS Keychain / GNOME Keyring / Windows Credential Manager)
- In-memory keys are wrapped in `Zeroizing<Vec<u8>>` — securely wiped on drop
- Per-agent key derivation via HKDF-SHA256 with domain separation
- PII auto-detection (17 regex patterns) classifies memories into security tiers
- HMAC-SHA256 chained audit log for tamper-evident operation history
- API keys entered during `setup` are stored in the engine config — consider encrypting them through the skill vault for production use
