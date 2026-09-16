# TwanAgent

Standalone Tauri desktop for the Grok coding workspace that used to live inside BackupAnything as Dev mode.

## Decisions

- New repo at `/Users/twanluttik/orca/projects/TwanAgent`. Not a BackupAnything workspace member.
- Lift-and-shift of the current Dev UI and Rust commands.
- BackupAnything loses Dev completely: button, view, settings tab, `dev_*` / PTY commands, `dev.rs`, `grok_cli.rs`, `pty.rs`.
- Fresh data. No import of conversations, recents, or the xAI key.
- Copy-out, then diverge. No shared crate.

## Product

Bundle id `app.twanagent.desktop`. App data in its own Application Support folder. Close quits the app. No tray, no autostart, no “Exit to BackupAnything.”

First launch is the landing composer: open a folder, create a project, or clone a repo, then talk to Grok. Conversations, recents, model/effort, and any saved key start empty.

Settings: Grok CLI / xAI key, theme, space-corner art.

## Stack

Tauri 2, Vite, React, Tailwind. Vite dev server on port 1430 so it can run next to BackupAnything.

## Layout

```
TwanAgent/
  src/                 React UI
  src-tauri/           Tauri + workspace/Grok/PTY
  docs/superpowers/specs/
```

Frontend is the current Dev workspace (composer, conversations, chat, editor, tree, terminal, git, folder picker) plus the chrome it already uses (window buttons, flash, symbols, markdown, theme).

Rust is `dev.rs`, `grok_cli.rs`, `pty.rs`, plus slim `error`, `paths`, `secrets` (xAI key only, keychain service `app.twanagent.desktop`), and `AppState { data_dir }`.

Prefs and theme keys use the `twanagent.*` prefix so they never collide with BackupAnything.

## Chat turn

Same as today: `completeTurn` in the UI streams `dev_chat_start` events, runs workspace tools, asks before `run_command`, persists the conversation under TwanAgent’s data dir.

## BackupAnything after the split

Backup client only. No Dev overlay, no Grok settings, no PTY. `secrets.json` may still contain a leftover `xai_key` field so old files parse; the app no longer reads or writes it.
