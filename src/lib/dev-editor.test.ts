import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  closeEditorTab,
  emptyEditor,
  formatPlayerTime,
  isMarkdownPath,
  languageForPath,
  markdownViewForTab,
  mediaKindForPath,
  mediaMimeForPath,
  openEditorTab,
  pinEditorTab,
  previewEditorTab,
  requestCloseEditorTab,
  selectChatTab,
  selectEditorTab,
  setEditorMarkdownView,
} from "./dev-editor.ts";

describe("openEditorTab", () => {
  it("opens a file and focuses the editor", () => {
    const next = openEditorTab(emptyEditor(), "src/lib.rs");
    assert.deepEqual(next.tabs.map((t) => t.path), ["src/lib.rs"]);
    assert.equal(next.activePath, "src/lib.rs");
    assert.equal(next.focus, "file");
  });

  it("reselects an already open file instead of duplicating it", () => {
    const start = openEditorTab(emptyEditor(), "src/lib.rs");
    const next = openEditorTab(start, "src/main.rs");
    const again = openEditorTab(next, "src/lib.rs");
    assert.deepEqual(again.tabs.map((t) => t.path), ["src/lib.rs", "src/main.rs"]);
    assert.equal(again.activePath, "src/lib.rs");
  });

  it("normalizes slashes so the same file is not opened twice", () => {
    const start = openEditorTab(emptyEditor(), "src\\lib.rs");
    const next = openEditorTab(start, "src/lib.rs");
    assert.deepEqual(next.tabs.map((t) => t.path), ["src/lib.rs"]);
    assert.equal(next.activePath, "src/lib.rs");
  });
});

describe("requestCloseEditorTab", () => {
  it("closes a clean tab immediately", () => {
    assert.deepEqual(requestCloseEditorTab(null, "a.ts", false), { close: true, pending: null });
  });

  it("warns on the first close of a dirty tab", () => {
    assert.deepEqual(requestCloseEditorTab(null, "a.ts", true), { close: false, pending: "a.ts" });
  });

  it("closes a dirty tab on the second request", () => {
    assert.deepEqual(requestCloseEditorTab("a.ts", "a.ts", true), { close: true, pending: null });
  });

  it("switches the warning when another dirty tab is asked to close", () => {
    assert.deepEqual(requestCloseEditorTab("a.ts", "b.ts", true), { close: false, pending: "b.ts" });
  });
});

describe("closeEditorTab", () => {
  it("closes the active tab and selects a neighbor", () => {
    let state = openEditorTab(emptyEditor(), "a.ts");
    state = openEditorTab(state, "b.ts");
    state = openEditorTab(state, "c.ts");
    const closed = closeEditorTab(state, "b.ts");
    assert.deepEqual(closed.tabs.map((t) => t.path), ["a.ts", "c.ts"]);
    assert.equal(closed.activePath, "c.ts");
  });

  it("returns to chat when the last file tab is closed", () => {
    const start = openEditorTab(emptyEditor(), "a.ts");
    const closed = closeEditorTab(start, "a.ts");
    assert.deepEqual(closed, emptyEditor());
    assert.equal(closed.focus, "chat");
  });

  it("keeps the current file when a different tab is closed", () => {
    let state = openEditorTab(emptyEditor(), "a.ts");
    state = openEditorTab(state, "b.ts");
    const closed = closeEditorTab(state, "a.ts");
    assert.equal(closed.activePath, "b.ts");
  });
});

describe("previewEditorTab", () => {
  it("opens a file as a preview and focuses the editor", () => {
    const next = previewEditorTab(emptyEditor(), "src/lib.rs");
    assert.deepEqual(next.tabs, [{ path: "src/lib.rs", preview: true }]);
    assert.equal(next.activePath, "src/lib.rs");
    assert.equal(next.focus, "file");
  });

  it("replaces the existing preview when another file is previewed", () => {
    const start = previewEditorTab(emptyEditor(), "src/lib.rs");
    const next = previewEditorTab(start, "src/main.rs");
    assert.deepEqual(next.tabs, [{ path: "src/main.rs", preview: true }]);
    assert.equal(next.activePath, "src/main.rs");
  });

  it("keeps pinned tabs and replaces only the preview slot", () => {
    let state = openEditorTab(emptyEditor(), "a.ts");
    state = previewEditorTab(state, "b.ts");
    state = previewEditorTab(state, "c.ts");
    assert.deepEqual(state.tabs, [
      { path: "a.ts" },
      { path: "c.ts", preview: true },
    ]);
    assert.equal(state.activePath, "c.ts");
  });

  it("selects an already pinned file instead of turning it into a preview", () => {
    const start = openEditorTab(emptyEditor(), "a.ts");
    const next = previewEditorTab(start, "a.ts");
    assert.deepEqual(next.tabs, [{ path: "a.ts" }]);
    assert.equal(next.activePath, "a.ts");
    assert.equal(next.focus, "file");
  });

  it("reselects the current preview without duplicating it", () => {
    const start = previewEditorTab(emptyEditor(), "a.ts");
    const next = previewEditorTab(start, "a.ts");
    assert.deepEqual(next.tabs, [{ path: "a.ts", preview: true }]);
    assert.equal(next.activePath, "a.ts");
  });
});

describe("pinEditorTab", () => {
  it("pins a preview tab so it stays", () => {
    const start = previewEditorTab(emptyEditor(), "src/lib.rs");
    const next = pinEditorTab(start, "src/lib.rs");
    assert.deepEqual(next.tabs, [{ path: "src/lib.rs" }]);
    assert.equal(next.activePath, "src/lib.rs");
    assert.equal(next.focus, "file");
  });

  it("opens a missing file as a pinned tab", () => {
    const start = previewEditorTab(emptyEditor(), "a.ts");
    const next = pinEditorTab(start, "b.ts");
    assert.deepEqual(next.tabs, [
      { path: "a.ts", preview: true },
      { path: "b.ts" },
    ]);
    assert.equal(next.activePath, "b.ts");
  });

  it("selects an already pinned tab", () => {
    const start = openEditorTab(emptyEditor(), "a.ts");
    const next = pinEditorTab(start, "a.ts");
    assert.deepEqual(next.tabs, [{ path: "a.ts" }]);
    assert.equal(next.activePath, "a.ts");
  });
});

describe("selectEditorTab", () => {
  it("selects an open tab and ignores unknown paths", () => {
    let state = openEditorTab(emptyEditor(), "a.ts");
    state = openEditorTab(state, "b.ts");
    assert.equal(selectEditorTab(state, "a.ts").activePath, "a.ts");
    assert.equal(selectEditorTab(state, "a.ts").focus, "file");
    assert.equal(selectEditorTab(state, "missing.ts").activePath, "b.ts");
  });
});

describe("selectChatTab", () => {
  it("keeps file tabs open while showing chat", () => {
    const state = openEditorTab(emptyEditor(), "a.ts");
    const chat = selectChatTab(state);
    assert.equal(chat.focus, "chat");
    assert.deepEqual(chat.tabs.map((t) => t.path), ["a.ts"]);
    assert.equal(chat.activePath, "a.ts");
  });
});

describe("isMarkdownPath", () => {
  it("treats .md and .markdown as Markdown, case-insensitive", () => {
    assert.equal(isMarkdownPath("notes.md"), true);
    assert.equal(isMarkdownPath("docs/SPEC.MD"), true);
    assert.equal(isMarkdownPath("readme.markdown"), true);
    assert.equal(isMarkdownPath("docs/Guide.MarkDown"), true);
  });

  it("leaves other files alone", () => {
    assert.equal(isMarkdownPath("src/App.tsx"), false);
    assert.equal(isMarkdownPath("readme"), false);
    assert.equal(isMarkdownPath("notes.md.bak"), false);
  });
});

describe("markdownViewForTab", () => {
  it("returns null for non-Markdown files", () => {
    assert.equal(markdownViewForTab("src/App.tsx", "viewer"), null);
    assert.equal(markdownViewForTab("src/App.tsx", "editor", "viewer"), null);
  });

  it("uses the default when the tab has no override", () => {
    assert.equal(markdownViewForTab("notes.md", "editor"), "editor");
    assert.equal(markdownViewForTab("notes.md", "viewer"), "viewer");
  });

  it("prefers the tab override over the default", () => {
    assert.equal(markdownViewForTab("notes.md", "editor", "viewer"), "viewer");
    assert.equal(markdownViewForTab("README.markdown", "viewer", "editor"), "editor");
  });
});

describe("setEditorMarkdownView", () => {
  it("stores the override on the open tab", () => {
    const start = openEditorTab(emptyEditor(), "notes.md");
    const next = setEditorMarkdownView(start, "notes.md", "viewer");
    assert.deepEqual(next.tabs, [{ path: "notes.md", markdownView: "viewer" }]);
    assert.equal(next.activePath, "notes.md");
  });

  it("ignores unknown and non-Markdown paths", () => {
    const start = openEditorTab(emptyEditor(), "notes.md");
    assert.equal(setEditorMarkdownView(start, "missing.md", "viewer"), start);
    assert.equal(setEditorMarkdownView(start, "src/App.tsx", "viewer"), start);
  });

  it("keeps the override when a preview is pinned", () => {
    let state = previewEditorTab(emptyEditor(), "notes.md");
    state = setEditorMarkdownView(state, "notes.md", "viewer");
    const pinned = pinEditorTab(state, "notes.md");
    assert.deepEqual(pinned.tabs, [{ path: "notes.md", markdownView: "viewer" }]);
  });

  it("does not copy the override onto a replacement preview", () => {
    let state = previewEditorTab(emptyEditor(), "notes.md");
    state = setEditorMarkdownView(state, "notes.md", "viewer");
    const next = previewEditorTab(state, "other.md");
    assert.deepEqual(next.tabs, [{ path: "other.md", preview: true }]);
  });
});

describe("languageForPath", () => {
  it("picks a language from the file extension", () => {
    assert.equal(languageForPath("app.py"), "python");
    assert.equal(languageForPath("config.yaml"), "yaml");
    assert.equal(languageForPath("src/lib.rs"), "rust");
    assert.equal(languageForPath("index.tsx"), "javascript");
    assert.equal(languageForPath("notes.md"), "markdown");
    assert.equal(languageForPath("unknown.bin"), "text");
  });
});

describe("mediaKindForPath", () => {
  it("treats common raster images as images", () => {
    assert.equal(mediaKindForPath("icons/128x128@2x.png"), "image");
    assert.equal(mediaKindForPath("photo.JPEG"), "image");
    assert.equal(mediaKindForPath("shot.webp"), "image");
    assert.equal(mediaKindForPath("anim.gif"), "image");
  });

  it("treats playable video extensions as video", () => {
    assert.equal(mediaKindForPath("demo.mp4"), "video");
    assert.equal(mediaKindForPath("clip.webm"), "video");
    assert.equal(mediaKindForPath("take.MOV"), "video");
  });

  it("leaves text, svg, and unknown files to the editor", () => {
    assert.equal(mediaKindForPath("src/App.tsx"), null);
    assert.equal(mediaKindForPath("logo.svg"), null);
    assert.equal(mediaKindForPath("notes.md"), null);
    assert.equal(mediaKindForPath("unknown.bin"), null);
  });
});

describe("mediaMimeForPath", () => {
  it("returns a mime type for known media extensions", () => {
    assert.equal(mediaMimeForPath("a.png"), "image/png");
    assert.equal(mediaMimeForPath("a.jpg"), "image/jpeg");
    assert.equal(mediaMimeForPath("a.mp4"), "video/mp4");
    assert.equal(mediaMimeForPath("a.webm"), "video/webm");
    assert.equal(mediaMimeForPath("a.mov"), "video/quicktime");
  });
});

describe("formatPlayerTime", () => {
  it("formats seconds as m:ss and h:mm:ss", () => {
    assert.equal(formatPlayerTime(0), "0:00");
    assert.equal(formatPlayerTime(9), "0:09");
    assert.equal(formatPlayerTime(75), "1:15");
    assert.equal(formatPlayerTime(3661), "1:01:01");
  });

  it("treats missing or invalid times as 0:00", () => {
    assert.equal(formatPlayerTime(Number.NaN), "0:00");
    assert.equal(formatPlayerTime(-4), "0:00");
    assert.equal(formatPlayerTime(Number.POSITIVE_INFINITY), "0:00");
  });
});
