/// Which chat protocol owns a model id. Unknown ids stay on xAI.
/// Specific providers are matched before the xAI fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderId {
    Xai,
    Anthropic,
    Minimax,
}

pub fn find(model_id: &str) -> ProviderId {
    if super::minimax::is_minimax_model(model_id) {
        ProviderId::Minimax
    } else if super::anthropic::is_claude_model(model_id) {
        ProviderId::Anthropic
    } else {
        ProviderId::Xai
    }
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
        assert_eq!(find("MiniMax-M3"), ProviderId::Minimax);
        assert_eq!(find("MiniMax-M2.7"), ProviderId::Minimax);
        assert_eq!(find("sxs-MiniMax-M3"), ProviderId::Xai);
        assert_eq!(find(""), ProviderId::Xai);
    }
}
