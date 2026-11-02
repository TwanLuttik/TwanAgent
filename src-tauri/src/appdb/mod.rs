mod projects;
mod schema;
mod settings;
mod sidebar;

pub use projects::{
    list_projects,
    add_project,
    add_project_named,
    reorder_projects,
    project_key_public,
    rename_project_path,
    remove_project,
    import_legacy_projects,
};
pub use schema::{
    db_path,
    open,
    get_provider_key,
    set_provider_key,
    delete_provider_key,
};
pub use settings::{
    get_setting,
    get_account_usage,
    get_pull_requests,
    set_pull_requests,
    set_account_usage,
    project_path_moves,
    previous_paths_for,
    remember_project_move,
    forget_project_paths,
    set_setting,
};
pub use sidebar::{
    sidebar_cached,
    replace_sidebar,
    upsert_sidebar_conversation,
    replace_sidebar_source,
    sidebar_is_cloud,
    sidebar_transcript_by_id,
    sidebar_transcript,
    save_sidebar_transcript,
    sidebar_transcripts,
    sidebar_snapshot,
    sidebar_for,
    clear_sidebar,
};

pub mod commands;

#[cfg(test)]
mod tests {
    use super::*;
    use super::settings::list_settings;
    use std::fs;

    use rusqlite::Connection;

    use crate::dev::path_string;
    use tempfile::tempdir;

    #[test]
    fn projects_roundtrip_and_are_unique_by_path() {
        let data = tempdir().unwrap();
        let folder = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        let added = add_project(&conn, folder.path()).unwrap();
        assert!(added.path.ends_with(folder.path().file_name().unwrap().to_str().unwrap()) || !added.path.is_empty());
        let again = add_project(&conn, folder.path()).unwrap();
        assert_eq!(again.path, added.path);
        let rows = list_projects(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, folder.path().file_name().unwrap().to_string_lossy());
        assert!(remove_project(&conn, &added.path).unwrap());
        assert!(list_projects(&conn).unwrap().is_empty());
        assert!(!remove_project(&conn, &added.path).unwrap());
    }

    #[test]
    fn rename_project_path_keeps_the_sidebar_place_and_cache() {
        let data = tempdir().unwrap();
        let from = tempdir().unwrap();
        let to = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        let added = add_project(&conn, from.path()).unwrap();
        let chat = crate::dev::ConversationSummary {
            id: "c1".into(),
            title: "Hello".into(),
            created_at: "t0".into(),
            updated_at: "t1".into(),
            kind: "chat".into(),
            journey_id: None,
            sort_order: 0,
            effort: None,
            model: None,
            context_window: None,
            permission: None,
            archived: false,
        };
        replace_sidebar(&conn, &added.path, &[chat], &[]).unwrap();
        let next = path_string(to.path());
        assert!(rename_project_path(&conn, &added.path, &next).unwrap());
        let rows = list_projects(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, next);
        let (chats, _) = sidebar_for(&conn, &next).unwrap();
        assert_eq!(chats[0].title, "Hello");
        assert!(sidebar_for(&conn, &added.path).unwrap().0.is_empty());
        assert!(!rename_project_path(&conn, "/missing", &next).unwrap());
    }

    #[test]
    fn reorder_projects_keeps_unknown_rows_and_skips_missing_paths() {
        let data = tempdir().unwrap();
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let c = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        let first = add_project(&conn, a.path()).unwrap();
        let second = add_project(&conn, b.path()).unwrap();
        let third = add_project(&conn, c.path()).unwrap();
        let third_path = third.path.clone();
        let rows = reorder_projects(&conn, &[third.path, first.path.clone(), "/missing".into()]).unwrap();
        assert_eq!(
            rows.iter().map(|row| row.path.clone()).collect::<Vec<_>>(),
            vec![third_path.clone(), first.path, second.path]
        );
        let again = list_projects(&conn).unwrap();
        assert_eq!(again[0].path, third_path);
    }

    #[test]
    fn import_keeps_default_children_and_opened_folders() {
        let data = tempdir().unwrap();
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("Alpha")).unwrap();
        fs::create_dir_all(root.path().join(".hidden")).unwrap();
        let outside = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        let n = import_legacy_projects(
            &conn,
            &[root.path()],
            &[outside.path().to_string_lossy().into_owned()],
        )
        .unwrap();
        assert_eq!(n, 2);
        let names: Vec<_> = list_projects(&conn).unwrap().into_iter().map(|row| row.name).collect();
        assert!(names.iter().any(|name| name == "Alpha"));
        assert!(!names.iter().any(|name| name == ".hidden"));
        let again = import_legacy_projects(&conn, &[root.path()], &[]).unwrap();
        assert_eq!(again, 0);
        assert_eq!(list_projects(&conn).unwrap().len(), 2);
        fs::create_dir_all(root.path().join("Later")).unwrap();
        let after_flag = import_legacy_projects(&conn, &[root.path()], &[]).unwrap();
        assert_eq!(after_flag, 0);
        assert!(!list_projects(&conn)
            .unwrap()
            .iter()
            .any(|row| row.name == "Later"));
    }

    #[test]
    fn settings_upsert() {
        let data = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        assert!(get_setting(&conn, "theme").unwrap().is_none());
        set_setting(&conn, "theme", r#"{"id":"finder"}"#).unwrap();
        set_setting(&conn, "theme", r#"{"id":"midnight"}"#).unwrap();
        assert_eq!(
            get_setting(&conn, "theme").unwrap().as_deref(),
            Some(r#"{"id":"midnight"}"#)
        );
        assert_eq!(list_settings(&conn).unwrap().len(), 1);
        assert!(set_setting(&conn, "  ", "x").is_err());
    }

    #[test]
    fn sidebar_index_replaces_one_project_and_keeps_the_other() {
        let data = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        let chat = crate::dev::ConversationSummary {
            id: "c1".into(),
            title: "Hello".into(),
            created_at: "t0".into(),
            updated_at: "t1".into(),
            kind: "chat".into(),
            journey_id: None,
            sort_order: 2,
            effort: Some("low".into()),
            model: Some("grok-4".into()),
            context_window: Some(256_000),
            permission: None,
            archived: false,
        };
        let journey = crate::dev::Journey {
            id: "j1".into(),
            title: "Work".into(),
            created_at: "t0".into(),
            updated_at: "t1".into(),
            sort_order: 1,
            collapsed: true,
            color: "blue".into(),
        };
        assert!(!sidebar_cached(&conn, "/app/Alpha").unwrap());
        replace_sidebar(&conn, "/app/Alpha/", &[chat.clone()], &[journey]).unwrap();
        replace_sidebar(&conn, "/app/beta", &[], &[]).unwrap();
        let (chats, journeys) = sidebar_for(&conn, "/app/alpha").unwrap();
        assert_eq!(chats.len(), 1);
        assert_eq!(chats[0].title, "Hello");
        assert_eq!(chats[0].sort_order, 2);
        assert_eq!(journeys[0].collapsed, true);
        assert!(sidebar_cached(&conn, "/app/alpha").unwrap());
        assert!(!sidebar_is_cloud(&conn, "/app/alpha").unwrap());
        replace_sidebar_source(&conn, "/app/alpha", &[chat.clone()], &[], true).unwrap();
        assert!(sidebar_is_cloud(&conn, "/app/alpha").unwrap());
        let transcript = crate::dev::Conversation {
            id: chat.id.clone(),
            title: chat.title.clone(),
            created_at: chat.created_at.clone(),
            updated_at: chat.updated_at.clone(),
            kind: chat.kind.clone(),
            messages: vec![serde_json::json!({"role":"user","content":"hi"})],
            context_usage: None,
            compaction: None,
            journey_id: None,
            sort_order: chat.sort_order,
            effort: None,
            model: None,
            context_window: None,
            permission: None,
            archived: false,
        };
        save_sidebar_transcript(&conn, "/app/alpha", &transcript).unwrap();
        let loaded = sidebar_transcript(&conn, "/app/Alpha/", &chat.id).unwrap().unwrap();
        assert_eq!(loaded.messages.len(), 1);
        replace_sidebar(&conn, "/app/alpha", &[], &[]).unwrap();
        let (chats, journeys) = sidebar_for(&conn, "/app/alpha").unwrap();
        assert!(chats.is_empty() && journeys.is_empty());
        assert!(!sidebar_is_cloud(&conn, "/app/alpha").unwrap());
        assert!(sidebar_transcript(&conn, "/app/alpha", "c1").unwrap().is_some());
        assert!(sidebar_cached(&conn, "/app/beta").unwrap());
    }

    fn chat(id: &str, title: &str, updated_at: &str) -> crate::dev::ConversationSummary {
        crate::dev::ConversationSummary {
            id: id.into(),
            title: title.into(),
            created_at: "t0".into(),
            updated_at: updated_at.into(),
            kind: "chat".into(),
            journey_id: None,
            sort_order: 0,
            effort: None,
            model: None,
            context_window: None,
            permission: None,
            archived: false,
        }
    }

    #[test]
    fn upsert_sidebar_conversation_updates_one_row_and_does_not_mark_uncached() {
        let data = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        let journey = crate::dev::Journey {
            id: "j1".into(),
            title: "Work".into(),
            created_at: "t0".into(),
            updated_at: "t1".into(),
            sort_order: 1,
            collapsed: true,
            color: "blue".into(),
        };
        replace_sidebar(
            &conn,
            "/app/alpha",
            &[chat("c1", "Hello", "t1"), chat("c2", "Other", "t2")],
            &[journey.clone()],
        )
        .unwrap();
        let mut updated = chat("c1", "Renamed", "t9");
        updated.sort_order = 4;
        updated.effort = Some("high".into());
        upsert_sidebar_conversation(&conn, "/app/Alpha/", &updated).unwrap();

        let (chats, journeys) = sidebar_for(&conn, "/app/alpha").unwrap();
        assert_eq!(chats.len(), 2);
        let c1 = chats.iter().find(|row| row.id == "c1").unwrap();
        let c2 = chats.iter().find(|row| row.id == "c2").unwrap();
        assert_eq!(c1.title, "Renamed");
        assert_eq!(c1.updated_at, "t9");
        assert_eq!(c1.sort_order, 4);
        assert_eq!(c1.effort.as_deref(), Some("high"));
        assert_eq!(c2.title, "Other");
        assert_eq!(c2.updated_at, "t2");
        assert_eq!(c2.sort_order, 0);
        assert_eq!(journeys.len(), 1);
        assert_eq!(journeys[0].id, journey.id);
        assert_eq!(journeys[0].title, journey.title);
        assert_eq!(journeys[0].collapsed, journey.collapsed);
        assert!(sidebar_cached(&conn, "/app/alpha").unwrap());

        upsert_sidebar_conversation(&conn, "/app/new", &chat("c9", "Fresh", "t3")).unwrap();
        assert!(!sidebar_cached(&conn, "/app/new").unwrap());
        let (fresh, fresh_journeys) = sidebar_for(&conn, "/app/new").unwrap();
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].title, "Fresh");
        assert!(fresh_journeys.is_empty());
        let (chats, _) = sidebar_for(&conn, "/app/alpha").unwrap();
        assert_eq!(chats.len(), 2);
    }

    #[test]
    fn an_old_sidebar_projects_table_gains_the_cloud_column() {
        let data = tempdir().unwrap();
        let path = data.path().join("app.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE sidebar_projects (
                    project_path TEXT PRIMARY KEY,
                    refreshed_at TEXT NOT NULL
                );",
            )
            .unwrap();
        }
        let conn = open(data.path()).unwrap();
        replace_sidebar_source(&conn, "/mounts/cloud", &[], &[], true).unwrap();
        assert!(sidebar_is_cloud(&conn, "/mounts/cloud").unwrap());
    }

    #[test]
    fn an_old_provider_keys_table_gains_the_value_column() {
        let data = tempdir().unwrap();
        let path = data.path().join("app.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE provider_keys (provider TEXT PRIMARY KEY);")
                .unwrap();
        }
        let conn = open(data.path()).unwrap();
        set_provider_key(&conn, "xai", "xai-secret").unwrap();
        assert_eq!(get_provider_key(&conn, "xai").unwrap().as_deref(), Some("xai-secret"));
    }

    #[test]
    fn provider_keys_roundtrip_and_stay_out_of_settings() {
        let data = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        assert!(get_provider_key(&conn, "xai").unwrap().is_none());
        set_provider_key(&conn, "xai", " xai-secret ").unwrap();
        set_provider_key(&conn, "anthropic", "anthropic-secret").unwrap();
        assert_eq!(get_provider_key(&conn, "xai").unwrap().as_deref(), Some("xai-secret"));
        set_provider_key(&conn, "xai", "").unwrap();
        assert!(get_provider_key(&conn, "xai").unwrap().is_none());
        assert_eq!(
            get_provider_key(&conn, "anthropic").unwrap().as_deref(),
            Some("anthropic-secret")
        );
        delete_provider_key(&conn, "anthropic").unwrap();
        assert!(get_provider_key(&conn, "anthropic").unwrap().is_none());
        assert!(list_settings(&conn).unwrap().is_empty());
        assert!(set_provider_key(&conn, "  ", "nope").is_err());
    }

    #[test]
    fn pull_request_cache_roundtrip() {
        let data = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        assert!(get_pull_requests(&conn, "TwanLuttik/TwanAgent").unwrap().is_none());
        set_pull_requests(&conn, "TwanLuttik/TwanAgent", r#"[{"number":5}]"#).unwrap();
        set_pull_requests(&conn, "TwanLuttik/TwanAgent", r#"[{"number":6}]"#).unwrap();
        set_pull_requests(&conn, "other/repo", "[]").unwrap();
        assert_eq!(
            get_pull_requests(&conn, "TwanLuttik/TwanAgent").unwrap().as_deref(),
            Some(r#"[{"number":6}]"#)
        );
        assert!(set_pull_requests(&conn, "  ", "[]").is_err());
    }

    #[test]
    fn account_usage_cache_roundtrip() {
        let data = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        assert!(get_account_usage(&conn, "anthropic").unwrap().is_none());
        set_account_usage(&conn, "anthropic", r#"{"connected":true}"#).unwrap();
        set_account_usage(&conn, "anthropic", r#"{"connected":false}"#).unwrap();
        set_account_usage(&conn, "minimax", r#"{"connected":true}"#).unwrap();
        assert_eq!(
            get_account_usage(&conn, "anthropic").unwrap().as_deref(),
            Some(r#"{"connected":false}"#)
        );
        assert_eq!(
            get_account_usage(&conn, "minimax").unwrap().as_deref(),
            Some(r#"{"connected":true}"#)
        );
        assert!(set_account_usage(&conn, "  ", "{}").is_err());
    }
}
