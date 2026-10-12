# twanagent-server

`twanagent-server` is the headless program that runs on a paired machine. It has no window. The TwanAgent app copies it to `~/.twanagent/bin/twanagent-server` and starts it over SSH.

Pairing writes `~/.twanagent/auth-token` on that machine and keeps the same token in the app database. The token is not an SSH password.

## Check it

On the machine:

```sh
~/.twanagent/bin/twanagent-server --version
```

That prints `twanagent-server` and the version, for example `twanagent-server 1.0.0-beta.1`.

From this Mac, for the OrbStack test machine:

```sh
ssh -p 22 twanluttik@192.168.139.200 ~/.twanagent/bin/twanagent-server --version
```

## Run it

```sh
~/.twanagent/bin/twanagent-server --project ~/project --data ~/.twanagent/data
```

- `--project` is the folder the tools read and edit.
- `--data` is where the server keeps its own store. The app creates this directory.

Both flags are required. Without them the program prints the usage line and exits with status 2.

The process then reads frames from stdin and writes frames to stdout. Each frame is a 4-byte big-endian length followed by JSON. The first frame the app sends is `hello`. Leave this process running for the session. Closing stdin stops it.

## Build it for a Linux machine

The Mac app binary cannot run on Linux. From the repo, for an arm64 machine such as OrbStack:

```sh
cargo zigbuild --manifest-path src-tauri/service/Cargo.toml \
  --release --target aarch64-unknown-linux-gnu --bin twanagent-server
```

The binary is `src-tauri/target/aarch64-unknown-linux-gnu/release/twanagent-server`. Install in the app copies that file. For an x86_64 machine, use `x86_64-unknown-linux-gnu` instead.
