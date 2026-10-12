//! One file per model provider.
//!
//! The desktop app and the headless server both speak these wire formats. Login, catalogs,
//! and the HTTP client stay with the caller. A new provider gets a file here and a match in
//! `registry::find` before the xAI fallback.

pub mod anthropic;
pub mod minimax;
pub mod registry;
pub mod xai;

pub use registry::{find, ProviderId};
