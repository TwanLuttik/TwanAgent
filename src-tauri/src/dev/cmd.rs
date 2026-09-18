use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use super::paths::resolve_in_workspace;
use crate::error::{Error, Result};

pub(crate) const CMD_OUTPUT_LIMIT: usize = 80_000;
const CMD_TIMEOUT_SECS: u64 = 60;

fn kill_command_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

pub fn run_command(workspace: &Path, command: &str) -> Result<String> {
    let root = resolve_in_workspace(workspace, "")?;
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(Error::Other("command is empty".into()));
    }
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", trimmed]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", trimmed]);
        c
    };
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let mut child = cmd
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Other(format!("could not start command: {e}")))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::Other("missing stdout pipe".into()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| Error::Other("missing stderr pipe".into()))?;
    let stdout_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let stderr_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > Duration::from_secs(CMD_TIMEOUT_SECS) => {
                kill_command_tree(&mut child);
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err(Error::Other(format!(
                    "command timed out after {CMD_TIMEOUT_SECS}s"
                )));
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(e) => return Err(Error::Other(e.to_string())),
        }
    };
    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();
    let mut text = String::new();
    let stdout = String::from_utf8_lossy(&stdout);
    let stderr = String::from_utf8_lossy(&stderr);
    if !stdout.is_empty() {
        text.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&stderr);
    }
    if !status.success() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&format!("exit {}", status.code().unwrap_or(-1)));
    }
    if text.len() > CMD_OUTPUT_LIMIT {
        text.truncate(CMD_OUTPUT_LIMIT);
        text.push_str("\n…truncated");
    }
    if text.is_empty() {
        text = "(no output)".into();
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_ws() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn run_command_stays_in_workspace() {
        let dir = temp_ws();
        fs::write(dir.path().join("note.txt"), "hi").unwrap();
        let cmd = if cfg!(windows) {
            "type note.txt"
        } else {
            "cat note.txt"
        };
        let out = run_command(dir.path(), cmd).unwrap();
        assert!(out.contains("hi"));
    }

    #[test]
    fn run_command_reads_large_stdout() {
        let dir = temp_ws();
        let cmd = if cfg!(windows) {
            "powershell -NoProfile -Command \"$s='x'*200000; Write-Output $s\""
        } else {
            "dd if=/dev/zero bs=1024 count=200 2>/dev/null | tr '\\0' 'x'"
        };
        let out = run_command(dir.path(), cmd).unwrap();
        assert!(
            out.len() >= CMD_OUTPUT_LIMIT,
            "expected large output, got {}",
            out.len()
        );
        assert!(out.contains("truncated"));
    }
}
