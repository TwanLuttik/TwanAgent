use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::grok_cli::{effort_label, parse_cli_version, DevEffort, DevModel};
use crate::model_providers::event::{
    apply_thinking, apply_tool, finished_thinking as shared_finished_thinking, finished_tools as shared_finished_tools,
    merge_usage as merge_stream_usage, ThinkingBlock, StreamPiece,
};

pub const PROVIDER_ANTHROPIC: &str = "anthropic";

/// One picker row per Claude family. Current lineup first, then the previous
/// generation, so a short models-API page cannot hide the rest.
/// Context windows and output caps follow Anthropic's model overview.
const CLAUDE_MODELS: &[(&str, &str, u64, u32, &[&str])] = &[
    (
        "claude-fable-5-1",
        "Claude Fable 5.1",
        1_000_000,
        128_000,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "claude-opus-5-5",
        "Claude Opus 5.5",
        1_000_000,
        128_000,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "claude-sonnet-5-5",
        "Claude Sonnet 5.5",
        1_000_000,
        128_000,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "claude-haiku-5-5",
        "Claude Haiku 5.5",
        1_000_000,
        128_000,
        &["low", "medium", "high"],
    ),
    (
        "claude-opus-4-8",
        "Claude Opus 4.8",
        1_000_000,
        128_000,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "claude-opus-4-7",
        "Claude Opus 4.7",
        1_000_000,
        128_000,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "claude-opus-4-6",
        "Claude Opus 4.6",
        1_000_000,
        128_000,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "claude-sonnet-4-6",
        "Claude Sonnet 4.6",
        1_000_000,
        64_000,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "claude-sonnet-4-5",
        "Claude Sonnet 4.5",
        200_000,
        64_000,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "claude-haiku-4-5",
        "Claude Haiku 4.5",
        200_000,
        64_000,
        &["low", "medium", "high"],
    ),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Xai,
    Anthropic,
}

fn efforts_for(ids: &[&str]) -> Vec<DevEffort> {
    ids.iter()
        .map(|id| DevEffort {
            id: (*id).into(),
            label: effort_label(id),
        })
        .collect()
}

pub fn claude_models() -> Vec<DevModel> {
    CLAUDE_MODELS
        .iter()
        .map(|(id, name, window, _max_tokens, efforts)| DevModel {
            id: (*id).into(),
            name: (*name).into(),
            efforts: efforts_for(efforts),
            context_window: Some(*window),
            context_windows: Vec::new(),
            provider: PROVIDER_ANTHROPIC.into(),
            capabilities: bundled_capabilities(id),
        })
        .collect()
}

pub fn claude_model(id: &str) -> Option<&'static (&'static str, &'static str, u64, u32, &'static [&'static str])> {
    let id = id.trim();
    CLAUDE_MODELS.iter().find(|(row_id, ..)| *row_id == id)
}

/// A chat model id from Anthropic. Dated snapshots (`claude-sonnet-4-5-20250929`) count.
/// Grok's side-by-side tutor ids (`sxs-claude-…`) do not.
pub fn is_claude_model(id: &str) -> bool {
    let id = id.trim();
    if claude_model(id).is_some() {
        return true;
    }
    let rest = id.strip_prefix("claude-").unwrap_or("");
    if rest.is_empty() {
        return false;
    }
    rest.chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.')
}

pub fn provider_for(id: &str) -> Provider {
    if is_claude_model(id) {
        Provider::Anthropic
    } else {
        Provider::Xai
    }
}

/// Output cap for the Messages API. Not the context window.
pub fn max_tokens_for(id: &str) -> u32 {
    let id = id.trim();
    if let Some(row) = claude_model(id) {
        return row.3;
    }
    let family = id.strip_suffix("-latest").unwrap_or(id);
    if let Some(row) = claude_model(family) {
        return row.3;
    }
    if id.contains("haiku") && !id.contains("haiku-5") {
        64_000
    } else if is_claude_model(id) {
        128_000
    } else {
        16_000
    }
}

/// Opus and Sonnet use adaptive thinking. Haiku keeps a fixed budget.
pub fn supports_adaptive_thinking(id: &str) -> bool {
    let id = id.trim();
    is_claude_model(id) && !id.contains("haiku")
}

/// Manual thinking budget for a model that cannot use adaptive thinking.
/// Must stay below the output cap. `None` means send no thinking field.
pub fn manual_thinking_budget(id: &str, effort: Option<&str>) -> Option<u32> {
    if supports_adaptive_thinking(id) {
        return None;
    }
    let effort = effort.map(str::trim).filter(|value| !value.is_empty())?;
    let cap = max_tokens_for(id);
    let budget = match effort {
        "low" => 1_024,
        "medium" => 4_096,
        "high" | "xhigh" | "max" => 8_192,
        _ => return None,
    };
    Some(budget.min(cap.saturating_sub(1)).max(1_024).min(cap.saturating_sub(1)))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClaudeCliInfo {
    pub installed: bool,
    pub path: String,
    pub version: Option<String>,
    pub logged_in: bool,
    pub email: Option<String>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn which(name: &str) -> Option<PathBuf> {
    which_in(name, &crate::env_path::command_path())
}

/// `which` against an explicit PATH. A Dock-launched app does not inherit the shell PATH.
fn which_in(name: &str, path: &str) -> Option<PathBuf> {
    let cmd = if cfg!(windows) { "where" } else { "which" };
    let mut command = Command::new(cmd);
    command.arg(name);
    #[cfg(unix)]
    command.env("PATH", path);
    #[cfg(not(unix))]
    let _ = path;
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
    let out = Command::new(bin).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?.trim();
    parse_cli_version(line)
}

fn account_email(value: &serde_json::Value) -> Option<String> {
    for key in ["email", "emailAddress", "primaryEmail"] {
        if let Some(email) = value.get(key).and_then(|v| v.as_str()) {
            let email = email.trim();
            if email.contains('@') {
                return Some(email.to_string());
            }
        }
    }
    None
}

/// A Claude login leaves credentials in `~/.claude` or the macOS keychain. The email is optional.
pub fn read_claude_account(home: &Path) -> Option<(bool, Option<String>)> {
    read_claude_account_with(home, keychain_credentials)
}

pub fn read_claude_account_with(
    home: &Path,
    keychain: impl Fn() -> Option<String>,
) -> Option<(bool, Option<String>)> {
    let claude = home.join(".claude");
    let creds = claude.join(".credentials.json");
    if creds.is_file() {
        let raw = fs::read_to_string(&creds).unwrap_or_default();
        if let Some(found) = oauth_login(&raw) {
            return Some(found);
        }
    }
    for path in [home.join(".claude.json"), claude.join(".claude.json")] {
        let Ok(config) = fs::read_to_string(path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&config) else {
            continue;
        };
        if let Some(oauth) = value.get("oauthAccount").filter(|item| !item.is_null()) {
            return Some((true, account_email(oauth)));
        }
    }
    keychain().and_then(|raw| oauth_login(&raw))
}

fn oauth_access_token(raw: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let oauth = value.get("claudeAiOauth").filter(|item| !item.is_null())?;
    let token = oauth
        .get("accessToken")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|token| !token.is_empty())?;
    if token_expired(oauth.get("expiresAt").and_then(|item| item.as_i64())) {
        return None;
    }
    Some(token.to_string())
}

fn oauth_login(raw: &str) -> Option<(bool, Option<String>)> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let token = oauth_access_token(raw)?;
    let oauth = value.get("claudeAiOauth")?;
    let _ = token;
    Some((true, account_email(oauth).or_else(|| account_email(&value))))
}

/// Current Claude Code builds keep the OAuth token in the login keychain, not on disk.
fn keychain_credentials() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("security")
            .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if raw.is_empty() {
            return None;
        }
        return Some(raw);
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeAuth {
    pub token: String,
    pub via_cli: bool,
}

/// Saved API key first, then the same Claude CLI login the settings screen shows as signed in.
/// The token is not returned to the UI. An expired CLI token is not refreshed here.
pub fn resolve_claude_auth() -> Option<ClaudeAuth> {
    resolve_claude_auth_with(false)
}

/// Like `resolve_claude_auth`, but renews the CLI OAuth token when it is near expiry.
pub async fn resolve_claude_auth_fresh() -> Option<ClaudeAuth> {
    if let Some(auth) = resolve_claude_auth_with(false) {
        if !auth.via_cli {
            return Some(auth);
        }
    }
    let home = home_dir()?;
    let token = read_cli_access_token_fresh(&home).await?;
    Some(ClaudeAuth {
        token,
        via_cli: true,
    })
}

fn resolve_claude_auth_with(allow_expired_cli: bool) -> Option<ClaudeAuth> {
    if let Some(key) = crate::secrets::resolve_anthropic_key_on_disk() {
        return Some(ClaudeAuth {
            token: key,
            via_cli: false,
        });
    }
    let home = home_dir()?;
    if let Some(token) = read_claude_access_token(&home) {
        return Some(ClaudeAuth {
            token,
            via_cli: true,
        });
    }
    if !allow_expired_cli {
        return None;
    }
    let (token, _) = cli_access_token(&home, true)?;
    Some(ClaudeAuth {
        token,
        via_cli: true,
    })
}

/// The login the settings screen counts as signed in. Keychain first, then the credentials file.
pub fn read_claude_access_token(home: &Path) -> Option<String> {
    read_claude_access_token_with(home, keychain_credentials)
}

pub fn read_claude_access_token_with(
    home: &Path,
    keychain: impl Fn() -> Option<String>,
) -> Option<String> {
    if let Some(raw) = keychain() {
        if let Some(token) = oauth_access_token(&raw) {
            return Some(token);
        }
    }
    let creds = home.join(".claude").join(".credentials.json");
    if let Ok(raw) = fs::read_to_string(creds) {
        if let Some(token) = oauth_access_token(&raw) {
            return Some(token);
        }
    }
    read_cli_access_token(home)
}

pub fn read_cli_access_token(home: &Path) -> Option<String> {
    cli_access_token(home, false).map(|(token, _)| token)
}

/// The Claude CLI login. When `refresh` is set, an expired access token is renewed and written back.
pub async fn read_cli_access_token_fresh(home: &Path) -> Option<String> {
    let (token, expired) = cli_access_token(home, true)?;
    if !expired {
        return Some(token);
    }
    let path = cli_credentials_path(home);
    let raw = fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let refresh = value
        .get("refresh_token")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())?
        .to_string();
    refresh_cli_credentials(&path, &refresh).await
}

/// `(token, needs_refresh)`. An expired token is still returned when `allow_expired` is set so the caller can refresh it.
fn cli_access_token(home: &Path, allow_expired: bool) -> Option<(String, bool)> {
    let raw = fs::read_to_string(cli_credentials_path(home)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let token = access_token_of(&value)?;
    let expired = token_needs_refresh(value.get("expires_at").and_then(|item| item.as_i64()));
    if expired && !allow_expired {
        return None;
    }
    Some((token, expired))
}

fn cli_credentials_path(home: &Path) -> PathBuf {
    home.join(".config")
        .join("anthropic")
        .join("credentials")
        .join("default.json")
}

fn access_token_of(value: &serde_json::Value) -> Option<String> {
    value
        .get("access_token")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

/// Refresh a few minutes early so a send does not race the expiry.
fn token_needs_refresh(expires_at: Option<i64>) -> bool {
    let Some(expires_at) = expires_at.filter(|value| *value > 0) else {
        return false;
    };
    let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return false;
    };
    let expires_ms = if expires_at < 10_000_000_000 {
        expires_at.saturating_mul(1000)
    } else {
        expires_at
    };
    expires_ms <= now.as_millis() as i64 + 5 * 60 * 1000
}

/// Same login the Claude CLI reports as `oauth_token`. The refresh token rotates, so the file is rewritten.
async fn refresh_cli_credentials(path: &Path, refresh_token: &str) -> Option<String> {
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CLAUDE_OAUTH_CLIENT_ID,
    });
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .ok()?
        .post(CLAUDE_OAUTH_TOKEN_URL)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .json(&body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let fresh: serde_json::Value = response.json().await.ok()?;
    let access = access_token_of(&fresh)?;
    let mut stored = serde_json::from_str::<serde_json::Value>(&fs::read_to_string(path).ok()?).ok()?;
    let obj = stored.as_object_mut()?;
    obj.insert("access_token".into(), serde_json::Value::String(access.clone()));
    if let Some(next) = fresh.get("refresh_token").and_then(|item| item.as_str()) {
        if !next.trim().is_empty() {
            obj.insert("refresh_token".into(), serde_json::Value::String(next.to_string()));
        }
    }
    if let Some(expires_at) = fresh.get("expires_at").and_then(|item| item.as_i64()) {
        obj.insert("expires_at".into(), serde_json::Value::from(expires_at));
    } else if let Some(expires_in) = fresh.get("expires_in").and_then(|item| item.as_i64()) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs() as i64;
        obj.insert("expires_at".into(), serde_json::Value::from(now.saturating_add(expires_in)));
    }
    let text = serde_json::to_string_pretty(&stored).ok()?;
    fs::write(path, text).ok()?;
    Some(access)
}

/// Claude writes `expires_at` as unix seconds. Older payloads used milliseconds.
fn token_expired(expires_at: Option<i64>) -> bool {
    let Some(expires_at) = expires_at.filter(|value| *value > 0) else {
        return false;
    };
    let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return false;
    };
    let expires_ms = if expires_at < 10_000_000_000 {
        expires_at.saturating_mul(1000)
    } else {
        expires_at
    };
    expires_ms <= now.as_millis() as i64
}

/// Turn one page of `GET /v1/models` into picker rows.
/// Retired models and non-Claude ids are dropped. A known catalog row supplies thinking
/// levels when the same id is listed; anything else gets the line default.
pub fn parse_models_page(body: &str) -> (Vec<DevModel>, Option<String>, bool) {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return (Vec::new(), None, false);
    };
    let Some(rows) = json.get("data").and_then(|value| value.as_array()) else {
        return (Vec::new(), None, false);
    };
    let mut models = Vec::new();
    for row in rows {
        if row.get("type").and_then(|value| value.as_str()) == Some("model")
            && row.get("lifecycle").and_then(|value| value.as_str()) == Some("retired")
        {
            continue;
        }
        let Some(id) = row.get("id").and_then(|value| value.as_str()).map(str::trim) else {
            continue;
        };
        if !is_claude_model(id) || models.iter().any(|model: &DevModel| model.id == id) {
            continue;
        }
        let known = claude_model(id);
        let name = row
            .get("display_name")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| known.map(|row| (*row.1).to_string()).unwrap_or_else(|| id.to_string()));
        let window = row
            .get("max_input_tokens")
            .and_then(|value| value.as_u64())
            .filter(|value| *value > 0)
            .or_else(|| known.map(|row| row.2));
        let efforts = effort_levels(row.get("capabilities").and_then(|value| value.get("effort")))
            .map(|levels| efforts_for(&levels))
            .or_else(|| known.map(|row| efforts_for(row.4)))
            .unwrap_or_else(|| efforts_for(efforts_for_line(id)));
        models.push(DevModel {
            id: id.to_string(),
            name,
            efforts,
            context_window: window,
            context_windows: Vec::new(),
            provider: PROVIDER_ANTHROPIC.into(),
            capabilities: model_capabilities(row.get("capabilities"), known.is_some()),
        });
    }
    let has_more = json.get("has_more").and_then(|value| value.as_bool()).unwrap_or(false);
    let last_id = json
        .get("last_id")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    (models, last_id, has_more)
}

fn bundled_capabilities(id: &str) -> Vec<String> {
    let mut caps = vec!["vision".to_string(), "pdf".to_string(), "effort".to_string()];
    if supports_adaptive_thinking(id) || manual_thinking_budget(id, Some("high")).is_some() {
        caps.insert(1, "thinking".to_string());
    }
    caps
}

fn supported(value: Option<&serde_json::Value>) -> bool {
    value
        .and_then(|item| item.get("supported"))
        .and_then(|item| item.as_bool())
        .unwrap_or(false)
}

fn model_capabilities(caps: Option<&serde_json::Value>, known: bool) -> Vec<String> {
    let Some(caps) = caps else {
        return if known { vec!["vision".into(), "thinking".into(), "pdf".into(), "effort".into()] } else { Vec::new() };
    };
    let mut out = Vec::new();
    if supported(caps.get("image_input")) {
        out.push("vision".into());
    }
    if supported(caps.get("thinking")) {
        out.push("thinking".into());
    }
    if supported(caps.get("pdf_input")) {
        out.push("pdf".into());
    }
    if supported(caps.get("effort")) {
        out.push("effort".into());
    }
    out
}

/// Effort levels the model actually offers, in picker order. `None` when the field is absent.
fn effort_levels(effort: Option<&serde_json::Value>) -> Option<Vec<&str>> {
    let effort = effort?;
    const ORDER: &[&str] = &["low", "medium", "high", "xhigh", "max"];
    let levels = ORDER
        .iter()
        .copied()
        .filter(|id| supported(effort.get(*id)))
        .collect::<Vec<_>>();
    if levels.is_empty() { None } else { Some(levels) }
}

fn efforts_for_line(id: &str) -> &'static [&'static str] {
    if id.contains("haiku") {
        &["low", "medium", "high"]
    } else {
        &["low", "medium", "high", "xhigh", "max"]
    }
}

/// Models this account can call.
/// The catalog is the picker. A live page fills in display names, windows, and effort
/// for ids it returns, including dated snapshots, but it never hides a catalog family
/// that the page left out.
pub async fn available_models(auth: &ClaudeAuth) -> Vec<DevModel> {
    let client = reqwest::Client::builder()
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut after: Option<String> = None;
    let mut out = Vec::new();
    for _ in 0..5 {
        let mut req = client
            .get(MODELS_URL)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .query(&[("limit", "100")]);
        if let Some(cursor) = after.as_deref() {
            req = req.query(&[("after_id", cursor)]);
        }
        req = if auth.via_cli {
            req.bearer_auth(&auth.token)
        } else {
            req.header("x-api-key", &auth.token)
        };
        let Ok(resp) = req.send().await else {
            break;
        };
        if !resp.status().is_success() {
            break;
        }
        let Ok(body) = resp.text().await else {
            break;
        };
        let (page, last_id, has_more) = parse_models_page(&body);
        if page.is_empty() && out.is_empty() {
            break;
        }
        for model in page {
            if !out.iter().any(|row: &DevModel| row.id == model.id) {
                out.push(model);
            }
        }
        if !has_more {
            break;
        }
        let Some(cursor) = last_id else {
            break;
        };
        after = Some(cursor);
    }
    merge_catalog(out)
}

/// Keep every catalog family, in catalog order. Live rows overlay the same id and
/// dated snapshots (`claude-sonnet-4-5-20250929`) follow their family.
fn merge_catalog(live: Vec<DevModel>) -> Vec<DevModel> {
    let mut used = vec![false; live.len()];
    let mut out = Vec::with_capacity(CLAUDE_MODELS.len() + live.len());
    for (id, name, window, _max_tokens, efforts) in CLAUDE_MODELS {
        let mut row = DevModel {
            id: (*id).into(),
            name: (*name).into(),
            efforts: efforts_for(efforts),
            context_window: Some(*window),
            context_windows: Vec::new(),
            provider: PROVIDER_ANTHROPIC.into(),
            capabilities: bundled_capabilities(id),
        };
        if let Some(index) = live.iter().position(|item| item.id == *id) {
            row = overlay_catalog(row, &live[index]);
            used[index] = true;
        }
        out.push(row);
        let prefix = format!("{id}-");
        for (index, item) in live.iter().enumerate() {
            if used[index] || !item.id.starts_with(&prefix) {
                continue;
            }
            used[index] = true;
            out.push(item.clone());
        }
    }
    for (index, item) in live.into_iter().enumerate() {
        if !used[index] {
            out.push(item);
        }
    }
    out
}

fn overlay_catalog(catalog: DevModel, live: &DevModel) -> DevModel {
    DevModel {
        id: catalog.id,
        name: if live.name.trim().is_empty() {
            catalog.name
        } else {
            live.name.clone()
        },
        efforts: if live.efforts.is_empty() {
            catalog.efforts
        } else {
            live.efforts.clone()
        },
        context_window: live.context_window.or(catalog.context_window),
        context_windows: live.context_windows.clone(),
        provider: PROVIDER_ANTHROPIC.into(),
        capabilities: if live.capabilities.is_empty() {
            catalog.capabilities
        } else {
            live.capabilities.clone()
        },
    }
}

pub fn claude_cli_info() -> ClaudeCliInfo {
    let bin = claude_bin();
    let version = bin.as_ref().and_then(|path| claude_version(path));
    let account = home_dir().and_then(|home| read_claude_account(&home));
    ClaudeCliInfo {
        installed: bin.is_some(),
        path: bin.map(|path| path.display().to_string()).unwrap_or_default(),
        version,
        logged_in: account.as_ref().map(|row| row.0).unwrap_or(false),
        email: account.and_then(|row| row.1),
    }
}

pub const CLAUDE_OAUTH_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
pub const CLAUDE_OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
pub const MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
pub const MODELS_URL: &str = "https://api.anthropic.com/v1/models";
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
pub const SIGN_IN_ERROR: &str =
    "Claude isn’t signed in. Run claude login, or add an Anthropic API key in Settings.";
pub const KEY_REJECTED: &str = "Anthropic rejected the API key.";

/// OpenAI-shaped chat messages become a Messages API body. No I/O.
pub fn to_messages_body(
    messages: &serde_json::Value,
    model: &str,
    effort: Option<&str>,
    tools: &serde_json::Value,
) -> serde_json::Value {
    let rows = messages.as_array().cloned().unwrap_or_default();
    let mut system = String::new();
    let mut out: Vec<serde_json::Value> = Vec::new();
    for msg in rows {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
        if role == "system" {
            let text = content_string(msg.get("content"));
            if text.is_empty() {
                continue;
            }
            if !system.is_empty() {
                system.push_str("\n\n");
            }
            system.push_str(&text);
            continue;
        }
        if role == "tool" {
            let block = serde_json::json!({
                "type": "tool_result",
                "tool_use_id": msg.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or(""),
                "content": content_string(msg.get("content")),
            });
            if let Some(last) = out.last_mut() {
                if last.get("role").and_then(|v| v.as_str()) == Some("user") {
                    if let Some(content) = last.get_mut("content").and_then(|v| v.as_array_mut()) {
                        content.push(block);
                        continue;
                    }
                }
            }
            out.push(serde_json::json!({ "role": "user", "content": [block] }));
            continue;
        }
        if role == "assistant" {
            let mut blocks = Vec::new();
            blocks.extend(replay_thinking(msg.get("thinking")));
            let text = content_string(msg.get("content"));
            if !text.trim().is_empty() {
                blocks.push(serde_json::json!({ "type": "text", "text": text }));
            }
            if let Some(calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
                for call in calls {
                    let name = call
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if name.is_empty() {
                        continue;
                    }
                    let arguments = call
                        .get("function")
                        .and_then(|f| f.get("arguments"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    blocks.push(serde_json::json!({
                        "type": "tool_use",
                        "id": call.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                        "name": name,
                        "input": tool_input(arguments),
                    }));
                }
            }
            if blocks.is_empty() {
                continue;
            }
            out.push(serde_json::json!({ "role": "assistant", "content": blocks }));
            continue;
        }
        let blocks = user_blocks(msg.get("content"));
        if blocks.is_empty() {
            continue;
        }
        out.push(serde_json::json!({ "role": "user", "content": blocks }));
    }
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens_for(model),
        "stream": true,
        "messages": out,
        "tools": reshape_tools(tools),
        "tool_choice": { "type": "auto" },
    });
    if supports_adaptive_thinking(model) {
        body["thinking"] = serde_json::json!({ "type": "adaptive" });
    } else if let Some(budget) = manual_thinking_budget(model, effort) {
        body["thinking"] = serde_json::json!({ "type": "enabled", "budget_tokens": budget });
    }
    if !system.is_empty() {
        body["system"] = serde_json::Value::String(system);
    }
    if supports_adaptive_thinking(model) {
        if let Some(effort) = effort.map(str::trim).filter(|s| !s.is_empty()) {
            body["output_config"] = serde_json::json!({ "effort": effort });
        }
    }
    body
}

/// Signed thinking must lead the assistant content, unchanged, before text and tools.
fn replay_thinking(value: Option<&serde_json::Value>) -> Vec<serde_json::Value> {
    let Some(rows) = value.and_then(|item| item.as_array()) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|block| {
            let kind = block.get("type").and_then(|item| item.as_str()).unwrap_or("");
            match kind {
                "thinking" => {
                    let signature = block.get("signature").and_then(|item| item.as_str()).unwrap_or("");
                    if signature.is_empty() {
                        return None;
                    }
                    Some(serde_json::json!({
                        "type": "thinking",
                        "thinking": block.get("thinking").and_then(|item| item.as_str()).unwrap_or(""),
                        "signature": signature,
                    }))
                }
                "redacted_thinking" => {
                    let data = block.get("data").and_then(|item| item.as_str()).unwrap_or("");
                    if data.is_empty() {
                        return None;
                    }
                    Some(serde_json::json!({
                        "type": "redacted_thinking",
                        "data": data,
                    }))
                }
                _ => None,
            }
        })
        .collect()
}

fn reshape_tools(tools: &serde_json::Value) -> Vec<serde_json::Value> {
    let Some(rows) = tools.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|tool| {
            let function = tool.get("function").unwrap_or(tool);
            let name = function.get("name").and_then(|v| v.as_str())?;
            if name.is_empty() {
                return None;
            }
            let mut row = serde_json::json!({
                "name": name,
                "input_schema": function.get("parameters").cloned().unwrap_or_else(|| serde_json::json!({
                    "type": "object",
                    "properties": {}
                })),
            });
            if let Some(description) = function.get("description").and_then(|v| v.as_str()) {
                if !description.is_empty() {
                    row["description"] = serde_json::Value::String(description.to_string());
                }
            }
            Some(row)
        })
        .collect()
}

fn content_string(value: Option<&serde_json::Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    if value.is_null() {
        return String::new();
    }
    let Some(parts) = value.as_array() else {
        return String::new();
    };
    let mut out = String::new();
    for part in parts {
        if let Some(text) = part.as_str() {
            out.push_str(text);
            continue;
        }
        if part.get("type").and_then(|v| v.as_str()) == Some("text") {
            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                out.push_str(text);
            }
        }
    }
    out
}

fn user_blocks(value: Option<&serde_json::Value>) -> Vec<serde_json::Value> {
    let Some(value) = value else {
        return Vec::new();
    };
    if let Some(text) = value.as_str() {
        if text.is_empty() {
            return Vec::new();
        }
        return vec![serde_json::json!({ "type": "text", "text": text })];
    }
    let Some(parts) = value.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for part in parts {
        let kind = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if kind == "text" {
            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                if !text.is_empty() {
                    out.push(serde_json::json!({ "type": "text", "text": text }));
                }
            }
            continue;
        }
        if kind == "image_url" {
            let url = part
                .get("image_url")
                .and_then(|v| v.get("url"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if let Some(image) = image_block(url) {
                out.push(image);
            }
        }
    }
    out
}

fn image_block(url: &str) -> Option<serde_json::Value> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(",")?;
    if !meta.contains(";base64") || data.is_empty() {
        return None;
    }
    let media_type = meta.split(';').next().unwrap_or("").trim();
    if media_type.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": data,
        }
    }))
}

fn tool_input(arguments: &str) -> serde_json::Value {
    let trimmed = arguments.trim();
    if trimmed.is_empty() {
        return serde_json::json!({});
    }
    match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(value) if value.is_object() => value,
        _ => serde_json::json!({ "raw": arguments }),
    }
}

pub fn http_error_message(status: u16, body: &str) -> String {
    if status == 401 {
        return KEY_REJECTED.into();
    }
    format!(
        "Anthropic error {status}: {}",
        body.chars().take(400).collect::<String>()
    )
}

pub type SsePiece = StreamPiece;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ThinkingAccum {
    inner: crate::model_providers::event::ThinkingAccum,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ToolAccum {
    inner: crate::model_providers::event::ToolAccum,
}

/// One Anthropic SSE `data:` payload. Event names are ignored; the JSON `type` is enough.
pub fn parse_sse_data(data: &str) -> Option<StreamPiece> {
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    let json: serde_json::Value = serde_json::from_str(data).ok()?;
    match json.get("type").and_then(|v| v.as_str())? {
        "content_block_start" => {
            let index = json.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let block = json.get("content_block")?;
            match block.get("type").and_then(|v| v.as_str())? {
                "tool_use" => Some(StreamPiece::ToolStart {
                    index,
                    id: block
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    name: block
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                }),
                "thinking" => Some(StreamPiece::ThinkingStart { index }),
                "redacted_thinking" => Some(StreamPiece::RedactedThinking {
                    index,
                    data: block
                        .get("data")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                }),
                _ => None,
            }
        }
        "content_block_delta" => {
            let index = json.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let delta = json.get("delta")?;
            match delta.get("type").and_then(|v| v.as_str())? {
                "text_delta" => {
                    let text = delta.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    if text.is_empty() {
                        None
                    } else {
                        Some(StreamPiece::Delta(text.to_string()))
                    }
                }
                "thinking_delta" => {
                    let text = delta.get("thinking").and_then(|v| v.as_str()).unwrap_or("");
                    if text.is_empty() {
                        None
                    } else {
                        Some(StreamPiece::Reasoning(text.to_string()))
                    }
                }
                "signature_delta" => {
                    let signature = delta.get("signature").and_then(|v| v.as_str()).unwrap_or("");
                    if signature.is_empty() {
                        None
                    } else {
                        Some(StreamPiece::ThinkingSignature {
                            index,
                            signature: signature.to_string(),
                        })
                    }
                }
                "input_json_delta" => Some(StreamPiece::ToolDelta {
                    index,
                    partial: delta
                        .get("partial_json")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                }),
                _ => None,
            }
        }
        "message_start" => usage_piece(json.get("message").and_then(|m| m.get("usage"))),
        "message_delta" => usage_piece(json.get("usage")),
        "message_stop" => Some(StreamPiece::Stop),
        _ => None,
    }
}

fn usage_piece(usage: Option<&serde_json::Value>) -> Option<SsePiece> {
    let usage = usage?;
    let prompt = usage.get("input_tokens").and_then(|v| v.as_u64());
    let completion = usage.get("output_tokens").and_then(|v| v.as_u64());
    // message_delta often carries only output_tokens. None means "keep the previous count".
    if prompt.is_none() && completion.is_none() {
        return None;
    }
    Some(StreamPiece::Usage {
        prompt_tokens: prompt.unwrap_or(u64::MAX),
        completion_tokens: completion.unwrap_or(u64::MAX),
    })
}

pub fn merge_usage(prev: Option<(u64, u64)>, prompt_tokens: u64, completion_tokens: u64) -> (u64, u64) {
    merge_stream_usage(prev, prompt_tokens, completion_tokens)
}

pub fn finished_thinking(blocks: &ThinkingAccum) -> Vec<ThinkingBlock> {
    finished_thinking_blocks(blocks)
}

pub fn finished_tools(tools: &ToolAccum) -> Vec<(String, String, String)> {
    finished_tool_rows(tools)
}

pub fn apply_thinking_piece(blocks: &mut ThinkingAccum, piece: &StreamPiece) {
    apply_thinking(&mut blocks.inner, piece);
}

pub fn finished_thinking_blocks(blocks: &ThinkingAccum) -> Vec<ThinkingBlock> {
    shared_finished_thinking(&blocks.inner)
}

pub fn apply_tool_piece(tools: &mut ToolAccum, piece: &StreamPiece) {
    apply_tool(&mut tools.inner, piece);
}

pub fn finished_tool_rows(tools: &ToolAccum) -> Vec<(String, String, String)> {
    shared_finished_tools(&tools.inner)
        .into_iter()
        .map(|row| {
            let id = if row.id.starts_with("tool_") && !row.id.starts_with("toolu_") {
                row.id.replacen("tool_", "toolu_", 1)
            } else {
                row.id
            };
            (id, row.name, row.arguments)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_account_reads_credentials_and_oauth_email() {
        let dir = tempfile::tempdir().unwrap();
        let none = || None;
        assert_eq!(read_claude_account_with(dir.path(), none), None);
        let home = dir.path().join(".claude");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            dir.path().join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"ada@example.com"}}"#,
        )
        .unwrap();
        assert_eq!(
            read_claude_account_with(dir.path(), none),
            Some((true, Some("ada@example.com".into())))
        );
        fs::write(
            home.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"secret","email":"ada@example.com"}}"#,
        )
        .unwrap();
        assert_eq!(
            read_claude_account_with(dir.path(), none),
            Some((true, Some("ada@example.com".into())))
        );
    }

    #[test]
    fn signed_in_keychain_login_is_the_token_used_to_chat() {
        let dir = tempfile::tempdir().unwrap();
        let raw = r#"{"claudeAiOauth":{"accessToken":"keychain-token","expiresAt":4102444800000},"emailAddress":"ada@example.com"}"#;
        assert_eq!(
            read_claude_access_token_with(dir.path(), || Some(raw.into())).as_deref(),
            Some("keychain-token")
        );
        let expired = r#"{"claudeAiOauth":{"accessToken":"old-token","expiresAt":1}}"#;
        assert_eq!(
            read_claude_access_token_with(dir.path(), || Some(expired.into())),
            None
        );
        let home = dir.path().join(".claude");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"file-token"}}"#,
        )
        .unwrap();
        assert_eq!(
            read_claude_access_token_with(dir.path(), || None).as_deref(),
            Some("file-token")
        );
    }

    #[test]
    fn cli_access_token_is_used_until_it_expires() {
        let dir = tempfile::tempdir().unwrap();
        let creds = dir
            .path()
            .join(".config")
            .join("anthropic")
            .join("credentials");
        fs::create_dir_all(&creds).unwrap();
        fs::write(
            creds.join("default.json"),
            r#"{"access_token":"oauth-token","expires_at":4102444800000,"account_email":"ada@example.com"}"#,
        )
        .unwrap();
        assert_eq!(
            read_cli_access_token(dir.path()).as_deref(),
            Some("oauth-token")
        );
        fs::write(
            creds.join("default.json"),
            r#"{"access_token":"old-token","expires_at":1}"#,
        )
        .unwrap();
        assert_eq!(read_cli_access_token(dir.path()), None);
        fs::write(
            creds.join("default.json"),
            r#"{"access_token":"oauth-seconds","expires_at":4102444800}"#,
        )
        .unwrap();
        assert_eq!(
            read_cli_access_token(dir.path()).as_deref(),
            Some("oauth-seconds")
        );
        assert!(!token_expired(None));
        assert!(token_expired(Some(1)));
        assert!(!token_expired(Some(4_102_444_800)));
        assert!(!token_expired(Some(4_102_444_800_000)));
        assert!(token_needs_refresh(Some(1)));
        assert!(!token_needs_refresh(None));
        assert!(!token_needs_refresh(Some(4_102_444_800)));
    }

    #[test]
    fn claude_account_reads_oauth_from_the_keychain_payload() {
        let dir = tempfile::tempdir().unwrap();
        let raw = r#"{"claudeAiOauth":{"accessToken":"secret-token"},"emailAddress":"ada@example.com"}"#;
        assert_eq!(
            read_claude_account_with(dir.path(), || Some(raw.into())),
            Some((true, Some("ada@example.com".into())))
        );
        let mcp_only = r#"{"mcpOAuth":{"server":{"accessToken":""}}}"#;
        assert_eq!(
            read_claude_account_with(dir.path(), || Some(mcp_only.into())),
            None
        );
    }

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

    #[test]
    fn claude_bin_prefers_the_local_install() {
        let dir = tempfile::tempdir().unwrap();
        let prev = std::env::var_os("HOME");
        std::env::set_var("HOME", dir.path());
        let local = dir.path().join(".claude").join("local");
        fs::create_dir_all(&local).unwrap();
        let bin = local.join(if cfg!(windows) { "claude.exe" } else { "claude" });
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

    #[test]
    fn catalog_lists_each_claude_family() {
        let rows = claude_models();
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            [
                "claude-fable-5-1",
                "claude-opus-5-5",
                "claude-sonnet-5-5",
                "claude-haiku-5-5",
                "claude-opus-4-8",
                "claude-opus-4-7",
                "claude-opus-4-6",
                "claude-sonnet-4-6",
                "claude-sonnet-4-5",
                "claude-haiku-4-5",
            ]
        );
        assert!(rows.iter().all(|row| row.provider == PROVIDER_ANTHROPIC));
        assert!(rows.iter().all(|row| row.context_windows.is_empty()));
        assert_eq!(rows[0].context_window, Some(1_000_000));
        assert_eq!(rows[0].efforts[0].id, "low");
        assert_eq!(rows[0].efforts[0].label, "Low");
        assert_eq!(rows[0].efforts[3].label, "Extra high");
        assert_eq!(rows[0].efforts.last().map(|e| e.id.as_str()), Some("max"));
        let haiku = rows.iter().find(|row| row.id == "claude-haiku-4-5").unwrap();
        assert_eq!(haiku.efforts.len(), 3);
        assert_eq!(haiku.context_window, Some(200_000));
    }

    #[test]
    fn live_page_does_not_hide_catalog_families() {
        let page = claude_models()
            .into_iter()
            .filter(|row| row.id == "claude-opus-4-8")
            .collect();
        let rows = merge_catalog(page);
        let ids: Vec<_> = rows.iter().map(|row| row.id.as_str()).collect();
        assert!(ids.contains(&"claude-fable-5-1"));
        assert!(ids.contains(&"claude-opus-5-5"));
        assert!(ids.contains(&"claude-sonnet-5-5"));
        assert!(ids.contains(&"claude-haiku-5-5"));
        assert!(ids.contains(&"claude-opus-4-7"));
        assert_eq!(ids.iter().filter(|id| **id == "claude-opus-4-8").count(), 1);
    }

    #[test]
    fn provider_matches_only_the_catalog_ids() {
        assert_eq!(provider_for("claude-sonnet-4-6"), Provider::Anthropic);
        assert_eq!(provider_for(" claude-opus-4-8 "), Provider::Anthropic);
        assert!(is_claude_model("claude-haiku-4-5"));
        assert!(is_claude_model("claude-opus-4-8-latest"));
        assert!(is_claude_model("claude-sonnet-4-5-20250929"));
        assert!(!is_claude_model("sxs-claude-opus-4-6"));
        assert!(!is_claude_model("grok-4.6"));
        assert!(!is_claude_model(""));
        assert_eq!(provider_for("grok-4.6"), Provider::Xai);
        assert_eq!(provider_for(""), Provider::Xai);
        assert_eq!(provider_for("sxs-claude-opus-4-6"), Provider::Xai);
    }

    #[test]
    fn models_page_keeps_live_claude_ids_and_drops_the_rest() {
        let body = r#"{
            "data": [
                {"type":"model","id":"claude-opus-4-8","display_name":"Claude Opus 4.8","max_input_tokens":200000,"capabilities":{"image_input":{"supported":true},"thinking":{"supported":true},"pdf_input":{"supported":true},"effort":{"supported":true,"high":{"supported":true},"xhigh":{"supported":true}}}},
                {"type":"model","id":"claude-sonnet-4-5-20250929","display_name":"Claude Sonnet 4.5","max_input_tokens":200000},
                {"type":"model","id":"claude-3-haiku-20240307","display_name":"Claude Haiku 3"},
                {"type":"model","id":"claude-retired","display_name":"Gone","lifecycle":"retired"},
                {"type":"model","id":"sxs-claude-opus-4-6","display_name":"Tutor"}
            ],
            "has_more": true,
            "last_id": "claude-3-haiku-20240307"
        }"#;
        let (rows, last_id, has_more) = parse_models_page(body);
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            ["claude-opus-4-8", "claude-sonnet-4-5-20250929", "claude-3-haiku-20240307"]
        );
        assert_eq!(rows[0].efforts.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), ["high", "xhigh"]);
        assert_eq!(rows[0].capabilities, ["vision", "thinking", "pdf", "effort"]);
        assert_eq!(rows[1].name, "Claude Sonnet 4.5");
        assert_eq!(rows[1].context_window, Some(200_000));
        assert!(rows[1].efforts.iter().any(|row| row.id == "max"));
        assert_eq!(rows[2].efforts.len(), 3);
        assert!(rows.iter().all(|row| row.provider == PROVIDER_ANTHROPIC));
        assert_eq!(last_id.as_deref(), Some("claude-3-haiku-20240307"));
        assert!(has_more);
        assert!(parse_models_page("nope").0.is_empty());
    }

    #[test]
    fn max_tokens_follow_the_catalog() {
        assert_eq!(max_tokens_for("claude-fable-5-1"), 128_000);
        assert_eq!(max_tokens_for("claude-opus-4-8"), 128_000);
        assert_eq!(max_tokens_for("claude-sonnet-4-6"), 64_000);
        assert_eq!(max_tokens_for("claude-haiku-4-5"), 64_000);
        assert_eq!(max_tokens_for("claude-opus-4-8-latest"), 128_000);
        assert_eq!(max_tokens_for("claude-3-haiku-20240307"), 64_000);
    }

    #[test]
    fn haiku_uses_a_fixed_thinking_budget_and_newer_models_stay_adaptive() {
        assert!(supports_adaptive_thinking("claude-opus-4-8"));
        assert!(supports_adaptive_thinking("claude-sonnet-4-6"));
        assert!(supports_adaptive_thinking("claude-sonnet-4-5-20250929"));
        assert!(!supports_adaptive_thinking("claude-haiku-4-5"));
        assert!(!supports_adaptive_thinking("claude-3-haiku-20240307"));
        assert_eq!(manual_thinking_budget("claude-haiku-4-5", None), None);
        assert_eq!(manual_thinking_budget("claude-haiku-4-5", Some("low")), Some(1_024));
        assert_eq!(manual_thinking_budget("claude-haiku-4-5", Some("medium")), Some(4_096));
        assert_eq!(manual_thinking_budget("claude-haiku-4-5", Some("high")), Some(8_192));
        assert_eq!(manual_thinking_budget("claude-opus-4-8", Some("high")), None);
        assert_eq!(manual_thinking_budget("claude-haiku-4-5", Some("nope")), None);
    }

    fn sample_tools(include_journey: bool) -> serde_json::Value {
        crate::dev::chat::tools_json(include_journey)
    }

    #[test]
    fn system_messages_leave_the_array_and_effort_is_optional() {
        let body = to_messages_body(
            &serde_json::json!([
                { "role": "system", "content": "You are Claude." },
                { "role": "system", "content": "Be brief." },
                { "role": "user", "content": "hi" }
            ]),
            "claude-sonnet-4-6",
            None,
            &sample_tools(false),
        );
        assert_eq!(body["system"], "You are Claude.\n\nBe brief.");
        assert_eq!(body["max_tokens"], 64_000);
        assert_eq!(body["stream"], true);
        assert_eq!(body["thinking"]["type"], "adaptive");
        assert!(body.get("output_config").is_none());
        let haiku = to_messages_body(
            &serde_json::json!([{ "role": "user", "content": "hi" }]),
            "claude-haiku-4-5",
            None,
            &sample_tools(false),
        );
        assert!(haiku.get("thinking").is_none());
        assert!(haiku.get("output_config").is_none());
        assert_eq!(body["messages"].as_array().map(|rows| rows.len()), Some(1));
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"][0]["text"], "hi");
        assert_eq!(body["tool_choice"]["type"], "auto");
        let names: Vec<_> = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|row| row["name"].as_str())
            .collect();
        assert!(names.contains(&"read_file"));
        assert!(names.contains(&"web_search"));
        assert!(!names.contains(&"update_journey_knowledge"));
        assert!(body["tools"][0].get("input_schema").is_some());
        assert!(body["tools"][0].get("function").is_none());
    }

    #[test]
    fn effort_and_journey_tool_are_included_when_asked() {
        let body = to_messages_body(
            &serde_json::json!([{ "role": "user", "content": "go" }]),
            "claude-haiku-4-5",
            Some("high"),
            &sample_tools(true),
        );
        assert!(body.get("output_config").is_none());
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["budget_tokens"], 8_192);
        assert_eq!(body["max_tokens"], 64_000);
        let opus = to_messages_body(
            &serde_json::json!([{ "role": "user", "content": "go" }]),
            "claude-opus-4-8",
            Some("high"),
            &sample_tools(false),
        );
        assert_eq!(opus["thinking"]["type"], "adaptive");
        assert_eq!(opus["output_config"]["effort"], "high");
        assert!(opus.get("thinking").and_then(|row| row.get("budget_tokens")).is_none());
        assert!(body.get("system").is_none());
        let names: Vec<_> = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|row| row["name"].as_str())
            .collect();
        assert!(names.contains(&"update_journey_knowledge"));
    }

    #[test]
    fn image_data_urls_become_base64_blocks_and_remote_urls_are_dropped() {
        let body = to_messages_body(
            &serde_json::json!([{
                "role": "user",
                "content": [
                    { "type": "text", "text": "what is this" },
                    { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,abc" } },
                    { "type": "image_url", "image_url": { "url": "https://example.com/a.jpg" } }
                ]
            }]),
            "claude-opus-4-8",
            Some("  "),
            &serde_json::json!([]),
        );
        assert!(body.get("output_config").is_none());
        assert_eq!(body["messages"][0]["content"].as_array().map(|rows| rows.len()), Some(2));
        assert_eq!(body["messages"][0]["content"][1]["type"], "image");
        assert_eq!(body["messages"][0]["content"][1]["source"]["media_type"], "image/jpeg");
        assert_eq!(body["messages"][0]["content"][1]["source"]["data"], "abc");
    }

    #[test]
    fn tool_round_trip_groups_results_and_repairs_arguments() {
        let body = to_messages_body(
            &serde_json::json!([
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {
                            "id": "toolu_1",
                            "type": "function",
                            "function": { "name": "read_file", "arguments": "{\"path\":\"a.rs\"}" }
                        },
                        {
                            "id": "toolu_2",
                            "type": "function",
                            "function": { "name": "list_dir", "arguments": "not-json" }
                        },
                        {
                            "id": "toolu_3",
                            "type": "function",
                            "function": { "name": "git_status", "arguments": "" }
                        }
                    ]
                },
                { "role": "tool", "tool_call_id": "toolu_1", "content": "fn main() {}" },
                { "role": "tool", "tool_call_id": "toolu_2", "content": "[]" }
            ]),
            "claude-sonnet-4-6",
            Some("medium"),
            &sample_tools(false),
        );
        let assistant = &body["messages"][0];
        assert_eq!(assistant["content"].as_array().map(|rows| rows.len()), Some(3));
        assert!(assistant["content"]
            .as_array()
            .unwrap()
            .iter()
            .all(|block| block["type"] == "tool_use"));
        assert_eq!(assistant["content"][0]["input"]["path"], "a.rs");
        assert_eq!(assistant["content"][1]["input"]["raw"], "not-json");
        assert_eq!(assistant["content"][2]["input"], serde_json::json!({}));
        let results = &body["messages"][1];
        assert_eq!(results["role"], "user");
        assert_eq!(results["content"].as_array().map(|rows| rows.len()), Some(2));
        assert_eq!(results["content"][0]["type"], "tool_result");
        assert_eq!(results["content"][0]["tool_use_id"], "toolu_1");
        assert_eq!(results["content"][1]["tool_use_id"], "toolu_2");
    }

    #[test]
    fn sse_fixture_emits_text_thinking_usage_and_a_tool_call() {
        let lines = [
            r#"{"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}"#,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Look "}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"first."}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-1"}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}"#,
            r#"{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_9","name":"read_file"}}"#,
            r#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#,
            r#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"a.rs\"}"}}"#,
            r#"{"type":"message_delta","usage":{"output_tokens":20}}"#,
            r#"{"type":"message_stop"}"#,
        ];
        let mut tools = ToolAccum::default();
        let mut thinking = ThinkingAccum::default();
        let mut deltas = Vec::new();
        let mut thoughts = Vec::new();
        let mut usages = Vec::new();
        let mut stopped = false;
        for line in lines {
            let Some(piece) = parse_sse_data(line) else {
                continue;
            };
            apply_tool_piece(&mut tools, &piece);
            apply_thinking_piece(&mut thinking, &piece);
            match piece {
                SsePiece::Delta(text) => deltas.push(text),
                SsePiece::Reasoning(text) => thoughts.push(text),
                SsePiece::Usage { prompt_tokens, completion_tokens } => {
                    usages.push((prompt_tokens, completion_tokens));
                }
                SsePiece::Stop => stopped = true,
                _ => {}
            }
        }
        assert_eq!(deltas.concat(), "Hi");
        assert_eq!(thoughts.concat(), "Look first.");
        assert_eq!(usages, vec![(12, 1), (u64::MAX, 20)]);
        assert_eq!(merge_usage(Some((12, 1)), u64::MAX, 20), (12, 20));
        assert!(stopped);
        let calls = finished_tools(&tools);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "toolu_9");
        assert_eq!(calls[0].1, "read_file");
        assert_eq!(calls[0].2, "{\"path\":\"a.rs\"}");
        let kept = finished_thinking(&thinking);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].kind, "thinking");
        assert_eq!(kept[0].thinking, "Look first.");
        assert_eq!(kept[0].signature, "sig-1");
        assert!(parse_sse_data("").is_none());
        assert!(parse_sse_data("[DONE]").is_none());
    }

    #[test]
    fn signed_thinking_is_replayed_before_text_and_unsigned_text_is_dropped() {
        let body = to_messages_body(
            &serde_json::json!([
                {
                    "role": "assistant",
                    "content": "Done.",
                    "thinking": [
                        { "type": "thinking", "thinking": "Look first.", "signature": "sig-1" },
                        { "type": "redacted_thinking", "data": "opaque" },
                        { "type": "thinking", "thinking": "no signature" }
                    ],
                    "tool_calls": [
                        {
                            "id": "toolu_1",
                            "type": "function",
                            "function": { "name": "read_file", "arguments": "{\"path\":\"a.rs\"}" }
                        }
                    ]
                },
                { "role": "tool", "tool_call_id": "toolu_1", "content": "fn main() {}" }
            ]),
            "claude-sonnet-4-6",
            Some("high"),
            &sample_tools(false),
        );
        let blocks = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(blocks[0]["type"], "thinking");
        assert_eq!(blocks[0]["thinking"], "Look first.");
        assert_eq!(blocks[0]["signature"], "sig-1");
        assert_eq!(blocks[1]["type"], "redacted_thinking");
        assert_eq!(blocks[1]["data"], "opaque");
        assert_eq!(blocks[2]["type"], "text");
        assert_eq!(blocks[3]["type"], "tool_use");
        assert_eq!(blocks.len(), 4);
    }

    #[test]
    fn claude_does_not_use_the_xai_endpoint() {
        assert_eq!(provider_for("claude-sonnet-4-6"), Provider::Anthropic);
        assert_ne!(MESSAGES_URL, crate::grok_cli::endpoint(false));
        assert_ne!(MESSAGES_URL, crate::grok_cli::endpoint(true));
        assert_eq!(http_error_message(401, "nope"), KEY_REJECTED);
        let other = http_error_message(400, "bad model");
        assert!(other.starts_with("Anthropic error 400:"));
        assert!(other.contains("bad model"));
    }
}
