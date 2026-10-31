#[cfg(test)]
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::paths::workspace_id;
use super::types::{Conversation, ConversationSummary, Journey, SidebarItem};
#[cfg(test)]
use super::types::default_conversation_kind;
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

fn read_conversations_json(path: &Path) -> Result<Vec<Conversation>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(path)?;
    if data.trim().is_empty() {
        return Ok(Vec::new());
    }
    Ok(serde_json::from_str(&data)?)
}

/// The JSON for this workspace, including a store that still lives under an older path.
fn conversations_json_path(data_dir: &Path, workspace: &str) -> Option<PathBuf> {
    let primary = conv_path(data_dir, workspace);
    if primary.exists() {
        return Some(primary);
    }
    let stored = conv_store_dir(data_dir, workspace).join("conversations.json");
    stored.exists().then_some(stored)
}

/// Read a leftover `conversations.json` into `store.db`, then remove the file.
/// A database that already has chats is left alone and the JSON stays until that is true.
pub(crate) fn import_conversations_json(data_dir: &Path, workspace: &str) -> Result<bool> {
    let Some(path) = conversations_json_path(data_dir, workspace) else {
        return Ok(false);
    };
    let rows = read_conversations_json(&path)?;
    let dir = conv_store_dir(data_dir, workspace);
    let imported = store::with_conn(&dir, |conn| {
        // An older open already copied these chats. The file is only a leftover.
        if !store::list_conversation_summaries(conn)?.is_empty() {
            return Ok(true);
        }
        for row in &rows {
            store::save_conversation(conn, row)?;
        }
        let ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
        if !ids.is_empty() {
            store::reorder_conversations(conn, &ids)?;
        }
        Ok(true)
    })?;
    if imported {
        if path.exists() {
            fs::remove_file(&path)?;
        }
        let _ = fs::remove_file(path.with_extension("json.tmp"));
    }
    Ok(imported)
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
    let _ = import_conversations_json(data_dir, workspace);
    store::with_conn(&dir, store::list_conversations)
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

/// After one chat is saved, touch only that sidebar row when the project is already indexed.
/// An uncached project still gets one full replace, so a single upsert cannot hide the other chats.
fn remember_saved_conversation(state: &AppState, workspace: &str, conversation: &Conversation) {
    let _ = index_saved_conversation(&state.data_dir, workspace, &conversation.id);
}

/// Copy one saved chat into the sidebar index.
///
/// Order comes from the project database. A new chat is inserted above the list, and a later
/// save leaves that place alone. The client often sends `sort_order: 0` because it never learned
/// the stored place. Writing that zero into the index is what makes the chat jump on the next read.
pub(crate) fn index_saved_conversation(data_dir: &Path, workspace: &str, id: &str) -> Result<()> {
    let app = crate::appdb::open(data_dir)?;
    let cloud = crate::appdb::sidebar_is_cloud(&app, workspace)?;
    let cached = crate::appdb::sidebar_cached(&app, workspace)?;
    if !cached && !cloud {
        let conversations = load_summaries(data_dir, workspace)?;
        let journeys =
            store::with_conn(&conv_store_dir(data_dir, workspace), store::list_journeys).unwrap_or_default();
        return crate::appdb::replace_sidebar(&app, workspace, &conversations, &journeys);
    }
    let summary = store::with_conn(&conv_store_dir(data_dir, workspace), |conn| {
        store::conversation_summary(conn, id)
    })?;
    let summary = if cloud {
        // The cached rows are the server list. A local save may refresh the title, but it must
        // not reorder a chat the server already placed.
        let (rows, _) = crate::appdb::sidebar_for(&app, workspace)?;
        match rows.into_iter().find(|row| row.id == id) {
            Some(existing) => ConversationSummary {
                sort_order: existing.sort_order,
                journey_id: existing.journey_id,
                archived: existing.archived,
                ..summary
            },
            None => summary,
        }
    } else {
        summary
    };
    crate::appdb::upsert_sidebar_conversation(&app, workspace, &summary)
}

fn load_summaries(data_dir: &Path, workspace: &str) -> Result<Vec<ConversationSummary>> {
    let dir = conv_store_dir(data_dir, workspace);
    let _ = import_conversations_json(data_dir, workspace);
    store::with_conn(&dir, store::list_conversation_summaries)
}

#[cfg(test)]
pub(crate) fn save_conversations(
    data_dir: &Path,
    workspace: &str,
    rows: &[Conversation],
) -> Result<()> {
    let dir = conv_store_dir(data_dir, workspace);
    store::with_conn(&dir, |conn| {
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
    })
}

#[cfg(test)]
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

/// A cloud project's chats live on the server. The local cache is a copy of that list,
/// marked cloud, so opening the app can paint it before the server answers.
fn remote_workspace(state: &AppState, workspace: &str) -> bool {
    let Ok(root) = state.require_workspace(workspace) else {
        return false;
    };
    crate::remote::project_for_workspace(state, &root)
        .ok()
        .flatten()
        .is_some()
}

/// Every project whose chats are already in the index, in sidebar order.
/// One read, so launch paints the list once instead of growing it project by project.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_sidebar_snapshot(state: State<'_, AppState>) -> Result<Vec<super::types::SidebarProject>> {
    let data_dir = state.data_dir.clone();
    crate::dev::commands::off_main(move || {
        let conn = crate::appdb::open(&data_dir)?;
        crate::appdb::sidebar_snapshot(&conn)
    })
    .await
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
        // A cloud cache written before the server answered can still hold an empty
        // "New chat" from the local mount. That row is not a cloud chat.
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
pub async fn dev_get_conversation(
    state: State<'_, AppState>,
    id: String,
    workspace: Option<String>,
) -> Result<Conversation> {
    let workspace = workspace.unwrap_or_default();
    let data_dir = state.data_dir.clone();
    // A cloud chat is not in the mount database. The id finds the copy saved from the server.
    let remote = workspace.trim().is_empty() || remote_workspace(&state, &workspace);
    crate::dev::commands::off_main(move || {
        if remote {
            let conn = crate::appdb::open(&data_dir)?;
            return crate::appdb::sidebar_transcript_by_id(&conn, &id)?
                .ok_or_else(|| Error::NotFound("conversation not found".into()));
        }
        let _ = import_conversations_json(&data_dir, &workspace);
        let dir = conv_store_dir(&data_dir, &workspace);
        store::with_conn(&dir, |conn| store::get_conversation(conn, &id))
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_save_conversation(
    state: State<'_, AppState>,
    workspace: String,
    conversation: Conversation,
) -> Result<Conversation> {
    let dir = conv_store_dir(&state.data_dir, &workspace);
    store::with_conn(&dir, |conn| store::save_conversation(conn, &conversation))?;
    remember_saved_conversation(&state, &workspace, &conversation);
    // Hand back the place the database kept. The payload's sort_order is often the default zero.
    let mut conversation = conversation;
    if let Ok(summary) = store::with_conn(&dir, |conn| store::conversation_summary(conn, &conversation.id)) {
        conversation.sort_order = summary.sort_order;
        conversation.journey_id = summary.journey_id;
        conversation.archived = summary.archived;
    }
    Ok(conversation)
}

#[cfg(test)]
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
    let rows = store::with_conn(&dir, |conn| store::reorder_conversations(conn, &ids))?;
    remember_sidebar(&state, &workspace);
    Ok(rows)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_archive_conversation(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
    archived: bool,
) -> Result<()> {
    let dir = conv_store_dir(&state.data_dir, &workspace);
    store::with_conn(&dir, |conn| store::set_conversation_archived(conn, &id, archived))?;
    remember_sidebar(&state, &workspace);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_delete_conversation(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
) -> Result<()> {
    let dir = conv_store_dir(&state.data_dir, &workspace);
    store::with_conn(&dir, |conn| store::delete_conversation(conn, &id))?;
    remember_sidebar(&state, &workspace);
    Ok(())
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
        assert!(!path.exists(), "the imported json should be removed");
        assert_eq!(loaded[0].kind, "chat");
        let summary = super::summary_from(loaded.into_iter().next().unwrap());
        assert_eq!(summary.kind, "chat");
    }

    fn plain(id: &str) -> Conversation {
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

    #[test]
    fn a_new_chat_does_not_move_the_others_when_the_client_sends_sort_zero() {
        let dir = temp_ws();
        let data = dir.path();
        let ws = data.join("proj").to_string_lossy().into_owned();
        let store_dir = super::conv_store_dir(data, &ws);
        store::with_conn(&store_dir, |conn| {
            store::save_conversation(conn, &plain("older"))?;
            store::save_conversation(conn, &plain("newer"))?;
            Ok(())
        })
        .unwrap();
        super::index_saved_conversation(data, &ws, "older").unwrap();
        let before = crate::appdb::sidebar_for(&crate::appdb::open(data).unwrap(), &ws)
            .unwrap()
            .0
            .into_iter()
            .map(|row| row.id)
            .collect::<Vec<_>>();
        assert_eq!(before, ["newer", "older"]);

        let mut fresh = plain("fresh");
        fresh.updated_at = "2026-06-01T00:00:00Z".into();
        store::with_conn(&store_dir, |conn| store::save_conversation(conn, &fresh)).unwrap();
        super::index_saved_conversation(data, &ws, "fresh").unwrap();
        let created = crate::appdb::sidebar_for(&crate::appdb::open(data).unwrap(), &ws)
            .unwrap()
            .0
            .into_iter()
            .map(|row| row.id)
            .collect::<Vec<_>>();
        assert_eq!(created, ["fresh", "newer", "older"]);

        fresh.title = "Renamed".into();
        fresh.sort_order = 0;
        fresh.updated_at = "2026-07-01T00:00:00Z".into();
        store::with_conn(&store_dir, |conn| store::save_conversation(conn, &fresh)).unwrap();
        super::index_saved_conversation(data, &ws, "fresh").unwrap();
        let rows = crate::appdb::sidebar_for(&crate::appdb::open(data).unwrap(), &ws)
            .unwrap()
            .0;
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            ["fresh", "newer", "older"]
        );
        assert_eq!(rows[0].title, "Renamed");
        assert!(rows[0].sort_order < rows[1].sort_order);
    }

    #[test]
    fn a_local_save_does_not_reorder_a_cloud_sidebar() {
        let dir = temp_ws();
        let data = dir.path();
        let ws = "/mounts/cloud";
        let mut kept = plain("kept");
        kept.sort_order = 4;
        let mut other = plain("other");
        other.sort_order = 1;
        crate::appdb::replace_sidebar_source(
            &crate::appdb::open(data).unwrap(),
            ws,
            &[super::summary_from(other), super::summary_from(kept.clone())],
            &[],
            true,
        )
        .unwrap();
        let store_dir = super::conv_store_dir(data, ws);
        kept.sort_order = 0;
        kept.title = "Kept".into();
        kept.updated_at = "2026-08-01T00:00:00Z".into();
        store::with_conn(&store_dir, |conn| store::save_conversation(conn, &kept)).unwrap();
        super::index_saved_conversation(data, ws, "kept").unwrap();
        let rows = crate::appdb::sidebar_for(&crate::appdb::open(data).unwrap(), ws)
            .unwrap()
            .0;
        let kept_row = rows.iter().find(|row| row.id == "kept").unwrap();
        assert_eq!(kept_row.sort_order, 4);
        assert_eq!(kept_row.title, "Kept");
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            ["other", "kept"]
        );
    }
}
