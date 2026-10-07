# TwanAgent

Standalone Tauri desktop for a Grok coding workspace.

## Decisions

- Its own repository and app data. Not a member of another app.
- Lift-and-shift of the workspace UI and Rust commands.
- Fresh data. No import of conversations, recents, or the xAI key.
- Copy-out, then diverge. No shared crate.

## Product

Bundle id `app.twanagent.desktop`. App data in its own Application Support folder. Close quits the app. No tray and no autostart.

First launch is the landing composer: open a folder, create a project, or clone a repo, then talk to Grok. Conversations, recents, model/effort, and any saved key start empty.

Settings: Grok CLI / xAI key, theme, space-corner art.

## Stack

Tauri 2, Vite, React, Tailwind. Vite dev server on port 1430.

## Layout

```
TwanAgent/
  src/                 React UI
  src-tauri/           Tauri + workspace/Grok/PTY
  docs/superpowers/specs/
```

Frontend is the current Dev workspace (composer, conversations, chat, editor, tree, terminal, git, folder picker) plus the chrome it already uses (window buttons, flash, symbols, markdown, theme).

Rust is `dev.rs`, `grok_cli.rs`, `pty.rs`, plus slim `error`, `paths`, `secrets` (xAI key only, keychain service `app.twanagent.desktop`), and `AppState { data_dir }`.

Prefs and theme keys use the `twanagent.*` prefix.

## Chat turn

`completeTurn` in the UI streams `dev_chat_start` events, runs workspace tools, asks before `run_command`, and persists the conversation under TwanAgent’s data dir.
