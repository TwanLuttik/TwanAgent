//! MiniMax text chat. The official CLI is `mmx` (`mmx-cli`).
//!
//! Text goes to the Anthropic-shaped Messages API at `{base}/anthropic/v1/messages`,
//! with the token in `x-api-key`. That is the same wire format Claude uses, so the
//! body and SSE parser stay in `anthropic`. This module owns the model ids, the
//! `mmx` binary, and `~/.mmx/config.json`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::grok_cli::{effort_label, parse_cli_version, DevEffort, DevModel};
use crate::process::WindowlessCommand;

pub const PROVIDER_MINIMAX: &str = "minimax";
pub const DEFAULT_MODEL: &str = "MiniMax-M3";
pub const SIGN_IN_ERROR: &str =
    "MiniMax isn’t signed in. Run mmx auth login, or add a MiniMax API key in Settings.";
pub const KEY_REJECTED: &str = twanagent_service::minimax::KEY_REJECTED;

const OAUTH_CLIENT_ID: &str = "659cf4c1-615c-45f6-a5f6-4bf15eb476e5";
const REFRESH_BUFFER_MS: i64 = 5 * 60 * 1000;

/// Global first. CN is the other host the CLI knows.
const REGIONS: &[(&str, &str, &str)] = &[
    ("global", "https://api.minimax.io", "https://account.minimax.io"),
    ("cn", "https://api.minimax.cn", "https://account.minimaxi.com"),
];

/// Text models `mmx text chat` and the MiniMax coding config both offer.
/// Context and output caps follow the coding catalog. Vision is only on M3.
const MINIMAX_MODELS: &[(&str, &str, u64, u32, bool, &[&str])] = &[
    (
        "MiniMax-M3",
        "MiniMax M3",
        512_000,
        128_000,
        true,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "MiniMax-M3.1-Flash-Preview",
        "MiniMax M3.1 Flash",
        512_000,
        128_000,
        true,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "MiniMax-M2.7",
        "MiniMax M2.7",
        200_000,
        128_000,
        false,
        &["low", "medium", "high"],
    ),
    (
        "MiniMax-M2.7-highspeed",
        "MiniMax M2.7 Highspeed",
        200_000,
        128_000,
        false,
        &["low", "medium", "high"],
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

pub fn minimax_models() -> Vec<DevModel> {
    MINIMAX_MODELS
        .iter()
        .map(|(id, name, window, _max_tokens, vision, efforts)| DevModel {
            id: (*id).into(),
            name: (*name).into(),
            efforts: efforts
                .iter()
                .map(|id| DevEffort {
                    id: (*id).into(),
                    label: effort_label(id),
                })
                .collect(),
            context_window: Some(*window),
            context_windows: context_windows_for(id),
            provider: PROVIDER_MINIMAX.into(),
            capabilities: capabilities_for(*vision),
        })
        .collect()
}

fn context_windows_for(id: &str) -> Vec<u64> {
    if id.starts_with("MiniMax-M3") {
        vec![512_000, 1_000_000]
    } else {
        Vec::new()
    }
}

fn capabilities_for(vision: bool) -> Vec<String> {
    let mut caps = vec!["thinking".into(), "effort".into()];
    if vision {
        caps.insert(0, "vision".into());
    }
    caps
}

pub fn minimax_model(id: &str) -> Option<&'static (&'static str, &'static str, u64, u32, bool, &'static [&'static str])> {
    let id = id.trim();
    MINIMAX_MODELS.iter().find(|(row_id, ..)| *row_id == id)
}

/// A MiniMax text model. The prefix is case-sensitive, matching the API ids.
pub fn is_minimax_model(id: &str) -> bool {
    twanagent_service::minimax::is_minimax_model(id)
}

pub fn max_tokens_for(id: &str) -> u32 {
    let id = id.trim();
    if let Some(row) = minimax_model(id) {
        return row.3;
    }
    if is_minimax_model(id) {
        128_000
    } else {
        4_096
    }
}

pub fn context_window_for(id: &str) -> Option<u64> {
    minimax_model(id.trim()).map(|row| row.2)
}

/// `{base}/anthropic/v1/messages`. Empty base uses the global host.
pub fn messages_url(base_url: &str) -> String {
    twanagent_service::minimax::messages_url(base_url)
}

pub fn http_error_message(status: u16, body: &str) -> String {
    twanagent_service::minimax::http_error_message(status, body)
}

/// OpenAI-shaped messages become the Messages body `mmx text chat` sends.
/// Plan tools are omitted. Effort is not an Anthropic output_config field here.
pub fn to_minimax_body(
    messages: &serde_json::Value,
    model: &str,
    tools: &serde_json::Value,
) -> serde_json::Value {
    twanagent_service::minimax::to_minimax_body(messages, model, tools, max_tokens_for(model))
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
        path.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase()
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
    if let Some(base) = base_url.map(str::trim).filter(|item| item.starts_with("http")) {
        return base.trim_end_matches('/').to_string();
    }
    if let Some(base) = resource_url.map(str::trim).filter(|item| item.starts_with("http")) {
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
        let base = api_base(&fresh.region, config.base_url.as_deref(), fresh.resource_url.as_deref());
        return Some(MinimaxAuth {
            token: fresh.access_token,
            base_url: base,
            via_key: false,
        });
    }
    None
}

/// Login state for settings. Does not refresh and does not return the token.
/// `mmx --version` is a process spawn. A detected version is reused; a miss is tried again.
fn cached_mmx_version(bin: Option<&Path>) -> Option<String> {
    static VERSION: OnceLock<String> = OnceLock::new();
    if let Some(found) = VERSION.get() {
        return Some(found.clone());
    }
    let version = bin.and_then(mmx_version)?;
    let _ = VERSION.set(version.clone());
    Some(version)
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
        path: bin.map(|path| path.display().to_string()).unwrap_or_default(),
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
    let host = region_row(&oauth.region).map(|(_, _, account)| account).unwrap_or(REGIONS[0].2);
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
    let expires_at = expires_from_refresh(body.get("expired_in")).unwrap_or_else(|| previous.expires_at.clone());
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

/// One allowance window on the connected MiniMax account. `used_percent` is how much of the
/// window is spent, matching the Claude row. `mmx quota show` reports the remainder instead.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AccountUsageWindow {
    pub id: String,
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<String>,
}

/// Token-plan quota, or a pay-as-you-go balance when the login is an `sk-api-` key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AccountUsage {
    pub provider: String,
    pub connected: bool,
    pub label: String,
    pub windows: Vec<AccountUsageWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance_cents: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance_currency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credit_status: Option<String>,
    /// When this snapshot was fetched. The sidebar ignores a cache older than a few minutes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
}

fn empty_usage(connected: bool) -> AccountUsage {
    AccountUsage {
        provider: PROVIDER_MINIMAX.into(),
        connected,
        label: "MiniMax".into(),
        windows: Vec::new(),
        balance_cents: None,
        balance_currency: None,
        credit_status: None,
        fetched_at: Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
    }
}

/// `{base}/v1/token_plan/remains`, the endpoint `mmx quota show` reads.
pub fn quota_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let base = if base.is_empty() { REGIONS[0].1 } else { base };
    format!("{base}/v1/token_plan/remains")
}

/// `{base}/account/query_balance`. Only an `sk-api-` key can read this.
pub fn balance_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let base = if base.is_empty() { REGIONS[0].1 } else { base };
    format!("{base}/account/query_balance")
}

pub fn is_secret_api_key(token: &str) -> bool {
    token.trim().starts_with("sk-api-")
}

fn json_f64(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|n| n as f64))
        .or_else(|| value.as_u64().map(|n| n as f64))
        .filter(|n| n.is_finite())
}

/// Percent still left in one quota window, 0–100. This is what `mmx quota show` prints as Left.
/// A remaining percent wins. Counts are the fallback. A model the plan does not include is `None`.
fn remaining_percent(usage: f64, total: f64, remaining_percent: Option<f64>, status: Option<i64>) -> Option<f64> {
    if status == Some(3) && remaining_percent.is_none() && total <= 0.0 {
        return None;
    }
    if let Some(left) = remaining_percent.filter(|n| n.is_finite() && *n >= 0.0 && *n <= 100.0) {
        return Some(left);
    }
    if total <= 0.0 || usage < 0.0 {
        return None;
    }
    Some((100.0 - (usage / total * 100.0)).clamp(0.0, 100.0))
}

fn window_label(span_ms: i64, weekly: bool) -> &'static str {
    if weekly || span_ms >= 6 * 24 * 3_600_000 {
        return "Week";
    }
    if span_ms >= 20 * 3_600_000 {
        return "Day";
    }
    // A token-plan window is five hours. The live end stamp is a few seconds short of that.
    if span_ms >= 4 * 3_600_000 {
        return "5h";
    }
    if span_ms > 0 {
        return "Now";
    }
    if weekly { "Week" } else { "Now" }
}

fn reset_from_ms(end_ms: i64) -> Option<String> {
    if end_ms <= 1_000_000_000_000 {
        return None;
    }
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(end_ms)?;
    Some(dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn quota_window(id: &str, label: &str, used: f64, end_ms: i64) -> AccountUsageWindow {
    AccountUsageWindow {
        id: id.into(),
        label: label.into(),
        used_percent: used,
        resets_at: reset_from_ms(end_ms),
    }
}

/// `model_remains` rows from `GET /v1/token_plan/remains`.
/// The current window (5h on a token plan) and the week are separate bars.
/// `used_percent` here is percent left, matching `mmx quota show`. A model the plan excludes is skipped.
pub fn parse_quota(body: &str) -> Vec<AccountUsageWindow> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let Some(rows) = json.get("model_remains").and_then(|value| value.as_array()) else {
        return Vec::new();
    };
    let only = rows.len() == 1;
    let mut windows = Vec::new();
    for row in rows {
        let name = row
            .get("model_name")
            .and_then(|item| item.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .unwrap_or("plan");
        let interval_total = json_f64(row.get("current_interval_total_count").unwrap_or(&serde_json::Value::Null)).unwrap_or(0.0);
        let weekly_total = json_f64(row.get("current_weekly_total_count").unwrap_or(&serde_json::Value::Null)).unwrap_or(0.0);
        let interval_status = row.get("current_interval_status").and_then(|item| item.as_i64());
        let weekly_status = row.get("current_weekly_status").and_then(|item| item.as_i64());
        if interval_status == Some(3) && weekly_status == Some(3) && interval_total <= 0.0 && weekly_total <= 0.0 {
            continue;
        }
        let start = row.get("start_time").and_then(|item| item.as_i64()).unwrap_or(0);
        let end = row.get("end_time").and_then(|item| item.as_i64()).unwrap_or(0);
        let span = end.saturating_sub(start);
        let current_label = window_label(span, false);
        // One plan row is the account, so the bar says 5h instead of "general 5h".
        let label_name = if only { "" } else { name };
        if let Some(left) = remaining_percent(
            json_f64(row.get("current_interval_usage_count").unwrap_or(&serde_json::Value::Null)).unwrap_or(0.0),
            interval_total,
            row.get("current_interval_remaining_percent").and_then(json_f64),
            interval_status,
        ) {
            let label = if label_name.is_empty() {
                current_label.to_string()
            } else {
                format!("{label_name} {current_label}")
            };
            windows.push(quota_window(&format!("{name}:current"), &label, left, end));
        }
        let week_end = row.get("weekly_end_time").and_then(|item| item.as_i64()).unwrap_or(0);
        if let Some(left) = remaining_percent(
            json_f64(row.get("current_weekly_usage_count").unwrap_or(&serde_json::Value::Null)).unwrap_or(0.0),
            weekly_total,
            row.get("current_weekly_remaining_percent").and_then(json_f64),
            weekly_status,
        ) {
            let label = if label_name.is_empty() {
                "Week".to_string()
            } else {
                format!("{label_name} Week")
            };
            windows.push(quota_window(&format!("{name}:week"), &label, left, week_end));
        }
    }
    windows
}

/// `available_amount` on a pay-as-you-go login, in cents. A missing amount is not zero.
pub fn parse_balance(body: &str) -> Option<(i64, String)> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    let raw = json.get("available_amount")?.as_str().unwrap_or("").trim();
    if raw.is_empty() {
        return None;
    }
    let amount: f64 = raw.parse().ok()?;
    if !amount.is_finite() || amount < 0.0 {
        return None;
    }
    Some(((amount * 100.0).round() as i64, "USD".into()))
}

fn account_usage_cache_key() -> &'static str {
    PROVIDER_MINIMAX
}

/// The last snapshot written to the app database. Empty when this provider has never loaded.
pub fn cached_account_usage(data_dir: &std::path::Path) -> Option<AccountUsage> {
    let conn = crate::appdb::open(data_dir).ok()?;
    let raw = crate::appdb::get_account_usage(&conn, account_usage_cache_key()).ok()??;
    serde_json::from_str(&raw).ok()
}

/// A confirmed sign-out replaces the snapshot. A failed read does not, so one bad
/// poll cannot hide an account that was connected a moment ago.
fn store_account_usage(data_dir: &std::path::Path, usage: &AccountUsage) {
    let Ok(conn) = crate::appdb::open(data_dir) else {
        return;
    };
    if !usage.connected {
        let previous = crate::appdb::get_account_usage(&conn, account_usage_cache_key())
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<AccountUsage>(&raw).ok());
        if previous.as_ref().is_some_and(|row| row.connected) {
            return;
        }
    }
    let Ok(raw) = serde_json::to_string(usage) else {
        return;
    };
    let _ = crate::appdb::set_account_usage(&conn, account_usage_cache_key(), &raw);
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_minimax_account_usage_cached(state: tauri::State<'_, crate::state::AppState>) -> Option<AccountUsage> {
    cached_account_usage(&state.data_dir)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_minimax_account_usage(state: tauri::State<'_, crate::state::AppState>) -> Result<AccountUsage, String> {
    let data_dir = state.data_dir.clone();
    let usage = account_usage().await;
    store_account_usage(&data_dir, &usage);
    Ok(usage)
}

/// The connected MiniMax account. A token-plan login reports quota windows.
/// An `sk-api-` key reports the cash balance instead, unless it is also on a
/// plan — in that case the quota endpoint reports windows and they win, the
/// same way Claude's session usage shadows a prepaid balance. Both endpoints
/// accept `Bearer` and `x-api-key`, so the same code path covers either login.
pub async fn account_usage() -> AccountUsage {
    let Some(auth) = resolve_minimax_auth_fresh().await else {
        return empty_usage(false);
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut usage = empty_usage(true);
    if let Some(body) = minimax_get(&client, &quota_url(&auth.base_url), &auth.token).await {
        usage.windows = parse_quota(&body);
    }
    if is_secret_api_key(&auth.token) {
        if let Some((cents, currency)) = minimax_get(&client, &balance_url(&auth.base_url), &auth.token)
            .await
            .as_deref()
            .and_then(parse_balance)
        {
            usage.balance_cents = Some(cents);
            usage.balance_currency = Some(currency);
        }
    }
    usage
}

/// Quota accepts the `mmx` login as a bearer token. An API key is sent as `x-api-key`.
/// MiniMax answers login failures with HTTP 200 and `base_resp.status_code`, so both are tried.
async fn minimax_get(client: &reqwest::Client, url: &str, token: &str) -> Option<String> {
    let bearer = format!("Bearer {token}");
    let attempts = [("authorization", bearer.as_str()), ("x-api-key", token)];
    for (header, value) in attempts {
        let response = client
            .get(url)
            .header(header, value)
            .header("accept", "application/json")
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            continue;
        }
        let body = response.text().await.ok()?;
        if quota_body_ok(&body) {
            return Some(body);
        }
    }
    None
}

fn quota_body_ok(body: &str) -> bool {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    match json
        .get("base_resp")
        .and_then(|item| item.get("status_code"))
        .and_then(|item| item.as_i64())
    {
        Some(code) => code == 0,
        None => json.get("model_remains").is_some() || json.get("available_amount").is_some(),
    }
}

fn write_oauth(home: &Path, previous: &MmxConfig, oauth: &MmxOAuth) -> Result<(), String> {
    let path = config_path(home);
    let mut stored = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    let obj = stored.as_object_mut().ok_or_else(|| "config is not an object".to_string())?;
    let mut oauth_value = obj
        .get("oauth")
        .cloned()
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(row) = oauth_value.as_object_mut() {
        row.insert("access_token".into(), serde_json::Value::String(oauth.access_token.clone()));
        row.insert("refresh_token".into(), serde_json::Value::String(oauth.refresh_token.clone()));
        row.insert("expires_at".into(), serde_json::Value::String(oauth.expires_at.clone()));
        row.insert("region".into(), serde_json::Value::String(oauth.region.clone()));
        if let Some(url) = &oauth.resource_url {
            row.insert("resource_url".into(), serde_json::Value::String(url.clone()));
        }
    }
    obj.insert("oauth".into(), oauth_value);
    if !obj.contains_key("region") {
        obj.insert("region".into(), serde_json::Value::String(previous.region.clone()));
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
            &short, &[dir.path().to_string_lossy().into_owned()],
        );
        let found = which_in("twanagent-mmx-probe.cmd", &merged).expect("where finds the probe");
        // `where` prints the short 8.3 path. The temp directory is the long name.
        assert!(same_windows_path(&found, &bin), "{found:?} vs {bin:?}");
    }

    #[test]
    fn catalog_lists_the_text_models() {
        let rows = minimax_models();
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            [
                "MiniMax-M3",
                "MiniMax-M3.1-Flash-Preview",
                "MiniMax-M2.7",
                "MiniMax-M2.7-highspeed",
            ]
        );
        assert!(rows.iter().all(|row| row.provider == PROVIDER_MINIMAX));
        assert_eq!(rows[0].context_window, Some(512_000));
        assert_eq!(rows[0].context_windows, vec![512_000, 1_000_000]);
        assert!(rows[0].capabilities.iter().any(|cap| cap == "vision"));
        assert!(!rows[2].capabilities.iter().any(|cap| cap == "vision"));
        assert!(rows[2].context_windows.is_empty());
        assert_eq!(rows[2].context_window, Some(200_000));
    }

    #[test]
    fn matcher_claims_minimax_ids_only() {
        assert!(is_minimax_model("MiniMax-M3"));
        assert!(is_minimax_model(" MiniMax-M2.7 "));
        assert!(is_minimax_model("MiniMax-M3.1-Flash-Preview"));
        assert!(is_minimax_model("MiniMax-Future-1"));
        assert!(!is_minimax_model("minimax-m3"));
        assert!(!is_minimax_model("claude-sonnet-4-6"));
        assert!(!is_minimax_model("grok-4.6"));
        assert!(!is_minimax_model(""));
        assert!(!is_minimax_model("MiniMax-"));
    }

    #[test]
    fn messages_url_uses_the_saved_base() {
        assert_eq!(
            messages_url("https://api.minimax.io"),
            "https://api.minimax.io/anthropic/v1/messages"
        );
        assert_eq!(
            messages_url("https://api.minimax.cn/"),
            "https://api.minimax.cn/anthropic/v1/messages"
        );
        assert_eq!(
            messages_url(""),
            "https://api.minimax.io/anthropic/v1/messages"
        );
        assert_ne!(
            messages_url("https://api.minimax.io"),
            crate::grok_cli::endpoint(false)
        );
        assert_ne!(
            messages_url("https://api.minimax.io"),
            crate::anthropic::MESSAGES_URL
        );
    }

    #[test]
    fn body_is_messages_shaped_and_drops_plan_tools() {
        let tools = crate::dev::chat::tools_json_for(false, false);
        let body = to_minimax_body(
            &serde_json::json!([
                { "role": "system", "content": "You are MiniMax." },
                { "role": "user", "content": "hi" }
            ]),
            "MiniMax-M3",
            &tools,
        );
        assert_eq!(body["model"], "MiniMax-M3");
        assert_eq!(body["max_tokens"], 128_000);
        assert_eq!(body["stream"], true);
        assert_eq!(body["system"], "You are MiniMax.");
        assert!(body.get("output_config").is_none());
        assert_eq!(body["thinking"]["type"], "adaptive");
        let names: Vec<_> = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|row| row["name"].as_str())
            .collect();
        assert!(names.contains(&"read_file"));
        assert!(names.contains(&"grep"));
        assert!(names.contains(&"glob"));
        assert!(!names.iter().any(|name| name.contains("plan")));
        assert_eq!(max_tokens_for("MiniMax-M2.7"), 128_000);
        assert_eq!(context_window_for("MiniMax-M2.7"), Some(200_000));
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
        assert_eq!(oauth.resource_url.as_deref(), Some("https://api.minimax.io"));
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

    #[test]
    fn quota_turns_remaining_counts_into_used_windows() {
        let body = r#"{
            "model_remains": [
                {
                    "model_name": "MiniMax-M3",
                    "start_time": 1780000000000,
                    "end_time": 1780018000000,
                    "current_interval_total_count": 1000,
                    "current_interval_usage_count": 250,
                    "current_interval_remaining_percent": 75,
                    "current_weekly_total_count": 5000,
                    "current_weekly_usage_count": 1000,
                    "weekly_end_time": 1780604800000
                },
                {
                    "model_name": "video",
                    "current_interval_total_count": 0,
                    "current_weekly_total_count": 0,
                    "current_interval_status": 3,
                    "current_weekly_status": 3
                }
            ]
        }"#;
        let windows = parse_quota(body);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].id, "MiniMax-M3:current");
        assert_eq!(windows[0].label, "MiniMax-M3 5h");
        assert!((windows[0].used_percent - 75.0).abs() < 0.01);
        assert!(windows[0].resets_at.is_some());
        assert_eq!(windows[1].label, "MiniMax-M3 Week");
        assert!((windows[1].used_percent - 80.0).abs() < 0.01);
        let general = r#"{"base_resp":{"status_code":0},"model_remains":[{"model_name":"general","start_time":1791695116008,"end_time":1791713116008,"current_interval_total_count":0,"current_interval_usage_count":0,"current_interval_remaining_percent":99,"current_interval_status":1,"current_weekly_total_count":0,"current_weekly_usage_count":0,"current_weekly_remaining_percent":99,"current_weekly_status":1,"weekly_end_time":1792263899676}]}"#;
        let live = parse_quota(general);
        assert_eq!(live.iter().map(|row| row.label.as_str()).collect::<Vec<_>>(), ["5h", "Week"]);
        assert!((live[0].used_percent - 99.0).abs() < 0.01);
        assert!((live[1].used_percent - 99.0).abs() < 0.01);
        assert!(!quota_body_ok(r#"{"base_resp":{"status_code":1004,"status_msg":"login fail"}}"#));
        assert!(quota_body_ok(general));
        assert!(parse_quota("nope").is_empty());
        assert!(parse_quota(r#"{"model_remains":[]}"#).is_empty());
        assert_eq!(
            parse_balance(r#"{"available_amount":"12.50","cash_balance":"12.50"}"#),
            Some((1250, "USD".into()))
        );
        assert_eq!(parse_balance(r#"{"cash_balance":"1"}"#), None);
        assert!(is_secret_api_key("sk-api-secret"));
        assert!(!is_secret_api_key("oat-token"));
        assert_eq!(
            quota_url("https://api.minimax.io"),
            "https://api.minimax.io/v1/token_plan/remains"
        );
    }

    #[test]
    fn key_error_does_not_mention_xai() {
        assert_eq!(http_error_message(401, "nope"), KEY_REJECTED);
        let other = http_error_message(400, "bad model");
        assert!(other.starts_with("MiniMax error 400:"));
        assert!(SIGN_IN_ERROR.contains("mmx auth login"));
    }

    #[test]
    fn quota_and_balance_combine_for_an_api_key_on_a_plan() {
        // Quota endpoint returns windows for an `sk-api-` key too. The frontend
        // shows bars when windows exist, falling back to the balance only when
        // the plan endpoint has nothing to say.
        let quota_body = r#"{"base_resp":{"status_code":0},"model_remains":[{"model_name":"general","start_time":1791695116008,"end_time":1791713116008,"current_interval_total_count":0,"current_interval_usage_count":0,"current_interval_remaining_percent":62,"current_interval_status":1,"current_weekly_total_count":0,"current_weekly_usage_count":0,"current_weekly_remaining_percent":41,"current_weekly_status":1,"weekly_end_time":1792263899676}]}"#;
        let quota = parse_quota(quota_body);
        assert_eq!(quota.len(), 2);
        assert!((quota[0].used_percent - 62.0).abs() < 0.01);
        assert!((quota[1].used_percent - 41.0).abs() < 0.01);
        let balance_body = r#"{"available_amount":"24.96","cash_balance":"24.96"}"#;
        assert_eq!(parse_balance(balance_body), Some((2496, "USD".into())));
        // A pay-as-you-go key without a plan keeps the dollar amount.
        assert!(parse_quota(r#"{"model_remains":[]}"#).is_empty());
        assert_eq!(parse_balance(balance_body), Some((2496, "USD".into())));
    }
}
