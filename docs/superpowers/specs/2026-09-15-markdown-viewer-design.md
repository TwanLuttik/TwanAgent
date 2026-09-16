# Markdown viewer

A rendered Markdown view for `.md` / `.markdown` files, with a setting for the default on open and a per-tab switch between viewer and editor.

## Decisions

- Selecting a Markdown file opens it in the **Editor** or the **Viewer**, from a setting.
- Default is **Editor** so current behavior does not change until the user opts in.
- The file toolbar can switch that tab between **Editor** and **Viewer**. The switch does not rewrite the setting.
- Closing the tab drops the override. Opening the file again uses the setting.
- Viewer is read-only rendered Markdown. Editing stays in CodeMirror. Save still works if the buffer is dirty.
- Reuse `ChatMarkdown` (`react-markdown` + GFM). No second Markdown stack.
- Not a split source/preview. Not remembered per path across tab close.

## Shape

- `isMarkdownPath`, `markdownViewForTab`, and `setEditorMarkdownView` live in `dev-editor.ts`.
- `EditorTab.markdownView` is an optional per-tab override (`editor` | `viewer`).
- Pref `twanagent.markdownOpen` in `prefs.ts`. Missing or unknown is `editor`.
- Settings → Appearance: **Open Markdown files in** Editor / Viewer.
- `DevEditor` shows `ChatMarkdown` for the draft when the resolved view is `viewer`.

## Tests

- Path detection for `.md`, `.markdown`, case, and non-Markdown files.
- Default, save/load, and garbage fallback for the pref.
- View resolution: setting, per-tab override, non-Markdown is `null`.
- Setting the override on an open tab; ignored for unknown or non-Markdown paths.
- Pinning a preview keeps the override; replacing a preview does not copy it.
