use std::path::Path;

#[cfg(target_os = "macos")]
use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};
use serde::{Deserialize, Serialize};

use crate::appdb;
use crate::error::{Error, Result};

const RELEASE_SERVICE: &str = "app.twanagent.desktop";
const DEV_SERVICE: &str = "app.twanagent.desktop.dev";
const XAI_ACCOUNT: &str = "xai";
const ANTHROPIC_ACCOUNT: &str = "anthropic";
const MINIMAX_ACCOUNT: &str = "minimax";

/// Provider ids stored in `provider_keys`. The keychain accounts used the same names.
const PROVIDERS: &[&str] = &[XAI_ACCOUNT, ANTHROPIC_ACCOUNT, MINIMAX_ACCOUNT];

pub fn set_ssh_secret(account: &str, value: &str) -> Result<()> {
    set_ssh_secret_in(account, value, &SystemKeychain)
}

pub fn set_ssh_secret_in(account: &str, value: &str, store: &dyn SshSecretStore) -> Result<()> {
    let account = account.trim();
    if !account.starts_with("ssh-secret:") || account == "ssh-secret:" {
        return Err(Error::Other("invalid SSH secret account".into()));
    }
    let value = value.trim();
    if value.is_empty() {
        return delete_ssh_secret_in(account, store);
    }
    store
        .set(account, value)
        .map_err(|e| Error::Keychain(format!("could not save SSH secret: {e}")))
}

pub fn get_ssh_secret(account: &str) -> Option<String> {
    get_ssh_secret_in(account, &SystemKeychain)
}

pub fn get_ssh_secret_in(account: &str, store: &dyn SshSecretStore) -> Option<String> {
    store
        .get(account.trim())
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn delete_ssh_secret(account: &str) -> Result<()> {
    delete_ssh_secret_in(account, &SystemKeychain)
}

pub fn delete_ssh_secret_in(account: &str, store: &dyn SshSecretStore) -> Result<()> {
    let account = account.trim();
    if !account.starts_with("ssh-secret:") {
        return Err(Error::Other("invalid SSH secret account".into()));
    }
    store
        .delete(account)
        .map_err(|e| Error::Keychain(format!("could not delete SSH secret: {e}")))
}

pub trait SshSecretStore {
    fn set(&self, account: &str, value: &str) -> std::result::Result<(), String>;
    fn get(&self, account: &str) -> std::result::Result<Option<String>, String>;
    fn delete(&self, account: &str) -> std::result::Result<(), String>;
}

impl SshSecretStore for SystemKeychain {
    fn set(&self, account: &str, value: &str) -> std::result::Result<(), String> {
        write_account(keychain_service(), account, value)
    }

    fn get(&self, account: &str) -> std::result::Result<Option<String>, String> {
        read_account(keychain_service(), account)
    }

    fn delete(&self, account: &str) -> std::result::Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            // Preserve the existing best-effort macOS deletion behavior.
            let _ = remove_account(keychain_service(), account);
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        remove_account(keychain_service(), account)
    }
}

fn keychain_service() -> &'static str {
    if cfg!(debug_assertions) {
        DEV_SERVICE
    } else {
        RELEASE_SERVICE
    }
}

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

pub struct SystemKeychain;

/// Write a generic password and read it back. `keyring` can report success while the
/// login keychain never stores the item, so the settings page keeps saying nothing is saved.
fn write_account(service: &str, account: &str, value: &str) -> std::result::Result<(), String> {
    #[cfg(target_os = "macos")]
    set_generic_password(service, account, value.as_bytes()).map_err(|err| err.to_string())?;
    #[cfg(windows)]
    windows_entry(service, account)?
        .set_password(value)
        .map_err(|err| err.to_string())?;
    #[cfg(not(any(target_os = "macos", windows)))]
    return unsupported_keychain(service, account, Some(value));
    #[cfg(any(target_os = "macos", windows))]
    match read_account(service, account)? {
        Some(stored) if stored == value => Ok(()),
        Some(_) => Err("the keychain stored a different value".into()),
        None => Err("the keychain did not keep the key".into()),
    }
}

#[cfg(target_os = "macos")]
fn remove_account(service: &str, account: &str) -> std::result::Result<(), String> {
    match delete_generic_password(service, account) {
        Ok(()) => Ok(()),
        Err(err) if err.code() == -25300 => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(target_os = "macos")]
fn read_account(service: &str, account: &str) -> std::result::Result<Option<String>, String> {
    match get_generic_password(service, account) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "keychain item is not text".to_string()),
        Err(err) if err.code() == -25300 => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

// Select the native credential explicitly: production must never use keyring's mock fallback.
#[cfg(windows)]
fn windows_entry(service: &str, account: &str) -> std::result::Result<keyring::Entry, String> {
    let credential = keyring::windows::default_credential_builder()
        .build(None, service, account)
        .map_err(|err| err.to_string())?;
    Ok(keyring::Entry::new_with_credential(credential))
}

#[cfg(windows)]
fn windows_read(entry: &keyring::Entry) -> std::result::Result<Option<String>, String> {
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(windows)]
fn windows_delete(entry: &keyring::Entry) -> std::result::Result<(), String> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(windows)]
fn read_account(service: &str, account: &str) -> std::result::Result<Option<String>, String> {
    windows_read(&windows_entry(service, account)?)
}

#[cfg(windows)]
fn remove_account(service: &str, account: &str) -> std::result::Result<(), String> {
    windows_delete(&windows_entry(service, account)?)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn unsupported_keychain<T>(_: &str, _: &str, _: Option<&str>) -> std::result::Result<T, String> {
    Err("secure credential storage is unsupported on this platform".into())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn read_account(service: &str, account: &str) -> std::result::Result<Option<String>, String> {
    unsupported_keychain(service, account, None)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn remove_account(service: &str, account: &str) -> std::result::Result<(), String> {
    unsupported_keychain(service, account, None)
}

fn clear_file_key(data_dir: &Path) -> Result<()> {
    let mut file = load_file(data_dir)?;
    if file.xai_key.is_none() {
        return Ok(());
    }
    file.xai_key = None;
    save_file(data_dir, &file)
}

fn leftover_file_key(data_dir: &Path) -> Option<String> {
    load_file(data_dir).ok().and_then(|file| {
        file.xai_key
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn open_keys(data_dir: &Path) -> Result<rusqlite::Connection> {
    appdb::open(data_dir)
}

/// Keys saved before this table lived in the login keychain. Copy each one once, then drop the item.
fn migrate_keychain_keys(conn: &rusqlite::Connection) {
    for provider in PROVIDERS {
        let already = appdb::get_provider_key(conn, provider).ok().flatten();
        if already.as_ref().is_some_and(|value| !value.trim().is_empty()) {
            continue;
        }
        let Some(value) = read_keychain_provider(provider) else {
            continue;
        };
        if appdb::set_provider_key(conn, provider, &value).is_ok() {
            let _ = remove_account(keychain_service(), provider);
            if cfg!(debug_assertions) {
                let _ = remove_account(RELEASE_SERVICE, provider);
            }
        }
    }
}

fn read_keychain_provider(provider: &str) -> Option<String> {
    let current = read_account(keychain_service(), provider)
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if current.is_some() {
        return current;
    }
    if !cfg!(debug_assertions) {
        return None;
    }
    read_account(RELEASE_SERVICE, provider)
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn stored_provider_key(data_dir: &Path, provider: &str) -> Option<String> {
    let conn = open_keys(data_dir).ok()?;
    if data_dir == crate::state::app_data_dir() {
        migrate_keychain_keys(&conn);
    }
    if provider == XAI_ACCOUNT {
        if let Some(leftover) = leftover_file_key(data_dir) {
            let current = appdb::get_provider_key(&conn, provider).ok().flatten();
            if current.as_ref().is_none_or(|value| value.trim().is_empty())
                && appdb::set_provider_key(&conn, provider, &leftover).is_ok()
            {
                let _ = clear_file_key(data_dir);
            }
        }
    }
    appdb::get_provider_key(&conn, provider)
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn write_provider_key(data_dir: &Path, provider: &str, key: &str) -> Result<()> {
    let conn = open_keys(data_dir)?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        appdb::delete_provider_key(&conn, provider)?;
    } else {
        appdb::set_provider_key(&conn, provider, trimmed)?;
    }
    if provider == XAI_ACCOUNT {
        let _ = clear_file_key(data_dir);
    }
    Ok(())
}

pub fn set_xai_key(data_dir: &Path, key: &str) -> Result<()> {
    write_provider_key(data_dir, XAI_ACCOUNT, key)
}

pub fn get_xai_key(data_dir: &Path) -> Option<String> {
    stored_provider_key(data_dir, XAI_ACCOUNT)
}

pub fn delete_xai_key(data_dir: &Path) -> Result<()> {
    write_provider_key(data_dir, XAI_ACCOUNT, "")
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

/// Anthropic key. Stored in SQLite, never in `secrets.json`. CLI login is separate.
pub fn set_anthropic_key(data_dir: &Path, key: &str) -> Result<()> {
    write_provider_key(data_dir, ANTHROPIC_ACCOUNT, key)
}

pub fn get_anthropic_key(data_dir: &Path) -> Option<String> {
    stored_provider_key(data_dir, ANTHROPIC_ACCOUNT)
}

pub fn delete_anthropic_key(data_dir: &Path) -> Result<()> {
    write_provider_key(data_dir, ANTHROPIC_ACCOUNT, "")
}

pub fn resolve_anthropic_key(saved: Option<String>, env: Option<String>) -> Option<String> {
    resolve_xai_key(saved, env)
}

pub fn resolve_anthropic_key_on_disk(data_dir: &Path) -> Option<String> {
    resolve_anthropic_key(
        get_anthropic_key(data_dir),
        std::env::var("ANTHROPIC_API_KEY").ok(),
    )
}

/// MiniMax key. Stored in SQLite, never in `secrets.json`. CLI login is separate.
pub fn set_minimax_key(data_dir: &Path, key: &str) -> Result<()> {
    write_provider_key(data_dir, MINIMAX_ACCOUNT, key)
}

pub fn get_minimax_key(data_dir: &Path) -> Option<String> {
    stored_provider_key(data_dir, MINIMAX_ACCOUNT)
}

pub fn delete_minimax_key(data_dir: &Path) -> Result<()> {
    write_provider_key(data_dir, MINIMAX_ACCOUNT, "")
}

pub fn resolve_minimax_key(saved: Option<String>, env: Option<String>) -> Option<String> {
    resolve_xai_key(saved, env)
}

pub fn resolve_minimax_key_on_disk(data_dir: &Path) -> Option<String> {
    resolve_minimax_key(get_minimax_key(data_dir), std::env::var("MINIMAX_API_KEY").ok())
}

#[cfg(test)]
mod xai_key_tests {
    use super::*;

    #[test]
    fn ssh_secret_roundtrip_does_not_touch_the_xai_key() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemSsh::default();
        set_xai_key(dir.path(), "xai-secret").unwrap();
        set_ssh_secret_in("ssh-secret:box", "pass-1", &store).unwrap();
        assert_eq!(
            get_ssh_secret_in("ssh-secret:box", &store).as_deref(),
            Some("pass-1")
        );
        assert_eq!(get_xai_key(dir.path()).as_deref(), Some("xai-secret"));
        delete_ssh_secret_in("ssh-secret:box", &store).unwrap();
        assert_eq!(get_ssh_secret_in("ssh-secret:box", &store), None);
        assert!(set_ssh_secret_in("xai", "nope", &store).is_err());
        assert!(set_ssh_secret_in("ssh-secret:", "nope", &store).is_err());
    }

    #[derive(Default)]
    struct MemSsh(std::sync::Mutex<std::collections::HashMap<String, String>>);

    impl SshSecretStore for MemSsh {
        fn set(&self, account: &str, value: &str) -> std::result::Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .insert(account.to_string(), value.to_string());
            Ok(())
        }
        fn get(&self, account: &str) -> std::result::Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(account).cloned())
        }
        fn delete(&self, account: &str) -> std::result::Result<(), String> {
            self.0.lock().unwrap().remove(account);
            Ok(())
        }
    }

    #[test]
    fn empty_ssh_secret_deletes_and_missing_delete_is_idempotent() {
        let store = MemSsh::default();
        set_ssh_secret_in(" ssh-secret:box ", " value ", &store).unwrap();
        assert_eq!(
            get_ssh_secret_in("ssh-secret:box", &store).as_deref(),
            Some("value")
        );
        set_ssh_secret_in("ssh-secret:box", " \n ", &store).unwrap();
        assert_eq!(get_ssh_secret_in("ssh-secret:box", &store), None);
        delete_ssh_secret_in("ssh-secret:box", &store).unwrap();
    }

    struct FailingSsh;

    impl SshSecretStore for FailingSsh {
        fn set(&self, _: &str, _: &str) -> std::result::Result<(), String> {
            Err("access denied".into())
        }
        fn get(&self, _: &str) -> std::result::Result<Option<String>, String> {
            Err("access denied".into())
        }
        fn delete(&self, _: &str) -> std::result::Result<(), String> {
            Err("access denied".into())
        }
    }

    #[test]
    fn ssh_store_failures_follow_the_public_error_contract() {
        for result in [
            set_ssh_secret_in("ssh-secret:box", "value", &FailingSsh),
            delete_ssh_secret_in("ssh-secret:box", &FailingSsh),
            set_ssh_secret_in("ssh-secret:box", "", &FailingSsh),
        ] {
            assert!(
                matches!(result, Err(Error::Keychain(message)) if message.contains("access denied"))
            );
        }
        // Reads retain the existing optional-value contract.
        assert_eq!(get_ssh_secret_in("ssh-secret:box", &FailingSsh), None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_wrapper_handles_missing_entries_and_backend_failures() {
        let credential = keyring::mock::default_credential_builder()
            .build(None, DEV_SERVICE, "ssh-secret:test")
            .unwrap();
        let entry = keyring::Entry::new_with_credential(credential);
        assert_eq!(windows_read(&entry).unwrap(), None);
        windows_delete(&entry).unwrap();
        entry.set_password("value").unwrap();
        assert_eq!(windows_read(&entry).unwrap().as_deref(), Some("value"));
        let mock = entry
            .get_credential()
            .downcast_ref::<keyring::mock::MockCredential>()
            .unwrap();
        mock.set_error(keyring::Error::Invalid("account".into(), "denied".into()));
        assert!(windows_read(&entry).unwrap_err().contains("denied"));
        mock.set_error(keyring::Error::Invalid("account".into(), "denied".into()));
        assert!(windows_delete(&entry).unwrap_err().contains("denied"));
        windows_delete(&entry).unwrap();
        assert_eq!(windows_read(&entry).unwrap(), None);
    }

    #[test]
    fn anthropic_key_does_not_read_the_xai_key() {
        let dir = tempfile::tempdir().unwrap();
        set_xai_key(dir.path(), "xai-secret").unwrap();
        assert_eq!(get_anthropic_key(dir.path()), None);
        set_anthropic_key(dir.path(), "anthropic-secret").unwrap();
        assert_eq!(
            get_anthropic_key(dir.path()).as_deref(),
            Some("anthropic-secret")
        );
        assert_eq!(get_xai_key(dir.path()).as_deref(), Some("xai-secret"));
        delete_anthropic_key(dir.path()).unwrap();
        assert_eq!(get_anthropic_key(dir.path()), None);
        assert_eq!(get_xai_key(dir.path()).as_deref(), Some("xai-secret"));
    }

    #[test]
    fn minimax_key_does_not_read_the_other_keys() {
        let dir = tempfile::tempdir().unwrap();
        set_xai_key(dir.path(), "xai-secret").unwrap();
        set_anthropic_key(dir.path(), "anthropic-secret").unwrap();
        assert_eq!(get_minimax_key(dir.path()), None);
        set_minimax_key(dir.path(), "minimax-secret").unwrap();
        assert_eq!(get_minimax_key(dir.path()).as_deref(), Some("minimax-secret"));
        assert_eq!(get_anthropic_key(dir.path()).as_deref(), Some("anthropic-secret"));
        assert_eq!(
            resolve_minimax_key(None, Some(" env-key ".into())).as_deref(),
            Some("env-key")
        );
        delete_minimax_key(dir.path()).unwrap();
        assert_eq!(get_minimax_key(dir.path()), None);
        assert_eq!(get_xai_key(dir.path()).as_deref(), Some("xai-secret"));
    }

    #[test]
    fn anthropic_key_is_not_written_to_secrets_json() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("secrets.json"), r#"{"xai_key":"file-secret"}"#).unwrap();
        set_anthropic_key(dir.path(), "anthropic-secret").unwrap();
        let raw = std::fs::read_to_string(dir.path().join("secrets.json")).unwrap();
        assert!(raw.contains("file-secret"), "{raw}");
        assert!(!raw.contains("anthropic-secret"), "{raw}");
        assert_eq!(
            resolve_anthropic_key(get_anthropic_key(dir.path()), None).as_deref(),
            Some("anthropic-secret")
        );
        assert_eq!(
            resolve_anthropic_key(None, Some(" env-key ".into())).as_deref(),
            Some("env-key")
        );
    }

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

    #[test]
    fn set_does_not_write_the_key_to_json() {
        let dir = tempfile::tempdir().unwrap();
        set_xai_key(dir.path(), "xai-secret").unwrap();
        let path = dir.path().join("secrets.json");
        if path.exists() {
            let raw = std::fs::read_to_string(&path).unwrap();
            assert!(!raw.contains("xai-secret"), "{raw}");
        }
        let conn = crate::appdb::open(dir.path()).unwrap();
        assert_eq!(
            crate::appdb::get_provider_key(&conn, "xai").unwrap().as_deref(),
            Some("xai-secret")
        );
        assert!(crate::appdb::get_setting(&conn, "provider.xai").unwrap().is_none());
    }

    #[test]
    fn get_migrates_leftover_file_into_the_database() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("secrets.json"),
            r#"{"xai_key":"file-secret"}"#,
        )
        .unwrap();
        assert_eq!(get_xai_key(dir.path()).as_deref(), Some("file-secret"));
        let conn = crate::appdb::open(dir.path()).unwrap();
        assert_eq!(
            crate::appdb::get_provider_key(&conn, "xai").unwrap().as_deref(),
            Some("file-secret")
        );
        let raw = std::fs::read_to_string(dir.path().join("secrets.json")).unwrap();
        assert!(!raw.contains("file-secret"), "{raw}");
    }

    #[test]
    fn a_saved_database_key_wins_over_a_leftover_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("secrets.json"),
            r#"{"xai_key":"file-secret"}"#,
        )
        .unwrap();
        set_xai_key(dir.path(), "db-secret").unwrap();
        assert_eq!(get_xai_key(dir.path()).as_deref(), Some("db-secret"));
        let raw = std::fs::read_to_string(dir.path().join("secrets.json")).unwrap();
        assert!(!raw.contains("file-secret"), "{raw}");
        assert!(!raw.contains("db-secret"), "{raw}");
    }

}
