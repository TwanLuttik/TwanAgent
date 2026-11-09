use super::*;

#[test]
fn parses_cli_model_cache_and_drops_non_grok() {
    let src = r#"{
      "models": {
        "grok-4.6": {
          "info": {
            "id": "grok-4.6",
            "name": "Grok 4.6",
            "model_family": "xai",
            "hidden": false,
            "reasoning_efforts": [
              {"id": "xhigh", "label": "Extra High Effort"},
              {"id": "high", "label": "High Effort"}
            ],
            "context_window": 256000,
            "context_windows": [256000, 500000, 256000]
          }
        },
        "other-claude-opus-4-6": {
          "info": {
            "id": "other-claude-opus-4-6",
            "name": "Other Claude",
            "model_family": "anthropic"
          }
        }
      }
    }"#;
    let rows = parse_models_cache(src);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "grok-4.6");
    assert_eq!(rows[0].efforts[0].label, "Extra high");
    assert_eq!(rows[0].context_window, Some(256_000));
    assert_eq!(rows[0].context_windows, vec![256_000, 500_000]);
}

#[test]
fn single_context_window_stays_hidden() {
    let src = r#"{
      "models": {
        "grok-3": {
          "info": {
            "id": "grok-3",
            "name": "Grok 3",
            "model_family": "xai",
            "context_window": 131072
          }
        }
      }
    }"#;
    let rows = parse_models_cache(src);
    assert_eq!(rows[0].context_window, Some(131_072));
    assert!(rows[0].context_windows.is_empty());
}

#[test]
fn context_window_header_is_a_positive_token_count() {
    assert_eq!(
        context_window_header_value(Some(500_000)).as_deref(),
        Some("500000")
    );
    assert_eq!(context_window_header_value(Some(0)), None);
    assert_eq!(context_window_header_value(None), None);
}

#[test]
fn reads_defaults_from_config_toml() {
    let src = "[models]\ndefault = \"grok-4.6\"\ndefault_reasoning_effort = \"xhigh\"\n";
    assert_eq!(
        parse_toml_quoted(src, "models", "default").as_deref(),
        Some("grok-4.6")
    );
    assert_eq!(
        parse_toml_quoted(src, "models", "default_reasoning_effort").as_deref(),
        Some("xhigh")
    );
}

#[test]
fn effort_labels_are_short() {
    assert_eq!(effort_label("xhigh"), "Extra high");
    assert_eq!(effort_label("max"), "Max");
    assert_eq!(effort_label("medium"), "Medium");
}

#[test]
fn runtime_appends_claude_without_replacing_the_grok_default() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("grok-home");
    fs::create_dir_all(&home).unwrap();
    fs::write(
        home.join("models_cache.json"),
        r#"{"models":{"grok-4.5":{"info":{"id":"grok-4.5","name":"Grok 4.5","model_family":"xai","reasoning_efforts":[{"id":"high","label":"High"}]}}}}"#,
    )
    .unwrap();
    fs::write(
        home.join("config.toml"),
        "[models]\ndefault = \"grok-4.5\"\ndefault_reasoning_effort = \"high\"\n",
    )
    .unwrap();
    let prev = std::env::var_os("GROK_HOME");
    std::env::set_var("GROK_HOME", &home);
    let status = runtime(dir.path());
    match prev {
        Some(value) => std::env::set_var("GROK_HOME", value),
        None => std::env::remove_var("GROK_HOME"),
    }
    assert_eq!(status.default_model, "grok-4.5");
    let providers: Vec<_> = status
        .models
        .iter()
        .map(|row| (row.id.as_str(), row.provider.as_str()))
        .collect();
    assert!(providers
        .iter()
        .any(|(id, provider)| *id == "grok-4.5" && *provider == "xai"));
    assert!(!providers.iter().any(|(id, _)| id.starts_with("claude-")));
    assert!(!providers.iter().any(|(id, _)| id.starts_with("other-")));
}

#[test]
fn parses_semver_from_grok_version_line() {
    assert_eq!(
        parse_cli_version("grok 1.0.31 (b44e0bc0a8e0) [alpha]").as_deref(),
        Some("1.0.31")
    );
    assert_eq!(parse_cli_version("1.0.31").as_deref(), Some("1.0.31"));
    assert_eq!(parse_cli_version("grok").as_deref(), None);
}

#[test]
fn proxy_version_falls_back_when_cli_is_missing() {
    assert_eq!(cli_proxy_version(None), "1.0.0");
    assert_eq!(
        cli_proxy_version(Some("grok 1.0.31 (b44e0bc0a8e0) [alpha]")),
        "1.0.31"
    );
}

#[test]
fn proxy_headers_include_client_version() {
    let headers = cli_proxy_headers("1.0.31");
    assert_eq!(headers.client_version, "1.0.31");
    assert_eq!(headers.token_auth, "xai-grok-cli");
    assert_eq!(headers.client_identifier, "twanagent");
    assert_eq!(headers.user_agent, "twanagent/1.0.31");
}
