use tauri::State;

use super::super::config::{self, Machine};
use super::ServerWork;
use crate::error::{Error, Result};
use crate::state::AppState;

#[derive(Debug, Clone, serde::Serialize)]
pub struct RemoteSkillFile {
    pub path: String,
    pub read_path: String,
    pub origin: String,
    pub contents: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RemoteCapabilities {
    pub mcp: Vec<String>,
    pub auth: Vec<String>,
    pub skills: Vec<super::RemoteSkillFile>,
}

/// The paired TwanAgent server for this workspace, when the project lives on one.
#[tauri::command(rename_all = "snake_case")]
pub fn dev_workspace_server_id(
    state: State<'_, AppState>,
    workspace: String,
) -> Result<Option<String>> {
    let root = state.require_workspace(&workspace)?;
    let Some(project) = super::super::project_for_workspace(&state, &root)? else {
        return Ok(None);
    };
    let conn = super::open_db(&state)?;
    let machine = config::machine_by_id(&conn, &project.machine_id)?
        .ok_or_else(|| Error::NotFound("machine not found".into()))?;
    Ok(
        super::super::agent_server::server_by_host(&conn, &machine.host, machine.port)?
            .map(|server| server.id),
    )
}

/// MCP and skills for the machine that owns this workspace. Local projects return nothing.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_workspace_capabilities(
    state: State<'_, AppState>,
    workspace: String,
) -> Result<Option<super::RemoteCapabilities>> {
    let root = state.require_workspace(&workspace)?;
    let Some(project) = super::super::project_for_workspace(&state, &root)? else {
        return Ok(None);
    };
    let conn = super::open_db(&state)?;
    let machine = config::machine_by_id(&conn, &project.machine_id)?
        .ok_or_else(|| Error::NotFound("machine not found".into()))?;
    let work = super::server_work(&state);
    crate::state::run_blocking(move || Ok(Some(read_capabilities(&work, &machine)?))).await
}

/// MCP configs, signed-in names, and skills that live on this server. Not this Mac.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_server_capabilities(
    state: State<'_, AppState>,
    id: String,
) -> Result<super::RemoteCapabilities> {
    let work = super::server_work(&state);
    crate::state::run_blocking(move || {
        let conn = super::work_db(&work)?;
        let server = super::servers::agent_server_by_id(&conn, &id)?;
        let machine = super::machine_for_server(&work, &server)?;
        read_capabilities(&work, &machine)
    })
    .await
}

fn read_capabilities(work: &ServerWork, machine: &Machine) -> Result<super::RemoteCapabilities> {
    let script = capabilities_command();
    let stdout = super::require_exec(work, machine, &script, 30)?;
    let parsed: serde_json::Value =
        serde_json::from_str(stdout.trim()).map_err(|err| Error::Other(err.to_string()))?;
    let mcp = parsed
        .get("mcp")
        .and_then(|value| value.as_object())
        .map(|map| {
            [".grok/config.toml", ".cursor/mcp.json", ".claude.json"]
                .into_iter()
                .filter_map(|rel| {
                    map.get(rel)
                        .and_then(|value| value.as_str())
                        .map(|text| format!("{rel}\n{text}"))
                })
                .collect()
        })
        .unwrap_or_default();
    let auth = parsed
        .get("auth")
        .and_then(|value| value.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let skills = parsed
        .get("skills")
        .and_then(|value| value.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    Some(super::RemoteSkillFile {
                        path: row.get("path")?.as_str()?.to_string(),
                        read_path: row.get("read_path")?.as_str()?.to_string(),
                        origin: row.get("origin")?.as_str()?.to_string(),
                        contents: row.get("contents")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(super::RemoteCapabilities { mcp, auth, skills })
}

/// Copy this Mac's MCP configs, skills, and the browser sign-in for one server. The browser stays here.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_sync_server_capabilities(
    state: State<'_, AppState>,
    id: String,
    mcp_name: Option<String>,
) -> Result<super::RemoteCapabilities> {
    let work = super::server_work(&state);
    let signed = mcp_name.unwrap_or_default();
    crate::state::run_blocking(move || {
        if !signed.trim().is_empty() {
            crate::dev::mcp_oauth::mcp_sign_in(signed.trim())?;
        }
        let bundle = local_capability_bundle()?;
        let conn = super::work_db(&work)?;
        let server = super::servers::agent_server_by_id(&conn, &id)?;
        let machine = super::machine_for_server(&work, &server)?;
        let script = capability_copy_script(&bundle)?;
        let _ = super::require_exec(&work, &machine, &script, 60)?;
        read_capabilities(&work, &machine)
    })
    .await
}

fn local_capability_bundle() -> Result<serde_json::Value> {
    let home = crate::dev::paths::home_dir()
        .ok_or_else(|| Error::Other("home folder is unknown".into()))?;
    let mut mcp = serde_json::Map::new();
    for rel in crate::dev::mcp::USER_MCP_FILES {
        if let Ok(text) = crate::dev::mcp::read_user_mcp(rel) {
            mcp.insert((*rel).to_string(), serde_json::Value::String(text));
        }
    }
    let creds = std::fs::read_to_string(
        crate::grok_cli::grok_home()
            .unwrap_or_else(|| home.join(".grok"))
            .join("mcp_credentials.json"),
    )
    .unwrap_or_else(|_| "{}".into());
    let grok = crate::grok_cli::grok_home().unwrap_or_else(|| home.join(".grok"));
    let skills = crate::dev::skills::collect_skill_files(&home, &grok, None);
    let mut copied = Vec::new();
    for row in skills {
        if !row.home {
            continue;
        }
        let Ok(contents) = crate::dev::skills::read_user_skill(&row.read_path) else {
            continue;
        };
        copied.push(serde_json::json!({
            "path": row.read_path,
            "contents": contents,
        }));
    }
    Ok(serde_json::json!({
        "mcp": mcp,
        "credentials": creds,
        "skills": copied,
    }))
}

/// Same listing as the old heredoc, but the script rides inside the command.
/// An exec channel closes stdin as the command starts, so `python3 - <<'PY'` exits before any line arrives.
fn capabilities_command() -> String {
    const PROGRAM: &str = r#"import json, os
home = os.path.expanduser("~")
mcp = {}
for rel in (".grok/config.toml", ".cursor/mcp.json", ".claude.json"):
    path = os.path.join(home, rel)
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            mcp[rel] = handle.read()
    except OSError:
        pass
auth = []
cred = os.path.join(home, ".grok", "mcp_credentials.json")
try:
    with open(cred, "r", encoding="utf-8") as handle:
        raw = json.load(handle)
    if isinstance(raw, dict):
        seen = []
        for key in raw:
            name = str(key).split(":", 1)[0].strip()
            if name and name not in seen:
                seen.append(name)
        auth = seen
except (OSError, ValueError):
    pass
roots = [
    (os.path.join(home, ".grok", "skills"), "user"),
    (os.path.join(home, ".grok", "commands"), "user"),
    (os.path.join(home, ".agents", "skills"), "user"),
    (os.path.join(home, ".claude", "skills"), "claude"),
    (os.path.join(home, ".claude", "commands"), "claude"),
    (os.path.join(home, ".cursor", "skills"), "cursor"),
    (os.path.join(home, ".grok", "bundled", "skills"), "bundled"),
]
skills = []
def add(path, origin):
    rel = os.path.relpath(path, home).replace(os.sep, "/")
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            skills.append({"path": "~/" + rel, "read_path": rel, "origin": origin, "contents": handle.read()})
    except OSError:
        pass
for root, origin in roots:
    if not os.path.isdir(root):
        continue
    if root.endswith("/commands") or root.endswith(os.sep + "commands"):
        for name in sorted(os.listdir(root)):
            if name.lower().endswith(".md") and name.lower() != "readme.md":
                add(os.path.join(root, name), origin)
        continue
    for name in sorted(os.listdir(root)):
        add(os.path.join(root, name, "SKILL.md"), origin)
plugins = os.path.join(home, ".grok", "installed-plugins")
if os.path.isdir(plugins):
    for plugin in sorted(os.listdir(plugins)):
        skill_root = os.path.join(plugins, plugin, "skills")
        if not os.path.isdir(skill_root):
            continue
        for name in sorted(os.listdir(skill_root)):
            add(os.path.join(skill_root, name, "SKILL.md"), "plugin")
print(json.dumps({"mcp": mcp, "auth": auth, "skills": skills}))
"#;
    let encoded = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        PROGRAM.as_bytes(),
    );
    format!(
        "printf %s {} | base64 -d | python3 -",
        super::super::ssh::shell_single_quote(&encoded)
    )
}

fn capability_copy_script(bundle: &serde_json::Value) -> Result<String> {
    let body = serde_json::to_vec(bundle).map_err(|err| Error::Other(err.to_string()))?;
    if body.len() > 8_000_000 {
        return Err(Error::Other("MCP and skills are too large to copy".into()));
    }
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, body);
    let program = r#"
import base64, json, os, sys
data = json.loads(base64.b64decode(sys.stdin.read()))
home = os.path.expanduser("~")

def allowed(rel):
    rel = str(rel).replace("\\", "/").strip()
    if not rel or rel.startswith("/") or ".." in rel.split("/"):
        return ""
    return rel

for rel, text in data.get("mcp", {}).items():
    rel = allowed(rel)
    if not rel:
        continue
    path = os.path.join(home, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text if isinstance(text, str) else "")

cred = os.path.join(home, ".grok", "mcp_credentials.json")
os.makedirs(os.path.dirname(cred), exist_ok=True)
with open(cred, "w", encoding="utf-8") as handle:
    handle.write(data.get("credentials") if isinstance(data.get("credentials"), str) else "{}")
os.chmod(cred, 0o600)

for row in data.get("skills", []):
    if not isinstance(row, dict):
        continue
    rel = allowed(row.get("path", ""))
    if not rel:
        continue
    path = os.path.join(home, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(row.get("contents") if isinstance(row.get("contents"), str) else "")
print("copied")
"#;
    let program_b64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        program.as_bytes(),
    );
    Ok(format!(
        "printf %s {} | base64 -d | python3 -c \"import base64,sys; exec(base64.b64decode('{}'))\"",
        super::super::ssh::shell_single_quote(&encoded),
        program_b64
    ))
}
