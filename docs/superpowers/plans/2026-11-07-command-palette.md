# Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ⌘K opens a centered dialog of running chats and the last five finished chats, and the same dialog searches projects, conversations, and (after Tab or Files) files in one project.

**Architecture:** Pure list-building lives in `src/lib/command-palette.ts` and is covered by node:test. The dialog is `src/components/CommandPalette.tsx`, mounted from `MainShell` so it can call the existing open-chat, switch-project, and open-file actions. The shortcut is `isCommandPaletteHotkey` next to the other app hotkeys.

**Tech Stack:** React 19, Tailwind 4, existing Tauri `treeSignature` / file-structure cache, node:test.

## Global Constraints

- Do not commit, push, or create a git worktree.
- Do not add a screen inline in `MainView.tsx`. Mount the dialog from `src/views/main/MainShell.tsx`.
- Do not add a backend command. File search uses the tree snapshot the app already has.
- Tests and docs use placeholder paths such as `/repo`, never a real home path.
- Terminal chats stay openable and get no new terminal-only behavior.
- Finished home list length is exactly 5. Conversation search cap is 20. Project search cap is 8. File search cap is 40.

---

### Task 1: Hotkey and list model

**Files:**
- Modify: `src/lib/hotkeys.ts`
- Modify: `src/lib/tests/hotkeys.test.ts`
- Create: `src/lib/command-palette.ts`
- Test: `src/lib/tests/command-palette.test.ts`

**Interfaces:**
- Produces: `isCommandPaletteHotkey(ev, mac)`
- Produces: `buildPalette({ mode, query, groups, files, runningIds }) => { sections, items }`
- Produces: `fileSearchProject(selected, workspace) => { path, name } | null`
- Produces: `movePaletteIndex(index, delta, count)`

- [ ] **Step 1:** Write failing tests for ⌘K / Ctrl+K, the home list, search ranking, file ranking, and file scope.
- [ ] **Step 2:** Run `node --experimental-strip-types --test src/lib/tests/hotkeys.test.ts src/lib/tests/command-palette.test.ts` and confirm the new cases fail.
- [ ] **Step 3:** Implement the hotkey and the pure builder.
- [ ] **Step 4:** Re-run the same command and confirm it passes.

### Task 2: Dialog

**Files:**
- Create: `src/components/CommandPalette.tsx`
- Modify: `src/views/main/MainShell.tsx`

**Interfaces:**
- Consumes: `buildPalette`, `fileSearchProject`, `movePaletteIndex`, `isCommandPaletteHotkey`
- Consumes: `useMain()` for `applyWorkspace`, `openWorkspaceFile`, `mentionFiles`, `workspace`, and the close-overlay actions
- Consumes: `useSidebar()` for `allProjectGroups`, `conversations`, `runningTurns`, `openSidebarChat`

- [ ] **Step 1:** Render a centered dialog, portal-mounted, toggled by the hotkey from anywhere including the landing screen.
- [ ] **Step 2:** Home, search, and file modes call `buildPalette`. Tab and the Files button enter file mode for `fileSearchProject`. Tab again leaves it.
- [ ] **Step 3:** Enter opens the selected chat, project, or file, then closes. A file in another project calls `applyWorkspace` before `openWorkspaceFile`.
- [ ] **Step 4:** Run `npx tsc --noEmit` and the palette tests.

### Task 3: Check

- [ ] **Step 1:** Run the palette tests and `npx tsc --noEmit`.
- [ ] **Step 2:** Do not commit.
