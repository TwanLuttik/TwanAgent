//! Git for a project group. Each member keeps its own repository.
//! Paths that cross the group boundary are `alias/file`.

use super::git::{
    git_commit, git_diff, git_discard, git_file_at, git_stage, git_status_with, git_unstage,
    GitTarget,
};
use super::group::{GroupLayout, GroupPath};
use super::types::GitChange;
use crate::error::{Error, Result};

pub const OPEN_REPO: &str = "commit this repository from its own folder";

pub fn status(layout: &GroupLayout, stats: bool) -> Result<Vec<GitChange>> {
    let mut out = Vec::new();
    for member in &layout.members {
        let target = GitTarget::local(&member.path)?;
        let mut rows = git_status_with(&target, stats)?;
        for row in &mut rows {
            row.path = prefix(&member.alias, &row.path);
            if let Some(original) = row.original.as_mut() {
                *original = prefix(&member.alias, original);
            }
        }
        out.extend(rows);
    }
    Ok(out)
}

pub fn diff(layout: &GroupLayout, rel: &str) -> Result<String> {
    let rel = rel.trim();
    if rel.is_empty() {
        let mut parts = Vec::new();
        for member in &layout.members {
            let target = GitTarget::local(&member.path)?;
            let text = git_diff(&target, "")?;
            if !text.trim().is_empty() {
                parts.push(prefix_diff(&text, &member.alias));
            }
        }
        return Ok(parts.join("\n"));
    }
    match layout.split(rel)? {
        GroupPath::Root => Err(Error::Other(OPEN_REPO.into())),
        GroupPath::Member { root, rest, alias } => {
            let target = GitTarget::local(&root)?;
            Ok(prefix_diff(&git_diff(&target, &rest)?, &alias))
        }
    }
}

pub fn stage(layout: &GroupLayout, paths: &[String]) -> Result<Vec<GitChange>> {
    let scoped = one_member(layout, paths)?;
    let target = GitTarget::local(&scoped.root)?;
    git_stage(&target, &scoped.paths)?;
    status(layout, false)
}

pub fn unstage(layout: &GroupLayout, paths: &[String]) -> Result<Vec<GitChange>> {
    let scoped = one_member(layout, paths)?;
    let target = GitTarget::local(&scoped.root)?;
    git_unstage(&target, &scoped.paths)?;
    status(layout, false)
}

pub fn discard(layout: &GroupLayout, paths: &[String]) -> Result<Vec<GitChange>> {
    let scoped = one_member(layout, paths)?;
    let target = GitTarget::local(&scoped.root)?;
    git_discard(&target, &scoped.paths)?;
    status(layout, false)
}

/// Stage and commit files in one member. An empty path list does not commit every repository.
pub fn commit_one(layout: &GroupLayout, message: &str, paths: &[String]) -> Result<String> {
    if paths.is_empty() {
        return Err(Error::Other(OPEN_REPO.into()));
    }
    let scoped = one_member(layout, paths)?;
    let target = GitTarget::local(&scoped.root)?;
    git_stage(&target, &scoped.paths)?;
    git_commit(&target, message)
}

pub fn open_member_error() -> Error {
    Error::Other("open that repository".into())
}

pub fn file_at(layout: &GroupLayout, rel: &str, revision: &str) -> Result<String> {
    match layout.split(rel)? {
        GroupPath::Member { root, rest, .. } if !rest.is_empty() => {
            let target = GitTarget::local(&root)?;
            git_file_at(&target, &rest, revision)
        }
        _ => Err(Error::Other(OPEN_REPO.into())),
    }
}

struct Scoped {
    root: std::path::PathBuf,
    paths: Vec<String>,
}

fn one_member(layout: &GroupLayout, paths: &[String]) -> Result<Scoped> {
    if paths.is_empty() {
        return Err(Error::Other("name the repository to change".into()));
    }
    let mut root = None;
    let mut alias: Option<String> = None;
    let mut scoped = Vec::new();
    for path in paths {
        match layout.split(path)? {
            GroupPath::Root => {
                return Err(Error::Other(
                    "path must be inside a repository in the group".into(),
                ))
            }
            GroupPath::Member {
                alias: next,
                root: member,
                rest,
            } => {
                if rest.is_empty() {
                    return Err(Error::Other(
                        "path must be inside a repository in the group".into(),
                    ));
                }
                if let Some(prev) = &alias {
                    if !prev.eq_ignore_ascii_case(&next) {
                        return Err(Error::Other("a change cannot span two repositories".into()));
                    }
                }
                alias = Some(next);
                root = Some(member);
                scoped.push(rest);
            }
        }
    }
    Ok(Scoped {
        root: root.ok_or_else(|| Error::Other("name the repository to change".into()))?,
        paths: scoped,
    })
}

fn prefix(alias: &str, path: &str) -> String {
    let path = path.trim_matches('/');
    if path.is_empty() {
        alias.to_string()
    } else {
        format!("{alias}/{path}")
    }
}

pub fn prefix_diff(text: &str, alias: &str) -> String {
    let mut out = String::new();
    for line in text.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\n', '\r']);
        let newline = &line[bare.len()..];
        let rewritten = if let Some(rest) = bare.strip_prefix("diff --git ") {
            prefix_git_header(rest, alias)
        } else if let Some(rest) = bare.strip_prefix("--- a/") {
            format!("--- a/{alias}/{rest}")
        } else if let Some(rest) = bare.strip_prefix("+++ b/") {
            format!("+++ b/{alias}/{rest}")
        } else if let Some(rest) = bare.strip_prefix("rename from ") {
            format!("rename from {alias}/{rest}")
        } else if let Some(rest) = bare.strip_prefix("rename to ") {
            format!("rename to {alias}/{rest}")
        } else if let Some(rest) = bare.strip_prefix("copy from ") {
            format!("copy from {alias}/{rest}")
        } else if let Some(rest) = bare.strip_prefix("copy to ") {
            format!("copy to {alias}/{rest}")
        } else {
            bare.to_string()
        };
        out.push_str(&rewritten);
        out.push_str(newline);
    }
    out
}

fn prefix_git_header(rest: &str, alias: &str) -> String {
    let Some(index) = rest.rfind(" b/") else {
        return format!("diff --git {rest}");
    };
    let left = rest[..index].trim_start_matches("a/");
    let right = &rest[index + 3..];
    format!("diff --git a/{alias}/{left} b/{alias}/{right}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dev::group::create_group;
    use std::fs;
    use std::process::Command;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn repo(name: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = temp_dir();
        let path = dir.path().join(name);
        fs::create_dir(&path).unwrap();
        git(&path, &["init"]);
        git(&path, &["config", "user.email", "dev@example.com"]);
        git(&path, &["config", "user.name", "Dev"]);
        fs::write(path.join("file.txt"), "one\n").unwrap();
        git(&path, &["add", "file.txt"]);
        git(&path, &["commit", "-m", "init"]);
        fs::write(path.join("file.txt"), "two\n").unwrap();
        (dir, path)
    }

    #[test]
    fn status_and_diff_prefix_each_repository_and_commit_stays_in_one() {
        let data = temp_dir();
        let projects = temp_dir();
        let (api_keep, api) = repo("api");
        let (web_keep, web) = repo("web");
        let created = create_group(
            data.path(),
            projects.path(),
            "apps",
            &[api.clone(), web.clone()],
        )
        .unwrap();
        let layout = crate::dev::group::layout(std::path::Path::new(&created.path)).unwrap();
        let rows = status(&layout, false).unwrap();
        let paths: Vec<_> = rows.iter().map(|row| row.path.as_str()).collect();
        assert!(paths.contains(&"api/file.txt"), "{paths:?}");
        assert!(paths.contains(&"web/file.txt"), "{paths:?}");
        let text = diff(&layout, "").unwrap();
        assert!(text.contains("a/api/file.txt"), "{text}");
        assert!(text.contains("a/web/file.txt"), "{text}");

        let err = stage(&layout, &["api/file.txt".into(), "web/file.txt".into()]).unwrap_err();
        assert!(err.to_string().contains("two repositories"));
        let still = status(&layout, false).unwrap();
        assert!(still.iter().all(|row| !row.staged));

        let hash = commit_one(&layout, "api only", &["api/file.txt".into()]).unwrap();
        assert!(!hash.is_empty());
        let after = status(&layout, false).unwrap();
        assert!(after.iter().any(|row| row.path == "web/file.txt"));
        assert!(!after.iter().any(|row| row.path == "api/file.txt"));
        assert!(commit_one(&layout, "nope", &[]).is_err());
        drop(api_keep);
        drop(web_keep);
    }

    #[test]
    fn diff_prefix_rewrites_headers() {
        let raw = "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n";
        let text = prefix_diff(raw, "api");
        assert!(text.contains("diff --git a/api/file.txt b/api/file.txt"));
        assert!(text.contains("--- a/api/file.txt"));
        assert!(text.contains("+++ b/api/file.txt"));
    }
}
