use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{ErrorKind, Read};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::paths::resolve_in_workspace;
use super::types::{GitBranches, GitChange};
use crate::env_path::command_path;
use crate::error::{Error, Result};
use crate::process::WindowlessCommand;
use crate::remote::config::{Machine, RemoteProject};
use crate::remote::ssh::{ExecRequest, Pool};

const GIT_TIMEOUT_SECS: u64 = 60;
const OUTPUT_LIMIT: usize = 2_000_000;
const UNTRACKED_LINE_CAP: u64 = 2_000_000;
const WORKTREE_DIR: &str = "worktrees";
const WORKTREE_EXCLUDE: &str = "/worktrees/";

/// One git invocation. Local commands spawn `git`. Remote commands run the same argv over SSH.
#[derive(Clone)]
pub struct GitTarget {
    pub root: PathBuf,
    remote: Option<RemoteGit>,
    /// App projects roots and the app data directory. Empty in tests, which keeps
    /// worktrees inside the temporary repository.
    worktree_place: Option<(Vec<PathBuf>, PathBuf)>,
}

#[derive(Clone)]
struct RemoteGit {
    machine: Machine,
    project: RemoteProject,
    pool: std::sync::Arc<Pool>,
    secret: Option<String>,
}

impl GitTarget {
    pub fn local(workspace: &Path) -> Result<Self> {
        Ok(Self {
            root: resolve_in_workspace(workspace, "")?,
            remote: None,
            worktree_place: None,
        })
    }

    /// Same as `local`, but a project outside `app_roots` checks worktrees out under `data_dir`.
    pub fn local_in(workspace: &Path, app_roots: &[PathBuf], data_dir: &Path) -> Result<Self> {
        Ok(Self {
            root: resolve_in_workspace(workspace, "")?,
            remote: None,
            worktree_place: Some((app_roots.to_vec(), data_dir.to_path_buf())),
        })
    }

    pub fn remote(
        workspace: &Path,
        machine: Machine,
        project: RemoteProject,
        pool: std::sync::Arc<Pool>,
        secret: Option<String>,
    ) -> Result<Self> {
        Ok(Self {
            root: resolve_in_workspace(workspace, "")?,
            remote: Some(RemoteGit {
                machine,
                project,
                pool,
                secret,
            }),
            worktree_place: None,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRepoSummary {
    pub repo: bool,
    pub current: Option<String>,
    pub detached: bool,
    pub commit: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub dirty: u32,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicts: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub at: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
    pub configured: bool,
}

/// One checkout from `git worktree list --porcelain`. The first block is the main worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitWorktree {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub main: bool,
}

/// One pull request. `open` is false for a request GitHub has closed or merged.
/// Git still advertises those heads, so the state has to come from `gh`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitPullRequest {
    pub number: u32,
    pub title: String,
    pub branch: String,
    pub head: String,
    pub url: String,
    pub open: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitWorktreeAdd {
    pub worktrees: Vec<GitWorktree>,
    pub opened: String,
}

enum GitText {
    Output(String),
    NotRepo,
}

pub fn parse_git_status(porcelain: &str) -> Vec<GitChange> {
    let mut rows = Vec::new();
    for line in porcelain.lines() {
        if let Some(row) = parse_status_line(line) {
            rows.push(row);
        }
    }
    rows
}

fn parse_status_line(line: &str) -> Option<GitChange> {
    if line.len() < 4 {
        return None;
    }
    let bytes = line.as_bytes();
    let x = bytes[0] as char;
    let y = bytes[1] as char;
    // porcelain v1 is "XY PATH". A rename score can make the third byte a digit.
    if bytes[2] != b' ' && !bytes[2].is_ascii_digit() {
        return None;
    }
    let mut rest = line[3..].trim_start();
    if rest.is_empty() {
        return None;
    }
    let mut original: Option<String> = None;
    if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
        if let Some((from, to)) = split_rename(rest) {
            original = Some(unquote_git(from));
            rest = to;
        }
    }
    let path = unquote_git(rest);
    if path.is_empty() {
        return None;
    }
    let (status, staged, unstaged) = classify_git(x, y);
    Some(GitChange {
        path,
        original,
        status,
        staged,
        unstaged,
        additions: 0,
        deletions: 0,
    })
}

/// `old -> new`, including the quoted form `"old -> new"` and paths that contain `->`.
fn split_rename(rest: &str) -> Option<(&str, &str)> {
    if let Some(stripped) = rest.strip_prefix('"') {
        if let Some(end) = find_closing_quote(stripped) {
            let inner = &stripped[..end];
            if let Some((from, to)) = inner.split_once(" -> ") {
                return Some((from, to));
            }
        }
    }
    rest.split_once(" -> ")
}

fn find_closing_quote(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        if bytes[i] == b'"' {
            return Some(i);
        }
        i += 1;
    }
    None
}

pub fn unquote_git(raw: &str) -> String {
    let trimmed = raw.trim();
    let Some(inner) = trimmed.strip_prefix('"').and_then(|s| s.strip_suffix('"')) else {
        return trimmed.to_string();
    };
    let mut out = String::new();
    let mut chars = inner.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('a') => out.push('\u{7}'),
            Some('b') => out.push('\u{8}'),
            Some('v') => out.push('\u{b}'),
            Some('f') => out.push('\u{c}'),
            Some('r') => out.push('\r'),
            Some('\\') => out.push('\\'),
            Some('"') => out.push('"'),
            Some(oct @ '0'..='7') => {
                let mut bytes = vec![oct.to_digit(8).unwrap_or(0) as u8];
                for _ in 0..2 {
                    if let Some(next) = chars.peek().copied() {
                        if let Some(digit) = next.to_digit(8) {
                            chars.next();
                            let last = bytes.last_mut().expect("octal byte");
                            *last = last.saturating_mul(8).saturating_add(digit as u8);
                        }
                    }
                }
                // Git quotes non-ASCII as a run of octal bytes, not one code point each.
                while let Some('\\') = chars.peek().copied() {
                    let mut look = chars.clone();
                    look.next();
                    let Some(next) = look.next() else { break };
                    if !next.is_digit(8) {
                        break;
                    }
                    chars.next();
                    chars.next();
                    let mut val = next.to_digit(8).unwrap_or(0) as u8;
                    for _ in 0..2 {
                        if let Some(more) = chars.peek().copied() {
                            if let Some(digit) = more.to_digit(8) {
                                chars.next();
                                val = val.saturating_mul(8).saturating_add(digit as u8);
                            }
                        }
                    }
                    bytes.push(val);
                }
                match String::from_utf8(bytes) {
                    Ok(text) => out.push_str(&text),
                    Err(err) => out.push_str(&String::from_utf8_lossy(err.as_bytes())),
                }
            }
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
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
    let rest = rest.trim();
    // numstat rename form is `old => new`, not porcelain's `old -> new`.
    if let Some((_, to)) = rest.split_once(" => ") {
        let dest = if let Some(start) = to.rfind('}') {
            // `dir/{old => new}/file` keeps the common prefix and suffix.
            let prefix = rest.split_once('{').map(|(pre, _)| pre).unwrap_or("");
            let suffix = &to[start + 1..];
            let middle = to[..start].trim();
            format!("{prefix}{middle}{suffix}")
        } else {
            to.split('\t').next().unwrap_or(to).to_string()
        };
        return unquote_git(dest.trim());
    }
    let path = rest.split('\t').next().unwrap_or(rest);
    unquote_git(path)
}

/// Index and worktree counts stay separate so a partially staged file is not one number.
pub fn apply_git_stats(
    rows: &mut [GitChange],
    staged: &HashMap<String, (u32, u32)>,
    unstaged: &HashMap<String, (u32, u32)>,
) {
    for row in rows {
        let index = staged.get(&row.path).copied().unwrap_or((0, 0));
        let work = unstaged.get(&row.path).copied().unwrap_or((0, 0));
        row.additions = index.0.saturating_add(work.0);
        row.deletions = index.1.saturating_add(work.1);
    }
}

fn classify_git(x: char, y: char) -> (String, bool, bool) {
    let staged = x != ' ' && x != '?';
    let unstaged = y != ' ' && y != '?';
    if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
        return ("conflict".into(), false, true);
    }
    if x == '?' && y == '?' {
        return ("untracked".into(), false, false);
    }
    if x == '!' && y == '!' {
        return ("ignored".into(), false, false);
    }
    if y == 'D' || (x == 'D' && y == ' ') {
        return ("deleted".into(), staged, unstaged);
    }
    if y == 'A' || (x == 'A' && y == ' ') {
        return ("added".into(), staged, unstaged);
    }
    if y == 'R' || x == 'R' {
        return ("renamed".into(), staged, unstaged);
    }
    if y == 'C' || x == 'C' {
        return ("copied".into(), staged, unstaged);
    }
    if y == 'T' || x == 'T' {
        return ("typechange".into(), staged, unstaged);
    }
    ("modified".into(), staged, unstaged)
}

fn git_missing(err: &str) -> bool {
    let text = err.to_ascii_lowercase();
    text.contains("git: command not found")
        || text.contains("git: not found")
        || text.contains("no such file or directory") && text.contains("git")
}

fn git_text(target: &GitTarget, args: &[&str]) -> Result<GitText> {
    let text = match &target.remote {
        Some(remote) => remote_git(remote, args)?,
        None => local_git(&target.root, args)?,
    };
    if text.starts_with("ERR\n") {
        let err = text.trim_start_matches("ERR\n");
        if err.contains("not a git repository") || git_missing(err) {
            return Ok(GitText::NotRepo);
        }
        return Err(Error::Other(clip(err)));
    }
    Ok(GitText::Output(text))
}

fn git_output(target: &GitTarget, args: &[&str]) -> Result<String> {
    match git_text(target, args)? {
        GitText::Output(text) => Ok(text),
        GitText::NotRepo => Ok(String::new()),
    }
}

fn git_run(target: &GitTarget, args: &[&str]) -> Result<String> {
    match git_text(target, args)? {
        GitText::Output(text) => Ok(text),
        GitText::NotRepo => Err(Error::Other("not a git repository".into())),
    }
}

fn local_git(root: &Path, args: &[&str]) -> Result<String> {
    let mut cmd = Command::new("git");
    cmd.hide_console_window();
    cmd.args(args)
        .current_dir(root)
        .env("PATH", command_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|_| Error::Other("git is not available".into()))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::Other("missing git stdout".into()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| Error::Other("missing git stderr".into()))?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        set_nonblocking(stdout.as_raw_fd());
        set_nonblocking(stderr.as_raw_fd());
    }
    let mut out_buf = Vec::new();
    let mut err_buf = Vec::new();
    let started = std::time::Instant::now();
    let status = loop {
        drain(&mut stdout, &mut out_buf);
        drain(&mut stderr, &mut err_buf);
        match child.try_wait() {
            Ok(Some(status)) => {
                drain(&mut stdout, &mut out_buf);
                drain(&mut stderr, &mut err_buf);
                break status;
            }
            Ok(None) if started.elapsed() > Duration::from_secs(GIT_TIMEOUT_SECS) => {
                kill_git(&mut child);
                drain(&mut stdout, &mut out_buf);
                drain(&mut stderr, &mut err_buf);
                return Err(Error::Other(format!(
                    "git timed out after {GIT_TIMEOUT_SECS}s"
                )));
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(err) => return Err(Error::Other(err.to_string())),
        }
    };
    let stdout = String::from_utf8_lossy(&out_buf).into_owned();
    if status.success() {
        return Ok(clip_bytes(&stdout));
    }
    let stderr = String::from_utf8_lossy(&err_buf);
    Ok(format!("ERR\n{}", stderr.trim()))
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

fn drain(file: &mut impl Read, buf: &mut Vec<u8>) {
    let mut chunk = [0u8; 8192];
    loop {
        if buf.len() >= OUTPUT_LIMIT {
            break;
        }
        match file.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                let room = OUTPUT_LIMIT.saturating_sub(buf.len());
                buf.extend_from_slice(&chunk[..n.min(room)]);
            }
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(err) if err.kind() == ErrorKind::WouldBlock => break,
            Err(_) => break,
        }
    }
}

fn kill_git(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn remote_git(remote: &RemoteGit, args: &[&str]) -> Result<String> {
    let command = crate::remote::git::git_command(args)?;
    let script = crate::remote::ssh::remote_shell_command(&remote.project.remote_path, &command)?;
    let result = remote.pool.exec(
        &remote.machine,
        remote.secret.as_deref(),
        &ExecRequest {
            cwd: remote.project.remote_path.clone(),
            command: format!("GIT_TERMINAL_PROMPT=0 {script}"),
            timeout_secs: GIT_TIMEOUT_SECS,
        },
    )?;
    if result.timed_out {
        return Err(Error::Other(format!(
            "git timed out after {GIT_TIMEOUT_SECS}s"
        )));
    }
    if result.exit_code.is_some_and(|code| code != 0) {
        let err = if result.stderr.is_empty() {
            result.stdout
        } else {
            result.stderr
        };
        return Ok(format!("ERR\n{}", err.trim()));
    }
    Ok(clip_bytes(&result.stdout))
}

fn clip(text: &str) -> String {
    text.trim().chars().take(400).collect()
}

fn clip_bytes(text: &str) -> String {
    if text.len() <= OUTPUT_LIMIT {
        return text.to_string();
    }
    let mut end = OUTPUT_LIMIT;
    while !text.is_char_boundary(end) && end > 0 {
        end -= 1;
    }
    let mut out = text[..end].to_string();
    out.push_str("\n…truncated");
    out
}

pub fn git_status(target: &GitTarget) -> Result<Vec<GitChange>> {
    git_status_with(target, true)
}

/// `stats` runs numstat and reads untracked files. The file tree only needs paths.
pub fn git_status_with(target: &GitTarget, stats: bool) -> Result<Vec<GitChange>> {
    let text = git_output(target, &["status", "--porcelain=v1", "-uall"])?;
    let mut rows = parse_git_status(&text);
    if !stats || rows.is_empty() {
        return Ok(rows);
    }
    let staged = git_numstat(target, &["diff", "--cached", "--numstat"])?;
    let unstaged = git_numstat(target, &["diff", "--numstat"])?;
    apply_git_stats(&mut rows, &staged, &unstaged);
    for row in &mut rows {
        if row.additions == 0 && row.deletions == 0 && row.status == "untracked" {
            row.additions = untracked_lines(target, &row.path);
        }
    }
    Ok(rows)
}

fn git_numstat(target: &GitTarget, args: &[&str]) -> Result<HashMap<String, (u32, u32)>> {
    Ok(parse_git_numstat(&git_output(target, args)?))
}

fn untracked_lines(target: &GitTarget, rel: &str) -> u32 {
    if target.remote.is_some() {
        return remote_line_count(target, rel).unwrap_or(0);
    }
    count_file_lines(&target.root.join(rel))
}

fn count_file_lines(path: &Path) -> u32 {
    let Ok(meta) = fs::metadata(path) else {
        return 0;
    };
    if !meta.is_file() || meta.len() > UNTRACKED_LINE_CAP {
        return 0;
    }
    let Ok(data) = fs::read(path) else {
        return 0;
    };
    line_count(&data)
}

fn line_count(data: &[u8]) -> u32 {
    if data.is_empty() || data.contains(&0) {
        return 0;
    }
    let mut n = data.iter().filter(|b| **b == b'\n').count() as u32;
    if data.last() != Some(&b'\n') {
        n += 1;
    }
    n
}

fn remote_line_count(target: &GitTarget, rel: &str) -> Result<u32> {
    let text = git_output(target, &["diff", "--no-index", "--numstat", "--", "/dev/null", rel])?;
    if let Some((add, _)) = parse_git_numstat(&text).get(rel) {
        return Ok(*add);
    }
    Ok(0)
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
        let name = raw.trim_start_matches(['*', '+']).trim();
        if name.is_empty() || name.starts_with('(') {
            continue;
        }
        branches.push(name.to_string());
        if is_current {
            current = Some(name.to_string());
        }
    }
    GitBranches {
        current,
        branches,
        repo: true,
    }
}

pub fn sanitize_git_branch(raw: &str) -> Result<String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(Error::Other("branch name is empty".into()));
    }
    if s.eq_ignore_ascii_case("head")
        || s.eq_ignore_ascii_case("head~")
        || s.chars().all(|c| c.is_ascii_hexdigit()) && s.len() >= 7
    {
        return Err(Error::Other("switch to a branch, not a commit".into()));
    }
    if s.starts_with('-') || s.starts_with('.') || s.ends_with('/') || s.ends_with('.') || s.ends_with(".lock")
    {
        return Err(Error::Other("invalid branch name".into()));
    }
    if s.contains("..") || s.contains("//") || s.contains('@') || s.contains('\\') {
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

pub fn sanitize_commit_message(raw: &str) -> Result<String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(Error::Other("commit message is empty".into()));
    }
    if s.chars().any(|c| c == '\0' || (c.is_control() && c != '\n' && c != '\t')) {
        return Err(Error::Other("commit message has invalid characters".into()));
    }
    if s.len() > 20_000 {
        return Err(Error::Other("commit message is too long".into()));
    }
    Ok(s.to_string())
}

pub fn git_branches(target: &GitTarget) -> Result<GitBranches> {
    match git_text(target, &["branch", "--list"])? {
        GitText::NotRepo => Ok(GitBranches {
            current: None,
            branches: Vec::new(),
            repo: false,
        }),
        GitText::Output(text) => {
            let mut listed = parse_git_branches(&text);
            if listed.current.is_none() {
                if let Ok(GitText::Output(head)) =
                    git_text(target, &["rev-parse", "--abbrev-ref", "HEAD"])
                {
                    let name = head.trim();
                    if !name.is_empty() && name != "HEAD" {
                        listed.current = Some(name.to_string());
                    }
                }
            }
            Ok(listed)
        }
    }
}

/// Branch, ahead, behind, and a dirty count from one `git status`.
pub fn git_label(target: &GitTarget) -> Result<GitRepoSummary> {
    match git_text(
        target,
        &["status", "--porcelain=v2", "--branch", "--untracked-files=no"],
    )? {
        GitText::NotRepo => Ok(empty_summary()),
        GitText::Output(text) => Ok(parse_git_label(&text)),
    }
}

/// `# branch.*` headers plus one ordinary line per change. Untracked files are not listed.
pub fn parse_git_label(text: &str) -> GitRepoSummary {
    let mut summary = empty_summary();
    let mut saw_header = false;
    let mut dirty = 0u32;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# branch.") {
            saw_header = true;
            if let Some((key, value)) = rest.split_once(' ') {
                match key {
                    "head" => {
                        let name = value.trim();
                        if name.is_empty() {
                            continue;
                        }
                        if name == "(detached)" {
                            summary.detached = true;
                        } else {
                            summary.current = Some(name.to_string());
                        }
                    }
                    "oid" => {
                        let oid = value.trim();
                        if oid.len() >= 7 && oid.chars().all(|c| c.is_ascii_hexdigit()) {
                            summary.commit = Some(oid[..7].to_string());
                        }
                    }
                    "upstream" => {
                        let name = value.trim();
                        if !name.is_empty() {
                            summary.upstream = Some(name.to_string());
                        }
                    }
                    "ab" => {
                        let (ahead, behind) = parse_branch_ab(value);
                        summary.ahead = ahead;
                        summary.behind = behind;
                    }
                    _ => {}
                }
            }
            continue;
        }
        if line.starts_with("# ") || line.is_empty() {
            continue;
        }
        dirty = dirty.saturating_add(1);
    }
    if !saw_header {
        return empty_summary();
    }
    summary.repo = true;
    summary.dirty = dirty;
    summary
}

fn parse_branch_ab(value: &str) -> (u32, u32) {
    let mut ahead = 0u32;
    let mut behind = 0u32;
    for part in value.split_whitespace() {
        if let Some(rest) = part.strip_prefix('+') {
            ahead = rest.parse().unwrap_or(0);
        } else if let Some(rest) = part.strip_prefix('-') {
            behind = rest.parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

fn empty_summary() -> GitRepoSummary {
    GitRepoSummary {
        repo: false,
        current: None,
        detached: false,
        commit: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        dirty: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicts: 0,
    }
}

pub fn git_switch(target: &GitTarget, name: &str) -> Result<GitBranches> {
    let name = sanitize_git_branch(name)?;
    let listed = git_branches(target)?;
    if !listed.repo {
        return Err(Error::Other("not a git repository".into()));
    }
    if !listed.branches.iter().any(|branch| branch == &name) {
        return Err(Error::Other(format!("branch {name} does not exist")));
    }
    git_run(target, &["switch", "--", &name])?;
    git_branches(target)
}

/// Porcelain blocks, blank-line separated. The first block is the main worktree.
pub fn parse_worktree_list(text: &str) -> Vec<GitWorktree> {
    let mut rows = Vec::new();
    for block in text.split("\n\n") {
        let mut path = None;
        let mut head = None;
        let mut branch = None;
        let mut bare = false;
        let mut detached = false;
        let mut saw = false;
        for line in block.lines() {
            let line = line.trim_end();
            if line.is_empty() {
                continue;
            }
            saw = true;
            if let Some(rest) = line.strip_prefix("worktree ") {
                let value = rest.trim();
                if !value.is_empty() {
                    path = Some(value.to_string());
                }
            } else if let Some(rest) = line.strip_prefix("HEAD ") {
                let value = rest.trim();
                if !value.is_empty() {
                    head = Some(value.to_string());
                }
            } else if let Some(rest) = line.strip_prefix("branch ") {
                branch = Some(worktree_branch_name(rest));
            } else if line == "bare" {
                bare = true;
            } else if line == "detached" {
                detached = true;
            }
        }
        if !saw {
            continue;
        }
        let Some(path) = path else { continue };
        rows.push(GitWorktree {
            path,
            head,
            branch,
            bare,
            detached,
            main: rows.is_empty(),
        });
    }
    rows
}

fn worktree_branch_name(raw: &str) -> String {
    raw.trim()
        .strip_prefix("refs/heads/")
        .unwrap_or(raw.trim())
        .to_string()
}

pub fn git_worktrees(target: &GitTarget) -> Result<Vec<GitWorktree>> {
    match git_text(target, &["worktree", "list", "--porcelain"])? {
        GitText::NotRepo => Ok(Vec::new()),
        GitText::Output(text) => Ok(parse_worktree_list(&text)),
    }
}

/// Where a new worktree is checked out. `inside` is `<repo>/worktrees/<branch>` for a
/// project the app owns. `None` is a folder the user opened from somewhere else, so the
/// checkout goes under the app data directory and the project folder is left alone.
pub struct WorktreeHome {
    pub inside: bool,
    pub root: PathBuf,
}

/// `<root>/<branch>`, with `/` in the branch turned into `-`.
pub fn worktree_destination(home: &WorktreeHome, branch: &str) -> Result<PathBuf> {
    let branch = sanitize_git_branch(branch)?;
    let name = worktree_folder_name(&branch)?;
    if home.inside && name == WORKTREE_DIR {
        return Err(Error::Other("worktree folder would nest inside itself".into()));
    }
    Ok(home.root.join(name))
}

/// A project under the app projects folder keeps worktrees inside itself.
/// Anything else, including a folder opened from another location, uses app data.
pub fn worktree_home(main_path: &Path, app_roots: &[&Path], data_dir: &Path) -> WorktreeHome {
    // `git worktree list` returns the real path. On macOS that drops a `/var` -> `/private/var`
    // symlink, so compare the resolved folders rather than the path the app stored.
    let main_real = fs::canonicalize(main_path).unwrap_or_else(|_| main_path.to_path_buf());
    let owned = app_roots.iter().any(|root| {
        let root_real = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        crate::paths::is_under(&main_real, &root_real)
            && main_real.parent().is_some_and(|parent| crate::paths::same_dir(parent, &root_real))
    });
    if owned {
        return WorktreeHome {
            inside: true,
            root: main_path.join(WORKTREE_DIR),
        };
    }
    WorktreeHome {
        inside: false,
        root: external_worktree_root(data_dir, main_path),
    }
}

/// `<data>/worktrees/<project>-<id>`. Removing an external project deletes this folder.
pub fn external_worktree_root(data_dir: &Path, main_path: &Path) -> PathBuf {
    let name = main_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty() && name != "." && name != "..")
        .unwrap_or_else(|| "project".into());
    let folder = super::projects::sanitize_project_name(&name).unwrap_or_else(|_| "project".into());
    let id = super::paths::workspace_id(&crate::paths::native_source(&main_path.to_string_lossy()));
    data_dir.join(WORKTREE_DIR).join(format!("{folder}-{id}"))
}

/// Tell git to ignore `worktrees/` without touching a committed `.gitignore`.
/// Git refuses `worktree add` inside the working tree unless this path is excluded.
fn ensure_worktree_excluded(main_path: &Path) -> Result<()> {
    let git_dir = main_path.join(".git");
    if !git_dir.is_dir() {
        return Ok(());
    }
    let info = git_dir.join("info");
    fs::create_dir_all(&info)?;
    let exclude = info.join("exclude");
    let current = fs::read_to_string(&exclude).unwrap_or_default();
    if current.lines().any(|line| line.trim() == WORKTREE_EXCLUDE) {
        return Ok(());
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(WORKTREE_EXCLUDE);
    next.push('\n');
    fs::write(&exclude, next)?;
    Ok(())
}

fn worktree_folder_name(branch: &str) -> Result<String> {
    let flat = branch.replace('/', "-");
    super::projects::sanitize_project_name(&flat)
}

fn same_checkout(left: &str, right: &Path) -> bool {
    let Ok(canon) = fs::canonicalize(right) else {
        return crate::paths::native_source(left).eq_ignore_ascii_case(&crate::paths::native_source(
            &right.to_string_lossy(),
        ));
    };
    crate::paths::native_source(left).eq_ignore_ascii_case(&crate::paths::native_source(
        &canon.to_string_lossy(),
    )) || crate::paths::native_source(left).eq_ignore_ascii_case(&crate::paths::native_source(
        &right.to_string_lossy(),
    ))
}

fn main_worktree_path(rows: &[GitWorktree]) -> Result<PathBuf> {
    rows.iter()
        .find(|row| row.main)
        .map(|row| PathBuf::from(&row.path))
        .ok_or_else(|| Error::Other("not a git repository".into()))
}

/// Where this repository's new worktrees go. An existing checkout keeps its own folder.
fn home_for(target: &GitTarget, main: &Path) -> WorktreeHome {
    let (roots, data_dir) = target
        .worktree_place
        .clone()
        .unwrap_or_else(|| (Vec::new(), PathBuf::new()));
    let root_refs: Vec<&Path> = roots.iter().map(PathBuf::as_path).collect();
    worktree_home(main, &root_refs, &data_dir)
}

/// Check `branch` out in this project's worktree folder. `create` makes the branch from HEAD when it is new.
pub fn git_worktree_add(target: &GitTarget, branch: &str, create: bool) -> Result<GitWorktreeAdd> {
    if target.remote.is_some() {
        return Err(Error::Other(
            "worktrees are only created for a project on this Mac".into(),
        ));
    }
    let branch = sanitize_git_branch(branch)?;
    let listed = git_worktrees(target)?;
    if listed.is_empty() {
        return Err(Error::Other("not a git repository".into()));
    }
    if listed.iter().any(|row| row.bare) {
        return Err(Error::Other("a bare repository cannot grow a worktree".into()));
    }
    if listed.iter().any(|row| row.branch.as_deref() == Some(branch.as_str())) {
        return Err(Error::Conflict(format!("{branch} is already checked out")));
    }
    let main = main_worktree_path(&listed)?;
    let home = home_for(target, &main);
    if home.inside {
        ensure_worktree_excluded(&main)?;
    }
    let dest = worktree_destination(&home, &branch)?;
    if dest.exists() {
        return Err(Error::Conflict(format!(
            "{} already exists",
            dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
        )));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    let dest_str = dest
        .to_str()
        .ok_or_else(|| Error::Other("worktree path is not valid".into()))?
        .to_string();
    let branch_exists = git_branches(target)?
        .branches
        .iter()
        .any(|name| name == &branch);
    let added = if create && !branch_exists {
        git_run(target, &["worktree", "add", "-b", &branch, &dest_str, "HEAD"])
    } else if branch_exists {
        git_run(target, &["worktree", "add", &dest_str, &branch])
    } else {
        Err(Error::Other(format!("branch {branch} does not exist")))
    };
    if let Err(err) = added {
        if dest.exists() && fs::read_dir(&dest).ok().is_some_and(|mut rows| rows.next().is_none()) {
            let _ = fs::remove_dir(&dest);
        }
        return Err(err);
    }
    let worktrees = git_worktrees(target)?;
    let opened = worktrees
        .iter()
        .find(|row| same_checkout(&row.path, &dest))
        .map(|row| row.path.clone())
        .unwrap_or(dest_str);
    Ok(GitWorktreeAdd { worktrees, opened })
}

/// Rename a linked worktree's branch and move its folder to match. The main checkout stays put.
pub fn git_worktree_rename(target: &GitTarget, path: &str, branch: &str) -> Result<GitWorktreeAdd> {
    if target.remote.is_some() {
        return Err(Error::Other(
            "worktrees are only renamed for a project on this Mac".into(),
        ));
    }
    let branch = sanitize_git_branch(branch)?;
    let listed = git_worktrees(target)?;
    let Some(row) = listed.iter().find(|row| same_checkout(&row.path, Path::new(path))) else {
        return Err(Error::Other("that worktree is not in this repository".into()));
    };
    if row.main {
        return Err(Error::Other("the main checkout cannot be renamed".into()));
    }
    if row.detached || row.branch.as_deref().is_none_or(str::is_empty) {
        return Err(Error::Other("a detached worktree has no branch to rename".into()));
    }
    let current = row.branch.clone().unwrap_or_default();
    let here = row.path.clone();
    let already_home = current == branch
        && same_checkout(
            &here,
            &worktree_destination(&home_for(target, &main_worktree_path(&listed)?), &branch)?,
        );
    if already_home {
        return Ok(GitWorktreeAdd {
            worktrees: listed,
            opened: here,
        });
    }
    if listed.iter().any(|item| item.path != row.path && item.branch.as_deref() == Some(branch.as_str())) {
        return Err(Error::Conflict(format!("{branch} is already checked out")));
    }
    let main = main_worktree_path(&listed)?;
    let repo = GitTarget::local(&main)?;
    let dest = worktree_destination(&home_for(target, &main), &branch)?;
    let moving = !same_checkout(&row.path, &dest);
    if moving && dest.exists() {
        return Err(Error::Conflict(format!(
            "{} already exists",
            dest.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        )));
    }
    if current != branch {
        let taken = git_branches(&repo)?
            .branches
            .iter()
            .any(|name| name == &branch);
        if taken {
            return Err(Error::Conflict(format!("{branch} already exists")));
        }
        // Running this in the main checkout would rename main. The branch lives here.
        let linked = GitTarget::local(Path::new(&here))?;
        git_run(&linked, &["branch", "-m", &branch])?;
    }
    let from = here;
    if moving {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let dest_str = dest
            .to_str()
            .ok_or_else(|| Error::Other("worktree path is not valid".into()))?
            .to_string();
        if let Err(err) = git_run(&repo, &["worktree", "move", &from, &dest_str]) {
            if current != branch {
                let linked = GitTarget::local(Path::new(&from))?;
                let _ = git_run(&linked, &["branch", "-m", &current]);
            }
            return Err(err);
        }
    }
    let worktrees = git_worktrees(target)?;
    let opened = worktrees
        .iter()
        .find(|item| item.branch.as_deref() == Some(branch.as_str()))
        .map(|item| item.path.clone())
        .unwrap_or_else(|| dest.to_string_lossy().into_owned());
    Ok(GitWorktreeAdd { worktrees, opened })
}

/// How much disk one remove choice would free. `project` is the main checkout.
/// `worktrees` is every linked checkout. `app` is the chats and other app data for those folders.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectRemoval {
    pub project: u64,
    pub worktrees: u64,
    pub app: u64,
    pub worktree_count: u32,
    pub app_managed: bool,
}

/// Bytes the main checkout, its linked worktrees, and their app data take.
/// A folder that is not a git repo reports no worktrees.
pub fn project_removal(target: &GitTarget, data_dir: &Path, app_roots: &[&Path]) -> ProjectRemoval {
    let here = fs::canonicalize(&target.root).unwrap_or_else(|_| target.root.clone());
    let app_managed = app_roots.iter().any(|root| {
        let root_real = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        crate::paths::is_under(&here, &root_real)
            && here.parent().is_some_and(|parent| crate::paths::same_dir(parent, &root_real))
    });
    let listed = git_worktrees(target).unwrap_or_default();
    let linked: Vec<&GitWorktree> = listed.iter().filter(|row| !row.main && !row.bare).collect();
    let main = listed.iter().find(|row| row.main);
    let skip = linked
        .iter()
        .map(|row| {
            fs::canonicalize(&row.path)
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|_| row.path.clone())
        })
        .collect::<Vec<_>>();
    let skip_refs = skip.iter().map(String::as_str).collect::<Vec<_>>();
    let project = main
        .map(|row| dir_size_except(Path::new(&row.path), &skip_refs))
        .unwrap_or_else(|| dir_size_except(&target.root, &skip_refs));
    let mut worktrees = 0u64;
    let mut app = app_data_size(data_dir, &target.root);
    for row in &linked {
        worktrees += dir_size(Path::new(&row.path));
        app += app_data_size(data_dir, Path::new(&row.path));
    }
    // External checkouts live together under one app-data folder. Count that once
    // when git has not listed the children yet.
    if linked.is_empty() && !app_managed {
        let home = external_worktree_root(data_dir, &target.root);
        if home.is_dir() {
            worktrees += dir_size(&home);
        }
    }
    ProjectRemoval {
        project,
        worktrees,
        app,
        worktree_count: linked.len() as u32,
        app_managed,
    }
}

/// Remove every linked worktree and the app data stored for those folders.
/// The main checkout and its branch stay. A dirty worktree is left in place.
pub fn remove_project_worktrees(target: &GitTarget, data_dir: &Path) -> Result<Vec<String>> {
    if target.remote.is_some() {
        return Err(Error::Other(
            "worktrees are only removed for a project on this Mac".into(),
        ));
    }
    let listed = git_worktrees(target)?;
    let mut removed = Vec::new();
    let mut blocked = Vec::new();
    for row in listed.iter().filter(|row| !row.main && !row.bare) {
        match git_run(target, &["worktree", "remove", "--", &row.path]) {
            Ok(_) => {
                let _ = super::project_location::drop_project_chats(data_dir, &row.path);
                removed.push(row.path.clone());
            }
            Err(_) => blocked.push(row.path.clone()),
        }
    }
    if let Some(main) = listed.iter().find(|row| row.main) {
        let home = external_worktree_root(data_dir, Path::new(&main.path));
        if home.is_dir() {
            let _ = fs::remove_dir_all(&home);
        }
    }
    if removed.is_empty() && !blocked.is_empty() {
        return Err(Error::Other(
            "worktrees still have uncommitted changes, so nothing was removed".into(),
        ));
    }
    Ok(removed)
}

/// Disk space a folder occupies, following the same files `du` would. A missing folder is zero.
fn dir_size(path: &Path) -> u64 {
    dir_size_except(path, &[])
}

/// Like `dir_size`, but a nested path in `skip` is left out. Linked worktrees live inside the
/// main checkout, and their space belongs to the worktree choice, not the project choice.
fn dir_size_except(path: &Path, skip: &[&str]) -> u64 {
    fn walk(path: &Path, skip: &[&str], seen: &mut HashSet<u64>, total: &mut u64) {
        let Ok(meta) = fs::symlink_metadata(path) else {
            return;
        };
        if meta.file_type().is_symlink() {
            return;
        }
        if meta.is_dir() {
            if path.file_name().is_some_and(|name| name == ".git") {
                return;
            }
            let canon = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
            let text = crate::paths::native_source(&canon.to_string_lossy());
            if skip.iter().any(|item| crate::paths::native_source(item).eq_ignore_ascii_case(&text)) {
                return;
            }
        }
        // A second hard link must not be counted twice.
        if meta.nlink() > 1 && !seen.insert(meta.ino()) {
            return;
        }
        *total = total.saturating_add(meta.blocks().saturating_mul(512));
        if !meta.is_dir() {
            return;
        }
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            walk(&entry.path(), skip, seen, total);
        }
    }
    let mut total = 0u64;
    walk(path, skip, &mut HashSet::new(), &mut total);
    total
}

fn app_data_size(data_dir: &Path, workspace: &Path) -> u64 {
    let id = super::paths::workspace_id(&crate::paths::native_source(&workspace.to_string_lossy()));
    dir_size(&data_dir.join("dev").join(id))
}

/// Remove a linked worktree. Refuses the main checkout, the open folder, and a dirty tree.
pub fn git_worktree_remove(target: &GitTarget, path: &str) -> Result<Vec<GitWorktree>> {
    if target.remote.is_some() {
        return Err(Error::Other(
            "worktrees are only removed for a project on this Mac".into(),
        ));
    }
    let listed = git_worktrees(target)?;
    let Some(row) = listed.iter().find(|row| same_checkout(&row.path, Path::new(path))) else {
        return Err(Error::Other("that worktree is not in this repository".into()));
    };
    if row.main {
        return Err(Error::Other("the main checkout cannot be removed".into()));
    }
    if same_checkout(&row.path, &target.root) {
        return Err(Error::Other("switch away from this worktree before removing it".into()));
    }
    let remove_path = row.path.clone();
    git_run(target, &["worktree", "remove", "--", &remove_path])?;
    git_worktrees(target)
}

pub fn git_create_branch(target: &GitTarget, name: &str, checkout: bool) -> Result<GitBranches> {
    let name = sanitize_git_branch(name)?;
    let listed = git_branches(target)?;
    if !listed.repo {
        return Err(Error::Other("not a git repository".into()));
    }
    if listed.branches.iter().any(|branch| branch == &name) {
        return Err(Error::Conflict(format!("{name} already exists")));
    }
    if checkout {
        git_run(target, &["switch", "-c", "--", &name])?;
    } else {
        git_run(target, &["branch", "--", &name])?;
    }
    git_branches(target)
}

pub fn git_diff(target: &GitTarget, rel: &str) -> Result<String> {
    let path = safe_repo_path(rel)?;
    let unstaged = diff_side(target, false, path.as_deref())?;
    let staged = diff_side(target, true, path.as_deref())?;
    Ok(join_diff(&staged, &unstaged))
}

fn diff_side(target: &GitTarget, staged: bool, path: Option<&str>) -> Result<String> {
    let mut args = vec!["diff", "--no-color", "--no-ext-diff", "-z"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    if let Some(path) = path {
        args.push(path);
    }
    let raw = git_output(target, &args)?;
    Ok(nul_diff_to_lines(&raw))
}

fn join_diff(staged: &str, unstaged: &str) -> String {
    if staged.is_empty() {
        return unstaged.to_string();
    }
    if unstaged.is_empty() {
        return staged.to_string();
    }
    format!("# staged\n{staged}\n# unstaged\n{unstaged}")
}

/// `git diff -z` separates file headers with NUL so a path cannot be mistaken for a diff line.
fn nul_diff_to_lines(raw: &str) -> String {
    if !raw.contains('\0') {
        return raw.to_string();
    }
    raw.replace('\0', "\n")
}

pub fn safe_repo_path(rel: &str) -> Result<Option<String>> {
    let path = rel.trim().replace('\\', "/");
    if path.is_empty() {
        return Ok(None);
    }
    if path.contains('\0') || path.starts_with('/') || path.split('/').any(|part| part == "..") {
        return Err(Error::Other("path is outside the workspace".into()));
    }
    Ok(Some(path.trim_start_matches("./").to_string()))
}

pub fn git_stage(target: &GitTarget, paths: &[String]) -> Result<Vec<GitChange>> {
    let args = path_args(paths)?;
    let mut cmd = vec!["add", "--"];
    cmd.extend(args.iter().map(String::as_str));
    git_run(target, &cmd)?;
    git_status(target)
}

pub fn git_unstage(target: &GitTarget, paths: &[String]) -> Result<Vec<GitChange>> {
    let args = path_args(paths)?;
    let mut cmd = vec!["restore", "--staged", "--"];
    cmd.extend(args.iter().map(String::as_str));
    git_run(target, &cmd)?;
    git_status(target)
}

pub fn git_discard(target: &GitTarget, paths: &[String]) -> Result<Vec<GitChange>> {
    let args = path_args(paths)?;
    let rows = git_status_with(target, false)?;
    let wanted: Vec<&GitChange> = if args.is_empty() {
        rows.iter().collect()
    } else {
        rows.iter()
            .filter(|row| args.iter().any(|path| path == &row.path))
            .collect()
    };
    let untracked: Vec<&str> = wanted
        .iter()
        .filter(|row| row.status == "untracked")
        .map(|row| row.path.as_str())
        .collect();
    let tracked: Vec<&str> = wanted
        .iter()
        .filter(|row| row.status != "untracked")
        .map(|row| row.path.as_str())
        .collect();
    if !tracked.is_empty() {
        let mut cmd = vec!["restore", "--source=HEAD", "--worktree", "--staged", "--"];
        cmd.extend(tracked.iter().copied());
        git_run(target, &cmd)?;
    }
    if !untracked.is_empty() {
        let mut cmd = vec!["clean", "-f", "--"];
        cmd.extend(untracked.iter().copied());
        git_run(target, &cmd)?;
    }
    git_status(target)
}

fn path_args(paths: &[String]) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for path in paths {
        if let Some(clean) = safe_repo_path(path)? {
            out.push(clean);
        }
    }
    Ok(out)
}

pub fn git_commit(target: &GitTarget, message: &str) -> Result<String> {
    let message = sanitize_commit_message(message)?;
    let rows = git_status_with(target, false)?;
    if !rows.iter().any(|row| row.staged) {
        return Err(Error::Other("nothing staged to commit".into()));
    }
    if rows.iter().any(|row| row.status == "conflict") {
        return Err(Error::Other("resolve conflicts before committing".into()));
    }
    let identity = git_identity(target)?;
    if !identity.configured {
        return Err(Error::Other(
            "set a git name and email before committing".into(),
        ));
    }
    git_run(target, &["commit", "-m", &message])?;
    git_output(target, &["rev-parse", "--short", "HEAD"]).map(|s| s.trim().to_string())
}

pub fn git_identity(target: &GitTarget) -> Result<GitIdentity> {
    let name = git_config(target, "user.name")?;
    let email = git_config(target, "user.email")?;
    Ok(GitIdentity {
        name: name.clone(),
        email: email.clone(),
        configured: !name.is_empty() && !email.is_empty(),
    })
}

fn git_config(target: &GitTarget, key: &str) -> Result<String> {
    match git_text(target, &["config", "--get", key])? {
        GitText::NotRepo => Ok(String::new()),
        GitText::Output(text) => Ok(text.trim().to_string()),
    }
}

pub fn git_set_identity(target: &GitTarget, name: &str, email: &str) -> Result<GitIdentity> {
    let name = sanitize_identity(name, "name")?;
    let email = sanitize_identity(email, "email")?;
    if !email.contains('@') || email.starts_with('@') || email.ends_with('@') {
        return Err(Error::Other("email needs an @".into()));
    }
    git_run(target, &["config", "--local", "user.name", &name])?;
    git_run(target, &["config", "--local", "user.email", &email])?;
    git_identity(target)
}

fn sanitize_identity(raw: &str, label: &str) -> Result<String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(Error::Other(format!("git {label} is empty")));
    }
    if s.chars().any(|c| c.is_control() || c == '\n') || s.len() > 200 {
        return Err(Error::Other(format!("invalid git {label}")));
    }
    Ok(s.to_string())
}

pub fn git_sync(target: &GitTarget, action: &str) -> Result<String> {
    match action {
        "fetch" => git_run(target, &["fetch", "--prune"]),
        "pull" => git_run(target, &["pull", "--ff-only"]),
        "push" => git_run(target, &["push"]),
        "publish" => git_run(target, &["push", "-u", "origin", "HEAD"]),
        other => Err(Error::Other(format!("unknown git sync action: {other}"))),
    }
}

pub fn git_stash(target: &GitTarget, action: &str, message: &str) -> Result<String> {
    match action {
        "push" => {
            if message.trim().is_empty() {
                git_run(target, &["stash", "push", "-u"])
            } else {
                let message = sanitize_commit_message(message)?;
                git_run(target, &["stash", "push", "-u", "-m", &message])
            }
        }
        "pop" => git_run(target, &["stash", "pop"]),
        "list" => git_run(target, &["stash", "list"]),
        other => Err(Error::Other(format!("unknown git stash action: {other}"))),
    }
}

pub fn git_log(target: &GitTarget, limit: u32) -> Result<Vec<GitCommit>> {
    let limit = limit.clamp(1, 200);
    let count = limit.to_string();
    let text = git_output(
        target,
        &[
            "log",
            "-n",
            &count,
            "--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s",
        ],
    )?;
    Ok(parse_git_log(&text))
}

pub fn parse_git_log(text: &str) -> Vec<GitCommit> {
    let mut rows = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(5, '\u{1f}').collect();
        if parts.len() < 5 {
            continue;
        }
        rows.push(GitCommit {
            hash: parts[0].to_string(),
            short: parts[1].to_string(),
            author: parts[2].to_string(),
            at: parts[3].to_string(),
            subject: parts[4].to_string(),
        });
    }
    rows
}

pub fn git_show(target: &GitTarget, hash: &str) -> Result<String> {
    let hash = sanitize_revision(hash)?;
    git_output(target, &["show", "--no-color", "--format=fuller", "--", &hash])
}

fn sanitize_revision(raw: &str) -> Result<String> {
    let s = raw.trim();
    if s.is_empty()
        || s.starts_with('-')
        || s.contains("..")
        || !s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/'))
    {
        return Err(Error::Other("invalid revision".into()));
    }
    Ok(s.to_string())
}

pub fn git_file_at(target: &GitTarget, rel: &str, revision: &str) -> Result<String> {
    let path = safe_repo_path(rel)?.ok_or_else(|| Error::Other("path is empty".into()))?;
    let revision = sanitize_revision(revision)?;
    let spec = format!("{revision}:{path}");
    git_output(target, &["show", &spec])
}

/// Pull requests advertised by the remote. Empty when this folder is not a GitHub repo.
/// A closed request stays in the list with `open: false`. Git keeps its head ref either way.
pub fn git_pull_requests(target: &GitTarget) -> Result<Vec<GitPullRequest>> {
    if target.remote.is_some() {
        return Ok(Vec::new());
    }
    let remote = match git_text(target, &["remote", "get-url", "origin"]) {
        Ok(GitText::Output(text)) => text,
        Ok(GitText::NotRepo) | Err(_) => return Ok(Vec::new()),
    };
    let Some(repo) = github_repo_slug(&remote) else {
        return Ok(Vec::new());
    };
    let heads = match git_text(
        target,
        &["ls-remote", "--refs", "origin", "refs/pull/*/head"],
    )? {
        GitText::NotRepo => return Ok(Vec::new()),
        GitText::Output(text) => text,
    };
    let mut rows = parse_pull_request_heads(&heads, &repo);
    if rows.is_empty() {
        return Ok(rows);
    }
    // `gh` is the only way to tell a closed request from an open one. Without it, every
    // advertised head stays open, which is what the menu shows by default.
    if let Some(states) = pull_request_states(target) {
        for row in &mut rows {
            if let Some(info) = states.get(&row.number) {
                if !info.title.is_empty() {
                    row.title.clone_from(&info.title);
                }
                row.open = info.open;
            }
        }
    }
    Ok(rows)
}

/// `origin` when this folder has one. None for a missing remote or a cloud project.
pub fn git_remote_url(target: &GitTarget) -> Option<String> {
    if target.remote.is_some() {
        return None;
    }
    match git_text(target, &["remote", "get-url", "origin"]) {
        Ok(GitText::Output(text)) if !text.trim().is_empty() => Some(text),
        _ => None,
    }
}

/// `owner/repo` from an https or ssh GitHub remote. None for any other host.
pub fn github_repo_slug(remote: &str) -> Option<String> {
    let raw = remote.trim().trim_end_matches('/').trim_end_matches(".git");
    if raw.is_empty() {
        return None;
    }
    let path = if let Some(rest) = raw.strip_prefix("git@github.com:") {
        rest
    } else if let Some(rest) = raw.strip_prefix("ssh://git@github.com/") {
        rest
    } else if let Some(rest) = raw
        .strip_prefix("https://github.com/")
        .or_else(|| raw.strip_prefix("http://github.com/"))
    {
        rest
    } else {
        return None;
    };
    let mut parts = path.split('/').filter(|part| !part.is_empty());
    let owner = parts.next()?;
    let repo = parts.next()?;
    if parts.next().is_some() || !github_slug_part(owner) || !github_slug_part(repo) {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

fn github_slug_part(part: &str) -> bool {
    !part.is_empty()
        && part.len() <= 100
        && part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !part.starts_with('.')
        && !part.ends_with('.')
}

/// `ls-remote` lines are `<oid><tab>refs/pull/<n>/head`. Closed requests are not advertised.
pub fn parse_pull_request_heads(text: &str, repo: &str) -> Vec<GitPullRequest> {
    let mut rows = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in text.lines() {
        let Some((oid, reference)) = line.split_once('\t').or_else(|| line.split_once(' ')) else {
            continue;
        };
        let oid = oid.trim();
        let Some(number) = pull_request_number(reference.trim()) else {
            continue;
        };
        if oid.len() < 7 || !oid.chars().all(|c| c.is_ascii_hexdigit()) || !seen.insert(number) {
            continue;
        }
        rows.push(GitPullRequest {
            number,
            title: String::new(),
            branch: format!("pr/{number}"),
            head: oid.to_string(),
            url: format!("https://github.com/{repo}/pull/{number}"),
            open: true,
        });
    }
    rows.sort_by_key(|row| std::cmp::Reverse(row.number));
    rows
}

fn pull_request_number(reference: &str) -> Option<u32> {
    let rest = reference.strip_prefix("refs/pull/")?;
    let number = rest.strip_suffix("/head")?;
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let parsed: u32 = number.parse().ok()?;
    if parsed == 0 {
        None
    } else {
        Some(parsed)
    }
}

#[derive(Debug)]
pub struct PullRequestInfo {
    pub title: String,
    pub open: bool,
}

/// `gh pr list` for open and closed requests. None when the CLI is missing or refuses.
fn pull_request_states(target: &GitTarget) -> Option<HashMap<u32, PullRequestInfo>> {
    let text = local_tool(
        &target.root,
        "gh",
        &[
            "pr",
            "list",
            "--state",
            "all",
            "--limit",
            "100",
            "--json",
            "number,title,state",
        ],
    )
    .ok()?;
    parse_pull_request_states(&text)
}

pub fn parse_pull_request_states(text: &str) -> Option<HashMap<u32, PullRequestInfo>> {
    let value: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    let rows = value.as_array()?;
    let mut out = HashMap::new();
    for row in rows {
        let Some(number) = row.get("number").and_then(|n| n.as_u64()) else {
            continue;
        };
        let number = number as u32;
        if number == 0 {
            continue;
        }
        let title = row
            .get("title")
            .and_then(|title| title.as_str())
            .unwrap_or("")
            .trim()
            .chars()
            .take(140)
            .collect();
        let state = row.get("state").and_then(|state| state.as_str()).unwrap_or("");
        out.insert(
            number,
            PullRequestInfo {
                title,
                open: state.eq_ignore_ascii_case("open"),
            },
        );
    }
    Some(out)
}

/// Fetch one open pull request and check it out in a worktree inside the project.
pub fn git_pull_request_checkout(target: &GitTarget, number: u32) -> Result<GitWorktreeAdd> {
    if target.remote.is_some() {
        return Err(Error::Other(
            "pull requests are only opened for a project on this Mac".into(),
        ));
    }
    if number == 0 {
        return Err(Error::Other("that pull request does not exist".into()));
    }
    let listed = git_worktrees(target)?;
    if listed.is_empty() {
        return Err(Error::Other("not a git repository".into()));
    }
    if listed.iter().any(|row| row.bare) {
        return Err(Error::Other("a bare repository cannot grow a worktree".into()));
    }
    let remote = match git_text(target, &["remote", "get-url", "origin"]) {
        Ok(GitText::Output(text)) => text,
        Ok(GitText::NotRepo) | Err(_) => String::new(),
    };
    if github_repo_slug(&remote).is_none() {
        return Err(Error::Other("this project has no GitHub remote".into()));
    }
    let reference = format!("refs/pull/{number}/head");
    let fetched = git_output(target, &["ls-remote", "origin", &reference])?;
    let Some(head) = fetched.split_whitespace().next() else {
        return Err(Error::Other(format!("pull request {number} is not open")));
    };
    if head.len() < 7 || !head.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(Error::Other(format!("pull request {number} is not open")));
    }
    let branch = format!("pr/{number}");
    if let Some(row) = listed.iter().find(|row| row.branch.as_deref() == Some(branch.as_str())) {
        return Ok(GitWorktreeAdd {
            opened: row.path.clone(),
            worktrees: listed,
        });
    }
    let refspec = format!("+{reference}:refs/heads/{branch}");
    git_run(target, &["fetch", "origin", &refspec])?;
    git_worktree_add(target, &branch, false)
}

fn local_tool(root: &Path, program: &str, args: &[&str]) -> Result<String> {
    if program.is_empty() || program.contains('/') || program.contains('\\') {
        return Err(Error::Other("invalid command".into()));
    }
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(root)
        .env("PATH", command_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|_| Error::Other(format!("{program} is not available")))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::Other("missing command stdout".into()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| Error::Other("missing command stderr".into()))?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        set_nonblocking(stdout.as_raw_fd());
        set_nonblocking(stderr.as_raw_fd());
    }
    let mut out_buf = Vec::new();
    let mut err_buf = Vec::new();
    let started = std::time::Instant::now();
    let status = loop {
        drain(&mut stdout, &mut out_buf);
        drain(&mut stderr, &mut err_buf);
        match child.try_wait() {
            Ok(Some(status)) => {
                drain(&mut stdout, &mut out_buf);
                drain(&mut stderr, &mut err_buf);
                break status;
            }
            Ok(None) if started.elapsed() > Duration::from_secs(20) => {
                kill_git(&mut child);
                return Err(Error::Other(format!("{program} timed out")));
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(err) => return Err(Error::Other(err.to_string())),
        }
    };
    if !status.success() {
        return Err(Error::Other(clip(&String::from_utf8_lossy(&err_buf))));
    }
    Ok(clip_bytes(&String::from_utf8_lossy(&out_buf)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn temp_ws() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn local(dir: &Path) -> GitTarget {
        GitTarget::local(dir).unwrap()
    }

    #[test]
    fn parse_git_status_lines() {
        let rows = parse_git_status(" M src/a.rs\n?? new.txt\nA  added.rs\n");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].path, "src/a.rs");
        assert_eq!(rows[0].status, "modified");
        assert!(!rows[0].staged);
        assert!(rows[0].unstaged);
        assert_eq!(rows[1].status, "untracked");
        assert_eq!(rows[2].status, "added");
        assert!(rows[2].staged);
        assert!(!rows[2].unstaged);
    }

    #[test]
    fn parse_rename_copy_and_partial_stage() {
        let rows = parse_git_status("R  old.rs -> src/new.rs\nMM both.rs\nC  a.rs -> b.rs\n");
        assert_eq!(rows[0].status, "renamed");
        assert_eq!(rows[0].original.as_deref(), Some("old.rs"));
        assert_eq!(rows[0].path, "src/new.rs");
        assert!(rows[0].staged);
        assert_eq!(rows[1].status, "modified");
        assert!(rows[1].staged);
        assert!(rows[1].unstaged);
        assert_eq!(rows[2].status, "copied");
        assert_eq!(rows[2].path, "b.rs");
    }

    #[test]
    fn parse_quoted_paths() {
        let rows = parse_git_status("?? \"src/my file.rs\"\nR  \"old file.rs\" -> \"src/new file.rs\"\n");
        assert_eq!(rows[0].path, "src/my file.rs");
        assert_eq!(rows[1].original.as_deref(), Some("old file.rs"));
        assert_eq!(rows[1].path, "src/new file.rs");
    }

    #[test]
    fn unquote_git_decodes_octal() {
        assert_eq!(unquote_git(r#""caf\303\251.rs""#), "café.rs");
        assert_eq!(unquote_git("plain.rs"), "plain.rs");
    }

    #[test]
    fn parse_git_numstat_lines() {
        let stats =
            parse_git_numstat("12\t3\tsrc/a.rs\n-\t-\tphoto.png\n1\t0\told.rs => src/new.rs\n");
        assert_eq!(stats.get("src/a.rs"), Some(&(12, 3)));
        assert_eq!(stats.get("photo.png"), Some(&(0, 0)));
        assert_eq!(stats.get("src/new.rs"), Some(&(1, 0)));
        assert_eq!(stats.get("old.rs"), None);
        let brace = parse_git_numstat("1\t0\tsrc/{old.rs => new.rs}\n");
        assert_eq!(brace.get("src/new.rs"), Some(&(1, 0)));
    }

    #[test]
    fn apply_git_stats_keeps_index_and_worktree_counts() {
        let mut rows = parse_git_status("MM src/a.rs\n?? new.txt\n");
        let mut staged = HashMap::new();
        staged.insert("src/a.rs".into(), (4, 1));
        let mut unstaged = HashMap::new();
        unstaged.insert("src/a.rs".into(), (8, 2));
        apply_git_stats(&mut rows, &staged, &unstaged);
        assert_eq!(rows[0].additions, 12);
        assert_eq!(rows[0].deletions, 3);
        assert!(rows[0].staged && rows[0].unstaged);
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
        git(&["config", "--local", "commit.gpgsign", "false"]);
        git(&["config", "user.email", "dev@example.com"]);
        git(&["config", "user.name", "Dev"]);
        git(&["add", "."]);
        git(&["commit", "-m", "init"]);
        fs::write(dir.path().join("README.md"), "hello\nworld\n").unwrap();
        fs::write(dir.path().join("new.txt"), "one\ntwo\nthree\n").unwrap();
        let rows = git_status(&local(dir.path())).unwrap();
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
        assert!(parsed.repo);
    }

    #[test]
    fn git_branches_reports_a_missing_repo() {
        let dir = temp_ws();
        let listed = git_branches(&local(dir.path())).unwrap();
        assert!(!listed.repo);
        assert_eq!(listed.current, None);
        assert!(listed.branches.is_empty());
        assert!(git_status(&local(dir.path())).unwrap().is_empty());
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
        assert!(sanitize_git_branch("HEAD").is_err());
        assert!(sanitize_git_branch("a1b2c3d").is_err());
        assert!(sanitize_git_branch("deadbeef").is_err());
    }

    #[test]
    fn git_switch_rejects_unsafe_name_without_running_git() {
        let dir = temp_ws();
        let err = git_switch(&local(dir.path()), "foo;rm").unwrap_err();
        assert!(err.to_string().contains("invalid"));
    }

    #[test]
    fn git_switch_refuses_a_commit_hash() {
        let dir = temp_ws();
        init_repo(dir.path());
        let err = git_switch(&local(dir.path()), "aaaaaaaa").unwrap_err();
        assert!(err.to_string().contains("branch"));
    }

    #[test]
    fn git_branches_and_switch_roundtrip() {
        let dir = temp_ws();
        init_repo(dir.path());
        Command::new("git")
            .args(["branch", "feature"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        let listed = git_branches(&local(dir.path())).unwrap();
        assert_eq!(listed.current.as_deref(), Some("main"));
        let switched = git_switch(&local(dir.path()), "feature").unwrap();
        assert_eq!(switched.current.as_deref(), Some("feature"));
    }

    #[test]
    fn stage_commit_and_log() {
        let dir = temp_ws();
        init_repo(dir.path());
        fs::write(dir.path().join("note.txt"), "hello\n").unwrap();
        let target = local(dir.path());
        git_stage(&target, &["note.txt".into()]).unwrap();
        let hash = git_commit(&target, "add note").unwrap();
        assert!(!hash.is_empty());
        let log = git_log(&target, 5).unwrap();
        assert!(log.iter().any(|row| row.subject == "add note"));
        assert!(git_status(&target).unwrap().is_empty());
    }

    #[test]
    fn commit_requires_a_message_and_staged_files() {
        let dir = temp_ws();
        init_repo(dir.path());
        let target = local(dir.path());
        assert!(git_commit(&target, "   ").is_err());
        assert!(git_commit(&target, "empty").unwrap_err().to_string().contains("nothing staged"));
    }

    #[test]
    fn parse_git_label_reads_the_branch_headers_and_counts_changes() {
        let summary = parse_git_label(
            "# branch.oid abcdef1234567890\n# branch.head feat/login\n# branch.upstream origin/feat/login\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 aa bb src/a.rs\n? src/new.txt\n",
        );
        assert!(summary.repo);
        assert_eq!(summary.current.as_deref(), Some("feat/login"));
        assert!(!summary.detached);
        assert_eq!(summary.commit.as_deref(), Some("abcdef1"));
        assert_eq!(summary.upstream.as_deref(), Some("origin/feat/login"));
        assert_eq!(summary.ahead, 2);
        assert_eq!(summary.behind, 1);
        assert_eq!(summary.dirty, 2);
    }

    #[test]
    fn parse_git_label_marks_a_detached_head_and_a_missing_repo() {
        let detached = parse_git_label("# branch.oid abcdef1234567890\n# branch.head (detached)\n");
        assert!(detached.repo);
        assert!(detached.detached);
        assert_eq!(detached.current, None);
        assert_eq!(detached.commit.as_deref(), Some("abcdef1"));
        assert_eq!(detached.dirty, 0);
        assert!(!parse_git_label("").repo);
        assert!(!parse_git_label("fatal: not a git repository\n").repo);
    }

    #[test]
    fn git_label_matches_one_status_on_a_real_repo() {
        let dir = temp_ws();
        init_repo(dir.path());
        fs::write(dir.path().join("README.md"), "changed\n").unwrap();
        fs::write(dir.path().join("note.txt"), "hello\n").unwrap();
        let summary = git_label(&local(dir.path())).unwrap();
        assert!(summary.repo);
        assert_eq!(summary.current.as_deref(), Some("main"));
        // Untracked files are left out. The label is one status, not a full listing.
        assert_eq!(summary.dirty, 1);
        assert_eq!(summary.ahead, 0);
        assert_eq!(summary.behind, 0);
    }

    #[test]
    fn parse_log_records() {
        let rows = parse_git_log("abc\u{1f}ab\u{1f}Ada\u{1f}2026-01-01T00:00:00Z\u{1f}Hello\n");
        assert_eq!(rows[0].short, "ab");
        assert_eq!(rows[0].author, "Ada");
        assert_eq!(rows[0].subject, "Hello");
    }

    #[test]
fn parse_worktree_list_reads_main_linked_detached_and_bare() {
    let text = "\
worktree /work/billing
HEAD abcdef1234567890abcdef1234567890abcdef12
branch refs/heads/main

worktree /work/billing-worktrees/feat-login
HEAD 1234567890abcdef1234567890abcdef12345678
branch refs/heads/feat/login

worktree /work/billing-worktrees/notes
HEAD 9999999999999999999999999999999999999999
detached

worktree /work/billing.git
HEAD abcdef1234567890abcdef1234567890abcdef12
bare
";
    let rows = parse_worktree_list(text);
    assert_eq!(rows.len(), 4);
    assert!(rows[0].main);
    assert_eq!(rows[0].path, "/work/billing");
    assert_eq!(rows[0].branch.as_deref(), Some("main"));
    assert!(!rows[0].bare && !rows[0].detached);
    assert!(!rows[1].main);
    assert_eq!(rows[1].branch.as_deref(), Some("feat/login"));
    assert_eq!(rows[1].path, "/work/billing-worktrees/feat-login");
    assert!(rows[2].detached);
    assert_eq!(rows[2].branch, None);
    assert!(rows[3].bare);
    assert!(parse_worktree_list("").is_empty());
    assert!(parse_worktree_list("fatal: not a git repository\n").is_empty());
}

#[test]
fn worktree_destination_lives_inside_the_project_and_flattens_slashes() {
    let main = Path::new("/work/billing");
    let home = WorktreeHome { inside: true, root: main.join("worktrees") };
    let dest = worktree_destination(&home, "feat/login").unwrap();
    assert_eq!(dest, PathBuf::from("/work/billing/worktrees/feat-login"));
    assert!(worktree_destination(&home, "foo;rm").is_err());
    assert!(worktree_destination(&home, "").is_err());
}

#[test]
fn an_opened_folder_keeps_worktrees_in_app_data() {
    let projects = Path::new("/Users/me/twanagent-dev/projects");
    let owned = Path::new("/Users/me/twanagent-dev/projects/billing");
    let opened = Path::new("/Users/me/code/billing");
    let data = Path::new("/Users/me/Library/Application Support/app.twanagent.desktop-dev");
    let inside = worktree_home(owned, &[projects], data);
    assert!(inside.inside);
    assert_eq!(inside.root, PathBuf::from("/Users/me/twanagent-dev/projects/billing/worktrees"));
    let outside = worktree_home(opened, &[projects], data);
    assert!(!outside.inside);
    let dest = worktree_destination(&outside, "feat/login").unwrap();
    assert!(dest.starts_with(data.join("worktrees")));
    assert!(dest.ends_with("feat-login"));
    assert!(!dest.starts_with(opened));
    assert_eq!(
        external_worktree_root(data, opened),
        outside.root,
    );
}

#[test]
fn git_worktrees_lists_a_real_add() {
    let dir = temp_ws();
    let (repo, target) = owned_repo(&dir);
    let added = git_worktree_add(&target, "feat/login", true).unwrap();
    assert!(added.opened.contains("worktrees"));
    assert!(added.opened.contains("feat-login"));
    assert!(fs::canonicalize(&added.opened).unwrap().starts_with(fs::canonicalize(&repo).unwrap()));
    let exclude = fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
    assert!(exclude.lines().any(|line| line.trim() == "/worktrees/"));
    let names: Vec<_> = added
        .worktrees
        .iter()
        .filter_map(|row| row.branch.clone())
        .collect();
    assert!(names.iter().any(|name| name == "main"));
    assert!(names.iter().any(|name| name == "feat/login"));
    let linked = added
        .worktrees
        .iter()
        .find(|row| row.branch.as_deref() == Some("feat/login"))
        .unwrap();
    assert!(!linked.main);
    assert!(Path::new(&linked.path).join("README.md").is_file());
    let main_branch = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&repo)
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&main_branch.stdout).trim(), "main");
    let again = git_worktree_add(&target, "feat/login", true).unwrap_err();
    assert!(again.to_string().contains("already checked out"));
}

#[test]
fn git_worktree_remove_refuses_a_dirty_tree_and_keeps_the_branch() {
    let dir = temp_ws();
    let (repo, target) = owned_repo(&dir);
    let added = git_worktree_add(&target, "feature", true).unwrap();
    let linked = added
        .worktrees
        .iter()
        .find(|row| !row.main)
        .unwrap()
        .path
        .clone();
    fs::write(Path::new(&linked).join("note.txt"), "dirty\n").unwrap();
    let dirty = git_worktree_remove(&target, &linked).unwrap_err();
    assert!(Path::new(&linked).exists(), "{dirty}");
    fs::remove_file(Path::new(&linked).join("note.txt")).unwrap();
    let left = git_worktree_remove(&target, &linked).unwrap();
    assert!(!Path::new(&linked).exists());
    assert!(left.iter().all(|row| row.main || row.path != linked));
    let branches = git_branches(&target).unwrap();
    assert!(branches.branches.iter().any(|name| name == "feature"));
    let main = git_worktree_remove(&target, repo.to_str().unwrap()).unwrap_err();
    assert!(main.to_string().contains("main checkout"));
}

#[test]
fn git_worktree_rename_moves_the_branch_and_the_folder() {
    let dir = temp_ws();
    let (repo, target) = owned_repo(&dir);
    let added = git_worktree_add(&target, "wip", true).unwrap();
    let linked = added
        .worktrees
        .iter()
        .find(|row| !row.main)
        .unwrap()
        .path
        .clone();
    fs::write(Path::new(&linked).join("note.txt"), "kept\n").unwrap();
    let renamed = git_worktree_rename(&target, &linked, "feat/login").unwrap();
    assert!(!Path::new(&linked).exists());
    assert!(renamed.opened.contains("worktrees"));
    assert!(renamed.opened.contains("feat-login"));
    let row = renamed
        .worktrees
        .iter()
        .find(|row| row.branch.as_deref() == Some("feat/login"))
        .unwrap();
    assert!(!row.main);
    assert_eq!(
        fs::read_to_string(Path::new(&row.path).join("note.txt")).unwrap(),
        "kept\n"
    );
    let branches = git_branches(&local(&repo)).unwrap();
    assert!(branches.branches.iter().any(|name| name == "feat/login"));
    assert!(!branches.branches.iter().any(|name| name == "wip"));
    let same = git_worktree_rename(&target, &row.path, "feat/login").unwrap();
    assert_eq!(same.opened, row.path);
    let main = git_worktree_rename(&target, repo.to_str().unwrap(), "other").unwrap_err();
    assert!(main.to_string().contains("main checkout"));
}

#[test]
fn an_opened_folder_checks_a_worktree_out_beside_app_data() {
    let dir = temp_ws();
    let projects = dir.path().join("projects");
    let data = dir.path().join("app-data");
    let opened = dir.path().join("code").join("billing");
    fs::create_dir_all(&opened).unwrap();
    init_repo(&opened);
    let target = GitTarget::local_in(&opened, &[projects], &data).unwrap();
    let added = git_worktree_add(&target, "feat/login", true).unwrap();
    let opened_canon = fs::canonicalize(&added.opened).unwrap();
    let home = fs::canonicalize(external_worktree_root(&data, &fs::canonicalize(&opened).unwrap())).unwrap();
    assert!(opened_canon.starts_with(&home));
    assert!(added.opened.contains("feat-login"));
    assert!(!opened.join("worktrees").exists());
    assert!(Path::new(&added.opened).join("README.md").is_file());
    fs::remove_dir_all(&home).unwrap();
    assert!(!opened_canon.exists());
}

#[test]
fn project_removal_splits_the_main_checkout_from_its_worktrees() {
    let dir = temp_ws();
    let (repo, target) = owned_repo(&dir);
    let added = git_worktree_add(&target, "feat/login", true).unwrap();
    let linked = added
        .worktrees
        .iter()
        .find(|row| !row.main)
        .unwrap()
        .path
        .clone();
    fs::write(Path::new(&linked).join("big.bin"), vec![1u8; 64 * 1024]).unwrap();
    let commit = |args: &[&str]| {
        let out = Command::new("git").args(args).current_dir(&linked).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    };
    commit(&["add", "big.bin"]);
    commit(&["commit", "-m", "add a large file"]);
    let data = dir.path().join("app-data");
    let projects = dir.path().join("projects");
    fs::create_dir_all(&data).unwrap();
    let report = project_removal(&target, &data, &[&projects]);
    assert!(report.app_managed);
    assert_eq!(report.worktree_count, 1);
    assert!(report.worktrees >= 64 * 1024, "worktrees {}", report.worktrees);
    assert!(report.project > 0);
    assert!(report.project < report.worktrees, "project {} includes the worktree", report.project);
    let removed = remove_project_worktrees(&target, &data).unwrap();
    assert_eq!(removed, vec![linked.clone()]);
    assert!(!Path::new(&linked).exists());
    assert!(repo.join("README.md").is_file());
    let after = project_removal(&target, &data, &[&projects]);
    assert_eq!(after.worktree_count, 0);
    assert_eq!(after.worktrees, 0);
}

#[test]
fn git_worktrees_reports_a_missing_repo() {
    let dir = temp_ws();
    assert!(git_worktrees(&local(dir.path())).unwrap().is_empty());
}

#[test]
fn github_repo_slug_reads_https_and_ssh_and_refuses_other_hosts() {
    assert_eq!(
        github_repo_slug("https://github.com/TwanLuttik/TwanAgent.git\n").as_deref(),
        Some("TwanLuttik/TwanAgent")
    );
    assert_eq!(
        github_repo_slug("git@github.com:TwanLuttik/TwanAgent.git").as_deref(),
        Some("TwanLuttik/TwanAgent")
    );
    assert_eq!(
        github_repo_slug("ssh://git@github.com/TwanLuttik/TwanAgent").as_deref(),
        Some("TwanLuttik/TwanAgent")
    );
    assert_eq!(github_repo_slug("https://gitlab.com/a/b.git"), None);
    assert_eq!(github_repo_slug("git@github.com:only-one"), None);
    assert_eq!(github_repo_slug("https://github.com/a/b/extra"), None);
    assert_eq!(github_repo_slug(""), None);
}

#[test]
fn parse_pull_request_heads_keeps_open_requests_newest_first() {
    let text = "\
abc1234\trefs/pull/4/head
def5678\trefs/pull/12/head
not-a-sha\trefs/pull/3/head
abc1234\trefs/pull/4/merge
999\trefs/heads/main
";
    let rows = parse_pull_request_heads(text, "TwanLuttik/TwanAgent");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].number, 12);
    assert_eq!(rows[0].branch, "pr/12");
    assert_eq!(rows[0].url, "https://github.com/TwanLuttik/TwanAgent/pull/12");
    assert_eq!(rows[1].number, 4);
    assert!(parse_pull_request_heads("fatal: not a git repository", "a/b").is_empty());
    assert!(rows.iter().all(|row| row.open));
    let states = parse_pull_request_states(
        r#"[{"number":12,"title":"Show open pull requests","state":"OPEN"},{"number":4,"title":"Old","state":"MERGED"},{"number":0,"title":"nope","state":"OPEN"}]"#,
    )
    .unwrap();
    assert!(states.get(&12).unwrap().open);
    assert_eq!(states.get(&12).unwrap().title, "Show open pull requests");
    assert!(!states.get(&4).unwrap().open);
    assert!(parse_pull_request_states("not json").is_none());
}

#[test]
fn pull_request_checkout_refuses_a_repo_without_github() {
    let dir = temp_ws();
    init_repo(dir.path());
    let err = git_pull_request_checkout(&local(dir.path()), 4).unwrap_err();
    assert!(err.to_string().contains("GitHub"));
    assert!(git_pull_requests(&local(dir.path())).unwrap().is_empty());
}

fn owned_repo(dir: &tempfile::TempDir) -> (PathBuf, GitTarget) {
    let projects = dir.path().join("projects");
    let repo = projects.join("billing");
    fs::create_dir_all(&repo).unwrap();
    init_repo(&repo);
    let target = GitTarget::local_in(&repo, &[projects], &dir.path().join("app-data")).unwrap();
    (repo, target)
}

fn init_repo(path: &Path) {
        fs::write(path.join("README.md"), "hi").unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .args(args)
                .current_dir(path)
                .output()
                .unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-b", "main"]);
        git(&["config", "--local", "commit.gpgsign", "false"]);
        git(&["config", "user.email", "dev@example.com"]);
        git(&["config", "user.name", "Dev"]);
        git(&["add", "."]);
        git(&["commit", "-m", "init"]);
    }
}
