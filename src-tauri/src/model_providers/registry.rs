use std::path::Path;

use super::grok_cli::{self, DevModel};

/// Which chat protocol owns a model id. Unknown ids stay on xAI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderId {
    Xai,
    Anthropic,
}

pub fn find(model_id: &str) -> ProviderId {
    if super::anthropic::provider_for(model_id) == super::anthropic::Provider::Anthropic {
        ProviderId::Anthropic
    } else {
        ProviderId::Xai
    }
}

pub fn sign_in_error(id: ProviderId) -> &'static str {
    match id {
        ProviderId::Anthropic => super::anthropic::SIGN_IN_ERROR,
        ProviderId::Xai => "Grok isn’t signed in. Run grok login, or add an xAI API key in Settings.",
    }
}

pub fn plan_mode(id: ProviderId) -> bool {
    matches!(id, ProviderId::Xai)
}

/// Fallback rows from every provider, with a signed-in provider's live list replacing its fallback.
pub async fn list_models(data_dir: &Path) -> Vec<DevModel> {
    let mut rows = grok_cli::runtime(data_dir).models;
    rows.retain(|row| row.provider != super::anthropic::PROVIDER_ANTHROPIC);
    if let Some(auth) = super::anthropic::resolve_claude_auth_fresh().await {
        rows.extend(super::anthropic::available_models(&auth).await);
    } else {
        rows.extend(super::anthropic::claude_models());
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matcher_keeps_tutor_ids_on_xai() {
        assert_eq!(find("grok-4.6"), ProviderId::Xai);
        assert_eq!(find("claude-sonnet-4-6"), ProviderId::Anthropic);
        assert_eq!(find("claude-sonnet-4-5-20250929"), ProviderId::Anthropic);
        assert_eq!(find("sxs-claude-opus-4-6"), ProviderId::Xai);
        assert_eq!(find(""), ProviderId::Xai);
        assert!(plan_mode(ProviderId::Xai));
        assert!(!plan_mode(ProviderId::Anthropic));
    }
}
