// Build script: keep the public repo compilable without the proprietary
// extension host.
//
// `src/extension_host.rs` (the OVST runtime) is intentionally gitignored, so a
// fresh `git clone` of the public repo is missing it and fails with
// `error[E0583]: file not found for module extension_host` (issue #23). When
// the real file is absent we generate an inert stub with the same public API so
// the workspace builds; Open VSX extensions simply don't load in stub builds.
// On a machine that has the real file, this script does nothing.

use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src/extension_host.rs");

    let target = Path::new("src/extension_host.rs");
    if target.exists() {
        return; // real implementation present — leave it untouched
    }

    std::fs::write(target, STUB).expect("failed to write extension_host stub");
    println!(
        "cargo:warning=Generated a stub src/extension_host.rs — the proprietary \
         OVST extension host is not present, so Open VSX extensions will be inert \
         in this build."
    );
}

const STUB: &str = r####"// AUTO-GENERATED STUB — do not edit, do not commit.
//
// The real extension_host.rs (the OVST runtime) is proprietary and gitignored.
// build.rs writes this stub on a fresh checkout so the workspace compiles. It
// mirrors the public API the rest of the app links against; every command is a
// no-op that reports the extension host is unavailable.

use serde::Deserialize;
use tauri::{AppHandle, State};

#[derive(Debug, Deserialize)]
pub struct ExtHostStartRequest {
    pub extensions_path: String,
    pub workspace_path: String,
}

#[derive(Default)]
pub struct ExtHostState;

impl ExtHostState {
    pub fn new() -> Self {
        Self
    }
}

const STUB_MSG: &str = "extension host unavailable: this build was compiled without the \
proprietary OVST runtime (src/extension_host.rs). Open VSX extensions will not load. \
See build.rs / issue #23.";

#[tauri::command]
pub async fn ext_host_start(
    _app: AppHandle,
    _state: State<'_, ExtHostState>,
    _request: ExtHostStartRequest,
) -> Result<(), String> {
    log::warn!("[opide-ext-host:stub] {STUB_MSG}");
    Err(STUB_MSG.to_string())
}

#[tauri::command]
pub async fn ext_host_send(
    _state: State<'_, ExtHostState>,
    _message: String,
) -> Result<(), String> {
    Err(STUB_MSG.to_string())
}

#[tauri::command]
pub async fn ext_host_stop(
    _app: AppHandle,
    _state: State<'_, ExtHostState>,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn ext_host_status(_state: State<'_, ExtHostState>) -> Result<String, String> {
    Ok("stopped".to_string())
}

#[tauri::command]
pub async fn ext_host_log(message: String) -> Result<(), String> {
    log::warn!("[opide-ext-bridge] {message}");
    Ok(())
}
"####;
