use super::SessionStore;
use crate::atoms::error::EngineResult;
use crate::engine::types::{ContentBlock, Message, MessageContent, Role, StoredMessage, ToolCall};
use rusqlite::params;

impl SessionStore {
    // ── Message CRUD ───────────────────────────────────────────────────

    pub fn add_message(&self, msg: &StoredMessage) -> EngineResult<()> {
        let conn = self.conn.lock();

        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, tool_calls_json, tool_call_id, name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                msg.id,
                msg.session_id,
                msg.role,
                msg.content,
                msg.tool_calls_json,
                msg.tool_call_id,
                msg.name,
            ],
        )?;

        // Update session stats
        conn.execute(
            "UPDATE sessions SET
                message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?1),
                updated_at = datetime('now')
             WHERE id = ?1",
            params![msg.session_id],
        )?;

        Ok(())
    }

    /// Load raw conversation messages as (role, content) pairs.
    /// Used by the Engram ContextBuilder for budget-aware trimming.
    pub fn load_conversation_raw(
        &self,
        session_id: &str,
        _agent_id: Option<&str>,
    ) -> EngineResult<Vec<StoredMessage>> {
        self.get_messages(session_id, 50)
    }

    /// Total message count for a session — used to detect truncation in
    /// `load_conversation` (B187).
    pub fn count_messages(&self, session_id: &str) -> EngineResult<i64> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM messages WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )?;
        Ok(count)
    }

    pub fn get_messages(&self, session_id: &str, limit: i64) -> EngineResult<Vec<StoredMessage>> {
        let conn = self.conn.lock();

        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, tool_calls_json, tool_call_id, name, created_at
             FROM messages WHERE session_id = ?1 ORDER BY created_at ASC LIMIT ?2",
        )?;

        let messages = stmt
            .query_map(params![session_id, limit], |row| {
                Ok(StoredMessage {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    tool_calls_json: row.get(4)?,
                    tool_call_id: row.get(5)?,
                    name: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(messages)
    }

    /// Convert stored messages to engine Message types for sending to AI provider.
    ///
    /// `max_context_tokens` caps the total conversation size.  Pass `None` to
    /// use the default (32 000 tokens).
    ///
    /// `agent_id` enables agent-scoped history filtering (VS Code pattern):
    /// non-default agents only see messages from their own session.  The
    /// "default" agent sees everything.  Pass `None` to disable filtering.
    pub fn load_conversation(
        &self,
        session_id: &str,
        system_prompt: Option<&str>,
        max_context_tokens: Option<usize>,
        agent_id: Option<&str>,
    ) -> EngineResult<Vec<Message>> {
        // B187: load 200 recent messages instead of 50 (mid-loop truncation
        // already trims back to context_window when needed) and tell the
        // model when older history was dropped, so it can reach for
        // memory_search instead of assuming it has the full transcript.
        const DEFAULT_LOAD_LIMIT: i64 = 200;
        let total_count = self.count_messages(session_id)?;
        let stored = self.get_messages(session_id, DEFAULT_LOAD_LIMIT)?;
        let was_truncated = (stored.len() as i64) < total_count;
        let mut messages = Vec::new();

        // Add system prompt if provided
        if let Some(prompt) = system_prompt {
            let mut prompt_text = prompt.to_string();
            if was_truncated {
                prompt_text.push_str(&format!(
                    "\n\n[Note: only the most recent {} of {} messages from this session are loaded. \
                     Use memory_search if you need older context.]",
                    stored.len(),
                    total_count
                ));
            }
            messages.push(Message {
                role: Role::System,
                content: MessageContent::Text(prompt_text),
                tool_calls: None,
                tool_call_id: None,
                name: None,
                reasoning_content: None,
            });
        }

        for sm in &stored {
            let role = match sm.role.as_str() {
                "system" => Role::System,
                "user" => Role::User,
                "assistant" => Role::Assistant,
                "tool" => Role::Tool,
                _ => Role::User,
            };

            // B186: log when tool_calls JSON fails to parse instead of
            // silently dropping the field. Without this, a corrupted
            // assistant message looks fine on load and only manifests as
            // mysterious tool_call_id-without-parent warnings later.
            let tool_calls: Option<Vec<ToolCall>> = sm.tool_calls_json.as_ref().and_then(|json| {
                match serde_json::from_str::<Vec<ToolCall>>(json) {
                    Ok(v) => Some(v),
                    Err(e) => {
                        log::warn!(
                            "[engine] load_conversation: dropping tool_calls for message {} — JSON parse failed: {}",
                            sm.id, e
                        );
                        None
                    }
                }
            });

            messages.push(Message {
                role,
                content: MessageContent::Text(sm.content.clone()),
                tool_calls,
                tool_call_id: sm.tool_call_id.clone(),
                name: sm.name.clone(),
                reasoning_content: None,
            });
        }

        // ── Agent-scoped history filtering (VS Code pattern) ───────────
        // Non-default agents only see messages relevant to their context.
        // We skip delegate-agent tool results (messages with name starting
        // with "agent_send_message") if the current agent is non-default,
        // to prevent cross-agent context pollution within a session.
        if let Some(aid) = agent_id {
            if aid != "default" {
                let before = messages.len();
                // Keep: system, user, and assistant messages.
                // Filter: tool results from other agents' delegated work.
                messages.retain(|m| {
                    if m.role == Role::Tool {
                        // Keep tool results that are part of this agent's work
                        // Skip results from agent delegation tools unless they match
                        let name = m.name.as_deref().unwrap_or("");
                        if name == "agent_send_message" || name == "agent_read_messages" {
                            return false; // Skip cross-agent delegation results
                        }
                    }
                    true
                });
                let after = messages.len();
                if before != after {
                    log::info!(
                        "[engine] Agent-scoped filter: removed {} cross-agent messages for agent '{}'",
                        before - after, aid
                    );
                }
            }
        }

        // ── Compress old tool results ────────────────────────────────────
        // Tool results (especially from audits) can be 50KB+ each. After 20 rounds,
        // they saturate the context window and the model can't switch topics.
        // Compress tool results older than the last 5 by replacing their content
        // with a one-line summary. Keeps conversation flow intact.
        const KEEP_RECENT_TOOL_RESULTS: usize = 5;
        let mut tool_result_count = 0;
        let _total_messages = messages.len();
        // Count tool results from the end to find which ones are "recent"
        let mut recent_tool_indices: Vec<usize> = Vec::new();
        for (i, m) in messages.iter().enumerate().rev() {
            if m.role == Role::Tool && m.tool_call_id.is_some() {
                recent_tool_indices.push(i);
                if recent_tool_indices.len() >= KEEP_RECENT_TOOL_RESULTS {
                    break;
                }
            }
        }
        // Compress old tool results (not in the recent set)
        for (i, m) in messages.iter_mut().enumerate() {
            if m.role == Role::Tool && m.tool_call_id.is_some() && !recent_tool_indices.contains(&i) {
                let name = m.name.as_deref().unwrap_or("unknown");
                let content_len = match &m.content {
                    MessageContent::Text(t) => t.len(),
                    MessageContent::Blocks(_) => 0,
                };
                if content_len > 500 {
                    tool_result_count += 1;
                    let success_hint = match &m.content {
                        MessageContent::Text(t) => if t.starts_with("ERROR") { "failed" } else { "succeeded" },
                        _ => "completed",
                    };
                    m.content = MessageContent::Text(format!(
                        "[Previous tool result: {} — {} — {} bytes. Use tools to re-read if needed.]",
                        name, success_hint, content_len
                    ));
                }
            }
        }
        if tool_result_count > 0 {
            log::info!("[engine] Compressed {} old tool results to free context space", tool_result_count);
        }

        // ── Context window truncation ──────────────────────────────────
        // Configurable via Settings → Engine → Context Window.
        // Default 32K tokens — leaves ~24K for conversation with a ~8K system prompt.
        // Users with large budgets can push to 64K-128K for full-session memory.
        // Always keep system prompt (first message).
        let context_limit = max_context_tokens.unwrap_or(32_000);
        let estimate_tokens = |m: &Message| -> usize {
            let text_len = match &m.content {
                MessageContent::Text(t) => t.len(),
                MessageContent::Blocks(blocks) => blocks
                    .iter()
                    .map(|b| match b {
                        ContentBlock::Text { text } => text.len(),
                        ContentBlock::ImageUrl { .. } => 1000, // rough estimate for images
                        ContentBlock::Document { data, .. } => data.len() / 4, // rough: base64 → chars
                    })
                    .sum(),
            };
            let tc_len = m
                .tool_calls
                .as_ref()
                .map(|tcs| {
                    tcs.iter()
                        .map(|tc| tc.function.arguments.len() + tc.function.name.len() + 20)
                        .sum::<usize>()
                })
                .unwrap_or(0);
            (text_len + tc_len) / 4 + 4 // +4 for role/overhead tokens
        };

        let total_tokens: usize = messages.iter().map(&estimate_tokens).sum();
        if total_tokens > context_limit && messages.len() > 2 {
            // Keep system prompt (index 0) and trim oldest non-system messages
            let system_msg = if !messages.is_empty() && messages[0].role == Role::System {
                Some(messages.remove(0))
            } else {
                None
            };

            // Drop from the front (oldest) until we fit, but ALWAYS keep the
            // last user message so the provider gets non-empty contents.
            let running_tokens: usize = system_msg.as_ref().map(&estimate_tokens).unwrap_or(0);
            let mut keep_from = 0;
            let msg_tokens: Vec<usize> = messages.iter().map(&estimate_tokens).collect();
            let total_msg_tokens: usize = msg_tokens.iter().sum();
            let mut drop_tokens = running_tokens + total_msg_tokens;

            // Find the last user message index — we must never drop past it
            let last_user_idx = messages
                .iter()
                .rposition(|m| m.role == Role::User)
                .unwrap_or(messages.len().saturating_sub(1));

            for (i, &t) in msg_tokens.iter().enumerate() {
                if drop_tokens <= context_limit {
                    break;
                }
                // Never drop past the last user message
                if i >= last_user_idx {
                    break;
                }
                drop_tokens -= t;
                keep_from = i + 1;
            }

            // Collect a brief recap of dropped messages
            let dropped_recap = if keep_from > 0 {
                let mut recap_parts: Vec<String> = Vec::new();
                for m in &messages[..keep_from] {
                    let text_ref: std::borrow::Cow<str> = match &m.content {
                        MessageContent::Text(t) => std::borrow::Cow::Borrowed(t.as_str()),
                        MessageContent::Blocks(blocks) => std::borrow::Cow::Owned(
                            blocks
                                .iter()
                                .filter_map(|b| match b {
                                    ContentBlock::Text { text } => Some(text.as_str()),
                                    _ => None,
                                })
                                .collect::<Vec<_>>()
                                .join(" "),
                        ),
                    };
                    let truncated = if text_ref.len() > 120 {
                        &text_ref[..text_ref.floor_char_boundary(120)]
                    } else {
                        &text_ref
                    };
                    recap_parts.push(format!("[{:?}] {}", m.role, truncated));
                }
                if recap_parts.is_empty() {
                    None
                } else {
                    Some(format!(
                        "[Earlier conversation recap — {} messages trimmed]\n{}",
                        keep_from,
                        recap_parts.join("\n")
                    ))
                }
            } else {
                None
            };

            messages = messages.split_off(keep_from);

            // Re-insert system prompt at the front
            if let Some(sys) = system_msg {
                messages.insert(0, sys);
            }

            // Inject recap of dropped messages so the model keeps some context
            if let Some(recap) = dropped_recap {
                messages.insert(
                    if !messages.is_empty() && messages[0].role == Role::System {
                        1
                    } else {
                        0
                    },
                    Message {
                        role: Role::System,
                        content: MessageContent::Text(recap),
                        tool_calls: None,
                        tool_call_id: None,
                        name: None,
                        reasoning_content: None,
                    },
                );
            }

            log::info!(
                "[engine] Context truncated: kept {} messages (~{} tokens, was ~{})",
                messages.len(),
                drop_tokens,
                total_tokens
            );
        }

        // ── Delete failed exchanges (VS Code pattern) ──────────────────
        // Instead of neutralizing or compacting failed responses, simply
        // delete them entirely.  The model never sees its past failures,
        // so it can't anchor on them or develop "learned helplessness."
        // This is how VS Code handles retries: removeRequest + resend fresh.
        Self::delete_failed_exchanges(&mut messages);

        // ── Delete empty / near-empty assistant messages ───────────────
        // Empty responses that leaked into storage waste context tokens and
        // cause the model to mimic the empty-response pattern in long
        // conversations. Strip them before the model sees them.
        Self::delete_empty_assistant_messages(&mut messages);

        // ── Sanitize tool_use / tool_result pairing ────────────────────
        // After truncation (or corruption from previous crashes), ensure every
        // assistant message with tool_calls has matching tool_result messages.
        // The Anthropic API returns 400 if tool_use IDs appear without a
        // corresponding tool_result immediately after.
        Self::sanitize_tool_pairs(&mut messages);

        Ok(messages)
    }

    /// Delete failed exchanges entirely from conversation history.
    ///
    /// VS Code pattern: instead of neutralizing or compacting failed responses,
    /// simply remove them.  The model never sees past failures, so it can't
    /// anchor on them or develop "learned helplessness."
    ///
    /// Removes:
    /// 1. Assistant messages with tool_calls where ALL tool results are errors
    ///    (plus the corresponding tool result messages)
    /// 2. Assistant "give up" text responses (apology spirals, refusals)
    ///
    /// Always preserves the last user message and the system prompt.
    fn delete_failed_exchanges(messages: &mut Vec<Message>) {
        use std::collections::HashSet;

        let is_error_text = |text: &str| -> bool {
            text.starts_with("Error:")
                || text.starts_with("Google API error")
                || text.contains("error (")
                || text.contains("is not enabled")
                || text.contains("failed:")
                || text.starts_with("Tool execution denied")
                || (text.len() < 200 && text.to_lowercase().contains("error"))
        };

        let give_up_patterns: &[&str] = &[
            "hitting a wall",
            "continue to struggle",
            "rather than continue",
            "keep running into errors",
            "i'm unable to",
            "i am unable to",
            "tool is broken",
            "tool isn't working",
            "consistently failing",
            "keeps failing",
            "this approach isn't working",
            "apologize for the difficulty",
            "apologize for the inconvenience",
        ];

        let mut indices_to_remove: HashSet<usize> = HashSet::new();

        // ── Pass 1: find assistant+tool_calls where all results are errors ──
        let mut i = 0;
        while i < messages.len() {
            if messages[i].role == Role::Assistant {
                if let Some(ref tcs) = messages[i].tool_calls {
                    if !tcs.is_empty() {
                        let tc_ids: HashSet<String> = tcs.iter().map(|tc| tc.id.clone()).collect();
                        // Scan following tool result messages
                        let mut j = i + 1;
                        let mut all_failed = true;
                        let mut result_indices: Vec<usize> = Vec::new();
                        while j < messages.len() && messages[j].role == Role::Tool {
                            if let Some(ref tcid) = messages[j].tool_call_id {
                                if tc_ids.contains(tcid) {
                                    result_indices.push(j);
                                    if !is_error_text(&messages[j].content.as_text()) {
                                        all_failed = false;
                                    }
                                }
                            }
                            j += 1;
                        }
                        if all_failed && !result_indices.is_empty() {
                            indices_to_remove.insert(i);
                            for idx in result_indices {
                                indices_to_remove.insert(idx);
                            }
                        }
                    }
                }
            }
            i += 1;
        }

        // ── Pass 2: find assistant give-up text responses ───────────────
        for (idx, msg) in messages.iter().enumerate() {
            if msg.role != Role::Assistant {
                continue;
            }
            if msg
                .tool_calls
                .as_ref()
                .map(|tc| !tc.is_empty())
                .unwrap_or(false)
            {
                continue;
            }
            let text = msg.content.as_text().to_lowercase();
            if give_up_patterns.iter().any(|p| text.contains(p)) {
                indices_to_remove.insert(idx);
            }
        }

        if indices_to_remove.is_empty() {
            return;
        }

        // Remove in reverse order to preserve indices
        let mut sorted: Vec<usize> = indices_to_remove.into_iter().collect();
        sorted.sort_unstable();
        for &idx in sorted.iter().rev() {
            if idx < messages.len() {
                messages.remove(idx);
            }
        }

        log::info!(
            "[engine] Deleted {} failed exchange messages from conversation history (VS Code pattern)",
            sorted.len()
        );
    }

    /// Remove empty or near-empty assistant messages from conversation history.
    ///
    /// Empty responses that leaked into storage waste context tokens and
    /// cause the model to mimic the empty-response pattern in long conversations.
    /// Also removes very short non-answers like "Let me know!" that indicate
    /// the model was confused rather than genuinely responding.
    fn delete_empty_assistant_messages(messages: &mut Vec<Message>) {
        let before = messages.len();

        messages.retain(|m| {
            if m.role != Role::Assistant {
                return true; // keep non-assistant messages
            }
            // Keep messages that have tool calls — they're functional
            if m.tool_calls.as_ref().is_some_and(|tc| !tc.is_empty()) {
                return true;
            }
            let text = m.content.as_text();
            let trimmed = text.trim();
            // Remove completely empty messages
            if trimmed.is_empty() {
                return false;
            }
            // Remove very short non-answers (< 15 chars, no real content)
            // These are artifacts like "Let me know!", "Sure!", "Okay." etc.
            // that indicate the model was confused rather than responding.
            // Only remove if the message is a dead-end (no substantive content).
            if trimmed.len() < 15 && !trimmed.contains(' ') {
                return false; // single-word garbage
            }
            true
        });

        let removed = before - messages.len();
        if removed > 0 {
            log::info!(
                "[engine] Removed {} empty/near-empty assistant messages from conversation",
                removed
            );
        }
    }

    /// Ensure every assistant message with tool_calls has matching tool_result
    /// messages immediately after it.  Orphaned tool_use IDs (from context
    /// truncation or prior crashes) cause Anthropic to return HTTP 400.
    ///
    /// Strategy:
    /// 1. Remove leading orphaned tool-result messages that have no preceding
    ///    assistant message with tool_calls.
    /// 2. For each assistant message with tool_calls, collect the set of
    ///    tool_call IDs and check the immediately following messages.  Inject
    ///    a synthetic tool_result for any missing ID.
    fn sanitize_tool_pairs(messages: &mut Vec<Message>) {
        use std::collections::HashSet;

        // ── Pass 1: strip leading orphan tool results ──────────────────
        // After truncation the first non-system messages might be tool results
        // whose parent assistant message was dropped.
        let first_non_system = messages
            .iter()
            .position(|m| m.role != Role::System)
            .unwrap_or(0);
        let mut strip_end = first_non_system;
        while strip_end < messages.len() && messages[strip_end].role == Role::Tool {
            strip_end += 1;
        }
        if strip_end > first_non_system {
            let removed = strip_end - first_non_system;
            log::warn!(
                "[engine] Removing {} orphaned leading tool_result messages",
                removed
            );
            messages.drain(first_non_system..strip_end);
        }

        // ── Pass 2: ensure every assistant+tool_calls has matching results ─
        let mut i = 0;
        while i < messages.len() {
            let has_tc = messages[i].role == Role::Assistant
                && messages[i]
                    .tool_calls
                    .as_ref()
                    .map(|tc| !tc.is_empty())
                    .unwrap_or(false);

            if !has_tc {
                i += 1;
                continue;
            }

            // Collect expected tool_call IDs from this assistant message
            let expected_ids: Vec<String> = messages[i]
                .tool_calls
                .as_ref()
                .unwrap()
                .iter()
                .map(|tc| tc.id.clone())
                .collect();

            // Scan following messages for tool results, skipping System messages
            // (context injections can insert System messages between assistant
            // and tool-result blocks).
            let mut found_ids = HashSet::new();
            let mut j = i + 1;
            while j < messages.len() {
                match messages[j].role {
                    Role::Tool => {
                        if let Some(ref tcid) = messages[j].tool_call_id {
                            found_ids.insert(tcid.clone());
                        }
                        j += 1;
                    }
                    Role::System => {
                        // Skip injected system messages — don't break the scan
                        j += 1;
                    }
                    _ => break,
                }
            }

            // Inject synthetic results for any missing tool_call IDs
            let mut injected = 0;
            for expected_id in &expected_ids {
                if !found_ids.contains(expected_id) {
                    let synthetic = Message {
                        role: Role::Tool,
                        content: MessageContent::Text(
                            "[Tool execution was interrupted or result was lost.]".into(),
                        ),
                        tool_calls: None,
                        tool_call_id: Some(expected_id.clone()),
                        name: Some("_synthetic".into()),
                        reasoning_content: None,
                    };
                    // Insert right after the assistant message (at position i+1+injected)
                    messages.insert(i + 1 + injected, synthetic);
                    injected += 1;
                }
            }

            if injected > 0 {
                log::warn!(
                    "[engine] Injected {} synthetic tool_result(s) for orphaned tool_use IDs",
                    injected
                );
            }

            // Advance past this assistant message + all following tool/system results
            i += 1;
            while i < messages.len()
                && (messages[i].role == Role::Tool || messages[i].role == Role::System)
            {
                i += 1;
            }
        }
    }
}
