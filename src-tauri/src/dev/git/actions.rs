//! GitHub Actions runs. One `gh run list` for the repo. The pane decides what to show.

use serde::{Deserialize, Serialize};

use super::pull_request::local_tool;
use super::GitTarget;
use crate::error::{Error, Result};

const RUN_FIELDS: &str =
    "databaseId,workflowName,name,displayTitle,status,conclusion,headBranch,url,createdAt,startedAt,updatedAt";

/// One workflow run, trimmed from `gh run list --json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitActionRun {
    pub id: u64,
    pub workflow: String,
    pub title: String,
    pub status: String,
    pub conclusion: String,
    pub branch: String,
    pub url: String,
    pub started_at: String,
    pub updated_at: String,
}

/// The list last saved for a repo, plus when that save happened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitActionsSnapshot {
    pub runs: Vec<GitActionRun>,
    pub fetched_at: String,
}

/// `None` when `gh` did not return a JSON list. An empty list is a real answer.
pub fn parse_action_runs(text: &str) -> Option<Vec<GitActionRun>> {
    let value: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    let rows = value.as_array()?;
    let mut out = Vec::new();
    for row in rows.iter().take(40) {
        let id = row.get("databaseId").and_then(|n| n.as_u64()).unwrap_or(0);
        if id == 0 {
            continue;
        }
        let workflow = first_text(row, &["workflowName", "name", "displayTitle"]);
        let title = first_text(row, &["displayTitle", "name", "workflowName"]);
        let workflow = if workflow.is_empty() {
            title.clone()
        } else {
            workflow
        };
        if workflow.is_empty() {
            continue;
        }
        let started = first_text(row, &["startedAt", "createdAt"]);
        let mut updated = first_text(row, &["updatedAt"]);
        if updated.is_empty() {
            updated = started.clone();
        }
        out.push(GitActionRun {
            id,
            workflow: clip(&workflow, 120),
            title: clip(&title, 200),
            status: lower_text(row.get("status")),
            conclusion: lower_text(row.get("conclusion")),
            branch: clip(&first_text(row, &["headBranch"]), 200),
            url: github_url(row.get("url")),
            started_at: started,
            updated_at: updated,
        });
    }
    Some(out)
}

/// Recent runs for a GitHub repo on this machine. The caller already checked the remote.
pub fn fetch_action_runs(target: &GitTarget) -> Result<Vec<GitActionRun>> {
    let text = local_tool(
        target.root.as_path(),
        "gh",
        &["run", "list", "--limit", "40", "--json", RUN_FIELDS],
    )?;
    parse_action_runs(&text).ok_or_else(|| Error::Other("could not read GitHub Actions".into()))
}

fn first_text(row: &serde_json::Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(text) = row.get(*key).and_then(|value| value.as_str()) {
            let text = text.trim();
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

fn lower_text(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

fn github_url(value: Option<&serde_json::Value>) -> String {
    let url = value.and_then(|value| value.as_str()).unwrap_or("").trim();
    if url.starts_with("https://github.com/") {
        url.to_string()
    } else {
        String::new()
    }
}

fn clip(text: &str, max: usize) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_action_runs_reads_a_gh_run_list() {
        let text = r#"[
          {
            "databaseId": 42,
            "workflowName": "CI",
            "name": "CI",
            "displayTitle": "Restyle the git pane",
            "status": "in_progress",
            "conclusion": "",
            "headBranch": "main",
            "url": "https://github.com/acme/app/actions/runs/42",
            "createdAt": "2026-04-08T12:00:00Z",
            "startedAt": "2026-04-08T12:01:00Z",
            "updatedAt": "2026-04-08T12:04:00Z"
          },
          {
            "databaseId": 7,
            "workflowName": "",
            "name": "Lint",
            "displayTitle": "Lint",
            "status": "completed",
            "conclusion": null,
            "headBranch": "feature/login",
            "url": "https://github.com/acme/app/actions/runs/7",
            "createdAt": "2026-04-08T11:00:00Z",
            "startedAt": null,
            "updatedAt": "2026-04-08T11:05:00Z"
          },
          {"databaseId": 0, "workflowName": "skip me"}
        ]"#;
        let rows = parse_action_runs(text).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, 42);
        assert_eq!(rows[0].workflow, "CI");
        assert_eq!(rows[0].title, "Restyle the git pane");
        assert_eq!(rows[0].status, "in_progress");
        assert_eq!(rows[0].conclusion, "");
        assert_eq!(rows[0].branch, "main");
        assert_eq!(rows[0].started_at, "2026-04-08T12:01:00Z");
        assert_eq!(rows[1].workflow, "Lint");
        assert_eq!(rows[1].conclusion, "");
        assert_eq!(rows[1].started_at, "2026-04-08T11:00:00Z");
        assert!(parse_action_runs("not json").is_none());
        assert_eq!(parse_action_runs("[]").unwrap().len(), 0);
    }
}
