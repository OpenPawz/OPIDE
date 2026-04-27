// Paw Agent Engine — Event types
//
// In legacy OpenPawz this module dispatched inbound events (webhook,
// agent message) to the kanban-task system, which would auto-fire any
// task whose `event_trigger` JSON matched. OPIDE phase 1 deleted the
// tasks subsystem, so dispatch is now a no-op. The `EngineEvent` enum
// is retained because `tools::squads` and `tools::agent_comms` still
// emit AgentMessage events for inter-agent observability.

use log::debug;

/// An event that can trigger task execution.
#[derive(Debug, Clone)]
pub enum EngineEvent {
    /// An inbound webhook request was received.
    Webhook {
        path: String,
        agent_id: String,
        payload: String,
    },
    /// An inter-agent message was delivered.
    AgentMessage {
        from_agent: String,
        to_agent: String,
        channel: String,
        content: String,
    },
}

/// Dispatch an event. Phase 1 of the OPIDE extraction removed the
/// kanban-task event-trigger pipeline, so this is a structured-logging
/// stub. The signature is preserved so callers compile unchanged.
pub async fn dispatch_event(_app_handle: &tauri::AppHandle, event: &EngineEvent) -> Vec<String> {
    match event {
        EngineEvent::Webhook { path, agent_id, .. } => {
            debug!("[events] Webhook event (no dispatch): path={path} agent={agent_id}");
        }
        EngineEvent::AgentMessage {
            from_agent,
            to_agent,
            channel,
            ..
        } => {
            debug!(
                "[events] AgentMessage event (no dispatch): from={from_agent} to={to_agent} channel={channel}"
            );
        }
    }
    Vec::new()
}
