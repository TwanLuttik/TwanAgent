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

pub(crate) fn with_store<T>(
    data_dir: &Path,
    workspace: &str,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T>,
) -> Result<T> {
    store::with_conn(&conv_store_dir(data_dir, workspace), f)
}

#[cfg(test)]
pub(crate) fn load_conversations(data_dir: &Path, workspace: &str) -> Result<Vec<Conversation>> {
    let dir = conv_store_dir(data_dir, workspace);
    match store::with_conn(&dir, store::list_conversations) {
        Ok(rows) => Ok(rows),
        Err(e) => {
            if store::db_path(&dir).exists() {
                Err(e)
            } else {
                load_conversations_json(data_dir, workspace)
            }
        }
    }
}

/// Copy the rows the sidebar paints into app.db. The project database stays the source.
fn remember_sidebar(state: &AppState, workspace: &str) {
    let Ok(conn) = crate::appdb::open(&state.data_dir) else {
        return;
    };
    let conversations = load_summaries(&state.data_dir, workspace);
    let journeys = store::with_conn(&conv_store_dir(&state.data_dir, workspace), store::list_journeys);
    let (Ok(conversations), Ok(journeys)) = (conversations, journeys) else {
        return;
    };
    let _ = crate::appdb::replace_sidebar(&conn, workspace, &conversations, &journeys);
}

fn load_summaries(data_dir: &Path, workspace: &str) -> Result<Vec<ConversationSummary>> {
    let dir = conv_store_dir(data_dir, workspace);
    match store::with_conn(&dir, store::list_conversation_summaries) {
        Ok(rows) => Ok(rows),
        Err(e) => {
            if store::db_path(&dir).exists() {
                Err(e)
            } else {
                Ok(load_conversations_json(data_dir, workspace)?
                    .into_iter()
                    .map(summary_from)
                    .collect())
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
    match store::with_conn(&dir, |conn| {
        let existing = store::list_conversations(conn)?;
        for row in existing {
            if !rows.iter().any(|c| c.id == row.id) {
                store::delete_conversation(conn, &row.id)?;
            }
        }
        for row in rows {
            store::save_conversation(conn, row)?;
        }
        let ids: Vec<String> = rows.iter().map(|c| c.id.clone()).collect();
        store::reorder_conversations(conn, &ids)?;
        Ok(())
    }) {
        Ok(()) => Ok(()),
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
        model: c.model.filter(|value| !value.trim().is_empty()),
        context_window: c.context_window.filter(|value| *value > 0),
        permission: c.permission.filter(|value| !value.trim().is_empty()),
        archived: c.archived,
    }
}

/// An empty chat saved in the local mount. A titled chat, or a terminal, is real.
fn is_local_cloud_draft(row: &ConversationSummary) -> bool {
    let title = row.title.trim();
    (title.is_empty() || title == "New chat") && row.kind != "terminal"
}

/// A cloud project's chats live on the server. Its local mount has an empty database.
/// Caching that empty database would make the sidebar say "No chats yet" forever.
fn remote_workspace(state: &AppState, workspace: &str) -> bool {
    let Ok(root) = state.require_workspace(workspace) else {
        return false;
    };
    crate::remote::project_for_workspace(state, &root)
        .ok()
        .flatten()
        .is_some()
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_list_conversations(
    state: State<'_, AppState>,
    workspace: String,
) -> Result<Vec<ConversationSummary>> {
    let data_dir = state.data_dir.clone();
    let remote = remote_workspace(&state, &workspace);
    crate::dev::commands::off_main(move || list_conversations_blocking(&data_dir, &workspace, remote)).await
}

fn list_conversations_blocking(
    data_dir: &Path,
    workspace: &str,
    remote: bool,
) -> Result<Vec<ConversationSummary>> {
    let conn = crate::appdb::open(data_dir)?;
    if crate::appdb::sidebar_cached(&conn, workspace)? {
        let rows = crate::appdb::sidebar_for(&conn, workspace)?.0;
        // The cache can hold an empty "New chat" written into the mount before
        // the server had the real conversation. That row is not a cloud chat.
        if remote {
            return Ok(rows.into_iter().filter(|row| !is_local_cloud_draft(row)).collect());
        }
        return Ok(rows);
    }
    if remote {
        return Ok(Vec::new());
    }
    let rows = load_summaries(data_dir, workspace)?;
    let journeys = store::with_conn(&conv_store_dir(data_dir, workspace), store::list_journeys).unwrap_or_default();
    let _ = crate::appdb::replace_sidebar(&conn, workspace, &rows, &journeys);
    Ok(rows)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_get_conversation(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
) -> Result<Conversation> {
    let dir = conv_store_dir(&state.data_dir, &workspace);
    match store::with_conn(&dir, |conn| store::get_conversation(conn, &id)) {
        Ok(row) => Ok(row),
        Err(e) => {
            if store::db_path(&dir).exists() {
                Err(e)
            } else {
                load_conversations_json(&state.data_dir, &workspace)?
                    .into_iter()
                    .find(|c| c.id == id)
                    .ok_or_else(|| Error::NotFound("conversation not found".into()))
            }
        }
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_save_conversation(
    state: State<'_, AppState>,
    workspace: String,
    conversation: Conversation,
) -> Result<Conversation> {
    let dir = conv_store_dir(&state.data_dir, &workspace);
    match store::with_conn(&dir, |conn| store::save_conversation(conn, &conversation)) {
        Ok(()) => {
            remember_sidebar(&state, &workspace);
            Ok(conversation)
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
    match store::with_conn(&dir, |conn| store::reorder_conversations(conn, &ids)) {
        Ok(rows) => {
            remember_sidebar(&state, &workspace);
            Ok(rows)
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
pub fn dev_archive_conversation(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
    archived: bool,
) -> Result<()> {
    let dir = conv_store_dir(&state.data_dir, &workspace);
    match store::with_conn(&dir, |conn| {
        store::set_conversation_archived(conn, &id, archived)
    }) {
        Ok(()) => {
            remember_sidebar(&state, &workspace);
            Ok(())
        }
        Err(e) => {
            if store::db_path(&dir).exists() {
                return Err(e);
            }
            let mut rows = load_conversations_json(&state.data_dir, &workspace)?;
            let Some(row) = rows.iter_mut().find(|c| c.id == id) else {
                return Err(Error::NotFound("conversation not found".into()));
            };
            row.archived = archived;
            save_conversations_json(&state.data_dir, &workspace, &rows)
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
    match store::with_conn(&dir, |conn| store::delete_conversation(conn, &id)) {
        Ok(()) => {
            remember_sidebar(&state, &workspace);
            Ok(())
        }
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
pub async fn dev_list_journeys(state: State<'_, AppState>, workspace: String) -> Result<Vec<Journey>> {
    let data_dir = state.data_dir.clone();
    let remote = remote_workspace(&state, &workspace);
    crate::dev::commands::off_main(move || list_journeys_blocking(&data_dir, &workspace, remote)).await
}

fn list_journeys_blocking(data_dir: &Path, workspace: &str, remote: bool) -> Result<Vec<Journey>> {
    let conn = crate::appdb::open(data_dir)?;
    if crate::appdb::sidebar_cached(&conn, workspace)? {
        return Ok(crate::appdb::sidebar_for(&conn, workspace)?.1);
    }
    if remote {
        return Ok(Vec::new());
    }
    let journeys = store::with_conn(&conv_store_dir(data_dir, workspace), store::list_journeys)?;
    let conversations = load_summaries(data_dir, workspace).unwrap_or_default();
    let _ = crate::appdb::replace_sidebar(&conn, workspace, &conversations, &journeys);
    Ok(journeys)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_create_journey(
    state: State<'_, AppState>,
    workspace: String,
    conversation_id: String,
) -> Result<Journey> {
    let dir = conv_store_dir(&state.data_dir, &workspace);
    let journey = store::with_conn(&dir, |conn| store::create_journey(conn, &dir, &conversation_id))?;
    remember_sidebar(&state, &workspace);
    Ok(journey)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_rename_journey(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
    title: String,
) -> Result<Journey> {
    let journey = with_store(&state.data_dir, &workspace, |conn| {
        store::rename_journey(conn, &id, &title)
    })?;
    remember_sidebar(&state, &workspace);
    Ok(journey)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_delete_journey(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
    delete_chats: bool,
) -> Result<()> {
    let dir = conv_store_dir(&state.data_dir, &workspace);
    store::with_conn(&dir, |conn| {
        store::delete_journey(conn, &dir, &id, delete_chats)
    })?;
    remember_sidebar(&state, &workspace);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_set_journey_collapsed(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
    collapsed: bool,
) -> Result<()> {
    with_store(&state.data_dir, &workspace, |conn| {
        store::set_journey_collapsed(conn, &id, collapsed)
    })?;
    remember_sidebar(&state, &workspace);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_set_journey_color(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
    color: String,
) -> Result<Journey> {
    let journey = with_store(&state.data_dir, &workspace, |conn| {
        store::set_journey_color(conn, &id, &color)
    })?;
    remember_sidebar(&state, &workspace);
    Ok(journey)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_move_conversation(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
    journey_id: Option<String>,
) -> Result<Conversation> {
    let conversation = with_store(&state.data_dir, &workspace, |conn| {
        store::move_conversation(conn, &id, journey_id.as_deref())
    })?;
    remember_sidebar(&state, &workspace);
    Ok(conversation)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_reorder_sidebar(
    state: State<'_, AppState>,
    workspace: String,
    items: Vec<SidebarItem>,
) -> Result<Vec<ConversationSummary>> {
    let rows = with_store(&state.data_dir, &workspace, |conn| {
        store::reorder_sidebar(conn, &items)?;
        store::list_conversation_summaries(conn)
    })?;
    remember_sidebar(&state, &workspace);
    Ok(rows)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_get_journey_knowledge(
    state: State<'_, AppState>,
    workspace: String,
    journey_id: String,
) -> Result<String> {
    let dir = conv_store_dir(&state.data_dir, &workspace);
    store::with_conn(&dir, |conn| store::get_knowledge(&dir, conn, &journey_id))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_save_journey_knowledge(
    state: State<'_, AppState>,
    workspace: String,
    journey_id: String,
    contents: String,
) -> Result<()> {
    let dir = conv_store_dir(&state.data_dir, &workspace);
    store::with_conn(&dir, |conn| {
        store::save_knowledge(&dir, conn, &journey_id, &contents)
    })
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
    store::with_conn(&dir, |conn| {
        store::update_knowledge(
            &dir,
            conn,
            &journey_id,
            &mode,
            contents.as_deref(),
            old_string.as_deref(),
            new_string.as_deref(),
        )
    })
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
                model: None,
                context_window: None,
                permission: None,
                archived: false,
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
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
            }),
            compaction: None,
            journey_id: None,
            sort_order: 0,
            effort: None,
            model: None,
            context_window: None,
            permission: None,
            archived: false,
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
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
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
