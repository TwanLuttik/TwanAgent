use std::io::{ErrorKind, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use super::paths::resolve_in_workspace;
use crate::env_path::command_path;
use crate::error::{Error, Result};

pub(crate) const CMD_OUTPUT_LIMIT: usize = 80_000;
const CMD_TIMEOUT_SECS: u64 = 60;

#[cfg(unix)]
fn set_nonblocking(fd: i32) {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags >= 0 {
        unsafe {
            libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
    }
}

fn read_available(file: &mut impl Read, buf: &mut Vec<u8>) {
    let mut chunk = [0u8; 8192];
    loop {
        match file.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() < CMD_OUTPUT_LIMIT + 1 {
                    let room = (CMD_OUTPUT_LIMIT + 1).saturating_sub(buf.len());
                    let take = n.min(room);
                    if take > 0 {
                        buf.extend_from_slice(&chunk[..take]);
                    }
                }
            }
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(err) if err.kind() == ErrorKind::WouldBlock => break,
            Err(_) => break,
        }
    }
}

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
    cmd.env("PATH", command_path());
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
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        set_nonblocking(stdout.as_raw_fd());
        set_nonblocking(stderr.as_raw_fd());
    }
    let mut out_buf = Vec::new();
    let mut err_buf = Vec::new();
    let started = std::time::Instant::now();
    let timed_out = loop {
        read_available(&mut stdout, &mut out_buf);
        read_available(&mut stderr, &mut err_buf);
        match child.try_wait() {
            Ok(Some(status)) => {
                read_available(&mut stdout, &mut out_buf);
                read_available(&mut stderr, &mut err_buf);
                break Err(status);
            }
            Ok(None) if started.elapsed() > Duration::from_secs(CMD_TIMEOUT_SECS) => {
                kill_command_tree(&mut child);
                read_available(&mut stdout, &mut out_buf);
                read_available(&mut stderr, &mut err_buf);
                break Ok(());
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(e) => return Err(Error::Other(e.to_string())),
        }
    };
    Ok(format_command_output(&out_buf, &err_buf, timed_out.err()))
}

fn format_command_output(
    stdout: &[u8],
    stderr: &[u8],
    status: Option<std::process::ExitStatus>,
) -> String {
    let mut text = String::new();
    let stdout = String::from_utf8_lossy(stdout);
    let stderr = String::from_utf8_lossy(stderr);
    if !stdout.is_empty() {
        text.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&stderr);
    }
    match status {
        Some(status) if !status.success() => {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&format!("exit {}", status.code().unwrap_or(-1)));
        }
        None => {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&format!("command timed out after {CMD_TIMEOUT_SECS}s"));
        }
        Some(_) => {}
    }
    if text.len() > CMD_OUTPUT_LIMIT {
        text.truncate(CMD_OUTPUT_LIMIT);
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
