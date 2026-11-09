use std::fs;
use std::path::{Path, PathBuf};

use super::cli::{cached_claude_version, claude_bin, claude_version, home_dir};

fn account_email(value: &serde_json::Value) -> Option<String> {
    for key in ["email", "emailAddress", "primaryEmail"] {
        if let Some(email) = value.get(key).and_then(|v| v.as_str()) {
            let email = email.trim();
            if email.contains('@') {
                return Some(email.to_string());
            }
        }
    }
    None
}

/// A Claude login leaves credentials on disk, or a `/login` managed API key in
/// the macOS keychain. The email is optional. The OAuth blob in the keychain is
/// not read: `security` asks for the keychain password when this app is not
/// allowed to see it, and the usage screen checks this account every time it
/// opens. The managed API key is a different item. A cancelled prompt for that
/// item is remembered for this process so the check does not ask again.
pub fn read_claude_account(home: &Path) -> Option<(bool, Option<String>)> {
    read_claude_account_with(home, read_managed_cli_api_key().as_deref())
}

fn read_claude_account_with(home: &Path, managed: Option<&str>) -> Option<(bool, Option<String>)> {
    let claude = home.join(".claude");
    let creds = claude.join(".credentials.json");
    if creds.is_file() {
        let raw = fs::read_to_string(&creds).unwrap_or_default();
        if let Some(found) = oauth_login(&raw) {
            return Some(found);
        }
    }
    for path in [home.join(".claude.json"), claude.join(".claude.json")] {
        let Ok(config) = fs::read_to_string(path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&config) else {
            continue;
        };
        if let Some(oauth) = value.get("oauthAccount").filter(|item| !item.is_null()) {
            return Some((true, account_email(oauth)));
        }
    }
    if let Some(found) = cli_access_token(home, false).map(|_| (true, cli_account_email(home))) {
        return Some(found);
    }
    // `claude auth status` reports this as `/login managed key` with no credentials file.
    managed_cli_api_key(managed).map(|_| (true, cli_account_email(home)))
}

/// Claude Code's `/login` managed key. Anything else, including the OAuth JSON
/// blob stored under a different keychain item, is not an API key.
fn managed_cli_api_key(raw: Option<&str>) -> Option<String> {
    let key = raw?.trim();
    if key.starts_with("sk-ant-") && key.len() > "sk-ant-".len() {
        Some(key.to_string())
    } else {
        None
    }
}

/// Account name `claude` passes to `security find-generic-password -a`.
fn claude_cli_keychain_account(user: Option<&str>) -> String {
    let user = user.unwrap_or("").trim();
    let ok = !user.is_empty()
        && user
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-');
    if ok {
        user.to_string()
    } else {
        "claude-code-user".into()
    }
}

/// Service name `claude` passes to `security -s` for the managed API key.
/// A custom config dir adds the first 8 hex chars of its sha256, which is how
/// Claude Code keeps two logins apart.
fn claude_cli_keychain_service(secure_dir: Option<&str>, config_dir: Option<&str>) -> String {
    let secure = secure_dir.map(str::trim);
    let config = config_dir.map(str::trim).filter(|value| !value.is_empty());
    let material = match secure {
        Some(value) if value.is_empty() => None,
        Some(value) => Some(value),
        None => config,
    };
    let suffix = match material {
        Some(value) => {
            use sha2::Digest;
            let digest = sha2::Sha256::digest(value.as_bytes());
            format!("-{}", hex::encode(&digest[..4]))
        }
        None => String::new(),
    };
    format!("Claude Code{suffix}")
}

/// The API key `claude /login` stored. `None` in tests, so a developer login
/// cannot change fixture results. A missing item is not cached: signing in
/// while the app is open should show up on the next check.
#[cfg(all(target_os = "macos", not(test)))]
fn read_managed_cli_api_key() -> Option<String> {
    let user = std::env::var("USER")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("LOGNAME").ok())
        .or_else(|| std::env::var("USERNAME").ok());
    let account = claude_cli_keychain_account(user.as_deref());
    let service = claude_cli_keychain_service(
        std::env::var("CLAUDE_SECURESTORAGE_CONFIG_DIR")
            .ok()
            .as_deref(),
        std::env::var("CLAUDE_CONFIG_DIR").ok().as_deref(),
    );
    let raw = read_claude_keychain(&service, &account)?;
    managed_cli_api_key(Some(&raw))
}

#[cfg(not(all(target_os = "macos", not(test))))]
fn read_managed_cli_api_key() -> Option<String> {
    None
}

/// One successful read is kept for this process. A cancelled prompt is kept too,
/// so settings and usage do not ask on every refresh. `errSecInteractionNotAllowed`
/// is not cached: the window may not have been able to show the dialog yet.
#[cfg(all(target_os = "macos", not(test)))]
fn read_claude_keychain(service: &str, account: &str) -> Option<String> {
    use std::sync::{Mutex, OnceLock};

    #[derive(Clone)]
    enum Cached {
        Value(String),
        Denied,
    }

    static CACHE: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    // Hold the lock across the read so two startup probes share one keychain prompt.
    let mut guard = cache.lock().unwrap_or_else(|err| err.into_inner());
    match guard.as_ref() {
        Some(Cached::Value(value)) => return Some(value.clone()),
        Some(Cached::Denied) => return None,
        None => {}
    }
    match security_framework::passwords::get_generic_password(service, account) {
        Ok(bytes) => {
            let text = String::from_utf8(bytes).ok()?;
            *guard = Some(Cached::Value(text.clone()));
            Some(text)
        }
        // errSecItemNotFound. A missing item does not show the password dialog.
        Err(err) if err.code() == -25300 => None,
        // User cancelled, or the prompt was refused.
        Err(err) if matches!(err.code(), -128 | -25293) => {
            *guard = Some(Cached::Denied);
            None
        }
        Err(_) => None,
    }
}

fn oauth_access_token(raw: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let oauth = value.get("claudeAiOauth").filter(|item| !item.is_null())?;
    let token = oauth
        .get("accessToken")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|token| !token.is_empty())?;
    if token_expired(oauth.get("expiresAt").and_then(|item| item.as_i64())) {
        return None;
    }
    Some(token.to_string())
}

fn oauth_login(raw: &str) -> Option<(bool, Option<String>)> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let token = oauth_access_token(raw)?;
    let oauth = value.get("claudeAiOauth")?;
    let _ = token;
    Some((true, account_email(oauth).or_else(|| account_email(&value))))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeAuth {
    pub token: String,
    pub via_cli: bool,
}

/// Saved API key first, then the same Claude CLI login the settings screen shows as signed in.
/// The token is not returned to the UI. An expired CLI token is not refreshed here.
pub fn resolve_claude_auth() -> Option<ClaudeAuth> {
    resolve_claude_auth_in(&crate::state::app_data_dir())
}

/// Like `resolve_claude_auth`, but renews the CLI OAuth token when it is near expiry.
/// A saved API key is used for chat. It does not skip renewing the CLI login, because
/// session usage can only be read with that OAuth token.
pub async fn resolve_claude_auth_fresh() -> Option<ClaudeAuth> {
    resolve_claude_auth_fresh_in(&crate::state::app_data_dir()).await
}

pub async fn resolve_claude_auth_fresh_in(data_dir: &std::path::Path) -> Option<ClaudeAuth> {
    let _ = refresh_claude_cli_login().await;
    resolve_claude_auth_in(data_dir)
}

fn resolve_claude_auth_in(data_dir: &std::path::Path) -> Option<ClaudeAuth> {
    resolve_claude_auth_with(data_dir, false)
}

/// Renew `~/.config/anthropic/credentials` when the access token is near expiry.
/// Returns the fresh token. `None` when there is nothing to renew or the refresh fails.
pub async fn refresh_claude_cli_login() -> Option<String> {
    let home = home_dir()?;
    read_cli_access_token_fresh(&home).await
}

fn resolve_claude_auth_with(
    data_dir: &std::path::Path,
    allow_expired_cli: bool,
) -> Option<ClaudeAuth> {
    resolve_claude_sources(
        data_dir,
        allow_expired_cli,
        home_dir().as_deref(),
        read_managed_cli_api_key(),
    )
}

/// Saved app key, then the `/login` managed API key, then the OAuth files.
/// The managed key is an `sk-ant-` API key, so it uses `x-api-key`, not a bearer token.
fn resolve_claude_sources(
    data_dir: &std::path::Path,
    allow_expired_cli: bool,
    home: Option<&Path>,
    managed: Option<String>,
) -> Option<ClaudeAuth> {
    if let Some(key) = crate::secrets::resolve_anthropic_key_on_disk(data_dir) {
        return Some(ClaudeAuth {
            token: key,
            via_cli: false,
        });
    }
    if let Some(token) = managed_cli_api_key(managed.as_deref()) {
        return Some(ClaudeAuth {
            token,
            via_cli: false,
        });
    }
    let home = home?;
    if let Some(token) = read_claude_access_token(home) {
        return Some(ClaudeAuth {
            token,
            via_cli: true,
        });
    }
    if !allow_expired_cli {
        return None;
    }
    let (token, _) = cli_access_token(home, true)?;
    Some(ClaudeAuth {
        token,
        via_cli: true,
    })
}

/// The login the settings screen counts as signed in.
/// `~/.claude/.credentials.json` first, then the Claude CLI credentials file.
/// The OAuth keychain item is not read, so opening usage never asks for its password.
/// The `/login` managed API key is resolved separately and sent as `x-api-key`.
pub fn read_claude_access_token(home: &Path) -> Option<String> {
    if let Some(raw) = fs::read_to_string(home.join(".claude").join(".credentials.json")).ok() {
        if let Some(token) = oauth_access_token(&raw) {
            return Some(token);
        }
    }
    read_cli_access_token(home)
}

pub fn read_cli_access_token(home: &Path) -> Option<String> {
    cli_access_token(home, false).map(|(token, _)| token)
}

/// The Claude CLI login. A token inside the refresh window is renewed and written back.
/// A token that is still fresh is returned as-is, so callers can always try a refresh.
pub async fn read_cli_access_token_fresh(home: &Path) -> Option<String> {
    let path = cli_credentials_path(home);
    let raw = fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let token = access_token_of(&value)?;
    if !token_needs_refresh(value.get("expires_at").and_then(|item| item.as_i64())) {
        return Some(token);
    }
    let refresh = value
        .get("refresh_token")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())?
        .to_string();
    match refresh_cli_credentials(&path, &refresh).await {
        Some(fresh) => Some(fresh),
        // Keep the current access token until it is actually expired. A failed refresh
        // a few minutes early should not sign the account out.
        None if !token_expired(value.get("expires_at").and_then(|item| item.as_i64())) => Some(token),
        None => None,
    }
}

/// `(token, needs_refresh)`. An expired token is still returned when `allow_expired` is set so the caller can refresh it.
pub(super) fn cli_access_token(home: &Path, allow_expired: bool) -> Option<(String, bool)> {
    let raw = fs::read_to_string(cli_credentials_path(home)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let token = access_token_of(&value)?;
    let expired = token_needs_refresh(value.get("expires_at").and_then(|item| item.as_i64()));
    if expired && !allow_expired {
        return None;
    }
    Some((token, expired))
}

fn cli_credentials_path(home: &Path) -> PathBuf {
    let root = home.join(".config").join("anthropic");
    let name = fs::read_to_string(root.join("active_config"))
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|name| profile_name_ok(name))
        .unwrap_or_else(|| "default".into());
    root.join("credentials").join(format!("{name}.json"))
}

/// Profile names Claude Code accepts: letters, digits, `_`, `.`, `-`.
fn profile_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-')
}

/// The OAuth client that issued this login. A profile config wins over the public default,
/// because a refresh token is bound to the client that created it.
fn claude_oauth_client_id(credentials: &Path) -> String {
    let Some(root) = credentials.parent().and_then(|dir| dir.parent()) else {
        return CLAUDE_OAUTH_CLIENT_ID.into();
    };
    let name = credentials
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|name| profile_name_ok(name))
        .unwrap_or("default");
    let config = root.join("configs").join(format!("{name}.json"));
    if let Some(client) = read_profile_client_id(&config) {
        return client;
    }
    // The profile file exists but has no client id. Current Claude Code pins the profile client.
    if config.is_file() {
        return CLAUDE_PROFILE_CLIENT_ID.into();
    }
    CLAUDE_OAUTH_CLIENT_ID.into()
}

fn read_profile_client_id(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .pointer("/authentication/client_id")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
}

pub(super) fn claude_cli_user_agent() -> String {
    let version = cached_claude_version(claude_bin().as_deref()).or_else(|| {
        home_dir().and_then(|home| claude_bin_version(&home))
    });
    match version {
        Some(version) => format!("claude-code/{version}"),
        None => "claude-code".into(),
    }
}

fn claude_bin_version(home: &Path) -> Option<String> {
    let local = home.join(".claude").join("local").join(if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    });
    if local.is_file() {
        return claude_version(&local);
    }
    None
}

fn access_token_of(value: &serde_json::Value) -> Option<String> {
    value
        .get("access_token")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

/// Refresh a few minutes early so a send does not race the expiry.
fn token_needs_refresh(expires_at: Option<i64>) -> bool {
    let Some(expires_at) = expires_at.filter(|value| *value > 0) else {
        return false;
    };
    let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return false;
    };
    let expires_ms = if expires_at < 10_000_000_000 {
        expires_at.saturating_mul(1000)
    } else {
        expires_at
    };
    expires_ms <= now.as_millis() as i64 + 5 * 60 * 1000
}

/// Same login the Claude CLI reports as `oauth_token`. The refresh token rotates, so the file is rewritten.
async fn refresh_cli_credentials(path: &Path, refresh_token: &str) -> Option<String> {
    let client_id = claude_oauth_client_id(path);
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
    });
    // Cloudflare rejects a request with no user agent. Claude Code sends its own.
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent(claude_cli_user_agent())
        .build()
        .ok()?
        .post(CLAUDE_OAUTH_TOKEN_URL)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .json(&body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let fresh: serde_json::Value = response.json().await.ok()?;
    let access = access_token_of(&fresh)?;
    let mut stored = serde_json::from_str::<serde_json::Value>(&fs::read_to_string(path).ok()?).ok()?;
    let obj = stored.as_object_mut()?;
    obj.insert("access_token".into(), serde_json::Value::String(access.clone()));
    if let Some(next) = fresh.get("refresh_token").and_then(|item| item.as_str()) {
        if !next.trim().is_empty() {
            obj.insert("refresh_token".into(), serde_json::Value::String(next.to_string()));
        }
    }
    if let Some(expires_at) = fresh.get("expires_at").and_then(|item| item.as_i64()) {
        obj.insert("expires_at".into(), serde_json::Value::from(expires_at));
    } else if let Some(expires_in) = fresh.get("expires_in").and_then(|item| item.as_i64()) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs() as i64;
        obj.insert("expires_at".into(), serde_json::Value::from(now.saturating_add(expires_in)));
    }
    let text = serde_json::to_string_pretty(&stored).ok()?;
    fs::write(path, text).ok()?;
    Some(access)
}

/// Claude writes `expires_at` as unix seconds. Older payloads used milliseconds.
fn token_expired(expires_at: Option<i64>) -> bool {
    let Some(expires_at) = expires_at.filter(|value| *value > 0) else {
        return false;
    };
    let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return false;
    };
    let expires_ms = if expires_at < 10_000_000_000 {
        expires_at.saturating_mul(1000)
    } else {
        expires_at
    };
    expires_ms <= now.as_millis() as i64
}

pub const CLAUDE_OAUTH_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
/// Claude Code's public OAuth client. A profile can pin a different one.
pub const CLAUDE_OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/// Claude Code 2.1+ writes this client into `~/.config/anthropic/configs/*.json`.
pub const CLAUDE_PROFILE_CLIENT_ID: &str = "41077d10-94b8-4194-be48-d251e9eb21b4";

pub(super) fn cli_account_email(home: &Path) -> Option<String> {
    let raw = fs::read_to_string(cli_credentials_path(home)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("account_email")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|email| email.contains('@'))
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::usage::claude_usage_tokens;

    #[test]
    fn claude_account_reads_credentials_and_oauth_email() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_claude_account(dir.path()), None);
        let home = dir.path().join(".claude");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            dir.path().join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"ada@example.com"}}"#,
        )
        .unwrap();
        assert_eq!(
            read_claude_account(dir.path()),
            Some((true, Some("ada@example.com".into())))
        );
        fs::write(
            home.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"secret","email":"ada@example.com"}}"#,
        )
        .unwrap();
        assert_eq!(
            read_claude_account(dir.path()),
            Some((true, Some("ada@example.com".into())))
        );
    }

    #[test]
    fn an_expired_credentials_file_is_not_a_login() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join(".claude");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"old-token","expiresAt":1}}"#,
        )
        .unwrap();
        assert_eq!(read_claude_access_token(dir.path()), None);
        fs::write(
            home.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"file-token","expiresAt":4102444800000}}"#,
        )
        .unwrap();
        assert_eq!(read_claude_access_token(dir.path()).as_deref(), Some("file-token"));
    }

    #[test]
    fn cli_email_is_read_without_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let creds = dir
            .path()
            .join(".config")
            .join("anthropic")
            .join("credentials");
        fs::create_dir_all(&creds).unwrap();
        fs::write(
            creds.join("default.json"),
            r#"{"access_token":"oauth-token","expires_at":1,"account_email":"ada@example.com","refresh_token":"refresh"}"#,
        )
        .unwrap();
        assert_eq!(cli_account_email(dir.path()).as_deref(), Some("ada@example.com"));
        assert_eq!(claude_oauth_client_id(&creds.join("default.json")), CLAUDE_OAUTH_CLIENT_ID);
        let root = dir.path().join(".config").join("anthropic");
        fs::create_dir_all(root.join("configs")).unwrap();
        fs::write(
            root.join("configs").join("default.json"),
            r#"{"authentication":{"type":"user_oauth","client_id":"41077d10-94b8-4194-be48-d251e9eb21b4"}}"#,
        )
        .unwrap();
        assert_eq!(
            claude_oauth_client_id(&creds.join("default.json")),
            CLAUDE_PROFILE_CLIENT_ID
        );
        fs::write(root.join("active_config"), "work\n").unwrap();
        assert_eq!(
            cli_credentials_path(dir.path()),
            root.join("credentials").join("work.json")
        );
        fs::write(root.join("active_config"), "../secrets").unwrap();
        assert_eq!(
            cli_credentials_path(dir.path()),
            root.join("credentials").join("default.json")
        );
        // The access token is expired, but it stays a candidate so the caller can refresh it.
        assert_eq!(claude_usage_tokens(dir.path()), vec!["oauth-token".to_string()]);
        assert_eq!(read_claude_access_token(dir.path()), None);
        assert_eq!(
            cli_access_token(dir.path(), true).map(|(token, expired)| (token, expired)),
            Some(("oauth-token".into(), true))
        );
    }

    #[test]
    fn a_credentials_file_signs_in_without_the_keychain() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_claude_access_token(dir.path()), None);
        let home = dir.path().join(".claude");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"file-token","expiresAt":4102444800000}}"#,
        )
        .unwrap();
        assert_eq!(read_claude_access_token(dir.path()).as_deref(), Some("file-token"));
        fs::write(
            home.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"file-token"}}"#,
        )
        .unwrap();
        assert_eq!(read_claude_access_token(dir.path()).as_deref(), Some("file-token"));
    }

    #[test]
    fn cli_access_token_is_used_until_it_expires() {
        let dir = tempfile::tempdir().unwrap();
        let creds = dir
            .path()
            .join(".config")
            .join("anthropic")
            .join("credentials");
        fs::create_dir_all(&creds).unwrap();
        fs::write(
            creds.join("default.json"),
            r#"{"access_token":"oauth-token","expires_at":4102444800000,"account_email":"ada@example.com"}"#,
        )
        .unwrap();
        assert_eq!(
            read_cli_access_token(dir.path()).as_deref(),
            Some("oauth-token")
        );
        fs::write(
            creds.join("default.json"),
            r#"{"access_token":"old-token","expires_at":1}"#,
        )
        .unwrap();
        assert_eq!(read_cli_access_token(dir.path()), None);
        fs::write(
            creds.join("default.json"),
            r#"{"access_token":"oauth-seconds","expires_at":4102444800}"#,
        )
        .unwrap();
        assert_eq!(
            read_cli_access_token(dir.path()).as_deref(),
            Some("oauth-seconds")
        );
        assert!(!token_expired(None));
        assert!(token_expired(Some(1)));
        assert!(!token_expired(Some(4_102_444_800)));
        assert!(!token_expired(Some(4_102_444_800_000)));
        assert!(token_needs_refresh(Some(1)));
        assert!(!token_needs_refresh(None));
        assert!(!token_needs_refresh(Some(4_102_444_800)));
    }

    #[test]
    fn a_login_managed_key_signs_in_without_a_credentials_file() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        assert_eq!(read_claude_account_with(home, None), None);
        assert_eq!(
            read_claude_account_with(home, Some("sk-ant-from-cli")),
            Some((true, None))
        );
        let auth = resolve_claude_sources(
            dir.path(),
            false,
            Some(home),
            Some("sk-ant-from-cli".into()),
        )
        .expect("managed key");
        assert_eq!(auth.token, "sk-ant-from-cli");
        // `/login` stores an API key, not an OAuth bearer token.
        assert!(!auth.via_cli);
        assert!(resolve_claude_sources(dir.path(), false, Some(home), None).is_none());
        crate::secrets::set_anthropic_key(dir.path(), "sk-ant-saved").unwrap();
        let saved = resolve_claude_sources(
            dir.path(),
            false,
            Some(home),
            Some("sk-ant-from-cli".into()),
        )
        .expect("saved key");
        assert_eq!(saved.token, "sk-ant-saved");
        assert!(!saved.via_cli);
    }

    #[test]
    fn managed_cli_key_rejects_anything_that_is_not_an_api_key() {
        assert_eq!(
            managed_cli_api_key(Some(" sk-ant-api03-abc ")).as_deref(),
            Some("sk-ant-api03-abc")
        );
        assert_eq!(managed_cli_api_key(None), None);
        assert_eq!(managed_cli_api_key(Some("")), None);
        assert_eq!(managed_cli_api_key(Some("sk-ant-")), None);
        assert_eq!(
            managed_cli_api_key(Some(r#"{"mcpOAuth":{"accessToken":""}}"#)),
            None
        );
    }

    #[test]
    fn cli_keychain_name_matches_claude_code() {
        assert_eq!(claude_cli_keychain_service(None, None), "Claude Code");
        assert_eq!(claude_cli_keychain_service(Some(""), None), "Claude Code");
        assert_eq!(
            claude_cli_keychain_service(None, Some("/tmp/claude-home")),
            "Claude Code-ee668b60"
        );
        assert_eq!(
            claude_cli_keychain_service(Some("/custom/secure"), Some("/tmp/claude-home")),
            "Claude Code-378dd983"
        );
        assert_eq!(
            claude_cli_keychain_account(Some("twanluttik")),
            "twanluttik"
        );
        assert_eq!(
            claude_cli_keychain_account(Some("Ada Lovelace")),
            "claude-code-user"
        );
        assert_eq!(claude_cli_keychain_account(Some("")), "claude-code-user");
        assert_eq!(claude_cli_keychain_account(None), "claude-code-user");
    }

    #[test]
    fn claude_account_reads_oauth_from_the_credentials_file() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join(".claude");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"secret-token"},"emailAddress":"ada@example.com"}"#,
        )
        .unwrap();
        assert_eq!(
            read_claude_account(dir.path()),
            Some((true, Some("ada@example.com".into())))
        );
        fs::write(
            home.join(".credentials.json"),
            r#"{"mcpOAuth":{"server":{"accessToken":""}}}"#,
        )
        .unwrap();
        assert_eq!(read_claude_account(dir.path()), None);
    }
}
