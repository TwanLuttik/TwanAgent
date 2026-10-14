# twanagent-server

`twanagent-server` is the headless program that runs on a paired machine. It has no window. The TwanAgent app copies it to `~/.twanagent/bin/twanagent-server` and starts it over SSH.

Pairing writes `~/.twanagent/auth-token` on that machine and keeps the same token in the app database. The token is not an SSH password.

## Check it

On the machine:

```sh
~/.twanagent/bin/twanagent-server --version
```

That prints `twanagent-server` and the server version, for example `twanagent-server 1.0.0-beta.3`. The server version is not the desktop app version. A server binary can be updated on its own, without a new TwanAgent release.

A server check also links that program to `~/.local/bin/twanagent-server` and adds `~/.local/bin` to `PATH` in the shell startup files when it is missing. A new shell can then run `twanagent-server` without the full path.

From this Mac, for an OrbStack machine. The VM's bridge address is not reachable from the Mac. `<machine>@orb` is the login OrbStack publishes:

```sh
ssh <user>@<machine>@orb ~/.twanagent/bin/twanagent-server --version
```

The add-server check looks for that binary and for `~/.twanagent/auth-token`. A token of 32 or more hex characters means the machine is already paired. Connecting then keeps that token instead of writing a new one.

## Run it

```sh
~/.twanagent/bin/twanagent-server --project ~/project --data ~/.twanagent/data
```

Chats for that project are stored under `--data/projects/<id>`, so two projects on the same machine do not share a conversation list. The app creates the data directory.

`--project` and `--data` are required for this run. `--version` and `--live` do not need them. Without a required flag the program prints the usage line and exits with status 2. An unknown argument does the same.

The process then reads frames from stdin and writes frames to stdout. Each frame is a 4-byte big-endian length followed by JSON. The first frame the app sends is `hello`. Leave this process running for the session. Closing stdin stops it.

## Arguments

```
twanagent-server --serve --data <dir>
twanagent-server --call --project <dir> --data <dir> [--frame <base64>]
twanagent-server --live [--data <dir>]
twanagent-server --version
```

| Argument | Value | What it does |
| --- | --- | --- |
| `--project` | directory | The folder the tools read and edit. Required with the default run and with `--call`. Passed through as written, so `~` is not expanded. |
| `--data` | directory | Where the server keeps keys and the live tail. A leading `$HOME` is expanded. Required except for `--version` and `--live`. |
| `--serve` | none | Stay up, bind `127.0.0.1:8731`, and run turns. If that port is already taken, print the address and exit. The process that bound it first is the one that publishes. |
| `--call` | none | Read one store frame, write one reply, then exit. Does not bind the socket and does not run a turn. The desktop app uses this over SSH. Without `--frame`, the frame is read from stdin. |
| `--frame` | base64 | The one request frame, base64-encoded. SSH runs the program through a shell, so a pipe never reaches it. Used with `--call`. |
| `--live` | none | Bind the live socket and wait, without reading turn frames. `--project` is not required. When `--data` comes first, that directory is used. Otherwise the default is `$HOME/.twanagent`. Flags after `--live` are not read. |
| `--version` | none | Print `twanagent-server` and the server version, then exit. No other flag is required. |

`--serve` is that process. `--data` for the app is `$HOME/.twanagent`. A turn is a frame on `~/.twanagent/serve.stdin`, not a second process. `--call` stays for listing and loading chats.

## Live socket

`--serve` publishes on a WebSocket at `127.0.0.1:8731`. The process binds that address only, so it is not reachable from another machine except through SSH. The desktop app opens one `ssh -N -L` to that port and, when a conversation is on screen, sends `{"type":"subscribe","id":"<conversation>"}`. Each later text frame is `status`, `delta`, `done`, or `error`. A client that joins while a turn is unfinished first receives the frames already written, then the ones still to come. The socket stays open after `done`, so the next turn on that conversation uses the same subscription. Closing the conversation sends nothing more. The desktop closes its side.

`--live` only binds the socket and waits. It does not run turns. If something is already listening, the command prints the address and exits. The process that bound the port first is the one that publishes. Rebuild and install `twanagent-server` on the machine before the socket exists there.

## Build it for a Linux machine

The Mac app binary cannot run on Linux. From the repo, for an arm64 machine such as OrbStack:

```sh
cargo zigbuild --manifest-path src-tauri/service/Cargo.toml \
  --target-dir src-tauri/target \
  --release --target aarch64-unknown-linux-gnu --bin twanagent-server
```

The binary is `src-tauri/target/aarch64-unknown-linux-gnu/release/twanagent-server`. Install in the app copies the newest build of that file. For an x86_64 machine, use `x86_64-unknown-linux-gnu` instead. `--target-dir` is required when the command starts at the repo root: Cargo then treats the service crate as its own workspace and would write `src-tauri/service/target` instead. The installer checks that folder too, but only the newest build. Rebuild before pressing Update. The app copies whatever is already built, and a stale binary keeps the old version on the machine.
