# twanagent-server

Headless program the app copies to `~/.twanagent/bin/twanagent-server` and starts over SSH. No window.

Pairing writes `~/.twanagent/auth-token` on the machine. That token is not an SSH password. A token of 32 or more hex characters means the machine is already paired, and connecting keeps it.

The server version is the `twanagent-service` crate version, not the app version. Bump it in `src-tauri/service/Cargo.toml` before a build you want offered as an update. An unchanged version counts as already installed.

A desktop release also publishes the server. The GitHub tag is the app version (`v1.0.0-beta.5`). The same release carries `twanagent-server-<server>-<target>` assets for macOS arm64 and x86_64, Linux arm64 and x86_64, and Windows x64. See [DEVELOPMENT.md](../DEVELOPMENT.md#release).

## Check

```sh
~/.twanagent/bin/twanagent-server --version
```

Prints `twanagent-server` and the version. A check also links it to `~/.local/bin/twanagent-server` and adds that directory to `PATH`.

From this Mac, for an OrbStack machine. Use the `@orb` login, not the VM's bridge address:

```sh
ssh <user>@<machine>@orb ~/.twanagent/bin/twanagent-server --version
```

## Build

Building the app does not build the server. Run from the repo root. Keep `--target-dir`: without it Cargo writes to `src-tauri/service/target`, and the app copies the newest binary it finds. Rebuild before pressing Update.

Mac server:

```sh
cargo build --manifest-path src-tauri/service/Cargo.toml \
  --target-dir src-tauri/target \
  --release --bin twanagent-server
```

`src-tauri/target/release/twanagent-server`

Linux. The Mac binary will not run there. Add the target once, then build. Use `x86_64-unknown-linux-gnu` for x86_64.

```sh
rustup target add aarch64-unknown-linux-gnu
cargo zigbuild --manifest-path src-tauri/service/Cargo.toml \
  --target-dir src-tauri/target \
  --release --target aarch64-unknown-linux-gnu --bin twanagent-server
```

`src-tauri/target/aarch64-unknown-linux-gnu/release/twanagent-server`

## Run

```sh
~/.twanagent/bin/twanagent-server --serve --data ~/.twanagent
```

Stays up and binds `127.0.0.1:8731`. The app reaches that port through `ssh -N -L`. If the port is taken, the process already bound to it is the one serving. A missing flag or an unknown argument prints usage and exits 2.

```
twanagent-server --serve --data <dir>
twanagent-server --call --project <dir> --data <dir> [--frame <base64>]
twanagent-server --live [--data <dir>]
twanagent-server --version
```

| Flag | |
| --- | --- |
| `--data` | Keys, live tail, and per-project stores. `$HOME` is expanded. |
| `--project` | Folder the tools edit. `~` is not expanded. |
| `--serve` | Stay up and run turns. |
| `--call` | One request, one reply, then exit. The app uses this over SSH. |
| `--frame` | That request, base64-encoded. A pipe never reaches a command run through a shell. |
| `--live` | Bind the socket and wait. Does not run turns. |
| `--version` | Print the version and exit. |
