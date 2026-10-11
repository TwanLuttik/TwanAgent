use std::collections::HashMap;
use std::io::{ErrorKind, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use super::paths::resolve_in_workspace;
use crate::env_path::command_path;
use crate::error::{Error, Result};

pub(crate) const CMD_OUTPUT_LIMIT: usize = 80_000;
const CMD_TIMEOUT_SECS: u64 = 60;
/// A command that backgrounds itself (a server, `cmd &`) only has to start.
const CMD_DETACH_SECS: u64 = 3;
const DETACH_PID_MARKER: &str = "\u{1e}bg:";
/// Double-fork into a new session, then run the command with the user's shell.
const DETACH_LAUNCHER: &str = r#"import os, sys
cmd = sys.argv[1]
read_fd, write_fd = os.pipe()
if os.fork() > 0:
    os.close(write_fd)
    data = b""
    while True:
        chunk = os.read(read_fd, 64)
        if not chunk:
            break
        data += chunk
    os.wait()
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()
    raise SystemExit(0)
os.close(read_fd)
os.setsid()
pid = os.fork()
if pid == 0:
    os.close(write_fd)
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.execvp("sh", ["sh", "-c", cmd])
os.write(write_fd, ("\u001ebg:%d\n" % os.getpid()).encode())
os.close(write_fd)
os._exit(0)
"#;

struct LiveCommand {
    /// The detached job. A trailing `&` is moved into its own session, so this is that session.
    pid: u32,
}

fn live_commands() -> &'static Mutex<HashMap<String, LiveCommand>> {
    static LIVE: OnceLock<Mutex<HashMap<String, LiveCommand>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Stop a command that was left running in the background. Missing ids are already gone.
pub fn stop_command(id: &str) -> Result<()> {
    let live = live_commands()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .remove(id);
    let Some(live) = live else {
        return Ok(());
    };
    kill_process_group(live.pid);
    Ok(())
}

fn remember_command(id: &str, pid: u32) {
    if id.is_empty() || pid == 0 {
        return;
    }
    live_commands()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .insert(id.to_string(), LiveCommand { pid });
}

fn forget_command(id: &str) {
    if id.is_empty() {
        return;
    }
    live_commands()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .remove(id);
}

fn kill_process_group(pid: u32) {
    #[cfg(unix)]
    {
        // The launcher's session leader has already exited. Its child, the command, is left behind.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .status();
    }
}

#[cfg(unix)]
fn set_nonblocking(fd: i32) {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags >= 0 {
        unsafe {
            libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
    }
}

/// Append newly available bytes. Returns how many were added, so a live view can show only those.
fn read_available(file: &mut impl Read, buf: &mut Vec<u8>) -> usize {
    let before = buf.len();
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
    buf.len().saturating_sub(before)
}

fn emit_fresh(buf: &[u8], added: usize, on_chunk: &mut impl FnMut(&str)) {
    if added == 0 {
        return;
    }
    let start = buf.len().saturating_sub(added);
    let start = floor_char_boundary(buf, start);
    if start >= buf.len() {
        return;
    }
    let text = String::from_utf8_lossy(&buf[start..]);
    if !text.is_empty() {
        on_chunk(&text);
    }
}

fn floor_char_boundary(buf: &[u8], mut index: usize) -> usize {
    if index >= buf.len() {
        return buf.len();
    }
    while index > 0 && (buf[index] & 0b1100_0000) == 0b1000_0000 {
        index -= 1;
    }
    index
}

fn strip_detach_marker(text: &str) -> String {
    let Some(marker) = text.rfind(DETACH_PID_MARKER) else {
        return text.to_string();
    };
    let mut end = marker + DETACH_PID_MARKER.len();
    let bytes = text.as_bytes();
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    if end < bytes.len() && bytes[end] == b'\n' {
        end += 1;
    }
    let mut out = String::new();
    out.push_str(&text[..marker]);
    out.push_str(&text[end..]);
    out
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
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
    run_command_streaming(workspace, command, "", |_| {})
}

/// True when the shell is asked to leave the command running, as `cmd &` does.
/// The runner then returns once the shell exits and leaves that process alive.
pub fn command_detaches(command: &str) -> bool {
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in command.chars() {
        if let Some(open) = quote {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' && open != '\'' {
                escaped = true;
                continue;
            }
            if ch == open {
                quote = None;
            }
            continue;
        }
        if ch == '\\' {
            escaped = !escaped;
            continue;
        }
        escaped = false;
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            continue;
        }
        if ch == '&' {
            return true;
        }
    }
    false
}

/// Run a shell command and call `on_chunk` with each piece of stdout or stderr as it arrives.
/// The returned string is the same capped result the model sees.
/// `id` lets the app stop a command that was left running in the background.
pub fn run_command_streaming(
    workspace: &Path,
    command: &str,
    id: &str,
    mut on_chunk: impl FnMut(&str),
) -> Result<String> {
    let root = resolve_in_workspace(workspace, "")?;
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(Error::Other("command is empty".into()));
    }
    let detaches = command_detaches(trimmed);
    // macOS has no setsid, so a short Python double-fork starts a new session and prints its pid.
    // The job keeps this stdout until the shell exits, so its startup output still streams.
    let script = if detaches && !cfg!(windows) {
        let inner = trimmed.trim_end_matches(|ch: char| ch.is_whitespace() || ch == '&');
        format!(
            "python3 -c {launcher} {quoted}",
            launcher = shell_single_quote(DETACH_LAUNCHER),
            quoted = shell_single_quote(inner),
        )
    } else {
        trimmed.to_string()
    };
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", &script]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", &script]);
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
    let limit = if detaches {
        Duration::from_secs(CMD_DETACH_SECS)
    } else {
        Duration::from_secs(CMD_TIMEOUT_SECS)
    };
    let outcome = loop {
        let out_added = read_available(&mut stdout, &mut out_buf);
        let err_added = read_available(&mut stderr, &mut err_buf);
        emit_fresh(&out_buf, out_added, &mut on_chunk);
        emit_fresh(&err_buf, err_added, &mut on_chunk);
        match child.try_wait() {
            Ok(Some(status)) => {
                let out_added = read_available(&mut stdout, &mut out_buf);
                let err_added = read_available(&mut stderr, &mut err_buf);
                emit_fresh(&out_buf, out_added, &mut on_chunk);
                emit_fresh(&err_buf, err_added, &mut on_chunk);
                // `cmd &` makes the shell exit immediately and leave the job running.
                if detaches && status.success() {
                    break CommandWait::Detached;
                }
                forget_command(id);
                break CommandWait::Exited(status);
            }
            Ok(None) if started.elapsed() > limit => {
                if detaches {
                    // The job is still running. Return once it has reported its pid, and keep
                    // reading here until it does so the startup output is not lost.
                    if detached_pid(&out_buf).is_some() {
                        break CommandWait::Detached;
                    }
                    if started.elapsed() > Duration::from_secs(CMD_TIMEOUT_SECS) {
                        break CommandWait::Detached;
                    }
                    thread::sleep(Duration::from_millis(40));
                    continue;
                }
                kill_command_tree(&mut child);
                forget_command(id);
                let out_added = read_available(&mut stdout, &mut out_buf);
                let err_added = read_available(&mut stderr, &mut err_buf);
                emit_fresh(&out_buf, out_added, &mut on_chunk);
                emit_fresh(&err_buf, err_added, &mut on_chunk);
                break CommandWait::TimedOut;
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(e) => {
                forget_command(id);
                return Err(Error::Other(e.to_string()));
            }
        }
    };
    if matches!(outcome, CommandWait::Detached) {
        if let Some(pid) = detached_pid(&out_buf) {
            remember_command(id, pid);
        }
    }
    Ok(format_command_output(&out_buf, &err_buf, outcome))
}

enum CommandWait {
    Exited(std::process::ExitStatus),
    TimedOut,
    Detached,
}

fn detached_pid(stdout: &[u8]) -> Option<u32> {
    let text = String::from_utf8_lossy(stdout);
    let marker = text.rfind(DETACH_PID_MARKER)?;
    let digits = text[marker + DETACH_PID_MARKER.len()..]
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>();
    let pid = digits.parse::<u32>().ok()?;
    if pid == 0 { None } else { Some(pid) }
}

fn format_command_output(stdout: &[u8], stderr: &[u8], outcome: CommandWait) -> String {
    let mut text = String::new();
    let stdout = strip_detach_marker(&String::from_utf8_lossy(stdout));
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
    match outcome {
        CommandWait::Exited(status) if !status.success() => {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&format!("exit {}", status.code().unwrap_or(-1)));
        }
        CommandWait::TimedOut => {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&format!("command timed out after {CMD_TIMEOUT_SECS}s"));
        }
        CommandWait::Detached => {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str("still running in the background");
        }
        CommandWait::Exited(_) => {}
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
    fn run_command_streaming_reports_each_chunk_once() {
        let dir = temp_ws();
        let cmd = if cfg!(windows) {
            "echo hello-stream"
        } else {
            "printf 'hello-stream\\n'"
        };
        let mut seen = String::new();
        let out = run_command_streaming(dir.path(), cmd, "", |chunk| seen.push_str(chunk)).unwrap();
        assert!(seen.contains("hello-stream"), "live chunks were {seen:?}");
        assert!(out.contains("hello-stream"));
        assert_eq!(seen.matches("hello-stream").count(), 1);
    }

    #[test]
    fn detach_marker_is_hidden_from_the_model() {
        let raw = format!("ready\n{DETACH_PID_MARKER}4321\n");
        assert_eq!(detached_pid(raw.as_bytes()), Some(4321));
        assert_eq!(strip_detach_marker(&raw), "ready\n");
        assert_eq!(strip_detach_marker("plain"), "plain");
    }

    #[test]
    fn command_detaches_only_for_a_background_job() {
        assert!(command_detaches("swift run HelloWorld &"));
        assert!(command_detaches("npm start > log.txt 2>&1 &"));
        assert!(command_detaches("cmd1 && cmd2 &"));
        assert!(!command_detaches("swift run HelloWorld"));
        assert!(!command_detaches("echo 'leave this & alone'"));
        assert!(!command_detaches("echo \"quoted & ampersand\""));
    }

    #[test]
    fn run_command_leaves_a_background_job_running() {
        let dir = temp_ws();
        let started = std::time::Instant::now();
        let out = run_command_streaming(dir.path(), "sleep 30 &", "bg-sleep", |_| {}).unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "background command blocked the tool"
        );
        assert!(out.contains("still running in the background"), "{out}");
        thread::sleep(Duration::from_millis(200));
        let listed = run_command(dir.path(), "ps -ax -o pid=,command=").unwrap();
        let alive = listed.lines().any(|line| {
            let command = line.trim().split_once(' ').map(|(_, command)| command.trim());
            command == Some("sleep 30") || command.is_some_and(|text| text.ends_with(" sleep 30"))
        });
        assert!(alive, "background process was killed: {listed}");
        stop_command("bg-sleep").unwrap();
        let gone = std::time::Instant::now();
        while gone.elapsed() < Duration::from_secs(2) {
            let listed = run_command(dir.path(), "ps -ax -o command=").unwrap();
            let still = listed.lines().any(|line| {
                let command = line.trim();
                command == "sleep 30" || command.ends_with(" sleep 30")
            });
            if !still {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("stop did not kill the background process");
    }

    #[test]
    fn run_command_keeps_background_startup_output() {
        let dir = temp_ws();
        let out = run_command(dir.path(), "echo hello-bg &").unwrap();
        assert!(out.contains("hello-bg"), "{out}");
        assert!(out.contains("still running in the background"), "{out}");
        assert!(!out.contains('\u{1e}'), "{out}");
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
