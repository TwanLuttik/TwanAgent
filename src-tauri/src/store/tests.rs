use std::fs;

use serde_json::{json, Value};
use tempfile::tempdir;

use super::{json_path, *};
use crate::dev::Conversation;

fn conv(id: &str, title: &str, messages: Vec<Value>) -> Conversation {
    Conversation {
        id: id.into(),
        title: title.into(),
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
        kind: "chat".into(),
        messages,
        context_usage: None,
        compaction: None,
        journey_id: None,
        sort_order: 0,
    }
}

#[test]
fn empty_project_creates_store_db() {
    let dir = tempdir().unwrap();
    let conn = open(dir.path()).unwrap();
    assert!(db_path(dir.path()).exists());
    assert!(list_conversations(&conn).unwrap().is_empty());
    assert!(list_journeys(&conn).unwrap().is_empty());
}

#[test]
fn imports_conversations_json_once() {
    let dir = tempdir().unwrap();
    fs::write(
        json_path(dir.path()),
        r#"[{
                "id":"c1",
                "title":"Hello",
                "created_at":"t0",
                "updated_at":"t1",
                "kind":"terminal",
                "messages":[
                    {"role":"user","content":"hi"},
                    {"role":"tool","content":"ok","tool_call_id":"t1"}
                ],
                "context_usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}
            }]"#,
    )
    .unwrap();
    let conn = open(dir.path()).unwrap();
    let rows = list_conversations(&conn).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].title, "Hello");
    assert_eq!(rows[0].kind, "terminal");
    assert_eq!(rows[0].messages.len(), 2);
    assert_eq!(rows[0].context_usage.as_ref().unwrap().prompt_tokens, 10);
    assert!(json_path(dir.path()).exists());
    fs::write(
        json_path(dir.path()),
        r#"[{"id":"other","title":"Nope","created_at":"t","updated_at":"t","messages":[]}]"#,
    )
    .unwrap();
    let again = open(dir.path()).unwrap();
    let rows = list_conversations(&again).unwrap();
    assert_eq!(rows[0].id, "c1");
    assert_eq!(rows.len(), 1);
}

#[test]
fn save_without_usage_keeps_stored_context_usage() {
    let dir = tempdir().unwrap();
    let conn = open(dir.path()).unwrap();
    let mut row = conv("c1", "Hello", vec![json!({"role":"user","content":"hi"})]);
    row.context_usage = Some(DevChatUsage {
        prompt_tokens: 138000,
        completion_tokens: 20,
        total_tokens: 138020,
    });
    save_conversation(&conn, &row).unwrap();
    row.context_usage = None;
    row.title = "Hello again".into();
    save_conversation(&conn, &row).unwrap();
    let loaded = get_conversation(&conn, "c1").unwrap();
    assert_eq!(loaded.title, "Hello again");
    assert_eq!(loaded.context_usage.as_ref().unwrap().prompt_tokens, 138000);
    assert!(loaded.compaction.is_none());
}

#[test]
fn save_keeps_compaction_until_a_new_one_is_written() {
    let dir = tempdir().unwrap();
    let conn = open(dir.path()).unwrap();
    let mut row = conv("c1", "Hello", vec![json!({"role":"user","content":"hi"})]);
    row.compaction = Some(crate::dev::DevCompaction {
        summary: "Fixed login.".into(),
        through: 4,
    });
    save_conversation(&conn, &row).unwrap();
    row.compaction = None;
    row.title = "Hello again".into();
    save_conversation(&conn, &row).unwrap();
    let loaded = get_conversation(&conn, "c1").unwrap();
    assert_eq!(loaded.compaction.as_ref().unwrap().summary, "Fixed login.");
    assert_eq!(loaded.compaction.as_ref().unwrap().through, 4);
    row.compaction = Some(crate::dev::DevCompaction {
        summary: "Also added tests.".into(),
        through: 8,
    });
    save_conversation(&conn, &row).unwrap();
    let updated = get_conversation(&conn, "c1").unwrap();
    assert_eq!(updated.compaction.as_ref().unwrap().through, 8);
}

#[test]
fn persists_message_images() {
    let dir = tempdir().unwrap();
    let conn = open(dir.path()).unwrap();
    let row = conv(
        "c1",
        "Hello",
        vec![json!({
            "role":"user",
            "content":"see",
            "images":[{
                "id":"i1",
                "path":"/tmp/a.jpg",
                "name":"a.jpg",
                "mime":"image/jpeg",
                "width":10,
                "height":10,
                "resized":false
            }]
        })],
    );
    save_conversation(&conn, &row).unwrap();
    let loaded = get_conversation(&conn, "c1").unwrap();
    assert_eq!(loaded.messages[0]["images"][0]["id"], "i1");
    assert_eq!(loaded.messages[0]["images"][0]["path"], "/tmp/a.jpg");
}

#[test]
fn persists_turn_duration() {
    let dir = tempdir().unwrap();
    let conn = open(dir.path()).unwrap();
    let row = conv(
        "c1",
        "Hello",
        vec![json!({
            "role":"assistant",
            "content":"Done.",
            "durationMs": 12400
        })],
    );
    save_conversation(&conn, &row).unwrap();
    let loaded = get_conversation(&conn, "c1").unwrap();
    assert_eq!(loaded.messages[0]["durationMs"], 12400);
    assert_eq!(loaded.messages[0]["content"], "Done.");
}

#[test]
fn persists_assistant_reasoning() {
    let dir = tempdir().unwrap();
    let conn = open(dir.path()).unwrap();
    let row = conv(
        "c1",
        "Hello",
        vec![json!({
            "role":"assistant",
            "content":"Done.",
            "reasoning":"Check the tests first."
        })],
    );
    save_conversation(&conn, &row).unwrap();
    let loaded = get_conversation(&conn, "c1").unwrap();
    assert_eq!(loaded.messages[0]["reasoning"], "Check the tests first.");
    assert_eq!(loaded.messages[0]["content"], "Done.");
}

#[test]
fn failed_import_leaves_no_db() {
    let dir = tempdir().unwrap();
    fs::write(json_path(dir.path()), "not-json").unwrap();
    assert!(open(dir.path()).is_err());
    assert!(!db_path(dir.path()).exists());
    assert!(!dir.path().join("store.db.tmp").exists());
    assert!(json_path(dir.path()).exists());
}

#[test]
fn create_journey_moves_seed_and_writes_empty_markdown() {
    let dir = tempdir().unwrap();
    let conn = open(dir.path()).unwrap();
    save_conversation(
        &conn,
        &conv(
            "c1",
            "Marketing",
            vec![json!({"role":"user","content":"ideas"})],
        ),
    )
    .unwrap();
    let journey = create_journey(&conn, dir.path(), "c1").unwrap();
    assert_eq!(journey.title, "Marketing");
    assert!(!journey.collapsed);
    let seed = get_conversation(&conn, "c1").unwrap();
    assert_eq!(seed.journey_id.as_deref(), Some(journey.id.as_str()));
    assert_eq!(seed.sort_order, 0);
    let md = knowledge_path(dir.path(), &journey.id);
    assert_eq!(fs::read_to_string(md).unwrap(), "");
    assert!(create_journey(&conn, dir.path(), "c1").is_err());
}

#[test]
fn delete_journey_keep_vs_delete_chats() {
    let dir = tempdir().unwrap();
    let conn = open(dir.path()).unwrap();
    save_conversation(&conn, &conv("a", "A", vec![])).unwrap();
    save_conversation(&conn, &conv("b", "B", vec![])).unwrap();
    let keep = create_journey(&conn, dir.path(), "a").unwrap();
    delete_journey(&conn, dir.path(), &keep.id, false).unwrap();
    let a = get_conversation(&conn, "a").unwrap();
    assert_eq!(a.journey_id, None);
    assert!(!knowledge_path(dir.path(), &keep.id).exists());

    let gone = create_journey(&conn, dir.path(), "b").unwrap();
    delete_journey(&conn, dir.path(), &gone.id, true).unwrap();
    assert!(get_conversation(&conn, "b").is_err());
    assert!(list_journeys(&conn).unwrap().is_empty());
}

#[test]
fn move_and_reorder() {
    let dir = tempdir().unwrap();
    let conn = open(dir.path()).unwrap();
    save_conversation(&conn, &conv("a", "A", vec![])).unwrap();
    save_conversation(&conn, &conv("b", "B", vec![])).unwrap();
    save_conversation(&conn, &conv("c", "C", vec![])).unwrap();
    let journey = create_journey(&conn, dir.path(), "a").unwrap();
    move_conversation(&conn, "b", Some(&journey.id)).unwrap();
    let kids = list_conversations(&conn)
        .unwrap()
        .into_iter()
        .filter(|c| c.journey_id.as_deref() == Some(journey.id.as_str()))
        .map(|c| c.id)
        .collect::<Vec<_>>();
    assert_eq!(kids, ["a", "b"]);
    reorder_conversations(&conn, &["b".into(), "a".into()]).unwrap();
    let kids = list_conversations(&conn)
        .unwrap()
        .into_iter()
        .filter(|c| c.journey_id.as_deref() == Some(journey.id.as_str()))
        .map(|c| c.id)
        .collect::<Vec<_>>();
    assert_eq!(kids, ["b", "a"]);
    assert!(reorder_conversations(&conn, &["c".into(), "b".into()]).is_err());
    reorder_sidebar(
        &conn,
        &[
            SidebarItem {
                kind: "conversation".into(),
                id: "c".into(),
            },
            SidebarItem {
                kind: "journey".into(),
                id: journey.id.clone(),
            },
        ],
    )
    .unwrap();
    let c = get_conversation(&conn, "c").unwrap();
    let j = list_journeys(&conn).unwrap().into_iter().next().unwrap();
    assert!(c.sort_order < j.sort_order);
    move_conversation(&conn, "b", None).unwrap();
    assert_eq!(get_conversation(&conn, "b").unwrap().journey_id, None);
}

#[test]
fn knowledge_get_save_and_update() {
    let dir = tempdir().unwrap();
    let conn = open(dir.path()).unwrap();
    save_conversation(&conn, &conv("a", "A", vec![])).unwrap();
    let journey = create_journey(&conn, dir.path(), "a").unwrap();
    fs::remove_file(knowledge_path(dir.path(), &journey.id)).unwrap();
    assert_eq!(get_knowledge(dir.path(), &conn, &journey.id).unwrap(), "");
    assert!(knowledge_path(dir.path(), &journey.id).exists());
    save_knowledge(dir.path(), &conn, &journey.id, "alpha beta").unwrap();
    let replaced = update_knowledge(
        dir.path(),
        &conn,
        &journey.id,
        "replace",
        Some("one two"),
        None,
        None,
    )
    .unwrap();
    assert_eq!(replaced, "one two");
    let edited = update_knowledge(
        dir.path(),
        &conn,
        &journey.id,
        "edit",
        None,
        Some("two"),
        Some("three"),
    )
    .unwrap();
    assert_eq!(edited, "one three");
    let err = update_knowledge(
        dir.path(),
        &conn,
        &journey.id,
        "edit",
        None,
        Some("missing"),
        Some("x"),
    )
    .unwrap_err();
    assert!(err.to_string().contains("not found"));
    save_knowledge(dir.path(), &conn, &journey.id, "foo foo").unwrap();
    let err = update_knowledge(
        dir.path(),
        &conn,
        &journey.id,
        "edit",
        None,
        Some("foo"),
        Some("bar"),
    )
    .unwrap_err();
    assert!(err.to_string().contains("2 times"));
    let _ = err;
}

#[test]
fn set_journey_color_persists_and_rejects_unknown() {
    let dir = tempdir().unwrap();
    let conn = open(dir.path()).unwrap();
    save_conversation(&conn, &conv("a", "A", vec![])).unwrap();
    let journey = create_journey(&conn, dir.path(), "a").unwrap();
    assert_eq!(journey.color, "");
    let next = set_journey_color(&conn, &journey.id, "blue").unwrap();
    assert_eq!(next.color, "blue");
    assert_eq!(list_journeys(&conn).unwrap()[0].color, "blue");
    assert!(set_journey_color(&conn, &journey.id, "neon").is_err());
    let cleared = set_journey_color(&conn, &journey.id, "").unwrap();
    assert_eq!(cleared.color, "");
}
