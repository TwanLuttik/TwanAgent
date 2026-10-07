# TwanAgent

Standalone Tauri app for the Grok coding workspace.

- Frontend: `src/`
- Rust: `src-tauri/src/`
- Data: app data dir (conversations, `secrets.json`, `projects-location.json`)
- Projects: `~/twanagent/projects`. Existing app-support projects are migrated there and keep their conversations.
- Keychain service: `app.twanagent.desktop`

This repo stands on its own. Do not depend on another app's source tree.

## File names

Frontend files do not use a `dev` or `dev-` prefix. Rust command names such as `dev_list_conversations` stay as they are.
