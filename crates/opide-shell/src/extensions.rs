// ── OPIDE Extensions Installer ─────────────────────────────────────────────
//
// Replaces the curl/unzip shell pipeline in
// src/opide/extension-mcp.ts with native Tauri commands. The previous
// implementation interpolated server-controlled URLs into a shell command
// string (B63) and used `unzip` on attacker-derived paths (B64); both let
// a hostile Open VSX response inject arbitrary commands.
//
// Tauri commands exposed:
//   fetch_url_text(url)              → String       (small JSON metadata)
//   download_url_to_path(url, path)  → ()            (writes the .vsix bytes)
//   extract_vsix(vsix_path, target)  → ()            (zip extraction in-process)
//
// All three validate inputs (https only, no `..`, expected hosts) before
// touching the network or filesystem.

use std::path::{Path, PathBuf};

const ALLOWED_HOSTS: &[&str] = &[
    "open-vsx.org",
    "openvsxorg.blob.core.windows.net",
    "marketplace.visualstudio.com",
    "vscode.gallerycdn.vsassets.io",
];

fn validate_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid URL: {}", e))?;
    if parsed.scheme() != "https" {
        return Err("only https URLs are allowed".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "URL missing host".to_string())?;
    let host_l = host.to_lowercase();
    let host_ok = ALLOWED_HOSTS.iter().any(|h| {
        host_l == *h || host_l.ends_with(&format!(".{}", h))
    });
    if !host_ok {
        return Err(format!(
            "host '{}' not in extension-installer allowlist",
            host
        ));
    }
    if parsed.path().contains("..") {
        return Err("URL path may not contain `..`".into());
    }
    Ok(parsed)
}

#[tauri::command]
pub async fn ext_fetch_url_text(url: String) -> Result<String, String> {
    let parsed = validate_url(&url)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("client build: {}", e))?;
    let resp = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("fetch failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.text()
        .await
        .map_err(|e| format!("read body: {}", e))
}

/// Download `url` to `dest_path`. Validates the URL is in the allowlist
/// and refuses absolute writes outside `/tmp` / `/var/folders` (system
/// temp dirs we trust, see B132).
#[tauri::command]
pub async fn ext_download_url_to_path(url: String, dest_path: String) -> Result<(), String> {
    let parsed = validate_url(&url)?;

    let dest = PathBuf::from(&dest_path);
    let dest_parent = dest
        .parent()
        .map(|p| p.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let temp_ok = dest_parent.starts_with("/tmp/")
        || dest_parent.starts_with("/var/folders/")
        || dest_parent.starts_with("/private/tmp/")
        || dest_parent.starts_with("/private/var/tmp/")
        || dirs::cache_dir()
            .map(|c| dest.starts_with(&c))
            .unwrap_or(false);
    if !temp_ok {
        return Err(format!(
            "extension downloads must land in a temp dir (got '{}')",
            dest_path
        ));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("client build: {}", e))?;
    let resp = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read body: {}", e))?;

    // Sanity-cap the .vsix size at 200 MiB so a hostile response can't
    // wedge the host. Real extensions are well under this.
    if bytes.len() > 200 * 1024 * 1024 {
        return Err(format!(
            "vsix download too large: {} bytes (cap 200 MiB)",
            bytes.len()
        ));
    }

    if let Some(p) = dest.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("mkdir: {}", e))?;
    }
    std::fs::write(&dest, &bytes).map_err(|e| format!("write file: {}", e))?;
    Ok(())
}

/// Native vsix extraction. Skips entries whose names contain `..` (zip
/// path-traversal) or absolute paths, and flattens the conventional
/// `extension/` prefix that VSIX archives carry.
#[tauri::command]
pub async fn ext_extract_vsix(vsix_path: String, target_dir: String) -> Result<(), String> {
    let target = PathBuf::from(&target_dir);
    std::fs::create_dir_all(&target).map_err(|e| format!("mkdir target: {}", e))?;
    let canon_target = target
        .canonicalize()
        .map_err(|e| format!("canonicalize target: {}", e))?;

    let file = std::fs::File::open(&vsix_path).map_err(|e| format!("open vsix: {}", e))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {}", e))?;

    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("zip entry {}: {}", i, e))?;
        let raw_name = entry.name().to_string();
        // Strip the conventional VSIX prefix.
        let inner = raw_name
            .strip_prefix("extension/")
            .unwrap_or(&raw_name)
            .to_string();
        if inner.is_empty() || inner.contains("..") {
            continue;
        }
        // Reject absolute paths or anything that escapes when joined.
        if Path::new(&inner).is_absolute() {
            continue;
        }
        let out_path = target.join(&inner);
        // Sanity: canonicalised parent must still be inside target.
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {}", e))?;
            if let Ok(canon_parent) = parent.canonicalize() {
                if !canon_parent.starts_with(&canon_target) {
                    continue;
                }
            }
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| format!("mkdir entry: {}", e))?;
        } else {
            let mut out =
                std::fs::File::create(&out_path).map_err(|e| format!("create entry: {}", e))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("copy entry: {}", e))?;
        }
    }

    Ok(())
}
