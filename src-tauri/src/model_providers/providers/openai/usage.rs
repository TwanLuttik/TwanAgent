//! OpenAI account allowance. A project key can read prepaid credits, the monthly
//! spend cap, and the token window left on the last reply. An admin-only costs
//! call fills the month bar when the key is allowed to see it.

use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, Datelike, TimeZone, Utc};
use serde::{Deserialize, Serialize};

use super::PROVIDER_OPENAI;

pub const CREDIT_GRANTS_URL: &str = "https://api.openai.com/v1/dashboard/billing/credit_grants";
pub const SUBSCRIPTION_URL: &str = "https://api.openai.com/v1/dashboard/billing/subscription";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AccountUsageWindow {
    pub id: String,
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<String>,
}

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
}

fn now_stamp() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn empty_usage(connected: bool) -> AccountUsage {
    AccountUsage {
        provider: PROVIDER_OPENAI.into(),
        connected,
        label: "GPT".into(),
        windows: Vec::new(),
        balance_cents: None,
        balance_currency: None,
        credit_status: None,
        fetched_at: Some(now_stamp()),
    }
}

fn rate_slot() -> &'static Mutex<Option<AccountUsageWindow>> {
    static RATE: OnceLock<Mutex<Option<AccountUsageWindow>>> = OnceLock::new();
    RATE.get_or_init(|| Mutex::new(None))
}

fn json_f64(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|n| n as f64))
        .or_else(|| value.as_u64().map(|n| n as f64))
        .or_else(|| value.as_str().and_then(|text| text.trim().parse::<f64>().ok()))
        .filter(|n| n.is_finite())
}

fn dollars(value: &serde_json::Value) -> Option<f64> {
    json_f64(value).or_else(|| value.get("value").and_then(json_f64))
}

/// `6m0s`, `1.5s`, `1d2h` → seconds. A bare number is already seconds.
pub fn reset_seconds(text: &str) -> Option<i64> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(n) = text.parse::<f64>() {
        if !n.is_finite() || n < 0.0 || n > 1_000_000_000.0 {
            return None;
        }
        return Some(n.round() as i64);
    }
    let mut total = 0.0;
    let mut num = String::new();
    let mut saw = false;
    for ch in text.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            num.push(ch);
            continue;
        }
        let value = num.parse::<f64>().ok()?;
        num.clear();
        let unit = match ch {
            'd' => 86_400.0,
            'h' => 3_600.0,
            'm' => 60.0,
            's' => 1.0,
            _ => return None,
        };
        total += value * unit;
        saw = true;
    }
    if !num.is_empty() || !saw {
        return None;
    }
    Some(total.round() as i64)
}

/// Token window left on the last OpenAI reply. `used_percent` is how much of the limit is spent.
pub fn rate_window(limit: f64, remaining: f64, reset_secs: i64, now: DateTime<Utc>) -> Option<AccountUsageWindow> {
    if !limit.is_finite() || limit <= 0.0 || !remaining.is_finite() || remaining < 0.0 {
        return None;
    }
    let used = ((limit - remaining.max(0.0)) / limit * 100.0).clamp(0.0, 100.0);
    let resets_at = if reset_secs > 0 {
        Some((now + chrono::Duration::seconds(reset_secs)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    } else {
        None
    };
    Some(AccountUsageWindow {
        id: "tokens".into(),
        label: "Tokens".into(),
        used_percent: used,
        resets_at,
    })
}

/// Remember the token window from response headers. A later allowance poll includes it.
pub fn remember_rate_headers(headers: &reqwest::header::HeaderMap) {
    let limit = header_f64(headers, "x-ratelimit-limit-tokens");
    let remaining = header_f64(headers, "x-ratelimit-remaining-tokens");
    let (Some(limit), Some(remaining)) = (limit, remaining) else {
        return;
    };
    let reset = headers
        .get("x-ratelimit-reset-tokens")
        .and_then(|value| value.to_str().ok())
        .and_then(reset_seconds)
        .unwrap_or(0);
    let Some(window) = rate_window(limit, remaining, reset, Utc::now()) else {
        return;
    };
    if let Ok(mut slot) = rate_slot().lock() {
        *slot = Some(window);
    }
}

fn header_f64(headers: &reqwest::header::HeaderMap, name: &str) -> Option<f64> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite())
}

fn cached_rate() -> Option<AccountUsageWindow> {
    rate_slot().lock().ok().and_then(|slot| slot.clone())
}

/// Remaining prepaid dollars, in cents. Absent when the body is not a credit summary.
pub fn parse_credit_grants(body: &str) -> Option<i64> {
    let json = serde_json::from_str::<serde_json::Value>(body).ok()?;
    let available = json.get("total_available").and_then(dollars)?;
    if available < 0.0 {
        return None;
    }
    Some((available * 100.0).round() as i64)
}

/// Monthly hard spend cap in dollars. Absent when this login cannot see a cap.
pub fn parse_hard_limit_usd(body: &str) -> Option<f64> {
    let json = serde_json::from_str::<serde_json::Value>(body).ok()?;
    let hard = json
        .get("hard_limit_usd")
        .and_then(dollars)
        .filter(|n| *n > 0.0);
    let system = json
        .get("system_hard_limit_usd")
        .and_then(dollars)
        .filter(|n| *n > 0.0);
    hard.or(system)
}

pub fn subscription_has_payment(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|json| json.get("has_payment_method").and_then(|item| item.as_bool()))
        .unwrap_or(false)
}

/// Dollars spent across every cost bucket. An empty page is zero, not a failure.
pub fn parse_costs_usd(body: &str) -> Option<f64> {
    let json = serde_json::from_str::<serde_json::Value>(body).ok()?;
    let buckets = json.get("data").and_then(|item| item.as_array())?;
    let mut total = 0.0;
    for bucket in buckets {
        let Some(results) = bucket.get("results").and_then(|item| item.as_array()) else {
            continue;
        };
        for row in results {
            let Some(amount) = row.get("amount").and_then(dollars) else {
                continue;
            };
            if amount > 0.0 {
                total += amount;
            }
        }
    }
    Some(total)
}

pub fn costs_url(start_unix: i64) -> String {
    format!("https://api.openai.com/v1/organization/costs?start_time={start_unix}&bucket_width=1d&limit=31")
}

fn month_start(now: DateTime<Utc>) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
        .single()
        .unwrap_or(now)
}

fn next_month_start(now: DateTime<Utc>) -> DateTime<Utc> {
    let (year, month) = if now.month() == 12 {
        (now.year() + 1, 1)
    } else {
        (now.year(), now.month() + 1)
    };
    Utc.with_ymd_and_hms(year, month, 1, 0, 0, 0)
        .single()
        .unwrap_or(now)
}

/// Month bar when both the spend and the cap are known. The reset is the next month.
pub fn month_window(spent_usd: f64, limit_usd: f64, now: DateTime<Utc>) -> Option<AccountUsageWindow> {
    if !spent_usd.is_finite() || spent_usd < 0.0 || !limit_usd.is_finite() || limit_usd <= 0.0 {
        return None;
    }
    Some(AccountUsageWindow {
        id: "month".into(),
        label: "Month".into(),
        used_percent: (spent_usd / limit_usd * 100.0).clamp(0.0, 100.0),
        resets_at: Some(next_month_start(now).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
    })
}

/// One snapshot from the billing bodies we could read. The caller decides `connected`.
pub fn usage_from_bodies(
    grants: Option<&str>,
    subscription: Option<&str>,
    costs: Option<&str>,
    rate: Option<AccountUsageWindow>,
    now: DateTime<Utc>,
) -> AccountUsage {
    let mut usage = empty_usage(true);
    usage.fetched_at = Some(now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    if let Some(cents) = grants.and_then(parse_credit_grants) {
        usage.balance_cents = Some(cents);
        usage.balance_currency = Some("USD".into());
        if cents == 0 {
            usage.credit_status = Some("exhausted".into());
        }
    }
    let spent = costs.and_then(parse_costs_usd);
    let limit = subscription.and_then(parse_hard_limit_usd);
    if let (Some(spent), Some(limit)) = (spent, limit) {
        if let Some(window) = month_window(spent, limit, now) {
            usage.windows.push(window);
        }
    }
    if let Some(window) = rate {
        usage.windows.push(window);
    }
    if usage.balance_cents.is_none()
        && usage.windows.is_empty()
        && subscription.is_some_and(subscription_has_payment)
    {
        usage.credit_status = Some("available".into());
    }
    usage
}

fn account_usage_cache_key() -> &'static str {
    PROVIDER_OPENAI
}

pub fn cached_account_usage(data_dir: &std::path::Path) -> Option<AccountUsage> {
    let conn = crate::appdb::open(data_dir).ok()?;
    let raw = crate::appdb::get_account_usage(&conn, account_usage_cache_key()).ok()??;
    serde_json::from_str(&raw).ok()
}

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
pub fn dev_openai_account_usage_cached(
    state: tauri::State<'_, crate::state::AppState>,
) -> Option<AccountUsage> {
    cached_account_usage(&state.data_dir)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_openai_account_usage(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<AccountUsage, String> {
    let data_dir = state.data_dir.clone();
    let token = super::resolve_openai_auth(&data_dir);
    let usage = account_usage(token.as_deref()).await;
    store_account_usage(&data_dir, &usage);
    Ok(usage)
}

/// Credits left, the monthly cap, and the token window from the last reply.
/// No key means the account is not connected.
pub async fn account_usage(token: Option<&str>) -> AccountUsage {
    let Some(token) = token.map(str::trim).filter(|token| !token.is_empty()) else {
        return empty_usage(false);
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let now = Utc::now();
    let grants = openai_get(&client, CREDIT_GRANTS_URL, token).await;
    let subscription = openai_get(&client, SUBSCRIPTION_URL, token).await;
    let costs = openai_get(&client, &costs_url(month_start(now).timestamp()), token).await;
    let mut usage = usage_from_bodies(
        grants.as_deref(),
        subscription.as_deref(),
        costs.as_deref(),
        cached_rate(),
        now,
    );
    usage.connected = true;
    usage
}

async fn openai_get(client: &reqwest::Client, url: &str, token: &str) -> Option<String> {
    let response = client
        .get(url)
        .bearer_auth(token)
        .header("accept", "application/json")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.text().await.ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-07-20T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn reset_durations_become_seconds() {
        assert_eq!(reset_seconds("6m0s"), Some(360));
        assert_eq!(reset_seconds("1.5s"), Some(2));
        assert_eq!(reset_seconds("1d2h"), Some(93_600));
        assert_eq!(reset_seconds("12"), Some(12));
        assert_eq!(reset_seconds(""), None);
    }

    #[test]
    fn credit_grants_become_cents_left() {
        let body = r#"{"object":"credit_summary","total_granted":18,"total_used":1.5,"total_available":16.5}"#;
        assert_eq!(parse_credit_grants(body), Some(1650));
        assert_eq!(parse_credit_grants("{}"), None);
    }

    #[test]
    fn costs_and_the_hard_cap_make_a_month_bar() {
        let costs = r#"{"data":[{"results":[{"amount":{"value":25,"currency":"usd"}},{"amount":{"value":"5.5","currency":"usd"}}]}]}"#;
        let subscription = r#"{"hard_limit_usd":100,"has_payment_method":true}"#;
        assert_eq!(parse_costs_usd(costs), Some(30.5));
        assert_eq!(parse_hard_limit_usd(subscription), Some(100.0));
        let usage = usage_from_bodies(None, Some(subscription), Some(costs), None, at());
        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.windows[0].label, "Month");
        assert!((usage.windows[0].used_percent - 30.5).abs() < 0.01);
        assert!(usage.windows[0].resets_at.as_deref().unwrap().starts_with("2026-08-01"));
    }

    #[test]
    fn a_token_window_is_percent_spent() {
        let window = rate_window(1_000_000.0, 250_000.0, 360, at()).unwrap();
        assert_eq!(window.label, "Tokens");
        assert!((window.used_percent - 75.0).abs() < 0.01);
        assert!(window.resets_at.is_some());
        assert!(rate_window(0.0, 0.0, 0, at()).is_none());
    }

    #[test]
    fn a_paid_login_with_no_numbers_still_says_credits_are_available() {
        let usage = usage_from_bodies(None, Some(r#"{"has_payment_method":true}"#), None, None, at());
        assert_eq!(usage.credit_status.as_deref(), Some("available"));
        assert!(usage.windows.is_empty());
    }
}
