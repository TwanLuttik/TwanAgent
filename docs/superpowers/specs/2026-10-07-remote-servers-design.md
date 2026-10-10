# Remote servers

A user can save an SSH machine, mount a folder on it, and open a project there. The editor and the model use the same tools they already use. The host decides whether those tools hit a local folder or that server.

## Decisions

- Do not add an MCP server for this. The model already calls `read_file`, `write_file`, `edit_file`, `list_dir`, `git_*`, and `run_command`. Routing those calls is the hook.
- Do not give the model `ssh`, hostnames, or a general `ssh_exec` tool. A remote project is just the open workspace.
- File tools and the editor go through the mount when it is healthy, and SFTP when it is not.
- Commands never run against the mount path. A mount makes remote files look local. `sh -c` in that folder still runs on the laptop. `run_command`, git, builds, and the user terminal run on the server in the remote project path.
- One multiplexed SSH connection per machine. Agent commands, git, SFTP, and the user terminal each get their own channel. They do not share a shell.
- Secrets stay in the keychain. The machine record stores only a keychain account name, never the passphrase or key text.
- macOS first. Windows and Linux mounts are out of scope until the SSH session layer is proven.
- Local projects keep working unchanged.

## Product

Two new objects:

- **Machine.** Name, user, host, port, auth method, keychain account. Saved in app data. Shown in a Machines section.
- **Remote project.** A machine plus a remote directory, for example `/srv/apps/billing`. Shown in the same project list as local folders. Opening it registers a workspace id the rest of the app already understands.

Flow:

1. Add machine. Test the connection before saving.
2. Pick the machine and type a remote project path. The app creates the directory if it does not exist.
3. Mount that directory under the app data mounts folder.
4. Open the mount as the workspace. File tree, editor, and tools use it.
5. Ask the model to build or test. `run_command` is sent over the pooled SSH session, cwd = remote path, and the result comes back as a normal tool result.

The user can also open a terminal. That is an SSH PTY on its own channel, not the agent’s command channel.

## What the model sees

Nothing new in the tool list.

The system line for a remote workspace says the folder is on `<machine name>` at `<remote path>`, file tools read and write that project, and shell commands run on that server in that directory. It does not include the SSH command, key path, or mount path.

Permission modes stay as they are:

- Ask: file edits apply, shell commands wait for approval.
- Approve all: both run.
- Read only: writes and `run_command` are blocked.

Approval text shows the command and the machine name so a remote shell is obvious.

## Transports

| Work | Transport | Working directory |
|---|---|---|
| Editor, tree, `read_file`, `write_file`, `edit_file`, `list_dir` | Mount, SFTP fallback | Project root |
| `run_command`, `git_*` | SSH exec channel | Remote project path |
| User terminal | SSH PTY channel | Remote project path |
| Connection check, mkdir project | SSH exec channel | Remote home, then project path |

Output limits change for remote commands only. Local stays 60s and 80 KB. Remote defaults to 10 minutes, streams chunks to the UI, and returns at most 80 KB to the model with the exit code. The full log stays in the tool card.

## Safety

- Command cwd is the remote project path. The model cannot pass a host.
- Remote paths are checked the same way local paths are: relative to the project, no `..` escape. Absolute remote paths are only accepted from the app when creating or opening a project, not from model tools.
- The mount is rooted at the project, not at `/`.
- Host keys are remembered in app data after the user accepts the fingerprint. A changed fingerprint fails closed and asks again.
- Removing a machine unmounts its projects and deletes the keychain item. It does not delete remote files.
- Removing a remote project unmounts it and forgets the local record. It does not `rm -rf` the server directory in v1.

## Non-goals for v1

- No MCP wrapper. Add one later only if an outside agent should drive the same machines.
- No agent-managed SSH config, ProxyJump, or bastion setup. A single host and port is enough.
- No two-way file sync engine. The mount is the file view.
- No remote deletion of the project directory.
- No Windows/Linux mount implementation.
