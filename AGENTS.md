# TwanAgent

Standalone Tauri app for the Grok coding workspace.

- Frontend: `src/`
- Rust: `src-tauri/src/`
- Data: app data dir (conversations, `secrets.json`, `projects-location.json`)
- Projects: `~/twanagent/projects`. Existing app-support projects are migrated there and keep their conversations.
- Keychain service: `app.twanagent.desktop`

Do not depend on the BackupAnything repo.

## File names

The `dev-` prefix is leftover from an older migration that split the app in two. Ignore it.

- New files do not use a `dev-` prefix.
- When you edit an existing file whose name starts with `dev-`, rename it in that same change and drop the prefix. `dev-agent.ts` becomes `agent.ts`. Rename its test file the same way, and update every import that points at the old path.
