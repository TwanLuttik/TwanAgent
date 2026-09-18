use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use super::paths::{path_string, resolve_in_workspace};
use super::types::{DevEntry, FilePreview};
use crate::error::{Error, Result};

const READ_LIMIT: usize = 400_000;
const WRITE_LIMIT: usize = 2_000_000;
const PREVIEW_BYTES: usize = 8_192;
const PREVIEW_LINES: usize = 8;
const PREVIEW_COLS: usize = 96;

pub fn list_dir(workspace: &Path, rel: &str) -> Result<Vec<DevEntry>> {
    let root = resolve_in_workspace(workspace, "")?;
    let dir = resolve_in_workspace(workspace, rel)?;
    if !dir.is_dir() {
        return Err(Error::Other("not a folder".into()));
    }
    let mut rows = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let full = entry.path();
        let rel_path = crate::paths::relative_to(&root, &full).unwrap_or_else(|| name.clone());
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let kind = if meta.is_dir() { "dir" } else { "file" };
        rows.push(DevEntry {
            name,
            path: rel_path,
            kind: kind.into(),
            size: if meta.is_file() {
                Some(meta.len())
            } else {
                None
            },
        });
    }
    rows.sort_by(|a, b| {
        a.kind.cmp(&b.kind).then_with(|| {
            a.name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase())
        })
    });
    // dirs first: "dir" < "file"
    Ok(rows)
}

pub fn read_file(workspace: &Path, rel: &str) -> Result<String> {
    let path = resolve_in_workspace(workspace, rel)?;
    if !path.is_file() {
        return Err(Error::Other("not a file".into()));
    }
    let meta = fs::metadata(&path)?;
    if meta.len() > READ_LIMIT as u64 {
        return Err(Error::Other(format!(
            "file is larger than {} bytes",
            READ_LIMIT
        )));
    }
    let mut file = fs::File::open(&path)?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    if buf.contains(&0) {
        return Err(Error::Other("binary file".into()));
    }
    String::from_utf8(buf).map_err(|_| Error::Other("file is not valid UTF-8".into()))
}

pub fn resolve_file(workspace: &Path, rel: &str) -> Result<String> {
    let path = resolve_in_workspace(workspace, rel)?;
    if !path.is_file() {
        return Err(Error::Other("not a file".into()));
    }
    Ok(path_string(&path))
}

pub fn file_preview(workspace: &Path, rel: &str) -> Result<FilePreview> {
    let path = resolve_in_workspace(workspace, rel)?;
    if !path.is_file() {
        return Err(Error::Other("not a file".into()));
    }
    let meta = fs::metadata(&path)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| rel.to_string());
    let modified = meta.modified().ok().and_then(system_time_ms);
    let size = meta.len();
    let mut file = fs::File::open(&path)?;
    let take = (size as usize).min(PREVIEW_BYTES);
    let mut buf = vec![0u8; take];
    let n = file.read(&mut buf)?;
    buf.truncate(n);
    let binary = buf.contains(&0);
    if binary {
        return Ok(FilePreview {
            path: rel.replace('\\', "/"),
            name,
            size,
            binary: true,
            lines: None,
            preview: None,
            modified,
        });
    }
    let text = String::from_utf8_lossy(&buf);
    let complete = (n as u64) >= size;
    Ok(FilePreview {
        path: rel.replace('\\', "/"),
        name,
        size,
        binary: false,
        lines: if complete {
            Some(count_lines(&text))
        } else {
            None
        },
        preview: Some(preview_excerpt(&text)),
        modified,
    })
}

fn system_time_ms(time: SystemTime) -> Option<i64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

fn count_lines(text: &str) -> u32 {
    if text.is_empty() {
        return 0;
    }
    let mut n = text.matches('\n').count() as u32;
    if !text.ends_with('\n') {
        n += 1;
    }
    n
}

fn preview_excerpt(text: &str) -> String {
    text.lines()
        .take(PREVIEW_LINES)
        .map(|line| {
            let mut chars = line.chars();
            let taken: String = chars.by_ref().take(PREVIEW_COLS).collect();
            if chars.next().is_some() {
                format!("{taken}…")
            } else {
                taken
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn existing_files(workspace: &Path, rels: &[String]) -> Vec<String> {
    rels.iter()
        .filter(|rel| {
            resolve_in_workspace(workspace, rel)
                .map(|path| path.is_file())
                .unwrap_or(false)
        })
        .cloned()
        .collect()
}

pub fn write_file(workspace: &Path, rel: &str, contents: &str) -> Result<()> {
    if contents.len() > WRITE_LIMIT {
        return Err(Error::Other(format!(
            "write is larger than {} bytes",
            WRITE_LIMIT
        )));
    }
    let path = resolve_in_workspace(workspace, rel)?;
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
        return Err(Error::Other(format!(
            "old_string matched {matches} times — make it unique"
        )));
    }
    write_file(workspace, rel, &current.replacen(old, new, 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn temp_ws() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn write_read_edit_roundtrip() {
        let dir = temp_ws();
        write_file(dir.path(), "src/hello.txt", "hello world").unwrap();
        assert_eq!(
            read_file(dir.path(), "src/hello.txt").unwrap(),
            "hello world"
        );
        edit_file(dir.path(), "src/hello.txt", "world", "there").unwrap();
        assert_eq!(
            read_file(dir.path(), "src/hello.txt").unwrap(),
            "hello there"
        );
        let err = edit_file(dir.path(), "src/hello.txt", "missing", "x").unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    #[test]
    fn resolve_file_returns_absolute_path_for_binary() {
        let dir = temp_ws();
        fs::create_dir_all(dir.path().join("icons")).unwrap();
        fs::write(
            dir.path().join("icons/128x128@2x.png"),
            [0x89, b'P', b'N', b'G', 0],
        )
        .unwrap();
        let path = resolve_file(dir.path(), "icons/128x128@2x.png").unwrap();
        assert!(Path::new(&path).is_absolute());
        assert!(path.ends_with("128x128@2x.png"));
        let err = resolve_file(dir.path(), "icons").unwrap_err();
        assert!(err.to_string().contains("not a file"));
        let binary = read_file(dir.path(), "icons/128x128@2x.png").unwrap_err();
        assert!(binary.to_string().contains("binary"));
    }

    #[test]
    fn edit_requires_unique_match() {
        let dir = temp_ws();
        write_file(dir.path(), "a.txt", "foo foo").unwrap();
        let err = edit_file(dir.path(), "a.txt", "foo", "bar").unwrap_err();
        assert!(err.to_string().contains("2 times"));
    }

    #[test]
    fn existing_files_returns_only_real_files() {
        let dir = temp_ws();
        write_file(dir.path(), "src/lib/dev.ts", "ok").unwrap();
        fs::create_dir_all(dir.path().join("src/lib")).unwrap();
        let found = existing_files(
            dir.path(),
            &[
                "src/lib/dev.ts".into(),
                "src/lib".into(),
                "missing.rs".into(),
                "../escape.rs".into(),
            ],
        );
        assert_eq!(found, vec!["src/lib/dev.ts"]);
    }

    #[test]
    fn file_preview_returns_excerpt_and_line_count() {
        let dir = temp_ws();
        write_file(dir.path(), "src/hello.ts", "export const a = 1;\nexport const b = 2;\n").unwrap();
        let preview = file_preview(dir.path(), "src/hello.ts").unwrap();
        assert_eq!(preview.name, "hello.ts");
        assert_eq!(preview.lines, Some(2));
        assert_eq!(preview.binary, false);
        assert!(preview.preview.unwrap().contains("export const a"));
        assert!(preview.size > 0);
    }

    #[test]
    fn file_preview_marks_binary() {
        let dir = temp_ws();
        fs::create_dir_all(dir.path().join("icons")).unwrap();
        fs::write(dir.path().join("icons/a.png"), [0x89, b'P', b'N', b'G', 0]).unwrap();
        let preview = file_preview(dir.path(), "icons/a.png").unwrap();
        assert_eq!(preview.binary, true);
        assert_eq!(preview.preview, None);
        assert_eq!(preview.lines, None);
    }

    #[test]
    fn list_dir_sorts_dirs_first() {
        let dir = temp_ws();
        fs::create_dir_all(dir.path().join("b")).unwrap();
        fs::write(dir.path().join("a.txt"), "x").unwrap();
        let rows = list_dir(dir.path(), "").unwrap();
        assert_eq!(
            rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            ["b", "a.txt"]
        );
    }
}
