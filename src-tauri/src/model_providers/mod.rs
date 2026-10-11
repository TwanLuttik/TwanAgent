//! Model providers.
//!
//! Adding one:
//! 1. Add `providers/<name>.rs` and `pub mod` it from `providers/mod.rs`.
//! 2. Implement `owns`, auth, models, the request body, and SSE parsing.
//! 3. Register it in `registry::find` before the xAI fallback.
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
pub use providers::minimax;

pub use event::ThinkingBlock;
