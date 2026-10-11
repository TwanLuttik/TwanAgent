use std::path::Path;

use keyring::Entry;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

const RELEASE_SERVICE: &str = "app.twanagent.desktop";
const DEV_SERVICE: &str = "app.twanagent.desktop.dev";
const XAI_ACCOUNT: &str = "xai";
const ANTHROPIC_ACCOUNT: &str = "anthropic";

fn ssh_entry(account: &str) -> std::result::Result<Entry, String> {
    Entry::new(keychain_service(), account).map_err(|e| e.to_string())
}

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
    store.delete(account);
    Ok(())
}

pub trait SshSecretStore {
    fn set(&self, account: &str, value: &str) -> std::result::Result<(), String>;
    fn get(&self, account: &str) -> std::result::Result<Option<String>, String>;
    fn delete(&self, account: &str);
}

impl SshSecretStore for SystemKeychain {
    fn set(&self, account: &str, value: &str) -> std::result::Result<(), String> {
        ssh_entry(account)?.set_password(value).map_err(|e| e.to_string())
    }

    fn get(&self, account: &str) -> std::result::Result<Option<String>, String> {
        match ssh_entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn delete(&self, account: &str) {
        if let Ok(entry) = ssh_entry(account) {
            let _ = entry.delete_credential();
        }
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

pub trait SecretStore {
    fn set(&self, value: &str) -> std::result::Result<(), String>;
    fn get(&self) -> std::result::Result<Option<String>, String>;
    fn delete(&self);

    fn set_account(&self, account: &str, value: &str) -> std::result::Result<(), String> {
        let _ = (account, value);
        Err("account secrets are not supported".into())
    }
    fn get_account(&self, account: &str) -> std::result::Result<Option<String>, String> {
        let _ = account;
        Ok(None)
    }
    fn delete_account(&self, account: &str) {
        let _ = account;
    }
}

pub struct SystemKeychain;

impl SecretStore for SystemKeychain {
    fn set(&self, value: &str) -> std::result::Result<(), String> {
        Entry::new(keychain_service(), XAI_ACCOUNT)
            .and_then(|entry| entry.set_password(value))
            .map_err(|e| e.to_string())
    }

    fn get(&self) -> std::result::Result<Option<String>, String> {
        match read_service(keychain_service())? {
            Some(value) => Ok(Some(value)),
            None if cfg!(debug_assertions) => copy_release_key_into_dev(),
            None => Ok(None),
        }
    }

    fn delete(&self) {
        if let Ok(entry) = Entry::new(keychain_service(), XAI_ACCOUNT) {
            let _ = entry.delete_credential();
        }
    }

    fn set_account(&self, account: &str, value: &str) -> std::result::Result<(), String> {
        Entry::new(keychain_service(), account)
            .and_then(|entry| entry.set_password(value))
            .map_err(|e| e.to_string())
    }

    fn get_account(&self, account: &str) -> std::result::Result<Option<String>, String> {
        match Entry::new(keychain_service(), account).and_then(|entry| entry.get_password()) {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => {
                if cfg!(debug_assertions) && account == ANTHROPIC_ACCOUNT {
                    copy_release_account_into_dev(account)
                } else {
                    Ok(None)
                }
            }
            Err(e) => Err(e.to_string()),
        }
    }

    fn delete_account(&self, account: &str) {
        if let Ok(entry) = Entry::new(keychain_service(), account) {
            let _ = entry.delete_credential();
        }
    }
}

fn copy_release_account_into_dev(account: &str) -> std::result::Result<Option<String>, String> {
    let Some(value) = read_account(RELEASE_SERVICE, account)? else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Entry::new(DEV_SERVICE, account)
        .and_then(|entry| entry.set_password(trimmed))
        .map_err(|e| e.to_string())?;
    Ok(Some(trimmed.to_string()))
}

fn read_account(service: &str, account: &str) -> std::result::Result<Option<String>, String> {
    match Entry::new(service, account).and_then(|entry| entry.get_password()) {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn read_service(service: &str) -> std::result::Result<Option<String>, String> {
    match Entry::new(service, XAI_ACCOUNT).and_then(|entry| entry.get_password()) {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Dev has its own keychain item. The first lookup copies the release key so clearing it later
/// cannot delete or keep resurrecting the release credential.
fn copy_release_key_into_dev() -> std::result::Result<Option<String>, String> {
    let Some(value) = read_service(RELEASE_SERVICE)? else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Entry::new(DEV_SERVICE, XAI_ACCOUNT)
        .and_then(|entry| entry.set_password(trimmed))
        .map_err(|e| e.to_string())?;
    Ok(Some(trimmed.to_string()))
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

pub fn set_xai_key(data_dir: &Path, key: &str) -> Result<()> {
    set_xai_key_in(data_dir, key, &SystemKeychain)
}

pub fn set_xai_key_in(data_dir: &Path, key: &str, store: &dyn SecretStore) -> Result<()> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return delete_xai_key_in(data_dir, store);
    }
    store
        .set(trimmed)
        .map_err(|e| Error::Keychain(format!("could not save key to keychain: {e}")))?;
    let _ = clear_file_key(data_dir);
    Ok(())
}

pub fn get_xai_key(data_dir: &Path) -> Option<String> {
    get_xai_key_in(data_dir, &SystemKeychain)
}

pub fn get_xai_key_in(data_dir: &Path, store: &dyn SecretStore) -> Option<String> {
    let stored = store
        .get()
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(value) = stored {
        let _ = clear_file_key(data_dir);
        return Some(value);
    }
    let leftover = leftover_file_key(data_dir)?;
    if store.set(&leftover).is_ok() {
        let _ = clear_file_key(data_dir);
    }
    Some(leftover)
}

pub fn delete_xai_key(data_dir: &Path) -> Result<()> {
    delete_xai_key_in(data_dir, &SystemKeychain)
}

pub fn delete_xai_key_in(data_dir: &Path, store: &dyn SecretStore) -> Result<()> {
    store.delete();
    clear_file_key(data_dir)
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

/// Anthropic key. Same keychain service as xAI, different account. Never reads `secrets.json`.
pub fn set_anthropic_key(key: &str) -> Result<()> {
    set_anthropic_key_in(key, &SystemKeychain)
}

pub fn set_anthropic_key_in(key: &str, store: &dyn SecretStore) -> Result<()> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return delete_anthropic_key_in(store);
    }
    store
        .set_account(ANTHROPIC_ACCOUNT, trimmed)
        .map_err(|e| Error::Keychain(format!("could not save key to keychain: {e}")))
}

pub fn get_anthropic_key() -> Option<String> {
    get_anthropic_key_in(&SystemKeychain)
}

pub fn get_anthropic_key_in(store: &dyn SecretStore) -> Option<String> {
    store
        .get_account(ANTHROPIC_ACCOUNT)
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn delete_anthropic_key() -> Result<()> {
    delete_anthropic_key_in(&SystemKeychain)
}

pub fn delete_anthropic_key_in(store: &dyn SecretStore) -> Result<()> {
    store.delete_account(ANTHROPIC_ACCOUNT);
    Ok(())
}

pub fn resolve_anthropic_key(saved: Option<String>, env: Option<String>) -> Option<String> {
    resolve_xai_key(saved, env)
}

pub fn resolve_anthropic_key_on_disk() -> Option<String> {
    resolve_anthropic_key(get_anthropic_key(), std::env::var("ANTHROPIC_API_KEY").ok())
}

#[cfg(test)]
mod xai_key_tests {
    use super::*;

    #[test]
    fn ssh_secret_roundtrip_does_not_touch_the_xai_key() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemSsh::default();
        let xai = MemStore::default();
        set_xai_key_in(dir.path(), "xai-secret", &xai).unwrap();
        set_ssh_secret_in("ssh-secret:box", "pass-1", &store).unwrap();
        assert_eq!(
            get_ssh_secret_in("ssh-secret:box", &store).as_deref(),
            Some("pass-1")
        );
        assert_eq!(
            get_xai_key_in(dir.path(), &xai).as_deref(),
            Some("xai-secret")
        );
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
        fn delete(&self, account: &str) {
            self.0.lock().unwrap().remove(account);
        }
    }

    #[test]
    fn anthropic_key_does_not_read_the_xai_key() {
        let store = MemStore::default();
        set_xai_key_in(std::path::Path::new("/tmp/unused"), "xai-secret", &store).unwrap();
        assert_eq!(get_anthropic_key_in(&store), None);
        set_anthropic_key_in("anthropic-secret", &store).unwrap();
        assert_eq!(
            get_anthropic_key_in(&store).as_deref(),
            Some("anthropic-secret")
        );
        assert_eq!(get_xai_key_in(std::path::Path::new("/tmp/unused"), &store).as_deref(), Some("xai-secret"));
        delete_anthropic_key_in(&store).unwrap();
        assert_eq!(get_anthropic_key_in(&store), None);
        assert_eq!(get_xai_key_in(std::path::Path::new("/tmp/unused"), &store).as_deref(), Some("xai-secret"));
    }

    #[test]
    fn anthropic_key_is_not_written_to_secrets_json() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemStore::default();
        std::fs::write(dir.path().join("secrets.json"), r#"{"xai_key":"file-secret"}"#).unwrap();
        set_anthropic_key_in("anthropic-secret", &store).unwrap();
        let raw = std::fs::read_to_string(dir.path().join("secrets.json")).unwrap();
        assert!(raw.contains("file-secret"), "{raw}");
        assert!(!raw.contains("anthropic-secret"), "{raw}");
        assert_eq!(
            resolve_anthropic_key(get_anthropic_key_in(&store), None).as_deref(),
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
        let store = MemStore::default();
        set_xai_key_in(dir.path(), "xai-secret", &store).unwrap();
        assert_eq!(
            get_xai_key_in(dir.path(), &store).as_deref(),
            Some("xai-secret")
        );
        delete_xai_key_in(dir.path(), &store).unwrap();
        assert_eq!(get_xai_key_in(dir.path(), &store), None);
    }

    #[test]
    fn set_does_not_write_the_key_to_json() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemStore::default();
        set_xai_key_in(dir.path(), "xai-secret", &store).unwrap();
        let path = dir.path().join("secrets.json");
        if path.exists() {
            let raw = std::fs::read_to_string(&path).unwrap();
            assert!(!raw.contains("xai-secret"), "{raw}");
        }
        assert_eq!(store.get().unwrap().as_deref(), Some("xai-secret"));
    }

    #[test]
    fn set_fails_when_keychain_fails() {
        let dir = tempfile::tempdir().unwrap();
        let err = set_xai_key_in(dir.path(), "xai-secret", &FailStore).unwrap_err();
        assert!(err.to_string().contains("keychain"));
        assert!(!dir.path().join("secrets.json").exists());
    }

    #[test]
    fn get_prefers_keychain_and_clears_leftover_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("secrets.json"),
            r#"{"xai_key":"file-secret"}"#,
        )
        .unwrap();
        let store = MemStore::default();
        store.set("chain-secret").unwrap();
        assert_eq!(
            get_xai_key_in(dir.path(), &store).as_deref(),
            Some("chain-secret")
        );
        let raw = std::fs::read_to_string(dir.path().join("secrets.json")).unwrap();
        assert!(!raw.contains("file-secret"), "{raw}");
    }

    #[test]
    fn get_migrates_leftover_file_into_keychain() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("secrets.json"),
            r#"{"xai_key":"file-secret"}"#,
        )
        .unwrap();
        let store = MemStore::default();
        assert_eq!(
            get_xai_key_in(dir.path(), &store).as_deref(),
            Some("file-secret")
        );
        assert_eq!(store.get().unwrap().as_deref(), Some("file-secret"));
        let raw = std::fs::read_to_string(dir.path().join("secrets.json")).unwrap();
        assert!(!raw.contains("file-secret"), "{raw}");
    }

    #[derive(Default)]
    struct MemStore(
        std::sync::Mutex<Option<String>>,
        std::sync::Mutex<std::collections::HashMap<String, String>>,
    );

    impl SecretStore for MemStore {
        fn set(&self, value: &str) -> std::result::Result<(), String> {
            *self.0.lock().unwrap() = Some(value.to_string());
            Ok(())
        }
        fn get(&self) -> std::result::Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn delete(&self) {
            *self.0.lock().unwrap() = None;
        }
        fn set_account(&self, account: &str, value: &str) -> std::result::Result<(), String> {
            self.1
                .lock()
                .unwrap()
                .insert(account.to_string(), value.to_string());
            Ok(())
        }
        fn get_account(&self, account: &str) -> std::result::Result<Option<String>, String> {
            Ok(self.1.lock().unwrap().get(account).cloned())
        }
        fn delete_account(&self, account: &str) {
            self.1.lock().unwrap().remove(account);
        }
    }

    struct FailStore;

    impl SecretStore for FailStore {
        fn set(&self, _: &str) -> std::result::Result<(), String> {
            Err("unavailable".into())
        }
        fn get(&self) -> std::result::Result<Option<String>, String> {
            Err("unavailable".into())
        }
        fn delete(&self) {}
    }
}
