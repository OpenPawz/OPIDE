// OPIDE Git — powered by libgit2 via the `git2` crate.
//
// Provides Tauri commands for the full SCM workflow:
//   status, diff, stage, unstage, commit, log, branch, checkout, push, pull
//
// Frontend wires these into the VS Code SCM panel via the scm-service-override.

use git2::{
    DiffOptions, IndexAddOption, Repository, StatusOptions, StatusShow,
};
use serde::{Deserialize, Serialize};

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct GitFileStatus {
    pub path: String,
    /// "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted"
    pub status: String,
    /// true if the change is staged (in index)
    pub staged: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct GitStatusResult {
    pub repo_root: String,
    pub branch: Option<String>,
    pub files: Vec<GitFileStatus>,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Debug, Serialize, Clone)]
pub struct GitDiffResult {
    pub path: String,
    pub patch: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct GitLogEntry {
    pub id: String,
    pub short_id: String,
    pub message: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct GitBranch {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
}

#[derive(Debug, Deserialize)]
pub struct GitCommitRequest {
    pub message: String,
    pub repo_path: String,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn open_repo(path: &str) -> Result<Repository, String> {
    Repository::discover(path).map_err(|e| format!("Not a git repository: {e}"))
}

fn status_string(status: git2::Status) -> &'static str {
    if status.is_conflicted() {
        "conflicted"
    } else if status.is_wt_new() || status.is_index_new() {
        "added"
    } else if status.is_wt_deleted() || status.is_index_deleted() {
        "deleted"
    } else if status.is_wt_renamed() || status.is_index_renamed() {
        "renamed"
    } else if status.is_wt_modified() || status.is_index_modified() {
        "modified"
    } else {
        "untracked"
    }
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_status(repo_path: String) -> Result<GitStatusResult, String> {
    let repo = open_repo(&repo_path)?;

    // Current branch
    let branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(String::from));

    // Ahead/behind
    let (ahead, behind) = match repo.head() {
        Ok(head) => {
            let local_oid = head.target().unwrap_or_else(git2::Oid::zero);
            let upstream = repo
                .branch_upstream_name(head.name().unwrap_or(""))
                .ok()
                .and_then(|name| {
                    let name_str = name.as_str()?;
                    repo.find_reference(name_str).ok()?.target()
                });
            match upstream {
                Some(remote_oid) => repo
                    .graph_ahead_behind(local_oid, remote_oid)
                    .unwrap_or((0, 0)),
                None => (0, 0),
            }
        }
        Err(_) => (0, 0),
    };

    // File statuses
    let mut opts = StatusOptions::new();
    opts.show(StatusShow::IndexAndWorkdir)
        .include_untracked(true)
        .renames_head_to_index(true);

    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;

    let files: Vec<GitFileStatus> = statuses
        .iter()
        .filter_map(|entry| {
            let path = entry.path()?.to_string();
            let st = entry.status();

            if st.is_ignored() {
                return None;
            }

            let staged = st.is_index_new()
                || st.is_index_modified()
                || st.is_index_deleted()
                || st.is_index_renamed();

            Some(GitFileStatus {
                path,
                status: status_string(st).to_string(),
                staged,
            })
        })
        .collect();

    let repo_root = repo
        .workdir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok(GitStatusResult {
        repo_root,
        branch,
        files,
        ahead,
        behind,
    })
}

#[tauri::command]
pub async fn git_diff(repo_path: String, staged: bool) -> Result<Vec<GitDiffResult>, String> {
    let repo = open_repo(&repo_path)?;

    let mut diff_opts = DiffOptions::new();
    diff_opts.context_lines(3);

    let diff = if staged {
        let head_tree = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut diff_opts))
    } else {
        repo.diff_index_to_workdir(None, Some(&mut diff_opts))
    }
    .map_err(|e| e.to_string())?;

    let mut results = Vec::new();

    diff.print(git2::DiffFormat::Patch, |delta, _hunk, line| {
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let content = std::str::from_utf8(line.content()).unwrap_or("");
        let prefix = match line.origin() {
            '+' => "+",
            '-' => "-",
            ' ' => " ",
            _ => "",
        };

        // Find or create entry
        if let Some(entry) = results.iter_mut().find(|e: &&mut GitDiffResult| e.path == path) {
            entry.patch.push_str(prefix);
            entry.patch.push_str(content);
        } else {
            let mut patch = String::new();
            patch.push_str(prefix);
            patch.push_str(content);
            results.push(GitDiffResult { path, patch });
        }
        true
    })
    .map_err(|e| e.to_string())?;

    Ok(results)
}

#[tauri::command]
pub async fn git_stage(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;

    for path in &paths {
        // Check if file exists on disk — if not, it's a deletion
        let full_path = repo
            .workdir()
            .ok_or("No workdir")?
            .join(path);
        if full_path.exists() {
            index
                .add_path(std::path::Path::new(path))
                .map_err(|e| format!("Failed to stage {path}: {e}"))?;
        } else {
            index
                .remove_path(std::path::Path::new(path))
                .map_err(|e| format!("Failed to stage deletion {path}: {e}"))?;
        }
    }

    index.write().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn git_stage_all(repo_path: String) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;

    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn git_unstage(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;

    let head = repo.head().map_err(|e| e.to_string())?;
    let head_commit = head.peel_to_commit().map_err(|e| e.to_string())?;

    for path in &paths {
        repo.reset_default(Some(head_commit.as_object()), [path])
            .map_err(|e| format!("Failed to unstage {path}: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn git_commit(request: GitCommitRequest) -> Result<String, String> {
    let repo = open_repo(&request.repo_path)?;

    let sig = repo.signature().map_err(|e| format!("No git identity configured: {e}"))?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;

    let parent = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok());

    let parents: Vec<&git2::Commit> = parent.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, &request.message, &tree, &parents)
        .map_err(|e| e.to_string())?;

    log::info!("[opide-git] committed {}", oid);
    Ok(oid.to_string())
}

#[tauri::command]
pub async fn git_log(repo_path: String, limit: Option<usize>) -> Result<Vec<GitLogEntry>, String> {
    let repo = open_repo(&repo_path)?;
    let limit = limit.unwrap_or(50);

    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.push_head().map_err(|e| e.to_string())?;
    revwalk
        .set_sorting(git2::Sort::TIME)
        .map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for (i, oid) in revwalk.enumerate() {
        if i >= limit {
            break;
        }
        let oid = oid.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;

        entries.push(GitLogEntry {
            id: oid.to_string(),
            short_id: oid.to_string()[..7].to_string(),
            message: commit.message().unwrap_or("").trim().to_string(),
            author: commit.author().name().unwrap_or("").to_string(),
            email: commit.author().email().unwrap_or("").to_string(),
            timestamp: commit.time().seconds(),
        });
    }

    Ok(entries)
}

#[tauri::command]
pub async fn git_branches(repo_path: String) -> Result<Vec<GitBranch>, String> {
    let repo = open_repo(&repo_path)?;

    let branches = repo
        .branches(None)
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for branch in branches {
        let (branch, branch_type) = branch.map_err(|e| e.to_string())?;
        let name = branch.name().map_err(|e| e.to_string())?;
        if let Some(name) = name {
            result.push(GitBranch {
                name: name.to_string(),
                is_head: branch.is_head(),
                is_remote: branch_type == git2::BranchType::Remote,
            });
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn git_checkout(repo_path: String, branch_name: String) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;

    let (object, reference) = repo
        .revparse_ext(&branch_name)
        .map_err(|e| format!("Branch not found: {e}"))?;

    repo.checkout_tree(&object, None)
        .map_err(|e| e.to_string())?;

    match reference {
        Some(r) => {
            let name = r.name().ok_or("Invalid reference name")?;
            repo.set_head(name).map_err(|e| e.to_string())?;
        }
        None => {
            repo.set_head_detached(object.id())
                .map_err(|e| e.to_string())?;
        }
    }

    log::info!("[opide-git] checked out {}", branch_name);
    Ok(())
}

// ─── Checkpoint / Restore ─────────────────────────────────────────────────────

/// Snapshot returned by git_checkpoint_create.
/// head_sha: the HEAD commit to restore to.
/// stash_index: Some(0) if dirty files were stashed before the checkpoint, None otherwise.
#[derive(Debug, Serialize, Clone)]
pub struct GitCheckpoint {
    pub head_sha: String,
    pub stash_index: Option<usize>,
}

/// Save a checkpoint: record HEAD SHA and stash any existing dirty work.
/// Call this before an agent run so changes can be reverted later.
#[tauri::command]
pub async fn git_checkpoint_create(repo_path: String) -> Result<GitCheckpoint, String> {
    let mut repo = open_repo(&repo_path)?;

    let head_sha = repo
        .head()
        .map_err(|e| format!("No HEAD: {e}"))?
        .target()
        .ok_or("HEAD has no target")?
        .to_string();

    // Check for dirty files — drop statuses before calling stash_save (needs &mut repo)
    let has_dirty = {
        let mut opts = StatusOptions::new();
        opts.show(StatusShow::IndexAndWorkdir).include_untracked(true);
        let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
        statuses.iter().any(|e| !e.status().is_ignored())
    };

    // Only stash if the tree is clean — i.e. dirty files were introduced by
    // a previous agent run. If the user already has uncommitted changes before
    // the agent starts (deleted folders, WIP edits, etc.) we leave them alone.
    // The HEAD SHA is enough to hard-reset agent commits on restore.
    let stash_index = None;
    if has_dirty {
        log::info!("[opide-git] checkpoint: dirty tree before agent run — skipping stash, HEAD recorded only");
    }

    log::info!("[opide-git] checkpoint created at {}", head_sha);
    Ok(GitCheckpoint { head_sha, stash_index })
}

/// Restore from a checkpoint: hard-reset to head_sha, then pop the stash if one was created.
#[tauri::command]
pub async fn git_checkpoint_restore(
    repo_path: String,
    head_sha: String,
    stash_index: Option<usize>,
) -> Result<(), String> {
    let mut repo = open_repo(&repo_path)?;

    let oid = git2::Oid::from_str(&head_sha)
        .map_err(|e| format!("Invalid checkpoint SHA: {e}"))?;

    // Scope the commit borrow so it's dropped before stash_pop (which needs &mut repo)
    {
        let commit = repo
            .find_commit(oid)
            .map_err(|e| format!("Checkpoint commit not found: {e}"))?;
        repo.reset(commit.as_object(), git2::ResetType::Hard, None)
            .map_err(|e| format!("Hard reset failed: {e}"))?;
    }

    if let Some(idx) = stash_index {
        repo.stash_pop(idx, None)
            .map_err(|e| format!("Stash pop failed: {e}"))?;
        log::info!("[opide-git] stash popped after checkpoint restore");
    }

    log::info!("[opide-git] checkpoint restored to {}", head_sha);
    Ok(())
}
