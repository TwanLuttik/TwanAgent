//! Model providers.
//!
//! Adding one:
//! 1. Add the wire format in `service/src/providers/<name>.rs` and register it in
//!    `service/src/providers/registry.rs` before the xAI fallback. The server and this app share that.
//! 2. Add `providers/<name>.rs` here for login, the catalog, and the HTTP call.
//! 3. Add a server round in `service/src/model/<name>.rs` and dispatch it from `model/mod.rs`.
//! 4. Add a settings key command in `dev/keys.rs` if it needs its own secret.
//! 5. Add a profile in `src/lib/model-providers/` and register it before xAI.
//!
//! No other file should branch on the provider id. Unknown model ids stay on xAI.

pub mod cli_update;
pub mod event;
pub mod providers;
pub mod registry;
pub mod runner;

pub use providers::anthropic;
pub use providers::grok_cli;
pub use providers::minimax;

pub use event::ThinkingBlock;
