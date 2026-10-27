//! GitHub pull requests. `ls-remote` lists heads. `gh` says which are still open.

use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use super::worktree::{git_worktree_add, git_worktrees, GitWorktreeAdd};
use super::{
    clip, clip_bytes, drain, git_output, git_run, git_text, kill_git, set_nonblocking, GitTarget, GitText,
};
use crate::env_path::command_path;
use crate::error::{Error, Result};

use super::GitPullRequest;

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
