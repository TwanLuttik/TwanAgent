use std::fs;
use std::path::Path;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use super::{cached_cli_version, cli_proxy_headers, grok_home, is_expired, parse_time, AuthEntry};

pub const PROVIDER_XAI: &str = "xai";
/// The call `grok` makes for `/usage`. An API key cannot read this.
pub const BILLING_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
pub const SETTINGS_URL: &str = "https://cli-chat-proxy.grok.com/v1/settings";
/// Same public client `grok login` uses. A refresh token is bound to it.
pub const XAI_OAUTH_CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
pub const XAI_OAUTH_TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";

/// One allowance window on the signed-in Grok account. `used_percent` is percent used.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AccountUsageWindow {
    pub id: String,
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<String>,
}

/// Weekly pool, or a prepaid balance, for the Grok CLI login. An API key has neither.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AccountUsage {
    pub provider: String,
    pub connected: bool,
    pub label: String,
    pub windows: Vec<AccountUsageWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance_cents: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance_currency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credit_status: Option<String>,
    /// When this snapshot was fetched. The sidebar ignores a cache older than a few minutes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
}

fn empty_usage(connected: bool, label: impl Into<String>) -> AccountUsage {
    AccountUsage {
        provider: PROVIDER_XAI.into(),
        connected,
        label: label.into(),
        windows: Vec::new(),
        balance_cents: None,
        balance_currency: None,
        credit_status: None,
        fetched_at: Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
    }
}

fn account_usage_cache_key() -> &'static str {
    PROVIDER_XAI
}

/// The last snapshot written to the app database. Empty when this provider has never loaded.
pub fn cached_account_usage(data_dir: &Path) -> Option<AccountUsage> {
    let conn = crate::appdb::open(data_dir).ok()?;
    let raw = crate::appdb::get_account_usage(&conn, account_usage_cache_key()).ok()??;
    serde_json::from_str(&raw).ok()
}

/// A confirmed sign-out replaces the snapshot. A failed read does not, so one bad
/// poll cannot hide an account that was connected a moment ago.
fn store_account_usage(data_dir: &Path, usage: &AccountUsage) {
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
pub fn dev_xai_account_usage_cached(state: tauri::State<'_, crate::state::AppState>) -> Option<AccountUsage> {
    cached_account_usage(&state.data_dir)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_xai_account_usage(state: tauri::State<'_, crate::state::AppState>) -> Result<AccountUsage, String> {
    let data_dir = state.data_dir.clone();
    let usage = account_usage().await;
    store_account_usage(&data_dir, &usage);
    Ok(usage)
}

fn json_f64(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|n| n as f64))
        .or_else(|| value.as_u64().map(|n| n as f64))
        .filter(|n| n.is_finite())
}

fn cent_val(value: &serde_json::Value) -> Option<i64> {
    let raw = value.get("val").unwrap_or(value);
    raw.as_i64()
        .or_else(|| raw.as_u64().and_then(|n| i64::try_from(n).ok()))
        .or_else(|| raw.as_f64().filter(|n| n.is_finite()).map(|n| n.round() as i64))
}

/// 0–100. A value strictly below 1 is a fraction. 1 and above are already a percent,
/// so a pool that is exactly 1% used is not turned into 100%.
fn usage_percent(value: &serde_json::Value) -> Option<f64> {
    let number = json_f64(value)?;
    if number < 0.0 {
        return None;
    }
    let scaled = if number > 0.0 && number < 1.0 { number * 100.0 } else { number };
    Some(scaled.min(100.0))
}

fn period_label(kind: &str) -> &'static str {
    let text = kind.trim().to_ascii_lowercase();
    if text.contains("week") {
        "Week"
    } else if text.contains("month") {
        "Month"
    } else if text.contains("day") {
        "Day"
    } else {
        "Week"
    }
}

fn period_end(config: &serde_json::Value) -> Option<String> {
    config
        .pointer("/currentPeriod/end")
        .or_else(|| config.get("billingPeriodEnd"))
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
}

/// Read the weekly pool from `GET /v1/billing?format=credits`.
/// `creditUsagePercent` is the shared allowance. Product rows are kept when that field is absent.
/// A prepaid balance is cents left. Unknown shapes return no windows instead of inventing a number.
pub fn parse_billing(body: &str) -> (Vec<AccountUsageWindow>, Option<i64>) {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return (Vec::new(), None);
    };
    let config = json.get("config").unwrap_or(&json);
    let mut windows = Vec::new();
    let kind = config
        .pointer("/currentPeriod/type")
        .and_then(|item| item.as_str())
        .unwrap_or("USAGE_PERIOD_TYPE_WEEKLY");
    let resets_at = period_end(config);
    if let Some(used) = config.get("creditUsagePercent").and_then(usage_percent) {
        windows.push(AccountUsageWindow {
            id: "credits".into(),
            label: period_label(kind).into(),
            used_percent: used,
            resets_at: resets_at.clone(),
        });
    } else if let Some(rows) = config.get("productUsage").and_then(|item| item.as_array()) {
        for row in rows {
            let Some(used) = row.get("usagePercent").and_then(usage_percent) else {
                continue;
            };
            let product = row.get("product").and_then(|item| item.as_str()).unwrap_or("pool");
            windows.push(AccountUsageWindow {
                id: product.to_string(),
                label: product_label(product).into(),
                used_percent: used,
                resets_at: resets_at.clone(),
            });
        }
    } else if let (Some(limit), Some(used)) = (
        config.get("monthlyLimit").and_then(cent_val).filter(|n| *n > 0),
        config.get("used").and_then(cent_val),
    ) {
        let percent = ((used as f64 / limit as f64) * 100.0).clamp(0.0, 100.0);
        windows.push(AccountUsageWindow {
            id: "monthly".into(),
            label: "Month".into(),
            used_percent: percent,
            resets_at,
        });
    }
    let balance = config.get("prepaidBalance").and_then(cent_val).filter(|n| *n >= 0);
    (windows, balance)
}

fn product_label(product: &str) -> String {
    let text = product.trim();
    let bare = text.strip_prefix("PRODUCT_").unwrap_or(text);
    let key = bare.replace('_', "").to_ascii_lowercase();
    if key == "grokbuild" || key == "build" {
        return "Build".into();
    }
    if key == "grokchat" || key == "chat" {
        return "Chat".into();
    }
    let name = bare.replace('_', " ");
    let mut out = String::new();
    for word in name.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            out.extend(first.to_uppercase());
            out.extend(chars.flat_map(|ch| ch.to_lowercase()));
        }
    }
    if out.is_empty() { "Week".into() } else { out }
}

/// Plan name from `GET /v1/settings`. Empty when the payload has none.
pub fn parse_subscription_tier(body: &str) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    for key in ["subscription_tier_display", "subscriptionTierDisplay", "subscription_tier", "subscriptionTier"] {
        if let Some(name) = json.get(key).and_then(|item| item.as_str()).map(str::trim).filter(|item| !item.is_empty()) {
            return Some(name.to_string());
        }
    }
    None
}

#[derive(Debug, Clone)]
struct CliLogin {
    key: String,
    email: String,
    refresh_token: String,
    /// Map key in `auth.json`, so a refresh writes back to the same login.
    slot: String,
}

fn best_cli_login(home: &Path) -> Option<CliLogin> {
    let src = fs::read_to_string(home.join("auth.json")).ok()?;
    let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&src).ok()?;
    let mut best: Option<(CliLogin, SystemTime)> = None;
    for (slot, value) in map {
        let Ok(entry) = serde_json::from_value::<AuthEntry>(value) else {
            continue;
        };
        if entry.key.trim().is_empty() && entry.refresh_token.trim().is_empty() {
            continue;
        }
        let stamp = parse_time(&entry.expires_at).unwrap_or(SystemTime::UNIX_EPOCH);
        let login = CliLogin {
            key: entry.key,
            email: entry.email,
            refresh_token: entry.refresh_token,
            slot,
        };
        if best.as_ref().map(|(_, at)| stamp > *at).unwrap_or(true) {
            best = Some((login, stamp));
        }
    }
    best.map(|(login, _)| login)
}

/// Renew the CLI access token when it is inside the refresh window, and write it back.
async fn refresh_cli_login(home: &Path) -> Option<String> {
    let login = best_cli_login(home)?;
    if login.key.trim().is_empty() && login.refresh_token.trim().is_empty() {
        return None;
    }
    let path = home.join("auth.json");
    let raw = fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let expires = value
        .get(&login.slot)
        .and_then(|item| item.get("expires_at"))
        .and_then(|item| item.as_str())
        .unwrap_or("");
    if !login.key.trim().is_empty() && !token_needs_refresh(expires) {
        return Some(login.key);
    }
    if login.refresh_token.trim().is_empty() {
        return (!login.key.trim().is_empty()).then_some(login.key);
    }
    let Some(fresh) = refresh_oauth(&login.refresh_token).await else {
        // A failed refresh a few minutes early is not a sign-out. The current token still works.
        return (!login.key.trim().is_empty() && !is_expired(expires)).then_some(login.key);
    };
    write_refreshed_login(&path, &login.slot, &fresh)?;
    Some(fresh.access_token)
}

fn token_needs_refresh(expires_at: &str) -> bool {
    let Some(at) = parse_time(expires_at.trim()) else {
        return false;
    };
    let Ok(left) = at.duration_since(SystemTime::now()) else {
        return true;
    };
    left <= std::time::Duration::from_secs(5 * 60)
}

struct RefreshedLogin {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<String>,
}

async fn refresh_oauth(refresh_token: &str) -> Option<RefreshedLogin> {
    let body = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", XAI_OAUTH_CLIENT_ID),
    ];
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .ok()?
        .post(XAI_OAUTH_TOKEN_URL)
        .header("content-type", "application/x-www-form-urlencoded")
        .header("accept", "application/json")
        .form(&body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let fresh: serde_json::Value = response.json().await.ok()?;
    let access_token = fresh
        .get("access_token")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())?
        .to_string();
    let refresh = fresh
        .get("refresh_token")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string);
    let expires_at = fresh.get("expires_in").and_then(|item| item.as_i64()).and_then(|secs| {
        if secs <= 0 {
            return None;
        }
        let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).ok()?.as_secs() as i64;
        let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(now.saturating_add(secs), 0)?;
        Some(dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    });
    Some(RefreshedLogin {
        access_token,
        refresh_token: refresh,
        expires_at,
    })
}

fn write_refreshed_login(path: &Path, slot: &str, fresh: &RefreshedLogin) -> Option<()> {
    let raw = fs::read_to_string(path).ok()?;
    let mut stored: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let entry = stored.get_mut(slot)?.as_object_mut()?;
    entry.insert("key".into(), serde_json::Value::String(fresh.access_token.clone()));
    if let Some(refresh) = &fresh.refresh_token {
        entry.insert("refresh_token".into(), serde_json::Value::String(refresh.clone()));
    }
    if let Some(expires) = &fresh.expires_at {
        entry.insert("expires_at".into(), serde_json::Value::String(expires.clone()));
    }
    let text = serde_json::to_string_pretty(&stored).ok()?;
    fs::write(path, text).ok()
}

enum BillingGet {
    Ok(String),
    Unauthorized,
    Failed,
}

async fn billing_get(client: &reqwest::Client, url: &str, token: &str) -> BillingGet {
    let headers = cli_proxy_headers(&cached_cli_version());
    let response = match client
        .get(url)
        .bearer_auth(token)
        .header("X-XAI-Token-Auth", headers.token_auth)
        .header("x-grok-client-version", headers.client_version)
        .header("x-grok-client-identifier", headers.client_identifier)
        .header(reqwest::header::USER_AGENT, headers.user_agent)
        .header("accept", "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return BillingGet::Failed,
    };
    let status = response.status().as_u16();
    if status == 401 || status == 403 {
        return BillingGet::Unauthorized;
    }
    if !response.status().is_success() {
        return BillingGet::Failed;
    }
    match response.text().await {
        Ok(body) => BillingGet::Ok(body),
        Err(_) => BillingGet::Failed,
    }
}

/// The signed-in Grok account's weekly pool. An API-key-only login has no session usage.
/// The CLI token is refreshed before the call when it is near expiry, and once more on 401.
pub async fn account_usage() -> AccountUsage {
    let Some(home) = grok_home() else {
        return empty_usage(false, "Grok");
    };
    let email = best_cli_login(&home).map(|login| login.email).filter(|email| email.contains('@'));
    let Some(token) = refresh_cli_login(&home).await else {
        return empty_usage(false, email.unwrap_or_else(|| "Grok".into()));
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut token = token;
    let body = match billing_get(&client, BILLING_URL, &token).await {
        BillingGet::Ok(body) => body,
        BillingGet::Unauthorized => {
            let Some(fresh) = refresh_cli_login(&home).await else {
                return empty_usage(false, email.unwrap_or_else(|| "Grok".into()));
            };
            if fresh == token {
                return empty_usage(false, email.clone().unwrap_or_else(|| "Grok".into()));
            }
            token = fresh;
            match billing_get(&client, BILLING_URL, &token).await {
                BillingGet::Ok(body) => body,
                BillingGet::Unauthorized => {
                    return empty_usage(false, email.unwrap_or_else(|| "Grok".into()));
                }
                BillingGet::Failed => return empty_usage(true, email.unwrap_or_else(|| "Grok".into())),
            }
        }
        BillingGet::Failed => return empty_usage(true, email.unwrap_or_else(|| "Grok".into())),
    };
    let (windows, balance) = parse_billing(&body);
    let tier = match billing_get(&client, SETTINGS_URL, &token).await {
        BillingGet::Ok(settings) => parse_subscription_tier(&settings),
        _ => None,
    };
    let label = tier
        .or(email)
        .filter(|item| !item.is_empty())
        .unwrap_or_else(|| "Grok".into());
    AccountUsage {
        provider: PROVIDER_XAI.into(),
        connected: true,
        label,
        windows,
        balance_cents: balance,
        balance_currency: balance.map(|_| "USD".into()),
        credit_status: None,
        fetched_at: Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn billing_reads_the_weekly_pool_and_a_prepaid_balance() {
        let body = r#"{
            "config": {
                "creditUsagePercent": 42.5,
                "currentPeriod": {
                    "type": "USAGE_PERIOD_TYPE_WEEKLY",
                    "start": "2026-06-01T00:00:00Z",
                    "end": "2026-06-08T00:00:00Z"
                },
                "onDemandCap": {"val": 5000},
                "onDemandUsed": {"val": 300},
                "prepaidBalance": {"val": 1250},
                "isUnifiedBillingUser": true,
                "productUsage": [
                    {"product": "PRODUCT_GROK_BUILD", "usagePercent": 61.2}
                ]
            }
        }"#;
        let (windows, balance) = parse_billing(body);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].id, "credits");
        assert_eq!(windows[0].label, "Week");
        assert!((windows[0].used_percent - 42.5).abs() < 0.01);
        assert_eq!(windows[0].resets_at.as_deref(), Some("2026-06-08T00:00:00Z"));
        assert_eq!(balance, Some(1250));
        let products = r#"{"config":{"productUsage":[{"product":"PRODUCT_GROK_BUILD","usagePercent":12},{"product":"GrokChat","usagePercent":0.18}],"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","end":"2026-06-08T00:00:00Z"}}}"#;
        let (rows, none) = parse_billing(products);
        assert_eq!(rows.iter().map(|row| row.label.as_str()).collect::<Vec<_>>(), ["Build", "Chat"]);
        assert!((rows[1].used_percent - 18.0).abs() < 0.01);
        assert_eq!(none, None);
        let monthly = r#"{"config":{"monthlyLimit":{"val":2000},"used":{"val":500},"billingPeriodEnd":"2026-07-01T00:00:00Z"}}"#;
        let (legacy, _) = parse_billing(monthly);
        assert_eq!(legacy[0].label, "Month");
        assert!((legacy[0].used_percent - 25.0).abs() < 0.01);
        assert!(parse_billing("nope").0.is_empty());
        assert_eq!(
            parse_subscription_tier(r#"{"subscription_tier_display":"SuperGrok"}"#).as_deref(),
            Some("SuperGrok")
        );
        assert_eq!(parse_subscription_tier("{}"), None);
    }
}
