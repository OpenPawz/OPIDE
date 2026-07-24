// ── Paw Atoms: Constants ───────────────────────────────────────────────────
// All named constants for the crate live here.
// Rationale: collecting constants in one place eliminates magic strings,
// makes auditing easier, and keeps every layer's code self-documenting.

// All keychain keys are stored in the unified key vault.
// See engine::key_vault for purpose constants.

// ── Chat session message retention ─────────────────────────────────────
// After each chat turn, prune the session if it exceeds this many stored
// messages.  Only the most recent N messages are kept; older ones are deleted
// from the DB.  The agent still has access to past context via memory_search.
pub(crate) const CHAT_SESSION_MAX_MESSAGES: i64 = 200;

// NOTE: the cron cost-control limits (CRON_SESSION_KEEP_MESSAGES,
// CRON_MAX_TOOL_ROUNDS) and startup-housekeeping limits
// (STARTUP_EMPTY_SESSION_MAX_AGE_SECS, STARTUP_STALE_SESSION_MAX_AGE_DAYS)
// were removed in the OPIDE extraction — cron/startup-purge live in OpenPawz,
// not OPIDE. Re-add here if those features are ported.
