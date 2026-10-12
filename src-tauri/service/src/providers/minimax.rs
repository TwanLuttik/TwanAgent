//! MiniMax text chat. The request is the Anthropic Messages body with MiniMax's own caps.
//! Login and the `mmx` CLI stay with the desktop. The server only needs the URL and the body.

use serde_json::Value;

use super::anthropic::to_messages_body;

pub const KEY_REJECTED: &str = "MiniMax rejected the API key.";
const GLOBAL_HOST: &str = "https://api.minimax.io";

/// A MiniMax text model. The prefix is case-sensitive, matching the API ids.
pub fn is_minimax_model(id: &str) -> bool {
    let id = id.trim();
    let Some(rest) = id.strip_prefix("MiniMax-") else {
        return false;
    };
    !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.')
}

/// `{base}/anthropic/v1/messages`. Empty base uses the global host.
pub fn messages_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let base = if base.is_empty() { GLOBAL_HOST } else { base };
    format!("{base}/anthropic/v1/messages")
}

pub fn http_error_message(status: u16, body: &str) -> String {
    if status == 401 || status == 403 {
        return KEY_REJECTED.into();
    }
    format!("MiniMax error {status}: {}", body.chars().take(400).collect::<String>())
}

/// OpenAI-shaped messages become the Messages body MiniMax accepts.
/// `max_output` is the model's output cap. Effort is not an Anthropic output_config field here.
pub fn to_minimax_body(messages: &Value, model: &str, tools: &Value, max_output: u32) -> Value {
    let mut body = to_messages_body(messages, model, None, tools);
    body["model"] = Value::String(model.trim().to_string());
    body["max_tokens"] = Value::from(max_output);
    if let Some(obj) = body.as_object_mut() {
        obj.remove("output_config");
        if is_minimax_model(model) {
            obj.insert("thinking".into(), serde_json::json!({ "type": "adaptive" }));
        } else {
            obj.remove("thinking");
        }
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matcher_claims_minimax_ids_only() {
        assert!(is_minimax_model("MiniMax-M3"));
        assert!(is_minimax_model(" MiniMax-M2.7 "));
        assert!(is_minimax_model("MiniMax-Future-1"));
        assert!(!is_minimax_model("minimax-m3"));
        assert!(!is_minimax_model("MiniMax-"));
        assert!(!is_minimax_model(""));
    }

    #[test]
    fn body_uses_the_caller_cap_and_drops_effort() {
        let body = to_minimax_body(
            &serde_json::json!([
                { "role": "system", "content": "You are MiniMax." },
                { "role": "user", "content": "hi" }
            ]),
            "MiniMax-M3",
            &serde_json::json!([]),
            128_000,
        );
        assert_eq!(body["model"], "MiniMax-M3");
        assert_eq!(body["max_tokens"], 128_000);
        assert_eq!(body["system"], "You are MiniMax.");
        assert!(body.get("output_config").is_none());
        assert_eq!(body["thinking"]["type"], "adaptive");
        assert_eq!(messages_url(""), "https://api.minimax.io/anthropic/v1/messages");
        assert_eq!(messages_url("https://api.minimax.cn/"), "https://api.minimax.cn/anthropic/v1/messages");
    }
}
