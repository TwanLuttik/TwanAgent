//! GitHub pull requests. `ls-remote` lists heads. `gh` says which are still open.

use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use super::worktree::{git_worktree_add, git_worktrees, GitWorktreeAdd};
use super::{
    clip, clip_bytes, drain, git_output, git_run, git_text, kill_git, GitTarget, GitText,
};
use serde::{Deserialize, Serialize};

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

/// The pull request for the branch that is checked out. `gh pr view` is the source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitBranchPullRequest {
    pub number: u32,
    pub title: String,
    pub state: String,
    pub body: String,
    pub author: String,
    pub base: String,
    pub head: String,
    pub url: String,
    pub additions: u32,
    pub deletions: u32,
    pub changed: u32,
    pub review: String,
    pub checks: GitPullRequestChecks,
    pub commits: Vec<GitPullRequestCommit>,
    pub files: Vec<GitPullRequestFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitPullRequestChecks {
    pub pass: u32,
    pub fail: u32,
    pub pending: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitPullRequestCommit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub at: String,
    pub subject: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitPullRequestFile {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}

/// `gh pr view --json` for the current branch. None when the payload is not a pull request.
pub fn parse_branch_pull_request(text: &str) -> Option<GitBranchPullRequest> {
    let value: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    let number = json_u32(&value, "number");
    if number == 0 {
        return None;
    }
    let draft = value.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false);
    let raw_state = value.get("state").and_then(|v| v.as_str()).unwrap_or("");
    let state = if raw_state.eq_ignore_ascii_case("merged") {
        "merged"
    } else if raw_state.eq_ignore_ascii_case("closed") {
        "closed"
    } else if draft {
        "draft"
    } else {
        "open"
    };
    let title = clip_text(
        value.get("title").and_then(|v| v.as_str()).unwrap_or("").trim(),
        180,
    );
    let title = if title.is_empty() {
        format!("Pull request #{number}")
    } else {
        title
    };
    let author = value
        .get("author")
        .and_then(|author| {
            author
                .get("login")
                .and_then(|v| v.as_str())
                .filter(|login| !login.is_empty())
                .or_else(|| author.get("name").and_then(|v| v.as_str()))
        })
        .unwrap_or("")
        .trim()
        .to_string();
    let review = match value.get("reviewDecision").and_then(|v| v.as_str()).unwrap_or("") {
        "APPROVED" => "approved",
        "CHANGES_REQUESTED" => "changes",
        "REVIEW_REQUIRED" => "review",
        _ => "",
    };
    let mut commits = Vec::new();
    if let Some(rows) = value.get("commits").and_then(|v| v.as_array()) {
        for row in rows.iter().take(40) {
            let hash = row.get("oid").and_then(|v| v.as_str()).unwrap_or("").trim();
            if hash.len() < 7 {
                continue;
            }
            let author = row
                .get("authors")
                .and_then(|v| v.as_array())
                .and_then(|authors| authors.first())
                .and_then(|author| {
                    author
                        .get("login")
                        .and_then(|v| v.as_str())
                        .filter(|login| !login.is_empty())
                        .or_else(|| author.get("name").and_then(|v| v.as_str()))
                })
                .unwrap_or("")
                .trim()
                .to_string();
            commits.push(GitPullRequestCommit {
                short: hash.chars().take(7).collect(),
                hash: hash.to_string(),
                author,
                at: row.get("authoredDate").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                subject: clip_text(
                    row.get("messageHeadline").and_then(|v| v.as_str()).unwrap_or("").trim(),
                    200,
                ),
            });
        }
    }
    let file_rows = value.get("files").and_then(|v| v.as_array());
    let mut changed = json_u32(&value, "changedFiles");
    if changed == 0 {
        changed = file_rows.map(|rows| rows.len().min(u32::MAX as usize) as u32).unwrap_or(0);
    }
    let mut files = Vec::new();
    if let Some(rows) = file_rows {
        for row in rows.iter().take(80) {
            let path = row.get("path").and_then(|v| v.as_str()).unwrap_or("").trim();
            if path.is_empty() {
                continue;
            }
            files.push(GitPullRequestFile {
                path: path.to_string(),
                additions: json_u32(row, "additions"),
                deletions: json_u32(row, "deletions"),
            });
        }
    }
    Some(GitBranchPullRequest {
        number,
        title,
        state: state.to_string(),
        body: clip_text(value.get("body").and_then(|v| v.as_str()).unwrap_or("").trim(), 6_000),
        author,
        base: value.get("baseRefName").and_then(|v| v.as_str()).unwrap_or("").trim().to_string(),
        head: value.get("headRefName").and_then(|v| v.as_str()).unwrap_or("").trim().to_string(),
        url: value.get("url").and_then(|v| v.as_str()).unwrap_or("").trim().to_string(),
        additions: json_u32(&value, "additions"),
        deletions: json_u32(&value, "deletions"),
        changed,
        review: review.to_string(),
        checks: count_checks(value.get("statusCheckRollup")),
        commits,
        files,
    })
}

fn json_u32(value: &serde_json::Value, key: &str) -> u32 {
    value
        .get(key)
        .and_then(|n| n.as_u64().or_else(|| n.as_i64().filter(|n| *n > 0).map(|n| n as u64)))
        .unwrap_or(0)
        .min(u64::from(u32::MAX)) as u32
}

fn clip_text(text: &str, max: usize) -> String {
    let mut out = String::new();
    for (i, ch) in text.chars().enumerate() {
        if i >= max {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

fn count_checks(value: Option<&serde_json::Value>) -> GitPullRequestChecks {
    let mut checks = GitPullRequestChecks { pass: 0, fail: 0, pending: 0 };
    let Some(rows) = value.and_then(|v| v.as_array()) else {
        return checks;
    };
    for row in rows {
        let kind = row.get("__typename").and_then(|v| v.as_str()).unwrap_or("");
        if kind == "CheckRun" {
            let status = row.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let conclusion = row.get("conclusion").and_then(|v| v.as_str()).unwrap_or("");
            if !status.eq_ignore_ascii_case("completed") {
                checks.pending += 1;
                continue;
            }
            match conclusion.to_ascii_uppercase().as_str() {
                "SUCCESS" | "NEUTRAL" | "SKIPPED" => checks.pass += 1,
                "FAILURE" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => {
                    checks.fail += 1
                }
                _ => checks.pending += 1,
            }
        } else {
            match row.get("state").and_then(|v| v.as_str()).unwrap_or("").to_ascii_uppercase().as_str() {
                "SUCCESS" => checks.pass += 1,
                "FAILURE" | "ERROR" => checks.fail += 1,
                _ => checks.pending += 1,
            }
        }
    }
    checks
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
        super::set_nonblocking(stdout.as_raw_fd());
        super::set_nonblocking(stderr.as_raw_fd());
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

const BRANCH_PULL_REQUEST_FIELDS: &str = "number,title,state,isDraft,body,author,baseRefName,headRefName,url,additions,deletions,changedFiles,reviewDecision,statusCheckRollup,commits,files";

/// The open request for the checked-out branch. Missing `gh`, or no request, is an empty result.
pub fn git_branch_pull_request(target: &GitTarget) -> Result<Option<GitBranchPullRequest>> {
    if target.remote.is_some() {
        return Ok(None);
    }
    match local_tool(target.root.as_path(), "gh", &["pr", "view", "--json", BRANCH_PULL_REQUEST_FIELDS]) {
        Ok(text) => Ok(parse_branch_pull_request(&text)),
        Err(_) => Ok(None),
    }
}
