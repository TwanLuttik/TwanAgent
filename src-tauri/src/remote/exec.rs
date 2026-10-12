use std::path::Path;

use super::config::{Machine, RemoteProject};
use super::ssh::{self, ExecRequest, ExecResult, Pool};
use crate::dev::cmd::{self, CMD_OUTPUT_LIMIT};
use crate::error::Result;

pub const REMOTE_TIMEOUT_SECS: u64 = 600;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    pub text: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub remote: bool,
}

pub trait ExecBackend {
    fn exec(&self, machine: &Machine, secret: Option<&str>, request: &ExecRequest) -> Result<ExecResult>;
}

impl ExecBackend for Pool {
    fn exec(&self, machine: &Machine, secret: Option<&str>, request: &ExecRequest) -> Result<ExecResult> {
        Pool::exec(self, machine, secret, request)
    }
}

/// Run on the server when `remote` is set. Otherwise use the local shell in `workspace`.
pub fn run_workspace_command(
    workspace: &Path,
    command: &str,
    remote: Option<(&Machine, &RemoteProject, Option<&str>)>,
    backend: &dyn ExecBackend,
) -> Result<CommandOutput> {
    let Some((machine, project, secret)) = remote else {
        let text = cmd::run_command(workspace, command)?;
        return Ok(CommandOutput {
            text,
            exit_code: None,
            timed_out: false,
            remote: false,
        });
    };
    let script = ssh::remote_shell_command(&project.remote_path, command)?;
    let result = backend.exec(
        machine,
        secret,
        &ExecRequest {
            cwd: project.remote_path.clone(),
            command: script,
            timeout_secs: REMOTE_TIMEOUT_SECS,
        },
    )?;
    Ok(CommandOutput {
        text: format_remote_output(&result),
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        remote: true,
    })
}

pub fn format_remote_output(result: &ExecResult) -> String {
    let mut text = String::new();
    if !result.stdout.is_empty() {
        text.push_str(&result.stdout);
    }
    if !result.stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&result.stderr);
    }
    if result.timed_out {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&format!("command timed out after {REMOTE_TIMEOUT_SECS}s"));
    } else if result.exit_code.is_some_and(|code| code != 0) {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&format!("exit {}", result.exit_code.unwrap_or(-1)));
    }
    if text.len() > CMD_OUTPUT_LIMIT {
        let mut end = CMD_OUTPUT_LIMIT;
        while !text.is_char_boundary(end) && end > 0 {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n…truncated");
    }
    if text.is_empty() {
        text = "(no output)".into();
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Rec {
        calls: Mutex<Vec<ExecRequest>>,
    }

    impl ExecBackend for Rec {
        fn exec(&self, _machine: &Machine, _secret: Option<&str>, request: &ExecRequest) -> Result<ExecResult> {
            self.calls.lock().unwrap().push(request.clone());
            Ok(ExecResult {
                stdout: "ok".into(),
                stderr: String::new(),
                stdout_bytes: b"ok".to_vec(),
                exit_code: Some(0),
                timed_out: false,
            })
        }
    }

    fn pair() -> (Machine, RemoteProject) {
        (
            Machine {
                id: "m".into(),
                name: "Box".into(),
                user: "dev".into(),
                host: "example.com".into(),
                port: 22,
                auth: super::super::config::AuthMethod::Agent,
                key_path: None,
                secret_account: None,
                created_at: "now".into(),
            },
            RemoteProject {
                id: "p".into(),
                machine_id: "m".into(),
                name: "billing".into(),
                remote_path: "/srv/billing".into(),
                mount_path: "/tmp/mounts/p".into(),
                created_at: "now".into(),
            },
        )
    }

    #[test]
    fn remote_workspace_uses_ssh_and_not_the_mount() {
        let (machine, project) = pair();
        let backend = Rec {
            calls: Mutex::new(Vec::new()),
        };
        let mount = Path::new("/tmp/mounts/p");
        let out = run_workspace_command(mount, "npm test", Some((&machine, &project, None)), &backend).unwrap();
        assert!(out.remote);
        assert_eq!(out.text, "ok");
        let calls = backend.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].cwd, "/srv/billing");
        assert_eq!(calls[0].command, "cd '/srv/billing' && npm test");
        assert_eq!(calls[0].timeout_secs, REMOTE_TIMEOUT_SECS);
        assert!(!calls[0].command.contains("/tmp/mounts"));
    }

    #[test]
    fn local_workspace_stays_on_the_local_shell() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("note.txt"), "hi").unwrap();
        let backend = Rec {
            calls: Mutex::new(Vec::new()),
        };
        let out = run_workspace_command(dir.path(), "cat note.txt", None, &backend).unwrap();
        assert!(!out.remote);
        assert!(out.text.contains("hi"));
        assert!(backend.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn remote_output_is_capped_for_the_model() {
        let result = ExecResult {
            stdout: "x".repeat(CMD_OUTPUT_LIMIT + 50),
            stderr: String::new(),
            stdout_bytes: Vec::new(),
            exit_code: Some(0),
            timed_out: false,
        };
        let text = format_remote_output(&result);
        assert!(text.contains("truncated"));
        assert!(text.len() <= CMD_OUTPUT_LIMIT + "\n…truncated".len());
    }
}
