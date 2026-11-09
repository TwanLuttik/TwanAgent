use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::home_dir;

pub fn grok_home() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("GROK_HOME") {
        let path = PathBuf::from(raw);
        if !path.as_os_str().is_empty() {
            return Some(path);
        }
    }
    home_dir().map(|h| h.join(".grok"))
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

#[cfg(test)]
mod tests {
    use super::*;

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
