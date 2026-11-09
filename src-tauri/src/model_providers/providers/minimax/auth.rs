use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use serde::Serialize;

use crate::grok_cli::parse_cli_version;
use crate::process::WindowlessCommand;

const OAUTH_CLIENT_ID: &str = "659cf4c1-615c-45f6-a5f6-4bf15eb476e5";
const REFRESH_BUFFER_MS: i64 = 5 * 60 * 1000;

/// Global first. CN is the other host the CLI knows.
pub(super) const REGIONS: &[(&str, &str, &str)] = &[
    (
        "global",
        "https://api.minimax.io",
        "https://account.minimax.io",
    ),
    (
        "cn",
        "https://api.minimax.cn",
        "https://account.minimaxi.com",
    ),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MinimaxAuth {
    pub token: String,
    pub base_url: String,
    /// Saved API key, not the `mmx` OAuth login.
    pub via_key: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MinimaxCliInfo {
    pub installed: bool,
    pub path: String,
    pub version: Option<String>,
    pub logged_in: bool,
    pub email: Option<String>,
    /// A newer release than `version`. Empty when this install is current or the check has not run.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub update: String,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// `~/.mmx`, or `MMX_HOME` when that is set.
pub fn mmx_home() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("MMX_HOME") {
        let path = PathBuf::from(raw);
        if !path.as_os_str().is_empty() {
            return Some(path);
        }
    }
    home_dir().map(|home| home.join(".mmx"))
}

fn config_path(home: &Path) -> PathBuf {
    home.join("config.json")
}

/// The `mmx` binary. A local `~/.mmx/bin/mmx` wins, then `which mmx`.
pub fn mmx_bin() -> Option<PathBuf> {
    if let Some(home) = mmx_home() {
        for name in bin_names() {
            let candidate = home.join("bin").join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    if let Some(home) = home_dir() {
        for name in bin_names() {
            let candidate = home.join(".npm-global").join("bin").join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    which("mmx")
}

fn bin_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["mmx.exe", "mmx.cmd", "mmx"]
    } else {
        &["mmx"]
    }
}

fn which(name: &str) -> Option<PathBuf> {
    which_in(name, &crate::env_path::command_path())
}

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

pub fn mmx_version(bin: &Path) -> Option<String> {
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
    parse_cli_version(line).or_else(|| {
        let trimmed = line.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MmxConfig {
    api_key: Option<String>,
    region: String,
    base_url: Option<String>,
    oauth: Option<MmxOAuth>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MmxOAuth {
    access_token: String,
    refresh_token: String,
    expires_at: String,
    region: String,
    resource_url: Option<String>,
}

fn read_config(home: &Path) -> Option<MmxConfig> {
    let raw = fs::read_to_string(config_path(home)).ok()?;
    parse_config(&raw)
}

fn parse_config(raw: &str) -> Option<MmxConfig> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    if !value.is_object() {
        return None;
    }
    let api_key = value
        .get("api_key")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string);
    let region = value
        .get("region")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| region_row(item).is_some())
        .unwrap_or("global")
        .to_string();
    let base_url = value
        .get("base_url")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| item.starts_with("http"))
        .map(str::to_string);
    let oauth = value.get("oauth").and_then(parse_oauth);
    Some(MmxConfig {
        api_key,
        region,
        base_url,
        oauth,
    })
}

fn parse_oauth(value: &serde_json::Value) -> Option<MmxOAuth> {
    let access_token = value
        .get("access_token")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())?
        .to_string();
    let refresh_token = value
        .get("refresh_token")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())?
        .to_string();
    let expires_at = value
        .get("expires_at")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())?
        .to_string();
    let region = value
        .get("region")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| region_row(item).is_some())
        .unwrap_or("global")
        .to_string();
    let resource_url = value
        .get("resource_url")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| item.starts_with("http"))
        .map(str::to_string);
    Some(MmxOAuth {
        access_token,
        refresh_token,
        expires_at,
        region,
        resource_url,
    })
}

fn region_row(region: &str) -> Option<(&'static str, &'static str, &'static str)> {
    REGIONS.iter().copied().find(|(id, ..)| *id == region)
}

fn api_base(region: &str, base_url: Option<&str>, resource_url: Option<&str>) -> String {
    if let Some(base) = base_url
        .map(str::trim)
        .filter(|item| item.starts_with("http"))
    {
        return base.trim_end_matches('/').to_string();
    }
    if let Some(base) = resource_url
        .map(str::trim)
        .filter(|item| item.starts_with("http"))
    {
        return base.trim_end_matches('/').to_string();
    }
    region_row(region)
        .map(|(_, api, _)| api.to_string())
        .unwrap_or_else(|| REGIONS[0].1.to_string())
}

/// Saved key, then `MINIMAX_API_KEY`, then the `mmx` OAuth login.
/// An OAuth token near expiry is refreshed and written back, matching the CLI.
pub async fn resolve_minimax_auth_fresh() -> Option<MinimaxAuth> {
    resolve_minimax_auth_fresh_in(&crate::state::app_data_dir()).await
}

pub async fn resolve_minimax_auth_fresh_in(data_dir: &Path) -> Option<MinimaxAuth> {
    if let Some(key) = crate::secrets::resolve_minimax_key_on_disk(data_dir) {
        let base = mmx_home()
            .and_then(|home| read_config(&home))
            .map(|config| api_base(&config.region, config.base_url.as_deref(), None))
            .unwrap_or_else(|| REGIONS[0].1.to_string());
        return Some(MinimaxAuth {
            token: key,
            base_url: base,
            via_key: true,
        });
    }
    let home = mmx_home()?;
    let config = read_config(&home)?;
    if let Some(oauth) = config.oauth.clone() {
        let base_fallback = api_base(
            &oauth.region,
            config.base_url.as_deref(),
            oauth.resource_url.as_deref(),
        );
        if !token_needs_refresh(&oauth.expires_at) {
            return Some(MinimaxAuth {
                token: oauth.access_token,
                base_url: base_fallback,
                via_key: false,
            });
        }
        let fresh = refresh_oauth(&oauth).await?;
        let _ = write_oauth(&home, &config, &fresh);
        let base = api_base(
            &fresh.region,
            config.base_url.as_deref(),
            fresh.resource_url.as_deref(),
        );
        return Some(MinimaxAuth {
            token: fresh.access_token,
            base_url: base,
            via_key: false,
        });
    }
    None
}

fn mmx_version_cache() -> &'static std::sync::Mutex<Option<String>> {
    static VERSION: OnceLock<std::sync::Mutex<Option<String>>> = OnceLock::new();
    VERSION.get_or_init(|| std::sync::Mutex::new(None))
}

/// Login state for settings. Does not refresh and does not return the token.
/// `mmx --version` is a process spawn. A detected version is reused; a miss is tried again.
fn cached_mmx_version(bin: Option<&Path>) -> Option<String> {
    if let Some(found) = mmx_version_cache()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
    {
        return Some(found);
    }
    let version = bin.and_then(mmx_version)?;
    if let Ok(mut guard) = mmx_version_cache().lock() {
        *guard = Some(version.clone());
    }
    Some(version)
}

/// Forget the version read at launch. The next settings read spawns `mmx --version` again.
pub fn forget_mmx_version() {
    if let Ok(mut guard) = mmx_version_cache().lock() {
        *guard = None;
    }
}

pub fn minimax_cli_info() -> MinimaxCliInfo {
    let bin = mmx_bin();
    let version = cached_mmx_version(bin.as_deref());
    let config = mmx_home().and_then(|home| read_config(&home));
    let logged_in = config
        .as_ref()
        .map(|row| row.api_key.is_some() || row.oauth.is_some())
        .unwrap_or(false)
        || crate::secrets::resolve_minimax_key_on_disk(&crate::state::app_data_dir()).is_some();
    MinimaxCliInfo {
        installed: bin.is_some(),
        path: bin
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
        version,
        logged_in,
        email: None,
        update: String::new(),
    }
}

fn token_needs_refresh(expires_at: &str) -> bool {
    let Ok(dt) = chrono::DateTime::parse_from_rfc3339(expires_at.trim()) else {
        return false;
    };
    let expires_ms = dt.timestamp_millis();
    let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return false;
    };
    expires_ms <= now.as_millis() as i64 + REFRESH_BUFFER_MS
}

async fn refresh_oauth(oauth: &MmxOAuth) -> Option<MmxOAuth> {
    let host = region_row(&oauth.region)
        .map(|(_, _, account)| account)
        .unwrap_or(REGIONS[0].2);
    let url = format!("{host}/oauth2/token");
    let body = [
        ("grant_type", "refresh_token"),
        ("refresh_token", oauth.refresh_token.as_str()),
        ("client_id", OAUTH_CLIENT_ID),
    ];
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .ok()?
        .post(url)
        .header("content-type", "application/x-www-form-urlencoded")
        .form(&body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let fresh: serde_json::Value = response.json().await.ok()?;
    parse_refresh(&fresh, oauth)
}

fn parse_refresh(body: &serde_json::Value, previous: &MmxOAuth) -> Option<MmxOAuth> {
    if body.get("status").and_then(|item| item.as_str()) != Some("success") {
        return None;
    }
    let access_token = body
        .get("access_token")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())?
        .to_string();
    let refresh_token = body
        .get("refresh_token")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| previous.refresh_token.clone());
    let expires_at =
        expires_from_refresh(body.get("expired_in")).unwrap_or_else(|| previous.expires_at.clone());
    let resource_url = body
        .get("resource_url")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| item.starts_with("http"))
        .map(str::to_string)
        .or_else(|| previous.resource_url.clone());
    Some(MmxOAuth {
        access_token,
        refresh_token,
        expires_at,
        region: previous.region.clone(),
        resource_url,
    })
}

/// The CLI treats `expired_in` as an absolute timestamp in milliseconds.
fn expires_from_refresh(value: Option<&serde_json::Value>) -> Option<String> {
    let ms = value?.as_i64().filter(|ms| *ms > 0)?;
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)?;
    Some(dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn write_oauth(home: &Path, previous: &MmxConfig, oauth: &MmxOAuth) -> Result<(), String> {
    let path = config_path(home);
    let mut stored = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    let obj = stored
        .as_object_mut()
        .ok_or_else(|| "config is not an object".to_string())?;
    let mut oauth_value = obj
        .get("oauth")
        .cloned()
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(row) = oauth_value.as_object_mut() {
        row.insert(
            "access_token".into(),
            serde_json::Value::String(oauth.access_token.clone()),
        );
        row.insert(
            "refresh_token".into(),
            serde_json::Value::String(oauth.refresh_token.clone()),
        );
        row.insert(
            "expires_at".into(),
            serde_json::Value::String(oauth.expires_at.clone()),
        );
        row.insert(
            "region".into(),
            serde_json::Value::String(oauth.region.clone()),
        );
        if let Some(url) = &oauth.resource_url {
            row.insert(
                "resource_url".into(),
                serde_json::Value::String(url.clone()),
            );
        }
    }
    obj.insert("oauth".into(), oauth_value);
    if !obj.contains_key("region") {
        obj.insert(
            "region".into(),
            serde_json::Value::String(previous.region.clone()),
        );
    }
    let text = serde_json::to_string_pretty(&stored).map_err(|err| err.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(path, text).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn where_finds_a_binary_using_the_explicit_path() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("twanagent-mmx-probe.cmd");
        fs::write(&bin, "@echo off\r\n").unwrap();
        let system = std::env::var("SystemRoot").unwrap();
        let short = format!(r"{system}\System32");
        assert_eq!(which_in("twanagent-mmx-probe.cmd", &short), None);
        let merged = crate::env_path::merge_command_path(
            &short,
            &[dir.path().to_string_lossy().into_owned()],
        );
        let found = which_in("twanagent-mmx-probe.cmd", &merged).expect("where finds the probe");
        // `where` prints the short 8.3 path. The temp directory is the long name.
        assert!(same_windows_path(&found, &bin), "{found:?} vs {bin:?}");
    }

    #[test]
    fn config_reads_oauth_without_keeping_a_key() {
        let raw = r#"{
            "oauth": {
                "access_token": "oat-token",
                "refresh_token": "dfrt-token",
                "expires_at": "2026-10-13T00:09:15.125Z",
                "region": "global",
                "resource_url": "https://api.minimax.io"
            },
            "region": "global"
        }"#;
        let config = parse_config(raw).unwrap();
        assert!(config.api_key.is_none());
        let oauth = config.oauth.unwrap();
        assert_eq!(oauth.access_token, "oat-token");
        assert_eq!(
            oauth.resource_url.as_deref(),
            Some("https://api.minimax.io")
        );
        assert_eq!(
            api_base(&oauth.region, None, oauth.resource_url.as_deref()),
            "https://api.minimax.io"
        );
        assert!(parse_config("nope").is_none());
        assert!(!token_needs_refresh("2099-01-01T00:00:00.000Z"));
        assert!(token_needs_refresh("2000-01-01T00:00:00.000Z"));
    }

    #[test]
    fn refresh_payload_rotates_the_token() {
        let previous = MmxOAuth {
            access_token: "old".into(),
            refresh_token: "refresh".into(),
            expires_at: "2000-01-01T00:00:00.000Z".into(),
            region: "global".into(),
            resource_url: Some("https://api.minimax.io".into()),
        };
        let body = serde_json::json!({
            "status": "success",
            "access_token": "new-token",
            "refresh_token": "new-refresh",
            "expired_in": 4_102_444_800_000_i64,
            "resource_url": "https://api.minimax.io"
        });
        let fresh = parse_refresh(&body, &previous).unwrap();
        assert_eq!(fresh.access_token, "new-token");
        assert_eq!(fresh.refresh_token, "new-refresh");
        assert_eq!(fresh.expires_at, "2100-01-01T00:00:00.000Z");
        assert!(parse_refresh(&serde_json::json!({"status":"error"}), &previous).is_none());
    }

    #[test]
    fn mmx_bin_prefers_the_local_install() {
        let dir = tempfile::tempdir().unwrap();
        let prev = std::env::var_os("MMX_HOME");
        std::env::set_var("MMX_HOME", dir.path());
        let bin_dir = dir.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let bin = bin_dir.join(if cfg!(windows) { "mmx.exe" } else { "mmx" });
        fs::write(&bin, b"").unwrap();
        let found = mmx_bin();
        match prev {
            Some(value) => std::env::set_var("MMX_HOME", value),
            None => std::env::remove_var("MMX_HOME"),
        }
        assert_eq!(found.as_deref(), Some(bin.as_path()));
    }
}
