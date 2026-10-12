# twanagent-server

`twanagent-server` is the headless program that runs on a paired machine. It has no window. The TwanAgent app copies it to `~/.twanagent/bin/twanagent-server` and starts it over SSH.

Pairing writes `~/.twanagent/auth-token` on that machine and keeps the same token in the app database. The token is not an SSH password.

## Check it

On the machine:

```sh
~/.twanagent/bin/twanagent-server --version
```

That prints `twanagent-server` and the server version, for example `twanagent-server 1.0.0-beta.3`. The server version is not the desktop app version. A server binary can be updated on its own, without a new TwanAgent release.

From this Mac, for an OrbStack machine. The VM's bridge address is not reachable from the Mac. `<machine>@orb` is the login OrbStack publishes:

```sh
ssh <user>@<machine>@orb ~/.twanagent/bin/twanagent-server --version
```

The add-server check looks for that binary and for `~/.twanagent/auth-token`. A token of 32 or more hex characters means the machine is already paired. Connecting then keeps that token instead of writing a new one.

## Run it

```sh
~/.twanagent/bin/twanagent-server --project ~/project --data ~/.twanagent/data
```

- `--project` is the folder the tools read and edit.
- `--data` is where the server keeps its own store. The app creates this directory.

Both flags are required. Without them the program prints the usage line and exits with status 2.

The process then reads frames from stdin and writes frames to stdout. Each frame is a 4-byte big-endian length followed by JSON. The first frame the app sends is `hello`. Leave this process running for the session. Closing stdin stops it.

## Live socket

A running turn also publishes on a WebSocket at `127.0.0.1:8731`. The process binds that address only, so it is not reachable from another machine except through SSH. The desktop app opens `ssh -N -L` to that port and sends `{"type":"subscribe","id":"<conversation>"}`. Each later text frame is `status`, `delta`, `done`, or `error`.

`--live` starts the socket and waits. A turn also starts it in the process that is answering the prompt, which is the process that publishes. Rebuild and install `twanagent-server` on the machine before the socket exists there.

## Build it for a Linux machine

The Mac app binary cannot run on Linux. From the repo, for an arm64 machine such as OrbStack:

```sh
cargo zigbuild --manifest-path src-tauri/service/Cargo.toml \
  --target-dir src-tauri/target \
  --release --target aarch64-unknown-linux-gnu --bin twanagent-server
```

The binary is `src-tauri/target/aarch64-unknown-linux-gnu/release/twanagent-server`. Install in the app copies the newest build of that file. For an x86_64 machine, use `x86_64-unknown-linux-gnu` instead. `--target-dir` is required when the command starts at the repo root: Cargo then treats the service crate as its own workspace and would write `src-tauri/service/target` instead. The installer checks that folder too, but only the newest build. Rebuild before pressing Update. The app copies whatever is already built, and a stale binary keeps the old version on the machine.
