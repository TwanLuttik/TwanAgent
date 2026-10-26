//! Workspace search shared by the desktop and the hosted server.
//!
//! `grep` finds lines. `glob` finds paths. Both stay inside the workspace and skip the
//! same heavy trees `list_dir` already ignores. The result is plain text the model reads.

use std::fs;
use std::path::Path;

use crate::error::{Error, Result};
use crate::files;

const MAX_MATCHES: usize = 100;
const MAX_FILES: usize = 200;
const MAX_OUTPUT: usize = 40_000;
const SNIPPET: usize = 240;

const HEAVY_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".git",
    "__pycache__",
    ".next",
    ".turbo",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrepQuery {
    pub pattern: String,
    pub path: String,
    pub glob: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobQuery {
    pub pattern: String,
    pub path: String,
}

pub fn grep(workspace: &Path, query: &GrepQuery) -> Result<String> {
    let pattern = query.pattern.trim();
    if pattern.is_empty() {
        return Err(Error::Other("pattern is empty".into()));
    }
    let needle = pattern.to_ascii_lowercase();
    let glob = query.glob.trim();
    let workspace = files::resolve(workspace, "")?;
    let root = files::resolve(&workspace, &query.path)?;
    if !root.exists() {
        return Err(Error::Other("path was not found".into()));
    }
    let mut hits: Vec<String> = Vec::new();
    let mut truncated = false;
    if root.is_file() {
        scan_file(&workspace, &root, &needle, glob, &mut hits, &mut truncated)?;
    } else if root.is_dir() {
        walk_grep(&workspace, &root, &needle, glob, &mut hits, &mut truncated)?;
    } else {
        return Err(Error::Other("path was not found".into()));
    }
    Ok(finish(
        &hits,
        truncated || hits.len() >= MAX_MATCHES,
        &grep_empty(pattern, query.path.trim(), glob),
    ))
}

pub fn glob(workspace: &Path, query: &GlobQuery) -> Result<String> {
    let pattern = query.pattern.trim();
    if pattern.is_empty() {
        return Err(Error::Other("pattern is empty".into()));
    }
    let workspace = files::resolve(workspace, "")?;
    let root = files::resolve(&workspace, &query.path)?;
    if !root.is_dir() {
        return Err(Error::Other("path is not a folder".into()));
    }
    let mut hits: Vec<String> = Vec::new();
    let mut truncated = false;
    walk_glob(&workspace, &root, pattern, &mut hits, &mut truncated)?;
    hits.sort();
    Ok(finish(&hits, truncated || hits.len() >= MAX_FILES, "No files."))
}

fn walk_grep(
    workspace: &Path,
    dir: &Path,
    needle: &str,
    glob: &str,
    hits: &mut Vec<String>,
    truncated: &mut bool,
) -> Result<()> {
    if hits.len() >= MAX_MATCHES {
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
        if hits.len() >= MAX_MATCHES {
            *truncated = true;
            return Ok(());
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if HEAVY_DIRS.contains(&name.as_str()) {
            continue;
        }
        let full = entry.path();
        let dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        if dir {
            walk_grep(workspace, &full, needle, glob, hits, truncated)?;
        } else if entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
            scan_file(workspace, &full, needle, glob, hits, truncated)?;
        }
    }
    Ok(())
}

fn scan_file(
    workspace: &Path,
    path: &Path,
    needle: &str,
    glob: &str,
    hits: &mut Vec<String>,
    truncated: &mut bool,
) -> Result<()> {
    if hits.len() >= MAX_MATCHES {
        *truncated = true;
        return Ok(());
    }
    let rel = relative(workspace, path);
    if !matches_glob(glob, &rel) {
        return Ok(());
    }
    let text = match files::read_file(workspace, &rel) {
        Ok(text) => text,
        Err(_) => return Ok(()),
    };
    for (index, line) in text.lines().enumerate() {
        if hits.len() >= MAX_MATCHES {
            *truncated = true;
            return Ok(());
        }
        if line.to_ascii_lowercase().contains(needle) {
            hits.push(format!("{rel}:{}:{}", index + 1, clip(line)));
        }
    }
    Ok(())
}

fn walk_glob(
    workspace: &Path,
    dir: &Path,
    pattern: &str,
    hits: &mut Vec<String>,
    truncated: &mut bool,
) -> Result<()> {
    if hits.len() >= MAX_FILES {
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
        if hits.len() >= MAX_FILES {
            *truncated = true;
            return Ok(());
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if HEAVY_DIRS.contains(&name.as_str()) {
            continue;
        }
        let full = entry.path();
        let rel = relative(workspace, &full);
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        if matches_glob(pattern, &rel) {
            hits.push(rel);
        }
        if is_dir {
            walk_glob(workspace, &full, pattern, hits, truncated)?;
        }
    }
    Ok(())
}

fn relative(workspace: &Path, path: &Path) -> String {
    path.strip_prefix(workspace)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn clip(line: &str) -> String {
    let trimmed = line.trim();
    let mut chars = trimmed.chars();
    let taken: String = chars.by_ref().take(SNIPPET).collect();
    if chars.next().is_some() {
        format!("{taken}…")
    } else {
        taken
    }
}

/// What the model reads when nothing matched. Names the pattern and glob so a
/// miss is not mistaken for a file type the search skipped.
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

fn finish(hits: &[String], truncated: bool, empty: &str) -> String {
    if hits.is_empty() {
        return empty.to_string();
    }
    let mut text = hits.join("\n");
    if truncated {
        text.push_str("\n…results truncated");
    }
    if text.len() > MAX_OUTPUT {
        let mut end = MAX_OUTPUT;
        while !text.is_char_boundary(end) && end > 0 {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n…results truncated");
    }
    text
}

/// A file glob matches the whole path, or just the file name when it has no slash.
/// `*.ts` finds `src/app.ts`. `src/**/*.ts` does not match `other/app.ts`.
pub fn matches_glob(pattern: &str, rel: &str) -> bool {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return true;
    }
    if glob_match(pattern, rel) {
        return true;
    }
    if pattern.contains('/') {
        return false;
    }
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name != rel && glob_match(pattern, name)
}

/// `*` matches inside one path segment. `**` matches across segments, including none.
pub fn glob_match(pattern: &str, path: &str) -> bool {
    let pattern = pattern.trim().trim_start_matches("./");
    let path = path.trim().trim_start_matches("./");
    if pattern.is_empty() {
        return false;
    }
    match_parts(
        &split_glob(pattern),
        &path.split('/').filter(|part| !part.is_empty()).collect::<Vec<_>>(),
    )
}

fn split_glob(pattern: &str) -> Vec<&str> {
    pattern
        .split('/')
        .filter(|part| !part.is_empty())
        .collect()
}

fn match_parts(pattern: &[&str], path: &[&str]) -> bool {
    if pattern.is_empty() {
        return path.is_empty();
    }
    if pattern[0] == "**" {
        if match_parts(&pattern[1..], path) {
            return true;
        }
        return !path.is_empty() && match_parts(pattern, &path[1..]);
    }
    if path.is_empty() {
        return false;
    }
    segment_match(pattern[0], path[0]) && match_parts(&pattern[1..], &path[1..])
}

/// `*` and `?` match Unicode scalar values, not bytes. A byte-wise `*` would
/// fail to match `*.ts` against a name that contains a multibyte character.
fn segment_match(pattern: &str, text: &str) -> bool {
    segment_at(
        &pattern.chars().collect::<Vec<_>>(),
        &text.chars().collect::<Vec<_>>(),
    )
}

fn segment_at(pattern: &[char], text: &[char]) -> bool {
    let mut pi = 0;
    let mut ti = 0;
    let mut star: Option<(usize, usize)> = None;
    while ti < text.len() {
        if pi < pattern.len() && (pattern[pi] == '?' || eq_ignore_char(pattern[pi], text[ti])) {
            pi += 1;
            ti += 1;
            continue;
        }
        if pi < pattern.len() && pattern[pi] == '*' {
            star = Some((pi, ti));
            pi += 1;
            continue;
        }
        if let Some((sp, st)) = star {
            pi = sp + 1;
            ti = st + 1;
            star = Some((sp, ti));
            continue;
        }
        return false;
    }
    while pi < pattern.len() && pattern[pi] == '*' {
        pi += 1;
    }
    pi == pattern.len()
}

fn eq_ignore_char(left: char, right: char) -> bool {
    left.to_ascii_lowercase() == right.to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        fs::write(dir.path().join("src/app.ts"), "export const answer = 42;\n").unwrap();
        fs::write(dir.path().join("src/note.md"), "Answer lives in app.ts\n").unwrap();
        fs::write(dir.path().join("node_modules/pkg/skip.ts"), "export const answer = 1;\n").unwrap();
        fs::write(dir.path().join("README.md"), "# Demo\n").unwrap();
        dir
    }

    #[test]
    fn grep_finds_lines_and_skips_heavy_dirs() {
        let dir = sample();
        let text = grep(
            dir.path(),
            &GrepQuery {
                pattern: "answer".into(),
                path: String::new(),
                glob: "*.ts".into(),
            },
        )
        .unwrap();
        assert!(text.contains("src/app.ts:1:"), "{text}");
        assert!(!text.contains("node_modules"));
        assert!(!text.contains("note.md"));
        let none = grep(
            dir.path(),
            &GrepQuery {
                pattern: "missing-symbol".into(),
                path: "src".into(),
                glob: String::new(),
            },
        )
        .unwrap();
        assert!(none.contains("No matches for \"missing-symbol\" in src."), "{none}");
        assert!(none.contains(".ts"), "{none}");
        assert!(none.contains("not a regular expression"), "{none}");
        let err = grep(
            dir.path(),
            &GrepQuery {
                pattern: "  ".into(),
                path: String::new(),
                glob: String::new(),
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("empty"));
    }

    #[test]
    fn glob_lists_matching_paths() {
        let dir = sample();
        let text = glob(
            dir.path(),
            &GlobQuery {
                pattern: "**/*.ts".into(),
                path: String::new(),
            },
        )
        .unwrap();
        assert!(text.contains("src/app.ts"));
        assert!(!text.contains("node_modules"));
        assert!(!text.contains("README.md"));
        let none = glob(
            dir.path(),
            &GlobQuery {
                pattern: "*.rs".into(),
                path: String::new(),
            },
        )
        .unwrap();
        assert_eq!(none, "No files.");
    }

    #[test]
    fn glob_match_covers_stars_and_double_stars() {
        assert!(glob_match("*.ts", "app.ts"));
        assert!(!glob_match("*.ts", "src/app.ts"));
        assert!(matches_glob("*.ts", "src/app.ts"));
        assert!(matches_glob("src/*.ts", "src/app.ts"));
        assert!(!matches_glob("src/*.ts", "other/app.ts"));
        assert!(glob_match("**/*.ts", "src/app.ts"));
        assert!(glob_match("src/**/*.ts", "src/lib/app.ts"));
        assert!(glob_match("**/app.ts", "app.ts"));
        assert!(!glob_match("*.ts", "src/app.ts"));
        assert!(!glob_match("src/*.ts", "src/lib/app.ts"));
        assert!(glob_match("App.TS", "app.ts"));
        // A byte-wise `*` stops inside the multibyte character and misses `.ts`.
        assert!(matches_glob("*.ts", "src/café.ts"));
        assert!(matches_glob("*.tsx", "pages/コンピューター.tsx"));
        assert!(glob_match("*.ts", "café.ts"));
        assert!(!matches_glob("*.ts", "src/café.tsx"));
    }
}
