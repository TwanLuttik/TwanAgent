use super::*;

#[test]
fn catalog_lists_each_claude_family() {
    let rows = claude_models();
    assert_eq!(
        rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        [
            "claude-fable-5-1",
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "claude-haiku-5-5",
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-sonnet-4-6",
            "claude-sonnet-4-5",
            "claude-haiku-4-5",
        ]
    );
    assert!(rows.iter().all(|row| row.provider == PROVIDER_ANTHROPIC));
    assert!(rows.iter().all(|row| row.context_windows.is_empty()));
    assert_eq!(rows[0].context_window, Some(1_000_000));
    assert_eq!(rows[0].efforts[0].id, "low");
    assert_eq!(rows[0].efforts[0].label, "Low");
    assert_eq!(rows[0].efforts[3].label, "Extra high");
    assert_eq!(rows[0].efforts.last().map(|e| e.id.as_str()), Some("max"));
    let haiku = rows
        .iter()
        .find(|row| row.id == "claude-haiku-4-5")
        .unwrap();
    assert_eq!(haiku.efforts.len(), 3);
    assert_eq!(haiku.context_window, Some(200_000));
}

#[test]
fn live_page_does_not_hide_catalog_families() {
    let page = claude_models()
        .into_iter()
        .filter(|row| row.id == "claude-opus-4-8")
        .collect();
    let rows = merge_catalog(page);
    let ids: Vec<_> = rows.iter().map(|row| row.id.as_str()).collect();
    assert!(ids.contains(&"claude-fable-5-1"));
    assert!(ids.contains(&"claude-opus-5-5"));
    assert!(ids.contains(&"claude-sonnet-5-5"));
    assert!(ids.contains(&"claude-haiku-5-5"));
    assert!(ids.contains(&"claude-opus-4-7"));
    assert_eq!(ids.iter().filter(|id| **id == "claude-opus-4-8").count(), 1);
}

#[test]
fn provider_matches_only_the_catalog_ids() {
    assert_eq!(provider_for("claude-sonnet-4-6"), Provider::Anthropic);
    assert_eq!(provider_for(" claude-opus-4-8 "), Provider::Anthropic);
    assert!(is_claude_model("claude-haiku-4-5"));
    assert!(is_claude_model("claude-opus-4-8-latest"));
    assert!(is_claude_model("claude-sonnet-4-5-20250929"));
    assert!(!is_claude_model("grok-4.6"));
    assert!(!is_claude_model(""));
    assert_eq!(provider_for("grok-4.6"), Provider::Xai);
    assert_eq!(provider_for(""), Provider::Xai);
}

#[test]
fn models_page_keeps_live_claude_ids_and_drops_the_rest() {
    let body = r#"{
        "data": [
            {"type":"model","id":"claude-opus-4-8","display_name":"Claude Opus 4.8","max_input_tokens":200000,"capabilities":{"image_input":{"supported":true},"thinking":{"supported":true},"pdf_input":{"supported":true},"effort":{"supported":true,"high":{"supported":true},"xhigh":{"supported":true}}}},
            {"type":"model","id":"claude-sonnet-4-5-20250929","display_name":"Claude Sonnet 4.5","max_input_tokens":200000},
            {"type":"model","id":"claude-3-haiku-20240307","display_name":"Claude Haiku 3"},
            {"type":"model","id":"claude-retired","display_name":"Gone","lifecycle":"retired"},
            {"type":"model","id":"not-a-claude","display_name":"Tutor"}
        ],
        "has_more": true,
        "last_id": "claude-3-haiku-20240307"
    }"#;
    let (rows, last_id, has_more) = parse_models_page(body);
    assert_eq!(
        rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        [
            "claude-opus-4-8",
            "claude-sonnet-4-5-20250929",
            "claude-3-haiku-20240307"
        ]
    );
    assert_eq!(
        rows[0]
            .efforts
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        ["high", "xhigh"]
    );
    assert_eq!(
        rows[0].capabilities,
        ["vision", "thinking", "pdf", "effort"]
    );
    assert_eq!(rows[1].name, "Claude Sonnet 4.5");
    assert_eq!(rows[1].context_window, Some(200_000));
    assert!(rows[1].efforts.iter().any(|row| row.id == "max"));
    assert_eq!(rows[2].efforts.len(), 3);
    assert!(rows.iter().all(|row| row.provider == PROVIDER_ANTHROPIC));
    assert_eq!(last_id.as_deref(), Some("claude-3-haiku-20240307"));
    assert!(has_more);
    assert!(parse_models_page("nope").0.is_empty());
}

#[test]
fn max_tokens_follow_the_catalog() {
    assert_eq!(max_tokens_for("claude-fable-5-1"), 128_000);
    assert_eq!(max_tokens_for("claude-opus-4-8"), 128_000);
    assert_eq!(max_tokens_for("claude-sonnet-4-6"), 64_000);
    assert_eq!(max_tokens_for("claude-haiku-4-5"), 64_000);
    assert_eq!(max_tokens_for("claude-opus-4-8-latest"), 128_000);
    assert_eq!(max_tokens_for("claude-3-haiku-20240307"), 64_000);
}

#[test]
fn haiku_uses_a_fixed_thinking_budget_and_newer_models_stay_adaptive() {
    assert!(supports_adaptive_thinking("claude-opus-4-8"));
    assert!(supports_adaptive_thinking("claude-sonnet-4-6"));
    assert!(supports_adaptive_thinking("claude-sonnet-4-5-20250929"));
    assert!(!supports_adaptive_thinking("claude-haiku-4-5"));
    assert!(!supports_adaptive_thinking("claude-3-haiku-20240307"));
    assert_eq!(manual_thinking_budget("claude-haiku-4-5", None), None);
    assert_eq!(
        manual_thinking_budget("claude-haiku-4-5", Some("low")),
        Some(1_024)
    );
    assert_eq!(
        manual_thinking_budget("claude-haiku-4-5", Some("medium")),
        Some(4_096)
    );
    assert_eq!(
        manual_thinking_budget("claude-haiku-4-5", Some("high")),
        Some(8_192)
    );
    assert_eq!(
        manual_thinking_budget("claude-opus-4-8", Some("high")),
        None
    );
    assert_eq!(
        manual_thinking_budget("claude-haiku-4-5", Some("nope")),
        None
    );
}

fn sample_tools(include_journey: bool) -> serde_json::Value {
    crate::dev::chat::tools_json(include_journey)
}

#[test]
fn system_messages_leave_the_array_and_effort_is_optional() {
    let body = to_messages_body(
        &serde_json::json!([
            { "role": "system", "content": "You are Claude." },
            { "role": "system", "content": "Be brief." },
            { "role": "user", "content": "hi" }
        ]),
        "claude-sonnet-4-6",
        None,
        &sample_tools(false),
    );
    assert_eq!(body["system"], "You are Claude.\n\nBe brief.");
    assert_eq!(body["max_tokens"], 64_000);
    assert_eq!(body["stream"], true);
    assert_eq!(body["thinking"]["type"], "adaptive");
    assert!(body.get("output_config").is_none());
    let haiku = to_messages_body(
        &serde_json::json!([{ "role": "user", "content": "hi" }]),
        "claude-haiku-4-5",
        None,
        &sample_tools(false),
    );
    assert!(haiku.get("thinking").is_none());
    assert!(haiku.get("output_config").is_none());
    assert_eq!(body["messages"].as_array().map(|rows| rows.len()), Some(1));
    assert_eq!(body["messages"][0]["role"], "user");
    assert_eq!(body["messages"][0]["content"][0]["text"], "hi");
    assert_eq!(body["tool_choice"]["type"], "auto");
    let names: Vec<_> = body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| row["name"].as_str())
        .collect();
    assert!(names.contains(&"read_file"));
    assert!(names.contains(&"web_search"));
    assert!(!names.contains(&"update_journey_knowledge"));
    assert!(body["tools"][0].get("input_schema").is_some());
    assert!(body["tools"][0].get("function").is_none());
}

#[test]
fn effort_is_included_and_journey_tools_stay_out() {
    let body = to_messages_body(
        &serde_json::json!([{ "role": "user", "content": "go" }]),
        "claude-haiku-4-5",
        Some("high"),
        &sample_tools(true),
    );
    assert!(body.get("output_config").is_none());
    assert_eq!(body["thinking"]["type"], "enabled");
    assert_eq!(body["thinking"]["budget_tokens"], 8_192);
    assert_eq!(body["max_tokens"], 64_000);
    let opus = to_messages_body(
        &serde_json::json!([{ "role": "user", "content": "go" }]),
        "claude-opus-4-8",
        Some("high"),
        &sample_tools(false),
    );
    assert_eq!(opus["thinking"]["type"], "adaptive");
    assert_eq!(opus["output_config"]["effort"], "high");
    assert!(opus
        .get("thinking")
        .and_then(|row| row.get("budget_tokens"))
        .is_none());
    assert!(body.get("system").is_none());
    let names: Vec<_> = body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| row["name"].as_str())
        .collect();
    // Journeys are no longer sent, even when the caller asks for them.
    assert!(!names.contains(&"update_journey_knowledge"));
}

#[test]
fn image_data_urls_become_base64_blocks_and_remote_urls_are_dropped() {
    let body = to_messages_body(
        &serde_json::json!([{
            "role": "user",
            "content": [
                { "type": "text", "text": "what is this" },
                { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,abc" } },
                { "type": "image_url", "image_url": { "url": "https://example.com/a.jpg" } }
            ]
        }]),
        "claude-opus-4-8",
        Some("  "),
        &serde_json::json!([]),
    );
    assert!(body.get("output_config").is_none());
    assert_eq!(
        body["messages"][0]["content"]
            .as_array()
            .map(|rows| rows.len()),
        Some(2)
    );
    assert_eq!(body["messages"][0]["content"][1]["type"], "image");
    assert_eq!(
        body["messages"][0]["content"][1]["source"]["media_type"],
        "image/jpeg"
    );
    assert_eq!(body["messages"][0]["content"][1]["source"]["data"], "abc");
}

#[test]
fn tool_round_trip_groups_results_and_repairs_arguments() {
    let body = to_messages_body(
        &serde_json::json!([
            {
                "role": "assistant",
                "content": null,
                "tool_calls": [
                    {
                        "id": "toolu_1",
                        "type": "function",
                        "function": { "name": "read_file", "arguments": "{\"path\":\"a.rs\"}" }
                    },
                    {
                        "id": "toolu_2",
                        "type": "function",
                        "function": { "name": "list_dir", "arguments": "not-json" }
                    },
                    {
                        "id": "toolu_3",
                        "type": "function",
                        "function": { "name": "git_status", "arguments": "" }
                    }
                ]
            },
            { "role": "tool", "tool_call_id": "toolu_1", "content": "fn main() {}" },
            { "role": "tool", "tool_call_id": "toolu_2", "content": "[]" }
        ]),
        "claude-sonnet-4-6",
        Some("medium"),
        &sample_tools(false),
    );
    let assistant = &body["messages"][0];
    assert_eq!(
        assistant["content"].as_array().map(|rows| rows.len()),
        Some(3)
    );
    assert!(assistant["content"]
        .as_array()
        .unwrap()
        .iter()
        .all(|block| block["type"] == "tool_use"));
    assert_eq!(assistant["content"][0]["input"]["path"], "a.rs");
    assert_eq!(assistant["content"][1]["input"]["raw"], "not-json");
    assert_eq!(assistant["content"][2]["input"], serde_json::json!({}));
    let results = &body["messages"][1];
    assert_eq!(results["role"], "user");
    assert_eq!(
        results["content"].as_array().map(|rows| rows.len()),
        Some(2)
    );
    assert_eq!(results["content"][0]["type"], "tool_result");
    assert_eq!(results["content"][0]["tool_use_id"], "toolu_1");
    assert_eq!(results["content"][1]["tool_use_id"], "toolu_2");
}

#[test]
fn sse_fixture_emits_text_thinking_usage_and_a_tool_call() {
    let lines = [
        r#"{"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}"#,
        r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
        r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Look "}}"#,
        r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"first."}}"#,
        r#"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-1"}}"#,
        r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}"#,
        r#"{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_9","name":"read_file"}}"#,
        r#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#,
        r#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"a.rs\"}"}}"#,
        r#"{"type":"message_delta","usage":{"output_tokens":20}}"#,
        r#"{"type":"message_stop"}"#,
    ];
    let mut tools = ToolAccum::default();
    let mut thinking = ThinkingAccum::default();
    let mut deltas = Vec::new();
    let mut thoughts = Vec::new();
    let mut usages = Vec::new();
    let mut stopped = false;
    for line in lines {
        let Some(piece) = parse_sse_data(line) else {
            continue;
        };
        apply_tool_piece(&mut tools, &piece);
        apply_thinking_piece(&mut thinking, &piece);
        match piece {
            SsePiece::Delta(text) => deltas.push(text),
            SsePiece::Reasoning(text) => thoughts.push(text),
            SsePiece::Usage {
                prompt_tokens,
                completion_tokens,
                ..
            } => {
                usages.push((prompt_tokens, completion_tokens));
            }
            SsePiece::Stop => stopped = true,
            _ => {}
        }
    }
    assert_eq!(deltas.concat(), "Hi");
    assert_eq!(thoughts.concat(), "Look first.");
    assert_eq!(usages, vec![(12, 1), (u64::MAX, 20)]);
    assert_eq!(merge_usage(Some((12, 1)), u64::MAX, 20), (12, 20));
    assert!(stopped);
    let calls = finished_tools(&tools);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "toolu_9");
    assert_eq!(calls[0].1, "read_file");
    assert_eq!(calls[0].2, "{\"path\":\"a.rs\"}");
    let kept = finished_thinking(&thinking);
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].kind, "thinking");
    assert_eq!(kept[0].thinking, "Look first.");
    assert_eq!(kept[0].signature, "sig-1");
    assert!(parse_sse_data("").is_none());
    assert!(parse_sse_data("[DONE]").is_none());
}

#[test]
fn signed_thinking_is_replayed_before_text_and_unsigned_text_is_dropped() {
    let body = to_messages_body(
        &serde_json::json!([
            {
                "role": "assistant",
                "content": "Done.",
                "thinking": [
                    { "type": "thinking", "thinking": "Look first.", "signature": "sig-1" },
                    { "type": "redacted_thinking", "data": "opaque" },
                    { "type": "thinking", "thinking": "no signature" }
                ],
                "tool_calls": [
                    {
                        "id": "toolu_1",
                        "type": "function",
                        "function": { "name": "read_file", "arguments": "{\"path\":\"a.rs\"}" }
                    }
                ]
            },
            { "role": "tool", "tool_call_id": "toolu_1", "content": "fn main() {}" }
        ]),
        "claude-sonnet-4-6",
        Some("high"),
        &sample_tools(false),
    );
    let blocks = body["messages"][0]["content"].as_array().unwrap();
    assert_eq!(blocks[0]["type"], "thinking");
    assert_eq!(blocks[0]["thinking"], "Look first.");
    assert_eq!(blocks[0]["signature"], "sig-1");
    assert_eq!(blocks[1]["type"], "redacted_thinking");
    assert_eq!(blocks[1]["data"], "opaque");
    assert_eq!(blocks[2]["type"], "text");
    assert_eq!(blocks[3]["type"], "tool_use");
    assert_eq!(blocks.len(), 4);
}

#[test]
fn claude_does_not_use_the_xai_endpoint() {
    assert_eq!(provider_for("claude-sonnet-4-6"), Provider::Anthropic);
    assert_ne!(MESSAGES_URL, crate::grok_cli::endpoint(false));
    assert_ne!(MESSAGES_URL, crate::grok_cli::endpoint(true));
    assert_eq!(http_error_message(401, "nope"), KEY_REJECTED);
    let other = http_error_message(400, "bad model");
    assert!(other.starts_with("Anthropic error 400:"));
    assert!(other.contains("bad model"));
}
