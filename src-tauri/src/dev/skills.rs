use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::error::{Error, Result};
use crate::grok_cli::grok_home;
use crate::paths::relative_to;

use super::files::{read_file, write_file};
use super::paths::{home_dir, resolve_in_workspace};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SkillFileRow {
    pub path: String,
    pub read_path: String,
    pub home: bool,
    pub origin: String,
}

pub fn list_skill_files(workspace: Option<&Path>) -> Result<Vec<SkillFileRow>> {
    let home = home_dir().ok_or_else(|| Error::Other("home folder is unknown".into()))?;
    let grok = grok_home().unwrap_or_else(|| home.join(".grok"));
    Ok(collect_skill_files(&home, &grok, workspace))
}

pub fn read_user_skill(path: &str) -> Result<String> {
    let home = home_dir().ok_or_else(|| Error::Other("home folder is unknown".into()))?;
    read_file(&home, allow_user_skill(path)?)
}

pub fn write_user_skill(path: &str, contents: &str) -> Result<()> {
    let home = home_dir().ok_or_else(|| Error::Other("home folder is unknown".into()))?;
    let rel = allow_user_skill(path)?;
    let full = resolve_in_workspace(&home, rel)?;
    if !full.is_file() {
        return Err(Error::Other("not a file".into()));
    }
    write_file(&home, rel, contents)
}

pub fn allow_user_skill(rel: &str) -> Result<&str> {
    if user_skill_allowed(rel) {
        Ok(rel)
    } else {
        Err(Error::Other("not an allowed skill path".into()))
    }
}

pub fn user_skill_allowed(rel: &str) -> bool {
    let path = rel.replace('\\', "/");
    if path.is_empty() || path.contains('\0') || path.split('/').any(|part| part == "..") {
        return false;
    }
    if path.starts_with('/') || (path.len() >= 2 && path.as_bytes()[1] == b':') {
        return false;
    }
    const PREFIXES: &[&str] = &[
        ".grok/skills/",
        ".grok/commands/",
        ".grok/bundled/skills/",
        ".claude/skills/",
        ".claude/commands/",
        ".cursor/skills/",
        ".agents/skills/",
        ".agents/commands/",
    ];
    if PREFIXES.iter().any(|prefix| path.starts_with(prefix)) {
        return path.ends_with("/SKILL.md") || path.ends_with(".md");
    }
    path.starts_with(".grok/installed-plugins/")
        && path.contains("/skills/")
        && path.ends_with("/SKILL.md")
}

pub fn collect_skill_files(
    home: &Path,
    grok: &Path,
    workspace: Option<&Path>,
) -> Vec<SkillFileRow> {
    let mut out = Vec::new();
    if let Some(root) = workspace {
        push_root(&mut out, root, root, ".grok/skills", "project", false);
        push_commands(&mut out, root, root, ".grok/commands", "project", false);
        push_root(&mut out, root, root, ".agents/skills", "project", false);
        push_commands(&mut out, root, root, ".agents/commands", "project", false);
        push_root(&mut out, root, root, ".claude/skills", "claude", false);
        push_commands(&mut out, root, root, ".claude/commands", "claude", false);
        push_root(&mut out, root, root, ".cursor/skills", "cursor", false);
    }
    push_root(&mut out, home, grok, "skills", "user", true);
    push_commands(&mut out, home, grok, "commands", "user", true);
    push_root(&mut out, home, home, ".agents/skills", "user", true);
    push_root(&mut out, home, home, ".claude/skills", "claude", true);
    push_commands(&mut out, home, home, ".claude/commands", "claude", true);
    push_root(&mut out, home, home, ".cursor/skills", "cursor", true);
    push_plugins(&mut out, home, grok);
    push_root(&mut out, home, grok, "bundled/skills", "bundled", true);
    out
}

fn push_root(
    out: &mut Vec<SkillFileRow>,
    display_root: &Path,
    base: &Path,
    rel: &str,
    origin: &str,
    home: bool,
) {
    let dir = base.join(rel);
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let mut rows: Vec<_> = entries.flatten().collect();
    rows.sort_by_key(|entry| entry.file_name());
    for entry in rows {
        let skill = entry.path().join("SKILL.md");
        if skill.is_file() {
            push_file(out, display_root, &skill, origin, home);
        }
    }
}

fn push_commands(
    out: &mut Vec<SkillFileRow>,
    display_root: &Path,
    base: &Path,
    rel: &str,
    origin: &str,
    home: bool,
) {
    let dir = base.join(rel);
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let mut rows: Vec<_> = entries.flatten().collect();
    rows.sort_by_key(|entry| entry.file_name());
    for entry in rows {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.is_file() && name.ends_with(".md") && !name.eq_ignore_ascii_case("readme.md") {
            push_file(out, display_root, &path, origin, home);
        }
    }
}

fn push_plugins(out: &mut Vec<SkillFileRow>, home: &Path, grok: &Path) {
    let dir = grok.join("installed-plugins");
    let Ok(plugins) = fs::read_dir(&dir) else {
        return;
    };
    let mut plugins: Vec<_> = plugins.flatten().collect();
    plugins.sort_by_key(|entry| entry.file_name());
    for plugin in plugins {
        if !plugin.path().is_dir() {
            continue;
        }
        push_root(out, home, &plugin.path(), "skills", "plugin", true);
    }
}

fn push_file(
    out: &mut Vec<SkillFileRow>,
    display_root: &Path,
    full: &Path,
    origin: &str,
    home: bool,
) {
    let Some(rel) = relative_to(display_root, full) else {
        return;
    };
    if rel.is_empty() {
        return;
    }
    let path = if home {
        format!("~/{rel}")
    } else {
        rel.clone()
    };
    out.push(SkillFileRow {
        path,
        read_path: rel,
        home,
        origin: origin.into(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn write_replaces_an_existing_skill_and_refuses_a_new_path() {
        let home = tempdir().unwrap();
        let prev = std::env::var_os("HOME");
        unsafe { std::env::set_var("HOME", home.path()) };
        let rel = ".grok/skills/commit/SKILL.md";
        let full = home.path().join(rel);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(&full, "before").unwrap();
        write_user_skill(rel, "after").unwrap();
        assert_eq!(fs::read_to_string(&full).unwrap(), "after");
        let missing = write_user_skill(".grok/skills/new/SKILL.md", "nope").unwrap_err();
        assert!(missing.to_string().contains("not a file"));
        let blocked = write_user_skill(".grok/config.toml", "nope").unwrap_err();
        assert!(blocked.to_string().contains("not an allowed"));
        match prev {
            Some(value) => unsafe { std::env::set_var("HOME", value) },
            None => unsafe { std::env::remove_var("HOME") },
        }
    }

    #[test]
    fn allowlist_rejects_escapes() {
        assert!(user_skill_allowed(".grok/skills/foo/SKILL.md"));
        assert!(user_skill_allowed(
            ".grok/installed-plugins/p/skills/x/SKILL.md"
        ));
        assert!(!user_skill_allowed(".grok/../.ssh/id_rsa"));
        assert!(!user_skill_allowed(".grok/config.toml"));
    }

    #[test]
    fn collects_project_and_user_skills() {
        let home = tempdir().unwrap();
        let grok = home.path().join(".grok");
        let project = tempdir().unwrap();
        fs::create_dir_all(project.path().join(".grok/skills/commit")).unwrap();
        fs::write(
            project.path().join(".grok/skills/commit/SKILL.md"),
            "---\nname: commit\n---\n",
        )
        .unwrap();
        fs::create_dir_all(grok.join("skills/personal")).unwrap();
        fs::write(grok.join("skills/personal/SKILL.md"), "ok").unwrap();
        fs::create_dir_all(grok.join("installed-plugins/p/skills/review")).unwrap();
        fs::write(
            grok.join("installed-plugins/p/skills/review/SKILL.md"),
            "ok",
        )
        .unwrap();
        let rows = collect_skill_files(home.path(), &grok, Some(project.path()));
        let paths: Vec<_> = rows.iter().map(|row| row.path.as_str()).collect();
        assert!(paths.contains(&".grok/skills/commit/SKILL.md"));
        assert!(paths.contains(&"~/.grok/skills/personal/SKILL.md"));
        assert!(paths
            .iter()
            .any(|path| path.contains("installed-plugins") && path.ends_with("review/SKILL.md")));
        assert_eq!(
            rows.iter()
                .find(|row| row.path.contains("commit"))
                .map(|row| row.origin.as_str()),
            Some("project")
        );
        assert_eq!(
            rows.iter()
                .find(|row| row.path.contains("review"))
                .map(|row| row.origin.as_str()),
            Some("plugin")
        );
    }
}
