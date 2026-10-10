# TwanAgent

Desktop Grok workspace: open a folder, chat, edit, run commands, and use a terminal.

## Requirements

- macOS, Linux, or Windows
- Node.js 22+
- Rust (stable)
- [Grok CLI](https://x.ai/cli) signed in (`grok login`), or an xAI API key in Settings

## Develop

```bash
npm install
npm test
npm run tauri dev
```

The Vite dev server runs on port 1430.

## macOS signing

Release builds are signed by `npm run tauri build`. The debug app used for local network access is signed by `npm run dev:mac`. See [docs/signing.md](docs/signing.md).
