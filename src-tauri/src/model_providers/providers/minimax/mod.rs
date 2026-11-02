//! MiniMax text chat. The official CLI is `mmx` (`mmx-cli`).
//!
//! Text goes to the Anthropic-shaped Messages API at `{base}/anthropic/v1/messages`,
//! with the token in `x-api-key`. That is the same wire format Claude uses, so the
//! body and SSE parser stay in `anthropic`. This module owns the model ids, the
//! `mmx` binary, and `~/.mmx/config.json`.

use crate::grok_cli::{effort_label, DevEffort, DevModel};

mod auth;
mod usage;

pub use auth::{
    forget_mmx_version, minimax_cli_info, mmx_bin, mmx_home, mmx_version, resolve_minimax_auth_fresh,
    resolve_minimax_auth_fresh_in, MinimaxAuth, MinimaxCliInfo,
};
pub use usage::{
    account_usage, balance_url, cached_account_usage, dev_minimax_account_usage,
    dev_minimax_account_usage_cached, is_secret_api_key, parse_balance, parse_quota, quota_url,
    AccountUsage, AccountUsageWindow, __cmd__dev_minimax_account_usage,
    __cmd__dev_minimax_account_usage_cached, __tauri_command_name_dev_minimax_account_usage,
    __tauri_command_name_dev_minimax_account_usage_cached,
};

pub const PROVIDER_MINIMAX: &str = "minimax";
pub const DEFAULT_MODEL: &str = "MiniMax-M3";
pub const SIGN_IN_ERROR: &str =
    "MiniMax isn’t signed in. Run mmx auth login, or add a MiniMax API key in Settings.";
pub const KEY_REJECTED: &str = twanagent_service::minimax::KEY_REJECTED;

/// Text models `mmx text chat` and the MiniMax coding config both offer.
/// Context and output caps follow the coding catalog. Vision is only on M3.
const MINIMAX_MODELS: &[(&str, &str, u64, u32, bool, &[&str])] = &[
    (
        "MiniMax-M3",
        "MiniMax M3",
        512_000,
        128_000,
        true,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "MiniMax-M3.1-Flash-Preview",
        "MiniMax M3.1 Flash",
        512_000,
        128_000,
        true,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "MiniMax-M2.7",
        "MiniMax M2.7",
        200_000,
        128_000,
        false,
        &["low", "medium", "high"],
    ),
    (
        "MiniMax-M2.7-highspeed",
        "MiniMax M2.7 Highspeed",
        200_000,
        128_000,
        false,
        &["low", "medium", "high"],
    ),
];

pub fn minimax_models() -> Vec<DevModel> {
    MINIMAX_MODELS
        .iter()
        .map(|(id, name, window, _max_tokens, vision, efforts)| DevModel {
            id: (*id).into(),
            name: (*name).into(),
            efforts: efforts
                .iter()
                .map(|id| DevEffort {
                    id: (*id).into(),
                    label: effort_label(id),
                })
                .collect(),
            context_window: Some(*window),
            context_windows: context_windows_for(id),
            provider: PROVIDER_MINIMAX.into(),
            capabilities: capabilities_for(*vision),
        })
        .collect()
}

fn context_windows_for(id: &str) -> Vec<u64> {
    if id.starts_with("MiniMax-M3") {
        vec![512_000, 1_000_000]
    } else {
        Vec::new()
    }
}

fn capabilities_for(vision: bool) -> Vec<String> {
    let mut caps = vec!["thinking".into(), "effort".into()];
    if vision {
        caps.insert(0, "vision".into());
    }
    caps
}

pub fn minimax_model(id: &str) -> Option<&'static (&'static str, &'static str, u64, u32, bool, &'static [&'static str])> {
    let id = id.trim();
    MINIMAX_MODELS.iter().find(|(row_id, ..)| *row_id == id)
}

/// A MiniMax text model. The prefix is case-sensitive, matching the API ids.
pub fn is_minimax_model(id: &str) -> bool {
    twanagent_service::minimax::is_minimax_model(id)
}

pub fn max_tokens_for(id: &str) -> u32 {
    let id = id.trim();
    if let Some(row) = minimax_model(id) {
        return row.3;
    }
    if is_minimax_model(id) {
        128_000
    } else {
        4_096
    }
}

pub fn context_window_for(id: &str) -> Option<u64> {
    minimax_model(id.trim()).map(|row| row.2)
}

/// `{base}/anthropic/v1/messages`. Empty base uses the global host.
pub fn messages_url(base_url: &str) -> String {
    twanagent_service::minimax::messages_url(base_url)
}

pub fn http_error_message(status: u16, body: &str) -> String {
    twanagent_service::minimax::http_error_message(status, body)
}

/// OpenAI-shaped messages become the Messages body `mmx text chat` sends.
/// Plan tools are omitted. Effort is not an Anthropic output_config field here.
pub fn to_minimax_body(
    messages: &serde_json::Value,
    model: &str,
    tools: &serde_json::Value,
) -> serde_json::Value {
    twanagent_service::minimax::to_minimax_body(messages, model, tools, max_tokens_for(model))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_lists_the_text_models() {
        let rows = minimax_models();
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            [
                "MiniMax-M3",
                "MiniMax-M3.1-Flash-Preview",
                "MiniMax-M2.7",
                "MiniMax-M2.7-highspeed",
            ]
        );
        assert!(rows.iter().all(|row| row.provider == PROVIDER_MINIMAX));
        assert_eq!(rows[0].context_window, Some(512_000));
        assert_eq!(rows[0].context_windows, vec![512_000, 1_000_000]);
        assert!(rows[0].capabilities.iter().any(|cap| cap == "vision"));
        assert!(!rows[2].capabilities.iter().any(|cap| cap == "vision"));
        assert!(rows[2].context_windows.is_empty());
        assert_eq!(rows[2].context_window, Some(200_000));
    }

    #[test]
    fn matcher_claims_minimax_ids_only() {
        assert!(is_minimax_model("MiniMax-M3"));
        assert!(is_minimax_model(" MiniMax-M2.7 "));
        assert!(is_minimax_model("MiniMax-M3.1-Flash-Preview"));
        assert!(is_minimax_model("MiniMax-Future-1"));
        assert!(!is_minimax_model("minimax-m3"));
        assert!(!is_minimax_model("claude-sonnet-4-6"));
        assert!(!is_minimax_model("grok-4.6"));
        assert!(!is_minimax_model(""));
        assert!(!is_minimax_model("MiniMax-"));
    }

    #[test]
    fn messages_url_uses_the_saved_base() {
        assert_eq!(
            messages_url("https://api.minimax.io"),
            "https://api.minimax.io/anthropic/v1/messages"
        );
        assert_eq!(
            messages_url("https://api.minimax.cn/"),
            "https://api.minimax.cn/anthropic/v1/messages"
        );
        assert_eq!(
            messages_url(""),
            "https://api.minimax.io/anthropic/v1/messages"
        );
        assert_ne!(
            messages_url("https://api.minimax.io"),
            crate::grok_cli::endpoint(false)
        );
        assert_ne!(
            messages_url("https://api.minimax.io"),
            crate::anthropic::MESSAGES_URL
        );
    }

    #[test]
    fn body_is_messages_shaped_and_drops_plan_tools() {
        let tools = crate::dev::chat::tools_json_for(false, false);
        let body = to_minimax_body(
            &serde_json::json!([
                { "role": "system", "content": "You are MiniMax." },
                { "role": "user", "content": "hi" }
            ]),
            "MiniMax-M3",
            &tools,
        );
        assert_eq!(body["model"], "MiniMax-M3");
        assert_eq!(body["max_tokens"], 128_000);
        assert_eq!(body["stream"], true);
        assert_eq!(body["system"], "You are MiniMax.");
        assert!(body.get("output_config").is_none());
        assert_eq!(body["thinking"]["type"], "adaptive");
        let names: Vec<_> = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|row| row["name"].as_str())
            .collect();
        assert!(names.contains(&"read_file"));
        assert!(names.contains(&"grep"));
        assert!(names.contains(&"glob"));
        assert!(!names.iter().any(|name| name.contains("plan")));
        assert_eq!(max_tokens_for("MiniMax-M2.7"), 128_000);
        assert_eq!(context_window_for("MiniMax-M2.7"), Some(200_000));
    }

    #[test]
    fn key_error_does_not_mention_xai() {
        assert_eq!(http_error_message(401, "nope"), KEY_REJECTED);
        let other = http_error_message(400, "bad model");
        assert!(other.starts_with("MiniMax error 400:"));
        assert!(SIGN_IN_ERROR.contains("mmx auth login"));
    }
}
