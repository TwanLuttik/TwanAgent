use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{Error, Result};
use crate::paths::is_under;
use crate::secrets;
use crate::state::AppState;

const READ_LIMIT: usize = 400_000;
const WRITE_LIMIT: usize = 2_000_000;
const CMD_OUTPUT_LIMIT: usize = 80_000;
const CMD_TIMEOUT_SECS: u64 = 60;
use crate::grok_cli;

fn streams() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static STREAMS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn resolve_in_workspace(root: &Path, rel: &str) -> Result<PathBuf> {
    let root =
        fs::canonicalize(root).map_err(|_| Error::Other("workspace folder is missing".into()))?;
    if !root.is_dir() {
        return Err(Error::Other("workspace is not a folder".into()));
    }
    let rel = normalize_rel(rel)?;
    if rel.as_os_str().is_empty() {
        return Ok(root);
    }
    let joined = root.join(&rel);
    if let Ok(canon) = fs::canonicalize(&joined) {
        ensure_inside(&root, &canon)?;
        return Ok(canon);
    }
    let mut ancestor = joined.parent().unwrap_or(root.as_path()).to_path_buf();
    let mut missing = vec![joined
        .file_name()
        .ok_or_else(|| Error::Other("invalid path".into()))?
        .to_os_string()];
    while !ancestor.exists() {
        if let Some(name) = ancestor.file_name() {
            missing.push(name.to_os_string());
        }
        match ancestor.parent() {
            Some(parent) => ancestor = parent.to_path_buf(),
            None => break,
        }
    }
    let ancestor = fs::canonicalize(&ancestor).unwrap_or_else(|_| root.clone());
    ensure_inside(&root, &ancestor)?;
    missing.reverse();
    let mut out = ancestor;
    for part in missing {
        out.push(part);
    }
    ensure_inside(&root, &out)?;
    Ok(out)
}

fn normalize_rel(rel: &str) -> Result<PathBuf> {
    if rel.contains('\0') {
        return Err(Error::Other("invalid path".into()));
    }
    let trimmed = rel.trim();
    if trimmed.is_empty() || trimmed == "." {
        return Ok(PathBuf::new());
    }
    if trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || Path::new(trimmed).is_absolute()
        || (trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':')
    {
        return Err(Error::Other(
            "path must be relative to the workspace".into(),
        ));
    }
    let path = Path::new(trimmed);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => out.push(part),
            Component::ParentDir => {
                if !out.pop() {
                    return Err(Error::Other("path is outside the workspace".into()));
                }
            }
            _ => {
                return Err(Error::Other(
                    "path must be relative to the workspace".into(),
                ))
            }
        }
    }
    Ok(out)
}

fn ensure_inside(root: &Path, path: &Path) -> Result<()> {
    if path == root || is_under(path, root) {
        Ok(())
    } else {
        Err(Error::Other("path is outside the workspace".into()))
    }
}

fn workspace_id(root: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(root.as_bytes());
    hex::encode(&hasher.finalize()[..8])
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn projects_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("projects")
}

fn path_string(path: &Path) -> String {
    crate::paths::native_source(&path.to_string_lossy())
}

fn resolve_typed_path(raw: &str) -> Result<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(Error::Other("folder path is empty".into()));
    }
    if trimmed.contains('\0') {
        return Err(Error::Other("invalid path".into()));
    }
    let mut path = if trimmed == "~" {
        home_dir().ok_or_else(|| Error::Other("home folder is unknown".into()))?
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        home_dir()
            .ok_or_else(|| Error::Other("home folder is unknown".into()))?
            .join(rest)
    } else if let Some(rest) = trimmed.strip_prefix("~\\") {
        home_dir()
            .ok_or_else(|| Error::Other("home folder is unknown".into()))?
            .join(rest)
    } else {
        PathBuf::from(trimmed)
    };
    if !path.is_absolute() {
        if let Some(home) = home_dir() {
            let under_home = home.join(&path);
            if under_home.is_dir() {
                path = under_home;
            }
        }
    }
    Ok(path)
}

pub fn expand_folder_path(raw: &str) -> Result<PathBuf> {
    let path = resolve_typed_path(raw)?;
    let canon = fs::canonicalize(&path)
        .map_err(|_| Error::Other(format!("folder not found: {}", path.display())))?;
    if !canon.is_dir() {
        return Err(Error::Other("not a folder".into()));
    }
    Ok(canon)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderSuggestion {
    pub name: String,
    pub path: String,
}

pub fn suggest_folders(raw: &str) -> Vec<FolderSuggestion> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let Ok(path) = resolve_typed_path(trimmed) else {
        return Vec::new();
    };
    let (dir, prefix) = if path.is_dir() {
        (path, String::new())
    } else {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "C:\\" } else { "/" }));
        let prefix = path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        (parent, prefix)
    };
    if !dir.is_dir() {
        return Vec::new();
    }
    let prefix_l = prefix.to_ascii_lowercase();
    let hide_dot = !prefix.starts_with('.');
    let mut rows = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if hide_dot && name.starts_with('.') {
            continue;
        }
        if !prefix_l.is_empty() && !name.to_ascii_lowercase().starts_with(&prefix_l) {
            continue;
        }
        rows.push(FolderSuggestion {
            name: name.clone(),
            path: path_string(&dir.join(&name)),
        });
        if rows.len() > 80 {
            break;
        }
    }
    rows.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    rows.truncate(40);
    rows
}

pub fn sanitize_project_name(raw: &str) -> Result<String> {
    let s = raw.trim();
    if s.is_empty() || s == "." || s == ".." {
        return Err(Error::Other("type a project name".into()));
    }
    if s.contains('/') || s.contains('\\') || s.contains('\0') {
        return Err(Error::Other("project name cannot contain a path".into()));
    }
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' {
            out.push(ch);
            prev_dash = false;
        } else if ch == '-' || ch.is_whitespace() {
            if !out.is_empty() && !prev_dash {
                out.push('-');
                prev_dash = true;
            }
        }
    }
    let cleaned = out.trim_matches(|c| c == '-' || c == '.').to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return Err(Error::Other("type a project name".into()));
    }
    Ok(cleaned.chars().take(80).collect())
}

pub fn repo_name_from_url(url: &str) -> Result<String> {
    let s = url
        .trim()
        .trim_end_matches(['/', '\\'])
        .trim_end_matches(".git")
        .trim_end_matches(".GIT");
    let part = s
        .rsplit(['/', ':', '\\'])
        .find(|p| !p.is_empty())
        .ok_or_else(|| Error::Other("could not read a folder name from that git URL".into()))?;
    sanitize_project_name(part)
}

fn validate_git_url(url: &str) -> Result<&str> {
    let url = url.trim();
    if url.is_empty() {
        return Err(Error::Other("git URL is empty".into()));
    }
    if url.contains('\0') || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(Error::Other("invalid git URL".into()));
    }
    let ok = url.starts_with("https://")
        || url.starts_with("http://")
        || url.starts_with("git@")
        || url.starts_with("ssh://")
        || url.starts_with("git://")
        || url.starts_with("file://");
    if !ok {
        return Err(Error::Other(
            "git URL must start with https://, git@, or ssh://".into(),
        ));
    }
    Ok(url)
}

pub fn create_project(data_dir: &Path, name: &str) -> Result<PathBuf> {
    let name = sanitize_project_name(name)?;
    let dest = projects_dir(data_dir).join(&name);
    if dest.exists() {
        return Err(Error::Conflict(format!("{name} already exists")));
    }
    fs::create_dir_all(&dest)?;
    Ok(dest)
}

pub fn list_projects(data_dir: &Path) -> Vec<FolderSuggestion> {
    let dir = projects_dir(data_dir);
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut rows = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        rows.push(FolderSuggestion {
            name: name.clone(),
            path: path_string(&dir.join(&name)),
        });
    }
    rows.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    rows
}

pub fn clone_repo(data_dir: &Path, url: &str, name: Option<&str>) -> Result<PathBuf> {
    let url = validate_git_url(url)?;
    let folder = match name {
        Some(n) if !n.trim().is_empty() => sanitize_project_name(n)?,
        _ => repo_name_from_url(url)?,
    };
    let dest = projects_dir(data_dir).join(&folder);
    if dest.exists() {
        return Err(Error::Conflict(format!("{folder} already exists")));
    }
    fs::create_dir_all(projects_dir(data_dir))?;
    let dest_str = dest
        .to_str()
        .ok_or_else(|| Error::Other("invalid path".into()))?;
    let out = Command::new("git")
        .args(["clone", "--", url, dest_str])
        .output()
        .map_err(|_| Error::Other("git is not available".into()))?;
    if !out.status.success() {
        let _ = fs::remove_dir_all(&dest);
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = err.trim();
        return Err(Error::Other(if msg.is_empty() {
            "git clone failed".into()
        } else {
            msg.chars().take(400).collect()
        }));
    }
    Ok(dest)
}

fn conv_dir(data_dir: &Path, workspace: &str) -> PathBuf {
    data_dir.join("dev").join(workspace_id(workspace))
}

fn conv_path(data_dir: &Path, workspace: &str) -> PathBuf {
    conv_dir(data_dir, workspace).join("conversations.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitChange {
    pub path: String,
    pub status: String,
    pub staged: bool,
    #[serde(default)]
    pub additions: u32,
    #[serde(default)]
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitBranches {
    pub current: Option<String>,
    pub branches: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default = "default_conversation_kind")]
    pub kind: String,
    #[serde(default)]
    pub messages: Vec<serde_json::Value>,
}

fn default_conversation_kind() -> String {
    "chat".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default = "default_conversation_kind")]
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyStatus {
    pub saved: bool,
    pub env: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DevChatEvent {
    pub stream_id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<DevToolCall>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

fn load_conversations(data_dir: &Path, workspace: &str) -> Result<Vec<Conversation>> {
    let path = conv_path(data_dir, workspace);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(path)?;
    if data.trim().is_empty() {
        return Ok(Vec::new());
    }
    Ok(serde_json::from_str(&data)?)
}

fn save_conversations(data_dir: &Path, workspace: &str, rows: &[Conversation]) -> Result<()> {
    let dir = conv_dir(data_dir, workspace);
    fs::create_dir_all(&dir)?;
    let path = dir.join("conversations.json");
    let tmp = dir.join("conversations.json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(rows)?)?;
    #[cfg(windows)]
    {
        if path.exists() {
            fs::remove_file(&path)?;
        }
    }
    fs::rename(tmp, path)?;
    Ok(())
}

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

pub fn parse_git_status(porcelain: &str) -> Vec<GitChange> {
    let mut rows = Vec::new();
    for line in porcelain.lines() {
        if line.len() < 4 {
            continue;
        }
        let x = line.as_bytes()[0] as char;
        let y = line.as_bytes()[1] as char;
        let rest = &line[3..];
        let path = if let Some((_, dest)) = rest.split_once(" -> ") {
            dest.to_string()
        } else {
            rest.to_string()
        };
        let (status, staged) = classify_git(x, y);
        rows.push(GitChange {
            path,
            status,
            staged,
            additions: 0,
            deletions: 0,
        });
    }
    rows
}

pub fn parse_git_numstat(text: &str) -> HashMap<String, (u32, u32)> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let mut parts = line.splitn(3, '\t');
        let Some(add) = parts.next() else { continue };
        let Some(del) = parts.next() else { continue };
        let Some(path) = parts.next() else { continue };
        let path = numstat_path(path);
        if path.is_empty() {
            continue;
        }
        out.insert(path, (parse_numstat_count(add), parse_numstat_count(del)));
    }
    out
}

fn parse_numstat_count(raw: &str) -> u32 {
    if raw == "-" {
        0
    } else {
        raw.parse().unwrap_or(0)
    }
}

fn numstat_path(rest: &str) -> String {
    if let Some((_, dest)) = rest.split_once(" => ") {
        dest.to_string()
    } else {
        rest.to_string()
    }
}

pub fn apply_git_stats(rows: &mut [GitChange], stats: &HashMap<String, (u32, u32)>) {
    for row in rows {
        if let Some((add, del)) = stats.get(&row.path) {
            row.additions = *add;
            row.deletions = *del;
        }
    }
}

fn count_file_lines(path: &Path) -> u32 {
    const MAX: u64 = 2_000_000;
    let Ok(meta) = fs::metadata(path) else {
        return 0;
    };
    if !meta.is_file() || meta.len() > MAX {
        return 0;
    }
    let Ok(data) = fs::read(path) else {
        return 0;
    };
    if data.is_empty() || data.contains(&0) {
        return 0;
    }
    let mut n = data.iter().filter(|b| **b == b'\n').count() as u32;
    if data.last() != Some(&b'\n') {
        n += 1;
    }
    n
}

fn git_numstat(root: &Path) -> HashMap<String, (u32, u32)> {
    if let Ok(text) = git_output(root, &["diff", "--numstat", "HEAD"]) {
        return parse_git_numstat(&text);
    }
    let mut map = HashMap::new();
    if let Ok(text) = git_output(root, &["diff", "--numstat"]) {
        map = parse_git_numstat(&text);
    }
    if let Ok(text) = git_output(root, &["diff", "--cached", "--numstat"]) {
        for (path, (add, del)) in parse_git_numstat(&text) {
            let entry = map.entry(path).or_insert((0, 0));
            entry.0 = entry.0.saturating_add(add);
            entry.1 = entry.1.saturating_add(del);
        }
    }
    map
}

fn classify_git(x: char, y: char) -> (String, bool) {
    if x == 'U' || y == 'U' || (x == 'D' && y == 'D') || (x == 'A' && y == 'A') {
        return ("conflict".into(), false);
    }
    if x == '?' && y == '?' {
        return ("untracked".into(), false);
    }
    if y == 'D' || x == 'D' && y == ' ' {
        return ("deleted".into(), x != ' ');
    }
    if y == 'A' || x == 'A' && y == ' ' {
        return ("added".into(), x != ' ');
    }
    if y == 'R' || x == 'R' {
        return ("renamed".into(), x != ' ');
    }
    if y == 'M' || x == 'M' {
        return ("modified".into(), x == 'M' && y == ' ');
    }
    if x != ' ' && x != '?' {
        return ("modified".into(), true);
    }
    ("modified".into(), false)
}

fn git_output(workspace: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(workspace)
        .output()
        .map_err(|_| Error::Other("git is not available".into()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("not a git repository") {
            return Ok(String::new());
        }
        return Err(Error::Other(err.trim().to_string()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn git_status(workspace: &Path) -> Result<Vec<GitChange>> {
    let root = resolve_in_workspace(workspace, "")?;
    let text = git_output(&root, &["status", "--porcelain=v1", "-uall"])?;
    let mut rows = parse_git_status(&text);
    if rows.is_empty() {
        return Ok(rows);
    }
    apply_git_stats(&mut rows, &git_numstat(&root));
    for row in &mut rows {
        if row.additions == 0 && row.deletions == 0 && row.status == "untracked" {
            row.additions = count_file_lines(&root.join(&row.path));
        }
    }
    Ok(rows)
}

pub fn parse_git_branches(text: &str) -> GitBranches {
    let mut current = None;
    let mut branches = Vec::new();
    for line in text.lines() {
        let raw = line.trim_end();
        if raw.is_empty() {
            continue;
        }
        let is_current = raw.starts_with('*');
        let name = raw.trim_start_matches('*').trim();
        if name.is_empty() || name.starts_with('(') {
            continue;
        }
        branches.push(name.to_string());
        if is_current {
            current = Some(name.to_string());
        }
    }
    GitBranches { current, branches }
}

pub fn sanitize_git_branch(raw: &str) -> Result<String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(Error::Other("branch name is empty".into()));
    }
    if s.starts_with('-') || s.starts_with('.') || s.ends_with('/') || s.ends_with('.') {
        return Err(Error::Other("invalid branch name".into()));
    }
    if s.contains("..") || s.contains("//") || s.contains("@{") {
        return Err(Error::Other("invalid branch name".into()));
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
    {
        return Err(Error::Other("invalid branch name".into()));
    }
    Ok(s.to_string())
}

fn git_run(workspace: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(workspace)
        .output()
        .map_err(|_| Error::Other("git is not available".into()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(Error::Other(err.trim().to_string()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn git_branches(workspace: &Path) -> Result<GitBranches> {
    let root = resolve_in_workspace(workspace, "")?;
    let text = git_output(&root, &["branch", "--list"])?;
    Ok(parse_git_branches(&text))
}

pub fn git_switch(workspace: &Path, name: &str) -> Result<GitBranches> {
    let name = sanitize_git_branch(name)?;
    let root = resolve_in_workspace(workspace, "")?;
    git_run(&root, &["switch", "--", &name])?;
    git_branches(workspace)
}

pub fn git_diff(workspace: &Path, rel: &str) -> Result<String> {
    let root = resolve_in_workspace(workspace, "")?;
    let path = rel.trim();
    let mut args = vec!["diff", "--no-color", "--"];
    if !path.is_empty() {
        let _ = resolve_in_workspace(workspace, path)?;
        args.push(path);
    }
    let unstaged = git_output(&root, &args)?;
    let mut staged_args = vec!["diff", "--no-color", "--cached", "--"];
    if !path.is_empty() {
        staged_args.push(path);
    }
    let staged = git_output(&root, &staged_args)?;
    if staged.is_empty() {
        return Ok(unstaged);
    }
    if unstaged.is_empty() {
        return Ok(staged);
    }
    Ok(format!("# staged\n{staged}\n# unstaged\n{unstaged}"))
}

pub fn run_command(workspace: &Path, command: &str) -> Result<String> {
    let root = resolve_in_workspace(workspace, "")?;
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(Error::Other("command is empty".into()));
    }
    let mut child = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", trimmed]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", trimmed]);
        c
    };
    let mut child = child
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Other(format!("could not start command: {e}")))?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > Duration::from_secs(CMD_TIMEOUT_SECS) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::Other(format!(
                    "command timed out after {CMD_TIMEOUT_SECS}s"
                )));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => return Err(Error::Other(e.to_string())),
        }
    }
    let out = child
        .wait_with_output()
        .map_err(|e| Error::Other(e.to_string()))?;
    let mut text = String::new();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !stdout.is_empty() {
        text.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&stderr);
    }
    if !out.status.success() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&format!("exit {}", out.status.code().unwrap_or(-1)));
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

fn tools_json() -> serde_json::Value {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": "List files and folders relative to the workspace root.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Relative folder path. Empty for the workspace root." }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a UTF-8 text file in the workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Create or overwrite a UTF-8 text file in the workspace. Creates parent folders.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "contents": { "type": "string" }
                    },
                    "required": ["path", "contents"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "Replace one unique occurrence of old_string with new_string in a file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "old_string": { "type": "string" },
                        "new_string": { "type": "string" }
                    },
                    "required": ["path", "old_string", "new_string"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "git_status",
                "description": "Show git status for the workspace.",
                "parameters": { "type": "object", "properties": {} }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "git_diff",
                "description": "Show the git diff. Pass a relative path to limit it to one file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "Run a shell command in the workspace. The user must approve it first.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string" }
                    },
                    "required": ["command"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "spawn_subagent",
                "description": "Start a child agent with its own context for a delegated task. Use for research, planning, or independent work. The child reports a summary when it finishes. Explore cannot edit files. Plan produces a plan without edits. General-purpose may edit.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "prompt": { "type": "string", "description": "Full task prompt for the child." },
                        "description": { "type": "string", "description": "Short 3-5 word label shown in the UI." },
                        "subagent_type": {
                            "type": "string",
                            "enum": ["general-purpose", "explore", "plan"],
                            "description": "explore investigates, plan writes a plan, general-purpose can edit."
                        }
                    },
                    "required": ["prompt", "description"]
                }
            }
        }
    ])
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_key_status(state: State<'_, AppState>) -> KeyStatus {
    KeyStatus {
        saved: secrets::get_xai_key(&state.data_dir).is_some(),
        env: std::env::var("XAI_API_KEY")
            .ok()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_runtime(state: State<'_, AppState>) -> grok_cli::DevRuntime {
    grok_cli::runtime(&state.data_dir)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_set_key(state: State<'_, AppState>, key: String) -> Result<KeyStatus> {
    secrets::set_xai_key(&state.data_dir, &key)?;
    Ok(dev_key_status(state))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_clear_key(state: State<'_, AppState>) -> Result<KeyStatus> {
    secrets::delete_xai_key(&state.data_dir)?;
    Ok(dev_key_status(state))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_projects_root(state: State<'_, AppState>) -> String {
    path_string(&projects_dir(&state.data_dir))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_list_projects(state: State<'_, AppState>) -> Vec<FolderSuggestion> {
    list_projects(&state.data_dir)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_open_folder(path: String) -> Result<String> {
    Ok(path_string(&expand_folder_path(&path)?))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_suggest_folders(path: String) -> Vec<FolderSuggestion> {
    suggest_folders(&path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_create_project(state: State<'_, AppState>, name: String) -> Result<String> {
    Ok(path_string(&create_project(&state.data_dir, &name)?))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_clone_repo(app: AppHandle, url: String, name: Option<String>) -> Result<String> {
    crate::state::run_blocking(move || {
        let state = app.state::<AppState>();
        Ok(path_string(&clone_repo(
            &state.data_dir,
            &url,
            name.as_deref(),
        )?))
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_list_dir(workspace: String, path: Option<String>) -> Result<Vec<DevEntry>> {
    list_dir(Path::new(&workspace), path.as_deref().unwrap_or(""))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_read_file(workspace: String, path: String) -> Result<String> {
    read_file(Path::new(&workspace), &path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_resolve_file(workspace: String, path: String) -> Result<String> {
    resolve_file(Path::new(&workspace), &path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_write_file(workspace: String, path: String, contents: String) -> Result<()> {
    write_file(Path::new(&workspace), &path, &contents)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_edit_file(
    workspace: String,
    path: String,
    old_string: String,
    new_string: String,
) -> Result<()> {
    edit_file(Path::new(&workspace), &path, &old_string, &new_string)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_git_status(workspace: String) -> Result<Vec<GitChange>> {
    git_status(Path::new(&workspace))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_git_diff(workspace: String, path: Option<String>) -> Result<String> {
    git_diff(Path::new(&workspace), path.as_deref().unwrap_or(""))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_git_branches(workspace: String) -> Result<GitBranches> {
    git_branches(Path::new(&workspace))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_git_switch(workspace: String, name: String) -> Result<GitBranches> {
    git_switch(Path::new(&workspace), &name)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_run_command(workspace: String, command: String) -> Result<String> {
    run_command(Path::new(&workspace), &command)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_list_conversations(
    state: State<'_, AppState>,
    workspace: String,
) -> Result<Vec<ConversationSummary>> {
    let rows = load_conversations(&state.data_dir, &workspace)?;
    Ok(rows
        .into_iter()
        .map(summary_from)
        .collect())
}

fn summary_from(c: Conversation) -> ConversationSummary {
    ConversationSummary {
        id: c.id,
        title: c.title,
        created_at: c.created_at,
        updated_at: c.updated_at,
        kind: if c.kind.is_empty() {
            default_conversation_kind()
        } else {
            c.kind
        },
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_get_conversation(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
) -> Result<Conversation> {
    load_conversations(&state.data_dir, &workspace)?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| Error::NotFound("conversation not found".into()))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_save_conversation(
    state: State<'_, AppState>,
    workspace: String,
    conversation: Conversation,
) -> Result<Conversation> {
    let mut rows = load_conversations(&state.data_dir, &workspace)?;
    if let Some(existing) = rows.iter_mut().find(|c| c.id == conversation.id) {
        *existing = conversation.clone();
    } else {
        rows.insert(0, conversation.clone());
    }
    save_conversations(&state.data_dir, &workspace, &rows)?;
    Ok(conversation)
}

pub fn apply_conversation_order(rows: Vec<Conversation>, ids: &[String]) -> Vec<Conversation> {
    let original: Vec<String> = rows.iter().map(|c| c.id.clone()).collect();
    let mut by_id: HashMap<String, Conversation> = HashMap::new();
    for row in rows {
        by_id.entry(row.id.clone()).or_insert(row);
    }
    let mut out = Vec::with_capacity(by_id.len());
    for id in ids {
        if let Some(row) = by_id.remove(id) {
            out.push(row);
        }
    }
    for id in original {
        if let Some(row) = by_id.remove(&id) {
            out.push(row);
        }
    }
    out
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_reorder_conversations(
    state: State<'_, AppState>,
    workspace: String,
    ids: Vec<String>,
) -> Result<Vec<ConversationSummary>> {
    let rows = apply_conversation_order(load_conversations(&state.data_dir, &workspace)?, &ids);
    save_conversations(&state.data_dir, &workspace, &rows)?;
    Ok(rows.into_iter().map(summary_from).collect())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_delete_conversation(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
) -> Result<()> {
    let mut rows = load_conversations(&state.data_dir, &workspace)?;
    rows.retain(|c| c.id != id);
    save_conversations(&state.data_dir, &workspace, &rows)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_chat_cancel(stream_id: String) {
    if let Ok(map) = streams().lock() {
        if let Some(flag) = map.get(&stream_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_chat_start(
    app: AppHandle,
    state: State<'_, AppState>,
    stream_id: String,
    messages: serde_json::Value,
    model: Option<String>,
    effort: Option<String>,
) -> Result<()> {
    let Some(auth) = grok_cli::resolve_auth(&state.data_dir) else {
        return Err(Error::Other(
            "Grok isn’t signed in. Run grok login, or add an xAI API key in Settings.".into(),
        ));
    };
    let model = model
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "grok-4.6".into());
    let effort = effort.filter(|s| !s.trim().is_empty());
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = streams().lock() {
        map.insert(stream_id.clone(), cancel.clone());
    }
    let app2 = app.clone();
    let sid = stream_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = stream_chat(&app2, &sid, &auth, messages, model, effort, cancel).await;
        if let Err(e) = result {
            let _ = app2.emit(
                "dev-chat",
                DevChatEvent {
                    stream_id: sid,
                    kind: "error".into(),
                    text: Some(e.to_string()),
                    tool_calls: None,
                },
            );
        }
        if let Ok(mut map) = streams().lock() {
            map.remove(&stream_id);
        }
    });
    Ok(())
}

async fn stream_chat(
    app: &AppHandle,
    stream_id: &str,
    auth: &grok_cli::GrokAuth,
    messages: serde_json::Value,
    model: String,
    effort: Option<String>,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    let mut body = serde_json::json!({
        "model": model,
        "stream": true,
        "messages": messages,
        "tools": tools_json(),
        "tool_choice": "auto",
    });
    if let Some(effort) = effort {
        body["reasoning_effort"] = serde_json::Value::String(effort);
    }
    let client = reqwest::Client::new();
    let mut req = client
        .post(grok_cli::endpoint(auth.via_cli))
        .bearer_auth(&auth.token)
        .header("content-type", "application/json")
        .header("x-grok-conv-id", stream_id);
    if auth.via_cli {
        let version = grok_cli::cli_proxy_version(
            grok_cli::grok_bin()
                .as_ref()
                .and_then(|p| grok_cli::grok_version(p))
                .as_deref(),
        );
        let headers = grok_cli::cli_proxy_headers(&version);
        req = req
            .header("x-grok-client-version", headers.client_version)
            .header("X-XAI-Token-Auth", headers.token_auth)
            .header("x-grok-client-identifier", headers.client_identifier)
            .header(reqwest::header::USER_AGENT, headers.user_agent)
            .header("x-grok-model-override", &model);
    }
    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("xAI request failed: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let msg = if status.as_u16() == 401 {
            if auth.via_cli {
                "Grok CLI login expired. Run grok login, or add an API key in Settings.".to_string()
            } else {
                "xAI rejected the API key.".to_string()
            }
        } else {
            format!(
                "xAI error {status}: {}",
                text.chars().take(400).collect::<String>()
            )
        };
        return Err(Error::Other(msg));
    }
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut tool_acc: HashMap<u32, (String, String, String)> = HashMap::new();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            let _ = app.emit(
                "dev-chat",
                DevChatEvent {
                    stream_id: stream_id.into(),
                    kind: "error".into(),
                    text: Some("Stopped.".into()),
                    tool_calls: None,
                },
            );
            return Ok(());
        }
        let chunk = chunk.map_err(|e| Error::Other(e.to_string()))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(idx) = buf.find('\n') {
            let line = buf[..idx].trim().to_string();
            buf = buf[idx + 1..].to_string();
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                let tool_calls = finish_tools(&tool_acc);
                let _ = app.emit(
                    "dev-chat",
                    DevChatEvent {
                        stream_id: stream_id.into(),
                        kind: "done".into(),
                        text: None,
                        tool_calls: if tool_calls.is_empty() {
                            None
                        } else {
                            Some(tool_calls)
                        },
                    },
                );
                return Ok(());
            }
            let Ok(json) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };
            let Some(choice) = json.get("choices").and_then(|c| c.get(0)) else {
                continue;
            };
            let delta = choice
                .get("delta")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                if !content.is_empty() {
                    let _ = app.emit(
                        "dev-chat",
                        DevChatEvent {
                            stream_id: stream_id.into(),
                            kind: "delta".into(),
                            text: Some(content.to_string()),
                            tool_calls: None,
                        },
                    );
                }
            }
            if let Some(calls) = delta.get("tool_calls").and_then(|c| c.as_array()) {
                for call in calls {
                    let index = call.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as u32;
                    let entry = tool_acc.entry(index).or_insert_with(|| {
                        (
                            call.get("id")
                                .and_then(|i| i.as_str())
                                .unwrap_or("")
                                .to_string(),
                            String::new(),
                            String::new(),
                        )
                    });
                    if let Some(id) = call.get("id").and_then(|i| i.as_str()) {
                        if !id.is_empty() {
                            entry.0 = id.to_string();
                        }
                    }
                    if let Some(name) = call
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|n| n.as_str())
                    {
                        entry.1.push_str(name);
                    }
                    if let Some(args) = call
                        .get("function")
                        .and_then(|f| f.get("arguments"))
                        .and_then(|n| n.as_str())
                    {
                        entry.2.push_str(args);
                    }
                }
            }
            if choice.get("finish_reason").and_then(|f| f.as_str()) == Some("stop")
                || choice.get("finish_reason").and_then(|f| f.as_str()) == Some("tool_calls")
            {
                // wait for [DONE]
            }
        }
    }
    let tool_calls = finish_tools(&tool_acc);
    let _ = app.emit(
        "dev-chat",
        DevChatEvent {
            stream_id: stream_id.into(),
            kind: "done".into(),
            text: None,
            tool_calls: if tool_calls.is_empty() {
                None
            } else {
                Some(tool_calls)
            },
        },
    );
    Ok(())
}

fn finish_tools(acc: &HashMap<u32, (String, String, String)>) -> Vec<DevToolCall> {
    let mut keys: Vec<u32> = acc.keys().copied().collect();
    keys.sort();
    keys.into_iter()
        .filter_map(|k| {
            let (id, name, arguments) = acc.get(&k)?;
            if name.is_empty() {
                return None;
            }
            Some(DevToolCall {
                id: if id.is_empty() {
                    format!("call_{k}")
                } else {
                    id.clone()
                },
                name: name.clone(),
                arguments: arguments.clone(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_ws() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn rejects_parent_escape() {
        let dir = temp_ws();
        let err = resolve_in_workspace(dir.path(), "../secret").unwrap_err();
        assert!(err.to_string().contains("outside"));
    }

    #[test]
    fn rejects_absolute_path() {
        let dir = temp_ws();
        let err = resolve_in_workspace(dir.path(), "/etc/passwd").unwrap_err();
        assert!(err.to_string().contains("relative"));
    }

    #[test]
    fn allows_nested_and_dot_segments() {
        let dir = temp_ws();
        fs::create_dir_all(dir.path().join("src/lib")).unwrap();
        fs::write(dir.path().join("src/lib/mod.rs"), "ok").unwrap();
        let path = resolve_in_workspace(dir.path(), "src/./lib/mod.rs").unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "ok");
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
    fn parse_git_status_lines() {
        let rows = parse_git_status(" M src/a.rs\n?? new.txt\nA  added.rs\n");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].path, "src/a.rs");
        assert_eq!(rows[0].status, "modified");
        assert_eq!(rows[1].status, "untracked");
        assert_eq!(rows[2].status, "added");
        assert!(rows[2].staged);
        assert_eq!(rows[0].additions, 0);
        assert_eq!(rows[0].deletions, 0);
    }

    #[test]
    fn parse_git_numstat_lines() {
        let stats =
            parse_git_numstat("12\t3\tsrc/a.rs\n-\t-\tphoto.png\n1\t0\told.rs => src/new.rs\n");
        assert_eq!(stats.get("src/a.rs"), Some(&(12, 3)));
        assert_eq!(stats.get("photo.png"), Some(&(0, 0)));
        assert_eq!(stats.get("src/new.rs"), Some(&(1, 0)));
        assert_eq!(stats.get("old.rs"), None);
    }

    #[test]
    fn apply_git_stats_fills_matching_paths() {
        let mut rows = parse_git_status(" M src/a.rs\n?? new.txt\n");
        let mut stats = HashMap::new();
        stats.insert("src/a.rs".into(), (12, 3));
        apply_git_stats(&mut rows, &stats);
        assert_eq!(rows[0].additions, 12);
        assert_eq!(rows[0].deletions, 3);
        assert_eq!(rows[1].additions, 0);
    }

    #[test]
    fn git_status_includes_line_counts() {
        let dir = temp_ws();
        fs::write(dir.path().join("README.md"), "hello\n").unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init", "-b", "main"]);
        git(&["config", "user.email", "dev@example.com"]);
        git(&["config", "user.name", "Dev"]);
        git(&["add", "."]);
        git(&["commit", "-m", "init"]);
        fs::write(dir.path().join("README.md"), "hello\nworld\n").unwrap();
        fs::write(dir.path().join("new.txt"), "one\ntwo\nthree\n").unwrap();
        let rows = git_status(dir.path()).unwrap();
        let readme = rows.iter().find(|r| r.path == "README.md").unwrap();
        assert_eq!(readme.status, "modified");
        assert_eq!(readme.additions, 1);
        assert_eq!(readme.deletions, 0);
        let added = rows.iter().find(|r| r.path == "new.txt").unwrap();
        assert_eq!(added.status, "untracked");
        assert_eq!(added.additions, 3);
        assert_eq!(added.deletions, 0);
    }

    #[test]
    fn parse_git_branches_marks_current() {
        let parsed = parse_git_branches("  develop\n* main\n  feature/login\n");
        assert_eq!(parsed.current.as_deref(), Some("main"));
        assert_eq!(parsed.branches, ["develop", "main", "feature/login"]);
    }

    #[test]
    fn parse_git_branches_skips_detached_head() {
        let parsed = parse_git_branches("* (HEAD detached at a1b2c3d)\n  main\n");
        assert_eq!(parsed.current, None);
        assert_eq!(parsed.branches, ["main"]);
    }

    #[test]
    fn sanitize_git_branch_rejects_unsafe_names() {
        assert_eq!(
            sanitize_git_branch("feature/login").unwrap(),
            "feature/login"
        );
        assert!(sanitize_git_branch("").is_err());
        assert!(sanitize_git_branch("-bad").is_err());
        assert!(sanitize_git_branch("foo bar").is_err());
        assert!(sanitize_git_branch("foo..bar").is_err());
        assert!(sanitize_git_branch("foo;rm").is_err());
    }

    #[test]
    fn git_switch_rejects_unsafe_name_without_running_git() {
        let dir = temp_ws();
        let err = git_switch(dir.path(), "foo;rm").unwrap_err();
        assert!(err.to_string().contains("invalid"));
    }

    #[test]
    fn git_branches_and_switch_roundtrip() {
        let dir = temp_ws();
        fs::write(dir.path().join("README.md"), "hi").unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init", "-b", "main"]);
        git(&["config", "user.email", "dev@example.com"]);
        git(&["config", "user.name", "Dev"]);
        git(&["add", "."]);
        git(&["commit", "-m", "init"]);
        git(&["branch", "feature"]);
        let listed = git_branches(dir.path()).unwrap();
        assert_eq!(listed.current.as_deref(), Some("main"));
        assert!(listed.branches.contains(&"main".into()));
        assert!(listed.branches.contains(&"feature".into()));
        let switched = git_switch(dir.path(), "feature").unwrap();
        assert_eq!(switched.current.as_deref(), Some("feature"));
    }

    #[test]
    fn sanitize_project_name_rejects_paths() {
        assert!(sanitize_project_name("My App").unwrap() == "My-App");
        assert!(sanitize_project_name("../etc").is_err());
        assert!(sanitize_project_name("foo/bar").is_err());
        assert!(sanitize_project_name(".").is_err());
        assert!(sanitize_project_name("   ").is_err());
    }

    #[test]
    fn repo_name_from_common_urls() {
        assert_eq!(
            repo_name_from_url("https://github.com/acme/widgets.git").unwrap(),
            "widgets"
        );
        assert_eq!(
            repo_name_from_url("git@github.com:acme/widgets.git").unwrap(),
            "widgets"
        );
        assert_eq!(
            repo_name_from_url("https://github.com/acme/widgets/").unwrap(),
            "widgets"
        );
    }

    #[test]
    fn suggest_folders_lists_children_and_prefix_matches() {
        let dir = temp_ws();
        fs::create_dir_all(dir.path().join("projects/apps")).unwrap();
        fs::create_dir_all(dir.path().join("projects/crates")).unwrap();
        fs::write(dir.path().join("projects/readme.txt"), "x").unwrap();
        fs::create_dir_all(dir.path().join("private")).unwrap();
        let root = dir.path().to_string_lossy();
        let kids = suggest_folders(&format!("{root}/projects"));
        let names: Vec<_> = kids.iter().map(|k| k.name.as_str()).collect();
        assert_eq!(names, ["apps", "crates"]);
        let filtered = suggest_folders(&format!("{root}/p"));
        assert!(filtered.iter().any(|k| k.name == "projects"));
        assert!(filtered.iter().any(|k| k.name == "private"));
        let one = suggest_folders(&format!("{root}/pri"));
        assert_eq!(
            one.iter().map(|k| k.name.as_str()).collect::<Vec<_>>(),
            ["private"]
        );
        assert!(suggest_folders("").is_empty());
    }

    #[test]
    fn expand_folder_path_requires_an_existing_dir() {
        let dir = temp_ws();
        let path = expand_folder_path(dir.path().to_str().unwrap()).unwrap();
        assert!(path.is_dir());
        let missing = dir.path().join("nope");
        assert!(expand_folder_path(missing.to_str().unwrap()).is_err());
        let file = dir.path().join("file.txt");
        fs::write(&file, "x").unwrap();
        assert!(expand_folder_path(file.to_str().unwrap()).is_err());
    }

    #[test]
    fn expand_tilde_uses_home() {
        let dir = temp_ws();
        let prev = std::env::var_os("HOME");
        unsafe { std::env::set_var("HOME", dir.path()) };
        fs::create_dir_all(dir.path().join("code")).unwrap();
        let got = expand_folder_path("~/code").unwrap();
        assert_eq!(got, fs::canonicalize(dir.path().join("code")).unwrap());
        match prev {
            Some(v) => unsafe { std::env::set_var("HOME", v) },
            None => unsafe { std::env::remove_var("HOME") },
        }
    }

    #[test]
    fn create_project_makes_a_folder_once() {
        let dir = temp_ws();
        let path = create_project(dir.path(), "Demo App").unwrap();
        assert!(path.is_dir());
        assert_eq!(path.file_name().unwrap(), "Demo-App");
        assert!(path.starts_with(dir.path().join("projects")));
        let err = create_project(dir.path(), "Demo App").unwrap_err();
        assert!(err.to_string().contains("already exists"));
    }

    #[test]
    fn list_projects_returns_folders_and_skips_files() {
        let dir = temp_ws();
        create_project(dir.path(), "Alpha").unwrap();
        create_project(dir.path(), "Beta").unwrap();
        fs::write(projects_dir(dir.path()).join("readme.txt"), "nope").unwrap();
        let rows = list_projects(dir.path());
        let names: Vec<_> = rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "Beta"]);
        assert!(list_projects(&dir.path().join("missing")).is_empty());
    }

    #[test]
    fn clone_repo_from_local_git() {
        let src = temp_ws();
        fs::write(src.path().join("README.md"), "hi").unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .args(args)
                .current_dir(src.path())
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init"]);
        git(&["config", "user.email", "dev@example.com"]);
        git(&["config", "user.name", "Dev"]);
        git(&["add", "."]);
        git(&["commit", "-m", "init"]);
        let dest_root = temp_ws();
        let cloned = clone_repo(
            dest_root.path(),
            &format!("file://{}", src.path().display()),
            Some("cloned-app"),
        )
        .unwrap();
        assert!(cloned.join("README.md").is_file());
        assert_eq!(cloned.file_name().unwrap(), "cloned-app");
    }

    #[test]
    fn conversations_keep_manual_order() {
        fn conv(id: &str) -> Conversation {
            Conversation {
                id: id.into(),
                title: id.into(),
                created_at: "2026-01-01T00:00:00Z".into(),
                updated_at: "2026-01-01T00:00:00Z".into(),
                kind: "chat".into(),
                messages: vec![],
            }
        }
        let rows = vec![conv("a"), conv("b"), conv("c")];
        let ordered = apply_conversation_order(rows, &["c".into(), "a".into(), "b".into()]);
        assert_eq!(
            ordered.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["c", "a", "b"]
        );
    }

    #[test]
    fn conversations_roundtrip() {
        let dir = temp_ws();
        let ws = dir.path().to_string_lossy().into_owned();
        let conv = Conversation {
            id: "c1".into(),
            title: "Hello".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            kind: "terminal".into(),
            messages: vec![serde_json::json!({"role":"user","content":"hi"})],
        };
        save_conversations(dir.path(), &ws, &[conv.clone()]).unwrap();
        let loaded = load_conversations(dir.path(), &ws).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].title, "Hello");
        assert_eq!(loaded[0].kind, "terminal");
        assert_eq!(loaded[0].messages.len(), 1);
    }

    #[test]
    fn conversations_without_kind_default_to_chat() {
        let dir = temp_ws();
        let ws = dir.path().to_string_lossy().into_owned();
        let path = super::conv_dir(dir.path(), &ws).join("conversations.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"[{"id":"old","title":"Legacy","created_at":"t","updated_at":"t","messages":[]}]"#,
        )
        .unwrap();
        let loaded = load_conversations(dir.path(), &ws).unwrap();
        assert_eq!(loaded[0].kind, "chat");
        let summary = super::summary_from(loaded.into_iter().next().unwrap());
        assert_eq!(summary.kind, "chat");
    }

    #[test]
    fn symlink_escape_is_rejected() {
        let dir = temp_ws();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "nope").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let link = dir.path().join("out");
            symlink(outside.path(), &link).unwrap();
            let err = resolve_in_workspace(dir.path(), "out/secret.txt").unwrap_err();
            assert!(err.to_string().contains("outside"));
        }
        #[cfg(not(unix))]
        {
            let _ = secret;
        }
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
    fn write_file_creates_parents() {
        let dir = temp_ws();
        write_file(dir.path(), "deep/nested/file.txt", "ok").unwrap();
        assert_eq!(read_file(dir.path(), "deep/nested/file.txt").unwrap(), "ok");
    }
}
