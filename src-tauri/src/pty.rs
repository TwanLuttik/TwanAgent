use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::state::AppState;

const EVENT: &str = "dev-pty";

struct PtySession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<PtySession>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<PtySession>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyEvent {
    pub id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
}

pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn resolve_workspace(workspace: &str) -> Result<PathBuf> {
    let root = fs::canonicalize(workspace)
        .map_err(|_| Error::Other("workspace folder is missing".into()))?;
    if !root.is_dir() {
        return Err(Error::Other("workspace is not a folder".into()));
    }
    Ok(root)
}

fn shell_command(workspace: &Path) -> CommandBuilder {
    let shell = default_shell();
    let mut cmd = CommandBuilder::new(&shell);
    #[cfg(not(windows))]
    {
        cmd.arg("-l");
    }
    apply_pty_env(&mut cmd, workspace);
    cmd
}

pub fn grok_missing_message() -> &'static str {
    "Grok CLI isn’t installed."
}

pub fn require_grok_bin(bin: Option<PathBuf>) -> Result<PathBuf> {
    bin.ok_or_else(|| Error::Other(grok_missing_message().into()))
}

fn grok_command(workspace: &Path, session_id: Option<&str>) -> Result<CommandBuilder> {
    let bin = require_grok_bin(crate::grok_cli::grok_bin())?;
    let mut cmd = CommandBuilder::new(&bin);
    let existing = session_id.is_some_and(crate::grok_cli::session_exists);
    for arg in crate::grok_cli::grok_launch_args(session_id, existing) {
        cmd.arg(arg);
    }
    apply_pty_env(&mut cmd, workspace);
    Ok(cmd)
}

fn apply_pty_env(cmd: &mut CommandBuilder, workspace: &Path) {
    cmd.cwd(workspace);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Same family as VS Code / Cursor: Grok and other TUIs enable SGR mouse for xterm.js.
    cmd.env("TERM_PROGRAM", "vscode");
}

pub fn spawn_pty(app: AppHandle, workspace: &Path, cols: u16, rows: u16) -> Result<String> {
    spawn_command_pty(app, cols, rows, shell_command(workspace), "start shell")
}

pub fn spawn_grok_pty(
    app: AppHandle,
    workspace: &Path,
    cols: u16,
    rows: u16,
    session_id: Option<&str>,
) -> Result<String> {
    spawn_command_pty(
        app,
        cols,
        rows,
        grok_command(workspace, session_id)?,
        "start grok",
    )
}

fn spawn_command_pty(
    app: AppHandle,
    cols: u16,
    rows: u16,
    command: CommandBuilder,
    start_err: &str,
) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    let system = native_pty_system();
    let pair = system
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| Error::Other(format!("open terminal: {e}")))?;
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| Error::Other(format!("{start_err}: {e}")))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| Error::Other(format!("read terminal: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| Error::Other(format!("write terminal: {e}")))?;
    let killer = child.clone_killer();
    let session = Arc::new(PtySession {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        killer: Mutex::new(killer),
    });
    sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), session);

    let app_r = app.clone();
    let id_r = id.clone();
    thread::Builder::new()
        .name(format!("dev-pty-{id}"))
        .spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                        let _ = app_r.emit(
                            EVENT,
                            PtyEvent {
                                id: id_r.clone(),
                                kind: "data".into(),
                                data: Some(data),
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
            let _ = child.wait();
            let _ = app_r.emit(
                EVENT,
                PtyEvent {
                    id: id_r.clone(),
                    kind: "exit".into(),
                    data: None,
                },
            );
            sessions()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id_r);
        })
        .map_err(|e| Error::Other(format!("start terminal reader: {e}")))?;

    Ok(id)
}

fn session(id: &str) -> Result<Arc<PtySession>> {
    sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .cloned()
        .ok_or_else(|| Error::NotFound("terminal is closed".into()))
}

pub fn write_pty_bytes(id: &str, data: &[u8]) -> Result<()> {
    let session = session(id)?;
    let mut writer = session.writer.lock().unwrap_or_else(|e| e.into_inner());
    writer
        .write_all(data)
        .map_err(|e| Error::Other(format!("write terminal: {e}")))?;
    writer
        .flush()
        .map_err(|e| Error::Other(format!("write terminal: {e}")))?;
    Ok(())
}

pub fn write_pty(id: &str, data: &str) -> Result<()> {
    write_pty_bytes(id, data.as_bytes())
}

pub fn resize_pty(id: &str, cols: u16, rows: u16) -> Result<()> {
    let session = session(id)?;
    let result = session
        .master
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| Error::Other(format!("resize terminal: {e}")));
    result
}

pub fn kill_pty(id: &str) -> Result<()> {
    let session = sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(id);
    if let Some(session) = session {
        let _ = session
            .killer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .kill();
        // Give the reader a moment to observe EOF so we don't leak the child.
        thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_pty_open(app: AppHandle, workspace: String, cols: u16, rows: u16) -> Result<String> {
    let root = app.state::<AppState>().require_workspace(&workspace)?;
    spawn_pty(app, &root, cols, rows)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_pty_open_grok(
    app: AppHandle,
    workspace: String,
    cols: u16,
    rows: u16,
    session_id: Option<String>,
) -> Result<String> {
    let root = app.state::<AppState>().require_workspace(&workspace)?;
    spawn_grok_pty(app, &root, cols, rows, session_id.as_deref())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_pty_write(id: String, data: String) -> Result<()> {
    write_pty(&id, &data)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_pty_write_bytes(id: String, data: Vec<u8>) -> Result<()> {
    write_pty_bytes(&id, &data)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_pty_resize(id: String, cols: u16, rows: u16) -> Result<()> {
    resize_pty(&id, cols, rows)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_pty_kill(id: String) -> Result<()> {
    kill_pty(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_shell_is_nonempty() {
        assert!(!default_shell().is_empty());
    }

    #[test]
    fn resolve_workspace_rejects_missing() {
        let err = resolve_workspace("/no/such/twanagent-workspace").unwrap_err();
        assert!(err.to_string().contains("missing"));
    }

    #[test]
    fn resolve_workspace_accepts_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        let got = resolve_workspace(dir.path().to_str().unwrap()).unwrap();
        assert!(got.is_dir());
    }

    #[test]
    fn write_and_resize_missing_session_error() {
        let err = write_pty("missing", "x").unwrap_err();
        assert!(err.to_string().contains("closed"));
        let err = write_pty_bytes("missing", &[0x1b, 0x5b, 0x4d]).unwrap_err();
        assert!(err.to_string().contains("closed"));
        let err = resize_pty("missing", 80, 24).unwrap_err();
        assert!(err.to_string().contains("closed"));
    }

    #[test]
    fn require_grok_bin_errors_when_missing() {
        let err = require_grok_bin(None).unwrap_err();
        assert!(err.to_string().contains("isn’t installed"));
    }

    #[test]
    fn pty_shell_echoes() {
        let dir = tempfile::tempdir().unwrap();
        let system = native_pty_system();
        let pair = system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new(default_shell());
        cmd.cwd(dir.path());
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        thread::spawn(move || {
            let mut buf = [0u8; 2048];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        writer.write_all(b"printf 'hello-pty-test\\n'\n").unwrap();
        writer.flush().unwrap();
        let mut acc = String::new();
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(4) {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
                acc.push_str(&String::from_utf8_lossy(&chunk));
                if acc.contains("hello-pty-test") {
                    let _ = child.kill();
                    return;
                }
            }
        }
        let _ = child.kill();
        panic!("did not see echo, got: {acc:?}");
    }
}
