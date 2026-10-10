use std::path::Path;
use std::sync::{Mutex, OnceLock};

use super::config::{Machine, RemoteProject};
use super::exec::format_remote_output;
use super::ssh::{ExecRequest, ExecResult, Pool};
use crate::error::{Error, Result};

struct Active {
    machine: Machine,
    project: RemoteProject,
    pool: std::sync::Arc<Pool>,
    secret: Option<String>,
}

fn slot() -> &'static Mutex<Option<Active>> {
    static SLOT: OnceLock<Mutex<Option<Active>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Git calls do not receive AppState. The command layer sets this for the duration of one call.
pub fn with_remote<T>(
    machine: Machine,
    project: RemoteProject,
    pool: std::sync::Arc<Pool>,
    secret: Option<String>,
    work: impl FnOnce() -> Result<T>,
) -> Result<T> {
    {
        let mut guard = slot().lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(Active {
            machine,
            project,
            pool,
            secret,
        });
    }
    let result = work();
    let mut guard = slot().lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
    result
}

pub fn try_remote(workspace: &Path, args: &[&str]) -> Result<Option<String>> {
    let guard = slot().lock().unwrap_or_else(|e| e.into_inner());
    let Some(active) = guard.as_ref() else {
        return Ok(None);
    };
    let mount = Path::new(&active.project.mount_path);
    if !same_path(mount, workspace) {
        return Ok(None);
    }
    let command = git_command(args)?;
    let script = super::ssh::remote_shell_command(&active.project.remote_path, &command)?;
    let result = active.pool.exec(
        &active.machine,
        active.secret.as_deref(),
        &ExecRequest {
            cwd: active.project.remote_path.clone(),
            command: script,
            timeout_secs: super::exec::REMOTE_TIMEOUT_SECS,
        },
    )?;
    if result.exit_code.is_some_and(|code| code != 0) {
        let err = if result.stderr.is_empty() {
            result.stdout
        } else {
            result.stderr
        };
        if err.contains("not a git repository") {
            return Ok(Some(String::new()));
        }
        return Err(Error::Other(err.trim().chars().take(400).collect()));
    }
    Ok(Some(result.stdout))
}

fn same_path(a: &Path, b: &Path) -> bool {
    crate::paths::same_dir(a, b)
        || a.to_string_lossy().trim_end_matches('/') == b.to_string_lossy().trim_end_matches('/')
}

pub fn git_command(args: &[&str]) -> Result<String> {
    if args.is_empty() {
        return Err(Error::Other("git command is empty".into()));
    }
    let mut parts = vec!["git".to_string()];
    for arg in args {
        if arg.contains('\0') || arg.contains('\n') {
            return Err(Error::Other("invalid git argument".into()));
        }
        parts.push(super::ssh::shell_single_quote(arg));
    }
    Ok(parts.join(" "))
}

#[allow(dead_code)]
pub fn remote_git_text(result: &ExecResult) -> String {
    format_remote_output(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_command_quotes_each_argument() {
        assert_eq!(
            git_command(&["status", "--porcelain=v1", "src/a file.rs"]).unwrap(),
            "git 'status' '--porcelain=v1' 'src/a file.rs'"
        );
        assert!(git_command(&[]).is_err());
    }
}
