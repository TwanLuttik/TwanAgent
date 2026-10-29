//! One model round on the machine that owns the project.
//!
//! The desktop does not call the model for a hosted turn. This module reads the
//! provider keys copied onto the server and streams the reply itself. Each provider
//! lives in its own file. The request body and SSE parsing come from `crate::providers`,
//! which the desktop uses too.

mod anthropic;
mod minimax;
mod xai;

use std::io::BufRead;

use serde_json::Value;

use crate::error::{Error, Result};
use crate::keys::ProviderKeys;
use crate::providers::{self, ProviderId};

/// Token counts from one model round. Absent when the provider sent none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RoundUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cache_read_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Round {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub error: Option<String>,
    pub usage: Option<RoundUsage>,
    /// Not streamed to the desktop. A summary uses it when the reply text is empty.
    pub reasoning: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// Tools the server can run next to the project files. The GUI does not get these calls.
pub fn tool_defs() -> Value {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": "List files and folders relative to the workspace root.",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "grep",
                "description": "Search file contents in the workspace. Returns matching lines as path:line:text. The pattern is a case-insensitive substring, not a regular expression. Every text file is searched, including .ts and .tsx, unless glob says otherwise. Skips node_modules, target, dist, build, and .git. A miss means the substring was not found. It does not mean a file type was skipped. Use this instead of a shell search.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Literal text to find. Matched case-insensitively. Not a regular expression: dots and brackets match themselves." },
                        "path": { "type": "string", "description": "Folder or file relative to the workspace. Empty searches the whole workspace." },
                        "glob": { "type": "string", "description": "Optional file glob, such as *.rs, *.ts, or src/**/*.tsx. * matches any file name, including .ts and .tsx. Empty searches every text file." }
                    },
                    "required": ["pattern"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "glob",
                "description": "Find files and folders by path pattern. Returns workspace-relative paths. Skips node_modules, target, dist, build, and .git. Use this instead of a shell find.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Glob such as **/*.ts or src/**/mod.rs. * stays in one segment. ** crosses folders." },
                        "path": { "type": "string", "description": "Folder relative to the workspace. Empty starts at the workspace root." }
                    },
                    "required": ["pattern"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a UTF-8 text file in the workspace. Optional offset and limit return a 1-based line range. Use them for large files instead of reading everything. Returned lines are prefixed with their line numbers.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "offset": { "type": "integer", "description": "1-based starting line. Omit to start at line 1." },
                        "limit": { "type": "integer", "description": "Max number of lines to return. Omit to read to the end." }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Create or overwrite a UTF-8 text file in the workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "contents": { "type": "string" }
                    },
                    "required": ["path", "contents"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "Replace one unique occurrence of old_string with new_string.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "old_string": { "type": "string" },
                        "new_string": { "type": "string" }
                    },
                    "required": ["path", "old_string", "new_string"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "load_skill",
                "description": "Read one enabled skill's instructions. Call this before following a skill named in the system prompt.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "Skill name from the system prompt." }
                    },
                    "required": ["name"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "Run a shell command in the workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string" },
                        "description": { "type": "string" }
                    },
                    "required": ["command", "description"]
                }
            }
        }
    ])
}

pub fn run_round(
    keys: &ProviderKeys,
    model: &str,
    effort: &str,
    messages: &[Value],
    on_delta: &mut dyn FnMut(&str),
) -> Result<Round> {
    let provider = providers::find(model);
    let token = key_for(keys, provider)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|err| Error::Other(format!("could not start the model request: {err}")))?;
    let messages = Value::Array(messages.to_vec());
    let mut tools = tool_defs();
    if let Some(list) = tools.as_array_mut() {
        list.extend(crate::capabilities::current_extra_tools());
    }
    match provider {
        ProviderId::Xai => xai::round(&client, &token, model, effort, &messages, &tools, on_delta),
        ProviderId::Anthropic => anthropic::round(&client, &token, model, effort, &messages, &tools, on_delta),
        ProviderId::Minimax => minimax::round(&client, &token, model, &messages, &tools, on_delta),
    }
}

fn key_for(keys: &ProviderKeys, provider: ProviderId) -> Result<String> {
    let value = match provider {
        ProviderId::Xai => keys.xai.trim(),
        ProviderId::Anthropic => keys.anthropic.trim(),
        ProviderId::Minimax => keys.minimax.trim(),
    };
    if value.is_empty() || value == "local-try" {
        return Err(Error::Other("Copy provider keys to this server in Settings.".into()));
    }
    Ok(value.to_string())
}

pub(super) struct OpenRound {
    text: String,
    reasoning: String,
    pending: String,
    calls: Vec<ToolCall>,
    /// Anthropic content-block index to the tool slot. A thinking block must not shift the tool.
    block_slots: Vec<Option<usize>>,
    stop: bool,
    error: Option<String>,
    usage: Option<RoundUsage>,
}

impl Default for OpenRound {
    fn default() -> Self {
        Self {
            text: String::new(),
            reasoning: String::new(),
            pending: String::new(),
            calls: Vec::new(),
            block_slots: Vec::new(),
            stop: false,
            error: None,
            usage: None,
        }
    }
}

impl OpenRound {
    fn push_text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.text.push_str(text);
        self.pending.push_str(text);
    }

    fn push_reasoning(&mut self, text: &str) {
        if !text.is_empty() {
            self.reasoning.push_str(text);
        }
    }

    /// xAI tool indexes are already tool-relative. Anthropic block indexes are not.
    pub(super) fn ensure_call(&mut self, index: usize) -> &mut ToolCall {
        while self.calls.len() <= index {
            let id = format!("tool_{}", self.calls.len());
            self.calls.push(ToolCall { id, name: String::new(), arguments: String::new() });
        }
        &mut self.calls[index]
    }

    /// One tool for this content block. A later delta for the same block appends to it.
    pub(super) fn tool_block(&mut self, block: usize) -> &mut ToolCall {
        if let Some(Some(slot)) = self.block_slots.get(block).copied() {
            return &mut self.calls[slot];
        }
        while self.block_slots.len() <= block {
            self.block_slots.push(None);
        }
        let slot = self.calls.len();
        let id = format!("tool_{slot}");
        self.calls.push(ToolCall { id, name: String::new(), arguments: String::new() });
        self.block_slots[block] = Some(slot);
        &mut self.calls[slot]
    }

    fn take_delta(&mut self) -> Option<String> {
        if self.pending.is_empty() { None } else { Some(std::mem::take(&mut self.pending)) }
    }

    /// A later usage event fills in only the sides it actually reported.
    pub(super) fn note_usage(&mut self, prompt: Option<u64>, completion: Option<u64>, cache_read: Option<u64>) {
        let usage = self.usage.get_or_insert(RoundUsage::default());
        if let Some(prompt) = prompt.filter(|value| *value != u64::MAX) {
            usage.prompt_tokens = prompt;
        }
        if let Some(completion) = completion.filter(|value| *value != u64::MAX) {
            usage.completion_tokens = completion;
        }
        if let Some(cache_read) = cache_read.filter(|value| *value != u64::MAX) {
            usage.cache_read_tokens = cache_read;
        }
    }

    fn finish(self) -> Round {
        Round {
            text: self.text,
            tool_calls: self.calls.into_iter().filter(|call| !call.name.is_empty()).collect(),
            error: self.error,
            usage: self.usage,
            reasoning: self.reasoning,
        }
    }

    fn has_reply(&self) -> bool {
        !self.text.trim().is_empty()
            || !self.reasoning.trim().is_empty()
            || self.calls.iter().any(|call| !call.name.is_empty())
    }

    /// A provider error with no text or tool call fails the round. One that arrives
    /// after a real reply just ends the stream.
    fn note_failure(&mut self, message: String) {
        if !self.has_reply() {
            self.error = Some(message);
        }
        self.stop = true;
    }
}

pub(super) fn read_sse(
    response: reqwest::blocking::Response,
    on_delta: &mut dyn FnMut(&str),
    parse: fn(&str, &mut OpenRound),
) -> Result<Round> {
    let mut open = OpenRound::default();
    let mut buf = String::new();
    let mut reader = std::io::BufReader::new(response);
    loop {
        buf.clear();
        let read = reader
            .read_line(&mut buf)
            .map_err(|err| Error::Other(format!("model stream failed: {err}")))?;
        if read == 0 {
            break;
        }
        let line = buf.trim();
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            if data == "[DONE]" {
                break;
            }
            continue;
        }
        parse(data, &mut open);
        if let Some(text) = open.take_delta() {
            on_delta(&text);
        }
        if open.stop {
            break;
        }
    }
    Ok(open.finish())
}

pub(super) fn failed(name: &str, status: reqwest::StatusCode, body: &str) -> Round {
    let message = match name {
        "xAI" => crate::providers::xai::http_error_message(status.as_u16(), body),
        "MiniMax" => crate::providers::minimax::http_error_message(status.as_u16(), body),
        _ => crate::providers::anthropic::http_error_message(status.as_u16(), body),
    };
    Round { text: String::new(), tool_calls: Vec::new(), error: Some(message), usage: None, reasoning: String::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_follows_the_model_id() {
        assert_eq!(providers::find("grok-4.6"), ProviderId::Xai);
        assert_eq!(providers::find("claude-sonnet-4-6"), ProviderId::Anthropic);
        assert_eq!(providers::find("MiniMax-M3"), ProviderId::Minimax);
        assert_eq!(providers::find("not-a-model"), ProviderId::Xai);
    }

    #[test]
    fn a_missing_key_does_not_call_the_model() {
        let err = key_for(&ProviderKeys::default(), ProviderId::Xai).unwrap_err();
        assert!(err.to_string().contains("Copy provider keys"));
        let marker = key_for(
            &ProviderKeys { xai: "local-try".into(), ..ProviderKeys::default() },
            ProviderId::Xai,
        );
        assert!(marker.is_err());
    }
}
