# Journeys

A Journey is a named space in a project’s sidebar. It groups conversations and gives every chat in that space the same markdown knowledge file.

## Decisions

- Product name is **Journey**. The sidebar still says Conversations.
- Entry point: right-click a **top-level** conversation → **Create Journey**. No “New Journey” button in v1.
- Creating a Journey wraps that conversation: new Journey row, seed chat moves inside it, empty knowledge file is created, then a summarize turn runs in the seed chat and the assistant reply is written into the file.
- Knowledge lives in app data as `dev/<workspace-id>/journeys/<journey-id>.md`, not in the git workspace.
- Conversations and Journeys live in SQLite at `dev/<workspace-id>/store.db`. Messages are rows, not a JSON blob. `rusqlite` with the `bundled` feature. There is no SQLite in the app today.
- Existing `conversations.json` is imported once, then ignored. The JSON file is left on disk and never written again.
- One level only. A conversation belongs to at most one Journey. Journeys cannot nest.
- Sidebar: Journey row is a taller conversation card with two buttons (open knowledge, new chat). Children indent under it and can collapse. Default after create is expanded.
- Chat-kind turns in a Journey prepend the current knowledge file to the system prompt and may call `update_journey_knowledge`. Terminal-kind rows can live in a Journey for grouping only; they do not get the prompt block or the tool (Grok CLI has its own session).
- Subagents spawned from a Journey chat get the same knowledge block. They do not get `update_journey_knowledge`.
- `update_journey_knowledge` is allowed in every permission mode. It edits app-data knowledge, not the workspace.
- Delete Journey asks: keep the chats (they become top-level) or delete the chats too. The knowledge file is always removed with the Journey.

## Storage

Per project, under the existing app-data folder:

```
dev/<workspace-id>/
  store.db
  journeys/<journey-id>.md
  conversations.json          # leftover after migrate; never written again
```

`<workspace-id>` is the existing 8-byte hex SHA-256 of the workspace path.

### Schema (version 1)

`PRAGMA foreign_keys = ON` and `PRAGMA journal_mode = WAL` on every open.

```
schema_migrations(version INTEGER PRIMARY KEY)

journeys(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  collapsed INTEGER NOT NULL DEFAULT 0
)

conversations(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  journey_id TEXT REFERENCES journeys(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL,
  context_usage TEXT
)

messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,
  tool_call_id TEXT
)
```

`context_usage` and `tool_calls` are JSON text matching the current on-disk shapes. `sort_order` is a single integer space for top-level rows (Journeys and conversations with `journey_id IS NULL`). Child conversations use `sort_order` only among siblings.

Open `store.db` per command through a small store module. No shared connection in `AppState` in v1.

### Migrate

On first open of a project:

1. If `store.db` exists, use it and ignore `conversations.json`.
2. Else if `conversations.json` exists, create the DB in a temp file, import every conversation (kind, timestamps, `context_usage`, messages in list order), then atomically rename onto `store.db`. Leave the JSON in place.
3. Else create an empty DB.
4. If import fails, delete the incomplete DB (or never rename it) and keep reading/writing `conversations.json`. Show the error. A later successful open retries the migrate.

Imported conversations have `journey_id = NULL`. `sort_order` follows the JSON array order.

After a successful migrate, every save/reorder/delete goes to SQLite only.

## Commands

Existing conversation commands keep their names and stay workspace-scoped. Internals switch from JSON to SQLite.

- `dev_list_conversations` — summaries gain `journey_id: string | null`. Full conversation payloads include it too so save can keep a chat in its Journey.
- `dev_get_conversation` / `dev_save_conversation` / `dev_delete_conversation` — same payloads plus `journey_id`; save writes conversation fields and replaces that conversation’s messages.
- `dev_reorder_conversations` — only for **siblings**. All listed ids must share the same `journey_id` (all null, or all the same Journey). Mixed lists are a no-op error. Mixed top-level order (Journeys + chats) uses `dev_reorder_sidebar`.

New:

- `dev_list_journeys` → `{ id, title, created_at, updated_at, sort_order, collapsed }[]`
- `dev_create_journey { workspace, conversation_id }` → the Journey. Ids are new UUIDs, same as conversations. Title copies the seed chat title. The Journey takes the seed’s top-level `sort_order`; the seed gets `journey_id` and child `sort_order = 0`. Creates an empty markdown file, `collapsed = 0`. Errors if the conversation is missing or already in a Journey. If `store.db` does not exist because migrate failed, this errors with that migrate failure.
- `dev_rename_journey { workspace, id, title }`
- `dev_delete_journey { workspace, id, delete_chats: bool }` — always deletes the markdown file. `delete_chats = false` leaves chats top-level (`ON DELETE SET NULL`). `delete_chats = true` deletes those conversations (messages cascade) and their terminal PTYs the same way as `dev_delete_conversation`.
- `dev_set_journey_collapsed { workspace, id, collapsed }`
- `dev_move_conversation { workspace, id, journey_id: string | null }` — into a Journey or back to top-level. Appends at the end of the destination’s order.
- `dev_reorder_sidebar { workspace, items: { kind: "journey" | "conversation", id }[] }` — full top-level order. Unknown or child ids are ignored; omitted rows keep their relative place at the end (same idea as `apply_conversation_order`).
- `dev_get_journey_knowledge` / `dev_save_journey_knowledge` — read/write the markdown file. Missing file on get returns `""` and recreates an empty file.
- `dev_update_journey_knowledge { workspace, journey_id, mode, contents?, old_string?, new_string? }` — backend for the agent tool (`replace` or `edit`). `edit` uses the same uniqueness rules as `edit_file`.

`dev_chat_start` gains optional `journey_id`. When it is a non-empty string, the tool list includes `update_journey_knowledge`. The frontend passes the active chat’s Journey id.

## Sidebar

`ConversationList` becomes a tree: top-level items are Journeys and ungrouped conversations, ordered by `sort_order`.

Journey row:

- Same card language as a chat, slightly taller.
- Title on the left, with a collapse chevron. Clicking the chevron or the row background toggles collapse (does not open a chat). The two buttons do not toggle.
- Button 1: open the knowledge markdown in the editor.
- Button 2: new conversation in this Journey (existing Chat / Terminal menu).
- Context menu: Rename, Delete.

Child row: indented under the Journey. Same open/delete/running preview as today. Context menu: Remove from Journey, Delete, Create Journey (hidden — already in a Journey).

Top-level chat context menu: Create Journey, Delete. Create Journey is hidden while that chat has a running turn.

Drag and drop:

- Reorder children inside their Journey.
- Reorder top-level Journeys and chats among themselves.
- Drop a top-level chat onto a Journey → `dev_move_conversation` into it.
- Drop a child onto the top-level list (not onto a Journey) → move out.

New chat inside a Journey is `kind` chat or terminal, `journey_id` set, inserted as the first child (matches today’s “new chat at top”).

Rename Journey is an inline title edit on the row.

Delete Journey opens a confirm: Keep conversations / Delete conversations / Cancel.

## Create flow

Right-click top-level chat → Create Journey:

1. `dev_create_journey`.
2. Reload sidebar, keep the seed chat active, Journey expanded.
3. If the seed chat has at least one user or assistant message with non-empty text, append this user message and run a normal turn:

   `Summarize this conversation into bullet points the rest of this Journey can reuse. Cover decisions, facts, and open threads. Do not add a preamble.`

4. On a successful finish, write the last assistant text into the knowledge file (overwrite). Do not write on error, cancel, or empty reply.
5. Empty seed (including typical terminal chats with no stored messages): skip the turn, leave the file empty.

The summarize turn is a real visible user message in that chat. The UI writes the file; the model does not need to call `update_journey_knowledge` for this first fill.

If step 1 succeeds and later steps fail, the Journey still exists.

## Knowledge in the editor

The knowledge button opens a special editor tab, not a workspace path.

- Tab path: `journey:<journey-id>` (reserved prefix; never passed to `dev_read_file` / `dev_write_file`).
- Tab title: `{journey title}`.
- Load/save through `dev_get_journey_knowledge` / `dev_save_journey_knowledge`.
- Markdown viewer/editor setting applies. Diff view does not.
- Dirty tracking matches file tabs. The tab is not a file-tree path.

If the Journey is deleted while the tab is open, close the tab.

## Prompt and tool

`systemPrompt` / `withSystem` gain an optional knowledge string. When non-empty, append:

```
Journey knowledge:
<markdown>
```

Read the file at send time. A running turn keeps the snapshot it started with. Empty or missing file → omit the block.

`update_journey_knowledge` (Journey chats only):

```
{
  "name": "update_journey_knowledge",
  "description": "Update this Journey's shared knowledge markdown. Use replace for a full rewrite, or edit to change one unique passage.",
  "parameters": {
    "mode": { "type": "string", "enum": ["replace", "edit"] },
    "contents": { "type": "string" },
    "old_string": { "type": "string" },
    "new_string": { "type": "string" }
  },
  "required": ["mode"]
}
```

- `replace` requires `contents` and overwrites the file via `dev_update_journey_knowledge`.
- `edit` requires `old_string` / `new_string` and replaces exactly one unique occurrence (same rules as `edit_file`).
- Unknown mode or missing fields → tool error string. Not in a Journey → tool is not offered; if called anyway, error.
- After a successful update, the next turn reads the new file. Refresh the open knowledge tab if it is not dirty.

System prompt line for Journey chats: mention that durable notes for this space go in `update_journey_knowledge`, not workspace files.

A chat moved out of a Journey stops getting the block and the tool on the next turn.

## Errors

| Case | Behavior |
|---|---|
| Seed chat already in a Journey | Create Journey is not shown |
| Seed chat is running a turn | Create Journey is not shown |
| Seed chat missing | Command error, no sidebar change |
| No user/assistant text | Create Journey, skip summarize |
| Summarize fails or is cancelled | Journey and empty/partial file remain; user can edit |
| Knowledge file missing | Recreate empty file |
| Migrate fails | No `store.db`; keep JSON; show error |
| Delete Journey with open knowledge tab | Close the tab |
| `update_journey_knowledge` edit not unique / not found | Tool error, file unchanged |

## Tests

Rust (store + commands, temp data dir):

- Empty project creates `store.db`.
- Import `conversations.json` (kinds, usage, message order, tool messages); JSON left on disk; second open does not re-import.
- Failed import leaves no `store.db` and JSON still loads.
- Create Journey moves the seed chat, writes empty markdown, rejects a second wrap.
- Delete Journey keep vs delete chats; markdown removed; keep leaves `journey_id` null.
- Move in/out; sibling reorder; top-level `dev_reorder_sidebar`.
- Knowledge get/save; missing file → empty + recreate.
- `update_journey_knowledge` replace and edit; edit uniqueness.

TypeScript:

- Sidebar tree from flat conversations + journeys (collapse, indent).
- `withSystem` includes / omits the knowledge block.
- Summarize skipped when there is no user/assistant text; run when there is.
- Tool only offered when `journey_id` is set; execute replace/edit.
- `journey:<id>` tabs load/save through knowledge APIs, not workspace file APIs.
- Subagent prompt includes knowledge; child cannot call the update tool.

## Out of scope

- Nested Journeys.
- Creating an empty Journey from the new-chat menu.
- Exporting knowledge into the workspace.
- Injecting knowledge into terminal (Grok CLI) sessions.
- Cross-project search or a single app-wide database.
- Sharing a conversation across Journeys.
