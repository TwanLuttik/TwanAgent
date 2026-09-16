use std::path::Path;

use keyring::Entry;
use serde::{Deserialize, Serialize};

use crate::error::Result;

const SERVICE: &str = "app.twanagent.desktop";
const XAI_ACCOUNT: &str = "xai";

#[derive(Default, Serialize, Deserialize)]
struct SecretFile {
    #[serde(default)]
    xai_key: Option<String>,
}

fn secrets_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("secrets.json")
}

fn load_file(data_dir: &Path) -> Result<SecretFile> {
    let path = secrets_path(data_dir);
    if !path.exists() {
        return Ok(SecretFile::default());
    }
    let data = fs_read(&path)?;
    if data.trim().is_empty() {
        return Ok(SecretFile::default());
    }
    Ok(serde_json::from_str(&data)?)
}

fn fs_read(path: &Path) -> Result<String> {
    Ok(std::fs::read_to_string(path)?)
}

fn save_file(data_dir: &Path, file: &SecretFile) -> Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = secrets_path(data_dir);
    let tmp = data_dir.join("secrets.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(file)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    replace_file(&tmp, &path)
}

fn replace_file(tmp: &Path, dest: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        if dest.exists() {
            std::fs::remove_file(dest)?;
        }
    }
    std::fs::rename(tmp, dest)?;
    Ok(())
}

fn keychain_set(account: &str, value: &str) -> std::result::Result<(), keyring::Error> {
    Entry::new(SERVICE, account)?.set_password(value)
}

fn keychain_get(account: &str) -> std::result::Result<String, keyring::Error> {
    Entry::new(SERVICE, account)?.get_password()
}

fn keychain_delete(account: &str) {
    if let Ok(entry) = Entry::new(SERVICE, account) {
        let _ = entry.delete_credential();
    }
}

pub fn set_xai_key(data_dir: &Path, key: &str) -> Result<()> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return delete_xai_key(data_dir);
    }
    let _ = keychain_set(XAI_ACCOUNT, trimmed);
    let mut file = load_file(data_dir)?;
    file.xai_key = Some(trimmed.to_string());
    save_file(data_dir, &file)
}

pub fn get_xai_key(data_dir: &Path) -> Option<String> {
    if let Ok(file) = load_file(data_dir) {
        if let Some(value) = file.xai_key {
            if !value.trim().is_empty() {
                return Some(value);
            }
        }
    }
    keychain_get(XAI_ACCOUNT)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

pub fn delete_xai_key(data_dir: &Path) -> Result<()> {
    keychain_delete(XAI_ACCOUNT);
    let mut file = load_file(data_dir)?;
    file.xai_key = None;
    save_file(data_dir, &file)
}

/// Settings key wins; otherwise `XAI_API_KEY`.
pub fn resolve_xai_key(saved: Option<String>, env: Option<String>) -> Option<String> {
    let saved = saved.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    let env = env.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    saved.or(env)
}

pub fn resolve_xai_key_on_disk(data_dir: &Path) -> Option<String> {
    resolve_xai_key(get_xai_key(data_dir), std::env::var("XAI_API_KEY").ok())
}

#[cfg(test)]
mod xai_key_tests {
    use super::*;

    #[test]
    fn settings_key_wins_over_env() {
        assert_eq!(
            resolve_xai_key(Some(" saved ".into()), Some("env".into())).as_deref(),
            Some("saved")
        );
        assert_eq!(
            resolve_xai_key(None, Some("env".into())).as_deref(),
            Some("env")
        );
        assert_eq!(resolve_xai_key(Some("  ".into()), Some("".into())), None);
    }

    #[test]
    fn xai_key_roundtrip_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        set_xai_key(dir.path(), "xai-secret").unwrap();
        assert_eq!(get_xai_key(dir.path()).as_deref(), Some("xai-secret"));
        delete_xai_key(dir.path()).unwrap();
        assert_eq!(get_xai_key(dir.path()), None);
    }
}
