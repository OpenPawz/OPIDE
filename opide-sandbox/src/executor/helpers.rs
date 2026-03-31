// ── Helpers & Async Wrappers ─────────────────────────────────────────────────

use crate::host_api::HostApi;
use rquickjs::{Function, Value as JsValue};
use std::sync::Arc;

use super::runtime::{LogCallback, SandboxResult, execute_js, execute_js_with_host, execute_js_with_host_streaming};

pub(super) fn js_value_to_json<'js>(ctx: &rquickjs::Ctx<'js>, val: &JsValue<'js>) -> serde_json::Value {
    let globals = ctx.globals();
    let json_obj: Result<rquickjs::Object, _> = globals.get("JSON");
    if let Ok(json_obj) = json_obj {
        let stringify: Result<Function, _> = json_obj.get("stringify");
        if let Ok(stringify) = stringify {
            let result: Result<String, _> = stringify.call((val.clone(),));
            if let Ok(json_str) = result {
                if let Ok(parsed) = serde_json::from_str(&json_str) {
                    return parsed;
                }
            }
        }
    }

    if val.is_undefined() || val.is_null() {
        serde_json::Value::Null
    } else if let Some(b) = val.as_bool() {
        serde_json::Value::Bool(b)
    } else if let Some(n) = val.as_int() {
        serde_json::Value::Number(n.into())
    } else if let Some(n) = val.as_float() {
        serde_json::json!(n)
    } else if let Some(s) = val.clone().into_string() {
        if let Ok(s) = s.to_string() {
            serde_json::Value::String(s)
        } else {
            serde_json::Value::Null
        }
    } else {
        serde_json::Value::Null
    }
}

pub(super) fn extract_logs(ctx: &rquickjs::Ctx<'_>) -> Vec<String> {
    let globals = ctx.globals();
    let logs_val: Result<rquickjs::Array, _> = globals.get("__logs");
    match logs_val {
        Ok(arr) => {
            let mut logs = Vec::new();
            for i in 0..arr.len() {
                if let Ok(entry) = arr.get::<String>(i) {
                    logs.push(entry);
                }
            }
            logs
        }
        Err(_) => vec![],
    }
}

// ─── Async Wrappers ─────────────────────────────────────────────────────────

/// Async wrapper — no host API.
pub async fn execute_js_async(code: String) -> SandboxResult {
    tokio::task::spawn_blocking(move || execute_js(&code))
        .await
        .unwrap_or_else(|e| SandboxResult {
            value: serde_json::Value::Null,
            logs: vec![],
            elapsed_ms: 0,
            success: false,
            error: Some(format!("Sandbox thread panicked: {e}")),
        })
}

/// Async wrapper — with host API.
pub async fn execute_js_with_host_async(code: String, host: Arc<dyn HostApi>) -> SandboxResult {
    tokio::task::spawn_blocking(move || execute_js_with_host(&code, host))
        .await
        .unwrap_or_else(|e| SandboxResult {
            value: serde_json::Value::Null,
            logs: vec![],
            elapsed_ms: 0,
            success: false,
            error: Some(format!("Sandbox thread panicked: {e}")),
        })
}

/// Async wrapper — with host API AND real-time log streaming.
pub async fn execute_js_with_host_streaming_async(
    code: String,
    host: Arc<dyn HostApi>,
    log_callback: LogCallback,
) -> SandboxResult {
    tokio::task::spawn_blocking(move || execute_js_with_host_streaming(&code, host, log_callback))
        .await
        .unwrap_or_else(|e| SandboxResult {
            value: serde_json::Value::Null,
            logs: vec![],
            elapsed_ms: 0,
            success: false,
            error: Some(format!("Sandbox thread panicked: {e}")),
        })
}

