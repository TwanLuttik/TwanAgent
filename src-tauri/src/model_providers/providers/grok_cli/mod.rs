use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::process::WindowlessCommand;
use crate::secrets;

mod billing;
mod plan;

pub use billing::{
    __cmd__dev_xai_account_usage, __cmd__dev_xai_account_usage_cached,
    __tauri_command_name_dev_xai_account_usage, __tauri_command_name_dev_xai_account_usage_cached,
    account_usage, cached_account_usage, dev_xai_account_usage, dev_xai_account_usage_cached,
    parse_billing, parse_subscription_tier, AccountUsage, AccountUsageWindow, BILLING_URL,
    PROVIDER_XAI, SETTINGS_URL, XAI_OAUTH_CLIENT_ID, XAI_OAUTH_TOKEN_URL,
};
pub use plan::{
    __cmd__dev_grok_plan, __cmd__dev_grok_plan_edit, __cmd__dev_grok_plan_set,
    __cmd__dev_grok_plan_write, __tauri_command_name_dev_grok_plan,
    __tauri_command_name_dev_grok_plan_edit, __tauri_command_name_dev_grok_plan_set,
    __tauri_command_name_dev_grok_plan_write, dev_grok_plan, dev_grok_plan_edit, dev_grok_plan_set,
    dev_grok_plan_write, edit_grok_plan_file, encode_session_cwd, grok_home, read_grok_plan,
    session_exists_in, session_id_safe, write_grok_plan_file, write_grok_plan_state,
    GrokPlanSnapshot,
};

const FALLBACK_MODELS: &[(&str, &str, &[&str])] = &[
    ("grok-4.6", "Grok 4.6", &["xhigh", "high", "medium", "low"]),
    ("grok-4.5", "Grok 4.5", &["high", "medium", "low"]),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DevEffort {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DevModel {
    pub id: String,
    pub name: String,
    pub efforts: Vec<DevEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// Selectable sizes from the CLI catalog. Empty when the model has a single window.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context_windows: Vec<u64>,
    /// `xai`, `anthropic`, or `minimax`. Older callers that omit it are Grok.
    #[serde(default = "default_provider")]
    pub provider: String,
    /// Short capability ids such as `vision` and `thinking`. Empty for Grok.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
}

fn default_provider() -> String {
    "xai".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GrokCliInfo {
    pub installed: bool,
    pub path: String,
    pub version: Option<String>,
    pub logged_in: bool,
    pub email: Option<String>,
    /// A newer release than `version`. Empty when this install is current or the check has not run.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub update: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderStatus {
    pub id: String,
    pub ready: bool,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DevRuntime {
    pub installed: bool,
    pub logged_in: bool,
    pub version: Option<String>,
    pub email: Option<String>,
    pub default_model: String,
    pub default_effort: String,
    pub models: Vec<DevModel>,
    pub has_key: bool,
    /// Grok can send. Kept so older screens still read one flag.
    pub ready: bool,
    pub hint: String,
    /// One row per model provider. The composer uses the row for the selected model.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub providers: Vec<ProviderStatus>,
}

#[derive(Debug, Clone)]
pub struct GrokAuth {
    pub token: String,
    pub via_cli: bool,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

pub fn grok_bin() -> Option<PathBuf> {
    if let Some(home) = grok_home() {
        let unix = home.join("bin").join("grok");
        if unix.is_file() {
            return Some(unix);
        }
        let win = home.join("bin").join("grok.exe");
        if win.is_file() {
            return Some(win);
        }
    }
    which("grok")
}

fn which(name: &str) -> Option<PathBuf> {
    let cmd = if cfg!(windows) { "where" } else { "which" };
    let out = Command::new(cmd)
        .hide_console_window()
        .arg(name)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&out.stdout);
    let path = line.lines().next()?.trim();
    if path.is_empty() {
        return None;
    }
    let p = PathBuf::from(path);
    p.is_file().then_some(p)
}

pub fn grok_version(bin: &Path) -> Option<String> {
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

/// `grok --version` is a process spawn. A detected version is reused; a miss is tried again
/// so installing the CLI after launch still shows up.
fn cli_version_cache() -> &'static Mutex<Option<String>> {
    static VERSION: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    VERSION.get_or_init(|| Mutex::new(None))
}

pub fn cached_cli_version() -> String {
    if let Some(found) = cli_version_cache()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
    {
        return found;
    }
    let detected = grok_bin().as_ref().and_then(|path| grok_version(path));
    let version = cli_proxy_version(detected.as_deref());
    if detected.is_some() {
        if let Ok(mut guard) = cli_version_cache().lock() {
            *guard = Some(version.clone());
        }
    }
    version
}

/// Forget the version read at launch. The next settings read spawns `grok --version` again.
pub fn forget_cli_version() {
    if let Ok(mut guard) = cli_version_cache().lock() {
        *guard = None;
    }
}

pub fn parse_cli_version(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            let mut dots = 0;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                if bytes[i] == b'.' {
                    dots += 1;
                }
                i += 1;
            }
            if dots == 2 {
                let candidate = &text[start..i];
                if candidate
                    .split('.')
                    .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
                {
                    return Some(candidate.to_string());
                }
            }
            continue;
        }
        i += 1;
    }
    None
}

const FALLBACK_PROXY_VERSION: &str = "1.0.0";

pub fn cli_proxy_version(detected: Option<&str>) -> String {
    detected
        .and_then(parse_cli_version)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| FALLBACK_PROXY_VERSION.into())
}

pub struct CliProxyHeaders {
    pub client_version: String,
    pub token_auth: &'static str,
    pub client_identifier: &'static str,
    pub user_agent: String,
}

pub fn cli_proxy_headers(version: &str) -> CliProxyHeaders {
    CliProxyHeaders {
        client_version: version.to_string(),
        token_auth: "xai-grok-cli",
        client_identifier: "twanagent",
        user_agent: format!("twanagent/{version}"),
    }
}

pub fn effort_label(id: &str) -> String {
    match id {
        "xhigh" => "Extra high".into(),
        "max" => "Max".into(),
        "high" => "High".into(),
        "medium" => "Medium".into(),
        "low" | "minimal" | "none" => "Low".into(),
        other => other.to_string(),
    }
}

pub fn parse_toml_quoted(src: &str, section: &str, key: &str) -> Option<String> {
    let mut in_section = section.is_empty();
    let header = format!("[{section}]");
    for raw in src.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            in_section = line.eq_ignore_ascii_case(&header);
            continue;
        }
        if !in_section {
            continue;
        }
        let Some((left, right)) = line.split_once('=') else {
            continue;
        };
        if left.trim() != key {
            continue;
        }
        let value = right.trim();
        if let Some(inner) = value
            .strip_prefix('"')
            .and_then(|s| s.rsplit_once('"').map(|(body, _)| body.to_string()))
        {
            return Some(inner);
        }
        return Some(value.trim_end_matches(',').to_string());
    }
    None
}

pub fn parse_models_cache(src: &str) -> Vec<DevModel> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(src) else {
        return Vec::new();
    };
    let Some(map) = json.get("models").and_then(|m| m.as_object()) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for (id, entry) in map {
        let info = entry.get("info").unwrap_or(entry);
        if info.get("hidden").and_then(|h| h.as_bool()) == Some(true) {
            continue;
        }
        let family = info
            .get("model_family")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !id.starts_with("grok-") && family != "xai" {
            continue;
        }
        let name = info
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(id)
            .to_string();
        let efforts = info
            .get("reasoning_efforts")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|e| {
                        let eid = e
                            .get("id")
                            .or_else(|| e.get("value"))
                            .and_then(|v| v.as_str())?;
                        Some(DevEffort {
                            id: eid.to_string(),
                            label: e
                                .get("label")
                                .and_then(|v| v.as_str())
                                .map(|s| friendly_effort_label(s, eid))
                                .unwrap_or_else(|| effort_label(eid)),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let context_window = info.get("context_window").and_then(json_u64);
        rows.push(DevModel {
            id: info
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or(id)
                .to_string(),
            name,
            efforts,
            context_window,
            context_windows: context_windows_from(info, context_window),
            provider: "xai".into(),
            capabilities: Vec::new(),
        });
    }
    rows.sort_by(|a, b| b.id.cmp(&a.id));
    rows
}

fn json_u64(value: &serde_json::Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|n| n.is_finite() && *n > 0.0 && *n <= u64::MAX as f64)
            .map(|n| n as u64)
    })
}

/// Sizes the CLI offers when a model lists more than one. A lone default stays empty
/// so the picker stays hidden, matching `/context-window`.
fn context_windows_from(info: &serde_json::Value, default_window: Option<u64>) -> Vec<u64> {
    let mut rows = Vec::new();
    if let Some(arr) = info.get("context_windows").and_then(|v| v.as_array()) {
        for value in arr {
            let Some(n) = json_u64(value).filter(|n| *n > 0) else {
                continue;
            };
            if !rows.contains(&n) {
                rows.push(n);
            }
        }
    }
    if let Some(n) = default_window.filter(|n| *n > 0) {
        if !rows.contains(&n) {
            rows.insert(0, n);
        }
    }
    if rows.len() < 2 {
        return Vec::new();
    }
    rows
}

pub fn context_window_header_value(tokens: Option<u64>) -> Option<String> {
    tokens.filter(|n| *n > 0).map(|n| n.to_string())
}

fn friendly_effort_label(raw: &str, id: &str) -> String {
    match id {
        "xhigh" => "Extra high".into(),
        "max" => "Max".into(),
        "high" => "High".into(),
        "medium" => "Medium".into(),
        "low" | "minimal" | "none" => "Low".into(),
        _ => raw
            .trim()
            .trim_end_matches(" Effort")
            .trim_end_matches(" effort")
            .to_string(),
    }
}

fn fallback_models() -> Vec<DevModel> {
    FALLBACK_MODELS
        .iter()
        .map(|(id, name, efforts)| DevModel {
            id: (*id).into(),
            name: (*name).into(),
            efforts: efforts
                .iter()
                .map(|e| DevEffort {
                    id: (*e).into(),
                    label: effort_label(e),
                })
                .collect(),
            context_window: Some(256_000),
            context_windows: vec![256_000, 500_000],
            provider: "xai".into(),
            capabilities: Vec::new(),
        })
        .collect()
}

/// Grok rows from the CLI cache, or the bundled fallback when that cache is missing.
pub fn load_models_public(home: Option<&Path>) -> Vec<DevModel> {
    home.map(load_models)
        .filter(|rows| !rows.is_empty())
        .unwrap_or_else(fallback_models)
}

fn load_models(home: &Path) -> Vec<DevModel> {
    let path = home.join("models_cache.json");
    if let Ok(src) = fs::read_to_string(path) {
        let rows = parse_models_cache(&src);
        if !rows.is_empty() {
            return rows;
        }
    }
    fallback_models()
}

fn load_defaults(home: &Path, models: &[DevModel]) -> (String, String) {
    let src = fs::read_to_string(home.join("config.toml")).unwrap_or_default();
    let model = parse_toml_quoted(&src, "models", "default")
        .filter(|id| models.iter().any(|m| m.id == *id))
        .or_else(|| models.first().map(|m| m.id.clone()))
        .unwrap_or_else(|| "grok-4.6".into());
    let effort = parse_toml_quoted(&src, "models", "default_reasoning_effort")
        .or_else(|| {
            models
                .iter()
                .find(|m| m.id == model)
                .and_then(|m| m.efforts.first().map(|e| e.id.clone()))
        })
        .unwrap_or_else(|| "high".into());
    (model, effort)
}

#[derive(Deserialize)]
struct AuthEntry {
    #[serde(default)]
    key: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    expires_at: String,
    #[serde(default)]
    refresh_token: String,
}

pub fn read_cli_session(home: &Path) -> Option<(String, String, bool)> {
    let src = fs::read_to_string(home.join("auth.json")).ok()?;
    let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&src).ok()?;
    let mut best: Option<(String, String, bool, SystemTime)> = None;
    for (_k, v) in map {
        let entry: AuthEntry = serde_json::from_value(v).ok()?;
        if entry.key.trim().is_empty() && entry.refresh_token.trim().is_empty() {
            continue;
        }
        let expired = is_expired(&entry.expires_at);
        let stamp = parse_time(&entry.expires_at).unwrap_or(SystemTime::UNIX_EPOCH);
        let keep =
            !expired || !entry.refresh_token.trim().is_empty() || !entry.key.trim().is_empty();
        if !keep {
            continue;
        }
        if best.as_ref().map(|b| stamp > b.3).unwrap_or(true) {
            best = Some((
                entry.key,
                entry.email,
                !expired || !entry.refresh_token.is_empty(),
                stamp,
            ));
        }
    }
    best.map(|(key, email, logged_in, _)| (key, email, logged_in))
}

fn parse_time(raw: &str) -> Option<SystemTime> {
    let dt = chrono::DateTime::parse_from_rfc3339(raw).ok()?;
    Some(SystemTime::from(dt.with_timezone(&chrono::Utc)))
}

fn is_expired(raw: &str) -> bool {
    match parse_time(raw) {
        Some(t) => t <= SystemTime::now(),
        None => false,
    }
}

pub fn resolve_auth(data_dir: &Path) -> Option<GrokAuth> {
    if let Some(key) = secrets::resolve_xai_key_on_disk(data_dir) {
        return Some(GrokAuth {
            token: key,
            via_cli: false,
        });
    }
    let home = grok_home()?;
    let (key, _email, logged_in) = read_cli_session(&home)?;
    if key.trim().is_empty() || !logged_in {
        return None;
    }
    Some(GrokAuth {
        token: key,
        via_cli: true,
    })
}

pub fn cli_info(data_dir: &Path) -> GrokCliInfo {
    // Settings reads this after launch. Reuse the version `runtime` already spawned.
    let status = runtime(data_dir);
    let path = grok_bin()
        .map(|bin| bin.display().to_string())
        .unwrap_or_default();
    GrokCliInfo {
        installed: status.installed,
        path,
        version: status.version,
        logged_in: status.logged_in,
        email: status.email,
        update: String::new(),
    }
}

pub fn runtime(data_dir: &Path) -> DevRuntime {
    let has_key = secrets::resolve_xai_key_on_disk(data_dir).is_some();
    let bin = grok_bin();
    let installed = bin.is_some();
    // `grok --version` is a process spawn. A version found earlier in this process is reused.
    // The fallback string means the binary was missing, so it is not reported as a version.
    let version = if installed {
        let cached = cached_cli_version();
        (cached != FALLBACK_PROXY_VERSION).then_some(cached)
    } else {
        None
    };
    let home = grok_home();
    let models = load_models_public(home.as_deref());
    let (default_model, default_effort) = home
        .as_ref()
        .map(|h| load_defaults(h, &models))
        .unwrap_or_else(|| {
            (
                models
                    .first()
                    .map(|m| m.id.clone())
                    .unwrap_or_else(|| "grok-4.6".into()),
                models
                    .first()
                    .and_then(|m| m.efforts.first().map(|e| e.id.clone()))
                    .unwrap_or_else(|| "high".into()),
            )
        });
    let session = home.as_ref().and_then(|h| read_cli_session(h));
    let email = session.as_ref().and_then(|s| {
        if s.1.trim().is_empty() {
            None
        } else {
            Some(s.1.clone())
        }
    });
    let logged_in = session.as_ref().map(|s| s.2).unwrap_or(false);
    let ready = has_key || resolve_auth(data_dir).is_some();
    let hint = if ready {
        if logged_in {
            match &email {
                Some(e) => format!("Using Grok CLI · {e}"),
                None => "Using Grok CLI".into(),
            }
        } else if has_key {
            "Using your xAI API key".into()
        } else {
            String::new()
        }
    } else if installed {
        "Grok CLI is installed. Run grok login, or add an API key in Settings.".into()
    } else {
        "Install the Grok CLI, or add an xAI API key in Settings.".into()
    };
    DevRuntime {
        installed,
        logged_in,
        version,
        email,
        default_model,
        default_effort,
        models,
        has_key,
        ready,
        hint,
        providers: Vec::new(),
    }
}

pub fn endpoint(via_cli: bool) -> &'static str {
    twanagent_service::xai::endpoint(via_cli)
}

#[cfg(test)]
mod tests;
