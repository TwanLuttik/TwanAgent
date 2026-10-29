# Sidebar index

The sidebar does not open each project's database at startup. It reads one index in `app.db`.

## What is stored

`app.db` has two tables the sidebar uses:

- `sidebar_projects` — one row per project whose index has been built. The path is lowercase, with the trailing slash removed.
- `sidebar_conversations` — the fields the sidebar paints: title, dates, kind, order, model, effort, context size, permission, archived.

An older `sidebar_journeys` table may still be in the file. The sidebar does not read it.

Messages are not in the index. Opening a chat still reads that project's `store.db`.

## Where the chats really live

The index is a copy. The source stays put.

- A project on this Mac keeps its chats in `store.db` under the app data directory, one database per project.
- A project on a server keeps its chats on that server. Listing it does not read the empty local mount and does not cache that empty result. The index is written only after a refresh that actually got rows from the server.

Deleting the index loses nothing. The next list rebuilds it from the project database.

## When it updates

`dev_sidebar_snapshot` reads every indexed project in one query. Launch paints that list once. A project with no index row is filled afterwards from its own store.

`dev_list_conversations` reads the index when `sidebar_projects` has a row for that project. The first list for a project reads its `store.db` once, writes the index, and returns those rows.

These commands write the project database first, then refresh that project's index:

- save, reorder, archive, and delete a conversation
- reorder the sidebar

Removing a project deletes its index rows too.

Do not read `store.db` to paint the sidebar of a project that is already in the index. Add the new field to the index tables and to the refresh instead.
