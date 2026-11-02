use serde::Serialize;

use crate::grok_cli::{effort_label, DevEffort, DevModel};
use crate::model_providers::event::{
    apply_thinking, apply_tool, finished_thinking as shared_finished_thinking, finished_tools as shared_finished_tools,
    merge_usage as merge_stream_usage, ThinkingBlock, StreamPiece,
};

mod auth;
mod cli;
mod usage;

pub use auth::{
    refresh_claude_cli_login, read_claude_access_token, read_claude_account, read_cli_access_token,
    read_cli_access_token_fresh, resolve_claude_auth, resolve_claude_auth_fresh,
    resolve_claude_auth_fresh_in, ClaudeAuth, CLAUDE_OAUTH_CLIENT_ID, CLAUDE_OAUTH_TOKEN_URL,
    CLAUDE_PROFILE_CLIENT_ID,
};
pub use cli::{claude_bin, claude_cli_info, claude_version, forget_claude_version, ClaudeCliInfo};
pub use usage::{
    account_usage, cached_account_usage, dev_account_usage, dev_account_usage_cached, parse_account_usage,
    parse_api_org, parse_prepaid_balance, AccountUsage, AccountUsageWindow, CLAUDE_ACCOUNT_URL, CLAUDE_USAGE_URL,
    __cmd__dev_account_usage, __cmd__dev_account_usage_cached, __tauri_command_name_dev_account_usage,
    __tauri_command_name_dev_account_usage_cached,
};

pub const PROVIDER_ANTHROPIC: &str = "anthropic";

/// One picker row per Claude family. Current lineup first, then the previous
/// generation, so a short models-API page cannot hide the rest.
/// Context windows and output caps follow Anthropic's model overview.
const CLAUDE_MODELS: &[(&str, &str, u64, u32, &[&str])] = &[
    (
        "claude-fable-5-1",
        "Claude Fable 5.1",
        1_000_000,
        128_000,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "claude-opus-5-5",
        "Claude Opus 5.5",
        1_000_000,
        128_000,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "claude-sonnet-5-5",
        "Claude Sonnet 5.5",
        1_000_000,
        128_000,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "claude-haiku-5-5",
        "Claude Haiku 5.5",
        1_000_000,
        128_000,
        &["low", "medium", "high"],
    ),
    (
        "claude-opus-4-8",
        "Claude Opus 4.8",
        1_000_000,
        128_000,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "claude-opus-4-7",
        "Claude Opus 4.7",
        1_000_000,
        128_000,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "claude-opus-4-6",
        "Claude Opus 4.6",
        1_000_000,
        128_000,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "claude-sonnet-4-6",
        "Claude Sonnet 4.6",
        1_000_000,
        64_000,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "claude-sonnet-4-5",
        "Claude Sonnet 4.5",
        200_000,
        64_000,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "claude-haiku-4-5",
        "Claude Haiku 4.5",
        200_000,
        64_000,
        &["low", "medium", "high"],
    ),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Xai,
    Anthropic,
}

fn efforts_for(ids: &[&str]) -> Vec<DevEffort> {
    ids.iter()
        .map(|id| DevEffort {
            id: (*id).into(),
            label: effort_label(id),
        })
        .collect()
}

pub fn claude_models() -> Vec<DevModel> {
    CLAUDE_MODELS
        .iter()
        .map(|(id, name, window, _max_tokens, efforts)| DevModel {
            id: (*id).into(),
            name: (*name).into(),
            efforts: efforts_for(efforts),
            context_window: Some(*window),
            context_windows: Vec::new(),
            provider: PROVIDER_ANTHROPIC.into(),
            capabilities: bundled_capabilities(id),
        })
        .collect()
}

pub fn claude_model(id: &str) -> Option<&'static (&'static str, &'static str, u64, u32, &'static [&'static str])> {
    let id = id.trim();
    CLAUDE_MODELS.iter().find(|(row_id, ..)| *row_id == id)
}

/// A chat model id from Anthropic. Dated snapshots (`claude-sonnet-4-5-20250929`) count.
pub fn is_claude_model(id: &str) -> bool {
    twanagent_service::anthropic::is_claude_model(id)
}

pub fn provider_for(id: &str) -> Provider {
    if is_claude_model(id) {
        Provider::Anthropic
    } else {
        Provider::Xai
    }
}

/// Output cap for the Messages API. Not the context window.
pub fn max_tokens_for(id: &str) -> u32 {
    twanagent_service::anthropic::max_tokens_for(id)
}

/// Opus and Sonnet use adaptive thinking. Haiku keeps a fixed budget.
pub fn supports_adaptive_thinking(id: &str) -> bool {
    twanagent_service::anthropic::supports_adaptive_thinking(id)
}

/// Manual thinking budget for a model that cannot use adaptive thinking.
/// Must stay below the output cap. `None` means send no thinking field.
pub fn manual_thinking_budget(id: &str, effort: Option<&str>) -> Option<u32> {
    twanagent_service::anthropic::manual_thinking_budget(id, effort)
}

/// Turn one page of `GET /v1/models` into picker rows.
/// Retired models and non-Claude ids are dropped. A known catalog row supplies thinking
/// levels when the same id is listed; anything else gets the line default.
pub fn parse_models_page(body: &str) -> (Vec<DevModel>, Option<String>, bool) {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return (Vec::new(), None, false);
    };
    let Some(rows) = json.get("data").and_then(|value| value.as_array()) else {
        return (Vec::new(), None, false);
    };
    let mut models = Vec::new();
    for row in rows {
        if row.get("type").and_then(|value| value.as_str()) == Some("model")
            && row.get("lifecycle").and_then(|value| value.as_str()) == Some("retired")
        {
            continue;
        }
        let Some(id) = row.get("id").and_then(|value| value.as_str()).map(str::trim) else {
            continue;
        };
        if !is_claude_model(id) || models.iter().any(|model: &DevModel| model.id == id) {
            continue;
        }
        let known = claude_model(id);
        let name = row
            .get("display_name")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| known.map(|row| (*row.1).to_string()).unwrap_or_else(|| id.to_string()));
        let window = row
            .get("max_input_tokens")
            .and_then(|value| value.as_u64())
            .filter(|value| *value > 0)
            .or_else(|| known.map(|row| row.2));
        let efforts = effort_levels(row.get("capabilities").and_then(|value| value.get("effort")))
            .map(|levels| efforts_for(&levels))
            .or_else(|| known.map(|row| efforts_for(row.4)))
            .unwrap_or_else(|| efforts_for(efforts_for_line(id)));
        models.push(DevModel {
            id: id.to_string(),
            name,
            efforts,
            context_window: window,
            context_windows: Vec::new(),
            provider: PROVIDER_ANTHROPIC.into(),
            capabilities: model_capabilities(row.get("capabilities"), known.is_some()),
        });
    }
    let has_more = json.get("has_more").and_then(|value| value.as_bool()).unwrap_or(false);
    let last_id = json
        .get("last_id")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    (models, last_id, has_more)
}

fn bundled_capabilities(id: &str) -> Vec<String> {
    let mut caps = vec!["vision".to_string(), "pdf".to_string(), "effort".to_string()];
    if supports_adaptive_thinking(id) || manual_thinking_budget(id, Some("high")).is_some() {
        caps.insert(1, "thinking".to_string());
    }
    caps
}

fn supported(value: Option<&serde_json::Value>) -> bool {
    value
        .and_then(|item| item.get("supported"))
        .and_then(|item| item.as_bool())
        .unwrap_or(false)
}

fn model_capabilities(caps: Option<&serde_json::Value>, known: bool) -> Vec<String> {
    let Some(caps) = caps else {
        return if known { vec!["vision".into(), "thinking".into(), "pdf".into(), "effort".into()] } else { Vec::new() };
    };
    let mut out = Vec::new();
    if supported(caps.get("image_input")) {
        out.push("vision".into());
    }
    if supported(caps.get("thinking")) {
        out.push("thinking".into());
    }
    if supported(caps.get("pdf_input")) {
        out.push("pdf".into());
    }
    if supported(caps.get("effort")) {
        out.push("effort".into());
    }
    out
}

/// Effort levels the model actually offers, in picker order. `None` when the field is absent.
fn effort_levels(effort: Option<&serde_json::Value>) -> Option<Vec<&str>> {
    let effort = effort?;
    const ORDER: &[&str] = &["low", "medium", "high", "xhigh", "max"];
    let levels = ORDER
        .iter()
        .copied()
        .filter(|id| supported(effort.get(*id)))
        .collect::<Vec<_>>();
    if levels.is_empty() { None } else { Some(levels) }
}

fn efforts_for_line(id: &str) -> &'static [&'static str] {
    if id.contains("haiku") {
        &["low", "medium", "high"]
    } else {
        &["low", "medium", "high", "xhigh", "max"]
    }
}

/// Models this account can call.
/// The catalog is the picker. A live page fills in display names, windows, and effort
/// for ids it returns, including dated snapshots, but it never hides a catalog family
/// that the page left out.
pub async fn available_models(auth: &ClaudeAuth) -> Vec<DevModel> {
    let client = reqwest::Client::builder()
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut after: Option<String> = None;
    let mut out = Vec::new();
    for _ in 0..5 {
        let mut req = client
            .get(MODELS_URL)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .query(&[("limit", "100")]);
        if let Some(cursor) = after.as_deref() {
            req = req.query(&[("after_id", cursor)]);
        }
        req = if auth.via_cli {
            req.bearer_auth(&auth.token)
        } else {
            req.header("x-api-key", &auth.token)
        };
        let Ok(resp) = req.send().await else {
            break;
        };
        if !resp.status().is_success() {
            break;
        }
        let Ok(body) = resp.text().await else {
            break;
        };
        let (page, last_id, has_more) = parse_models_page(&body);
        if page.is_empty() && out.is_empty() {
            break;
        }
        for model in page {
            if !out.iter().any(|row: &DevModel| row.id == model.id) {
                out.push(model);
            }
        }
        if !has_more {
            break;
        }
        let Some(cursor) = last_id else {
            break;
        };
        after = Some(cursor);
    }
    merge_catalog(out)
}

/// Keep every catalog family, in catalog order. Live rows overlay the same id and
/// dated snapshots (`claude-sonnet-4-5-20250929`) follow their family.
fn merge_catalog(live: Vec<DevModel>) -> Vec<DevModel> {
    let mut used = vec![false; live.len()];
    let mut out = Vec::with_capacity(CLAUDE_MODELS.len() + live.len());
    for (id, name, window, _max_tokens, efforts) in CLAUDE_MODELS {
        let mut row = DevModel {
            id: (*id).into(),
            name: (*name).into(),
            efforts: efforts_for(efforts),
            context_window: Some(*window),
            context_windows: Vec::new(),
            provider: PROVIDER_ANTHROPIC.into(),
            capabilities: bundled_capabilities(id),
        };
        if let Some(index) = live.iter().position(|item| item.id == *id) {
            row = overlay_catalog(row, &live[index]);
            used[index] = true;
        }
        out.push(row);
        let prefix = format!("{id}-");
        for (index, item) in live.iter().enumerate() {
            if used[index] || !item.id.starts_with(&prefix) {
                continue;
            }
            used[index] = true;
            out.push(item.clone());
        }
    }
    for (index, item) in live.into_iter().enumerate() {
        if !used[index] {
            out.push(item);
        }
    }
    out
}

fn overlay_catalog(catalog: DevModel, live: &DevModel) -> DevModel {
    DevModel {
        id: catalog.id,
        name: if live.name.trim().is_empty() {
            catalog.name
        } else {
            live.name.clone()
        },
        efforts: if live.efforts.is_empty() {
            catalog.efforts
        } else {
            live.efforts.clone()
        },
        context_window: live.context_window.or(catalog.context_window),
        context_windows: live.context_windows.clone(),
        provider: PROVIDER_ANTHROPIC.into(),
        capabilities: if live.capabilities.is_empty() {
            catalog.capabilities
        } else {
            live.capabilities.clone()
        },
    }
}

pub const MESSAGES_URL: &str = twanagent_service::anthropic::MESSAGES_URL;
pub const MODELS_URL: &str = "https://api.anthropic.com/v1/models";
pub const ANTHROPIC_VERSION: &str = twanagent_service::anthropic::ANTHROPIC_VERSION;
pub const SIGN_IN_ERROR: &str =
    "Claude isn’t signed in. Run claude login, or add an Anthropic API key in Settings.";
pub const KEY_REJECTED: &str = twanagent_service::anthropic::KEY_REJECTED;

/// OpenAI-shaped chat messages become a Messages API body. No I/O.
pub fn to_messages_body(
    messages: &serde_json::Value,
    model: &str,
    effort: Option<&str>,
    tools: &serde_json::Value,
) -> serde_json::Value {
    twanagent_service::anthropic::to_messages_body(messages, model, effort, tools)
}

pub fn http_error_message(status: u16, body: &str) -> String {
    twanagent_service::anthropic::http_error_message(status, body)
}

pub type SsePiece = StreamPiece;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ThinkingAccum {
    inner: crate::model_providers::event::ThinkingAccum,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ToolAccum {
    inner: crate::model_providers::event::ToolAccum,
}

/// One Anthropic SSE `data:` payload. Event names are ignored; the JSON `type` is enough.
pub fn parse_sse_data(data: &str) -> Option<StreamPiece> {
    use twanagent_service::anthropic::SseEvent;
    Some(match twanagent_service::anthropic::parse_sse_data(data)? {
        SseEvent::Delta(text) => StreamPiece::Delta(text),
        SseEvent::Reasoning(text) => StreamPiece::Reasoning(text),
        SseEvent::Usage {
            prompt_tokens,
            completion_tokens,
            cache_read_tokens,
            cache_creation_tokens,
        } => StreamPiece::Usage {
            prompt_tokens,
            completion_tokens,
            cache_read_tokens,
            cache_creation_tokens,
        },
        SseEvent::ToolStart { index, id, name } => StreamPiece::ToolStart { index, id, name },
        SseEvent::ToolDelta { index, partial } => StreamPiece::ToolDelta { index, partial },
        SseEvent::ThinkingStart { index } => StreamPiece::ThinkingStart { index },
        SseEvent::RedactedThinking { index, data } => StreamPiece::RedactedThinking { index, data },
        SseEvent::ThinkingSignature { index, signature } => StreamPiece::ThinkingSignature { index, signature },
        SseEvent::Stop => StreamPiece::Stop,
    })
}

pub fn merge_usage(prev: Option<(u64, u64)>, prompt_tokens: u64, completion_tokens: u64) -> (u64, u64) {
    merge_stream_usage(prev, prompt_tokens, completion_tokens)
}

pub fn finished_thinking(blocks: &ThinkingAccum) -> Vec<ThinkingBlock> {
    finished_thinking_blocks(blocks)
}

pub fn finished_tools(tools: &ToolAccum) -> Vec<(String, String, String)> {
    finished_tool_rows(tools)
}

pub fn apply_thinking_piece(blocks: &mut ThinkingAccum, piece: &StreamPiece) {
    apply_thinking(&mut blocks.inner, piece);
}

pub fn finished_thinking_blocks(blocks: &ThinkingAccum) -> Vec<ThinkingBlock> {
    shared_finished_thinking(&blocks.inner)
}

pub fn apply_tool_piece(tools: &mut ToolAccum, piece: &StreamPiece) {
    apply_tool(&mut tools.inner, piece);
}

pub fn finished_tool_rows(tools: &ToolAccum) -> Vec<(String, String, String)> {
    shared_finished_tools(&tools.inner)
        .into_iter()
        .map(|row| {
            let id = if row.id.starts_with("tool_") && !row.id.starts_with("toolu_") {
                row.id.replacen("tool_", "toolu_", 1)
            } else {
                row.id
            };
            (id, row.name, row.arguments)
        })
        .collect()
}

#[cfg(test)]
mod tests;
