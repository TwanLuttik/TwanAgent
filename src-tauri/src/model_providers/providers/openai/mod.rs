//! OpenAI Responses chat.

mod usage;

pub use usage::{
    __cmd__dev_openai_account_usage, __cmd__dev_openai_account_usage_cached,
    __tauri_command_name_dev_openai_account_usage, __tauri_command_name_dev_openai_account_usage_cached,
    dev_openai_account_usage, dev_openai_account_usage_cached,
};

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tauri::AppHandle;

use crate::error::{Error, Result};
use crate::grok_cli::{effort_label, DevEffort, DevModel};
use crate::model_providers::event::StreamPiece;

pub const PROVIDER_OPENAI: &str = "openai";
pub const SIGN_IN_ERROR: &str = "OpenAI isn’t signed in. Add an OpenAI API key in Settings.";

pub fn openai_models() -> Vec<DevModel> {
    twanagent_service::openai::catalog()
        .iter()
        .map(|(id, name, window, _max_tokens, efforts)| DevModel {
            id: (*id).into(),
            name: (*name).into(),
            efforts: efforts
                .iter()
                .map(|id| DevEffort {
                    id: (*id).into(),
                    label: if *id == "none" {
                        "None".into()
                    } else {
                        effort_label(id)
                    },
                })
                .collect(),
            context_window: Some(*window),
            context_windows: Vec::new(),
            provider: PROVIDER_OPENAI.into(),
            capabilities: vec!["vision".into(), "thinking".into(), "effort".into()],
        })
        .collect()
}

/// Saved key, then `OPENAI_API_KEY`.
pub fn resolve_openai_auth(data_dir: &std::path::Path) -> Option<String> {
    crate::secrets::resolve_openai_key_on_disk(data_dir)
}

fn map_sse(data: &str, state: &mut twanagent_service::openai::SseState) -> Vec<StreamPiece> {
    use twanagent_service::openai::SseEvent;
    twanagent_service::openai::parse_sse_data_with(data, state)
        .into_iter()
        .map(|event| match event {
            SseEvent::Delta(text) => StreamPiece::Delta(text),
            SseEvent::Reasoning(text) => StreamPiece::Reasoning(text),
            SseEvent::Usage {
                prompt_tokens,
                completion_tokens,
                cache_read_tokens,
            } => StreamPiece::Usage {
                prompt_tokens,
                completion_tokens,
                cache_read_tokens,
                cache_creation_tokens: 0,
            },
            SseEvent::ToolStart { index, id, name } => StreamPiece::ToolStart { index, id, name },
            SseEvent::ToolDelta { index, partial } => StreamPiece::ToolDelta { index, partial },
            SseEvent::OutputItem(item) => StreamPiece::ReasoningItem(item),
            SseEvent::Failed(message) => StreamPiece::Failed(message),
            SseEvent::Stop => StreamPiece::Stop,
        })
        .collect()
}

pub async fn stream(
    app: &AppHandle,
    stream_id: &str,
    token: &str,
    messages: serde_json::Value,
    model: &str,
    effort: Option<&str>,
    tools: &serde_json::Value,
    cancel: Arc<AtomicBool>,
    service_tier: Option<&str>,
) -> Result<()> {
    let mut body = twanagent_service::openai::to_responses_body(&messages, model, effort, tools);
    if let Some(tier) = twanagent_service::openai::service_tier_for(model, service_tier.unwrap_or("")) {
        body["service_tier"] = serde_json::Value::String(tier.to_string());
    }
    let resp = crate::model_providers::runner::http_client()
        .post(twanagent_service::openai::RESPONSES_URL)
        .bearer_auth(token)
        .header("content-type", "application/json")
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .json(&body)
        .send()
        .await
        .map_err(|err| Error::Other(format!("OpenAI request failed: {err}")))?;
    usage::remember_rate_headers(resp.headers());
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(twanagent_service::openai::http_error_message(
            status.as_u16(),
            &text,
        )));
    }
    let mut sse = twanagent_service::openai::SseState::default();
    crate::model_providers::runner::consume_sse(
        app,
        stream_id,
        resp,
        cancel,
        move |data| map_sse(data, &mut sse),
        |_| None,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_lists_the_four_models_without_a_context_chip() {
        let rows = openai_models();
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"]
        );
        assert!(rows.iter().all(|row| row.provider == PROVIDER_OPENAI));
        assert!(rows.iter().all(|row| row.context_window == Some(922_000)));
        assert!(rows.iter().all(|row| row.context_windows.is_empty()));
        assert!(rows[0].efforts.iter().all(|effort| effort.id != "none"));
        assert_eq!(rows[2].efforts[0].id, "none");
        assert_eq!(rows[2].efforts[0].label, "None");
        assert_eq!(rows[3].name, "GPT-6 Luna");
    }
}
