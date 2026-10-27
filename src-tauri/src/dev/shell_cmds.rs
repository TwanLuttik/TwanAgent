//! Open a folder, open a link, and run a shell command.
//! Command names stay `dev_*`.

use tauri::{AppHandle, Emitter, State};

use crate::dev::off_main;
use crate::error::{Error, Result};
use crate::process::WindowlessCommand;
use crate::state::AppState;

/// http(s) only. `open` would also launch local files and custom URL schemes.
fn browser_url(raw: &str) -> Result<String> {
    let url = raw.trim();
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(|| Error::Other("only http and https links can be opened".into()))?;
    if rest.is_empty() || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(Error::Other("that link cannot be opened".into()));
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod url_tests {
    use super::browser_url;
    use crate::dev::commands::{named_project_rows, same_project_path};
    use crate::dev::projects::FolderSuggestion;
    use crate::remote::config::RemoteProject;

    #[test]
    fn a_server_project_keeps_the_typed_name_not_the_mount_id() {
        let mount = "/Users/me/Library/Application Support/app.twanagent.desktop-dev/mounts/8fecb999-263f-458f-b191-39a4f3e71e88/";
        let rows = named_project_rows(
            vec![FolderSuggestion {
                path: mount.trim_end_matches('/').into(),
                name: "8fecb999-263f-458f-b191-39a4f3e71e88".into(),
            }],
            &[RemoteProject {
                id: "8fecb999-263f-458f-b191-39a4f3e71e88".into(),
                machine_id: "m1".into(),
                name: "dev-test".into(),
                remote_path: "/home/dev/projects/dev-test".into(),
                mount_path: mount.into(),
                created_at: "now".into(),
            }],
        );
        assert_eq!(rows[0].name, "dev-test");
        assert!(same_project_path(&rows[0].path, mount));
    }

    #[test]
    fn browser_links_are_http_only() {
        assert_eq!(
            browser_url(" https://example.com/a ").unwrap(),
            "https://example.com/a"
        );
        assert!(browser_url("http://localhost:1430").is_ok());
        assert!(browser_url("file:///etc/passwd").is_err());
        assert!(browser_url("javascript:alert(1)").is_err());
        assert!(browser_url("https://evil.test\nopen").is_err());
        assert!(browser_url("notaurl").is_err());
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_reveal_folder(state: State<'_, AppState>, path: String) -> Result<()> {
    let root = state.require_workspace(&path)?;
    if crate::remote::project_for_workspace(&state, &root)?.is_some() {
        return Err(Error::Other("this project lives on a server".into()));
    }
    crate::dev::mcp::open_path(&root)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_open_url(url: String) -> Result<()> {
    let url = browser_url(&url)?;
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&url).status()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .hide_console_window()
            .args(["/C", "start", "", &url])
            .status()
    } else {
        std::process::Command::new("xdg-open").arg(&url).status()
    };
    match status {
        Ok(code) if code.success() => Ok(()),
        Ok(_) => Err(Error::Other("could not open the link".into())),
        Err(err) => Err(Error::Other(format!("could not open the link: {err}"))),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_stop_command(id: String) -> Result<()> {
    crate::dev::cmd::stop_command(&id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_run_command(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace: String,
    command: String,
    stream_id: Option<String>,
) -> Result<String> {
    let root = state.require_workspace(&workspace)?;
    let remote = crate::remote::project_for_workspace(&state, &root)?;
    let data_dir = state.data_dir.clone();
    let pool = state.ssh_pool.clone();
    let stream = stream_id.unwrap_or_default();
    off_main(move || {
        let emit = |kind: &str, text: Option<String>, exit_code: Option<i32>| {
            if stream.is_empty() {
                return;
            }
            let _ = app.emit(
                "dev-command",
                crate::dev::types::DevCommandEvent {
                    stream_id: stream.clone(),
                    kind: kind.into(),
                    text,
                    exit_code,
                },
            );
        };
        emit("start", None, None);
        let Some(project) = remote else {
            let text = crate::dev::cmd::run_command_streaming(&root, &command, &stream, |chunk| {
                emit("data", Some(chunk.to_string()), None);
            })?;
            emit("exit", None, None);
            return Ok(text);
        };
        let conn = crate::appdb::open(&data_dir)?;
        let machine = crate::remote::config::machine_by_id(&conn, &project.machine_id)?
            .ok_or_else(|| Error::NotFound("machine not found".into()))?;
        let secret = machine
            .secret_account
            .as_deref()
            .and_then(crate::secrets::get_ssh_secret);
        let out = crate::remote::exec::run_workspace_command(
            &root,
            &command,
            Some((&machine, &project, secret.as_deref())),
            pool.as_ref(),
        )?;
        if !out.text.is_empty() && out.text != "(no output)" {
            emit("data", Some(out.text.clone()), None);
        }
        emit("exit", None, out.exit_code);
        Ok(out.text)
    })
    .await
}
