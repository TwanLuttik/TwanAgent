#!/bin/sh
# Build twanagent-server into the folder the app copies from.
# See docs/twanagent-server.md.
#
#   scripts/build-server.sh            this machine, release
#   scripts/build-server.sh linux      Linux arm64
#   scripts/build-server.sh linux-x64  Linux x86_64
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$root"

if ! command -v cargo >/dev/null 2>&1 && [ -x "$HOME/.cargo/bin/cargo" ]; then
  PATH="$HOME/.cargo/bin:$PATH"
  export PATH
fi

manifest=src-tauri/service/Cargo.toml
target_dir=src-tauri/target
kind=${1:-host}

usage() {
  echo "usage: scripts/build-server.sh [host|linux|linux-x64]" >&2
  exit 2
}

if [ "$kind" = "-h" ] || [ "$kind" = "--help" ]; then
  echo "usage: scripts/build-server.sh [host|linux|linux-x64]"
  echo "  host       this machine, release (default)"
  echo "  linux      Linux arm64"
  echo "  linux-x64  Linux x86_64"
  exit 0
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is not installed. Install Rust from https://rustup.rs" >&2
  exit 1
fi

build_host() {
  cargo build --manifest-path "$manifest" --target-dir "$target_dir" --release --bin twanagent-server
  bin="$root/$target_dir/release/twanagent-server"
  echo ""
  echo "Built $bin"
  "$bin" --version
  echo "The app copies this file onto a macOS server. A Linux server needs: scripts/build-server.sh linux"
}

build_linux() {
  triple=$1
  if ! command -v cargo-zigbuild >/dev/null 2>&1; then
    echo "Linux builds need cargo-zigbuild and Zig." >&2
    echo "  brew install zig && cargo install cargo-zigbuild" >&2
    exit 1
  fi
  rustup target add "$triple"
  cargo zigbuild --manifest-path "$manifest" \
    --target-dir "$target_dir" \
    --release --target "$triple" --bin twanagent-server
  bin="$root/$target_dir/$triple/release/twanagent-server"
  version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$manifest" | head -n 1)
  echo ""
  echo "Built $bin"
  echo "twanagent-server $version"
  echo "The app copies this file when you update a Linux server ($triple)."
}

case "$kind" in
  host | mac | macos | darwin) build_host ;;
  linux | linux-arm | linux-arm64 | aarch64-unknown-linux-gnu) build_linux aarch64-unknown-linux-gnu ;;
  linux-x64 | linux-amd64 | x86_64-unknown-linux-gnu) build_linux x86_64-unknown-linux-gnu ;;
  *) usage ;;
esac
