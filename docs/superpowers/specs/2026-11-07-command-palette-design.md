# Command palette

⌘K (Ctrl+K off macOS) opens a centered dialog for jumping to work that is already in the app.

## What opens

With an empty query the dialog shows two sections:

- **Running.** Every non-archived conversation that currently has a turn in progress, newest update first. Empty "New chat" drafts stay in this list when they are actually running.
- **Finished.** The five most recently updated conversations that are not running, not archived, and not an empty "New chat" draft.

Projects and files stay out of this home list.

## Search

Typing filters the same dialog:

- Conversations match title, preview, project name, or project path. Archived chats stay hidden. Running matches sort above an equal text match. Cap 20.
- Projects match name or path. Cap 8. Sidebar order is otherwise preserved aside from the match rank.

An empty result says so. Escape closes. ⌘K toggles.

## Files

Tab, or the Files button in the dialog, is the extra step that switches the same query into file search. Tab again returns to projects and conversations.

File search looks inside one project:

- If the query is non-empty and a project or conversation is highlighted, that row's project.
- Otherwise the project that is open now. The home list highlights a chat on its own, and that highlight is not a choice of project.

Files come from the in-memory tree snapshot. A project that has not been indexed yet is walked once with the existing tree snapshot command. Heavy directories stay skipped by that walk. An empty query does not list the whole tree; it asks for a query. Results cap at 40, with the file name ranked above a path match.

Choosing a file opens it in the editor. If that file's project is not the open one, the app switches to that project first. Choosing a conversation uses the existing sidebar open path. Choosing a project switches to it, and choosing the project that is already open only closes the dialog.

## Out of scope

No new backend search command. No search across every project's files at once. No changes to terminal chats beyond being able to open one that is already listed. No commit.
