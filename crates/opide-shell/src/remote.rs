// OPIDE Remote Development — SSH connections for remote file editing and terminals.
//
// Uses the system's ssh binary (no Rust SSH library needed — keeps it simple).
// Combined with Tailscale (already in OpenPawz), this enables:
//   - Connect to any machine on your tailnet by hostname
//   - Open remote folders (files read/written over SSH)
//   - Remote terminals (SSH shell sessions)
//
// Architecture:
//   - `remote_connect` — test SSH connectivity to a host
//   - `remote_exec` — run a command on a remote host
//   - `remote_read_file` — read a file from a remote host
//   - `remote_write_file` — write a file to a remote host
//   - `remote_list_dir` — list a directory on a remote host
//   - Remote terminal — spawn an SSH session via the existing PTY system

use serde::{Deserialize, Serialize};

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct RemoteHostInfo {
    pub host: String,
    pub user: String,
    pub connected: bool,
    pub os: String,
    pub home_dir: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct RemoteCommandResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Deserialize)]
pub struct RemoteConnectRequest {
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    /// Path to SSH private key (optional — uses default if not set)
    pub key_path: Option<String>,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn ssh_base_args(host: &str, user: &Option<String>, port: &Option<u16>, key_path: &Option<String>) -> Vec<String> {
    let mut args = vec![
        "-o".to_string(), "StrictHostKeyChecking=accept-new".to_string(),
        "-o".to_string(), "ConnectTimeout=10".to_string(),
        "-o".to_string(), "BatchMode=yes".to_string(),
    ];
    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    if let Some(key) = key_path {
        args.push("-i".to_string());
        args.push(key.clone());
    }
    let target = match user {
        Some(u) => format!("{u}@{host}"),
        None => host.to_string(),
    };
    args.push(target);
    args
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn remote_connect(request: RemoteConnectRequest) -> Result<RemoteHostInfo, String> {
    let mut args = ssh_base_args(&request.host, &request.user, &request.port, &request.key_path);
    args.push("echo OPIDE_CONNECTED && uname -s && echo $HOME && whoami".to_string());

    let output = tokio::process::Command::new("ssh")
        .args(&args)
        .output()
        .await
        .map_err(|e| format!("SSH connection failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("SSH connection failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = stdout.trim().lines().collect();

    if lines.first().map(|l| l.trim()) != Some("OPIDE_CONNECTED") {
        return Err("SSH connection test failed — unexpected response".into());
    }

    let os = lines.get(1).unwrap_or(&"unknown").trim().to_string();
    let home_dir = lines.get(2).unwrap_or(&"/home").trim().to_string();
    let user = lines.get(3).unwrap_or(&"unknown").trim().to_string();

    log::info!("[opide-remote] connected to {} as {} ({})", request.host, user, os);

    Ok(RemoteHostInfo {
        host: request.host,
        user,
        connected: true,
        os,
        home_dir,
    })
}

#[tauri::command]
pub async fn remote_exec(
    host: String,
    user: Option<String>,
    port: Option<u16>,
    command: String,
) -> Result<RemoteCommandResult, String> {
    let mut args = ssh_base_args(&host, &user, &port, &None);
    args.push(command);

    let output = tokio::process::Command::new("ssh")
        .args(&args)
        .output()
        .await
        .map_err(|e| format!("Remote exec failed: {e}"))?;

    Ok(RemoteCommandResult {
        exit_code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

#[tauri::command]
pub async fn remote_read_file(
    host: String,
    user: Option<String>,
    port: Option<u16>,
    path: String,
) -> Result<String, String> {
    let mut args = ssh_base_args(&host, &user, &port, &None);
    args.push(format!("cat '{}'", path.replace('\'', "'\\''")));

    let output = tokio::process::Command::new("ssh")
        .args(&args)
        .output()
        .await
        .map_err(|e| format!("Remote read failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Remote read failed: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
pub async fn remote_write_file(
    host: String,
    user: Option<String>,
    port: Option<u16>,
    path: String,
    content: String,
) -> Result<(), String> {
    let mut args = ssh_base_args(&host, &user, &port, &None);
    args.push(format!("cat > '{}'", path.replace('\'', "'\\''")));

    let mut child = tokio::process::Command::new("ssh")
        .args(&args)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Remote write failed: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin.write_all(content.as_bytes()).await
            .map_err(|e| format!("Remote write stdin failed: {e}"))?;
        stdin.shutdown().await
            .map_err(|e| format!("Remote write shutdown failed: {e}"))?;
    }

    let status = child.wait().await.map_err(|e| format!("Remote write wait failed: {e}"))?;
    if !status.success() {
        return Err("Remote write failed".into());
    }

    Ok(())
}

#[tauri::command]
pub async fn remote_list_dir(
    host: String,
    user: Option<String>,
    port: Option<u16>,
    path: String,
) -> Result<Vec<String>, String> {
    let mut args = ssh_base_args(&host, &user, &port, &None);
    args.push(format!("ls -1 '{}'", path.replace('\'', "'\\''")));

    let output = tokio::process::Command::new("ssh")
        .args(&args)
        .output()
        .await
        .map_err(|e| format!("Remote list failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Remote list failed: {stderr}"));
    }

    let entries = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();

    Ok(entries)
}
