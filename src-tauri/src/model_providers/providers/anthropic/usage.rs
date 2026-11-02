use std::path::Path;

use serde::{Deserialize, Serialize};

use super::PROVIDER_ANTHROPIC;
use super::auth::{
    claude_cli_user_agent, cli_access_token, cli_account_email, read_claude_access_token,
    read_claude_account, read_cli_access_token_fresh,
};
use super::cli::home_dir;

fn account_usage_cache_key() -> &'static str {
    PROVIDER_ANTHROPIC
}

/// The last snapshot written to the app database. Empty when this provider has never loaded.
pub fn cached_account_usage(data_dir: &std::path::Path) -> Option<AccountUsage> {
    let conn = crate::appdb::open(data_dir).ok()?;
    let raw = crate::appdb::get_account_usage(&conn, account_usage_cache_key()).ok()??;
    serde_json::from_str(&raw).ok()
}

/// A confirmed sign-out replaces the snapshot. A failed read does not, so one bad
/// poll cannot hide an account that was connected a moment ago.
fn store_account_usage(data_dir: &std::path::Path, usage: &AccountUsage) {
    let Ok(conn) = crate::appdb::open(data_dir) else {
        return;
    };
    if !usage.connected {
        let previous = crate::appdb::get_account_usage(&conn, account_usage_cache_key())
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<AccountUsage>(&raw).ok());
        if previous.as_ref().is_some_and(|row| row.connected) {
            return;
        }
    }
    let Ok(raw) = serde_json::to_string(usage) else {
        return;
    };
    let _ = crate::appdb::set_account_usage(&conn, account_usage_cache_key(), &raw);
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_account_usage_cached(state: tauri::State<'_, crate::state::AppState>) -> Option<AccountUsage> {
    cached_account_usage(&state.data_dir)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_account_usage(state: tauri::State<'_, crate::state::AppState>) -> Result<AccountUsage, String> {
    let data_dir = state.data_dir.clone();
    let usage = account_usage().await;
    store_account_usage(&data_dir, &usage);
    Ok(usage)
}

/// Session usage for the signed-in Claude account. An API key cannot read this.
pub const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
pub const CLAUDE_ACCOUNT_URL: &str = "https://api.anthropic.com/api/oauth/account";

/// One allowance window on the connected Claude account, such as the 5-hour session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AccountUsageWindow {
    pub id: String,
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<String>,
}

/// Usage of the Claude account this app is signed into. Absent when Claude is not connected.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AccountUsage {
    pub provider: String,
    pub connected: bool,
    pub label: String,
    pub windows: Vec<AccountUsageWindow>,
    /// Remaining prepaid balance in cents, when this login can read it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance_cents: Option<i64>,
    /// Currency for `balance_cents`. Empty when the balance is absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance_currency: Option<String>,
    /// `available` when a prepaid API org still has credits and no dollar balance was returned.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credit_status: Option<String>,
    /// When this snapshot was fetched. The sidebar ignores a cache older than a few minutes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
}

fn usage_percent(value: &serde_json::Value) -> Option<f64> {
    let raw = value
        .get("utilization")
        .or_else(|| value.get("used_percentage"))
        .or_else(|| value.get("percent"))
        .or_else(|| value.get("utilization_percent"))?;
    let number = raw.as_f64().or_else(|| raw.as_i64().map(|n| n as f64))?;
    if !number.is_finite() || number < 0.0 {
        return None;
    }
    // The usage endpoint reports 0–100. A 0–1 header fraction is not used here.
    Some(number.min(100.0))
}

/// An ISO timestamp, or unix seconds written so `Date.parse` can read them.
/// A small number is a percent, not a reset, so it is ignored.
fn reset_stamp(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        let text = text.trim();
        if text.is_empty() || text.parse::<f64>().is_ok() {
            return None;
        }
        return Some(text.to_string());
    }
    let secs = value.as_i64().filter(|secs| *secs > 1_000_000_000)?;
    Some(format!("{secs}000"))
}

fn usage_window(id: &str, label: &str, value: &serde_json::Value) -> Option<AccountUsageWindow> {
    let used_percent = usage_percent(value)?;
    let resets_at = value
        .get("resets_at")
        .or_else(|| value.get("resetsAt"))
        .and_then(reset_stamp);
    Some(AccountUsageWindow {
        id: id.into(),
        label: label.into(),
        used_percent,
        resets_at,
    })
}

/// Read the session and weekly allowance from a Claude OAuth usage payload.
/// Unknown shapes return no windows instead of inventing a number.
///
/// The CLI reads `five_hour` / `seven_day` with `used_percentage`. Newer replies
/// also carry a `limits` list (`kind`, `percent`, `resets_at`). A prepaid API
/// org often has neither, and then this stays empty.
pub fn parse_account_usage(body: &str) -> Vec<AccountUsageWindow> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let root = json
        .get("rate_limits")
        .filter(|value| value.is_object())
        .unwrap_or(&json);
    let mut windows = Vec::new();
    for (id, label) in [
        ("five_hour", "5h"),
        ("seven_day", "7d"),
        ("seven_day_opus", "Opus"),
        ("seven_day_sonnet", "Sonnet"),
    ] {
        if let Some(window) = root.get(id).and_then(|value| usage_window(id, label, value)) {
            windows.push(window);
        }
    }
    if let Some(extra) = json
        .get("extra_usage")
        .or_else(|| root.get("extra_usage"))
        .filter(|value| value.get("is_enabled").and_then(|item| item.as_bool()).unwrap_or(false))
        .and_then(|value| usage_window("extra", "Extra", value))
    {
        windows.push(extra);
    }
    if windows.is_empty() {
        if let Some(rows) = root.get("limits").and_then(|value| value.as_array()) {
            for row in rows {
                let kind = row.get("kind").and_then(|item| item.as_str()).unwrap_or("session");
                let label = limit_label(kind, row);
                if let Some(window) = usage_window(kind, &label, row) {
                    windows.push(window);
                }
            }
        }
    }
    windows
}

fn empty_usage(connected: bool, label: impl Into<String>) -> AccountUsage {
    AccountUsage {
        provider: PROVIDER_ANTHROPIC.into(),
        connected,
        label: label.into(),
        windows: Vec::new(),
        balance_cents: None,
        balance_currency: None,
        credit_status: None,
        fetched_at: Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
    }
}

/// `amount` is cents. A missing amount is not a balance of zero.
pub fn parse_prepaid_balance(body: &str) -> Option<(i64, String)> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    let amount = json.get("amount")?.as_i64()?;
    if amount < 0 {
        return None;
    }
    let currency = json
        .get("currency")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .unwrap_or("USD")
        .to_string();
    Some((amount, currency))
}

/// The prepaid API organization on this login. Chat-only orgs are ignored.
pub fn parse_api_org(body: &str) -> Option<(String, Option<String>)> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    let rows = json.get("memberships")?.as_array()?;
    for row in rows {
        let org = row.get("organization")?;
        let caps = org.get("capabilities").and_then(|value| value.as_array());
        let api = caps
            .map(|items| items.iter().any(|item| item.as_str() == Some("api")))
            .unwrap_or(false);
        if !api && org.get("billing_type").and_then(|item| item.as_str()) != Some("prepaid") {
            continue;
        }
        let uuid = org.get("uuid").and_then(|item| item.as_str()).map(str::trim)?;
        if uuid.is_empty() {
            continue;
        }
        let status = org
            .get("free_credits_status")
            .and_then(|item| item.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string);
        return Some((uuid.to_string(), status));
    }
    None
}

fn limit_label(kind: &str, row: &serde_json::Value) -> String {
    match kind {
        "session" | "five_hour" => "5h".into(),
        "weekly_all" | "seven_day" => "7d".into(),
        "weekly_scoped" => row
            .pointer("/scope/model/display_name")
            .and_then(|item| item.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .unwrap_or("Week")
            .to_string(),
        other => other.to_string(),
    }
}

fn oauth_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

enum OauthGet {
    Ok(String),
    /// The token was rejected. The caller should refresh and try once more.
    Unauthorized,
    /// The network failed or the server answered with something other than 401.
    Failed,
}

async fn oauth_get(client: &reqwest::Client, url: &str, token: &str) -> OauthGet {
    let response = match client
        .get(url)
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("accept", "application/json")
        .header("user-agent", claude_cli_user_agent())
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return OauthGet::Failed,
    };
    let status = response.status();
    // 403 on the credits endpoint means this plan cannot read a dollar balance.
    // The caller still has the account, so that is not a failed login.
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return OauthGet::Unauthorized;
    }
    if !status.is_success() {
        return OauthGet::Failed;
    }
    match response.text().await {
        Ok(body) => OauthGet::Ok(body),
        Err(_) => OauthGet::Failed,
    }
}

/// OAuth tokens that can read session usage, newest first. An API key is not one of them.
/// The CLI file is listed even when it is inside the refresh window, so a 401 can renew it.
pub(super) fn claude_usage_tokens(home: &Path) -> Vec<String> {
    let mut tokens = Vec::new();
    let push = |tokens: &mut Vec<String>, token: Option<String>| {
        let Some(token) = token else {
            return;
        };
        if !tokens.iter().any(|row| row == &token) {
            tokens.push(token);
        }
    };
    push(&mut tokens, read_claude_access_token(home));
    push(
        &mut tokens,
        cli_access_token(home, true).map(|(token, _)| token),
    );
    tokens
}

async fn usage_from_token(client: &reqwest::Client, token: &str, label: String) -> (AccountUsage, OauthGet) {
    let usage_body = oauth_get(client, CLAUDE_USAGE_URL, token).await;
    let mut usage = AccountUsage {
        provider: PROVIDER_ANTHROPIC.into(),
        connected: true,
        label,
        windows: match &usage_body {
            OauthGet::Ok(body) => parse_account_usage(body),
            _ => Vec::new(),
        },
        balance_cents: None,
        balance_currency: None,
        credit_status: None,
        fetched_at: Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
    };
    if !usage.windows.is_empty() {
        return (usage, OauthGet::Ok(String::new()));
    }
    // A 401 on usage is the token. Don't spend another request before refreshing.
    if matches!(usage_body, OauthGet::Unauthorized) {
        return (usage, OauthGet::Unauthorized);
    }
    let account = match oauth_get(client, CLAUDE_ACCOUNT_URL, token).await {
        OauthGet::Ok(body) => body,
        other => return (usage, other),
    };
    let Some((org, status)) = parse_api_org(&account) else {
        // The usage endpoint answered. An account with no session windows and no
        // API org is still signed in. Session limits simply do not apply.
        return (usage, OauthGet::Ok(account));
    };
    usage.credit_status = status.filter(|item| item == "available" || item == "exhausted");
    let credits_url = format!("https://api.anthropic.com/api/oauth/organizations/{org}/prepaid/credits");
    match oauth_get(client, &credits_url, token).await {
        OauthGet::Ok(body) => {
            if let Some((cents, currency)) = parse_prepaid_balance(&body) {
                usage.balance_cents = Some(cents);
                usage.balance_currency = Some(currency);
                // A dollar balance replaces the free-credit flag.
                usage.credit_status = None;
            }
            (usage, OauthGet::Ok(body))
        }
        // Pro and Max only. The account payload already said whether credits remain.
        OauthGet::Unauthorized => (usage, OauthGet::Ok(account)),
        OauthGet::Failed => (usage, OauthGet::Ok(account)),
    }
}

/// The connected Claude account's own allowance. An API-key-only login has no session usage.
/// A prepaid API org with no session windows reports its credit balance instead.
/// The CLI token is refreshed before the call when it is near expiry, and once more on 401.
pub async fn account_usage() -> AccountUsage {
    let Some(home) = home_dir() else {
        return empty_usage(false, "Claude");
    };
    let _ = read_cli_access_token_fresh(&home).await;
    let email = read_claude_account(&home).and_then(|(_, email)| email);
    let label = email
        .or_else(|| cli_account_email(&home))
        .unwrap_or_else(|| "Claude".into());
    let mut tokens = claude_usage_tokens(&home);
    if tokens.is_empty() {
        return empty_usage(false, label);
    }
    let client = oauth_client();
    let mut saw_auth_failure = false;
    let mut last_connected: Option<AccountUsage> = None;
    for token in tokens.iter() {
        let (usage, status) = usage_from_token(&client, token, label.clone()).await;
        match status {
            OauthGet::Unauthorized => saw_auth_failure = true,
            OauthGet::Failed => last_connected = Some(usage),
            OauthGet::Ok(_) => return usage,
        }
    }
    if saw_auth_failure {
        if let Some(fresh) = read_cli_access_token_fresh(&home).await {
            if !tokens.iter().any(|token| token == &fresh) {
                tokens.push(fresh.clone());
                let (usage, status) = usage_from_token(&client, &fresh, label.clone()).await;
                if !matches!(status, OauthGet::Unauthorized) {
                    return usage;
                }
            }
        }
    }
    if let Some(usage) = last_connected {
        return usage;
    }
    // Every candidate token was rejected. That is a real sign-out, not a blip.
    if saw_auth_failure {
        return empty_usage(false, label);
    }
    empty_usage(false, label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_usage_reads_session_windows() {
        let body = r#"{
            "five_hour": {"utilization": 42.5, "resets_at": "2026-07-20T18:00:00Z"},
            "seven_day": {"utilization": 11, "resets_at": "2026-07-26T00:00:00Z"}
        }"#;
        let windows = parse_account_usage(body);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].id, "five_hour");
        assert_eq!(windows[0].label, "5h");
        assert!((windows[0].used_percent - 42.5).abs() < 0.01);
        assert_eq!(windows[0].resets_at.as_deref(), Some("2026-07-20T18:00:00Z"));
        assert_eq!(windows[1].label, "7d");
        assert!((windows[1].used_percent - 11.0).abs() < 0.01);
        assert!(parse_account_usage("nope").is_empty());
        assert!(parse_account_usage(r#"{"five_hour":{"utilization":-1}}"#).is_empty());
        let nested = r#"{"rate_limits":{"five_hour":{"used_percentage":18,"resets_at":1780000000},"seven_day":null},"extra_usage":{"is_enabled":true,"utilization":64,"currency":"USD"}}"#;
        let windows = parse_account_usage(nested);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].label, "5h");
        assert!((windows[0].used_percent - 18.0).abs() < 0.01);
        assert_eq!(windows[0].resets_at.as_deref(), Some("1780000000000"));
        assert_eq!(windows.iter().filter(|row| row.id == "extra").count(), 1);
        assert!((windows.iter().find(|row| row.id == "extra").unwrap().used_percent - 64.0).abs() < 0.01);
        let limits = r#"{"limits":[{"kind":"session","percent":7,"resets_at":"2026-07-20T18:00:00Z"},{"kind":"weekly_scoped","percent":3,"resets_at":"2026-07-26T00:00:00Z","scope":{"model":{"display_name":"Opus"}}}]}"#;
        let rows = parse_account_usage(limits);
        assert_eq!(rows.iter().map(|row| row.label.as_str()).collect::<Vec<_>>(), ["5h", "Opus"]);
        assert_eq!(
            parse_prepaid_balance(r#"{"amount":1250,"currency":"USD"}"#),
            Some((1250, "USD".into()))
        );
        assert_eq!(parse_prepaid_balance(r#"{"currency":"USD"}"#), None);
        let account = r#"{"memberships":[{"organization":{"uuid":"chat-org","capabilities":["chat"],"free_credits_status":null}},{"organization":{"uuid":"api-org","billing_type":"prepaid","capabilities":["api"],"free_credits_status":"available"}}]}"#;
        assert_eq!(parse_api_org(account), Some(("api-org".into(), Some("available".into()))));
        assert_eq!(parse_api_org(r#"{"memberships":[]}"#), None);
    }
}
