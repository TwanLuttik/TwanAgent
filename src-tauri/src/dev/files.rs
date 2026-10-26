use std::fs;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use base64::Engine;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::paths::{path_string, resolve_in_workspace};
use super::types::{DevEntry, FilePreview, TreeSnapshot};
use crate::error::{Error, Result};

const READ_LIMIT: usize = 400_000;
const PDF_READ_LIMIT: u64 = 80 * 1024 * 1024;
const WRITE_LIMIT: usize = 2_000_000;
const PREVIEW_BYTES: usize = 8_192;
const PREVIEW_LINES: usize = 8;
const PREVIEW_COLS: usize = 96;

const TREE_SKIP: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".git",
    "worktrees",
    "__pycache__",
    ".next",
    ".turbo",
];

/// Bumped by every mutating helper so a same-second create still misses the cache.
static TREE_GENERATION: AtomicU64 = AtomicU64::new(0);

struct CachedTree {
    generation: u64,
    /// Directories visited by the last walk, including the workspace root.
    dir_mtimes: Vec<(PathBuf, SystemTime)>,
    snapshot: TreeSnapshot,
}

fn tree_cache() -> &'static Mutex<std::collections::HashMap<PathBuf, CachedTree>> {
    static CACHE: OnceLock<Mutex<std::collections::HashMap<PathBuf, CachedTree>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn bump_tree_generation() {
    TREE_GENERATION.fetch_add(1, Ordering::Relaxed);
}

fn dir_mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|meta| meta.modified()).ok()
}

/// True when every recorded directory still exists with the same mtime.
fn dirs_unchanged(dirs: &[(PathBuf, SystemTime)]) -> bool {
    dirs.iter()
        .all(|(path, cached)| dir_mtime(path) == Some(*cached))
}

/// Stable fingerprint of file and folder paths. Content edits do not change it.
pub fn tree_snapshot(workspace: &Path) -> Result<TreeSnapshot> {
    let root = resolve_in_workspace(workspace, "")?;
    let generation = TREE_GENERATION.load(Ordering::Relaxed);
    if let Ok(cache) = tree_cache().lock() {
        if let Some(cached) = cache.get(&root) {
            if cached.generation == generation && dirs_unchanged(&cached.dir_mtimes) {
                return Ok(cached.snapshot.clone());
            }
        }
    }
    let mut rows = Vec::new();
    let mut dir_mtimes = Vec::new();
    walk_tree(&root, &root, &mut rows, &mut dir_mtimes)?;
    rows.sort();
    let snapshot = TreeSnapshot {
        signature: hash_rows(&rows),
        dirs: rows
            .iter()
            .filter_map(|row| row.strip_prefix("d\t").map(str::to_string))
            .collect(),
        files: rows
            .iter()
            .filter_map(|row| row.strip_prefix("f\t").map(str::to_string))
            .collect(),
    };
    if let Ok(mut cache) = tree_cache().lock() {
        cache.insert(
            root,
            CachedTree {
                generation,
                dir_mtimes,
                snapshot: snapshot.clone(),
            },
        );
    }
    Ok(snapshot)
}

fn hash_rows(rows: &[String]) -> String {
    let mut hasher = sha2::Sha256::new();
    use sha2::Digest;
    for row in rows {
        hasher.update(row.as_bytes());
        hasher.update(b"\n");
    }
    hex::encode(hasher.finalize())
}

fn walk_tree(
    root: &Path,
    dir: &Path,
    rows: &mut Vec<String>,
    dir_mtimes: &mut Vec<(PathBuf, SystemTime)>,
) -> Result<()> {
    // Record the directory before reading it. A failed read still counts: the next call
    // stats it again, and a later successful read replaces the cache.
    if let Some(mtime) = dir_mtime(dir) {
        dir_mtimes.push((dir.to_path_buf(), mtime));
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if TREE_SKIP.contains(&name.as_str()) {
            continue;
        }
        let full = entry.path();
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        let rel = crate::paths::relative_to(root, &full).unwrap_or(name);
        let rel = rel.replace('\\', "/");
        if meta.is_dir() {
            rows.push(format!("d\t{rel}"));
            walk_tree(root, &full, rows, dir_mtimes)?;
        } else if meta.is_file() {
            rows.push(format!("f\t{rel}"));
        }
    }
    Ok(())
}

pub fn list_dir(workspace: &Path, rel: &str) -> Result<Vec<DevEntry>> {
    let root = resolve_in_workspace(workspace, "")?;
    let dir = resolve_in_workspace(workspace, rel)?;
    // A remembered folder can be deleted or renamed between sessions. That is an
    // empty listing, not a file. A real file still has to say so.
    if !dir.exists() {
        return Ok(Vec::new());
    }
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

/// A PDF as base64. The webview cannot fetch `asset://` itself, so the bytes come from here.
pub fn read_pdf_base64(workspace: &Path, rel: &str) -> Result<String> {
    let path = resolve_in_workspace(workspace, rel)?;
    if !path.is_file() {
        return Err(Error::Other("not a file".into()));
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !name.ends_with(".pdf") {
        return Err(Error::Other("not a PDF".into()));
    }
    let len = fs::metadata(&path)?.len();
    if len > PDF_READ_LIMIT {
        return Err(Error::Other("This PDF is too large to open.".into()));
    }
    let bytes = fs::read(&path)?;
    if bytes.len() < 5 || &bytes[..5] != b"%PDF-" {
        return Err(Error::Other("This file is not a PDF.".into()));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
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

fn file_name_of(rel: &str) -> Result<String> {
    let path = Path::new(rel.trim().trim_matches('/'));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty() && n != "." && n != "..")
        .ok_or_else(|| Error::Other("invalid name".into()))?;
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(Error::Other("invalid name".into()));
    }
    Ok(name)
}

fn parent_rel(rel: &str) -> String {
    match Path::new(rel).parent() {
        Some(parent) => parent.to_string_lossy().replace('\\', "/"),
        None => String::new(),
    }
}

fn join_rel(dir: &str, name: &str) -> String {
    let dir = dir.trim_matches('/');
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

fn is_within(path: &str, dir: &str) -> bool {
    let path = path.trim_matches('/');
    let dir = dir.trim_matches('/');
    if dir.is_empty() {
        return true;
    }
    path == dir || path.starts_with(&format!("{dir}/"))
}

/// Move or rename one file or folder. `to` is the destination path, including the new name.
pub fn move_path(workspace: &Path, from: &str, to: &str) -> Result<String> {
    let from_rel = from.trim().trim_matches('/');
    let to_rel = to.trim().trim_matches('/');
    if from_rel.is_empty() {
        return Err(Error::Other("cannot move the workspace root".into()));
    }
    if to_rel.is_empty() {
        return Err(Error::Other("invalid destination".into()));
    }
    if from_rel == to_rel {
        return Ok(from_rel.to_string());
    }
    if is_within(to_rel, from_rel) {
        return Err(Error::Other("cannot move a folder into itself".into()));
    }
    let _ = file_name_of(to_rel)?;
    let src = resolve_in_workspace(workspace, from_rel)?;
    if !src.exists() {
        return Err(Error::Other("not found".into()));
    }
    let dest = resolve_in_workspace(workspace, to_rel)?;
    if dest.exists() {
        return Err(Error::Other("something with that name already exists".into()));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&src, &dest)?;
    bump_tree_generation();
    Ok(to_rel.replace('\\', "/"))
}

pub fn rename_path(workspace: &Path, rel: &str, name: &str) -> Result<String> {
    let rel = rel.trim().trim_matches('/');
    if rel.is_empty() {
        return Err(Error::Other("cannot rename the workspace root".into()));
    }
    let name = file_name_of(name)?;
    move_path(workspace, rel, &join_rel(&parent_rel(rel), &name))
}

pub fn delete_paths(workspace: &Path, rels: &[String]) -> Result<()> {
    let mut paths: Vec<String> = rels
        .iter()
        .map(|rel| rel.trim().trim_matches('/').to_string())
        .filter(|rel| !rel.is_empty())
        .collect();
    paths.sort();
    paths.dedup();
    // A selected folder already covers anything selected inside it.
    let tops: Vec<String> = paths
        .iter()
        .filter(|rel| {
            !paths
                .iter()
                .any(|other| *other != **rel && is_within(rel, other))
        })
        .cloned()
        .collect();
    if tops.is_empty() {
        return Err(Error::Other("nothing to delete".into()));
    }
    for rel in &tops {
        let path = resolve_in_workspace(workspace, rel)?;
        if path.is_dir() {
            fs::remove_dir_all(&path)?;
        } else if path.is_file() {
            fs::remove_file(&path)?;
        } else {
            return Err(Error::Other(format!("not found: {rel}")));
        }
    }
    bump_tree_generation();
    Ok(())
}

pub fn create_dir(workspace: &Path, parent: &str, name: &str) -> Result<String> {
    let name = file_name_of(name)?;
    let rel = join_rel(parent.trim().trim_matches('/'), &name);
    let path = resolve_in_workspace(workspace, &rel)?;
    if path.exists() {
        return Err(Error::Other("something with that name already exists".into()));
    }
    fs::create_dir_all(&path)?;
    bump_tree_generation();
    Ok(rel)
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
    let creating = !path.is_file();
    fs::write(&path, contents)?;
    // A new file changes the tree. Rewriting one that already exists does not.
    if creating {
        bump_tree_generation();
    }
    Ok(())
}

const SEARCH_MATCHES: usize = 100;
const SEARCH_FILES: usize = 200;
const SEARCH_OUTPUT: usize = 40_000;
const SEARCH_SNIPPET: usize = 240;

/// Case-insensitive content search. Heavy trees are skipped. Lines come back as `path:line:text`.
pub fn grep(workspace: &Path, pattern: &str, rel: &str, glob_pattern: &str) -> Result<String> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Err(Error::Other("pattern is empty".into()));
    }
    let needle = pattern.to_ascii_lowercase();
    let glob_pattern = glob_pattern.trim();
    let root = resolve_in_workspace(workspace, "")?;
    let start = resolve_in_workspace(workspace, rel)?;
    if !start.exists() {
        return Err(Error::Other("path was not found".into()));
    }
    let mut hits = Vec::new();
    let mut truncated = false;
    if start.is_file() {
        scan_search_file(&root, &start, &needle, glob_pattern, &mut hits, &mut truncated);
    } else if start.is_dir() {
        walk_grep(&root, &start, &needle, glob_pattern, &mut hits, &mut truncated)?;
    } else {
        return Err(Error::Other("path was not found".into()));
    }
    Ok(search_text(
        &hits,
        truncated || hits.len() >= SEARCH_MATCHES,
        &grep_empty(pattern, rel.trim(), glob_pattern),
    ))
}

/// Path search. `*` stays in one segment. `**` crosses folders. Heavy trees are skipped.
pub fn glob(workspace: &Path, pattern: &str, rel: &str) -> Result<String> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Err(Error::Other("pattern is empty".into()));
    }
    let root = resolve_in_workspace(workspace, "")?;
    let start = resolve_in_workspace(workspace, rel)?;
    if !start.is_dir() {
        return Err(Error::Other("path is not a folder".into()));
    }
    let mut hits = Vec::new();
    let mut truncated = false;
    walk_glob(&root, &start, pattern, &mut hits, &mut truncated)?;
    hits.sort();
    Ok(search_text(&hits, truncated || hits.len() >= SEARCH_FILES, "No files."))
}

fn walk_grep(
    root: &Path,
    dir: &Path,
    needle: &str,
    glob_pattern: &str,
    hits: &mut Vec<String>,
    truncated: &mut bool,
) -> Result<()> {
    if hits.len() >= SEARCH_MATCHES {
        *truncated = true;
        return Ok(());
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    let mut rows: Vec<_> = entries.filter_map(|entry| entry.ok()).collect();
    rows.sort_by_key(|entry| entry.file_name());
    for entry in rows {
        if hits.len() >= SEARCH_MATCHES {
            *truncated = true;
            return Ok(());
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if TREE_SKIP.contains(&name.as_str()) {
            continue;
        }
        let full = entry.path();
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.is_dir() {
            walk_grep(root, &full, needle, glob_pattern, hits, truncated)?;
        } else if meta.is_file() {
            scan_search_file(root, &full, needle, glob_pattern, hits, truncated);
        }
    }
    Ok(())
}

fn scan_search_file(root: &Path, path: &Path, needle: &str, glob_pattern: &str, hits: &mut Vec<String>, truncated: &mut bool) {
    if hits.len() >= SEARCH_MATCHES {
        *truncated = true;
        return;
    }
    let rel = search_rel(root, path);
    if !twanagent_service::matches_glob(glob_pattern, &rel) {
        return;
    }
    let Ok(text) = read_file(root, &rel) else {
        return;
    };
    for (index, line) in text.lines().enumerate() {
        if hits.len() >= SEARCH_MATCHES {
            *truncated = true;
            return;
        }
        if line.to_ascii_lowercase().contains(needle) {
            hits.push(format!("{rel}:{}:{}", index + 1, search_clip(line)));
        }
    }
}

fn walk_glob(root: &Path, dir: &Path, pattern: &str, hits: &mut Vec<String>, truncated: &mut bool) -> Result<()> {
    if hits.len() >= SEARCH_FILES {
        *truncated = true;
        return Ok(());
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    let mut rows: Vec<_> = entries.filter_map(|entry| entry.ok()).collect();
    rows.sort_by_key(|entry| entry.file_name());
    for entry in rows {
        if hits.len() >= SEARCH_FILES {
            *truncated = true;
            return Ok(());
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if TREE_SKIP.contains(&name.as_str()) {
            continue;
        }
        let full = entry.path();
        let rel = search_rel(root, &full);
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        if twanagent_service::matches_glob(pattern, &rel) {
            hits.push(rel);
        }
        if is_dir {
            walk_glob(root, &full, pattern, hits, truncated)?;
        }
    }
    Ok(())
}

fn search_rel(root: &Path, path: &Path) -> String {
    crate::paths::relative_to(root, path)
        .unwrap_or_else(|| path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default())
        .replace('\\', "/")
}

fn search_clip(line: &str) -> String {
    let trimmed = line.trim();
    let mut chars = trimmed.chars();
    let taken: String = chars.by_ref().take(SEARCH_SNIPPET).collect();
    if chars.next().is_some() { format!("{taken}…") } else { taken }
}

/// Names the pattern and glob so a miss is not mistaken for a skipped file type.
fn grep_empty(pattern: &str, path: &str, glob: &str) -> String {
    let where_text = if path.is_empty() { "the workspace" } else { path };
    let mut text = format!("No matches for \"{pattern}\" in {where_text}.");
    if glob.is_empty() {
        text.push_str(" Searched every text file. .ts, .tsx, and other source files are included.");
    } else {
        text.push_str(&format!(" File glob: {glob}."));
    }
    text.push_str(" This is a case-insensitive substring, not a regular expression. Nothing was skipped because of its extension.");
    text
}

fn search_text(hits: &[String], truncated: bool, empty: &str) -> String {
    if hits.is_empty() {
        return empty.to_string();
    }
    let mut text = hits.join("\n");
    if truncated {
        text.push_str("\n…results truncated");
    }
    if text.len() > SEARCH_OUTPUT {
        let mut end = SEARCH_OUTPUT;
        while !text.is_char_boundary(end) && end > 0 {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n…results truncated");
    }
    text
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
        write_file(
            dir.path(),
            "src/hello.ts",
            "export const a = 1;\nexport const b = 2;\n",
        )
        .unwrap();
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
    fn rename_move_create_and_delete() {
        let dir = temp_ws();
        write_file(dir.path(), "src/a.txt", "a").unwrap();
        fs::create_dir_all(dir.path().join("src/keep")).unwrap();
        assert_eq!(rename_path(dir.path(), "src/a.txt", "b.txt").unwrap(), "src/b.txt");
        assert!(dir.path().join("src/b.txt").is_file());
        let made = create_dir(dir.path(), "src", "box").unwrap();
        assert_eq!(made, "src/box");
        assert_eq!(
            move_path(dir.path(), "src/b.txt", "src/box/b.txt").unwrap(),
            "src/box/b.txt"
        );
        let into_self = move_path(dir.path(), "src", "src/box/nested").unwrap_err();
        assert!(into_self.to_string().contains("itself"));
        let clash = move_path(dir.path(), "src/keep", "src/box").unwrap_err();
        assert!(clash.to_string().contains("already exists"));
        delete_paths(
            dir.path(),
            &["src/box/b.txt".into(), "src/box".into(), "src/keep".into()],
        )
        .unwrap();
        assert!(!dir.path().join("src/box").exists());
        assert!(!dir.path().join("src/keep").exists());
        assert!(dir.path().join("src").is_dir());
    }

    #[test]
    fn delete_rejects_workspace_root() {
        let dir = temp_ws();
        let err = delete_paths(dir.path(), &["".into(), "/".into()]).unwrap_err();
        assert!(err.to_string().contains("nothing"));
        assert!(dir.path().is_dir());
    }

    #[test]
    fn tree_signature_changes_when_files_are_created_renamed_or_deleted() {
        let dir = temp_ws();
        let first = tree_snapshot(dir.path()).unwrap();
        write_file(dir.path(), "src/a.txt", "a").unwrap();
        let created = tree_snapshot(dir.path()).unwrap();
        assert_ne!(first.signature, created.signature);
        write_file(dir.path(), "src/a.txt", "edited contents").unwrap();
        assert_eq!(tree_snapshot(dir.path()).unwrap().signature, created.signature);
        fs::create_dir_all(dir.path().join("node_modules")).unwrap();
        fs::write(dir.path().join("node_modules/pkg.js"), "x").unwrap();
        fs::create_dir_all(dir.path().join("worktrees/feat-login")).unwrap();
        fs::write(dir.path().join("worktrees/feat-login/README.md"), "x").unwrap();
        assert_eq!(tree_snapshot(dir.path()).unwrap().signature, created.signature);
        rename_path(dir.path(), "src/a.txt", "b.txt").unwrap();
        let renamed = tree_snapshot(dir.path()).unwrap();
        assert_ne!(renamed.signature, created.signature);
        delete_paths(dir.path(), &["src/b.txt".into()]).unwrap();
        assert_ne!(tree_snapshot(dir.path()).unwrap().signature, renamed.signature);
    }

    #[test]
    fn tree_snapshot_reuses_the_cached_tree_until_a_path_changes() {
        let dir = temp_ws();
        write_file(dir.path(), "src/a.txt", "a").unwrap();
        let first = tree_snapshot(dir.path()).unwrap();
        let second = tree_snapshot(dir.path()).unwrap();
        assert_eq!(second.signature, first.signature);
        assert_eq!(second.dirs, first.dirs);
        assert_eq!(second.files, first.files);
        write_file(dir.path(), "src/a.txt", "only the contents changed").unwrap();
        let edited = tree_snapshot(dir.path()).unwrap();
        assert_eq!(edited.signature, first.signature);
        write_file(dir.path(), "src/b.txt", "b").unwrap();
        assert_ne!(tree_snapshot(dir.path()).unwrap().signature, first.signature);
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

    #[test]
    fn grep_and_glob_skip_heavy_dirs() {
        let dir = temp_ws();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        fs::write(dir.path().join("src/app.ts"), "export const answer = 42;\n").unwrap();
        fs::write(dir.path().join("node_modules/pkg/skip.ts"), "export const answer = 1;\n").unwrap();
        let found = grep(dir.path(), "answer", "", "*.ts").unwrap();
        assert!(found.contains("src/app.ts:1:"));
        assert!(!found.contains("node_modules"));
        let paths = glob(dir.path(), "**/*.ts", "").unwrap();
        assert!(paths.contains("src/app.ts"));
        assert!(!paths.contains("node_modules"));
        let none = grep(dir.path(), "missing", "src", "*.ts").unwrap();
        assert!(none.contains("No matches for \"missing\" in src."), "{none}");
        assert!(none.contains("File glob: *.ts."), "{none}");
        assert!(none.contains("not a regular expression"), "{none}");
        fs::write(dir.path().join("src/café.ts"), "export const answer = 7;\n").unwrap();
        let unicode = grep(dir.path(), "answer", "", "*.ts").unwrap();
        assert!(unicode.contains("src/café.ts:"), "{unicode}");
        assert!(grep(dir.path(), "  ", "", "").is_err());
    }

    #[test]
    fn list_dir_treats_a_missing_folder_as_empty_and_a_file_as_an_error() {
        let dir = temp_ws();
        fs::write(dir.path().join("readme.txt"), "x").unwrap();
        assert!(list_dir(dir.path(), "src/gone").unwrap().is_empty());
        let err = list_dir(dir.path(), "readme.txt").unwrap_err();
        assert!(err.to_string().contains("not a folder"));
    }
}
