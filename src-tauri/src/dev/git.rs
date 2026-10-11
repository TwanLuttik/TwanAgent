use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::Command;

use super::paths::resolve_in_workspace;
use super::types::{GitBranches, GitChange};
use crate::error::{Error, Result};

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

enum GitText {
    Output(String),
    NotRepo,
}

fn git_text(workspace: &Path, args: &[&str]) -> Result<GitText> {
    match crate::remote::git::try_remote(workspace, args) {
        Ok(Some(text)) => return Ok(GitText::Output(text)),
        Ok(None) => {}
        Err(err) if err.to_string().contains("not a git repository") => {
            return Ok(GitText::NotRepo);
        }
        Err(err) => return Err(err),
    }
    let out = Command::new("git")
        .args(args)
        .current_dir(workspace)
        .output()
        .map_err(|_| Error::Other("git is not available".into()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("not a git repository") {
            return Ok(GitText::NotRepo);
        }
        return Err(Error::Other(err.trim().to_string()));
    }
    Ok(GitText::Output(
        String::from_utf8_lossy(&out.stdout).into_owned(),
    ))
}

fn git_output(workspace: &Path, args: &[&str]) -> Result<String> {
    match git_text(workspace, args)? {
        GitText::Output(text) => Ok(text),
        GitText::NotRepo => Ok(String::new()),
    }
}

pub fn git_status(workspace: &Path) -> Result<Vec<GitChange>> {
    git_status_with(workspace, true)
}

/// `stats` runs `git diff --numstat` and reads untracked files. The file tree
/// only needs paths, so it skips that work.
pub fn git_status_with(workspace: &Path, stats: bool) -> Result<Vec<GitChange>> {
    let root = resolve_in_workspace(workspace, "")?;
    let text = git_output(&root, &["status", "--porcelain=v1", "-uall"])?;
    let mut rows = parse_git_status(&text);
    if !stats || rows.is_empty() {
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
    if let Some(text) = crate::remote::git::try_remote(workspace, args)? {
        return Ok(text);
    }
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
    match git_text(&root, &["branch", "--list"])? {
        GitText::NotRepo => Ok(GitBranches {
            current: None,
            branches: Vec::new(),
            repo: false,
        }),
        GitText::Output(text) => {
            let mut listed = parse_git_branches(&text);
            if listed.current.is_none() {
                if let Ok(GitText::Output(head)) =
                    git_text(&root, &["rev-parse", "--abbrev-ref", "HEAD"])
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::process::Command;

    fn temp_ws() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
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
        assert!(parsed.repo);
    }

    #[test]
    fn git_branches_reports_a_missing_repo() {
        let dir = temp_ws();
        let listed = git_branches(dir.path()).unwrap();
        assert!(!listed.repo);
        assert_eq!(listed.current, None);
        assert!(listed.branches.is_empty());
        assert!(git_status(dir.path()).unwrap().is_empty());
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
}
