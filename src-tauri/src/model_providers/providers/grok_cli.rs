use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::secrets;
use crate::process::WindowlessCommand;

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

const PLAN_STATES: &[&str] = &["Inactive", "Pending", "Active", "ExitPending"];

fn normalize_plan_state(state: &str) -> &'static str {
    PLAN_STATES
        .iter()
        .copied()
        .find(|known| *known == state)
        .unwrap_or("Inactive")
}

/// Keep the fields the CLI already wrote. Only `state` and approval change.
fn plan_mode_json(previous: &str, state: &str, awaiting: bool) -> String {
    let mut value = serde_json::from_str::<serde_json::Value>(previous).unwrap_or_else(|_| {
        serde_json::json!({
            "was_previously_active": false,
            "reminder_count": 0,
            "pending_exit_reminder": false,
        })
    });
    if !value.is_object() {
        value = serde_json::json!({
            "was_previously_active": false,
            "reminder_count": 0,
            "pending_exit_reminder": false,
        });
    }
    if let Some(obj) = value.as_object_mut() {
        let normalized = normalize_plan_state(state);
        let was = obj
            .get("state")
            .and_then(|item| item.as_str())
            .unwrap_or("Inactive");
        if normalized == "Active" && was != "Active" {
            obj.insert("was_previously_active".into(), serde_json::Value::Bool(true));
        }
        obj.insert(
            "state".into(),
            serde_json::Value::String(normalized.into()),
        );
        obj.insert(
            "awaiting_plan_approval".into(),
            serde_json::Value::Bool(awaiting),
        );
        obj.entry("reminder_count")
            .or_insert(serde_json::Value::from(0));
        obj.entry("pending_exit_reminder")
            .or_insert(serde_json::Value::Bool(false));
        obj.entry("was_previously_active")
            .or_insert(serde_json::Value::Bool(false));
    }
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| {
        format!("{{\"state\":\"{}\",\"awaiting_plan_approval\":{awaiting}}}", normalize_plan_state(state))
    })
}

pub fn write_grok_plan_state(
    home: &Path,
    workspace: &Path,
    session_id: &str,
    state: &str,
    awaiting_approval: bool,
) -> std::result::Result<GrokPlanSnapshot, String> {
    if !session_id_safe(session_id) {
        return Err("invalid session id".into());
    }
    let dir = home
        .join("sessions")
        .join(encode_session_cwd(workspace))
        .join(session_id.trim());
    fs::create_dir_all(&dir).map_err(|err| format!("create plan session: {err}"))?;
    let mode_path = dir.join("plan_mode.json");
    let previous = fs::read_to_string(&mode_path).unwrap_or_default();
    let next = plan_mode_json(&previous, state, awaiting_approval);
    fs::write(&mode_path, next).map_err(|err| format!("write plan mode: {err}"))?;
    Ok(read_grok_plan(home, workspace, session_id))
}

pub fn write_grok_plan_file(
    home: &Path,
    workspace: &Path,
    session_id: &str,
    contents: &str,
) -> std::result::Result<(), String> {
    if !session_id_safe(session_id) {
        return Err("invalid session id".into());
    }
    if contents.len() > PLAN_CAP {
        return Err("plan is too large".into());
    }
    let dir = home
        .join("sessions")
        .join(encode_session_cwd(workspace))
        .join(session_id.trim());
    fs::create_dir_all(&dir).map_err(|err| format!("create plan session: {err}"))?;
    fs::write(dir.join("plan.md"), contents).map_err(|err| format!("write plan: {err}"))
}

pub fn edit_grok_plan_file(
    home: &Path,
    workspace: &Path,
    session_id: &str,
    old: &str,
    new_text: &str,
) -> std::result::Result<(), String> {
    if old.is_empty() {
        return Err("old_string is empty".into());
    }
    if !session_id_safe(session_id) {
        return Err("invalid session id".into());
    }
    let dir = session_dir(home, workspace, session_id).ok_or_else(|| "plan file is missing".to_string())?;
    let path = dir.join("plan.md");
    let current = fs::read_to_string(&path).map_err(|_| "plan file is missing".to_string())?;
    let count = current.matches(old).count();
    if count == 0 {
        return Err("old_string was not found in plan.md".into());
    }
    if count > 1 {
        return Err("old_string matched more than once in plan.md".into());
    }
    let next = current.replacen(old, new_text, 1);
    if next.len() > PLAN_CAP {
        return Err("plan is too large".into());
    }
    fs::write(path, next).map_err(|err| format!("write plan: {err}"))
}

fn plan_paths(workspace: &str) -> Option<(PathBuf, PathBuf)> {
    let home = grok_home()?;
    let path = PathBuf::from(workspace);
    let path = fs::canonicalize(&path).unwrap_or(path);
    Some((home, path))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_grok_plan(workspace: String, session_id: String) -> GrokPlanSnapshot {
    let Some((home, path)) = plan_paths(&workspace) else {
        return GrokPlanSnapshot::missing();
    };
    read_grok_plan(&home, &path, &session_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_grok_plan_set(
    workspace: String,
    session_id: String,
    state: String,
    awaiting_approval: bool,
) -> Result<GrokPlanSnapshot, String> {
    let (home, path) = plan_paths(&workspace).ok_or_else(|| "Grok home is missing".to_string())?;
    write_grok_plan_state(&home, &path, &session_id, &state, awaiting_approval)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_grok_plan_write(
    workspace: String,
    session_id: String,
    contents: String,
) -> Result<(), String> {
    let (home, path) = plan_paths(&workspace).ok_or_else(|| "Grok home is missing".to_string())?;
    write_grok_plan_file(&home, &path, &session_id, &contents)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_grok_plan_edit(
    workspace: String,
    session_id: String,
    old_string: String,
    new_string: String,
) -> Result<(), String> {
    let (home, path) = plan_paths(&workspace).ok_or_else(|| "Grok home is missing".to_string())?;
    edit_grok_plan_file(&home, &path, &session_id, &old_string, &new_string)
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
pub fn cached_cli_version() -> String {
    static VERSION: OnceLock<String> = OnceLock::new();
    if let Some(found) = VERSION.get() {
        return found.clone();
    }
    let detected = grok_bin().as_ref().and_then(|path| grok_version(path));
    let version = cli_proxy_version(detected.as_deref());
    if detected.is_some() {
        let _ = VERSION.set(version.clone());
    }
    version
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

pub const PROVIDER_XAI: &str = "xai";
/// The call `grok` makes for `/usage`. An API key cannot read this.
pub const BILLING_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
pub const SETTINGS_URL: &str = "https://cli-chat-proxy.grok.com/v1/settings";
/// Same public client `grok login` uses. A refresh token is bound to it.
pub const XAI_OAUTH_CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
pub const XAI_OAUTH_TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";

/// One allowance window on the signed-in Grok account. `used_percent` is percent used.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AccountUsageWindow {
    pub id: String,
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<String>,
}

/// Weekly pool, or a prepaid balance, for the Grok CLI login. An API key has neither.
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

fn empty_usage(connected: bool, label: impl Into<String>) -> AccountUsage {
    AccountUsage {
        provider: PROVIDER_XAI.into(),
        connected,
        label: label.into(),
        windows: Vec::new(),
        balance_cents: None,
        balance_currency: None,
        credit_status: None,
        fetched_at: Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
    }
}

fn account_usage_cache_key() -> &'static str {
    PROVIDER_XAI
}

/// The last snapshot written to the app database. Empty when this provider has never loaded.
pub fn cached_account_usage(data_dir: &Path) -> Option<AccountUsage> {
    let conn = crate::appdb::open(data_dir).ok()?;
    let raw = crate::appdb::get_account_usage(&conn, account_usage_cache_key()).ok()??;
    serde_json::from_str(&raw).ok()
}

/// A confirmed sign-out replaces the snapshot. A failed read does not, so one bad
/// poll cannot hide an account that was connected a moment ago.
fn store_account_usage(data_dir: &Path, usage: &AccountUsage) {
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
pub fn dev_xai_account_usage_cached(state: tauri::State<'_, crate::state::AppState>) -> Option<AccountUsage> {
    cached_account_usage(&state.data_dir)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_xai_account_usage(state: tauri::State<'_, crate::state::AppState>) -> Result<AccountUsage, String> {
    let data_dir = state.data_dir.clone();
    let usage = account_usage().await;
    store_account_usage(&data_dir, &usage);
    Ok(usage)
}

fn json_f64(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|n| n as f64))
        .or_else(|| value.as_u64().map(|n| n as f64))
        .filter(|n| n.is_finite())
}

fn cent_val(value: &serde_json::Value) -> Option<i64> {
    let raw = value.get("val").unwrap_or(value);
    raw.as_i64()
        .or_else(|| raw.as_u64().and_then(|n| i64::try_from(n).ok()))
        .or_else(|| raw.as_f64().filter(|n| n.is_finite()).map(|n| n.round() as i64))
}

/// 0–100. A value strictly below 1 is a fraction. 1 and above are already a percent,
/// so a pool that is exactly 1% used is not turned into 100%.
fn usage_percent(value: &serde_json::Value) -> Option<f64> {
    let number = json_f64(value)?;
    if number < 0.0 {
        return None;
    }
    let scaled = if number > 0.0 && number < 1.0 { number * 100.0 } else { number };
    Some(scaled.min(100.0))
}

fn period_label(kind: &str) -> &'static str {
    let text = kind.trim().to_ascii_lowercase();
    if text.contains("week") {
        "Week"
    } else if text.contains("month") {
        "Month"
    } else if text.contains("day") {
        "Day"
    } else {
        "Week"
    }
}

fn period_end(config: &serde_json::Value) -> Option<String> {
    config
        .pointer("/currentPeriod/end")
        .or_else(|| config.get("billingPeriodEnd"))
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
}

/// Read the weekly pool from `GET /v1/billing?format=credits`.
/// `creditUsagePercent` is the shared allowance. Product rows are kept when that field is absent.
/// A prepaid balance is cents left. Unknown shapes return no windows instead of inventing a number.
pub fn parse_billing(body: &str) -> (Vec<AccountUsageWindow>, Option<i64>) {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return (Vec::new(), None);
    };
    let config = json.get("config").unwrap_or(&json);
    let mut windows = Vec::new();
    let kind = config
        .pointer("/currentPeriod/type")
        .and_then(|item| item.as_str())
        .unwrap_or("USAGE_PERIOD_TYPE_WEEKLY");
    let resets_at = period_end(config);
    if let Some(used) = config.get("creditUsagePercent").and_then(usage_percent) {
        windows.push(AccountUsageWindow {
            id: "credits".into(),
            label: period_label(kind).into(),
            used_percent: used,
            resets_at: resets_at.clone(),
        });
    } else if let Some(rows) = config.get("productUsage").and_then(|item| item.as_array()) {
        for row in rows {
            let Some(used) = row.get("usagePercent").and_then(usage_percent) else {
                continue;
            };
            let product = row.get("product").and_then(|item| item.as_str()).unwrap_or("pool");
            windows.push(AccountUsageWindow {
                id: product.to_string(),
                label: product_label(product).into(),
                used_percent: used,
                resets_at: resets_at.clone(),
            });
        }
    } else if let (Some(limit), Some(used)) = (
        config.get("monthlyLimit").and_then(cent_val).filter(|n| *n > 0),
        config.get("used").and_then(cent_val),
    ) {
        let percent = ((used as f64 / limit as f64) * 100.0).clamp(0.0, 100.0);
        windows.push(AccountUsageWindow {
            id: "monthly".into(),
            label: "Month".into(),
            used_percent: percent,
            resets_at,
        });
    }
    let balance = config.get("prepaidBalance").and_then(cent_val).filter(|n| *n >= 0);
    (windows, balance)
}

fn product_label(product: &str) -> String {
    let text = product.trim();
    let bare = text.strip_prefix("PRODUCT_").unwrap_or(text);
    let key = bare.replace('_', "").to_ascii_lowercase();
    if key == "grokbuild" || key == "build" {
        return "Build".into();
    }
    if key == "grokchat" || key == "chat" {
        return "Chat".into();
    }
    let name = bare.replace('_', " ");
    let mut out = String::new();
    for word in name.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            out.extend(first.to_uppercase());
            out.extend(chars.flat_map(|ch| ch.to_lowercase()));
        }
    }
    if out.is_empty() { "Week".into() } else { out }
}

/// Plan name from `GET /v1/settings`. Empty when the payload has none.
pub fn parse_subscription_tier(body: &str) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    for key in ["subscription_tier_display", "subscriptionTierDisplay", "subscription_tier", "subscriptionTier"] {
        if let Some(name) = json.get(key).and_then(|item| item.as_str()).map(str::trim).filter(|item| !item.is_empty()) {
            return Some(name.to_string());
        }
    }
    None
}

#[derive(Debug, Clone)]
struct CliLogin {
    key: String,
    email: String,
    refresh_token: String,
    /// Map key in `auth.json`, so a refresh writes back to the same login.
    slot: String,
}

fn best_cli_login(home: &Path) -> Option<CliLogin> {
    let src = fs::read_to_string(home.join("auth.json")).ok()?;
    let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&src).ok()?;
    let mut best: Option<(CliLogin, SystemTime)> = None;
    for (slot, value) in map {
        let Ok(entry) = serde_json::from_value::<AuthEntry>(value) else {
            continue;
        };
        if entry.key.trim().is_empty() && entry.refresh_token.trim().is_empty() {
            continue;
        }
        let stamp = parse_time(&entry.expires_at).unwrap_or(SystemTime::UNIX_EPOCH);
        let login = CliLogin {
            key: entry.key,
            email: entry.email,
            refresh_token: entry.refresh_token,
            slot,
        };
        if best.as_ref().map(|(_, at)| stamp > *at).unwrap_or(true) {
            best = Some((login, stamp));
        }
    }
    best.map(|(login, _)| login)
}

/// Renew the CLI access token when it is inside the refresh window, and write it back.
async fn refresh_cli_login(home: &Path) -> Option<String> {
    let login = best_cli_login(home)?;
    if login.key.trim().is_empty() && login.refresh_token.trim().is_empty() {
        return None;
    }
    let path = home.join("auth.json");
    let raw = fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let expires = value
        .get(&login.slot)
        .and_then(|item| item.get("expires_at"))
        .and_then(|item| item.as_str())
        .unwrap_or("");
    if !login.key.trim().is_empty() && !token_needs_refresh(expires) {
        return Some(login.key);
    }
    if login.refresh_token.trim().is_empty() {
        return (!login.key.trim().is_empty()).then_some(login.key);
    }
    let Some(fresh) = refresh_oauth(&login.refresh_token).await else {
        // A failed refresh a few minutes early is not a sign-out. The current token still works.
        return (!login.key.trim().is_empty() && !is_expired(expires)).then_some(login.key);
    };
    write_refreshed_login(&path, &login.slot, &fresh)?;
    Some(fresh.access_token)
}

fn token_needs_refresh(expires_at: &str) -> bool {
    let Some(at) = parse_time(expires_at.trim()) else {
        return false;
    };
    let Ok(left) = at.duration_since(SystemTime::now()) else {
        return true;
    };
    left <= std::time::Duration::from_secs(5 * 60)
}

struct RefreshedLogin {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<String>,
}

async fn refresh_oauth(refresh_token: &str) -> Option<RefreshedLogin> {
    let body = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", XAI_OAUTH_CLIENT_ID),
    ];
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .ok()?
        .post(XAI_OAUTH_TOKEN_URL)
        .header("content-type", "application/x-www-form-urlencoded")
        .header("accept", "application/json")
        .form(&body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let fresh: serde_json::Value = response.json().await.ok()?;
    let access_token = fresh
        .get("access_token")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())?
        .to_string();
    let refresh = fresh
        .get("refresh_token")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string);
    let expires_at = fresh.get("expires_in").and_then(|item| item.as_i64()).and_then(|secs| {
        if secs <= 0 {
            return None;
        }
        let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).ok()?.as_secs() as i64;
        let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(now.saturating_add(secs), 0)?;
        Some(dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    });
    Some(RefreshedLogin {
        access_token,
        refresh_token: refresh,
        expires_at,
    })
}

fn write_refreshed_login(path: &Path, slot: &str, fresh: &RefreshedLogin) -> Option<()> {
    let raw = fs::read_to_string(path).ok()?;
    let mut stored: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let entry = stored.get_mut(slot)?.as_object_mut()?;
    entry.insert("key".into(), serde_json::Value::String(fresh.access_token.clone()));
    if let Some(refresh) = &fresh.refresh_token {
        entry.insert("refresh_token".into(), serde_json::Value::String(refresh.clone()));
    }
    if let Some(expires) = &fresh.expires_at {
        entry.insert("expires_at".into(), serde_json::Value::String(expires.clone()));
    }
    let text = serde_json::to_string_pretty(&stored).ok()?;
    fs::write(path, text).ok()
}

enum BillingGet {
    Ok(String),
    Unauthorized,
    Failed,
}

async fn billing_get(client: &reqwest::Client, url: &str, token: &str) -> BillingGet {
    let headers = cli_proxy_headers(&cached_cli_version());
    let response = match client
        .get(url)
        .bearer_auth(token)
        .header("X-XAI-Token-Auth", headers.token_auth)
        .header("x-grok-client-version", headers.client_version)
        .header("x-grok-client-identifier", headers.client_identifier)
        .header(reqwest::header::USER_AGENT, headers.user_agent)
        .header("accept", "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return BillingGet::Failed,
    };
    let status = response.status().as_u16();
    if status == 401 || status == 403 {
        return BillingGet::Unauthorized;
    }
    if !response.status().is_success() {
        return BillingGet::Failed;
    }
    match response.text().await {
        Ok(body) => BillingGet::Ok(body),
        Err(_) => BillingGet::Failed,
    }
}

/// The signed-in Grok account's weekly pool. An API-key-only login has no session usage.
/// The CLI token is refreshed before the call when it is near expiry, and once more on 401.
pub async fn account_usage() -> AccountUsage {
    let Some(home) = grok_home() else {
        return empty_usage(false, "Grok");
    };
    let email = best_cli_login(&home).map(|login| login.email).filter(|email| email.contains('@'));
    let Some(token) = refresh_cli_login(&home).await else {
        return empty_usage(false, email.unwrap_or_else(|| "Grok".into()));
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut token = token;
    let body = match billing_get(&client, BILLING_URL, &token).await {
        BillingGet::Ok(body) => body,
        BillingGet::Unauthorized => {
            let Some(fresh) = refresh_cli_login(&home).await else {
                return empty_usage(false, email.unwrap_or_else(|| "Grok".into()));
            };
            if fresh == token {
                return empty_usage(false, email.clone().unwrap_or_else(|| "Grok".into()));
            }
            token = fresh;
            match billing_get(&client, BILLING_URL, &token).await {
                BillingGet::Ok(body) => body,
                BillingGet::Unauthorized => {
                    return empty_usage(false, email.unwrap_or_else(|| "Grok".into()));
                }
                BillingGet::Failed => return empty_usage(true, email.unwrap_or_else(|| "Grok".into())),
            }
        }
        BillingGet::Failed => return empty_usage(true, email.unwrap_or_else(|| "Grok".into())),
    };
    let (windows, balance) = parse_billing(&body);
    let tier = match billing_get(&client, SETTINGS_URL, &token).await {
        BillingGet::Ok(settings) => parse_subscription_tier(&settings),
        _ => None,
    };
    let label = tier
        .or(email)
        .filter(|item| !item.is_empty())
        .unwrap_or_else(|| "Grok".into());
    AccountUsage {
        provider: PROVIDER_XAI.into(),
        connected: true,
        label,
        windows,
        balance_cents: balance,
        balance_currency: balance.map(|_| "USD".into()),
        credit_status: None,
        fetched_at: Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
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
            "other-claude-opus-4-6": {
              "info": {
                "id": "other-claude-opus-4-6",
                "name": "Other Claude",
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
        assert!(!providers.iter().any(|(id, _)| id.starts_with("claude-")));
        assert!(!providers.iter().any(|(id, _)| id.starts_with("other-")));
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
    fn write_grok_plan_state_round_trips_and_keeps_cli_fields() {
        let dir = tempfile::tempdir().unwrap();
        let id = "01a0a89f-8f33-7600-8603-fb8517309b73";
        let workspace = PathBuf::from("/tmp/project");
        let wrote = write_grok_plan_state(dir.path(), &workspace, id, "Pending", false).unwrap();
        assert!(wrote.found);
        assert_eq!(wrote.state, "Pending");
        assert!(!wrote.awaiting_approval);

        let session = dir
            .path()
            .join("sessions")
            .join("%2Ftmp%2Fproject")
            .join(id);
        let raw = fs::read_to_string(session.join("plan_mode.json")).unwrap();
        assert!(raw.contains("\"reminder_count\": 0"));
        let active = write_grok_plan_state(dir.path(), &workspace, id, "nope", true).unwrap();
        assert_eq!(active.state, "Inactive");
        assert!(active.awaiting_approval);
        let err = write_grok_plan_state(dir.path(), &workspace, "../escape", "Active", false);
        assert!(err.is_err());
    }

    #[test]
    fn write_and_edit_plan_file_stay_inside_the_session() {
        let dir = tempfile::tempdir().unwrap();
        let id = "01a0a89f-8f33-7600-8603-fb8517309b74";
        let workspace = PathBuf::from("/tmp/project");
        write_grok_plan_file(dir.path(), &workspace, id, "# Plan\n\nReuse helper.\n").unwrap();
        edit_grok_plan_file(dir.path(), &workspace, id, "Reuse helper.", "Reuse the session helper.").unwrap();
        let plan = read_grok_plan(dir.path(), &workspace, id);
        assert!(plan.content.contains("Reuse the session helper."));
        let missing = edit_grok_plan_file(dir.path(), &workspace, id, "nope", "x");
        assert!(missing.is_err());
    }

    #[test]
    fn billing_reads_the_weekly_pool_and_a_prepaid_balance() {
        let body = r#"{
            "config": {
                "creditUsagePercent": 42.5,
                "currentPeriod": {
                    "type": "USAGE_PERIOD_TYPE_WEEKLY",
                    "start": "2026-06-01T00:00:00Z",
                    "end": "2026-06-08T00:00:00Z"
                },
                "onDemandCap": {"val": 5000},
                "onDemandUsed": {"val": 300},
                "prepaidBalance": {"val": 1250},
                "isUnifiedBillingUser": true,
                "productUsage": [
                    {"product": "PRODUCT_GROK_BUILD", "usagePercent": 61.2}
                ]
            }
        }"#;
        let (windows, balance) = parse_billing(body);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].id, "credits");
        assert_eq!(windows[0].label, "Week");
        assert!((windows[0].used_percent - 42.5).abs() < 0.01);
        assert_eq!(windows[0].resets_at.as_deref(), Some("2026-06-08T00:00:00Z"));
        assert_eq!(balance, Some(1250));
        let products = r#"{"config":{"productUsage":[{"product":"PRODUCT_GROK_BUILD","usagePercent":12},{"product":"GrokChat","usagePercent":0.18}],"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","end":"2026-06-08T00:00:00Z"}}}"#;
        let (rows, none) = parse_billing(products);
        assert_eq!(rows.iter().map(|row| row.label.as_str()).collect::<Vec<_>>(), ["Build", "Chat"]);
        assert!((rows[1].used_percent - 18.0).abs() < 0.01);
        assert_eq!(none, None);
        let monthly = r#"{"config":{"monthlyLimit":{"val":2000},"used":{"val":500},"billingPeriodEnd":"2026-07-01T00:00:00Z"}}"#;
        let (legacy, _) = parse_billing(monthly);
        assert_eq!(legacy[0].label, "Month");
        assert!((legacy[0].used_percent - 25.0).abs() < 0.01);
        assert!(parse_billing("nope").0.is_empty());
        assert_eq!(
            parse_subscription_tier(r#"{"subscription_tier_display":"SuperGrok"}"#).as_deref(),
            Some("SuperGrok")
        );
        assert_eq!(parse_subscription_tier("{}"), None);
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
