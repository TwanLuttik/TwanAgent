use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::paths::workspace_id;
use super::types::{
    default_conversation_kind, Conversation, ConversationSummary, Journey, SidebarItem,
};
use crate::error::{Error, Result};
use crate::state::AppState;
use crate::store;
use tauri::State;

pub(crate) fn conv_dir(data_dir: &Path, workspace: &str) -> PathBuf {
    data_dir.join("dev").join(workspace_id(workspace))
}

pub(crate) fn conv_path(data_dir: &Path, workspace: &str) -> PathBuf {
    conv_dir(data_dir, workspace).join("conversations.json")
}

pub(crate) fn load_conversations_json(
    data_dir: &Path,
    workspace: &str,
) -> Result<Vec<Conversation>> {
    let path = conv_path(data_dir, workspace);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(path)?;
    if data.trim().is_empty() {
        return Ok(Vec::new());
    }
    Ok(serde_json::from_str(&data)?)
}

pub(crate) fn save_conversations_json(
    data_dir: &Path,
    workspace: &str,
    rows: &[Conversation],
) -> Result<()> {
    let dir = conv_dir(data_dir, workspace);
    fs::create_dir_all(&dir)?;
    let path = dir.join("conversations.json");
    let tmp = dir.join("conversations.json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(rows)?)?;
    #[cfg(windows)]
    {
        if path.exists() {
            fs::remove_file(&path)?;
        }
    }
    fs::rename(tmp, path)?;
    Ok(())
}

pub(crate) fn conv_store_dir(data_dir: &Path, workspace: &str) -> PathBuf {
    super::project_location::resolve_conv_dir(data_dir, workspace)
}

pub(crate) fn open_store(data_dir: &Path, workspace: &str) -> Result<rusqlite::Connection> {
    store::open(&conv_store_dir(data_dir, workspace))
}

pub(crate) fn load_conversations(data_dir: &Path, workspace: &str) -> Result<Vec<Conversation>> {
    let dir = conv_store_dir(data_dir, workspace);
    match store::open(&dir) {
        Ok(conn) => store::list_conversations(&conn),
        Err(e) => {
            if store::db_path(&dir).exists() {
                Err(e)
            } else {
                load_conversations_json(data_dir, workspace)
            }
        }
    }
}

#[cfg(test)]
pub(crate) fn save_conversations(
    data_dir: &Path,
    workspace: &str,
    rows: &[Conversation],
) -> Result<()> {
    let dir = conv_store_dir(data_dir, workspace);
    match store::open(&dir) {
        Ok(conn) => {
            let existing = store::list_conversations(&conn)?;
            for row in existing {
                if !rows.iter().any(|c| c.id == row.id) {
                    store::delete_conversation(&conn, &row.id)?;
                }
            }
            for row in rows {
                store::save_conversation(&conn, row)?;
            }
            let ids: Vec<String> = rows.iter().map(|c| c.id.clone()).collect();
            store::reorder_conversations(&conn, &ids)?;
            Ok(())
        }
        Err(e) => {
            if store::db_path(&dir).exists() {
                Err(e)
            } else {
                save_conversations_json(data_dir, workspace, rows)
            }
        }
    }
}

pub(crate) fn summary_from(c: Conversation) -> ConversationSummary {
    ConversationSummary {
        id: c.id,
        title: c.title,
        created_at: c.created_at,
        updated_at: c.updated_at,
        kind: if c.kind.is_empty() {
            default_conversation_kind()
        } else {
            c.kind
        },
        journey_id: c.journey_id,
        sort_order: c.sort_order,
        effort: c.effort.filter(|value| !value.trim().is_empty()),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_list_conversations(
    state: State<'_, AppState>,
    workspace: String,
) -> Result<Vec<ConversationSummary>> {
    let rows = load_conversations(&state.data_dir, &workspace)?;
    Ok(rows.into_iter().map(summary_from).collect())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_get_conversation(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
) -> Result<Conversation> {
    load_conversations(&state.data_dir, &workspace)?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| Error::NotFound("conversation not found".into()))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_save_conversation(
    state: State<'_, AppState>,
    workspace: String,
    conversation: Conversation,
) -> Result<Conversation> {
    let dir = conv_store_dir(&state.data_dir, &workspace);
    match store::open(&dir) {
        Ok(conn) => {
            store::save_conversation(&conn, &conversation)?;
            store::get_conversation(&conn, &conversation.id)
        }
        Err(e) => {
            if store::db_path(&dir).exists() {
                return Err(e);
            }
            let mut rows = load_conversations_json(&state.data_dir, &workspace)?;
            if let Some(existing) = rows.iter_mut().find(|c| c.id == conversation.id) {
                *existing = conversation.clone();
            } else {
                rows.insert(0, conversation.clone());
            }
            save_conversations_json(&state.data_dir, &workspace, &rows)?;
            Ok(conversation)
        }
    }
}

pub fn apply_conversation_order(rows: Vec<Conversation>, ids: &[String]) -> Vec<Conversation> {
    let original: Vec<String> = rows.iter().map(|c| c.id.clone()).collect();
    let mut by_id: HashMap<String, Conversation> = HashMap::new();
    for row in rows {
        by_id.entry(row.id.clone()).or_insert(row);
    }
    let mut out = Vec::with_capacity(by_id.len());
    for id in ids {
        if let Some(row) = by_id.remove(id) {
            out.push(row);
        }
    }
    for id in original {
        if let Some(row) = by_id.remove(&id) {
            out.push(row);
        }
    }
    out
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_reorder_conversations(
    state: State<'_, AppState>,
    workspace: String,
    ids: Vec<String>,
) -> Result<Vec<ConversationSummary>> {
    let dir = conv_store_dir(&state.data_dir, &workspace);
    match store::open(&dir) {
        Ok(conn) => {
            let rows = store::reorder_conversations(&conn, &ids)?;
            Ok(rows.into_iter().map(summary_from).collect())
        }
        Err(e) => {
            if store::db_path(&dir).exists() {
                return Err(e);
            }
            let rows = apply_conversation_order(
                load_conversations_json(&state.data_dir, &workspace)?,
                &ids,
            );
            save_conversations_json(&state.data_dir, &workspace, &rows)?;
            Ok(rows.into_iter().map(summary_from).collect())
        }
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_delete_conversation(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
) -> Result<()> {
    let dir = conv_store_dir(&state.data_dir, &workspace);
    match store::open(&dir) {
        Ok(conn) => store::delete_conversation(&conn, &id),
        Err(e) => {
            if store::db_path(&dir).exists() {
                return Err(e);
            }
            let mut rows = load_conversations_json(&state.data_dir, &workspace)?;
            rows.retain(|c| c.id != id);
            save_conversations_json(&state.data_dir, &workspace, &rows)
        }
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_list_journeys(state: State<'_, AppState>, workspace: String) -> Result<Vec<Journey>> {
    let conn = open_store(&state.data_dir, &workspace)?;
    store::list_journeys(&conn)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_create_journey(
    state: State<'_, AppState>,
    workspace: String,
    conversation_id: String,
) -> Result<Journey> {
    let dir = conv_store_dir(&state.data_dir, &workspace);
    let conn = store::open(&dir)?;
    store::create_journey(&conn, &dir, &conversation_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_rename_journey(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
    title: String,
) -> Result<Journey> {
    let conn = open_store(&state.data_dir, &workspace)?;
    store::rename_journey(&conn, &id, &title)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_delete_journey(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
    delete_chats: bool,
) -> Result<()> {
    let dir = conv_store_dir(&state.data_dir, &workspace);
    let conn = store::open(&dir)?;
    store::delete_journey(&conn, &dir, &id, delete_chats)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_set_journey_collapsed(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
    collapsed: bool,
) -> Result<()> {
    let conn = open_store(&state.data_dir, &workspace)?;
    store::set_journey_collapsed(&conn, &id, collapsed)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_set_journey_color(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
    color: String,
) -> Result<Journey> {
    let conn = open_store(&state.data_dir, &workspace)?;
    store::set_journey_color(&conn, &id, &color)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_move_conversation(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
    journey_id: Option<String>,
) -> Result<Conversation> {
    let conn = open_store(&state.data_dir, &workspace)?;
    store::move_conversation(&conn, &id, journey_id.as_deref())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_reorder_sidebar(
    state: State<'_, AppState>,
    workspace: String,
    items: Vec<SidebarItem>,
) -> Result<Vec<ConversationSummary>> {
    let conn = open_store(&state.data_dir, &workspace)?;
    store::reorder_sidebar(&conn, &items)?;
    Ok(store::list_conversations(&conn)?
        .into_iter()
        .map(summary_from)
        .collect())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_get_journey_knowledge(
    state: State<'_, AppState>,
    workspace: String,
    journey_id: String,
) -> Result<String> {
    let dir = conv_store_dir(&state.data_dir, &workspace);
    let conn = store::open(&dir)?;
    store::get_knowledge(&dir, &conn, &journey_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_save_journey_knowledge(
    state: State<'_, AppState>,
    workspace: String,
    journey_id: String,
    contents: String,
) -> Result<()> {
    let dir = conv_store_dir(&state.data_dir, &workspace);
    let conn = store::open(&dir)?;
    store::save_knowledge(&dir, &conn, &journey_id, &contents)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_update_journey_knowledge(
    state: State<'_, AppState>,
    workspace: String,
    journey_id: String,
    mode: String,
    contents: Option<String>,
    old_string: Option<String>,
    new_string: Option<String>,
) -> Result<String> {
    let dir = conv_store_dir(&state.data_dir, &workspace);
    let conn = store::open(&dir)?;
    store::update_knowledge(
        &dir,
        &conn,
        &journey_id,
        &mode,
        contents.as_deref(),
        old_string.as_deref(),
        new_string.as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dev::types::DevChatUsage;

    fn temp_ws() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn conversations_keep_manual_order() {
        fn conv(id: &str) -> Conversation {
            Conversation {
                id: id.into(),
                title: id.into(),
                created_at: "2026-01-01T00:00:00Z".into(),
                updated_at: "2026-01-01T00:00:00Z".into(),
                kind: "chat".into(),
                messages: vec![],
                context_usage: None,
                compaction: None,
                journey_id: None,
                sort_order: 0,
                effort: None,
            }
        }
        let rows = vec![conv("a"), conv("b"), conv("c")];
        let ordered = apply_conversation_order(rows, &["c".into(), "a".into(), "b".into()]);
        assert_eq!(
            ordered.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["c", "a", "b"]
        );
    }

    #[test]
    fn conversations_roundtrip() {
        let dir = temp_ws();
        let ws = dir.path().to_string_lossy().into_owned();
        let conv = Conversation {
            id: "c1".into(),
            title: "Hello".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            kind: "terminal".into(),
            messages: vec![serde_json::json!({"role":"user","content":"hi"})],
            context_usage: Some(DevChatUsage {
                prompt_tokens: 24100,
                completion_tokens: 800,
                total_tokens: 24900,
            }),
            compaction: None,
            journey_id: None,
            sort_order: 0,
            effort: None,
        };
        save_conversations(dir.path(), &ws, &[conv.clone()]).unwrap();
        let loaded = load_conversations(dir.path(), &ws).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].title, "Hello");
        assert_eq!(loaded[0].kind, "terminal");
        assert_eq!(loaded[0].messages.len(), 1);
        assert_eq!(
            loaded[0].context_usage,
            Some(DevChatUsage {
                prompt_tokens: 24100,
                completion_tokens: 800,
                total_tokens: 24900,
            })
        );
    }

    #[test]
    fn conversations_load_without_context_usage() {
        let json = r#"[{
            "id":"c1",
            "title":"Hello",
            "created_at":"2026-01-01T00:00:00Z",
            "updated_at":"2026-01-01T00:00:00Z",
            "kind":"chat",
            "messages":[]
        }]"#;
        let rows: Vec<Conversation> = serde_json::from_str(json).unwrap();
        assert_eq!(rows[0].context_usage, None);
    }

    #[test]
    fn conversations_without_kind_default_to_chat() {
        let dir = temp_ws();
        let ws = dir.path().to_string_lossy().into_owned();
        let path = super::conv_dir(dir.path(), &ws).join("conversations.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"[{"id":"old","title":"Legacy","created_at":"t","updated_at":"t","messages":[]}]"#,
        )
        .unwrap();
        let loaded = load_conversations(dir.path(), &ws).unwrap();
        assert_eq!(loaded[0].kind, "chat");
        let summary = super::summary_from(loaded.into_iter().next().unwrap());
        assert_eq!(summary.kind, "chat");
    }
}
