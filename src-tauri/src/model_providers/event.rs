use serde::Serialize;

use crate::dev::types::{DevChatUsage, DevToolCall};

/// Signed thinking that must be replayed unchanged. Only Anthropic emits it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThinkingBlock {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub thinking: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub signature: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub data: String,
}

/// One piece of a provider stream, after that provider has parsed its own wire format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamPiece {
    Delta(String),
    Reasoning(String),
    /// `u64::MAX` means "keep the previous count" for that side.
    Usage {
        prompt_tokens: u64,
        completion_tokens: u64,
    },
    ToolStart {
        index: u32,
        id: String,
        name: String,
    },
    ToolDelta {
        index: u32,
        partial: String,
    },
    ThinkingStart {
        index: u32,
    },
    RedactedThinking {
        index: u32,
        data: String,
    },
    ThinkingSignature {
        index: u32,
        signature: String,
    },
    Stop,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenTool {
    pub index: u32,
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ToolAccum {
    pub(crate) rows: Vec<OpenTool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OpenThinking {
    index: u32,
    redacted: bool,
    thinking: String,
    signature: String,
    data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ThinkingAccum {
    rows: Vec<OpenThinking>,
}

pub fn merge_usage(prev: Option<(u64, u64)>, prompt_tokens: u64, completion_tokens: u64) -> (u64, u64) {
    let (prev_prompt, prev_completion) = prev.unwrap_or((0, 0));
    (
        if prompt_tokens == u64::MAX { prev_prompt } else { prompt_tokens },
        if completion_tokens == u64::MAX { prev_completion } else { completion_tokens },
    )
}

pub fn apply_tool(tools: &mut ToolAccum, piece: &StreamPiece) {
    match piece {
        StreamPiece::ToolStart { index, id, name } => {
            if let Some(row) = tools.rows.iter_mut().find(|row| row.index == *index) {
                if !id.is_empty() {
                    row.id = id.clone();
                }
                if !name.is_empty() {
                    row.name = name.clone();
                }
                return;
            }
            tools.rows.push(OpenTool {
                index: *index,
                id: id.clone(),
                name: name.clone(),
                arguments: String::new(),
            });
        }
        StreamPiece::ToolDelta { index, partial } => {
            if let Some(row) = tools.rows.iter_mut().find(|row| row.index == *index) {
                row.arguments.push_str(partial);
                return;
            }
            tools.rows.push(OpenTool {
                index: *index,
                id: String::new(),
                name: String::new(),
                arguments: partial.clone(),
            });
        }
        _ => {}
    }
}

pub fn finished_tools(tools: &ToolAccum) -> Vec<DevToolCall> {
    let mut rows = tools.rows.clone();
    rows.sort_by_key(|row| row.index);
    rows.into_iter()
        .filter(|row| !row.name.is_empty())
        .map(|row| DevToolCall {
            id: if row.id.is_empty() {
                format!("tool_{}", row.index)
            } else {
                row.id
            },
            name: row.name,
            arguments: row.arguments,
        })
        .collect()
}

pub fn apply_thinking(blocks: &mut ThinkingAccum, piece: &StreamPiece) {
    match piece {
        StreamPiece::ThinkingStart { index } => {
            if blocks.rows.iter().any(|row| row.index == *index) {
                return;
            }
            blocks.rows.push(OpenThinking {
                index: *index,
                redacted: false,
                thinking: String::new(),
                signature: String::new(),
                data: String::new(),
            });
        }
        StreamPiece::Reasoning(text) => {
            if let Some(row) = blocks.rows.iter_mut().rev().find(|row| !row.redacted) {
                row.thinking.push_str(text);
            }
        }
        StreamPiece::ThinkingSignature { index, signature } => {
            if let Some(row) = blocks.rows.iter_mut().find(|row| row.index == *index && !row.redacted) {
                row.signature.push_str(signature);
                return;
            }
            if let Some(row) = blocks
                .rows
                .iter_mut()
                .rev()
                .find(|row| !row.redacted && row.signature.is_empty())
            {
                row.signature.push_str(signature);
            }
        }
        StreamPiece::RedactedThinking { index, data } => {
            if data.is_empty() {
                return;
            }
            if let Some(row) = blocks.rows.iter_mut().find(|row| row.index == *index) {
                row.redacted = true;
                row.data = data.clone();
                return;
            }
            blocks.rows.push(OpenThinking {
                index: *index,
                redacted: true,
                thinking: String::new(),
                signature: String::new(),
                data: data.clone(),
            });
        }
        _ => {}
    }
}

/// Blocks worth sending back. A thinking block without its signature is dropped.
pub fn finished_thinking(blocks: &ThinkingAccum) -> Vec<ThinkingBlock> {
    let mut rows = blocks.rows.clone();
    rows.sort_by_key(|row| row.index);
    rows.into_iter()
        .filter_map(|row| {
            if row.redacted {
                if row.data.is_empty() {
                    return None;
                }
                return Some(ThinkingBlock {
                    kind: "redacted_thinking".into(),
                    thinking: String::new(),
                    signature: String::new(),
                    data: row.data,
                });
            }
            if row.signature.is_empty() {
                return None;
            }
            Some(ThinkingBlock {
                kind: "thinking".into(),
                thinking: row.thinking,
                signature: row.signature,
                data: String::new(),
            })
        })
        .collect()
}

pub fn usage_event(prompt_tokens: u64, completion_tokens: u64) -> DevChatUsage {
    DevChatUsage {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens.saturating_add(completion_tokens),
    }
}
