use std::path::PathBuf;

use serde_json::Value;

use crate::error::{Error, Result};
use crate::files;
use crate::search::{self, GlobQuery, GrepQuery};

pub fn tool_status(name: &str, arguments: &str) -> String {
    let args: Value = serde_json::from_str(arguments).unwrap_or(Value::Null);
    let path = args.get("path").and_then(Value::as_str).unwrap_or("").trim();
    match name {
        "read_file" => {
            let range = read_range_label(&args);
            if range.is_empty() {
                format!("Reading {}", label(path))
            } else {
                format!("Reading {} {range}", label(path))
            }
        }
        "write_file" => format!("Writing {}", label(path)),
        "edit_file" => format!("Editing {}", label(path)),
        "list_dir" => format!("Listing {}", if path.is_empty() { "." } else { path }),
        "grep" => {
            let pattern = args.get("pattern").and_then(Value::as_str).unwrap_or("").trim();
            if pattern.is_empty() { "Searching".into() } else { format!("Searching for {pattern}") }
        }
        "glob" => {
            let pattern = args.get("pattern").and_then(Value::as_str).unwrap_or("").trim();
            if pattern.is_empty() { "Finding files".into() } else { format!("Finding {pattern}") }
        }
        "run_command" => {
            let description = args.get("description").and_then(Value::as_str).unwrap_or("").trim();
            if description.is_empty() {
                "Running a command".into()
            } else {
                format!("Running {description}")
            }
        }
        other => format!("Using {other}"),
    }
}

fn label(path: &str) -> &str {
    if path.is_empty() { "a file" } else { path }
}

fn read_int(args: &Value, key: &str) -> Option<u32> {
    args.get(key).and_then(files::parse_line_int)
}

fn read_range_label(args: &Value) -> String {
    let offset = read_int(args, "offset");
    let limit = read_int(args, "limit");
    match (offset, limit) {
        (None, None) => String::new(),
        (Some(start), Some(count)) if count > 0 => format!("({start} - {})", start + count - 1),
        (None, Some(count)) if count > 0 => format!("(1 - {count})"),
        (Some(start), _) => format!("({start}+)"),
        _ => String::new(),
    }
}

pub trait Workspace {
    fn read(&self, path: &str) -> Result<String>;
    fn write(&self, path: &str, contents: &str) -> Result<()>;
    fn edit(&self, path: &str, old: &str, new: &str) -> Result<()>;
    fn list(&self, path: &str) -> Result<String>;
    fn grep(&self, pattern: &str, path: &str, glob: &str) -> Result<String>;
    fn glob(&self, pattern: &str, path: &str) -> Result<String>;
    fn run(&self, command: &str) -> Result<String>;
}

pub trait ToolHost {
    fn allow_shell(&self, command: &str) -> bool;
}

pub struct LocalWorkspace {
    pub root: PathBuf,
}

impl Workspace for LocalWorkspace {
    fn read(&self, path: &str) -> Result<String> {
        files::read_file(&self.root, path)
    }
    fn write(&self, path: &str, contents: &str) -> Result<()> {
        files::write_file(&self.root, path, contents)
    }
    fn edit(&self, path: &str, old: &str, new: &str) -> Result<()> {
        files::edit_file(&self.root, path, old, new)
    }
    fn list(&self, path: &str) -> Result<String> {
        Ok(files::list_dir(&self.root, path)?
            .into_iter()
            .map(|(name, dir)| format!("{}\t{name}", if dir { "dir" } else { "file" }))
            .collect::<Vec<_>>()
            .join("\n"))
    }
    fn grep(&self, pattern: &str, path: &str, glob: &str) -> Result<String> {
        search::grep(
            &self.root,
            &GrepQuery {
                pattern: pattern.to_string(),
                path: path.to_string(),
                glob: glob.to_string(),
            },
        )
    }
    fn glob(&self, pattern: &str, path: &str) -> Result<String> {
        search::glob(
            &self.root,
            &GlobQuery {
                pattern: pattern.to_string(),
                path: path.to_string(),
            },
        )
    }
    fn run(&self, command: &str) -> Result<String> {
        files::run_command(&self.root, command)
    }
}

pub fn dispatch(
    workspace: &dyn Workspace,
    host: &dyn ToolHost,
    permission: &str,
    name: &str,
    arguments: &str,
) -> Result<String> {
    let args: Value = serde_json::from_str(arguments).unwrap_or_else(|_| serde_json::json!({}));
    let text = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    if permission == "read-only" && matches!(name, "write_file" | "edit_file" | "run_command") {
        return Ok(format!("Error: {name} is blocked in read-only mode."));
    }
    match name {
        "read_file" => {
            let text = workspace.read(&text("path"))?;
            files::numbered_lines(&text, read_int(&args, "offset"), read_int(&args, "limit"))
        }
        "list_dir" => workspace.list(&text("path")),
        "grep" => workspace.grep(&text("pattern"), &text("path"), &text("glob")),
        "glob" => workspace.glob(&text("pattern"), &text("path")),
        "write_file" => {
            let path = text("path");
            workspace.write(&path, &text("contents"))?;
            Ok(format!("Wrote {path}"))
        }
        "edit_file" => {
            let path = text("path");
            workspace.edit(&path, &text("old_string"), &text("new_string"))?;
            Ok(format!("Edited {path}"))
        }
        "run_command" => {
            let command = text("command");
            if command.trim().is_empty() {
                return Err(Error::Other("command is empty".into()));
            }
            if permission == "ask" && !host.allow_shell(&command) {
                return Ok("User skipped this command.".into());
            }
            workspace.run(&command)
        }
        other => Ok(format!("Unknown tool: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ask_mode_does_not_run_a_skipped_command() {
        let dir = tempfile::tempdir().unwrap();
        struct Skip;
        impl ToolHost for Skip {
            fn allow_shell(&self, _command: &str) -> bool {
                false
            }
        }
        let workspace = LocalWorkspace { root: dir.path().to_path_buf() };
        let marker = dir.path().join("ran.txt");
        let result = dispatch(
            &workspace,
            &Skip,
            "ask",
            "run_command",
            &format!(r#"{{"command":"echo ran > {}"}}"#, marker.display()),
        )
        .unwrap();
        assert_eq!(result, "User skipped this command.");
        assert!(!marker.exists());
    }

    #[test]
    fn grep_and_glob_run_inside_the_workspace() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/app.rs"), "fn answer() {}\n").unwrap();
        struct Allow;
        impl ToolHost for Allow {
            fn allow_shell(&self, _command: &str) -> bool {
                true
            }
        }
        let workspace = LocalWorkspace { root: dir.path().to_path_buf() };
        let found = dispatch(&workspace, &Allow, "read-only", "grep", r#"{"pattern":"answer","glob":"*.rs"}"#).unwrap();
        assert!(found.contains("src/app.rs:1:"));
        let paths = dispatch(&workspace, &Allow, "read-only", "glob", r#"{"pattern":"**/*.rs"}"#).unwrap();
        assert!(paths.contains("src/app.rs"));
    }

    #[test]
    fn read_file_can_return_a_numbered_line_range() {
        let dir = tempfile::tempdir().unwrap();
        let body = (1..=60).map(|n| format!("line {n}")).collect::<Vec<_>>().join("\n");
        std::fs::write(dir.path().join("src.rs"), body).unwrap();
        struct Allow;
        impl ToolHost for Allow {
            fn allow_shell(&self, _command: &str) -> bool {
                true
            }
        }
        let workspace = LocalWorkspace { root: dir.path().to_path_buf() };
        let whole = dispatch(&workspace, &Allow, "read-only", "read_file", r#"{"path":"src.rs"}"#).unwrap();
        assert_eq!(whole.lines().next(), Some("line 1"));
        let ranged = dispatch(
            &workspace,
            &Allow,
            "read-only",
            "read_file",
            r#"{"path":"src.rs","offset":10,"limit":51}"#,
        )
        .unwrap();
        let rows: Vec<&str> = ranged.lines().collect();
        assert_eq!(rows[0], "    10|line 10");
        assert_eq!(rows[50], "    60|line 60");
        assert_eq!(
            tool_status("read_file", r#"{"path":"src.rs","offset":10,"limit":51}"#),
            "Reading src.rs (10 - 60)",
        );
        assert_eq!(tool_status("read_file", r#"{"path":"src.rs"}"#), "Reading src.rs");
    }
}
