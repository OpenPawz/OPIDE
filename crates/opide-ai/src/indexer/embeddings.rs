// ── Embedding Generator ─────────────────────────────────────────────────────
// Generates vector embeddings for code chunks using the OpenPawz embedding
// infrastructure (Ollama, OpenAI, Google, or any configured provider).
// Batches requests and emits progress events.

use super::chunker::CodeChunk;
use tauri::AppHandle;

/// Generate embeddings for a list of code chunks.
/// Uses the OpenPawz EmbeddingClient which handles provider routing.
/// Batches in groups of 32 to avoid overwhelming the API.
/// Emits progress via Tauri events.
pub async fn embed_chunks(
    chunks: &mut Vec<CodeChunk>,
    app_handle: &AppHandle,
) -> Result<usize, String> {
    use tauri::Emitter;

    let embed_client = build_embed_client(app_handle)?;

    let total = chunks.len();
    let batch_size = 32;
    let mut embedded_count = 0;

    log::info!("[indexer] Embedding {} chunks using {}", total, embed_client.model_name());

    for batch_start in (0..total).step_by(batch_size) {
        let batch_end = (batch_start + batch_size).min(total);

        for i in batch_start..batch_end {
            let text = &chunks[i].text;

            match embed_client.embed(text).await {
                Ok(vector) => {
                    chunks[i].embedding = Some(vector);
                    embedded_count += 1;
                }
                Err(e) => {
                    log::debug!(
                        "[indexer] Failed to embed chunk '{}': {}",
                        chunks[i].name, e
                    );
                }
            }
        }

        // Emit progress
        let _ = app_handle.emit("indexer-progress", serde_json::json!({
            "phase": "embedding",
            "current": batch_end,
            "total": total,
            "percent": ((batch_end as f64 / total as f64) * 100.0) as u32,
        }));

        let pct = ((batch_end as f64 / total as f64) * 100.0) as u32;
        let prev_pct = ((batch_start as f64 / total as f64) * 100.0) as u32;
        if pct / 10 > prev_pct / 10 || batch_end == total {
            log::info!("[indexer] Embedded {}/{} chunks ({}%)", batch_end, total, pct);
        }
    }

    log::info!(
        "[indexer] Embedding complete: {}/{} chunks embedded",
        embedded_count, total
    );

    Ok(embedded_count)
}

/// Embed a single chunk (for incremental updates when a file changes).

/// Build an EmbeddingClient from OpenPawz's managed state.
fn build_embed_client(
    app_handle: &AppHandle,
) -> Result<paw_temp_lib::engine::memory::embedding::EmbeddingClient, String> {
    use tauri::Manager;

    let state = app_handle
        .try_state::<paw_temp_lib::engine::state::EngineState>()
        .ok_or("EngineState not available — cannot generate embeddings")?;

    let memory_config = state.memory_config.lock();
    let client = paw_temp_lib::engine::memory::embedding::EmbeddingClient::new(&memory_config);

    Ok(client)
}
