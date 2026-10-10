# Remote servers implementation plan

> **For agentic workers:** Implement task-by-task with TDD. Do not commit unless the user asks. Do not start a task until the user accepts this plan.

**Goal:** Let the user save an SSH machine, open a project on it, and have the existing file and command tools operate there. The model calls the same functions it already calls. It never SSHes itself.

**Architecture:** A machine record and a remote-project record live in app data. Opening a remote project registers a local mount as the workspace, so the current path jail still applies to file tools. `run_command`, git, and the user terminal do not use that mount path. They borrow a channel from a pooled SSH connection and run with cwd set to the remote project path. No MCP server.

**Tech Stack:** Tauri 2, Rust, russh for SSH, rusqlite app database, macOS sshfs for the mount, React, existing tool loop in `src/lib/agent.ts`, cargo test + node:test.

Spec: `docs/superpowers/specs/2026-10-07-remote-servers-design.md`

## Global constraints

- Do not add a model-facing SSH tool, and do not connect an MCP server for this feature.
- Do not put private keys, passphrases, or host passwords in SQLite, JSON, logs, or the model prompt.
- Local workspaces keep the current `run_command` behavior: 60s timeout, 80 KB cap, local `sh -c`.
- Remote command cwd is the project path on the server. Never the mount path.
- macOS only for mounting. The SSH client itself should not call macOS APIs directly, so a later Linux port is possible.
- A changed host key fails closed.
- Deleting a machine or remote project does not delete remote files.
- Follow TDD for store, path, and command-routing logic. No `TBD` leftovers.
- Do not commit unless asked.

## File map

- Create: `src-tauri/src/remote/mod.rs` — module root
- Create: `src-tauri/src/remote/config.rs` — machine and remote-project records, validation, no secrets
- Create: `src-tauri/src/remote/ssh.rs` — russh client, known hosts, pooled connection, exec and PTY channels
- Create: `src-tauri/src/remote/mount.rs` — sshfs mount and unmount under app data
- Create: `src-tauri/src/remote/exec.rs` — remote command runner with streaming, timeout, and model-sized truncation
- Create: `src-tauri/src/remote/files.rs` — SFTP fallback used when the mount is down
- Modify: `src-tauri/Cargo.toml` — `russh`, `russh-sftp`
- Modify: `src-tauri/src/lib.rs` — `mod remote`, new commands
- Modify: `src-tauri/src/appdb.rs` — `machines` and `remote_projects` tables
- Modify: `src-tauri/src/secrets.rs` — keychain accounts for SSH secrets
- Modify: `src-tauri/src/state.rs` — connection pool handle
- Modify: `src-tauri/src/dev/commands.rs` — route `dev_run_command` and git when the workspace is a mount
- Modify: `src-tauri/src/dev/files.rs` — SFTP fallback on mount IO errors
- Modify: `src-tauri/src/pty.rs` — SSH PTY when the workspace is remote
- Modify: `src/lib/tauri.ts` — invoke wrappers
- Modify: `src/lib/permission.ts` — approval copy includes the machine, behavior unchanged
- Modify: `src/lib/agent.ts` — remote system line only, same tool execution
- Create: `src/components/MachinesDialog.tsx` — add, test, and remove machines
- Modify: project picker view that calls `dev_create_project` — add "On a server"

## Data model

`machines`

| Column | Notes |
|---|---|
| id | uuid |
| name | display name, unique |
| user | SSH user |
| host | hostname or IP |
| port | default 22 |
| auth | `agent`, `private_key`, or `password` |
| key_path | optional local path to a private key, not the key |
| secret_account | keychain account when auth needs a secret |
| created_at | ISO time |

`remote_projects`

| Column | Notes |
|---|---|
| id | uuid |
| machine_id | FK, cascade delete record only |
| name | display name |
| remote_path | absolute path on the server |
| mount_path | local mount point under `<data_dir>/mounts/<id>` |
| created_at | ISO time |

`known_hosts` is a file in app data, not a table. Entries are host, port, key type, and fingerprint. The user must accept a new or changed fingerprint.

Keychain accounts are `ssh-secret:<machine-id>`. The xAI key account stays untouched.

## Tasks

### Task 1: Records and secret accounts

**Files:** `appdb.rs`, `secrets.rs`, `remote/config.rs`, tests in those files.

- Add the two tables with a schema migration. Do not bump past a new version without a migration step.
- Validate host, port, user, and remote path before insert. Reject empty host, ports outside 1–65535, users with whitespace, and remote paths that are not absolute.
- Store and read an SSH secret through a new keychain account. Tests use the existing in-memory `SecretStore`, not the real keychain.
- Deleting a machine removes its projects rows and its secret. It does not try to unmount yet. That comes with Task 4.

**Done when:** cargo tests cover insert, duplicate name, bad path, secret roundtrip, and delete.

### Task 2: SSH session pool

**Files:** `remote/ssh.rs`, `Cargo.toml`.

- Connect with russh using the machine record and the keychain secret.
- On first connect, return the server fingerprint instead of trusting it. A separate `accept_host` call writes `known_hosts` and then connects.
- If the presented key differs from `known_hosts`, return a typed host-key error. Do not continue.
- Pool one connected client per machine id. Reconnect once if the connection is dead.
- `exec(cwd, command)` opens a channel, runs the command with the remote directory, and returns stdout, stderr, exit code, and whether it timed out.
- Unit tests can cover known-host compare, command argv construction, and pool reuse with a fake client. A live SSH test is optional and ignored unless `TWANAGENT_SSH_FIXTURE` is set.

**Done when:** a fake session proves two exec calls share one connection and use separate channels, and a changed fingerprint is rejected.

### Task 3: Remote command runner

**Files:** `remote/exec.rs`, then the branch in `dev/commands.rs` `dev_run_command`.

- Look up the workspace. If it is not a mount path for a remote project, call the existing local `run_command`.
- If it is remote, ignore the local mount path for the process cwd and call `exec` with `remote_path`.
- Remote timeout is 10 minutes. Local timeout stays 60 seconds.
- Stream stdout and stderr to the existing tool UI as chunks. The string returned to the model is still capped at 80 KB and ends with the exit code or timeout line.
- Keep the frontend permission check where it is. Only the approval label changes, in Task 6.

**Done when:** a fake remote workspace routes to SSH, and a normal temp folder still routes to local `sh`.

### Task 4: Mount and open a remote project

**Files:** `remote/mount.rs`, project commands, picker UI.

- Mount point is `<data_dir>/mounts/<project-id>`.
- On macOS, mount with `sshfs` using the already accepted host key and the machine's identity. If `sshfs` is missing, return an error that tells the user to install it. Do not silently fall back to copying the tree.
- Create the remote directory with SSH `mkdir -p` before mounting, but only after the path passed validation.
- Register the mount path with `OpenedRoots`, the same way `dev_open_folder` registers a local folder.
- Remember the remote project in `remote_projects` and also in the normal projects list so it appears in the sidebar.
- Unmount on forget and on app exit. A stale mount is unmounted and retried once before showing a connection error.
- UI: Machines dialog with name, user, host, port, auth, and a Test button. Project creation gets a server choice: pick a machine, type a remote path and project name.

**Done when:** the user can save a machine, create a remote project, see its files in the existing tree, and close it cleanly.

### Task 5: File fallback and git

**Files:** `remote/files.rs`, `dev/files.rs`, `dev/git.rs` call sites in `commands.rs`.

- If a file-tool read or write fails because the mount is unavailable, perform that one operation over SFTP against `remote_path + relative path`.
- Keep the current relative-path jail. Do not let a model path address anything outside the remote project.
- `git_status`, `git_diff`, `git_branches`, and `git_switch` run through the same remote exec path when the workspace is remote. Git output stays on the server. Do not run local git against the mount.

**Done when:** file tests prove a relative escape is rejected for a remote root, and git commands are routed remotely for a mount workspace.

### Task 6: Terminal, prompt, and permissions

**Files:** `pty.rs`, `src/lib/agent.ts`, `src/lib/permission.ts`, terminal open call.

- `dev_pty_open` for a remote workspace starts an SSH PTY channel in `remote_path` instead of a local login shell.
- The user terminal and `run_command` must not share a shell session. Sharing the connection is fine.
- Add one system line when the open workspace is remote: server display name, remote path, and the fact that shell commands run there. Do not include the mount path or key path.
- Shell approval copy includes the machine name. Read-only mode still blocks remote writes and remote commands.

**Done when:** opening the terminal on a remote project lands on the server, and the prompt snapshot test shows the remote line only for remote workspaces.

## Suggested order

Task 1 then Task 2 can land without UI. Task 3 is the command hook and should land before the mount so command routing is testable with a fake workspace. Task 4 is the first user-visible slice. Tasks 5 and 6 complete the workspace so the model is not half-local.

## Out of scope

- MCP server wrapping these commands.
- ProxyJump, bastions, and agent-edited SSH config.
- Deleting the remote directory.
- Mounts on Windows or Linux.
- A separate sync engine.
