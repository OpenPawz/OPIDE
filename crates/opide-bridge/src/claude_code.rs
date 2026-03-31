// ── OPIDE Claude Code Thin Bridge ────────────────────────────────────────────
// Claude Code CLI is used ONLY as an auth-aware pipe to the Anthropic API.
// Max subscription authenticates through the CLI binary — no API key needed.
// OPIDE handles everything else: engram, tools, WASM skills, context, UI.
//
// Architecture:
// - Spawn `claude -p` per round with `--output-format stream-json`
// - Session resume via `--resume <session_id>` for prompt caching
// - On resume, only the NEW content is sent (not full history)
// - Two flags strip Claude Code features:
//   --tools ""            → no built-in tools (Read/Write/Bash/Glob/Grep)
//   --strict-mcp-config   → no MCP servers (none passed via --mcp-config)
// - OPIDE's own system message (engram/soul) dominates context — no --system-prompt needed
// - stderr captured and logged (not swallowed)

use paw_temp_lib::atoms::traits::{AiProvider, ProviderError};
use paw_temp_lib::engine::types::{
    Message, MessageContent, ProviderConfig, ProviderKind, Role, StreamChunk,
    TokenUsage, ToolDefinition,
};
use async_trait::async_trait;
use log::{info, warn, debug};
use serde_json::Value;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

pub struct ClaudeCodeProvider {
    claude_binary: String,
    model: String,
    /// Session ID from Claude Code — enables prompt caching on resume.
    session_id: tokio::sync::Mutex<Option<String>>,
    /// Number of messages sent in previous rounds — used to send only deltas.
    messages_sent: tokio::sync::Mutex<usize>,
}

impl ClaudeCodeProvider {
    pub fn new(config: &ProviderConfig) -> Self {
        let claude_binary = config.base_url.clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
                let candidates = [
                    format!("{}/.local/bin/claude", home),
                    format!("{}/.claude/bin/claude", home),
                    "claude".to_string(),
                ];
                for c in &candidates {
                    if std::path::Path::new(c).exists() {
                        return c.clone();
                    }
                }
                "claude".to_string()
            });

        let model = config.default_model.clone()
            .unwrap_or_else(|| "sonnet".to_string());

        info!("[claude-code] Thin bridge initialized: binary={}, model={}", claude_binary, model);

        ClaudeCodeProvider {
            claude_binary,
            model,
            session_id: tokio::sync::Mutex::new(None),
            messages_sent: tokio::sync::Mutex::new(0),
        }
    }

    /// Format messages into a prompt string.
    /// If `resume` is true, only formats messages after `skip` (the delta).
    fn format_prompt(messages: &[Message], tools: &[ToolDefinition], skip: usize) -> String {
        let mut prompt = String::new();
        let is_first_round = skip == 0;

        // Tool definitions only on first round (session resume caches them)
        if is_first_round && !tools.is_empty() {
            prompt.push_str("You are running inside OPIDE. You do NOT have Claude Code's built-in tools. You have OPIDE's tools listed below. Do NOT ask for permission. Output tool call JSON directly.\n\n");
            prompt.push_str("To use a tool, respond with ONLY a JSON object:\n");
            prompt.push_str("```json\n{\"tool_calls\": [{\"name\": \"tool_name\", \"arguments\": {\"arg1\": \"value1\"}}]}\n```\n\n");
            prompt.push_str("Available tools:\n");
            for tool in tools {
                prompt.push_str(&format!("- **{}**: {}\n", tool.function.name, tool.function.description));
                if let Some(params) = tool.function.parameters.as_object() {
                    if let Some(props) = params.get("properties").and_then(|p| p.as_object()) {
                        for (name, schema) in props {
                            let desc = schema.get("description").and_then(|d| d.as_str()).unwrap_or("");
                            let typ = schema.get("type").and_then(|t| t.as_str()).unwrap_or("string");
                            prompt.push_str(&format!("  - `{}` ({}): {}\n", name, typ, desc));
                        }
                    }
                }
            }
            prompt.push_str("\nWhen you want to use a tool, output ONLY the JSON tool_calls block. Do not mix tool calls with text.\n\n");
        }

        // Format messages — on resume, only the new ones
        let messages_to_send = &messages[skip..];
        for msg in messages_to_send {
            let role_label = match msg.role {
                Role::System => "System",
                Role::User => "User",
                Role::Assistant => "Assistant",
                Role::Tool => "Tool Result",
            };

            let content = match &msg.content {
                MessageContent::Text(s) => s.clone(),
                MessageContent::Blocks(blocks) => {
                    blocks.iter().filter_map(|b| match b {
                        paw_temp_lib::engine::types::ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    }).collect::<Vec<_>>().join("\n")
                }
            };

            if !content.is_empty() {
                prompt.push_str(&format!("{}: {}\n\n", role_label, content));
            }

            if let Some(tc) = &msg.tool_calls {
                for call in tc {
                    prompt.push_str(&format!("Assistant called tool: {} with args: {}\n\n",
                        call.function.name, call.function.arguments));
                }
            }

            if let Some(ref tc_id) = msg.tool_call_id {
                let name = msg.name.as_deref().unwrap_or("unknown");
                prompt.push_str(&format!("Tool result for {} (id: {}): {}\n\n", name, tc_id, content));
            }
        }

        prompt
    }

    /// Parse a tool_calls JSON block from the response text.
    fn extract_tool_calls(text: &str) -> Option<Vec<(String, String)>> {
        if let Some(start) = text.find("{\"tool_calls\"") {
            let json_str = &text[start..];
            let mut depth = 0;
            let mut end = 0;
            for (i, ch) in json_str.chars().enumerate() {
                match ch {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            end = i + 1;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            if end > 0 {
                if let Ok(parsed) = serde_json::from_str::<Value>(&json_str[..end]) {
                    if let Some(calls) = parsed.get("tool_calls").and_then(|v| v.as_array()) {
                        let mut result = Vec::new();
                        for call in calls {
                            let name = call.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                            let args = call.get("arguments")
                                .map(|a| serde_json::to_string(a).unwrap_or_default())
                                .unwrap_or_else(|| "{}".to_string());
                            if !name.is_empty() {
                                result.push((name, args));
                            }
                        }
                        if !result.is_empty() {
                            return Some(result);
                        }
                    }
                }
            }
        }
        None
    }

    /// Strip ANSI escape sequences and terminal noise from CLI output.
    fn strip_noise(s: &str) -> String {
        let mut result = String::with_capacity(s.len());
        let mut chars = s.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '\x1b' {
                if chars.peek() == Some(&'[') {
                    chars.next();
                    while let Some(&c) = chars.peek() {
                        chars.next();
                        if c.is_alphabetic() { break; }
                    }
                }
            } else if ch == '\r' || ch == '\x07' || ch == '\x08' {
                // Skip carriage return, bell, backspace
            } else {
                result.push(ch);
            }
        }
        result
    }
}

#[async_trait]
impl AiProvider for ClaudeCodeProvider {
    fn name(&self) -> &str {
        "Claude Code"
    }

    fn kind(&self) -> ProviderKind {
        ProviderKind::ClaudeCode
    }

    async fn chat_stream(
        &self,
        messages: &[Message],
        tools: &[ToolDefinition],
        model: &str,
        _temperature: Option<f64>,
        _thinking_level: Option<&str>,
        _tool_choice: Option<&str>,
    ) -> Result<Vec<StreamChunk>, ProviderError> {
        let model_name = if model.is_empty() { &self.model } else { model };

        // Check for session resume
        let session_id_guard = self.session_id.lock().await;
        let has_session = session_id_guard.is_some();
        let resume_id = session_id_guard.clone();
        drop(session_id_guard);

        let messages_sent_guard = self.messages_sent.lock().await;
        let skip = if has_session { *messages_sent_guard } else { 0 };
        drop(messages_sent_guard);

        // Build args — strip all Claude Code features, use CLI as auth pipe only
        let mut args: Vec<String> = vec![
            "-p".into(),
            "--output-format".into(), "stream-json".into(),
            "--verbose".into(),                    // required for stream-json in --print mode
            "--model".into(), model_name.into(),
            "--tools".into(), "".into(),           // no built-in tools
            "--strict-mcp-config".into(),          // no MCP servers (none passed via --mcp-config)
            // Note: no --system-prompt — OPIDE's own system message dominates the context.
        ];

        // Resume existing session for prompt caching
        if let Some(ref sid) = resume_id {
            args.push("--resume".into());
            args.push(sid.clone());
            info!("[claude-code] Resuming session {} (sending {} new messages, skipping {})",
                sid, messages.len() - skip, skip);
        } else {
            info!("[claude-code] Starting new session: model={}, messages={}",
                model_name, messages.len());
        }

        // Format prompt — only delta on resume
        let prompt = Self::format_prompt(messages, tools, skip);
        debug!("[claude-code] Prompt size: {} bytes", prompt.len());

        // Spawn claude CLI
        let mut child = tokio::process::Command::new(&self.claude_binary)
            .args(&args)
            .env("NO_COLOR", "1")
            .env("TERM", "dumb")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())  // Capture stderr, don't swallow
            .spawn()
            .map_err(|e| ProviderError::Transport(
                format!("Failed to spawn claude CLI at '{}': {}", self.claude_binary, e)
            ))?;

        // Write prompt to stdin and close
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(prompt.as_bytes()).await
                .map_err(|e| ProviderError::Transport(format!("Failed to write to claude stdin: {}", e)))?;
            stdin.shutdown().await
                .map_err(|e| ProviderError::Transport(format!("Failed to close claude stdin: {}", e)))?;
        }

        // Stream stdout line by line (stream-json is line-delimited)
        let stdout = child.stdout.take()
            .ok_or_else(|| ProviderError::Transport("No stdout handle".into()))?;
        let mut reader = BufReader::new(stdout).lines();

        let mut chunks = Vec::new();
        let mut response_text = String::new();
        let mut usage = None;
        let mut new_session_id: Option<String> = None;

        // Read with timeout — 180s total for the response
        let read_result = tokio::time::timeout(
            std::time::Duration::from_secs(180),
            async {
                while let Ok(Some(line)) = reader.next_line().await {
                    let line = Self::strip_noise(line.trim());
                    if line.is_empty() { continue; }

                    if let Ok(v) = serde_json::from_str::<Value>(&line) {
                        // Capture session_id from any event that has it
                        if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                            if new_session_id.is_none() {
                                new_session_id = Some(sid.to_string());
                                debug!("[claude-code] Got session_id: {}", sid);
                            }
                        }

                        match v.get("type").and_then(|t| t.as_str()) {
                            Some("content_block_delta") | Some("stream_event") => {
                                let text = v.pointer("/delta/text")
                                    .or_else(|| v.pointer("/event/delta/text"))
                                    .and_then(|t| t.as_str());
                                if let Some(t) = text {
                                    response_text.push_str(t);
                                }
                            }
                            Some("result") => {
                                if let Some(result_text) = v.get("result").and_then(|r| r.as_str()) {
                                    response_text = result_text.to_string();
                                }
                                if let Some(u) = v.get("usage") {
                                    let input = u.get("input_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
                                    let output_tok = u.get("output_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
                                    let cache_create = u.get("cache_creation_input_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
                                    let cache_read = u.get("cache_read_input_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
                                    usage = Some(TokenUsage {
                                        input_tokens: input,
                                        output_tokens: output_tok,
                                        total_tokens: input + output_tok,
                                        cache_creation_tokens: cache_create,
                                        cache_read_tokens: cache_read,
                                    });
                                }
                                break;
                            }
                            _ => {
                                debug!("[claude-code] stream event: {}", line.chars().take(200).collect::<String>());
                            }
                        }
                    } else {
                        // Not JSON — append as plain text
                        if !line.is_empty() {
                            response_text.push_str(&line);
                            response_text.push('\n');
                        }
                    }
                }
            }
        ).await;

        // Check timeout
        if read_result.is_err() {
            // Kill the process on timeout
            let _ = child.kill().await;
            return Err(ProviderError::Transport("Claude CLI timed out after 180s".into()));
        }

        // Read stderr for diagnostics (non-blocking, just grab what's there)
        if let Some(mut stderr) = child.stderr.take() {
            let mut stderr_buf = String::new();
            // Don't block forever on stderr — just read what's available
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(500),
                stderr.read_to_string(&mut stderr_buf)
            ).await;
            for line in stderr_buf.lines() {
                let line = line.trim();
                if line.is_empty() { continue; }
                // Filter EBADF spam
                if line.contains("EBADF") || line.contains("bad file descriptor") {
                    continue;
                }
                warn!("[claude-code] stderr: {}", line);
            }
        }

        // Wait for process to exit (should already be done after stdout closed)
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            child.wait()
        ).await;

        // Update session state for next round
        if let Some(sid) = new_session_id {
            let mut guard = self.session_id.lock().await;
            *guard = Some(sid);
        }
        {
            let mut guard = self.messages_sent.lock().await;
            *guard = messages.len();
        }

        // Use raw stdout if no parsed result
        if response_text.is_empty() {
            return Err(ProviderError::Transport("Claude CLI returned empty response".into()));
        }

        let response_text = response_text.trim().to_string();
        info!("[claude-code] Response: {} chars, cache_read={}",
            response_text.len(),
            usage.as_ref().map(|u| u.cache_read_tokens).unwrap_or(0));

        // Parse tool calls from response
        if let Some(tool_calls) = Self::extract_tool_calls(&response_text) {
            for (i, (name, args)) in tool_calls.iter().enumerate() {
                chunks.push(StreamChunk {
                    delta_text: None,
                    tool_calls: vec![paw_temp_lib::engine::types::ToolCallDelta {
                        index: i,
                        id: Some(format!("call_{}", uuid::Uuid::new_v4())),
                        function_name: Some(name.clone()),
                        arguments_delta: Some(args.clone()),
                        thought_signature: None,
                    }],
                    finish_reason: None,
                    usage: None,
                    model: Some(model_name.to_string()),
                    thought_parts: vec![],
                    thinking_text: None,
                });
            }
        } else {
            chunks.push(StreamChunk {
                delta_text: Some(response_text),
                tool_calls: vec![],
                finish_reason: Some("stop".to_string()),
                usage: None,
                model: Some(model_name.to_string()),
                thought_parts: vec![],
                thinking_text: None,
            });
        }

        if let Some(u) = usage {
            chunks.push(StreamChunk {
                delta_text: None,
                tool_calls: vec![],
                finish_reason: None,
                usage: Some(u),
                model: Some(model_name.to_string()),
                thought_parts: vec![],
                thinking_text: None,
            });
        }

        Ok(chunks)
    }
}
