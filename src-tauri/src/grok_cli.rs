use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::secrets;

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
    /// `xai` or `anthropic`. Older callers that omit it are Grok.
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
    pub ready: bool,
    pub hint: String,
}

#[derive(Debug, Clone)]
pub struct GrokAuth {
    pub token: String,
    pub via_cli: bool,
}

pub fn grok_home() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("GROK_HOME") {
        let path = PathBuf::from(raw);
        if !path.as_os_str().is_empty() {
            return Some(path);
        }
    }
    home_dir().map(|h| h.join(".grok"))
}

pub fn grok_launch_args(session_id: Option<&str>, existing: bool) -> Vec<String> {
    match session_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) if existing => vec!["--resume".into(), id.into()],
        Some(id) => vec!["--session-id".into(), id.into()],
        None => Vec::new(),
    }
}

pub fn session_id_safe(session_id: &str) -> bool {
    let id = session_id.trim();
    !id.is_empty()
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains("..")
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn session_exists_in(home: &Path, session_id: &str) -> bool {
    if !session_id_safe(session_id) {
        return false;
    }
    let root = home.join("sessions");
    let Ok(entries) = fs::read_dir(root) else {
        return false;
    };
    entries
        .flatten()
        .any(|entry| entry.path().join(session_id).is_dir())
}

pub fn session_exists(session_id: &str) -> bool {
    grok_home().is_some_and(|home| session_exists_in(&home, session_id))
}

const PLAN_CAP: usize = 400_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GrokPlanSnapshot {
    pub found: bool,
    pub state: String,
    pub awaiting_approval: bool,
    pub content: String,
}

impl GrokPlanSnapshot {
    fn missing() -> Self {
        Self {
            found: false,
            state: "Inactive".into(),
            awaiting_approval: false,
            content: String::new(),
        }
    }
}

pub fn encode_session_cwd(path: &Path) -> String {
    let text = path.to_string_lossy();
    let mut out = String::new();
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn session_dir(home: &Path, workspace: &Path, session_id: &str) -> Option<PathBuf> {
    if !session_id_safe(session_id) {
        return None;
    }
    let id = session_id.trim();
    let root = home.join("sessions");
    let preferred = root.join(encode_session_cwd(workspace)).join(id);
    if preferred.is_dir() {
        return Some(preferred);
    }
    let entries = fs::read_dir(root).ok()?;
    entries.flatten().find_map(|entry| {
        let candidate = entry.path().join(id);
        candidate.is_dir().then_some(candidate)
    })
}

fn parse_plan_mode(text: &str) -> (String, bool) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return ("Inactive".into(), false);
    };
    let state = match value
        .get("state")
        .and_then(|item| item.as_str())
        .unwrap_or("Inactive")
    {
        "Pending" => "Pending",
        "Active" => "Active",
        "ExitPending" => "ExitPending",
        _ => "Inactive",
    };
    let awaiting = value
        .get("awaiting_plan_approval")
        .and_then(|item| item.as_bool())
        .unwrap_or(false);
    (state.into(), awaiting)
}

fn read_capped(path: &Path) -> String {
    let Ok(bytes) = fs::read(path) else {
        return String::new();
    };
    let end = bytes.len().min(PLAN_CAP);
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

pub fn read_grok_plan(home: &Path, workspace: &Path, session_id: &str) -> GrokPlanSnapshot {
    let Some(dir) = session_dir(home, workspace, session_id) else {
        return GrokPlanSnapshot::missing();
    };
    let (state, awaiting_approval) =
        parse_plan_mode(&fs::read_to_string(dir.join("plan_mode.json")).unwrap_or_default());
    GrokPlanSnapshot {
        found: true,
        state,
        awaiting_approval,
        content: read_capped(&dir.join("plan.md")),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_grok_plan(workspace: String, session_id: String) -> GrokPlanSnapshot {
    let Some(home) = grok_home() else {
        return GrokPlanSnapshot::missing();
    };
    let path = PathBuf::from(&workspace);
    let path = fs::canonicalize(&path).unwrap_or(path);
    read_grok_plan(&home, &path, &session_id)
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
    let out = Command::new(cmd).arg(name).output().ok()?;
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
    let out = Command::new(bin).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?.trim();
    parse_cli_version(line)
}

/// `grok --version` is a process spawn. Chat rounds reuse the first answer.
pub fn cached_cli_version() -> String {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION
        .get_or_init(|| {
            let detected = grok_bin().as_ref().and_then(|path| grok_version(path));
            cli_proxy_version(detected.as_deref())
        })
        .clone()
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
    }
}

pub fn runtime(data_dir: &Path) -> DevRuntime {
    let has_key = secrets::resolve_xai_key_on_disk(data_dir).is_some();
    let bin = grok_bin();
    let installed = bin.is_some();
    let version = bin.as_ref().and_then(|p| grok_version(p));
    let home = grok_home();
    let mut models = home
        .as_ref()
        .map(|h| load_models(h))
        .filter(|m| !m.is_empty())
        .unwrap_or_else(fallback_models);
    models.extend(crate::anthropic::claude_models());
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
    }
}

pub fn endpoint(via_cli: bool) -> &'static str {
    if via_cli {
        "https://cli-chat-proxy.grok.com/v1/chat/completions"
    } else {
        "https://api.x.ai/v1/chat/completions"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cli_model_cache_and_drops_non_grok() {
        let src = r#"{
          "models": {
            "grok-4.6": {
              "info": {
                "id": "grok-4.6",
                "name": "Grok 4.6",
                "model_family": "xai",
                "hidden": false,
                "reasoning_efforts": [
                  {"id": "xhigh", "label": "Extra High Effort"},
                  {"id": "high", "label": "High Effort"}
                ],
                "context_window": 256000,
                "context_windows": [256000, 500000, 256000]
              }
            },
            "sxs-claude-opus-4-6": {
              "info": {
                "id": "sxs-claude-opus-4-6",
                "name": "Tutor Claude",
                "model_family": "anthropic"
              }
            }
          }
        }"#;
        let rows = parse_models_cache(src);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "grok-4.6");
        assert_eq!(rows[0].efforts[0].label, "Extra high");
        assert_eq!(rows[0].context_window, Some(256_000));
        assert_eq!(rows[0].context_windows, vec![256_000, 500_000]);
    }

    #[test]
    fn single_context_window_stays_hidden() {
        let src = r#"{
          "models": {
            "grok-3": {
              "info": {
                "id": "grok-3",
                "name": "Grok 3",
                "model_family": "xai",
                "context_window": 131072
              }
            }
          }
        }"#;
        let rows = parse_models_cache(src);
        assert_eq!(rows[0].context_window, Some(131_072));
        assert!(rows[0].context_windows.is_empty());
    }

    #[test]
    fn context_window_header_is_a_positive_token_count() {
        assert_eq!(
            context_window_header_value(Some(500_000)).as_deref(),
            Some("500000")
        );
        assert_eq!(context_window_header_value(Some(0)), None);
        assert_eq!(context_window_header_value(None), None);
    }

    #[test]
    fn reads_defaults_from_config_toml() {
        let src = "[models]\ndefault = \"grok-4.6\"\ndefault_reasoning_effort = \"xhigh\"\n";
        assert_eq!(
            parse_toml_quoted(src, "models", "default").as_deref(),
            Some("grok-4.6")
        );
        assert_eq!(
            parse_toml_quoted(src, "models", "default_reasoning_effort").as_deref(),
            Some("xhigh")
        );
    }

    #[test]
    fn effort_labels_are_short() {
        assert_eq!(effort_label("xhigh"), "Extra high");
        assert_eq!(effort_label("max"), "Max");
        assert_eq!(effort_label("medium"), "Medium");
    }

    #[test]
    fn runtime_appends_claude_without_replacing_the_grok_default() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("grok-home");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join("models_cache.json"),
            r#"{"models":{"grok-4.5":{"info":{"id":"grok-4.5","name":"Grok 4.5","model_family":"xai","reasoning_efforts":[{"id":"high","label":"High"}]}}}}"#,
        )
        .unwrap();
        fs::write(
            home.join("config.toml"),
            "[models]\ndefault = \"grok-4.5\"\ndefault_reasoning_effort = \"high\"\n",
        )
        .unwrap();
        let prev = std::env::var_os("GROK_HOME");
        std::env::set_var("GROK_HOME", &home);
        let status = runtime(dir.path());
        match prev {
            Some(value) => std::env::set_var("GROK_HOME", value),
            None => std::env::remove_var("GROK_HOME"),
        }
        assert_eq!(status.default_model, "grok-4.5");
        let providers: Vec<_> = status
            .models
            .iter()
            .map(|row| (row.id.as_str(), row.provider.as_str()))
            .collect();
        assert!(providers.iter().any(|(id, provider)| *id == "grok-4.5" && *provider == "xai"));
        assert!(providers
            .iter()
            .any(|(id, provider)| *id == "claude-sonnet-4-6" && *provider == "anthropic"));
        assert!(!providers.iter().any(|(id, _)| id.starts_with("sxs-")));
    }

    #[test]
    fn parses_semver_from_grok_version_line() {
        assert_eq!(
            parse_cli_version("grok 1.0.31 (b44e0bc0a8e0) [alpha]").as_deref(),
            Some("1.0.31")
        );
        assert_eq!(parse_cli_version("1.0.31").as_deref(), Some("1.0.31"));
        assert_eq!(parse_cli_version("grok").as_deref(), None);
    }

    #[test]
    fn proxy_version_falls_back_when_cli_is_missing() {
        assert_eq!(cli_proxy_version(None), "1.0.0");
        assert_eq!(
            cli_proxy_version(Some("grok 1.0.31 (b44e0bc0a8e0) [alpha]")),
            "1.0.31"
        );
    }

    #[test]
    fn proxy_headers_include_client_version() {
        let headers = cli_proxy_headers("1.0.31");
        assert_eq!(headers.client_version, "1.0.31");
        assert_eq!(headers.token_auth, "xai-grok-cli");
        assert_eq!(headers.client_identifier, "twanagent");
        assert_eq!(headers.user_agent, "twanagent/1.0.31");
    }

    #[test]
    fn launch_args_bind_or_resume_a_session() {
        assert_eq!(grok_launch_args(None, false), Vec::<String>::new());
        assert_eq!(grok_launch_args(Some("c1"), false), ["--session-id", "c1"]);
        assert_eq!(grok_launch_args(Some("c1"), true), ["--resume", "c1"]);
        assert_eq!(grok_launch_args(Some("  "), false), Vec::<String>::new());
    }

    #[test]
    fn read_grok_plan_returns_the_session_plan() {
        let dir = tempfile::tempdir().unwrap();
        let id = "01a0a89f-8f33-7600-8603-fb8517309b70";
        let workspace = PathBuf::from("/tmp/project");
        let missing = read_grok_plan(dir.path(), &workspace, id);
        assert!(!missing.found);
        assert_eq!(missing.state, "Inactive");
        assert!(!missing.awaiting_approval);
        assert!(missing.content.is_empty());

        let session = dir
            .path()
            .join("sessions")
            .join("%2Ftmp%2Fproject")
            .join(id);
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("plan.md"), "# Ship it\n\nReuse the helper.\n").unwrap();
        fs::write(
            session.join("plan_mode.json"),
            r#"{"state":"Active","awaiting_plan_approval":false}"#,
        )
        .unwrap();

        let plan = read_grok_plan(dir.path(), &workspace, id);
        assert!(plan.found);
        assert_eq!(plan.state, "Active");
        assert!(!plan.awaiting_approval);
        assert!(plan.content.contains("Reuse the helper."));
    }

    #[test]
    fn read_grok_plan_prefers_the_workspace_session() {
        let dir = tempfile::tempdir().unwrap();
        let id = "01a0a89f-8f33-7600-8603-fb8517309b71";
        let other = dir.path().join("sessions").join("%2Fother").join(id);
        let matched = dir
            .path()
            .join("sessions")
            .join("%2Ftmp%2Fproject")
            .join(id);
        fs::create_dir_all(&other).unwrap();
        fs::create_dir_all(&matched).unwrap();
        fs::write(other.join("plan.md"), "other plan").unwrap();
        fs::write(matched.join("plan.md"), "workspace plan").unwrap();
        fs::write(
            matched.join("plan_mode.json"),
            r#"{"state":"Inactive","awaiting_plan_approval":true}"#,
        )
        .unwrap();

        let plan = read_grok_plan(dir.path(), Path::new("/tmp/project"), id);
        assert!(plan.found);
        assert_eq!(plan.content, "workspace plan");
        assert!(plan.awaiting_approval);
        assert_eq!(plan.state, "Inactive");
    }

    #[test]
    fn read_grok_plan_falls_back_and_rejects_unsafe_ids() {
        let dir = tempfile::tempdir().unwrap();
        let id = "01a0a89f-8f33-7600-8603-fb8517309b72";
        let session = dir.path().join("sessions").join("%2Felsewhere").join(id);
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("plan.md"), "saved plan").unwrap();
        fs::write(session.join("plan_mode.json"), "not json").unwrap();

        let plan = read_grok_plan(dir.path(), Path::new("/tmp/missing"), id);
        assert!(plan.found);
        assert_eq!(plan.content, "saved plan");
        assert_eq!(plan.state, "Inactive");
        assert!(!plan.awaiting_approval);

        let escaped = read_grok_plan(dir.path(), Path::new("/tmp/missing"), "../escape");
        assert!(!escaped.found);
    }

    #[test]
    fn session_exists_finds_a_dir_under_any_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let id = "01a0a89f-8f33-7600-8603-fb8517309b70";
        assert!(!session_exists_in(dir.path(), id));
        let session = dir
            .path()
            .join("sessions")
            .join("%2Ftmp%2Fproject")
            .join(id);
        fs::create_dir_all(&session).unwrap();
        assert!(session_exists_in(dir.path(), id));
        assert!(!session_exists_in(dir.path(), "missing-id"));
        assert!(!session_exists_in(dir.path(), "../escape"));
    }
}
