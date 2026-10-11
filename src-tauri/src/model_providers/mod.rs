//! Model providers.
//!
//! Adding one:
//! 1. Add `provider_name.rs` in this folder.
//! 2. Implement `Provider`: `owns`, auth, models, `prepare`, `parse_sse`.
//! 3. Register it in `registry()` before the xAI fallback.
//! 4. Add a settings key command in `dev/keys.rs` if it needs its own secret.
//! 5. Add a profile in `src/lib/model-providers/` and register it before xAI.
//!
//! No other file should branch on the provider id. Unknown model ids stay on xAI.

pub mod event;
pub mod providers;
pub mod registry;
pub mod runner;

pub use providers::anthropic;
pub use providers::grok_cli;

pub use event::ThinkingBlock;
