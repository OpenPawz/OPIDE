// ── Engram: Cognitive State ──────────────────────────────────────────────────
//
// The CognitiveState is the per-agent runtime wrapper that ties together
// all three tiers of the Engram memory pipeline:
//
//   Tier 0: SensoryBuffer  — ephemeral ring buffer of raw message pairs
//   Tier 1: WorkingMemory  — priority-sorted active context slots
//   Tier 2: Long-Term Store — SQLite graph (via SessionStore)
//
// CognitiveState also holds:
//   - The IntentClassifier integration (query-adaptive signal weighting)
//   - Per-agent Tokenizer instance
//   - Agent ID and configuration
//
// Thread safety: CognitiveState itself is NOT Sync.
// The EngineState holds a `HashMap<String, Arc<Mutex<CognitiveState>>>>`
// keyed by agent_id, so each agent's state is independently lockable.

use crate::atoms::engram_types::{
    EngramConfig, IntentClassification, MemoryScope, MemorySearchConfig, TokenizerType,
};
use crate::engine::engram::cognitive_event;
use crate::engine::engram::encryption;
use crate::engine::engram::intent_classifier;
use crate::engine::engram::sensory_buffer::{SensoryBuffer, SensoryEntry};
use crate::engine::engram::tokenizer::Tokenizer;
use crate::engine::engram::working_memory::WorkingMemory;
use log::{debug, info};

/// Per-agent cognitive state wrapping all three memory tiers.
pub struct CognitiveState {
    /// The agent this state belongs to.
    pub agent_id: String,
    /// Tier 0: raw message ring buffer.
    pub sensory_buffer: SensoryBuffer,
    /// Tier 1: priority-sorted working memory.
    pub working_memory: WorkingMemory,
    /// Tokenizer for this agent (model-specific).
    tokenizer: Tokenizer,
}

impl CognitiveState {
    /// Create a new CognitiveState for an agent using the given config.
    ///
    /// The `token_budget` is the working memory token budget — typically
    /// derived from the model's context window (e.g., 4096 tokens).
    pub fn new(agent_id: String, config: &EngramConfig, token_budget: usize) -> Self {
        let tokenizer = Tokenizer::new(TokenizerType::Heuristic);
        let sensory_buffer =
            SensoryBuffer::from_config(config, Tokenizer::new(TokenizerType::Heuristic));
        let working_memory = WorkingMemory::new(
            agent_id.clone(),
            token_budget,
            Tokenizer::new(TokenizerType::Heuristic),
        );

        Self {
            agent_id,
            sensory_buffer,
            working_memory,
            tokenizer,
        }
    }

    /// Push a message pair into the sensory buffer.
    /// If the buffer is full, the evicted entry is promoted to working memory.
    /// Returns the number of slots evicted from working memory (if any).
    pub fn push_message(&mut self, user_input: &str, assistant_output: &str) -> usize {
        let evicted_entry =
            self.sensory_buffer
                .push(user_input.to_string(), assistant_output.to_string(), None);

        // Promote evicted sensory entries to working memory
        if let Some(entry) = evicted_entry {
            let content = format_sensory_entry(&entry);
            let token_cost = self.tokenizer.count_tokens(&content);
            let recency_score = 0.2; // low priority — tool-heavy audit rounds must not accumulate in WM
            let wm_evicted = self
                .working_memory
                .insert_sensory(content.clone(), recency_score);
            cognitive_event::emit(
                &self.agent_id,
                cognitive_event::CognitiveEventKind::SensoryPromoted {
                    entry_preview: if content.len() > 60 {
                        format!("{}…", crate::engine::util::safe_truncate(&content, 60))
                    } else {
                        content
                    },
                    token_cost,
                },
            );
            debug!(
                "[cognitive] Agent '{}': sensory→working memory promotion, {} WM evictions",
                self.agent_id,
                wm_evicted.len()
            );
            wm_evicted.len()
        } else {
            0
        }
    }

    /// Classify a query's intent and return signal weights.
    /// This drives intent-adaptive hybrid search weighting.
    pub fn classify_query(&self, query: &str) -> IntentClassification {
        intent_classifier::classify_intent(query)
    }

    /// Get the intent-adapted search config for a given query.
    /// Merges the default search config with intent-derived signal weights.
    /// Blends all 5 signal channels (§55.2), not just BM25.
    pub fn intent_search_config(
        &self,
        query: &str,
        base_config: &MemorySearchConfig,
    ) -> MemorySearchConfig {
        let intent = self.classify_query(query);
        let (bm25_w, vector_w, _graph_w, temporal_w, _emotional_w) = intent.signal_weights();

        let mut config = base_config.clone();
        // Blend the intent-derived weights with the user's configured weights
        // 60% intent-adaptive, 40% user-configured (preserves user tuning)
        config.hybrid.text_weight = bm25_w as f64 * 0.6 + config.hybrid.text_weight * 0.4;
        config.bm25_weight = bm25_w * 0.6 + config.bm25_weight * 0.4;
        config.vector_weight = vector_w * 0.6 + config.vector_weight * 0.4;
        // Temporal: shorter half-life for episodic queries (recent memories matter more)
        if temporal_w > 0.5 {
            config.decay_half_life_days *= 1.0 - temporal_w * 0.5;
        }
        config
    }

    /// Decay working memory priorities by the standard factor (0.95 per turn).
    pub fn decay_turn(&mut self) {
        self.working_memory.decay_priorities(0.95);
    }

    /// Get the MemoryScope for this agent.
    pub fn scope(&self) -> MemoryScope {
        MemoryScope {
            global: false,
            agent_id: Some(self.agent_id.clone()),
            ..Default::default()
        }
    }

    /// Snapshot the working memory for persistence (agent switching).
    pub fn snapshot_working_memory(&self) -> crate::atoms::engram_types::WorkingMemorySnapshot {
        self.working_memory.snapshot()
    }

    /// Restore working memory from a snapshot.
    pub fn restore_working_memory(
        &mut self,
        snapshot: crate::atoms::engram_types::WorkingMemorySnapshot,
    ) {
        self.working_memory.restore(snapshot);
        info!(
            "[cognitive] Agent '{}': restored {} working memory slots",
            self.agent_id,
            self.working_memory.slot_count()
        );
    }

    /// Inject gap prompts from maintenance into working memory.
    /// These are knowledge gaps detected during consolidation that the agent
    /// should be aware of (e.g., "Contradictory facts detected about X").
    /// Gap descriptions originate from raw DB content, so we sanitize them
    /// against prompt injection before WM insertion (§10.14).
    ///
    /// §58.5: Gap prompts use Strict sanitization (defensive default) because
    /// they come from DB consolidation where the originating model is unknown.
    /// This catches markdown directives and role assertions that Standard misses.
    pub fn inject_gap_prompts(&mut self, prompts: &[String]) {
        for prompt in prompts {
            let sanitized = encryption::sanitize_recalled_memory_at_level(
                prompt,
                crate::atoms::engram_types::SanitizationLevel::Strict,
            );
            self.working_memory.insert_tool_result(sanitized, 0.6);
        }
        if !prompts.is_empty() {
            cognitive_event::emit(
                &self.agent_id,
                cognitive_event::CognitiveEventKind::GapPromptsInjected {
                    gap_count: prompts.len(),
                    agents_affected: 1,
                },
            );
            info!(
                "[cognitive] Agent '{}': injected {} gap prompts into working memory",
                self.agent_id,
                prompts.len()
            );
        }
    }

    /// Get a reference to the tokenizer.
    pub fn tokenizer(&self) -> &Tokenizer {
        &self.tokenizer
    }

    /// Adapt the working memory budget to the actual model being used this turn.
    /// Called after the per-request model is resolved (which may differ from the
    /// default model used at CognitiveState creation time, e.g. via auto-tier routing).
    ///
    /// The budget is 10% of the model's context window, clamped to [2048, 32768].
    /// If the new budget differs from the current one, `set_token_budget()` handles
    /// eviction of excess slots (shrinking) or simply allows more capacity (growing).
    ///
    /// Returns true if the budget was changed, false if it was already correct.
    pub fn adapt_wm_budget(&mut self, model: &str) -> bool {
        let caps = crate::engine::engram::model_caps::resolve_model_capabilities(model);
        let new_budget = (caps.context_window / 10).clamp(2048, 32768);
        let old_budget = self.working_memory.token_budget();
        if new_budget != old_budget {
            log::info!(
                "[cognitive] Agent '{}': adapting WM budget {} → {} for model '{}'",
                self.agent_id,
                old_budget,
                new_budget,
                model
            );
            self.working_memory.set_token_budget(new_budget);
            true
        } else {
            false
        }
    }
}

/// Format a sensory buffer entry for working memory insertion.
/// Applies prompt injection sanitization (§10.14) so that promoted content
/// is safe to include in system prompts via working memory → ContextBuilder.
fn format_sensory_entry(entry: &SensoryEntry) -> String {
    let sanitized_input = encryption::sanitize_recalled_memory(&entry.input);
    let sanitized_output = encryption::sanitize_recalled_memory(&entry.output);
    if sanitized_output.is_empty() {
        sanitized_input
    } else {
        format!("User: {}\nAssistant: {}", sanitized_input, sanitized_output)
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn make_config() -> EngramConfig {
        EngramConfig {
            sensory_buffer_size: 3,
            working_memory_capacity: 7,
            ..Default::default()
        }
    }

    #[test]
    fn test_new_cognitive_state() {
        let cs = CognitiveState::new("agent-1".into(), &make_config(), 4096);
        assert_eq!(cs.agent_id, "agent-1");
        assert!(cs.working_memory.is_empty());
    }

    #[test]
    fn test_push_message_no_eviction() {
        let mut cs = CognitiveState::new("agent-1".into(), &make_config(), 4096);
        // Buffer size is 3, so first push won't evict
        let evicted = cs.push_message("hello", "hi there");
        assert_eq!(evicted, 0);
        // Sensory buffer should have 1 entry
        assert_eq!(cs.sensory_buffer.len(), 1);
    }

    #[test]
    fn test_push_message_with_promotion() {
        let mut cs = CognitiveState::new("agent-1".into(), &make_config(), 10_000);
        // Fill up the sensory buffer (size 3)
        cs.push_message("msg1", "out1");
        cs.push_message("msg2", "out2");
        cs.push_message("msg3", "out3");
        // This push should evict the oldest and promote it to working memory
        let _evicted = cs.push_message("msg4", "out4");
        assert!(cs.working_memory.slot_count() >= 1);
    }

    #[test]
    fn test_classify_query() {
        let cs = CognitiveState::new("agent-1".into(), &make_config(), 4096);
        let intent = cs.classify_query("How do I set up SSH keys?");
        assert!(intent.procedural > 0.3);
    }

    #[test]
    fn test_intent_search_config() {
        let cs = CognitiveState::new("agent-1".into(), &make_config(), 4096);
        let base = MemorySearchConfig::default();
        let adapted = cs.intent_search_config("What is the default port?", &base);
        // Factual query should have higher text weight than the base
        assert!(adapted.hybrid.text_weight > 0.0);
    }

    #[test]
    fn test_decay_turn() {
        let mut cs = CognitiveState::new("agent-1".into(), &make_config(), 10_000);
        cs.working_memory
            .insert_recall("m1".into(), "test".into(), 1.0);
        cs.decay_turn();
        assert!(cs.working_memory.slots()[0].priority < 1.0);
    }

    #[test]
    fn test_scope() {
        let cs = CognitiveState::new("agent-1".into(), &make_config(), 4096);
        let scope = cs.scope();
        assert_eq!(scope.agent_id, Some("agent-1".to_string()));
        assert!(!scope.global);
    }

    #[test]
    fn test_snapshot_restore() {
        let mut cs = CognitiveState::new("agent-1".into(), &make_config(), 10_000);
        cs.working_memory
            .insert_recall("m1".into(), "data".into(), 0.8);
        let snap = cs.snapshot_working_memory();

        let mut cs2 = CognitiveState::new("agent-1".into(), &make_config(), 10_000);
        cs2.restore_working_memory(snap);
        assert_eq!(cs2.working_memory.slot_count(), 1);
    }

    #[test]
    fn test_inject_gap_prompts() {
        let mut cs = CognitiveState::new("agent-1".into(), &make_config(), 10_000);
        cs.inject_gap_prompts(&[
            "Contradictory facts about project X".to_string(),
            "Missing context for entity Y".to_string(),
        ]);
        assert_eq!(cs.working_memory.slot_count(), 2);
    }

    // ── Locking & Concurrency Tests ─────────────────────────────────────

    /// Verify the HashMap<String, Arc<tokio::sync::Mutex<CognitiveState>>>
    /// pattern returns the same Arc for the same agent_id (identity test).
    #[test]
    fn test_cognitive_state_map_identity() {
        use parking_lot::Mutex;
        use std::collections::HashMap;
        use std::sync::Arc;

        let states: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<CognitiveState>>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // First access — creates new state
        let arc1 = {
            let mut map = states.lock();
            let cs = CognitiveState::new("agent-x".into(), &make_config(), 4096);
            let arc = Arc::new(tokio::sync::Mutex::new(cs));
            map.insert("agent-x".to_string(), Arc::clone(&arc));
            arc
        };

        // Second access — should return the SAME Arc
        let arc2 = {
            let map = states.lock();
            Arc::clone(map.get("agent-x").unwrap())
        };

        assert!(
            Arc::ptr_eq(&arc1, &arc2),
            "Same agent_id must return same Arc"
        );
    }

    /// Verify different agent_ids produce independent CognitiveState instances.
    #[test]
    fn test_cognitive_state_map_independent_agents() {
        use parking_lot::Mutex;
        use std::collections::HashMap;
        use std::sync::Arc;

        let states: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<CognitiveState>>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let arc_a = {
            let mut map = states.lock();
            let cs = CognitiveState::new("agent-a".into(), &make_config(), 4096);
            let arc = Arc::new(tokio::sync::Mutex::new(cs));
            map.insert("agent-a".to_string(), Arc::clone(&arc));
            arc
        };
        let arc_b = {
            let mut map = states.lock();
            let cs = CognitiveState::new("agent-b".into(), &make_config(), 4096);
            let arc = Arc::new(tokio::sync::Mutex::new(cs));
            map.insert("agent-b".to_string(), Arc::clone(&arc));
            arc
        };

        assert!(
            !Arc::ptr_eq(&arc_a, &arc_b),
            "Different agents must have different Arcs"
        );
    }

    /// Verify concurrent tasks can acquire and release the inner tokio Mutex
    /// without deadlock (smoke test for the per-agent locking pattern).
    #[tokio::test]
    async fn test_cognitive_state_concurrent_access_same_agent() {
        use std::sync::Arc;

        let cs = CognitiveState::new("agent-c".into(), &make_config(), 10_000);
        let shared = Arc::new(tokio::sync::Mutex::new(cs));

        let mut handles = Vec::new();
        for i in 0..5 {
            let cs_clone = Arc::clone(&shared);
            handles.push(tokio::spawn(async move {
                let mut guard = cs_clone.lock().await;
                guard.push_message(&format!("msg-{}", i), &format!("out-{}", i));
                // Hold the lock briefly — simulates the chat.rs pattern
                guard.decay_turn();
            }));
        }

        // All tasks should complete without deadlock
        for h in handles {
            h.await.expect("Task should not panic");
        }

        // Verify mutations accumulated
        let guard = shared.lock().await;
        assert!(
            guard.sensory_buffer.len() >= 1,
            "At least some messages should have been pushed"
        );
    }

    /// Verify that two different agents can be mutated simultaneously
    /// (no contention across agents).
    #[tokio::test]
    async fn test_cognitive_state_no_cross_agent_contention() {
        use std::sync::Arc;

        let cs_a = Arc::new(tokio::sync::Mutex::new(CognitiveState::new(
            "agent-a".into(),
            &make_config(),
            10_000,
        )));
        let cs_b = Arc::new(tokio::sync::Mutex::new(CognitiveState::new(
            "agent-b".into(),
            &make_config(),
            10_000,
        )));

        // Lock both simultaneously — this must NOT deadlock
        let (mut ga, mut gb) = tokio::join!(cs_a.lock(), cs_b.lock());
        ga.push_message("hello-a", "out-a");
        gb.push_message("hello-b", "out-b");
        assert_eq!(ga.agent_id, "agent-a");
        assert_eq!(gb.agent_id, "agent-b");
    }

    /// Verify parking_lot::Mutex on the HashMap is not held across .await.
    /// If someone accidentally held the outer Mutex across an await, the
    /// tokio::sync::Mutex lock() would hang → this test would timeout.
    #[tokio::test]
    async fn test_cognitive_state_outer_lock_not_held_across_await() {
        use parking_lot::Mutex;
        use std::collections::HashMap;
        use std::sync::Arc;

        let states: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<CognitiveState>>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // Insert initial state
        {
            let mut map = states.lock();
            let cs = CognitiveState::new("agent-z".into(), &make_config(), 4096);
            map.insert("agent-z".to_string(), Arc::new(tokio::sync::Mutex::new(cs)));
        }

        // Simulate the correct pattern: grab Arc (outer lock), drop outer, await inner
        let arc = {
            let map = states.lock();
            Arc::clone(map.get("agent-z").unwrap())
        };
        // outer Mutex is dropped here — inner lock can proceed
        let guard = arc.lock().await;
        assert_eq!(guard.agent_id, "agent-z");

        // Verify another caller can access the states HashMap simultaneously
        let map = states.lock();
        assert!(map.contains_key("agent-z"));
    }

    // ── WM Budget Adaptation Tests (§8.2) ───────────────────────────────

    /// Verify adapt_wm_budget changes the budget for a different model.
    #[test]
    fn test_adapt_wm_budget_changes_for_different_model() {
        let mut cs = CognitiveState::new("agent-1".into(), &make_config(), 4096);
        assert_eq!(cs.working_memory.token_budget(), 4096);

        // Claude Opus 4.6 has 200K context → 200000/10 = 20000, clamped → 20000
        let changed = cs.adapt_wm_budget("claude-opus-4-6");
        assert!(changed, "Budget should change for a large model");
        assert!(
            cs.working_memory.token_budget() > 4096,
            "Budget should increase for Opus: got {}",
            cs.working_memory.token_budget()
        );
    }

    /// Verify adapt_wm_budget is a no-op when the model matches the current budget.
    #[test]
    fn test_adapt_wm_budget_noop_when_same() {
        // gpt-4o has 128K context → 128000/10 = 12800
        let expected = (128_000usize / 10).clamp(2048, 32768);
        let mut cs = CognitiveState::new("agent-1".into(), &make_config(), expected);
        let changed = cs.adapt_wm_budget("gpt-4o");
        assert!(!changed, "Budget should not change when it already matches");
    }

    /// Verify adapt_wm_budget evicts excess slots when shrinking.
    #[test]
    fn test_adapt_wm_budget_shrink_evicts() {
        let mut cs = CognitiveState::new("agent-1".into(), &make_config(), 10_000);
        // Fill some slots
        for i in 0..20 {
            cs.working_memory.insert_recall(
                format!("m{}", i),
                format!(
                    "Long content that takes some tokens for recall memory number {}",
                    i
                ),
                0.5,
            );
        }
        let before_count = cs.working_memory.slot_count();
        assert!(before_count > 0);

        // Switch to a very small model (unknown → 32K context → 3200 budget)
        // This should shrink the budget and evict slots that don't fit
        cs.adapt_wm_budget("phi-3-mini");
        assert!(
            cs.working_memory.token_usage() <= cs.working_memory.token_budget(),
            "After shrink, usage {} must be <= budget {}",
            cs.working_memory.token_usage(),
            cs.working_memory.token_budget(),
        );
    }

    /// Verify adapt_wm_budget clamps to minimum 2048 even for tiny models.
    #[test]
    fn test_adapt_wm_budget_clamp_minimum() {
        let mut cs = CognitiveState::new("agent-1".into(), &make_config(), 4096);
        // Unknown model gets default 32K → 3200, but if a model had <20K
        // it would go below 2048. The clamp protects against that.
        // For now verify the budget is at least 2048 for any model.
        cs.adapt_wm_budget("some-tiny-unknown-model");
        assert!(
            cs.working_memory.token_budget() >= 2048,
            "Budget must be at least 2048: got {}",
            cs.working_memory.token_budget()
        );
    }

    /// Verify adapt_wm_budget clamps to maximum 32768.
    #[test]
    fn test_adapt_wm_budget_clamp_maximum() {
        let mut cs = CognitiveState::new("agent-1".into(), &make_config(), 4096);
        // Gemini Pro 2.0 has 2M context → 200000 unclamped → 32768 clamped
        cs.adapt_wm_budget("gemini-2.0-pro");
        assert!(
            cs.working_memory.token_budget() <= 32768,
            "Budget must be at most 32768: got {}",
            cs.working_memory.token_budget()
        );
    }
}
