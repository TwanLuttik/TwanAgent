# TwanAgent

Standalone Tauri app for the Grok coding workspace.

- Frontend: `src/`
- Rust: `src-tauri/src/`
- Data: app data dir (conversations, `secrets.json`, `projects-location.json`)
- Projects: `~/twanagent/projects`. Existing app-support projects are migrated there and keep their conversations.
- Keychain service: `app.twanagent.desktop`

## Chats

Normal chats are the product. Grok plan mode lives there: the same `enter_plan_mode` / `exit_plan_mode` tools and `~/.grok/sessions/<cwd>/<conversation-id>/plan.md` files as the Grok CLI. It is Grok-only. Claude chats do not get those tools.

Terminal chats (`kind: "terminal"`) spawn the Grok CLI in a PTY. They are deprecated. Do not add features there. Keep them only so old terminal conversations still open.

This repo stands on its own. Do not depend on another app's source tree.

## File names

Frontend files do not use a `dev` or `dev-` prefix. Rust command names such as `dev_list_conversations` stay as they are.
