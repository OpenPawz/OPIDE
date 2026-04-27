// Paw Atoms — AI Provider Golden Trait
// Every AI provider backend implements AiProvider.
// Adding a new provider = implement this trait + register in AnyProvider.

use crate::atoms::types::{Message, ProviderConfig, ProviderKind, StreamChunk, ToolDefinition};
use async_trait::async_trait;

// ── Error type ─────────────────────────────────────────────────────────────

/// Canonical error type for all AI provider operations.
#[derive(Debug)]
pub enum ProviderError {
    /// HTTP / network failure — may be retried.
    Transport(String),
    /// Authentication rejected — not retryable.
    Auth(String),
    /// Provider rate-limited the request.
    RateLimited {
        message: String,
        retry_after_secs: Option<u64>,
    },
    /// Requested model does not exist or is unavailable.
    ModelNotFound(String),
    /// Operation not supported by this provider.
    Unsupported(String),
    /// Generic API error with HTTP status code.
    Api { status: u16, message: String },
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderError::Transport(s) => write!(f, "transport error: {}", s),
            ProviderError::Auth(s) => write!(f, "auth error: {}", s),
            ProviderError::RateLimited { message, .. } => write!(f, "rate limited: {}", message),
            ProviderError::ModelNotFound(s) => write!(f, "model not found: {}", s),
            ProviderError::Unsupported(s) => write!(f, "unsupported: {}", s),
            ProviderError::Api { status, message } => {
                write!(f, "API error {}: {}", status, message)
            }
        }
    }
}

impl From<ProviderError> for String {
    fn from(e: ProviderError) -> Self {
        e.to_string()
    }
}

// ── Model metadata ─────────────────────────────────────────────────────────

/// Metadata returned by list_models().
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub context_window: Option<u64>,
    pub max_output: Option<u64>,
}

// ── The Golden Trait ───────────────────────────────────────────────────────

/// The Golden Trait — every AI provider implements this.
///
/// To add a new OpenAI-compatible provider (e.g. DeepSeek):
///   1. Add a `ProviderKind` variant.
///   2. Return its `default_base_url()`.
///   3. Register it in `AnyProvider::from_config()`.
///   4. Done — no new struct, no copy-paste.
///
/// To add a provider with a unique API format:
///   1. Create `engine/providers/{name}.rs`.
///   2. Implement this trait.
///   3. Register in `AnyProvider::from_config()`.
#[async_trait]
pub trait AiProvider: Send + Sync {
    /// Human-readable provider name for logging and UI.
    fn name(&self) -> &str;

    /// The ProviderKind discriminant for this provider.
    fn kind(&self) -> ProviderKind;

    /// Send a chat completion request with SSE streaming.
    /// Returns collected stream chunks; the caller reassembles them.
    /// `tool_choice` overrides the default: "auto", "required", or "none".
    async fn chat_stream(
        &self,
        messages: &[Message],
        tools: &[ToolDefinition],
        model: &str,
        temperature: Option<f64>,
        thinking_level: Option<&str>,
        tool_choice: Option<&str>,
    ) -> Result<Vec<StreamChunk>, ProviderError>;

    /// Optional: generate embeddings for the memory system.
    /// Default impl returns `Unsupported`.
    async fn embed(&self, _texts: &[String], _model: &str) -> Result<Vec<Vec<f32>>, ProviderError> {
        Err(ProviderError::Unsupported(
            "embeddings not supported by this provider".into(),
        ))
    }

    /// Optional: list available models.
    /// Default impl returns `Unsupported`.
    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        Err(ProviderError::Unsupported(
            "model listing not supported by this provider".into(),
        ))
    }
}

// ── Provider Factory ─────────────────────────────────────────────────────

/// Hook for host apps (e.g. OPIDE) to register custom AI providers
/// without editing the ProviderKind enum or AnyProvider::from_config().
///
/// Usage: implement this trait, then register via Tauri `.manage()`:
/// ```ignore
/// app.manage(Box::new(MyProviderFactory) as Box<dyn ProviderFactory>);
/// ```
///
/// The engine checks for this in `AnyProvider::from_config()` before
/// falling through to the default OpenAI-compatible handler.
pub trait ProviderFactory: Send + Sync {
    /// Create a provider for the given config. Return `None` to let
    /// the engine use its default provider construction.
    fn create_provider(&self, config: &ProviderConfig) -> Option<Box<dyn AiProvider>>;
}

// ── Tool Assembler ───────────────────────────────────────────────────────

/// Hook for host apps (e.g. OPIDE) to filter the tool list before sending to the AI model.
///
/// Usage: implement this trait, then register via Tauri `.manage()`:
/// ```ignore
/// app.manage(Box::new(MyToolAssembler) as Box<dyn ToolAssembler>);
/// ```
///
/// The engine checks for this in `build_chat_tools()` after assembling all tools.
/// If no ToolAssembler is registered, all tools pass through unfiltered.
pub trait ToolAssembler: Send + Sync {
    /// Filter the assembled tool list. Return only the tools the host app wants
    /// the AI model to see. Called after all tools (builtins, skills, external, MCP)
    /// have been collected.
    fn filter_tools(&self, tools: Vec<ToolDefinition>) -> Vec<ToolDefinition>;
}
