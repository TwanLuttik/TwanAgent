use std::fs;
use std::path::Path;

use serde_json::{Map, Value};

use crate::error::{Error, Result};
use crate::grok_cli::grok_home;

use super::files::{read_file, write_file};
use super::paths::home_dir;

pub const USER_MCP_FILES: &[&str] = &[".grok/config.toml", ".cursor/mcp.json", ".claude.json"];

pub fn mcp_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphabetic())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn read_user_mcp(path: &str) -> Result<String> {
    let home = user_mcp_home()?;
    read_file(&home, allow_user_mcp(path)?)
}

pub fn write_user_mcp(path: &str, contents: &str) -> Result<()> {
    let home = user_mcp_home()?;
    write_file(&home, allow_user_mcp(path)?, contents)
}

pub fn open_user_mcp(path: &str) -> Result<()> {
    let home = user_mcp_home()?;
    let full = super::paths::resolve_in_workspace(&home, allow_user_mcp(path)?)?;
    if !full.is_file() {
        return Err(Error::Other("not a file".into()));
    }
    open_path(&full)
}

pub fn mcp_auth_names() -> Result<Vec<String>> {
    let Some(map) = read_credentials()? else {
        return Ok(Vec::new());
    };
    let mut names: Vec<String> = map
        .keys()
        .filter_map(|key| key.split(':').next())
        .filter(|name| !name.is_empty())
        .map(|name| name.to_string())
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}

pub fn mcp_clear_auth(name: &str) -> Result<()> {
    if !mcp_name_ok(name) {
        return Err(Error::Other("invalid MCP server name".into()));
    }
    let Some(mut map) = read_credentials()? else {
        return Ok(());
    };
    let prefix = format!("{name}:");
    map.retain(|key, _| !key.starts_with(&prefix) && key != name);
    write_credentials(&map)
}

fn allow_user_mcp(path: &str) -> Result<&str> {
    if USER_MCP_FILES.contains(&path) {
        Ok(path)
    } else {
        Err(Error::Other("not an allowed MCP config path".into()))
    }
}

fn user_mcp_home() -> Result<std::path::PathBuf> {
    home_dir().ok_or_else(|| Error::Other("home folder is unknown".into()))
}

fn credentials_path() -> Result<std::path::PathBuf> {
    Ok(grok_home()
        .ok_or_else(|| Error::Other("home folder is unknown".into()))?
        .join("mcp_credentials.json"))
}

fn read_credentials() -> Result<Option<Map<String, Value>>> {
    let path = credentials_path()?;
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(None);
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Ok(Some(map)),
        _ => Ok(Some(Map::new())),
    }
}

fn write_credentials(map: &Map<String, Value>) -> Result<()> {
    let path = credentials_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(map).unwrap_or_else(|_| "{}".into());
    write_private(&path, body.as_bytes())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(bytes)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::write(path, bytes)?;
        Ok(())
    }
}

pub(crate) fn open_path(path: &Path) -> Result<()> {
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(path).status()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path.to_string_lossy()])
            .status()
    } else {
        std::process::Command::new("xdg-open").arg(path).status()
    };
    match status {
        Ok(code) if code.success() => Ok(()),
        Ok(_) => Err(Error::Other("could not open the file".into())),
        Err(err) => Err(Error::Other(err.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::tempdir;

    static LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn rejects_bad_server_names() {
        assert!(mcp_name_ok("linear"));
        assert!(!mcp_name_ok(""));
        assert!(!mcp_name_ok("../x"));
        assert!(!mcp_name_ok("a:b"));
    }

    #[test]
    fn auth_names_and_clear_do_not_expose_tokens() {
        let _guard = LOCK.lock().unwrap();
        let dir = tempdir().unwrap();
        let prev = std::env::var_os("GROK_HOME");
        unsafe { std::env::set_var("GROK_HOME", dir.path()) };
        fs::write(
            dir.path().join("mcp_credentials.json"),
            r#"{"linear:https://x":{"token_response":{"access_token":"secret-token"}},"notion:https://y":{}}"#,
        )
        .unwrap();
        let names = mcp_auth_names().unwrap();
        assert_eq!(names, vec!["linear", "notion"]);
        mcp_clear_auth("linear").unwrap();
        let left = mcp_auth_names().unwrap();
        assert_eq!(left, vec!["notion"]);
        let raw = fs::read_to_string(dir.path().join("mcp_credentials.json")).unwrap();
        assert!(!raw.contains("secret-token"));
        match prev {
            Some(value) => unsafe { std::env::set_var("GROK_HOME", value) },
            None => unsafe { std::env::remove_var("GROK_HOME") },
        }
    }
}
