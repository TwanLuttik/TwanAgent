use serde::{Deserialize, Serialize};

use super::PROVIDER_MINIMAX;
use super::auth::{REGIONS, resolve_minimax_auth_fresh};

/// One allowance window on the connected MiniMax account. `used_percent` is how much of the
/// window is spent, matching the Claude row. `mmx quota show` reports the remainder instead.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AccountUsageWindow {
    pub id: String,
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<String>,
}

/// Token-plan quota, or a pay-as-you-go balance when the login is an `sk-api-` key.
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

fn empty_usage(connected: bool) -> AccountUsage {
    AccountUsage {
        provider: PROVIDER_MINIMAX.into(),
        connected,
        label: "MiniMax".into(),
        windows: Vec::new(),
        balance_cents: None,
        balance_currency: None,
        credit_status: None,
        fetched_at: Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
    }
}

/// `{base}/v1/token_plan/remains`, the endpoint `mmx quota show` reads.
pub fn quota_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let base = if base.is_empty() { REGIONS[0].1 } else { base };
    format!("{base}/v1/token_plan/remains")
}

/// `{base}/account/query_balance`. Only an `sk-api-` key can read this.
pub fn balance_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let base = if base.is_empty() { REGIONS[0].1 } else { base };
    format!("{base}/account/query_balance")
}

pub fn is_secret_api_key(token: &str) -> bool {
    token.trim().starts_with("sk-api-")
}

fn json_f64(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|n| n as f64))
        .or_else(|| value.as_u64().map(|n| n as f64))
        .filter(|n| n.is_finite())
}

/// Percent still left in one quota window, 0–100. This is what `mmx quota show` prints as Left.
/// A remaining percent wins. Counts are the fallback. A model the plan does not include is `None`.
fn remaining_percent(usage: f64, total: f64, remaining_percent: Option<f64>, status: Option<i64>) -> Option<f64> {
    if status == Some(3) && remaining_percent.is_none() && total <= 0.0 {
        return None;
    }
    if let Some(left) = remaining_percent.filter(|n| n.is_finite() && *n >= 0.0 && *n <= 100.0) {
        return Some(left);
    }
    if total <= 0.0 || usage < 0.0 {
        return None;
    }
    Some((100.0 - (usage / total * 100.0)).clamp(0.0, 100.0))
}

fn window_label(span_ms: i64, weekly: bool) -> &'static str {
    if weekly || span_ms >= 6 * 24 * 3_600_000 {
        return "Week";
    }
    if span_ms >= 20 * 3_600_000 {
        return "Day";
    }
    // A token-plan window is five hours. The live end stamp is a few seconds short of that.
    if span_ms >= 4 * 3_600_000 {
        return "5h";
    }
    if span_ms > 0 {
        return "Now";
    }
    if weekly { "Week" } else { "Now" }
}

fn reset_from_ms(end_ms: i64) -> Option<String> {
    if end_ms <= 1_000_000_000_000 {
        return None;
    }
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(end_ms)?;
    Some(dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn quota_window(id: &str, label: &str, used: f64, end_ms: i64) -> AccountUsageWindow {
    AccountUsageWindow {
        id: id.into(),
        label: label.into(),
        used_percent: used,
        resets_at: reset_from_ms(end_ms),
    }
}

/// `model_remains` rows from `GET /v1/token_plan/remains`.
/// The current window (5h on a token plan) and the week are separate bars.
/// `used_percent` here is percent left, matching `mmx quota show`. A model the plan excludes is skipped.
pub fn parse_quota(body: &str) -> Vec<AccountUsageWindow> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let Some(rows) = json.get("model_remains").and_then(|value| value.as_array()) else {
        return Vec::new();
    };
    let only = rows.len() == 1;
    let mut windows = Vec::new();
    for row in rows {
        let name = row
            .get("model_name")
            .and_then(|item| item.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .unwrap_or("plan");
        let interval_total = json_f64(row.get("current_interval_total_count").unwrap_or(&serde_json::Value::Null)).unwrap_or(0.0);
        let weekly_total = json_f64(row.get("current_weekly_total_count").unwrap_or(&serde_json::Value::Null)).unwrap_or(0.0);
        let interval_status = row.get("current_interval_status").and_then(|item| item.as_i64());
        let weekly_status = row.get("current_weekly_status").and_then(|item| item.as_i64());
        if interval_status == Some(3) && weekly_status == Some(3) && interval_total <= 0.0 && weekly_total <= 0.0 {
            continue;
        }
        let start = row.get("start_time").and_then(|item| item.as_i64()).unwrap_or(0);
        let end = row.get("end_time").and_then(|item| item.as_i64()).unwrap_or(0);
        let span = end.saturating_sub(start);
        let current_label = window_label(span, false);
        // One plan row is the account, so the bar says 5h instead of "general 5h".
        let label_name = if only { "" } else { name };
        if let Some(left) = remaining_percent(
            json_f64(row.get("current_interval_usage_count").unwrap_or(&serde_json::Value::Null)).unwrap_or(0.0),
            interval_total,
            row.get("current_interval_remaining_percent").and_then(json_f64),
            interval_status,
        ) {
            let label = if label_name.is_empty() {
                current_label.to_string()
            } else {
                format!("{label_name} {current_label}")
            };
            windows.push(quota_window(&format!("{name}:current"), &label, left, end));
        }
        let week_end = row.get("weekly_end_time").and_then(|item| item.as_i64()).unwrap_or(0);
        if let Some(left) = remaining_percent(
            json_f64(row.get("current_weekly_usage_count").unwrap_or(&serde_json::Value::Null)).unwrap_or(0.0),
            weekly_total,
            row.get("current_weekly_remaining_percent").and_then(json_f64),
            weekly_status,
        ) {
            let label = if label_name.is_empty() {
                "Week".to_string()
            } else {
                format!("{label_name} Week")
            };
            windows.push(quota_window(&format!("{name}:week"), &label, left, week_end));
        }
    }
    windows
}

/// `available_amount` on a pay-as-you-go login, in cents. A missing amount is not zero.
pub fn parse_balance(body: &str) -> Option<(i64, String)> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    let raw = json.get("available_amount")?.as_str().unwrap_or("").trim();
    if raw.is_empty() {
        return None;
    }
    let amount: f64 = raw.parse().ok()?;
    if !amount.is_finite() || amount < 0.0 {
        return None;
    }
    Some(((amount * 100.0).round() as i64, "USD".into()))
}

fn account_usage_cache_key() -> &'static str {
    PROVIDER_MINIMAX
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
pub fn dev_minimax_account_usage_cached(state: tauri::State<'_, crate::state::AppState>) -> Option<AccountUsage> {
    cached_account_usage(&state.data_dir)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_minimax_account_usage(state: tauri::State<'_, crate::state::AppState>) -> Result<AccountUsage, String> {
    let data_dir = state.data_dir.clone();
    let usage = account_usage().await;
    store_account_usage(&data_dir, &usage);
    Ok(usage)
}

/// The connected MiniMax account. A token-plan login reports quota windows.
/// An `sk-api-` key reports the cash balance instead, unless it is also on a
/// plan — in that case the quota endpoint reports windows and they win, the
/// same way Claude's session usage shadows a prepaid balance. Both endpoints
/// accept `Bearer` and `x-api-key`, so the same code path covers either login.
pub async fn account_usage() -> AccountUsage {
    let Some(auth) = resolve_minimax_auth_fresh().await else {
        return empty_usage(false);
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut usage = empty_usage(true);
    if let Some(body) = minimax_get(&client, &quota_url(&auth.base_url), &auth.token).await {
        usage.windows = parse_quota(&body);
    }
    if is_secret_api_key(&auth.token) {
        if let Some((cents, currency)) = minimax_get(&client, &balance_url(&auth.base_url), &auth.token)
            .await
            .as_deref()
            .and_then(parse_balance)
        {
            usage.balance_cents = Some(cents);
            usage.balance_currency = Some(currency);
        }
    }
    usage
}

/// Quota accepts the `mmx` login as a bearer token. An API key is sent as `x-api-key`.
/// MiniMax answers login failures with HTTP 200 and `base_resp.status_code`, so both are tried.
async fn minimax_get(client: &reqwest::Client, url: &str, token: &str) -> Option<String> {
    let bearer = format!("Bearer {token}");
    let attempts = [("authorization", bearer.as_str()), ("x-api-key", token)];
    for (header, value) in attempts {
        let response = client
            .get(url)
            .header(header, value)
            .header("accept", "application/json")
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            continue;
        }
        let body = response.text().await.ok()?;
        if quota_body_ok(&body) {
            return Some(body);
        }
    }
    None
}

fn quota_body_ok(body: &str) -> bool {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    match json
        .get("base_resp")
        .and_then(|item| item.get("status_code"))
        .and_then(|item| item.as_i64())
    {
        Some(code) => code == 0,
        None => json.get("model_remains").is_some() || json.get("available_amount").is_some(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quota_turns_remaining_counts_into_used_windows() {
        let body = r#"{
            "model_remains": [
                {
                    "model_name": "MiniMax-M3",
                    "start_time": 1780000000000,
                    "end_time": 1780018000000,
                    "current_interval_total_count": 1000,
                    "current_interval_usage_count": 250,
                    "current_interval_remaining_percent": 75,
                    "current_weekly_total_count": 5000,
                    "current_weekly_usage_count": 1000,
                    "weekly_end_time": 1780604800000
                },
                {
                    "model_name": "video",
                    "current_interval_total_count": 0,
                    "current_weekly_total_count": 0,
                    "current_interval_status": 3,
                    "current_weekly_status": 3
                }
            ]
        }"#;
        let windows = parse_quota(body);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].id, "MiniMax-M3:current");
        assert_eq!(windows[0].label, "MiniMax-M3 5h");
        assert!((windows[0].used_percent - 75.0).abs() < 0.01);
        assert!(windows[0].resets_at.is_some());
        assert_eq!(windows[1].label, "MiniMax-M3 Week");
        assert!((windows[1].used_percent - 80.0).abs() < 0.01);
        let general = r#"{"base_resp":{"status_code":0},"model_remains":[{"model_name":"general","start_time":1791695116008,"end_time":1791713116008,"current_interval_total_count":0,"current_interval_usage_count":0,"current_interval_remaining_percent":99,"current_interval_status":1,"current_weekly_total_count":0,"current_weekly_usage_count":0,"current_weekly_remaining_percent":99,"current_weekly_status":1,"weekly_end_time":1792263899676}]}"#;
        let live = parse_quota(general);
        assert_eq!(live.iter().map(|row| row.label.as_str()).collect::<Vec<_>>(), ["5h", "Week"]);
        assert!((live[0].used_percent - 99.0).abs() < 0.01);
        assert!((live[1].used_percent - 99.0).abs() < 0.01);
        assert!(!quota_body_ok(r#"{"base_resp":{"status_code":1004,"status_msg":"login fail"}}"#));
        assert!(quota_body_ok(general));
        assert!(parse_quota("nope").is_empty());
        assert!(parse_quota(r#"{"model_remains":[]}"#).is_empty());
        assert_eq!(
            parse_balance(r#"{"available_amount":"12.50","cash_balance":"12.50"}"#),
            Some((1250, "USD".into()))
        );
        assert_eq!(parse_balance(r#"{"cash_balance":"1"}"#), None);
        assert!(is_secret_api_key("sk-api-secret"));
        assert!(!is_secret_api_key("oat-token"));
        assert_eq!(
            quota_url("https://api.minimax.io"),
            "https://api.minimax.io/v1/token_plan/remains"
        );
    }

    #[test]
    fn quota_and_balance_combine_for_an_api_key_on_a_plan() {
        // Quota endpoint returns windows for an `sk-api-` key too. The frontend
        // shows bars when windows exist, falling back to the balance only when
        // the plan endpoint has nothing to say.
        let quota_body = r#"{"base_resp":{"status_code":0},"model_remains":[{"model_name":"general","start_time":1791695116008,"end_time":1791713116008,"current_interval_total_count":0,"current_interval_usage_count":0,"current_interval_remaining_percent":62,"current_interval_status":1,"current_weekly_total_count":0,"current_weekly_usage_count":0,"current_weekly_remaining_percent":41,"current_weekly_status":1,"weekly_end_time":1792263899676}]}"#;
        let quota = parse_quota(quota_body);
        assert_eq!(quota.len(), 2);
        assert!((quota[0].used_percent - 62.0).abs() < 0.01);
        assert!((quota[1].used_percent - 41.0).abs() < 0.01);
        let balance_body = r#"{"available_amount":"24.96","cash_balance":"24.96"}"#;
        assert_eq!(parse_balance(balance_body), Some((2496, "USD".into())));
        // A pay-as-you-go key without a plan keeps the dollar amount.
        assert!(parse_quota(r#"{"model_remains":[]}"#).is_empty());
        assert_eq!(parse_balance(balance_body), Some((2496, "USD".into())));
    }
}
