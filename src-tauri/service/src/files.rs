use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use crate::error::{Error, Result};

const READ_LIMIT: usize = 400_000;
const WRITE_LIMIT: usize = 2_000_000;

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
    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(trimmed)
        .current_dir(workspace)
        .output()
        .map_err(|err| Error::Other(format!("could not start command: {err}")))?;
    let mut text = String::new();
    text.push_str(&String::from_utf8_lossy(&output.stdout));
    if !output.stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    if !output.status.success() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&format!("exit {}", output.status.code().unwrap_or(-1)));
    }
    if text.len() > 80_000 {
        text.truncate(80_000);
        text.push_str("\n…truncated");
    }
    if text.is_empty() {
        text = "(no output)".into();
    }
    Ok(text)
}

pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf> {
    let root = fs::canonicalize(root).map_err(|_| Error::Other("workspace folder is missing".into()))?;
    let rel = normalize(rel)?;
    let joined = if rel.as_os_str().is_empty() { root.clone() } else { root.join(&rel) };
    if let Ok(canon) = fs::canonicalize(&joined) {
        if canon == root || canon.starts_with(&root) {
            return Ok(canon);
        }
        return Err(Error::Other("path is outside the workspace".into()));
    }
    if let Some(parent) = joined.parent() {
        if let Ok(parent) = fs::canonicalize(parent) {
            if parent == root || parent.starts_with(&root) {
                return Ok(parent.join(joined.file_name().unwrap_or_default()));
            }
        }
    }
    if joined.starts_with(&root) {
        Ok(joined)
    } else {
        Err(Error::Other("path is outside the workspace".into()))
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
