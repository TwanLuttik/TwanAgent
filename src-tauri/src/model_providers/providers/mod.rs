//! One file per model provider.
//!
//! `anthropic` is the Claude Messages client. `grok_cli` is the xAI client and the Grok CLI
//! (binary, `~/.grok` sessions, plan files). A new provider gets its own file here and a
//! registration in `model_providers::registry` before the xAI fallback.

pub mod anthropic;
pub mod grok_cli;
