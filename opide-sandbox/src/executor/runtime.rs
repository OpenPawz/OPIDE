// ── Sandbox Executor ─────────────────────────────────────────────────────────
// Creates a QuickJS runtime with strict limits, executes agent JS, returns result.
//
// Two execution modes:
//   execute_js(code)              — Phase 1: ctx.log() only
//   execute_js_with_host(code, host) — Phase 2+: full host API (files, exec, etc.)
//
// Constraints:
//   - 10 MB memory hard limit
//   - 1 MB stack size
//   - 30 second timeout (checked via interrupt handler)
//   - No raw filesystem, network, or system calls
//   - No require/import — no module loading
//   - All I/O goes through the HostApi trait

use crate::host_api::HostApi;
use super::host_inject::inject_host_api;
use super::helpers::{js_value_to_json, extract_logs};
use rquickjs::{Context, Function, Runtime, Value as JsValue};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(not(test))]
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;

/// Callback invoked each time ctx.log() is called from JS.
/// Receives the log message immediately (for real-time streaming to UI).
pub type LogCallback = Arc<dyn Fn(&str) + Send + Sync>;
use std::time::{Duration, Instant};

// ─── Constants ──────────────────────────────────────────────────────────────

const MEMORY_LIMIT: usize = 128 * 1024 * 1024; // 128 MB — bumped from 10MB to handle large file reads and search results in audit workloads
// B149: 1 MB was too tight for AST traversal in TypeScript / large recursive
// queries; bump to 4 MB. Still well below typical OS thread defaults.
const STACK_SIZE: usize = 4 * 1024 * 1024; // 4 MB
const TIMEOUT: Duration = Duration::from_secs(30);

/// B142: cap concurrent sandbox executions so N parallel agent calls don't
/// each pin a 128 MB QuickJS heap and OOM the host. Counter-based "semaphore"
/// keeps the sync execution path simple — callers that hit the cap fail fast.
#[cfg(not(test))]
const MAX_CONCURRENT_SANDBOXES: usize = 4;
#[cfg(not(test))]
static SANDBOX_INFLIGHT: AtomicUsize = AtomicUsize::new(0);

#[cfg(not(test))]
struct SandboxPermit;
#[cfg(not(test))]
impl SandboxPermit {
    fn try_acquire() -> Option<Self> {
        loop {
            let cur = SANDBOX_INFLIGHT.load(Ordering::Acquire);
            if cur >= MAX_CONCURRENT_SANDBOXES {
                return None;
            }
            if SANDBOX_INFLIGHT
                .compare_exchange(cur, cur + 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return Some(SandboxPermit);
            }
        }
    }
}
#[cfg(not(test))]
impl Drop for SandboxPermit {
    fn drop(&mut self) {
        SANDBOX_INFLIGHT.fetch_sub(1, Ordering::AcqRel);
    }
}

// ─── Result Type ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SandboxResult {
    /// The return value from `run(ctx)`, serialized as JSON
    pub value: serde_json::Value,
    /// Log messages collected during execution (from ctx.log)
    pub logs: Vec<String>,
    /// Execution time in milliseconds
    pub elapsed_ms: u64,
    /// Whether the execution completed successfully
    pub success: bool,
    /// Error message if execution failed
    pub error: Option<String>,
}

// ─── Execute (Phase 1 — no host API) ───────────────────────────────────────

/// Execute JS with only ctx.log() available. No file or exec access.
pub fn execute_js(code: &str) -> SandboxResult {
    execute_internal(code, None, None)
}

// ─── Execute with Host API (Phase 2+) ──────────────────────────────────────

/// Execute JS with the full host API injected into `ctx`.
pub fn execute_js_with_host(code: &str, host: Arc<dyn HostApi>) -> SandboxResult {
    execute_internal(code, Some(host), None)
}

/// Execute JS with host API AND real-time log streaming.
/// The log_callback is invoked immediately each time ctx.log() is called,
/// enabling live progress updates in the UI while the sandbox runs.
pub fn execute_js_with_host_streaming(
    code: &str,
    host: Arc<dyn HostApi>,
    log_callback: LogCallback,
) -> SandboxResult {
    execute_internal(code, Some(host), Some(log_callback))
}

// ─── Core Execution ─────────────────────────────────────────────────────────

fn execute_internal(
    code: &str,
    host: Option<Arc<dyn HostApi>>,
    log_callback: Option<LogCallback>,
) -> SandboxResult {
    let start = Instant::now();

    // B142: refuse to spin up another runtime past MAX_CONCURRENT_SANDBOXES.
    // Each runtime can pin MEMORY_LIMIT bytes; uncapped concurrency lets a
    // batch of parallel agent calls OOM the host. Disabled under cfg(test)
    // because the test harness runs many sandbox tests in parallel and isn't
    // exercising the resource-pressure case the cap protects against.
    #[cfg(not(test))]
    let _permit = match SandboxPermit::try_acquire() {
        Some(p) => p,
        None => {
            return SandboxResult {
                value: serde_json::Value::Null,
                logs: vec![],
                elapsed_ms: 0,
                success: false,
                error: Some(format!(
                    "Sandbox: too many concurrent executions ({} max), retry shortly",
                    MAX_CONCURRENT_SANDBOXES
                )),
            };
        }
    };

    // ── Create runtime with limits ──────────────────────────────────
    let runtime = match Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            return SandboxResult {
                value: serde_json::Value::Null,
                logs: vec![],
                elapsed_ms: start.elapsed().as_millis() as u64,
                success: false,
                error: Some(format!("Failed to create JS runtime: {e}")),
            };
        }
    };

    runtime.set_memory_limit(MEMORY_LIMIT);
    runtime.set_max_stack_size(STACK_SIZE);

    // ── Timeout via interrupt handler ───────────────────────────────
    let timed_out = Arc::new(AtomicBool::new(false));
    let timed_out_clone = timed_out.clone();

    runtime.set_interrupt_handler(Some(Box::new(move || {
        if start.elapsed() > TIMEOUT {
            timed_out_clone.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    })));

    // ── Create context ──────────────────────────────────────────────
    let context = match Context::full(&runtime) {
        Ok(ctx) => ctx,
        Err(e) => {
            return SandboxResult {
                value: serde_json::Value::Null,
                logs: vec![],
                elapsed_ms: start.elapsed().as_millis() as u64,
                success: false,
                error: Some(format!("Failed to create JS context: {e}")),
            };
        }
    };

    // ── Execute code ────────────────────────────────────────────────
    let result = context.with(|ctx| {
        // Set up __logs array
        if let Err(e) = ctx.eval::<(), &str>("var __logs = []; var ctx = {};") {
            return SandboxResult {
                value: serde_json::Value::Null,
                logs: vec![],
                elapsed_ms: start.elapsed().as_millis() as u64,
                success: false,
                error: Some(format!("Setup error: {e}")),
            };
        }

        // Inject ctx.log — if we have a callback, use a Rust-backed function
        // that both stores the log AND calls the callback for real-time streaming
        let globals = ctx.globals();
        let ctx_obj: rquickjs::Object = match globals.get("ctx") {
            Ok(o) => o,
            Err(e) => {
                return SandboxResult {
                    value: serde_json::Value::Null,
                    logs: vec![],
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    success: false,
                    error: Some(format!("ctx object error: {e}")),
                };
            }
        };

        if let Some(ref cb) = log_callback {
            // Rust-backed log: pushes to __logs AND calls the streaming callback
            let cb_clone = cb.clone();
            let log_fn = Function::new(ctx.clone(), move |msg: String| -> rquickjs::Result<()> {
                cb_clone(&msg);
                Ok(())
            });
            match log_fn {
                Ok(f) => { let _ = ctx_obj.set("__log_rust", f); }
                Err(e) => {
                    return SandboxResult {
                        value: serde_json::Value::Null,
                        logs: vec![],
                        elapsed_ms: start.elapsed().as_millis() as u64,
                        success: false,
                        error: Some(format!("log callback bind: {e}")),
                    };
                }
            }
            // JS wrapper that stores + calls Rust
            let _ = ctx.eval::<(), &str>(r#"
                ctx.log = function(msg) {
                    var s = String(msg);
                    __logs.push(s);
                    ctx.__log_rust(s);
                };
            "#);
        } else {
            // Pure JS log — just stores in array
            let _ = ctx.eval::<(), &str>(r#"
                ctx.log = function(msg) { __logs.push(String(msg)); };
            "#);
        }

        // ── Inject host API functions if provided ───────────────────
        if let Some(ref host) = host {
            if let Err(e) = inject_host_api(&ctx, host.clone()) {
                return SandboxResult {
                    value: serde_json::Value::Null,
                    logs: vec![],
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    success: false,
                    error: Some(format!("Host API injection error: {e}")),
                };
            }
        }

        // Wrap the user code: define the function, then call run(ctx)
        let wrapped = format!(
            r#"
            {code}

            (function() {{
                if (typeof run === 'function') {{
                    return run(ctx);
                }} else {{
                    return {{ error: "No run(ctx) function defined" }};
                }}
            }})()
            "#,
            code = code
        );

        let eval_result: Result<JsValue, _> = ctx.eval(wrapped);

        match eval_result {
            Ok(js_val) => {
                let value = js_value_to_json(&ctx, &js_val);
                let logs = extract_logs(&ctx);

                SandboxResult {
                    value,
                    logs,
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    success: true,
                    error: None,
                }
            }
            Err(e) => {
                let logs = extract_logs(&ctx);

                if timed_out.load(Ordering::Relaxed) {
                    SandboxResult {
                        value: serde_json::Value::Null,
                        logs,
                        elapsed_ms: start.elapsed().as_millis() as u64,
                        success: false,
                        error: Some(format!(
                            "Execution timed out ({}s limit)",
                            TIMEOUT.as_secs()
                        )),
                    }
                } else {
                    // Try to extract the actual JS exception message for better diagnostics
                    let error_msg = if matches!(e, rquickjs::Error::Exception) {
                        let exc = ctx.catch();
                        if let Some(obj) = exc.clone().into_object() {
                            let msg: String = obj.get("message").unwrap_or_default();
                            let stack: String = obj.get("stack").unwrap_or_default();
                            if !msg.is_empty() && !stack.is_empty() {
                                format!("JS exception: {msg}\n{stack}")
                            } else if !msg.is_empty() {
                                format!("JS exception: {msg}")
                            } else {
                                format!("JS exception (no message): {exc:?}")
                            }
                        } else {
                            format!("JS exception: {exc:?}")
                        }
                    } else {
                        format!("JS execution error: {e}")
                    };
                    SandboxResult {
                        value: serde_json::Value::Null,
                        logs,
                        elapsed_ms: start.elapsed().as_millis() as u64,
                        success: false,
                        error: Some(error_msg),
                    }
                }
            }
        }
    });

    result
}

