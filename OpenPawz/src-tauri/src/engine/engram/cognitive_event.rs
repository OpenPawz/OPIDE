// ── Engram: Cognitive Event Bus (§47.6) ──────────────────────────────────────
//
// Observability infrastructure for the cognitive pipeline.
//
// Every significant cognitive action (memory recall, gate decision, decay,
// consolidation, gap detection, momentum shift, quality refusal) emits a
// typed event through this bus. Consumers include:
//
//   - Debug panel (future): real-time visualization of memory system decisions
//   - Telemetry: latency / quality metrics aggregation
//   - Adaptive tuning: auto-adjust thresholds based on event patterns
//   - Logging: structured event-based audit trail
//
// Architecture:
//   Uses tokio::sync::broadcast for multi-consumer fanout. Events are small
//   (~200 bytes) and the channel is bounded (1024 events). Slow consumers
//   get a lagged error and skip events — this is acceptable for observability.
//
// Performance:
//   Broadcasting is effectively a memcpy into the channel buffer. On the hot
//   path (gated_search per query), this adds <1μs per event. decay_turn()
//   emits one event per agent per turn — negligible.
//
// Thread safety:
//   The bus is Arc-wrapped and the broadcast channel is lock-free internally.
//   Safe to call from any async or sync context.

use chrono::Utc;
use serde::Serialize;
use std::sync::{Arc, OnceLock};

/// The global cognitive event bus capacity.
/// 1024 events × ~200 bytes = ~200KB worst-case buffer.
const BUS_CAPACITY: usize = 1024;

/// Global singleton — standard pattern for observability infrastructure.
/// Initialized once at engine startup; if never initialized, all emit calls
/// are no-ops (no allocation, no overhead).
static GLOBAL_BUS: OnceLock<CognitiveEventBus> = OnceLock::new();

/// Initialize the global cognitive event bus. Call once at engine startup.
/// Returns the bus reference. Subsequent calls are no-ops (returns existing).
pub fn init() -> &'static CognitiveEventBus {
    GLOBAL_BUS.get_or_init(CognitiveEventBus::new)
}

/// Get the global bus, if initialized. Returns None pre-init (events are silently dropped).
pub fn bus() -> Option<&'static CognitiveEventBus> {
    GLOBAL_BUS.get()
}

/// Convenience: emit an event on the global bus if it's initialized.
/// If not initialized, this is a no-op. Use this from pipeline code to avoid
/// Option-unwrap verbosity.
pub fn emit(agent_id: &str, kind: CognitiveEventKind) {
    if let Some(b) = bus() {
        b.emit(agent_id, kind);
    }
}

/// Convenience: emit a gate decision event on the global bus.
pub fn emit_gate(agent_id: &str, gate: &str, query: &str) {
    if let Some(b) = bus() {
        b.emit_gate(agent_id, gate, query);
    }
}

/// Convenience: emit a recall event on the global bus.
pub fn emit_recall(agent_id: &str, count: usize, top_score: f32, latency_ms: u64, tier: &str) {
    if let Some(b) = bus() {
        b.emit_recall(agent_id, count, top_score, latency_ms, tier);
    }
}

/// Convenience: emit a CRAG corrective action event on the global bus.
pub fn emit_crag(agent_id: &str, action: &str, sub_queries: usize, recovered: usize) {
    if let Some(b) = bus() {
        b.emit_crag(agent_id, action, sub_queries, recovered);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Event Types
// ═════════════════════════════════════════════════════════════════════════════

/// A cognitive event emitted by the Engram pipeline.
#[derive(Debug, Clone, Serialize)]
pub struct CognitiveEvent {
    /// When the event occurred (UTC ISO 8601).
    pub timestamp: String,
    /// Which agent triggered the event (empty for system-wide events).
    pub agent_id: String,
    /// The event payload.
    pub kind: CognitiveEventKind,
}

/// Typed event payloads.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum CognitiveEventKind {
    // ── Retrieval lifecycle ──────────────────────────────────────────
    /// Gate decision was made for a query.
    GateDecided {
        gate: String,
        query_preview: String,
        word_count: usize,
    },
    /// Memory recall completed.
    MemoryRecalled {
        memories_count: usize,
        top_score: f32,
        latency_ms: u64,
        quality_tier: String,
    },
    /// CRAG corrective action triggered (DecomposeAndRetry or EscalatingRecovery).
    CragCorrective {
        action: String,
        sub_queries: usize,
        recovered_count: usize,
    },
    /// Quality gate refused results.
    QualityRefused {
        query_preview: String,
        reason: String,
    },

    // ── Cognitive state lifecycle ────────────────────────────────────
    /// Working memory decay applied.
    DecayApplied {
        slots_count: usize,
        decay_factor: f32,
    },
    /// Sensory buffer entry promoted to working memory.
    SensoryPromoted {
        entry_preview: String,
        token_cost: usize,
    },
    /// Momentum vector updated (trajectory recall).
    MomentumShifted {
        embedding_dim: usize,
        total_momentum_vectors: usize,
    },

    // ── Maintenance lifecycle ────────────────────────────────────────
    /// Consolidation completed.
    ConsolidationComplete {
        triples_created: usize,
        memories_decayed: usize,
        memories_gc: usize,
    },
    /// Knowledge gaps detected and injected.
    GapPromptsInjected {
        gap_count: usize,
        agents_affected: usize,
    },

    // ── Security events ─────────────────────────────────────────────
    /// Injection attempt detected and redacted.
    InjectionRedacted {
        source: String,
        content_length: usize,
    },
    /// Defer gate triggered — disambiguation needed.
    DeferTriggered {
        reason: String,
        query_preview: String,
    },
}

// ═════════════════════════════════════════════════════════════════════════════
// Bus Implementation
// ═════════════════════════════════════════════════════════════════════════════

/// The cognitive event bus — multi-consumer broadcast channel.
#[derive(Clone)]
pub struct CognitiveEventBus {
    sender: Arc<tokio::sync::broadcast::Sender<CognitiveEvent>>,
}

impl CognitiveEventBus {
    /// Create a new event bus with the default capacity.
    pub fn new() -> Self {
        let (sender, _) = tokio::sync::broadcast::channel(BUS_CAPACITY);
        Self {
            sender: Arc::new(sender),
        }
    }

    /// Emit a cognitive event. Non-blocking; if the channel is full,
    /// the oldest event is dropped (lagged consumers will see an error).
    pub fn emit(&self, agent_id: &str, kind: CognitiveEventKind) {
        let event = CognitiveEvent {
            timestamp: Utc::now().to_rfc3339(),
            agent_id: agent_id.to_string(),
            kind,
        };
        // Ignore send error — it means no receivers are active, which is fine
        // for observability. The bus is fire-and-forget by design.
        let _ = self.sender.send(event);
    }

    /// Subscribe to cognitive events. Returns a receiver that will get all
    /// future events. Use in a tokio::spawn for async consumption.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<CognitiveEvent> {
        self.sender.subscribe()
    }

    /// Get the number of active subscribers.
    pub fn subscriber_count(&self) -> usize {
        self.sender.receiver_count()
    }

    // ── Convenience emitters for common events ──────────────────────────

    /// Emit a gate decision event.
    pub fn emit_gate(&self, agent_id: &str, gate: &str, query: &str) {
        self.emit(
            agent_id,
            CognitiveEventKind::GateDecided {
                gate: gate.to_string(),
                query_preview: truncate_preview(query, 60),
                word_count: query.split_whitespace().count(),
            },
        );
    }

    /// Emit a memory recall event.
    pub fn emit_recall(
        &self,
        agent_id: &str,
        count: usize,
        top_score: f32,
        latency_ms: u64,
        quality_tier: &str,
    ) {
        self.emit(
            agent_id,
            CognitiveEventKind::MemoryRecalled {
                memories_count: count,
                top_score,
                latency_ms,
                quality_tier: quality_tier.to_string(),
            },
        );
    }

    /// Emit a decay event.
    pub fn emit_decay(&self, agent_id: &str, slots: usize, factor: f32) {
        self.emit(
            agent_id,
            CognitiveEventKind::DecayApplied {
                slots_count: slots,
                decay_factor: factor,
            },
        );
    }

    /// Emit a momentum shift event.
    pub fn emit_momentum(&self, agent_id: &str, dim: usize, total: usize) {
        self.emit(
            agent_id,
            CognitiveEventKind::MomentumShifted {
                embedding_dim: dim,
                total_momentum_vectors: total,
            },
        );
    }

    /// Emit a CRAG corrective action event.
    pub fn emit_crag(&self, agent_id: &str, action: &str, sub_queries: usize, recovered: usize) {
        self.emit(
            agent_id,
            CognitiveEventKind::CragCorrective {
                action: action.to_string(),
                sub_queries,
                recovered_count: recovered,
            },
        );
    }

    /// Emit a gap injection event.
    pub fn emit_gaps(&self, gap_count: usize, agents_affected: usize) {
        self.emit(
            "",
            CognitiveEventKind::GapPromptsInjected {
                gap_count,
                agents_affected,
            },
        );
    }
}

impl Default for CognitiveEventBus {
    fn default() -> Self {
        Self::new()
    }
}

/// Truncate for event previews (no PII concern — events are internal only).
fn truncate_preview(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let mut end = max;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &s[..end])
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bus_creation() {
        let bus = CognitiveEventBus::new();
        assert_eq!(bus.subscriber_count(), 0);
    }

    #[test]
    fn test_emit_without_subscribers() {
        let bus = CognitiveEventBus::new();
        // Should not panic even with no subscribers
        bus.emit_gate("agent-1", "Retrieve", "test query");
        bus.emit_decay("agent-1", 5, 0.95);
        bus.emit_recall("agent-1", 3, 0.75, 42, "Correct");
    }

    #[test]
    fn test_subscribe_receives_events() {
        let bus = CognitiveEventBus::new();
        let mut rx = bus.subscribe();
        assert_eq!(bus.subscriber_count(), 1);

        bus.emit_gate("agent-1", "Skip", "hello");
        let event = rx.try_recv().expect("Should receive event");
        assert_eq!(event.agent_id, "agent-1");
        assert!(matches!(event.kind, CognitiveEventKind::GateDecided { .. }));
    }

    #[test]
    fn test_multiple_subscribers() {
        let bus = CognitiveEventBus::new();
        let mut rx1 = bus.subscribe();
        let mut rx2 = bus.subscribe();
        assert_eq!(bus.subscriber_count(), 2);

        bus.emit_decay("agent-1", 10, 0.95);

        assert!(rx1.try_recv().is_ok());
        assert!(rx2.try_recv().is_ok());
    }

    #[test]
    fn test_truncate_preview() {
        assert_eq!(truncate_preview("short", 60), "short");
        assert_eq!(truncate_preview("a".repeat(100).as_str(), 10).len(), 13); // 10 chars + "…" (3 bytes)
    }

    #[test]
    fn test_emit_all_event_kinds() {
        let bus = CognitiveEventBus::new();
        let mut rx = bus.subscribe();

        bus.emit_gate("a", "Retrieve", "query");
        bus.emit_recall("a", 5, 0.8, 100, "Correct");
        bus.emit_decay("a", 3, 0.95);
        bus.emit_momentum("a", 768, 3);
        bus.emit_crag("a", "DecomposeAndRetry", 3, 5);
        bus.emit_gaps(2, 4);
        bus.emit(
            "a",
            CognitiveEventKind::InjectionRedacted {
                source: "recall".into(),
                content_length: 200,
            },
        );
        bus.emit(
            "a",
            CognitiveEventKind::DeferTriggered {
                reason: "AmbiguousReference".into(),
                query_preview: "delete it".into(),
            },
        );

        // All 8 events should be received
        let mut count = 0;
        while rx.try_recv().is_ok() {
            count += 1;
        }
        assert_eq!(count, 8);
    }
}
