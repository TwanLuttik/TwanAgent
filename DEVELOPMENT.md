# Development

TwanAgent is a [Tauri](https://tauri.app) 2 app. The interface is React and TypeScript in `src/`. The native shell, chat streaming, files, git, and SSH are Rust in `src-tauri/`.

## Requirements

- macOS, Linux, or Windows
- Node.js 22 or newer
- Rust stable (`rustup` toolchain)
- A C toolchain and the system packages Tauri needs for your OS ([Tauri prerequisites](https://tauri.app/start/prerequisites/))
- [Grok CLI](https://x.ai/cli) signed in (`grok login`), or an xAI API key in Settings
- Optional: Claude CLI signed in (`claude login`), or an Anthropic API key in Settings

On Windows, use the `x86_64-pc-windows-msvc` Rust toolchain and Visual Studio 2022
Build Tools with **Desktop development with C++**, MSVC x64 tools, and the Windows
10 or 11 SDK. Install CMake and LLVM (including `libclang.dll`); the speech library
uses CMake for C++ and Clang for Rust bindings. Run native commands in a Developer
PowerShell for VS 2022 so the SDK headers are available. If another Visual Studio
installation is selected, set `$env:CMAKE_GENERATOR = 'Visual Studio 17 2022'`.
Set `$env:LIBCLANG_PATH` to your LLVM `bin` directory. If Clang cannot find its
standard headers, use `clang --print-resource-dir` and the MSVC include directory
in `BINDGEN_EXTRA_CLANG_ARGS`, as shown in the Windows release workflow.

Windows also needs the [Microsoft Edge WebView2 Evergreen Runtime](https://v2.tauri.app/start/prerequisites/#webview2).

## Install

```bash
npm install
```

For Windows release development, install [Bun](https://bun.sh/) and use the
committed `package-lock.json` without adding another repository lockfile:

```powershell
bun install --frozen-lockfile --no-save
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
git diff --exit-code -- package-lock.json
if ($LASTEXITCODE -ne 0) { throw 'The committed lockfile changed' }
if (Test-Path 'bun.lock') { Remove-Item -LiteralPath 'bun.lock' }
```

The Windows release installs with `bun install --frozen-lockfile`. Both
`package-lock.json` and `bun.lock` are committed. A version bump has to update
the root `version` in `package-lock.json` as well, or the frozen install fails.
Use `bun run test` for the frontend tests and `bun x tsc --noEmit` for typechecking.

## Run

```bash
npm run tauri dev
```

That starts the Vite dev server on port 1430 and opens the desktop window. `npm run dev` starts only the web frontend.

On macOS, local network access for SSH needs a signed debug bundle. Quit the dev window, then:

```bash
npm run dev:mac
```

The debug binary has to exist first, so run `npm run tauri dev` once before `npm run dev:mac`. Signing details are in [docs/signing.md](docs/signing.md).

## Test

Frontend tests use the Node test runner and do not need a browser:

```bash
npm test
```

Typecheck:

```bash
npx tsc --noEmit
```

Rust tests, from the repo root:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

One speech test is ignored because it needs a downloaded model.

## Build

Frontend only:

```bash
npm run build
```

Desktop bundle. On macOS this also signs the app:

```bash
npm run bundle
```

`npm run tauri build` produces the same app. `npm run bundle` then renames the disk image and updater archives so the file name carries the build id, for example `TwanAgent_1.0.0-beta.2+0ab7051_aarch64.dmg`. The id is the short git commit. The app version inside the bundle stays `1.0.0-beta.2`. The `twanagent-server` version is separate and is not part of that name.

The macOS app lands in `src-tauri/target/release/bundle/macos/TwanAgent.app`.

Build an unsigned Windows x64 NSIS installer from the repo root:

```powershell
cargo check --manifest-path src-tauri/Cargo.toml --locked --target x86_64-pc-windows-msvc
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib
bun run test
bun run tauri build --target x86_64-pc-windows-msvc --bundles nsis --no-sign --ci
```

The installer lands in
`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/TwanAgent_*-setup.exe`.
The release workflow tests and checks Windows before packaging, uploads the
`TwanAgent-windows-x86_64` workflow artifact, then attaches the installer to the
release after the macOS job has created it. Signing credentials are not needed
for Windows; SmartScreen may warn because the installer is unsigned.

The existing Tauri configuration uses the default WebView2
[`downloadBootstrapper` mode](https://v2.tauri.app/distribute/windows-installer/#webview2-installation-options).
If WebView2 is missing, installation requires internet access to download it.
Installer execution and WebView2 installation need a Windows smoke test in
addition to CI packaging.

A signed build checks GitHub releases when the sidebar opens. If a newer prerelease has a `TwanAgent_*.app.tar.gz` asset, the version row shows Update. That downloads the archive, replaces this `.app`, and restarts. `tauri dev` can see the update but cannot install it, because it is not running from `TwanAgent.app`.

## Release

The desktop version and the server version are two numbers.

- Desktop: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and the root `version` in `package-lock.json`. This is the GitHub tag, such as `v1.0.0-beta.5`.
- Server: `src-tauri/service/Cargo.toml`. `twanagent-server --version` prints this. Bump it whenever the server binary changes, even when the desktop version stays put.

One tag publishes both. Pushing `v*` runs `.github/workflows/release.yml`. The macOS job creates the GitHub release and attaches the universal app. The Windows job attaches the unsigned installer and `twanagent-server` for Windows. The server job attaches the macOS and Linux server binaries. The asset names carry the service crate version:

```
twanagent-server-<server>-aarch64-apple-darwin
twanagent-server-<server>-x86_64-apple-darwin
twanagent-server-<server>-aarch64-unknown-linux-gnu
twanagent-server-<server>-x86_64-unknown-linux-gnu
twanagent-server-<server>-x86_64-pc-windows-msvc.exe
```

The app still installs a server by copying a binary built on that Mac. The release assets are what a machine without a local Cargo build can download. A server-only fix bumps the service crate, commits, and pushes a new desktop tag so the binaries are rebuilt and attached. Do not retag an existing `v*`. GitHub will not run the workflow again for a tag that already exists.

## Layout

- `src/` React interface, chat client, and frontend tests in `src/lib/tests/`
- `src-tauri/src/` Rust commands, store, providers, and tools
- `scripts/` macOS debug wrapper, build stamp, and icon script
- App data holds conversations and project location. API keys use the keychain service `app.twanagent.desktop`
- Projects default to `~/twanagent/projects`

Rust command names still use a `dev_` prefix, such as `dev_list_conversations`. Frontend files do not.
