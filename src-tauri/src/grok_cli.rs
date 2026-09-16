use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
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
        client_identifier: "backupanything",
        user_agent: format!("backupanything-dev/{version}"),
    }
}

pub fn effort_label(id: &str) -> String {
    match id {
        "xhigh" | "max" => "Extra high".into(),
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
        rows.push(DevModel {
            id: info
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or(id)
                .to_string(),
            name,
            efforts,
        });
    }
    rows.sort_by(|a, b| b.id.cmp(&a.id));
    rows
}

fn friendly_effort_label(raw: &str, id: &str) -> String {
    match id {
        "xhigh" | "max" => "Extra high".into(),
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

pub fn runtime(data_dir: &Path) -> DevRuntime {
    let has_key = secrets::resolve_xai_key_on_disk(data_dir).is_some();
    let bin = grok_bin();
    let installed = bin.is_some();
    let version = bin.as_ref().and_then(|p| grok_version(p));
    let home = grok_home();
    let models = home
        .as_ref()
        .map(|h| load_models(h))
        .filter(|m| !m.is_empty())
        .unwrap_or_else(fallback_models);
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
                ]
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
        assert_eq!(effort_label("medium"), "Medium");
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
        assert_eq!(headers.client_identifier, "backupanything");
        assert_eq!(headers.user_agent, "backupanything-dev/1.0.31");
    }
}
