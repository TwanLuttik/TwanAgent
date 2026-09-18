use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use super::paths::{path_string, projects_dir, resolve_typed_path};
use crate::error::{Error, Result};

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

#[cfg(test)]
mod tests {
    use super::super::paths::projects_dir;
    use super::*;
    use std::fs;
    use std::process::Command;

    fn temp_ws() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
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
}
