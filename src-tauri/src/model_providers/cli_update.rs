//! Whether an installed CLI has a newer release.
//!
//! The check hits the same public channel the CLI itself uses. A result is kept
//! in the app database so opening Settings does not fetch again until it is stale.
//! A failed fetch leaves the last good result in place.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::grok_cli::{grok_home, parse_toml_quoted};
use crate::process::WindowlessCommand;

/// A check older than this is fetched again. Newer than this is returned as-is.
pub const CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);

const GROK_CHANNEL_BASE: &str = "https://storage.googleapis.com/grok-build-public-artifacts/cli";
const CLAUDE_LATEST_URL: &str =
    "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest";
const MINIMAX_LATEST_URL: &str = "https://registry.npmjs.org/mmx-cli/latest";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CliUpdate {
    /// The installed version this check was made against.
    pub installed: String,
    /// The newer release, when one exists. Empty when the install is current.
    #[serde(default)]
    pub available: String,
    /// Unix seconds. A check older than `CACHE_TTL` is fetched again.
    pub checked_at: i64,
}

/// True when `latest` is a newer release than `installed`.
/// `1.0.0-beta.1` is older than `1.0.0`. Equal versions are not an update.
pub fn version_is_older(installed: &str, latest: &str) -> bool {
    let installed = installed.trim();
    let latest = latest.trim();
    if installed.is_empty() || latest.is_empty() || installed == latest {
        return false;
    }
    let (installed_num, installed_pre) = split_version(installed);
    let (latest_num, latest_pre) = split_version(latest);
    if installed_num.is_empty() || latest_num.is_empty() {
        return false;
    }
    let len = installed_num.len().max(latest_num.len());
    for i in 0..len {
        let left = installed_num.get(i).copied().unwrap_or(0);
        let right = latest_num.get(i).copied().unwrap_or(0);
        if left != right {
            return left < right;
        }
    }
    match (installed_pre, latest_pre) {
        (Some(left), Some(right)) => left < right,
        (Some(_), None) => true,
        _ => false,
    }
}

fn split_version(raw: &str) -> (Vec<u64>, Option<u64>) {
    let (head, tail) = raw.split_once('-').unwrap_or((raw, ""));
    let numbers = head
        .split('.')
        .filter_map(|part| part.parse::<u64>().ok())
        .collect();
    let pre = tail
        .rsplit(|ch: char| !ch.is_ascii_digit())
        .next()
        .filter(|part| !part.is_empty())
        .and_then(|part| part.parse().ok());
    (numbers, pre)
}

/// The release to show, or empty when `latest` is not newer than `installed`.
pub fn newer_version(installed: &str, latest: &str) -> String {
    let latest = latest.trim();
    if version_is_older(installed, latest) {
        latest.to_string()
    } else {
        String::new()
    }
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

/// A saved check for this exact install that is still inside `CACHE_TTL`.
pub fn fresh_cache(saved: Option<&CliUpdate>, installed: &str, now: i64) -> Option<CliUpdate> {
    let saved = saved?;
    if saved.installed != installed.trim() {
        return None;
    }
    let age = now.saturating_sub(saved.checked_at);
    if age < 0 || age >= CACHE_TTL.as_secs() as i64 {
        return None;
    }
    Some(saved.clone())
}

fn cache_key(id: &str) -> String {
    format!("cli-update.{id}")
}

fn read_cache(data_dir: &std::path::Path, id: &str) -> Option<CliUpdate> {
    let conn = crate::appdb::open(data_dir).ok()?;
    let raw = crate::appdb::get_setting(&conn, &cache_key(id)).ok()??;
    serde_json::from_str(&raw).ok()
}

fn write_cache(data_dir: &std::path::Path, id: &str, update: &CliUpdate) {
    let Ok(raw) = serde_json::to_string(update) else {
        return;
    };
    let Ok(conn) = crate::appdb::open(data_dir) else {
        return;
    };
    let _ = crate::appdb::set_setting(&conn, &cache_key(id), &raw);
}

/// The cached check when it still matches this install and is fresh. Otherwise fetch once and save it.
/// A failed fetch keeps the previous row, even when that row is stale.
pub async fn cached_update(
    data_dir: &std::path::Path,
    id: &str,
    installed: Option<&str>,
    latest: impl std::future::Future<Output = Option<String>>,
) -> Option<CliUpdate> {
    let installed = installed.map(str::trim).filter(|version| !version.is_empty())?;
    let saved = read_cache(data_dir, id);
    if let Some(hit) = fresh_cache(saved.as_ref(), installed, now_secs()) {
        return Some(hit);
    }
    let Some(latest) = latest.await else {
        return saved.filter(|row| row.installed == installed);
    };
    let update = CliUpdate {
        installed: installed.to_string(),
        available: newer_version(installed, &latest),
        checked_at: now_secs(),
    };
    write_cache(data_dir, id, &update);
    Some(update)
}

/// Grok's `[cli] channel`. `alpha`, `stable`, and `enterprise` are the public pointers. Anything else is stable.
pub fn grok_channel(config: &str) -> &'static str {
    match parse_toml_quoted(config, "cli", "channel")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "alpha" => "alpha",
        "enterprise" => "enterprise",
        _ => "stable",
    }
}

pub fn grok_channel_url(channel: &str) -> String {
    format!("{GROK_CHANNEL_BASE}/{channel}")
}

fn grok_config_channel() -> String {
    let config = grok_home()
        .and_then(|home| std::fs::read_to_string(home.join("config.toml")).ok())
        .unwrap_or_default();
    grok_channel(&config).to_string()
}

async fn fetch_text(url: &str) -> Option<String> {
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .ok()?
        .get(url)
        .header("accept", "text/plain, application/json")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.text().await.ok()?;
    let line = body.lines().next()?.trim();
    if line.is_empty() || line.len() > 80 {
        return None;
    }
    Some(line.to_string())
}

/// One version from a channel pointer such as `1.0.58`.
pub fn parse_channel_version(body: &str) -> Option<String> {
    let line = body.lines().next()?.trim();
    let version = line
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '.' || *ch == '-')
        .collect::<String>();
    version
        .starts_with(|ch: char| ch.is_ascii_digit())
        .then_some(version)
        .filter(|text| !text.is_empty())
}

/// `version` from an npm `latest` document.
pub fn parse_npm_latest(body: &str) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    let version = json.get("version")?.as_str()?.trim();
    parse_channel_version(version)
}

pub async fn grok_latest() -> Option<String> {
    let url = grok_channel_url(&grok_config_channel());
    parse_channel_version(&fetch_text(&url).await?)
}

pub async fn claude_latest() -> Option<String> {
    parse_channel_version(&fetch_text(CLAUDE_LATEST_URL).await?)
}

pub async fn minimax_latest() -> Option<String> {
    parse_npm_latest(&fetch_text(MINIMAX_LATEST_URL).await?)
}

pub async fn grok_update(data_dir: &std::path::Path, installed: Option<&str>) -> Option<CliUpdate> {
    cached_update(data_dir, "grok", installed, grok_latest()).await
}

pub async fn claude_update(data_dir: &std::path::Path, installed: Option<&str>) -> Option<CliUpdate> {
    cached_update(data_dir, "claude", installed, claude_latest()).await
}

pub async fn minimax_update(data_dir: &std::path::Path, installed: Option<&str>) -> Option<CliUpdate> {
    cached_update(data_dir, "minimax", installed, minimax_latest()).await
}

/// Drop the saved check so the next settings read fetches again. An update just changed the install.
pub fn forget_cache(data_dir: &std::path::Path, id: &str) {
    let Ok(conn) = crate::appdb::open(data_dir) else {
        return;
    };
    let _ = crate::appdb::set_setting(&conn, &cache_key(id), "");
}

/// The last useful line of a CLI update. Installers print progress; the end is what failed or finished.
pub fn update_output_tail(stdout: &str, stderr: &str) -> String {
    let text = format!("{stdout}\n{stderr}");
    let line = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("The CLI update failed.");
    const CAP: usize = 240;
    if line.chars().count() <= CAP {
        line.to_string()
    } else {
        let end = line.chars().skip(line.chars().count() - CAP).collect::<String>();
        format!("…{end}")
    }
}

/// Run one CLI's own updater. `program` is the installed binary, so a Dock-launched app does not need it on PATH.
/// A non-zero exit is the updater's own message, not a missing binary.
pub fn run_cli_update(program: &std::path::Path, args: &[&str]) -> Result<(), String> {
    let mut command = std::process::Command::new(program);
    command.hide_console_window();
    command.args(args);
    // npm and the MiniMax installer look up `node`. A GUI app does not inherit a shell PATH.
    let mut prefixes = Vec::new();
    if let Some(node) = node_bin_dir() {
        prefixes.push(node);
    }
    command.env(
        "PATH",
        crate::env_path::merge_command_path(&crate::env_path::command_path(), &prefixes),
    );
    let output = command.output().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            format!("{} is not installed.", program.display())
        } else {
            err.to_string()
        }
    })?;
    if output.status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(update_output_tail(&stdout, &stderr))
}

/// A directory that holds `node`, for an npm CLI. Homebrew's versioned formulas come first.
fn node_bin_dir() -> Option<String> {
    for extra in ["/opt/homebrew/opt/node@22/bin", "/opt/homebrew/bin", "/usr/local/bin"] {
        if std::path::Path::new(extra).join("node").is_file() {
            return Some(extra.to_string());
        }
    }
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from)?;
    for rel in [".nvm/versions/node", ".local/share/fnm/node-versions"] {
        let root = home.join(rel);
        let found = std::fs::read_dir(&root).ok()?.filter_map(Result::ok).find_map(|entry| {
            let bin = entry.path().join("bin");
            bin.join("node").is_file().then(|| bin.display().to_string())
        });
        if found.is_some() {
            return found;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_newer_release_is_an_update_and_the_same_one_is_not() {
        assert!(version_is_older("1.0.55", "1.0.58"));
        assert!(!version_is_older("1.0.58", "1.0.58"));
        assert!(!version_is_older("1.0.58", "1.0.55"));
        assert!(version_is_older("1.0.0-beta.1", "1.0.0-beta.2"));
        assert!(version_is_older("1.0.0-beta.2", "1.0.0"));
        assert!(!version_is_older("1.0.0", "1.0.0-beta.2"));
        assert!(!version_is_older("", "1.0.58"));
        assert!(!version_is_older("1.0.58", ""));
        assert_eq!(newer_version("1.0.55", "1.0.58"), "1.0.58");
        assert!(newer_version("1.0.58", "1.0.58").is_empty());
        assert!(newer_version("2.1.299", "2.1.287").is_empty());
    }

    #[test]
    fn a_fresh_cache_is_reused_until_the_install_or_the_clock_moves() {
        let saved = CliUpdate {
            installed: "1.0.55".into(),
            available: "1.0.58".into(),
            checked_at: 1_000,
        };
        assert_eq!(fresh_cache(Some(&saved), "1.0.55", 1_000).as_ref(), Some(&saved));
        assert_eq!(
            fresh_cache(Some(&saved), "1.0.55", 1_000 + CACHE_TTL.as_secs() as i64 - 1).as_ref(),
            Some(&saved)
        );
        assert!(fresh_cache(Some(&saved), "1.0.55", 1_000 + CACHE_TTL.as_secs() as i64).is_none());
        assert!(fresh_cache(Some(&saved), "1.0.56", 1_000).is_none());
        assert!(fresh_cache(None, "1.0.55", 1_000).is_none());
    }

    #[test]
    fn grok_channel_follows_the_cli_config() {
        assert_eq!(grok_channel("[cli]\nchannel = \"alpha\"\n"), "alpha");
        assert_eq!(grok_channel("[cli]\nchannel = \"enterprise\"\n"), "enterprise");
        assert_eq!(grok_channel("[cli]\nchannel = \"nope\"\n"), "stable");
        assert_eq!(grok_channel(""), "stable");
        assert_eq!(
            grok_channel_url("alpha"),
            "https://storage.googleapis.com/grok-build-public-artifacts/cli/alpha"
        );
    }

    #[test]
    fn channel_and_npm_bodies_become_one_version() {
        assert_eq!(parse_channel_version("1.0.58\n").as_deref(), Some("1.0.58"));
        assert_eq!(parse_channel_version("2.1.299").as_deref(), Some("2.1.299"));
        assert_eq!(parse_channel_version("1.0.0-beta.2").as_deref(), Some("1.0.0-beta.2"));
        assert!(parse_channel_version("missing").is_none());
        assert!(parse_channel_version("").is_none());
        assert_eq!(
            parse_npm_latest(r#"{"name":"mmx-cli","version":"1.0.28"}"#).as_deref(),
            Some("1.0.28")
        );
        assert!(parse_npm_latest(r#"{"name":"mmx-cli"}"#).is_none());
        assert!(parse_npm_latest("nope").is_none());
    }

    #[test]
    fn an_update_failure_keeps_the_last_line_and_drops_the_progress() {
        assert_eq!(
            update_output_tail("downloading\ninstalled 2.1.309\n", ""),
            "installed 2.1.309"
        );
        assert_eq!(update_output_tail("", "\nEACCES: permission denied\n"), "EACCES: permission denied");
        assert_eq!(update_output_tail("   \n", "  "), "The CLI update failed.");
        let long = "x".repeat(300);
        assert!(update_output_tail(&long, "").starts_with('…'));
        assert!(update_output_tail(&long, "").chars().count() <= 241);
    }
}
