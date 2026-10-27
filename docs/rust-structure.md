# Rust structure

Tracking file for the app-crate split. IPC names, event names, and JSON fields stay as they are. React calls them from `src/lib/tauri.ts`.

Checked: `cargo test --offline --lib` in `src-tauri`. 337 passed, 0 failed, 1 ignored.

## Done

- Window size and the debug data directory moved from `lib.rs` to `window.rs`. `run()` still starts the app.
- App database commands moved to `appdb/commands.rs`. The handler calls `appdb::commands::dev_app_*`. The invoke names are still `dev_app_*`.
- `appdb::open` skips the full schema build when `schema_migrations` is already at the current version. Column and table fixes that were added after that stamp still run.
- `dev/commands.rs` is now the shared `off_main` helper plus four command files:
  - `project_cmds.rs` for the project list, open, create, clone, and delete
  - `file_cmds.rs` for files, MCP, and skills
  - `git_cmds.rs` for git
  - `shell_cmds.rs` for reveal, open-url, and `dev_run_command`
- File commands go through `dev/workspace_fs.rs`. One `WorkspaceFiles` value is local disk or SSH. The command signatures did not change.
- Tool JSON moved from `dev/chat.rs` to `dev/tool_schema.rs`. `chat` re-exports `tools_json` and `tools_json_for`, so provider call sites stay put.
- `dev/git.rs` keeps status, diff, commit, and the git process runner. Worktrees and removal sizes are `dev/git/worktree.rs`. Pull requests are `dev/git/pull_request.rs`.
- `twanagent_service::Error` converts into the app `Error` with `From`. `NotFound` stays `NotFound` instead of becoming a plain string.
- `command_surface.rs` lists every invoke name registered in `lib.rs` and checks the list is unique snake case.

## Not done

- `remote/commands.rs` is still one file. Machines, pairing, install, and capabilities share `ServerWork` and the SSH helpers. Splitting it means making that helper module first. Command names would not change.
- `local_turn.rs` still owns the turn loop and `run_tool`. The tool schemas moved. The match that runs a tool did not, because it closes over the live turn, subagents, and plan approval.
- The desktop turn loop and `twanagent-service`'s turn loop are still two implementations. Merging them is a behavior change, not a move.
- `app.db` is not cached on `AppState`. A current file skips the big migration, but each command still opens a connection.
- Provider files (`anthropic.rs`, `grok_cli.rs`, `minimax.rs`) are still large. Login, catalog, and the HTTP call stay together on purpose.
- Command functions still use the `dev_` prefix. Renaming them needs `#[tauri::command(rename = "dev_...")]` on every one. Not worth a wide diff.

## Rule for the next command

Register it in `lib.rs` `generate_handler!` and add the same name to `REGISTERED` in `command_surface.rs`. The function name is the invoke name unless `rename` says otherwise.
