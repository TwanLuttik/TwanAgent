#[cfg(test)]
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::grok_cli::parse_cli_version;
use crate::process::WindowlessCommand;

use super::auth::read_claude_account;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClaudeCliInfo {
    pub installed: bool,
    pub path: String,
    pub version: Option<String>,
    pub logged_in: bool,
    pub email: Option<String>,
    /// A newer release than `version`. Empty when this install is current or the check has not run.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub update: String,
}

pub(super) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn which(name: &str) -> Option<PathBuf> {
    which_in(name, &crate::env_path::command_path())
}

/// `which` against an explicit PATH. A Dock-launched app does not inherit the shell PATH.
/// `where` can print `RUNNER~1` for a directory whose real name is `runneradmin`.
#[cfg(all(windows, test))]
fn same_windows_path(found: &Path, expected: &Path) -> bool {
    fn key(path: &Path) -> String {
        path.to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    }
    if key(found) == key(expected) {
        return true;
    }
    let (Ok(found), Ok(expected)) = (fs::canonicalize(found), fs::canonicalize(expected)) else {
        return false;
    };
    key(&found) == key(&expected)
}

fn which_in(name: &str, path: &str) -> Option<PathBuf> {
    let cmd = if cfg!(windows) { "where" } else { "which" };
    let mut command = Command::new(cmd);
    command.hide_console_window();
    command.arg(name);
    command.env("PATH", path);
    let out = command.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let path = text.lines().next()?.trim();
    if path.is_empty() {
        return None;
    }
    let found = PathBuf::from(path);
    found.is_file().then_some(found)
}

/// Claude Code CLI. Local installs live under `~/.claude/local`, then the developer PATH.
pub fn claude_bin() -> Option<PathBuf> {
    if let Some(home) = home_dir() {
        let names = if cfg!(windows) {
            ["claude.exe", "claude.cmd", "claude"]
        } else {
            ["claude", "claude", "claude"]
        };
        for name in names {
            let candidate = home.join(".claude").join("local").join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    which("claude")
}

pub fn claude_version(bin: &Path) -> Option<String> {
    let out = Command::new(bin)
        .hide_console_window()
        .arg("--version")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?.trim();
    parse_cli_version(line)
}

fn claude_version_cache() -> &'static std::sync::Mutex<Option<String>> {
    static VERSION: OnceLock<std::sync::Mutex<Option<String>>> = OnceLock::new();
    VERSION.get_or_init(|| std::sync::Mutex::new(None))
}

/// `claude --version` is a process spawn. A detected version is reused; a miss is tried again.
pub(super) fn cached_claude_version(bin: Option<&Path>) -> Option<String> {
    if let Some(found) = claude_version_cache()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
    {
        return Some(found);
    }
    let version = bin.and_then(claude_version)?;
    if let Ok(mut guard) = claude_version_cache().lock() {
        *guard = Some(version.clone());
    }
    Some(version)
}

/// Forget the version read at launch. The next settings read spawns `claude --version` again.
pub fn forget_claude_version() {
    if let Ok(mut guard) = claude_version_cache().lock() {
        *guard = None;
    }
}

pub fn claude_cli_info() -> ClaudeCliInfo {
    let bin = claude_bin();
    let version = cached_claude_version(bin.as_deref());
    let account = home_dir().and_then(|home| read_claude_account(&home));
    ClaudeCliInfo {
        installed: bin.is_some(),
        path: bin
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
        version,
        logged_in: account.as_ref().map(|row| row.0).unwrap_or(false),
        email: account.and_then(|row| row.1),
        update: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn which_finds_a_binary_the_process_path_cannot_see() {
        let dir = tempfile::tempdir().unwrap();
        let name = "twanagent-which-probe";
        let bin = dir.path().join(name);
        fs::write(&bin, b"#!/bin/sh\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        let short = "/usr/bin:/bin:/usr/sbin:/sbin";
        assert_eq!(which_in(name, short), None);
        let merged = format!("{}:{short}", dir.path().display());
        assert_eq!(which_in(name, &merged).as_deref(), Some(bin.as_path()));
    }

    #[cfg(windows)]
    #[test]
    fn where_finds_a_binary_using_the_explicit_path() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("twanagent-which-probe.cmd");
        fs::write(&bin, "@echo off\r\n").unwrap();
        let system = std::env::var("SystemRoot").unwrap();
        let short = format!(r"{system}\System32");
        assert_eq!(which_in("twanagent-which-probe.cmd", &short), None);
        let merged = crate::env_path::merge_command_path(
            &short,
            &[dir.path().to_string_lossy().into_owned()],
        );
        let found = which_in("twanagent-which-probe.cmd", &merged).expect("where finds the probe");
        // `where` prints the short 8.3 path. The temp directory is the long name.
        assert!(same_windows_path(&found, &bin), "{found:?} vs {bin:?}");
    }

    #[test]
    fn claude_bin_prefers_the_local_install() {
        let dir = tempfile::tempdir().unwrap();
        let prev = std::env::var_os("HOME");
        std::env::set_var("HOME", dir.path());
        let local = dir.path().join(".claude").join("local");
        fs::create_dir_all(&local).unwrap();
        let bin = local.join(if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        });
        fs::write(&bin, b"").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&bin, fs::Permissions::from_mode(0o755));
        }
        let found = claude_bin();
        match prev {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        assert_eq!(found.as_deref(), Some(bin.as_path()));
    }
}
