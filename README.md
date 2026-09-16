# TwanAgent

Desktop Grok workspace: open a folder, chat, edit, run commands, and use a terminal.

This used to be Dev mode inside BackupAnything. It is now its own Tauri app.

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

The Vite server is on port 1430 so it can run next to BackupAnything.
