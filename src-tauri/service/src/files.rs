use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::error::{Error, Result};

const READ_LIMIT: usize = 400_000;
const WRITE_LIMIT: usize = 2_000_000;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(600);

thread_local! {
    static COMMAND_CANCEL: std::cell::Cell<Option<Arc<AtomicBool>>> = const { std::cell::Cell::new(None) };
}

/// The turn sets this so Stop can kill the command `run_command` is waiting on.
pub fn set_command_cancel(flag: Option<Arc<AtomicBool>>) {
    COMMAND_CANCEL.with(|slot| slot.set(flag));
}

pub fn read_file(workspace: &Path, rel: &str) -> Result<String> {
    let path = resolve(workspace, rel)?;
    if !path.is_file() {
        return Err(Error::Other("not a file".into()));
    }
    let meta = fs::metadata(&path)?;
    if meta.len() > READ_LIMIT as u64 {
        return Err(Error::Other(format!("file is larger than {READ_LIMIT} bytes")));
    }
    let mut file = fs::File::open(&path)?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    if buf.contains(&0) {
        return Err(Error::Other("binary file".into()));
    }
    String::from_utf8(buf).map_err(|_| Error::Other("file is not valid UTF-8".into()))
}

pub fn write_file(workspace: &Path, rel: &str, contents: &str) -> Result<()> {
    if contents.len() > WRITE_LIMIT {
        return Err(Error::Other(format!("write is larger than {WRITE_LIMIT} bytes")));
    }
    let path = resolve(workspace, rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)?;
    Ok(())
}

pub fn edit_file(workspace: &Path, rel: &str, old: &str, new: &str) -> Result<()> {
    if old.is_empty() {
        return Err(Error::Other("old_string is empty".into()));
    }
    let current = read_file(workspace, rel)?;
    let matches = current.matches(old).count();
    if matches == 0 {
        return Err(Error::Other("old_string was not found".into()));
    }
    if matches > 1 {
        return Err(Error::Other(format!("old_string matched {matches} times — make it unique")));
    }
    write_file(workspace, rel, &current.replacen(old, new, 1))
}

pub fn list_dir(workspace: &Path, rel: &str) -> Result<Vec<(String, bool)>> {
    let dir = resolve(workspace, rel)?;
    if !dir.is_dir() {
        return Err(Error::Other("not a folder".into()));
    }
    let mut rows = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        rows.push((name, dir));
    }
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.to_ascii_lowercase().cmp(&b.0.to_ascii_lowercase())));
    Ok(rows)
}

pub fn run_command(workspace: &Path, command: &str) -> Result<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(Error::Other("command is empty".into()));
    }
    let cancel = COMMAND_CANCEL.with(|slot| slot.take());
    let outcome = run_command_timed(workspace, trimmed, cancel.as_ref(), COMMAND_TIMEOUT);
    COMMAND_CANCEL.with(|slot| slot.set(cancel));
    outcome
}

fn run_command_timed(
    workspace: &Path,
    command: &str,
    cancel: Option<&Arc<AtomicBool>>,
    timeout: Duration,
) -> Result<String> {
    let mut cmd = std::process::Command::new("sh");
    cmd.arg("-c").arg(command).current_dir(workspace);
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                extern "C" {
                    fn setsid() -> i32;
                }
                let _ = setsid();
                Ok(())
            });
        }
    }
    let mut child = cmd
        .spawn()
        .map_err(|err| Error::Other(format!("could not start command: {err}")))?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    #[cfg(unix)]
    {
        if let Some(pipe) = stdout.as_ref() {
            set_nonblocking(pipe);
        }
        if let Some(pipe) = stderr.as_ref() {
            set_nonblocking(pipe);
        }
    }
    let mut out = Vec::new();
    let mut err = Vec::new();
    let started = std::time::Instant::now();
    let status = loop {
        drain_pipe(stdout.as_mut(), &mut out);
        drain_pipe(stderr.as_mut(), &mut err);
        if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            kill_child(&mut child);
            return Ok("Skipped: stopped.".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > timeout => {
                kill_child(&mut child);
                return Ok(format!("command timed out after {}s", timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(error) => return Err(Error::Other(error.to_string())),
        }
    };
    drain_pipe(stdout.as_mut(), &mut out);
    drain_pipe(stderr.as_mut(), &mut err);
    format_output(&out, &err, &status)
}

fn drain_pipe(pipe: Option<&mut impl Read>, buf: &mut Vec<u8>) {
    let Some(pipe) = pipe else { return };
    let mut chunk = [0u8; 8192];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() < 80_001 {
                    let room = 80_001usize.saturating_sub(buf.len());
                    buf.extend_from_slice(&chunk[..n.min(room)]);
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(_) => break,
        }
    }
}

#[cfg(unix)]
fn set_nonblocking(file: &impl std::os::fd::AsRawFd) {
    let fd = file.as_raw_fd();
    extern "C" {
        fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    }
    const F_GETFL: i32 = 3;
    const F_SETFL: i32 = 4;
    const O_NONBLOCK: i32 = 0x0004;
    unsafe {
        let flags = fcntl(fd, F_GETFL);
        if flags >= 0 {
            let _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK);
        }
    }
}

fn format_output(stdout: &[u8], stderr: &[u8], status: &std::process::ExitStatus) -> Result<String> {
    let mut text = String::new();
    let out = String::from_utf8_lossy(stdout);
    let err = String::from_utf8_lossy(stderr);
    if !out.is_empty() {
        text.push_str(&out);
    }
    if !err.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&err);
    }
    if !status.success() {
        if !text.is_empty() {
            text.push('\n');
        }
        match status.code() {
            Some(code) => text.push_str(&format!("exit {code}")),
            None => text.push_str("exit signal"),
        }
    }
    if text.len() > 80_000 {
        let mut end = 80_000;
        while !text.is_char_boundary(end) && end > 0 {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n…truncated");
    }
    if text.is_empty() {
        text = "(no output)".into();
    }
    Ok(text)
}

fn kill_child(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        #[allow(unused_unsafe)]
        unsafe {
            libc_kill(-pid, 9);
            libc_kill(pid, 9);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

#[cfg(unix)]
fn libc_kill(pid: i32, sig: i32) -> i32 {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe { kill(pid, sig) }
}



pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf> {
    let root = fs::canonicalize(root).map_err(|_| Error::Other("workspace folder is missing".into()))?;
    let rel = normalize(rel)?;
    if rel.as_os_str().is_empty() {
        return Ok(root);
    }
    // Walk every existing ancestor. A symlink to a folder outside the workspace is rejected
    // before a new file is created inside it. Checking only the final path lets the write through.
    let mut cursor = root.clone();
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let parts: Vec<_> = rel.components().collect();
    for (index, part) in parts.iter().enumerate() {
        let Component::Normal(name) = part else {
            return Err(Error::Other("path must be relative to the workspace".into()));
        };
        let next = cursor.join(name);
        match fs::symlink_metadata(&next) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    let canon = fs::canonicalize(&next).map_err(|_| Error::Other("path is outside the workspace".into()))?;
                    if !inside(&root, &canon) {
                        return Err(Error::Other("path is outside the workspace".into()));
                    }
                    cursor = canon;
                } else if index + 1 == parts.len() {
                    return Ok(next);
                } else if meta.is_dir() {
                    cursor = next;
                } else {
                    return Err(Error::Other("not a folder".into()));
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                missing.push(name.to_os_string());
                missing.extend(parts[index + 1..].iter().filter_map(|part| match part {
                    Component::Normal(name) => Some(name.to_os_string()),
                    _ => None,
                }));
                break;
            }
            Err(err) => return Err(err.into()),
        }
    }
    if !inside(&root, &cursor) {
        return Err(Error::Other("path is outside the workspace".into()));
    }
    for part in missing {
        cursor.push(part);
    }
    Ok(cursor)
}

fn inside(root: &Path, path: &Path) -> bool {
    path == root || path.starts_with(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_file_under_a_symlink_cannot_leave_the_workspace() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
            let err = resolve(root.path(), "link/planted.txt").unwrap_err();
            assert!(err.to_string().contains("outside"), "{err}");
            let nested = write_file(root.path(), "link/a/planted.txt", "nope");
            assert!(nested.is_err(), "a nested write must not follow the symlink");
            assert!(!outside.path().join("planted.txt").exists());
            assert!(!outside.path().join("a").exists());
            std::fs::write(outside.path().join("secret.txt"), "nope").unwrap();
            std::os::unix::fs::symlink(outside.path().join("secret.txt"), root.path().join("filelink")).unwrap();
            assert!(read_file(root.path(), "filelink").is_err());
        }
        let _ = (root, outside);
    }

    #[test]
    fn a_file_inside_the_workspace_still_resolves() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("src")).unwrap();
        write_file(root.path(), "src/note.txt", "hi").unwrap();
        assert_eq!(read_file(root.path(), "src/note.txt").unwrap(), "hi");
        assert_eq!(read_file(root.path(), "src/./note.txt").unwrap(), "hi");
        assert!(resolve(root.path(), "../secret").is_err());
    }
}

fn normalize(rel: &str) -> Result<PathBuf> {
    let trimmed = rel.trim();
    if trimmed.is_empty() || trimmed == "." {
        return Ok(PathBuf::new());
    }
    if trimmed.starts_with('/') || trimmed.starts_with('\\') || Path::new(trimmed).is_absolute() {
        return Err(Error::Other("path must be relative to the workspace".into()));
    }
    let mut out = PathBuf::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => out.push(part),
            Component::ParentDir => {
                if !out.pop() {
                    return Err(Error::Other("path is outside the workspace".into()));
                }
            }
            _ => return Err(Error::Other("path must be relative to the workspace".into())),
        }
    }
    Ok(out)
}
