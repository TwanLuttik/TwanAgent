//! Access from a group chat to the chats stored on its member projects.
//!
//! A chat id is only unique inside one project, so every call names the member alias.
//! The tools never take a filesystem path. `create_chat` adds one chat to that project.

use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};

use super::group::GroupLayout;
use super::paths::path_string;
use super::types::Conversation;
use crate::error::{Error, Result};

const TRANSCRIPT_CAP: usize = 24_000;
const TRANSCRIPT_HEAD: usize = 20_000;
const TRANSCRIPT_TAIL: usize = 2_000;

pub const PROMPT_LINE: &str = "Member projects keep their own chats. Use list_chats and read_chat to read them. Use create_chat to add a chat to one project and start it. message is that chat's first prompt.";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct ListedChat {
    pub alias: String,
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

pub fn tool_defs() -> Vec<Value> {
    json!([
        {
            "type": "function",
            "function": {
                "name": "list_chats",
                "description": "List chats that belong to the projects in this group. Returns alias, id, title, and updated time. Does not return messages. Pass an alias to limit the list to one project. Omit it to list every project.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "alias": { "type": "string", "description": "Project alias, such as api. Empty lists every project in the group." },
                        "archived": { "type": "boolean", "description": "Include archived chats. Omit to leave them out." }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_chat",
                "description": "Read one chat that belongs to a project in this group. Read-only. alias is the project name from list_chats, and id is that chat's id.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "alias": { "type": "string", "description": "Project alias, such as api." },
                        "id": { "type": "string", "description": "Chat id from list_chats." }
                    },
                    "required": ["alias", "id"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "create_chat",
                "description": "Create a new chat in one project in this group and start it. It appears in that project's chat list while it runs. message is the first prompt.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "alias": { "type": "string", "description": "Project alias, such as api." },
                        "title": { "type": "string", "description": "Sidebar title. Omit to use the first line of message." },
                        "message": { "type": "string", "description": "Opening note stored in the new chat." }
                    },
                    "required": ["alias", "message"]
                }
            }
        }
    ])
    .as_array()
    .cloned()
    .unwrap_or_default()
}

pub fn list_member_chats(data_dir: &Path, layout: &GroupLayout, alias: &str, archived: bool) -> Result<String> {
    let rows = member_rows(data_dir, layout, alias, archived)?;
    if rows.is_empty() {
        return Ok("No chats.".into());
    }
    let mut lines = Vec::new();
    for row in rows {
        lines.push(format!(
            "{}\t{}\t{}\t{}",
            row.alias,
            row.id,
            one_line(&row.title),
            row.updated_at
        ));
    }
    Ok(lines.join("\n"))
}

pub struct CreatedChat {
    pub alias: String,
    pub workspace: String,
    pub summary: super::types::ConversationSummary,
}

pub fn create_member_chat(
    data_dir: &Path,
    layout: &GroupLayout,
    alias: &str,
    title: &str,
    message: &str,
    model: &str,
    effort: &str,
    context_window: Option<u64>,
    permission: &str,
) -> Result<CreatedChat> {
    let member = require_member(layout, alias)?;
    let message = message.trim();
    if message.is_empty() {
        return Err(Error::Other("message is empty".into()));
    }
    let title = chat_title(title, message);
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let id = uuid::Uuid::new_v4().to_string();
    let conversation = Conversation {
        id: id.clone(),
        title: title.clone(),
        created_at: now.clone(),
        updated_at: now,
        kind: "chat".into(),
        messages: vec![json!({ "role": "user", "content": message })],
        context_usage: None,
        compaction: None,
        journey_id: None,
        sort_order: 0,
        effort: nonempty(effort),
        model: nonempty(model),
        context_window: context_window.filter(|value| *value > 0),
        permission: nonempty(permission),
        archived: false,
    };
    let key = path_string(&member.path);
    super::conv::with_store(data_dir, &key, |conn| crate::store::save_conversation(conn, &conversation))?;
    let _ = super::conv::index_saved_conversation(data_dir, &key, &id);
    let summary = super::conv::with_store(data_dir, &key, |conn| crate::store::conversation_summary(conn, &id))?;
    Ok(CreatedChat {
        alias: member.alias.clone(),
        workspace: key,
        summary,
    })
}

fn nonempty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
}

fn chat_title(title: &str, message: &str) -> String {
    let given = one_line(title.trim());
    let source = if given.is_empty() {
        one_line(message)
    } else {
        given
    };
    let trimmed = source.trim();
    let title: String = trimmed.chars().take(80).collect();
    if title.is_empty() { "New chat".into() } else { title }
}

pub fn read_member_chat(data_dir: &Path, layout: &GroupLayout, alias: &str, id: &str) -> Result<String> {
    let member = require_member(layout, alias)?;
    let id = id.trim();
    if id.is_empty() {
        return Err(Error::Other("chat id is empty".into()));
    }
    let key = path_string(&member.path);
    let conversation = match super::conv::with_store(data_dir, &key, |conn| crate::store::get_conversation(conn, id)) {
        Ok(conversation) => conversation,
        Err(Error::NotFound(_)) => {
            return Err(Error::Other(format!("no chat {id} in {}", member.alias)))
        }
        Err(err) => return Err(err),
    };
    Ok(cap_transcript(&render_chat(&member.alias, &conversation)))
}

fn member_rows(data_dir: &Path, layout: &GroupLayout, alias: &str, archived: bool) -> Result<Vec<ListedChat>> {
    let alias = alias.trim();
    let members: Vec<_> = if alias.is_empty() {
        layout.members.iter().collect()
    } else {
        vec![require_member(layout, alias)?]
    };
    let mut rows = Vec::new();
    for member in members {
        let key = path_string(&member.path);
        let _ = super::conv::import_conversations_json(data_dir, &key);
        let summaries = super::conv::with_store(data_dir, &key, crate::store::list_conversation_summaries)?;
        for summary in summaries {
            if summary.archived && !archived {
                continue;
            }
            rows.push(ListedChat {
                alias: member.alias.clone(),
                id: summary.id,
                title: summary.title,
                updated_at: summary.updated_at,
            });
        }
    }
    rows.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.alias.cmp(&b.alias))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(rows)
}

fn require_member<'a>(layout: &'a GroupLayout, alias: &str) -> Result<&'a super::group::GroupMember> {
    let alias = alias.trim();
    if alias.is_empty() {
        return Err(Error::Other("name the project alias".into()));
    }
    layout
        .members
        .iter()
        .find(|member| member.alias.eq_ignore_ascii_case(alias))
        .ok_or_else(|| Error::Other(format!("no project named {alias} in this group")))
}

fn render_chat(alias: &str, conversation: &Conversation) -> String {
    let mut out = format!("{alias} {}\n{}", conversation.id, conversation.title);
    if conversation.archived {
        out.push_str("\narchived");
    }
    out.push_str(&format!("\nupdated {}\n", conversation.updated_at));
    if conversation.messages.is_empty() {
        out.push_str("\nNo messages.");
        return out;
    }
    for message in &conversation.messages {
        out.push('\n');
        out.push_str(&render_message(message));
        out.push('\n');
    }
    out
}

fn render_message(message: &Value) -> String {
    let role = message.get("role").and_then(Value::as_str).unwrap_or("message");
    let mut body = content_text(message.get("content"));
    if let Some(reasoning) = message
        .get("reasoning")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str("reasoning:\n");
        body.push_str(reasoning);
    }
    if message
        .get("images")
        .and_then(Value::as_array)
        .is_some_and(|rows| !rows.is_empty())
    {
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str("image attached");
    }
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let name = call
                .get("function")
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str)
                .or_else(|| call.get("name").and_then(Value::as_str))
                .unwrap_or("tool");
            if !body.is_empty() {
                body.push('\n');
            }
            body.push_str("tool: ");
            body.push_str(name);
        }
    }
    format!("{role}:\n{body}")
}

fn one_line(text: &str) -> String {
    text.replace(['\t', '\n', '\r'], " ")
}

fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.as_str())
                    .map(str::to_string)
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn cap_transcript(text: &str) -> String {
    let len = text.chars().count();
    if len <= TRANSCRIPT_CAP {
        return text.to_string();
    }
    let head: String = text.chars().take(TRANSCRIPT_HEAD).collect();
    let tail: String = text.chars().skip(len - TRANSCRIPT_TAIL).collect();
    let omitted = len - TRANSCRIPT_HEAD - TRANSCRIPT_TAIL;
    format!("{head}\n… omitted {omitted} characters …\n{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dev::group::create_group;
    use std::fs;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn chat(id: &str, title: &str, updated: &str, body: &str, archived: bool) -> Conversation {
        Conversation {
            id: id.into(),
            title: title.into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: updated.into(),
            kind: "chat".into(),
            messages: vec![json!({ "role": "user", "content": body })],
            context_usage: None,
            compaction: None,
            journey_id: None,
            sort_order: 0,
            effort: None,
            model: None,
            context_window: None,
            permission: None,
            archived,
        }
    }

    fn save(data_dir: &Path, workspace: &Path, conversation: &Conversation) {
        let key = path_string(workspace);
        super::super::conv::with_store(data_dir, &key, |conn| {
            crate::store::save_conversation(conn, conversation)
        })
        .unwrap();
    }

    fn grouped() -> (tempfile::TempDir, tempfile::TempDir, tempfile::TempDir, tempfile::TempDir, GroupLayout) {
        let data = temp_dir();
        let projects = temp_dir();
        let api_root = temp_dir();
        let web_root = temp_dir();
        let api = api_root.path().join("api");
        let web = web_root.path().join("web");
        fs::create_dir(&api).unwrap();
        fs::create_dir(&web).unwrap();
        let created = create_group(data.path(), projects.path(), "apps", &[api, web]).unwrap();
        let layout = crate::dev::group::layout(std::path::Path::new(&created.path)).unwrap();
        (data, projects, api_root, web_root, layout)
    }

    #[test]
    fn list_and_read_stay_inside_the_named_project() {
        let (data, _projects, _api_root, _web_root, layout) = grouped();
        let api = layout.members.iter().find(|member| member.alias == "api").unwrap();
        let web = layout.members.iter().find(|member| member.alias == "web").unwrap();
        save(data.path(), &api.path, &chat("shared", "Api login", "2026-02-02T00:00:00Z", "api token check", false));
        save(data.path(), &web.path, &chat("shared", "Web login", "2026-03-03T00:00:00Z", "web token check", false));
        save(data.path(), &web.path, &chat("old", "Old web", "2026-01-01T00:00:00Z", "archived body", true));
        save(data.path(), &layout.root, &chat("group-chat", "Group only", "2026-04-04T00:00:00Z", "not a member", false));

        let listed = list_member_chats(data.path(), &layout, "", false).unwrap();
        assert!(listed.contains("web\tshared\tWeb login"), "{listed}");
        assert!(listed.contains("api\tshared\tApi login"), "{listed}");
        assert!(!listed.contains("Old web"), "{listed}");
        assert!(!listed.contains("Group only"), "{listed}");
        assert!(!listed.contains("api token"), "{listed}");

        let only_api = list_member_chats(data.path(), &layout, "api", false).unwrap();
        assert!(only_api.contains("Api login"), "{only_api}");
        assert!(!only_api.contains("Web login"), "{only_api}");

        let with_archived = list_member_chats(data.path(), &layout, "web", true).unwrap();
        assert!(with_archived.contains("Old web"), "{with_archived}");

        let api_text = read_member_chat(data.path(), &layout, "api", "shared").unwrap();
        assert!(api_text.contains("api token check"), "{api_text}");
        assert!(!api_text.contains("web token check"), "{api_text}");
        let web_text = read_member_chat(data.path(), &layout, "web", "shared").unwrap();
        assert!(web_text.contains("web token check"), "{web_text}");
        let mut reasoned = chat("note", "Line\nbreak", "2026-02-01T00:00:00Z", "seen", false);
        reasoned.messages[0]
            .as_object_mut()
            .unwrap()
            .insert("reasoning".into(), json!("thought about it"));
        save(data.path(), &api.path, &reasoned);
        let note = read_member_chat(data.path(), &layout, "api", "note").unwrap();
        assert!(note.contains("reasoning:\nthought about it"), "{note}");
        let titles = list_member_chats(data.path(), &layout, "api", false).unwrap();
        assert!(titles.contains("Line break"), "{titles}");
        assert!(!titles.contains("Line\nbreak"), "{titles}");
        assert!(read_member_chat(data.path(), &layout, "api", "old").is_err());
        let created = create_member_chat(
            data.path(),
            &layout,
            "web",
            "Handoff\nplan",
            "Look at the login page.",
            "grok-4.6",
            "high",
            Some(512_000),
            "approve-all",
        )
        .unwrap();
        assert_eq!(created.alias, "web");
        assert_eq!(created.summary.title, "Handoff plan");
        let after = list_member_chats(data.path(), &layout, "web", false).unwrap();
        assert!(after.contains(&format!("web\t{}\tHandoff plan", created.summary.id)), "{after}");
        let note = read_member_chat(data.path(), &layout, "web", &created.summary.id).unwrap();
        assert!(note.contains("Look at the login page."), "{note}");
        let group_only = list_member_chats(data.path(), &layout, "", false).unwrap();
        assert!(!group_only.contains("Group only"), "{group_only}");
        assert!(create_member_chat(data.path(), &layout, "missing", "Nope", "text", "", "", None, "").is_err());
        assert!(create_member_chat(data.path(), &layout, "api", "Nope", "  ", "", "", None, "").is_err());
        assert!(read_member_chat(data.path(), &layout, "missing", "shared").is_err());
        assert!(list_member_chats(data.path(), &layout, "missing", false).is_err());
    }

    #[test]
    fn a_long_transcript_keeps_the_start_and_the_end() {
        let (data, _projects, _api_root, _web_root, layout) = grouped();
        let api = layout.members.iter().find(|member| member.alias == "api").unwrap();
        let body = "x".repeat(30_000);
        save(data.path(), &api.path, &chat("long", "Long", "2026-02-02T00:00:00Z", &body, false));
        let text = read_member_chat(data.path(), &layout, "api", "long").unwrap();
        assert!(text.contains("omitted"), "{text}");
        assert!(text.chars().count() < 30_000);
        assert!(text.starts_with("api long"));
        assert!(text.trim_end().ends_with('x'));
    }
}
