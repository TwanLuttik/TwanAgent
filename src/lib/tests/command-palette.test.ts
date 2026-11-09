import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPalette,
  fileSearchProject,
  movePaletteIndex,
  type PaletteGroup,
  type PaletteItem,
} from "../command-palette.ts";

function group(
  path: string,
  conversations: PaletteGroup["conversations"],
  name = path.split("/").filter(Boolean).pop() ?? path,
): PaletteGroup {
  return { name, path, conversations };
}

function chat(
  id: string,
  title: string,
  updated_at: string,
  extra: Partial<PaletteGroup["conversations"][number]> = {},
): PaletteGroup["conversations"][number] {
  return { id, title, updated_at, ...extra };
}

describe("buildPalette home", () => {
  const groups = [
    group("/repo", [
      chat("run-old", "Older run", "2026-11-01T00:00:00Z"),
      chat("run-new", "Newer run", "2026-11-03T00:00:00Z"),
      chat("done-1", "First done", "2026-11-06T00:00:00Z"),
      chat("done-2", "Second done", "2026-11-05T00:00:00Z"),
      chat("done-3", "Third done", "2026-11-04T00:00:00Z"),
      chat("done-4", "Fourth done", "2026-11-02T00:00:00Z"),
      chat("done-5", "Fifth done", "2026-10-30T00:00:00Z"),
      chat("done-6", "Sixth done", "2026-10-01T00:00:00Z"),
      chat("draft", "New chat", "2026-11-07T00:00:00Z"),
      chat("archived", "Hidden", "2026-11-07T12:00:00Z", { archived: true }),
    ]),
  ];

  it("lists every running chat and only the five newest finished chats", () => {
    const { sections, items } = buildPalette({
      mode: "browse",
      query: "",
      groups,
      files: [],
      runningIds: { "run-old": true, "run-new": true },
    });
    assert.deepEqual(
      sections.map((section) => section.label),
      ["Running", "Finished"],
    );
    assert.deepEqual(
      items.filter((item) => item.kind === "chat" && item.running).map((item) => item.id),
      ["run-new", "run-old"],
    );
    assert.deepEqual(
      items.filter((item) => item.kind === "chat" && !item.running).map((item) => item.id),
      ["done-1", "done-2", "done-3", "done-4", "done-5"],
    );
  });

  it("keeps a running empty draft and drops archived chats", () => {
    const { items } = buildPalette({
      mode: "browse",
      query: "",
      groups: [
        group("/repo", [
          chat("draft", "New chat", "2026-11-07T00:00:00Z"),
          chat("archived", "Hidden", "2026-11-07T12:00:00Z", { archived: true }),
        ]),
      ],
      files: [],
      runningIds: { draft: true, archived: true },
    });
    assert.deepEqual(
      items.map((item) => item.id),
      ["draft"],
    );
  });
});

describe("buildPalette search", () => {
  const groups = [
    group("/repo/app", [
      chat("alpha", "Alpha plan", "2026-11-01T00:00:00Z", { preview: "ship the button" }),
      chat("live", "Live notes", "2026-11-02T00:00:00Z", { preview: "button work" }),
      chat("hidden", "Button archive", "2026-11-04T00:00:00Z", { archived: true }),
    ], "App"),
    group("/repo/button-kit", [], "Button Kit"),
  ];

  it("matches conversations and projects, with a running chat above the same text match", () => {
    const { sections, items } = buildPalette({
      mode: "browse",
      query: "button",
      groups,
      files: [{ path: "src/button.tsx", name: "button.tsx" }],
      runningIds: { live: true },
    });
    assert.deepEqual(
      sections.map((section) => section.label),
      ["Conversations", "Projects"],
    );
    assert.deepEqual(
      items.map((item) => item.kind === "chat" ? item.id : item.path),
      ["live", "alpha", "/repo/button-kit"],
    );
  });

  it("ranks a title match above a project-name match", () => {
    const { items } = buildPalette({
      mode: "browse",
      query: "kit",
      groups: [
        group("/repo/kit", [chat("other", "Notes", "2026-11-02T00:00:00Z")], "Kit"),
        group("/repo/app", [chat("exact", "Kit", "2026-11-01T00:00:00Z")], "App"),
      ],
      files: [],
      runningIds: {},
    });
    assert.equal(items[0]?.kind === "chat" ? items[0].id : "", "exact");
  });

  it("keeps the model and remote flag the row icons need", () => {
    const { items } = buildPalette({
      mode: "browse",
      query: "app",
      groups: [
        {
          name: "App",
          path: "/repo/app",
          remote: true,
          conversations: [chat("notes", "App notes", "2026-11-01T00:00:00Z", { model: "claude-sonnet-4-6" })],
        },
      ],
      files: [],
      runningIds: {},
    });
    const conversation = items.find((item) => item.kind === "chat");
    const project = items.find((item) => item.kind === "project");
    assert.equal(conversation?.kind === "chat" ? conversation.model : "", "claude-sonnet-4-6");
    assert.equal(project?.kind === "project" ? project.remote : false, true);
  });
});

describe("buildPalette files", () => {
  const files = [
    { path: "src/button.tsx", name: "button.tsx" },
    { path: "docs/button-notes.md", name: "button-notes.md" },
    { path: "src/app.ts", name: "app.ts" },
    { path: "src/lib/button-theme.ts", name: "theme.ts" },
  ];

  it("returns no files until there is a query", () => {
    const { items } = buildPalette({
      mode: "files",
      query: "   ",
      groups: [],
      files,
      runningIds: {},
    });
    assert.deepEqual(items, []);
  });

  it("ranks the file name above a path match and ignores conversations", () => {
    const { sections, items } = buildPalette({
      mode: "files",
      query: "button",
      groups: [group("/repo", [chat("alpha", "Button", "2026-11-01T00:00:00Z")])],
      files,
      runningIds: {},
    });
    assert.deepEqual(
      sections.map((section) => section.label),
      ["Files"],
    );
    assert.deepEqual(
      items.map((item) => item.path),
      ["src/button.tsx", "docs/button-notes.md", "src/lib/button-theme.ts"],
    );
  });
});

describe("fileSearchProject", () => {
  it("uses a highlighted row only after the user has typed, otherwise the open project", () => {
    const project: PaletteItem = { kind: "project", name: "App", path: "/repo/app", remote: false };
    const chatItem: PaletteItem = {
      kind: "chat",
      id: "c1",
      title: "Notes",
      path: "/repo/notes",
      project: "Notes",
      updatedAt: "",
      running: false,
      preview: "",
      model: "",
    };
    assert.deepEqual(fileSearchProject(project, "/repo/other", ""), { path: "/repo/other", name: "other" });
    assert.deepEqual(fileSearchProject(project, "/repo/other", "app"), { path: "/repo/app", name: "App" });
    assert.deepEqual(fileSearchProject(chatItem, "/repo/other", "notes"), { path: "/repo/notes", name: "Notes" });
    assert.deepEqual(fileSearchProject(undefined, "/repo/other", ""), { path: "/repo/other", name: "other" });
    assert.equal(fileSearchProject(undefined, "", ""), null);
    assert.deepEqual(fileSearchProject(project, "", "app"), { path: "/repo/app", name: "App" });
  });
});

describe("movePaletteIndex", () => {
  it("wraps at both ends and stays put when the list is empty", () => {
    assert.equal(movePaletteIndex(0, -1, 3), 2);
    assert.equal(movePaletteIndex(2, 1, 3), 0);
    assert.equal(movePaletteIndex(4, 1, 3), 0);
    assert.equal(movePaletteIndex(0, 1, 0), 0);
  });
});
