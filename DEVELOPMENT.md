# Development

TwanAgent is a [Tauri](https://tauri.app) 2 app. The interface is React and TypeScript in `src/`. The native shell, chat streaming, files, git, and SSH are Rust in `src-tauri/`.

## Requirements

- macOS, Linux, or Windows
- Node.js 22 or newer
- Rust stable (`rustup` toolchain)
- A C toolchain and the system packages Tauri needs for your OS ([Tauri prerequisites](https://tauri.app/start/prerequisites/))
- [Grok CLI](https://x.ai/cli) signed in (`grok login`), or an xAI API key in Settings
- Optional: Claude CLI signed in (`claude login`), or an Anthropic API key in Settings

## Install

```bash
npm install
```

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

A signed build checks GitHub releases when the sidebar opens. If a newer prerelease has a `TwanAgent_*.app.tar.gz` asset, the version row shows Update. That downloads the archive, replaces this `.app`, and restarts. `tauri dev` can see the update but cannot install it, because it is not running from `TwanAgent.app`.

## Layout

- `src/` React interface, chat client, and frontend tests in `src/lib/tests/`
- `src-tauri/src/` Rust commands, store, providers, and tools
- `scripts/` macOS debug wrapper, build stamp, and icon script
- App data holds conversations and project location. API keys use the keychain service `app.twanagent.desktop`
- Projects default to `~/twanagent/projects`

Rust command names still use a `dev_` prefix, such as `dev_list_conversations`. Frontend files do not.
