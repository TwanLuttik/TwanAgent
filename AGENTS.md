# TwanAgent

Standalone Tauri app for the Grok coding workspace.

- Frontend: `src/`
- Rust: `src-tauri/src/`
- Data: app data dir (conversations, `secrets.json`, `projects-location.json`). The sidebar reads one index in `app.db` instead of every project database. See `docs/sidebar-index.md`.
- Projects: `~/twanagent/projects`. Existing app-support projects are migrated there and keep their conversations.
- Keychain service: `app.twanagent.desktop`

## Chats

Normal chats are the product. Grok plan mode lives there: the same `enter_plan_mode` / `exit_plan_mode` tools and `~/.grok/sessions/<cwd>/<conversation-id>/plan.md` files as the Grok CLI. It is Grok-only. Claude chats do not get those tools.

Terminal chats (`kind: "terminal"`) spawn the Grok CLI in a PTY. They are deprecated. Do not add features there. Keep them only so old terminal conversations still open.

This repo stands on its own. Do not depend on another app's source tree.

## File names

Frontend files do not use a `dev` or `dev-` prefix. Rust command names such as `dev_list_conversations` stay as they are.

## File size

A view or component that keeps growing gets split into files. `MainView.tsx` wires the screen together. The shell, sidebar, chat stage, and each new screen live in `src/views/main/` as their own components. Do not add another screen inline in `MainView.tsx`.

Hooks live in `src/hooks/`. A new `use*` file goes there, not next to a view. The shell already shares state through `MainProvider`, so do not add a second state library for the same data.

## Public repo

This repository is public. Do not commit anything that comes from the machine it was written on. That includes home paths, usernames, email addresses, SSH hosts, LAN addresses, machine names, signing identities, and tokens. Docs and tests use placeholders such as `<user>`, `<machine>`, and `dev@example`. Build output stays out of git, including `src-tauri/patches/**/target`.
