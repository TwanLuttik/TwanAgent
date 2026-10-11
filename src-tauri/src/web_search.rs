//! Client-side `web_search`, matching the Grok CLI.
//!
//! The CLI exposes `web_search` as a normal function tool. When the model calls
//! it, the CLI makes its own Responses API request with a server-side
//! `web_search` tool, then returns the answer and citations as the tool result.
//! TwanAgent's chat loop stays on chat completions, so this module is that
//! nested call.

use std::time::Duration;

use futures_util::StreamExt;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::dev::types::DevWebSearchEvent;
use crate::error::{Error, Result};
use crate::grok_cli::{self, GrokAuth};

pub const DEFAULT_MODEL: &str = "grok-4.6";
/// The web-search API rejects more than five domains. The CLI keeps the first five.
pub const MAX_DOMAINS: usize = 5;
const QUERY_CAP: usize = 2_000;
const ANSWER_CAP: usize = 24_000;
const TIMEOUT: Duration = Duration::from_secs(45);

const INSTRUCTIONS: &str = "\
Answer the user's web search query using the web_search tool. \
Search before you answer. Be concise and factual. \
Cite sources with their URLs. If the search returns nothing useful, say so.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebSearchRequest {
    pub query: String,
    pub allowed_domains: Vec<String>,
    pub excluded_domains: Vec<String>,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebCitation {
    pub url: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebSearchOutput {
    pub query: String,
    pub answer: String,
    pub citations: Vec<WebCitation>,
    pub allowed_domains: Vec<String>,
}

pub fn responses_endpoint(via_cli: bool) -> &'static str {
    if via_cli {
        "https://cli-chat-proxy.grok.com/v1/responses"
    } else {
        "https://api.x.ai/v1/responses"
    }
}

/// Read `[models] web_search`, then `GROK_WEB_SEARCH_MODEL`. Empty means the CLI default.
pub fn configured_model() -> String {
    if let Ok(from_env) = std::env::var("GROK_WEB_SEARCH_MODEL") {
        let from_env = from_env.trim();
        if !from_env.is_empty() {
            return from_env.to_string();
        }
    }
    if let Some(home) = grok_cli::grok_home() {
        if let Ok(src) = std::fs::read_to_string(home.join("config.toml")) {
            if let Some(model) = grok_cli::parse_toml_quoted(&src, "models", "web_search") {
                let model = model.trim();
                if !model.is_empty() {
                    return model.to_string();
                }
            }
        }
    }
    DEFAULT_MODEL.to_string()
}

/// `[toolset.web_search]` domain policy. An allowlist wins over a blocklist, as in the CLI.
pub fn configured_domains() -> (Vec<String>, Vec<String>) {
    let Some(home) = grok_cli::grok_home() else {
        return (Vec::new(), Vec::new());
    };
    let Ok(src) = std::fs::read_to_string(home.join("config.toml")) else {
        return (Vec::new(), Vec::new());
    };
    let allowed = parse_toml_string_array(&src, "toolset.web_search", "allowed_domains");
    if !allowed.is_empty() {
        return (cap_domains(allowed), Vec::new());
    }
    let excluded = parse_toml_string_array(&src, "toolset.web_search", "excluded_domains");
    (Vec::new(), cap_domains(excluded))
}

pub fn normalize_domains(raw: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for item in raw {
        let domain = normalize_domain(item);
        if domain.is_empty() || out.iter().any(|seen| seen == &domain) {
            continue;
        }
        out.push(domain);
        if out.len() == MAX_DOMAINS {
            break;
        }
    }
    out
}

fn cap_domains(domains: Vec<String>) -> Vec<String> {
    normalize_domains(&domains)
}

fn normalize_domain(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches(|c| c == '"' || c == '\'' || c == ',');
    let without_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    let host = without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    let labels: Vec<&str> = host.split('.').collect();
    let ok = labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        });
    if !ok {
        return String::new();
    }
    host.to_string()
}

/// Model arguments, with the configured domain policy applied on top.
/// A configured allowlist or blocklist replaces the model's own `allowed_domains`.
pub fn resolve_request(arguments: &str) -> std::result::Result<WebSearchRequest, String> {
    let args: Value = if arguments.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(arguments).map_err(|_| "web_search arguments were not valid JSON".to_string())?
    };
    let query = args
        .get("query")
        .or_else(|| args.get("search_term"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if query.is_empty() {
        return Err("web_search requires a query".into());
    }
    let query = query.chars().take(QUERY_CAP).collect::<String>();
    let model_domains = string_list(args.get("allowed_domains"));
    let (config_allowed, config_excluded) = configured_domains();
    let (allowed_domains, excluded_domains) = if !config_allowed.is_empty() {
        (config_allowed, Vec::new())
    } else if !config_excluded.is_empty() {
        (Vec::new(), config_excluded)
    } else {
        (normalize_domains(&model_domains), Vec::new())
    };
    Ok(WebSearchRequest {
        query,
        allowed_domains,
        excluded_domains,
        model: configured_model(),
    })
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub fn request_body(req: &WebSearchRequest) -> Value {
    let mut tool = serde_json::json!({ "type": "web_search" });
    if !req.allowed_domains.is_empty() || !req.excluded_domains.is_empty() {
        let mut filters = serde_json::Map::new();
        if !req.allowed_domains.is_empty() {
            filters.insert(
                "allowed_domains".into(),
                Value::Array(req.allowed_domains.iter().cloned().map(Value::String).collect()),
            );
        }
        if !req.excluded_domains.is_empty() {
            filters.insert(
                "excluded_domains".into(),
                Value::Array(req.excluded_domains.iter().cloned().map(Value::String).collect()),
            );
        }
        tool["filters"] = Value::Object(filters);
    }
    serde_json::json!({
        "model": req.model,
        "instructions": INSTRUCTIONS,
        "input": req.query,
        "tools": [tool],
        "tool_choice": "auto",
        "store": false,
    })
}

pub fn format_output(output: &WebSearchOutput) -> String {
    let mut text = format!("Web search results for: \"{}\"\n\n", output.query);
    if output.answer.trim().is_empty() {
        text.push_str("No search results found.");
    } else {
        text.push_str(output.answer.trim());
    }
    if !output.citations.is_empty() {
        text.push_str("\n\nSources:");
        for (index, citation) in output.citations.iter().enumerate() {
            text.push_str(&format!("\n[{}] ", index + 1));
            if !citation.title.is_empty() && citation.title != citation.url {
                text.push_str(&citation.title);
                text.push_str(" — ");
            }
            text.push_str(&citation.url);
        }
    }
    if !output.allowed_domains.is_empty() {
        text.push_str("\n\nLimited to: ");
        text.push_str(&output.allowed_domains.join(", "));
    }
    text
}

pub fn parse_response(query: &str, allowed_domains: &[String], body: &Value) -> WebSearchOutput {
    if let Some(err) = body.get("error").filter(|v| !v.is_null()) {
        let message = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("web search failed");
        return WebSearchOutput {
            query: query.to_string(),
            answer: format!("Web search failed: {message}"),
            citations: Vec::new(),
            allowed_domains: allowed_domains.to_vec(),
        };
    }
    let mut answer = output_text(body);
    if answer.trim().is_empty() {
        answer = "No search results found.".into();
    }
    let answer = answer.chars().take(ANSWER_CAP).collect();
    WebSearchOutput {
        query: query.to_string(),
        answer,
        citations: citations_from(body),
        allowed_domains: allowed_domains.to_vec(),
    }
}

fn output_text(body: &Value) -> String {
    if let Some(text) = body.get("output_text").and_then(|v| v.as_str()) {
        if !text.trim().is_empty() {
            return text.to_string();
        }
    }
    let Some(items) = body.get("output").and_then(|v| v.as_array()) else {
        return String::new();
    };
    let mut parts = Vec::new();
    for item in items {
        let kind = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if kind != "message" {
            continue;
        }
        let Some(content) = item.get("content").and_then(|v| v.as_array()) else {
            continue;
        };
        for part in content {
            let part_type = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if part_type != "output_text" && part_type != "text" {
                continue;
            }
            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                if !text.is_empty() {
                    parts.push(text.to_string());
                }
            }
        }
    }
    parts.join("\n")
}

fn citations_from(body: &Value) -> Vec<WebCitation> {
    let mut out = Vec::new();
    collect_citations(body, &mut out);
    let mut unique = Vec::new();
    for citation in out {
        if unique.iter().any(|seen: &WebCitation| seen.url == citation.url) {
            continue;
        }
        unique.push(citation);
        if unique.len() == 12 {
            break;
        }
    }
    unique
}

fn collect_citations(value: &Value, out: &mut Vec<WebCitation>) {
    match value {
        Value::Array(rows) => {
            for row in rows {
                collect_citations(row, out);
            }
        }
        Value::Object(map) => {
            let kind = map.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if kind == "url_citation" {
                if let Some(citation) = citation_from_map(map) {
                    out.push(citation);
                }
            }
            if let Some(url) = map.get("url").and_then(|v| v.as_str()) {
                if looks_like_result(kind, map) {
                    let title = map
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    push_citation(out, url, &title);
                }
            }
            for (key, child) in map {
                if key == "url" || key == "title" {
                    continue;
                }
                collect_citations(child, out);
            }
        }
        _ => {}
    }
}

fn looks_like_result(kind: &str, map: &serde_json::Map<String, Value>) -> bool {
    matches!(
        kind,
        "url_citation" | "web_search_result" | "search_result" | "source"
    ) || map.contains_key("title")
}

fn citation_from_map(map: &serde_json::Map<String, Value>) -> Option<WebCitation> {
    let url = map.get("url").and_then(|v| v.as_str()).unwrap_or("").trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return None;
    }
    let title = map
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Some(WebCitation {
        url: url.to_string(),
        title,
    })
}

fn push_citation(out: &mut Vec<WebCitation>, url: &str, title: &str) {
    let url = url.trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return;
    }
    out.push(WebCitation {
        url: url.to_string(),
        title: title.to_string(),
    });
}

/// Minimal TOML string-array reader for one section. Enough for `allowed_domains = ["a", "b"]`.
fn parse_toml_string_array(src: &str, section: &str, key: &str) -> Vec<String> {
    let mut in_section = false;
    let header = format!("[{section}]");
    for raw in src.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            in_section = line.eq_ignore_ascii_case(&header);
            continue;
        }
        if !in_section {
            continue;
        }
        let Some((left, right)) = line.split_once('=') else {
            continue;
        };
        if left.trim() != key {
            continue;
        }
        let value = right.split('#').next().unwrap_or("").trim();
        let Some(inner) = value.strip_prefix('[').and_then(|s| s.strip_suffix(']')) else {
            return Vec::new();
        };
        return inner
            .split(',')
            .filter_map(|part| {
                let part = part.trim().trim_matches('"').trim_matches('\'').trim();
                if part.is_empty() {
                    None
                } else {
                    Some(part.to_string())
                }
            })
            .collect();
    }
    Vec::new()
}

pub async fn search(app: &AppHandle, data_dir: &std::path::Path, stream_id: &str, arguments: &str) -> Result<String> {
    let req = resolve_request(arguments).map_err(Error::Other)?;
    let Some(auth) = grok_cli::resolve_auth(data_dir) else {
        return Err(Error::Other(
            "Grok isn’t signed in. Run grok login, or add an xAI API key in Settings.".into(),
        ));
    };
    emit_scope(app, stream_id, &req);
    let output = execute(app, stream_id, &auth, &req).await?;
    Ok(format_output(&output))
}

fn emit_scope(app: &AppHandle, stream_id: &str, req: &WebSearchRequest) {
    if req.allowed_domains.is_empty() && req.excluded_domains.is_empty() {
        return;
    }
    let text = if !req.allowed_domains.is_empty() {
        format!("Limited to {}", req.allowed_domains.join(", "))
    } else {
        format!("Excluding {}", req.excluded_domains.join(", "))
    };
    let _ = app.emit(
        "dev-web-search",
        DevWebSearchEvent {
            stream_id: stream_id.into(),
            kind: "scope".into(),
            host: None,
            text: Some(text),
        },
    );
}

fn emit_host(app: &AppHandle, stream_id: &str, host: &str) {
    let host = host.trim();
    if host.is_empty() {
        return;
    }
    let _ = app.emit(
        "dev-web-search",
        DevWebSearchEvent {
            stream_id: stream_id.into(),
            kind: "site".into(),
            host: Some(host.to_string()),
            text: None,
        },
    );
}

async fn execute(
    app: &AppHandle,
    stream_id: &str,
    auth: &GrokAuth,
    req: &WebSearchRequest,
) -> Result<WebSearchOutput> {
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| Error::Other(format!("web search client failed: {e}")))?;
    let mut body = request_body(req);
    body["stream"] = Value::Bool(true);
    let mut http = client
        .post(responses_endpoint(auth.via_cli))
        .bearer_auth(&auth.token)
        .header("content-type", "application/json")
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .header(reqwest::header::ACCEPT_ENCODING, "identity");
    if auth.via_cli {
        let headers = grok_cli::cli_proxy_headers(&grok_cli::cached_cli_version());
        http = http
            .header("x-grok-client-version", headers.client_version)
            .header("X-XAI-Token-Auth", headers.token_auth)
            .header("x-grok-client-identifier", headers.client_identifier)
            .header(reqwest::header::USER_AGENT, headers.user_agent);
    }
    let resp = http
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                Error::Other("Web search timed out.".into())
            } else {
                Error::Other(format!("Web search failed: {e}"))
            }
        })?;
    let status = resp.status();
    if status.as_u16() == 401 {
        let _ = resp.text().await;
        return Err(Error::Other(
            if auth.via_cli {
                "Grok CLI login expired. Run grok login, or add an API key in Settings.".into()
            } else {
                "xAI rejected the API key.".into()
            },
        ));
    }
    if !status.is_success() {
        let detail = resp.text().await.unwrap_or_default();
        let detail = detail.chars().take(300).collect::<String>();
        return Err(Error::Other(format!("Web search failed ({status}): {detail}")));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if content_type.contains("text/event-stream") {
        return read_search_stream(app, stream_id, req, resp).await;
    }
    let text = resp.text().await.unwrap_or_default();
    let body: Value = serde_json::from_str(&text)
        .map_err(|_| Error::Other("Web search returned a response that could not be read.".into()))?;
    emit_hosts(app, stream_id, &body);
    Ok(parse_response(&req.query, &req.allowed_domains, &body))
}

fn emit_hosts(app: &AppHandle, stream_id: &str, body: &Value) {
    for host in hosts_from(body) {
        emit_host(app, stream_id, &host);
    }
}

async fn read_search_stream(
    app: &AppHandle,
    stream_id: &str,
    req: &WebSearchRequest,
    resp: reqwest::Response,
) -> Result<WebSearchOutput> {
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut answer = String::new();
    let mut hosts: Vec<String> = Vec::new();
    let mut citations: Vec<WebCitation> = Vec::new();
    let mut failed = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            if e.is_timeout() {
                Error::Other("Web search timed out.".into())
            } else {
                Error::Other(format!("Web search failed: {e}"))
            }
        })?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(idx) = buf.find('\n') {
            let line = buf[..idx].trim().to_string();
            buf.drain(..=idx);
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(json) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if let Some(piece) = response_text_delta(&json) {
                answer.push_str(&piece);
            }
            if failed.is_empty() {
                if let Some(message) = response_error(&json) {
                    failed = message;
                }
            }
            for citation in citations_from(&json) {
                let Some(host) = host_of(&citation.url) else {
                    continue;
                };
                if hosts.iter().any(|seen| seen == &host) {
                    continue;
                }
                hosts.push(host.clone());
                citations.push(citation);
                emit_host(app, stream_id, &host);
            }
        }
    }
    if !failed.is_empty() && answer.trim().is_empty() {
        answer = format!("Web search failed: {failed}");
    }
    if answer.trim().is_empty() {
        answer = "No search results found.".into();
    }
    let answer = answer.chars().take(ANSWER_CAP).collect();
    Ok(WebSearchOutput {
        query: req.query.clone(),
        answer,
        citations,
        allowed_domains: req.allowed_domains.clone(),
    })
}

fn response_text_delta(json: &Value) -> Option<String> {
    let kind = json.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if kind == "response.output_text.delta" {
        return json
            .get("delta")
            .and_then(|v| v.as_str())
            .filter(|text| !text.is_empty())
            .map(str::to_string);
    }
    None
}

fn response_error(json: &Value) -> Option<String> {
    let kind = json.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if kind != "response.failed" && kind != "error" {
        return None;
    }
    json.get("error")
        .or_else(|| json.get("response").and_then(|r| r.get("error")))
        .and_then(|err| err.get("message").and_then(|v| v.as_str()))
        .map(str::to_string)
}

/// Website hosts mentioned by a Responses event or a finished response.
pub fn hosts_from(value: &Value) -> Vec<String> {
    let mut urls = Vec::new();
    collect_result_urls(value, &mut urls);
    let mut hosts = Vec::new();
    for url in urls {
        let Some(host) = host_of(&url) else {
            continue;
        };
        if hosts.iter().any(|seen| seen == &host) {
            continue;
        }
        hosts.push(host);
        if hosts.len() == 12 {
            break;
        }
    }
    hosts
}

fn collect_result_urls(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Array(rows) => {
            for row in rows {
                collect_result_urls(row, out);
            }
        }
        Value::Object(map) => {
            let kind = map.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(url) = map.get("url").and_then(|v| v.as_str()) {
                if looks_like_result(kind, map) {
                    out.push(url.to_string());
                }
            }
            for (key, child) in map {
                if key == "url" {
                    continue;
                }
                collect_result_urls(child, out);
            }
        }
        _ => {}
    }
}

pub fn host_of(url: &str) -> Option<String> {
    let rest = url
        .trim()
        .strip_prefix("https://")
        .or_else(|| url.trim().strip_prefix("http://"))?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("").trim();
    let host = host.strip_prefix("www.").unwrap_or(host);
    let domain = normalize_domain(host);
    if domain.is_empty() {
        None
    } else {
        Some(domain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_follow_cli_and_api_key_auth() {
        assert_eq!(
            responses_endpoint(true),
            "https://cli-chat-proxy.grok.com/v1/responses"
        );
        assert_eq!(responses_endpoint(false), "https://api.x.ai/v1/responses");
    }

    #[test]
    fn domains_are_normalized_and_capped_at_five() {
        let got = normalize_domains(&[
            " https://WWW.Docs.X.AI/guide ".into(),
            "docs.x.ai".into(),
            "not a domain".into(),
            ".example.com".into(),
            "docs..x.ai".into(),
            "arxiv.org".into(),
            "example.com".into(),
            "rust-lang.org".into(),
            "developer.mozilla.org".into(),
            "sixth.example".into(),
        ]);
        assert_eq!(
            got,
            vec![
                "docs.x.ai",
                "arxiv.org",
                "example.com",
                "rust-lang.org",
                "developer.mozilla.org",
            ]
        );
    }

    #[test]
    fn request_uses_query_or_search_term_and_server_side_tool() {
        let req = resolve_request(r#"{"search_term":"  rust 2024 edition  "}"#).unwrap();
        assert_eq!(req.query, "rust 2024 edition");
        let body = request_body(&WebSearchRequest {
            query: "rust 2024 edition".into(),
            allowed_domains: vec!["doc.rust-lang.org".into()],
            excluded_domains: Vec::new(),
            model: "grok-4.6".into(),
        });
        assert_eq!(body["model"], "grok-4.6");
        assert_eq!(body["input"], "rust 2024 edition");
        assert_eq!(body["tools"][0]["type"], "web_search");
        assert_eq!(body["tools"][0]["filters"]["allowed_domains"][0], "doc.rust-lang.org");
        assert!(body.get("stream").is_none());
    }

    #[test]
    fn empty_query_is_rejected() {
        assert!(resolve_request("{}").is_err());
        assert!(resolve_request(r#"{"query":"  "}"#).is_err());
    }

    #[test]
    fn response_parser_keeps_answer_and_unique_citations() {
        let body = serde_json::json!({
            "output_text": "Rust 2024 is the current edition.",
            "output": [{
                "type": "message",
                "content": [{
                    "type": "output_text",
                    "text": "Rust 2024 is the current edition.",
                    "annotations": [
                        { "type": "url_citation", "url": "https://doc.rust-lang.org/edition-guide/", "title": "Edition Guide" },
                        { "type": "url_citation", "url": "https://doc.rust-lang.org/edition-guide/", "title": "Edition Guide" }
                    ]
                }]
            }]
        });
        let parsed = parse_response("rust edition", &[], &body);
        assert_eq!(parsed.answer, "Rust 2024 is the current edition.");
        assert_eq!(parsed.citations.len(), 1);
        assert_eq!(parsed.citations[0].title, "Edition Guide");
        let formatted = format_output(&parsed);
        assert!(formatted.starts_with("Web search results for: \"rust edition\""));
        assert!(formatted.contains("[1] Edition Guide — https://doc.rust-lang.org/edition-guide/"));
    }

    #[test]
    fn hosts_come_from_search_actions_without_duplicates() {
        let event = serde_json::json!({
            "type": "response.output_item.done",
            "item": {
                "type": "web_search_call",
                "action": {
                    "type": "search",
                    "query": "donuts",
                    "sources": [
                        { "url": "https://www.seriouseats.com/donuts", "title": "Guide" },
                        { "url": "https://seriouseats.com/other", "title": "Other" },
                        { "url": "https://www.kingarthur.com/recipes", "title": "Recipe" }
                    ]
                }
            }
        });
        assert_eq!(
            hosts_from(&event),
            vec!["seriouseats.com", "kingarthur.com"]
        );
        assert_eq!(host_of("https://www.seriouseats.com/donuts").as_deref(), Some("seriouseats.com"));
        assert_eq!(host_of("not a url"), None);
    }

    #[test]
    fn action_sources_are_citations_when_there_is_no_annotation() {
        let body = serde_json::json!({
            "output": [
                {
                    "type": "web_search_call",
                    "action": {
                        "type": "search",
                        "query": "rust edition",
                        "sources": [
                            { "url": "https://blog.rust-lang.org/2024/05/02/edition.html", "title": "Announcing Rust 2024" }
                        ]
                    }
                },
                {
                    "type": "message",
                    "content": [{ "type": "output_text", "text": "The edition shipped." }]
                }
            ]
        });
        let parsed = parse_response("rust edition", &["blog.rust-lang.org".into()], &body);
        assert_eq!(parsed.citations.len(), 1);
        assert!(format_output(&parsed).contains("Limited to: blog.rust-lang.org"));
    }

    #[test]
    fn toml_domain_lists_stop_at_the_section() {
        let src = r#"
[toolset.web_fetch]
allowed_domains = ["docs.rs"]

[toolset.web_search]
allowed_domains = ["docs.x.ai", "arxiv.org"]
excluded_domains = ["reddit.com"]
"#;
        assert_eq!(
            parse_toml_string_array(src, "toolset.web_search", "allowed_domains"),
            vec!["docs.x.ai", "arxiv.org"]
        );
        assert_eq!(
            parse_toml_string_array(src, "toolset.web_search", "excluded_domains"),
            vec!["reddit.com"]
        );
        assert!(parse_toml_string_array(src, "models", "web_search").is_empty());
    }
}
