# Edit Review (A/B diff gate) — Plan & Status

_The reviewable green/red diff is OPIDE's flagship differentiator vs Cursor
(Cursor has shipped silent edits to unrelated files). Eli's report: "I don't
see the A/B very often" — coders want to review every change before approving._

## Root cause (code-verified 2026-06-09)

Two reasons the diff rarely appeared:

1. **New files were auto-approved with no diff.** Both write paths
   (`host_api.rs::file_write` for the execute_code sandbox, and
   `tool_executor.rs` for direct ide_write_file) did `if new file → write
   without review`. The agent's most common action is *creating* files, so the
   most common change was never reviewable. (Was B203 — pulled back too far.)
2. **The diff that did show "most users never noticed"** (B203's own words):
   existing-file edits opened a Monaco diff but the floating toolbar was dim,
   hardcoded-colored, and easy to miss — leading to 600s timeouts.

Approval tiers, for reference: `execute_code` is NOT auto-approved at the
agent-loop tier (B198) except in Yolo. Existing-file edits already always went
through `request_edit_review`; only new files bypassed it.

## Shipped (this change)

- **New files now go through the diff gate** — shown as an all-green addition,
  with a "Create <file>" header. Only `/tmp` / `/var/folders` scratch paths
  bypass review. Both write paths updated.
- **Toolbar polished to VS Code grade**: theme variables (was hardcoded
  `#1e1e1e`), a `+adds / −dels` line badge, a Create/Review verb + filename,
  and a slide-in animation so it's no longer easy to miss.

## Known tension / to verify (needs Eli's GUI test)

- **Volume.** Scaffolding N files now shows N diffs. Mitigated by the existing
  **Accept All / Reject All** (applies to the rest of the turn). If it feels
  heavy, the next step is to batch a multi-file change into ONE review surface
  (see Phase 2) rather than reverting.
- **Yolo.** In Yolo mode, existing-file edits already showed diffs (pre-existing
  design as a safety net); new files now do too, consistent with that. If Yolo
  should mean truly zero prompts, that's a separate decision — wire the
  request's `auto_approve_all` into `request_edit_review` to auto-accept.

## Phase 2 (planned, not built — needs GUI iteration)

1. **Multi-file review surface.** Cursor's Composer shows ALL changed files as
   one reviewable diff set with per-file accept/reject, not N popups. Build a
   single panel that accumulates the turn's edits and lets the user walk them.
   (This is also the "center-editor" work that was reverted — retry once the
   missing workbench service is identified.)
2. **Inline accept/reject in the editor** (green/red gutter + CodeLens
   "Accept | Reject" above each hunk), the most Cursor-like surface.
3. **Review the file diff, not the JS.** Today execute_code is approved at the
   JS-args tier; coders want to approve the resulting *code*, not the script.
   Consider making the file diff the primary gate and lightening the JS-args
   prompt.
