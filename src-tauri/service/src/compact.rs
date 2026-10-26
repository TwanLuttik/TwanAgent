//! Decide when a hosted turn must shrink its prompt, and build the shrunk prompt.
//! The desktop loop keeps the same rules in its own crate. A turn on this machine uses these.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct Compaction {
    pub summary: String,
    pub through: u64,
}

pub(crate) const AUTO_COMPACT_PERCENT: u64 = 80;
pub(crate) const COMPACTION_EVENT_TEXT: &str = "Conversation compacted";
const SUMMARY_TAG: &str = "compaction_summary";
const FAILURE_PREFIX: &str = "Couldn't continue: ";
const TRANSCRIPT_CAP: usize = 80_000;

const SUMMARY_INSTRUCTIONS: &str = "Summarize this coding conversation so work can continue in a fresh context window.\n\
Write a compact brief the assistant will read instead of the earlier messages. Include:\n\
- What the user asked for and the decisions already made\n\
- Files created or changed, and what changed in each\n\
- Commands run and whether they passed or failed\n\
- Errors still open, and the exact next step\n\
Keep file paths, function names, and error text that the next turn needs. Drop greetings, repeated tool output, and anything already superseded.\n\
Reply with the summary only. Do not mention that you are summarizing.";

const COMPACT_NOTICE: &str = "Your conversation was summarized due to context constraints. Here is the summary of the conversation so far:";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BudgetAction {
    Send,
    /// Summarize this many times before the next model call.
    Fold { times: u8 },
    Stop,
}

#[derive(Debug, Clone)]
pub(crate) struct FoldPlan {
    pub older: Vec<Value>,
    pub through: usize,
    pub previous_summary: String,
}

pub(crate) fn should_auto_compact(prompt_tokens: u64, window: u64) -> bool {
    prompt_tokens > 0 && window > 0 && prompt_tokens >= window.saturating_mul(AUTO_COMPACT_PERCENT) / 100
}

pub(crate) fn prompt_exceeds_window(prompt_tokens: u64, window: u64) -> bool {
    window > 0 && prompt_tokens > 0 && prompt_tokens >= window
}

pub(crate) fn is_context_length_error(error: &str) -> bool {
    let text = error.to_lowercase();
    if text.is_empty() || text.contains("stopped") {
        return false;
    }
    text.contains("context length")
        || text.contains("context window")
        || text.contains("maximum context")
        || text.contains("too many tokens")
        || text.contains("token limit")
        || (text.contains("context") && (text.contains("exceed") || text.contains("too long") || text.contains("too large")))
}

/// `prompt_tokens` is the previous request. Zero means this turn has not measured a prompt yet.
pub(crate) fn budget_action(prompt_tokens: u64, window: u64, can_fold: bool) -> BudgetAction {
    if !prompt_exceeds_window(prompt_tokens, window) && !should_auto_compact(prompt_tokens, window) {
        return BudgetAction::Send;
    }
    if prompt_exceeds_window(prompt_tokens, window) {
        return if can_fold {
            BudgetAction::Fold { times: 4 }
        } else {
            BudgetAction::Stop
        };
    }
    if can_fold {
        BudgetAction::Fold { times: 1 }
    } else {
        BudgetAction::Send
    }
}

pub(crate) fn plan_fold(stored: &[Value], current: Option<&Compaction>) -> Option<FoldPlan> {
    let source = messages_for_context(stored, current);
    let cut = shrink_cut(&source);
    if cut == 0 || cut >= source.len() {
        return None;
    }
    let older = source[..cut].to_vec();
    if !foldable(&older) {
        return None;
    }
    let recent_len = source.len() - cut;
    if recent_len == 0 || recent_len > stored.len() {
        return None;
    }
    let through = stored.len() - recent_len;
    if through == 0 || through >= stored.len() {
        return None;
    }
    if current.is_some_and(|state| state.through as usize == through) {
        return None;
    }
    let previous_summary = summary_body(source.first().and_then(|msg| msg.get("content")).and_then(Value::as_str).unwrap_or(""))
        .or_else(|| current.map(|state| state.summary.trim().to_string()).filter(|text| !text.is_empty()))
        .unwrap_or_default();
    Some(FoldPlan {
        older,
        through,
        previous_summary,
    })
}

pub(crate) fn commit_fold(stored: &mut Vec<Value>, summary: &str, through: usize) -> Option<Compaction> {
    let summary = summary.trim();
    if summary.is_empty() || through == 0 || through >= stored.len() {
        return None;
    }
    insert_compaction_event(stored, through);
    Some(Compaction {
        summary: summary.to_string(),
        through: through as u64,
    })
}

pub(crate) fn messages_for_context(stored: &[Value], current: Option<&Compaction>) -> Vec<Value> {
    let Some(current) = current else {
        return stored.to_vec();
    };
    let summary = current.summary.trim();
    let through = current.through as usize;
    if summary.is_empty() || through == 0 || through >= stored.len() {
        return stored.to_vec();
    }
    let mut out = Vec::with_capacity(1 + stored.len() - through);
    out.push(summary_message(summary));
    out.extend(stored[through..].iter().cloned());
    out
}

/// Messages the provider should see. Reasoning stays on the transcript and is not sent again.
pub(crate) fn api_messages(context: &[Value]) -> Vec<Value> {
    context.iter().filter_map(api_message).collect()
}

pub(crate) fn compaction_prompt(older: &[Value], previous: &str) -> Vec<Value> {
    let transcript = render_transcript(older);
    let previous = previous.trim();
    let content = if previous.is_empty() {
        format!("{SUMMARY_INSTRUCTIONS}\n\nConversation:\n{transcript}")
    } else {
        format!("{SUMMARY_INSTRUCTIONS}\n\nPrevious summary:\n{previous}\n\nConversation since that summary:\n{transcript}")
    };
    vec![
        json!({ "role": "system", "content": "Reply with the summary only. Do not call tools." }),
        json!({ "role": "user", "content": content }),
    ]
}

fn shrink_cut(messages: &[Value]) -> usize {
    let at_turns = user_turn_cut(messages, 2);
    if at_turns > 0 && at_turns < messages.len() {
        return at_turns;
    }
    let keep_two = tool_round_cut(messages, 2);
    if keep_two > 0 && keep_two < messages.len() {
        return keep_two;
    }
    let keep_one = tool_round_cut(messages, 1);
    if keep_one > 0 && keep_one < messages.len() {
        keep_one
    } else {
        messages.len()
    }
}

fn user_turn_cut(messages: &[Value], keep: usize) -> usize {
    let starts = user_turns(messages);
    let retain = keep.max(1);
    if starts.len() <= retain {
        return messages.len();
    }
    starts[starts.len() - retain]
}

fn user_turns(messages: &[Value]) -> Vec<usize> {
    messages
        .iter()
        .enumerate()
        .filter_map(|(index, msg)| (role(msg) == "user").then_some(index))
        .collect()
}

fn tool_round_cut(messages: &[Value], keep: usize) -> usize {
    let starts: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter_map(|(index, msg)| (role(msg) == "assistant" && has_tool_calls(msg)).then_some(index))
        .collect();
    let retain = keep.max(1);
    if starts.len() <= retain {
        return messages.len();
    }
    starts[starts.len() - retain]
}

fn foldable(older: &[Value]) -> bool {
    older.iter().any(|msg| {
        !is_compaction_event(msg) && !is_summary_message(msg) && role(msg) != "system"
    })
}

fn insert_compaction_event(stored: &mut Vec<Value>, at: usize) {
    if at == 0 || at > stored.len() {
        return;
    }
    if is_compaction_event(stored.get(at).unwrap_or(&Value::Null))
        || is_compaction_event(stored.get(at - 1).unwrap_or(&Value::Null))
    {
        return;
    }
    stored.insert(at, json!({ "role": "system", "content": COMPACTION_EVENT_TEXT }));
}

fn summary_message(summary: &str) -> Value {
    json!({ "role": "system", "content": format_summary(summary) })
}

fn format_summary(summary: &str) -> String {
    format!(
        "{COMPACT_NOTICE}\n<summary_content>\n<{SUMMARY_TAG}>\n{summary}\n</{SUMMARY_TAG}>\n</summary_content>\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary and do not recap what was happening."
    )
}

fn is_compaction_event(msg: &Value) -> bool {
    role(msg) == "system" && content_str(msg).trim() == COMPACTION_EVENT_TEXT
}

fn is_summary_message(msg: &Value) -> bool {
    role(msg) == "system" && content_str(msg).contains(&format!("<{SUMMARY_TAG}>"))
}

fn is_failure(msg: &Value) -> bool {
    msg.get("error").and_then(Value::as_bool) == Some(true) || content_str(msg).starts_with(FAILURE_PREFIX)
}

fn api_message(msg: &Value) -> Option<Value> {
    if is_compaction_event(msg) || is_failure(msg) {
        return None;
    }
    if is_summary_message(msg) {
        return Some(json!({ "role": "user", "content": content_str(msg) }));
    }
    match role(msg) {
        "system" => None,
        "tool" => Some(json!({
            "role": "tool",
            "tool_call_id": msg.get("tool_call_id").and_then(Value::as_str).unwrap_or(""),
            "content": msg.get("content").cloned().unwrap_or_else(|| Value::String(String::new())),
        })),
        "user" => {
            let mut out = json!({
                "role": "user",
                "content": msg.get("content").cloned().unwrap_or_else(|| Value::String(String::new())),
            });
            if let Some(images) = msg.get("images").filter(|value| value.as_array().is_some_and(|rows| !rows.is_empty())) {
                out["images"] = images.clone();
            }
            Some(out)
        }
        "assistant" => {
            let calls = msg
                .get("tool_calls")
                .cloned()
                .filter(|value| value.as_array().is_some_and(|rows| !rows.is_empty()));
            let thinking = msg
                .get("thinking")
                .cloned()
                .filter(|value| value.as_array().is_some_and(|rows| !rows.is_empty()));
            let text = content_str(msg);
            let mut out = serde_json::Map::new();
            out.insert("role".into(), Value::String("assistant".into()));
            if (calls.is_some() || thinking.is_some()) && text.trim().is_empty() {
                out.insert("content".into(), Value::Null);
            } else {
                out.insert("content".into(), Value::String(text));
            }
            if let Some(calls) = calls {
                out.insert("tool_calls".into(), calls);
            }
            if let Some(thinking) = thinking {
                out.insert("thinking".into(), thinking);
            }
            Some(Value::Object(out))
        }
        _ => None,
    }
}

fn render_transcript(messages: &[Value]) -> String {
    let mut lines = Vec::new();
    for msg in messages {
        if is_summary_message(msg) {
            if let Some(body) = summary_body(&content_str(msg)) {
                lines.push(format!("Previous summary:\n{body}"));
            }
            continue;
        }
        if role(msg) == "system" {
            continue;
        }
        match role(msg) {
            "user" => {
                let text = content_str(msg).trim().to_string();
                let images = image_names(msg);
                let attached = if images.is_empty() {
                    String::new()
                } else {
                    format!("\n[images: {}]", images.join(", "))
                };
                lines.push(format!("User: {text}{attached}").trim().to_string());
            }
            "assistant" => {
                let thought = msg.get("reasoning").and_then(Value::as_str).unwrap_or("").trim();
                if !thought.is_empty() {
                    lines.push(format!("Thinking: {}", clip(thought, 800)));
                }
                let owned = content_str(msg);
                let text = owned.trim();
                if !text.is_empty() {
                    lines.push(format!("Assistant: {}", clip(text, 2000)));
                }
                if let Some(calls) = msg.get("tool_calls").and_then(Value::as_array) {
                    for call in calls {
                        lines.push(format!("Tool call: {}", tool_line(call)));
                    }
                }
            }
            "tool" => lines.push(format!("Tool result: {}", clip(content_str(msg).trim(), 500))),
            _ => {}
        }
    }
    cap_tail(&lines.join("\n\n"))
}

fn tool_line(call: &Value) -> String {
    let name = call
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| call.pointer("/function/name").and_then(Value::as_str))
        .unwrap_or("");
    let args = call
        .get("arguments")
        .and_then(Value::as_str)
        .or_else(|| call.pointer("/function/arguments").and_then(Value::as_str))
        .unwrap_or("");
    let args = args.trim();
    if args.is_empty() {
        name.to_string()
    } else {
        format!("{name} {}", clip(args, 300))
    }
}

fn image_names(msg: &Value) -> Vec<String> {
    msg.get("images")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|image| image.get("name").and_then(Value::as_str))
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn summary_body(content: &str) -> Option<String> {
    let start = content.find(&format!("<{SUMMARY_TAG}>"))?;
    let rest = &content[start + SUMMARY_TAG.len() + 2..];
    let end = rest.find(&format!("</{SUMMARY_TAG}>"))?;
    let body = rest[..end].trim();
    if body.is_empty() {
        None
    } else {
        Some(body.to_string())
    }
}

fn cap_tail(text: &str) -> String {
    let count = text.chars().count();
    if count <= TRANSCRIPT_CAP {
        return text.to_string();
    }
    text.chars().skip(count - TRANSCRIPT_CAP).collect()
}

fn clip(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

fn role(msg: &Value) -> &str {
    msg.get("role").and_then(Value::as_str).unwrap_or("")
}

fn content_str(msg: &Value) -> String {
    match msg.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn has_tool_calls(msg: &Value) -> bool {
    msg.get("tool_calls").and_then(Value::as_array).is_some_and(|rows| !rows.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(content: &str) -> Value {
        json!({ "role": "user", "content": content })
    }

    fn assistant_tool(id: &str) -> Value {
        json!({
            "role": "assistant",
            "content": "",
            "reasoning": "private thought",
            "tool_calls": [{ "id": id, "name": "read_file", "arguments": "{}" }]
        })
    }

    fn tool_result(id: &str, content: &str) -> Value {
        json!({ "role": "tool", "tool_call_id": id, "content": content })
    }

    fn tool_loop() -> Vec<Value> {
        vec![
            user("find the crash"),
            assistant_tool("1"),
            tool_result("1", "a"),
            assistant_tool("2"),
            tool_result("2", "b"),
            assistant_tool("3"),
            tool_result("3", "c"),
            assistant_tool("4"),
            tool_result("4", "d"),
        ]
    }

    #[test]
    fn the_proxy_overflow_is_a_context_length_error() {
        let err = r#"xAI error 400: {"code":"invalid-argument","error":"Failed to start sampling: [input_too_large] The prompt is too long for this model's context window (500333 tokens > 500000 tokens)"}"#;
        assert!(is_context_length_error(err));
        assert!(!is_context_length_error("Stopped."));
        assert!(!is_context_length_error("xAI rejected the API key."));
    }

    #[test]
    fn eighty_percent_folds_once_and_a_full_window_stops_when_nothing_can_fold() {
        assert!(should_auto_compact(400_000, 500_000));
        assert!(!should_auto_compact(399_999, 500_000));
        assert_eq!(budget_action(400_000, 500_000, true), BudgetAction::Fold { times: 1 });
        assert_eq!(budget_action(399_999, 500_000, true), BudgetAction::Send);
        assert_eq!(budget_action(500_333, 500_000, true), BudgetAction::Fold { times: 4 });
        assert_eq!(budget_action(500_333, 500_000, false), BudgetAction::Stop);
        assert_eq!(budget_action(0, 500_000, true), BudgetAction::Send);
    }

    #[test]
    fn one_user_turn_of_tool_rounds_folds_the_older_rounds() {
        let mut stored = tool_loop();
        let plan = plan_fold(&stored, None).expect("fold");
        assert_eq!(plan.through, 5);
        assert_eq!(stored[plan.through]["tool_calls"][0]["id"], "3");
        let state = commit_fold(&mut stored, "Read the first files.", plan.through).unwrap();
        assert_eq!(state.through, 5);
        assert_eq!(stored[5]["content"], COMPACTION_EVENT_TEXT);
        let again = plan_fold(&stored, Some(&state)).expect("second fold");
        assert!(again.through > state.through as usize);
        assert_eq!(stored[again.through]["tool_calls"][0]["id"], "4");
    }

    #[test]
    fn user_turns_stay_ahead_of_tool_rounds() {
        let stored = vec![
            user("fix the login bug"),
            assistant_tool("1"),
            tool_result("1", "export function login() {}"),
            json!({ "role": "assistant", "content": "Found it in src/login.ts." }),
            user("also add a test"),
            json!({ "role": "assistant", "content": "Added the test." }),
            user("now compact the list"),
            json!({ "role": "assistant", "content": "Working on the list." }),
        ];
        let plan = plan_fold(&stored, None).unwrap();
        assert_eq!(plan.through, 4);
        assert_eq!(stored[4]["content"], "also add a test");
    }

    #[test]
    fn the_prompt_keeps_the_tail_and_drops_reasoning() {
        let mut stored = tool_loop();
        let state = commit_fold(&mut stored, "Read the first files.", 5).unwrap();
        let api = api_messages(&messages_for_context(&stored, Some(&state)));
        assert_eq!(api[0]["role"], "user");
        assert!(api[0]["content"].as_str().unwrap().contains("Read the first files."));
        assert!(api.iter().all(|msg| msg.get("reasoning").is_none()));
        assert!(api.iter().all(|msg| msg["content"].as_str() != Some(COMPACTION_EVENT_TEXT)));
        assert!(api.iter().all(|msg| msg["content"].as_str() != Some("a")));
        assert!(api.iter().any(|msg| msg["content"].as_str() == Some("d")));
        let calls = api.iter().any(|msg| msg["tool_calls"][0]["id"].as_str() == Some("4"));
        assert!(calls);
    }

    #[test]
    fn a_short_thread_and_one_tool_round_do_not_fold() {
        let short = vec![user("find the crash"), assistant_tool("1"), tool_result("1", "a")];
        assert!(plan_fold(&short, None).is_none());
    }

    #[test]
    fn the_summary_prompt_clips_a_huge_tool_result() {
        let long = "x".repeat(800);
        let older = vec![tool_result("1", &long)];
        let prompt = compaction_prompt(&older, "");
        let text = prompt[1]["content"].as_str().unwrap();
        assert!(text.contains('…'));
        assert!(!text.contains(&long));
        assert!(text.contains("Reply with the summary only"));
    }
}
