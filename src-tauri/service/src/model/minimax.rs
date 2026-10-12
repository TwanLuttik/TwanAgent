//! MiniMax round for a hosted turn. Same SSE events as Claude, with MiniMax's URL and output cap.

use super::{failed, read_sse, Round};
use crate::error::{Error, Result};
use crate::providers::minimax;

const MAX_OUTPUT: u32 = 128_000;

pub(super) fn round(
    client: &reqwest::blocking::Client,
    token: &str,
    model: &str,
    messages: &serde_json::Value,
    tools: &serde_json::Value,
    on_delta: &mut dyn FnMut(&str),
) -> Result<Round> {
    let body = minimax::to_minimax_body(messages, model, tools, MAX_OUTPUT);
    let response = client
        .post(minimax::messages_url(""))
        .header("x-api-key", token)
        .header("anthropic-version", crate::providers::anthropic::ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|err| Error::Other(format!("MiniMax request failed: {err}")))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().unwrap_or_default();
        return Ok(failed("MiniMax", status, &text));
    }
    read_sse(response, on_delta, super::anthropic::apply_line)
}

#[cfg(test)]
mod tests {
    use super::super::OpenRound;
    use super::super::anthropic::apply_line;

    #[test]
    fn claude_events_fill_the_same_round() {
        let mut open = OpenRound::default();
        apply_line(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}"#,
            &mut open,
        );
        apply_line(
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file"}}"#,
            &mut open,
        );
        apply_line(
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"a.rs\"}"}}"#,
            &mut open,
        );
        let done = open.finish();
        assert_eq!(done.text, "Hi");
        assert_eq!(done.tool_calls[0].id, "toolu_1");
        assert_eq!(done.tool_calls[0].arguments, r#"{"path":"a.rs"}"#);
    }
}
